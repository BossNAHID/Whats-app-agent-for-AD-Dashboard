require('dotenv').config();

// Safety net: log unexpected errors instead of crashing the HTTP bridge.
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createKVStore, SupabaseKVStore } = require('./supabase-store');
const { OpenWAGateway } = require('./openwa-gateway');

const DEFAULT_ACCOUNT_ID = 'default';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseAdminKeys(raw) {
  const map = new Map();
  String(raw || '').split(',').forEach((entry) => {
    const idx = entry.indexOf(':');
    if (idx === -1) return;
    const label = entry.slice(0, idx).trim();
    const key = entry.slice(idx + 1).trim();
    if (label && key) map.set(key, label);
  });
  return map;
}

function slugify(label, existingAccounts) {
  let base = String(label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'account';

  if (base.length < 3) {
    base = `cb-${base}`;
  }
  if (base.length > 44) {
    base = base.slice(0, 44).replace(/-+$/g, '');
  }

  const taken = new Set((existingAccounts || []).map(a => a.id));
  let candidate = base;
  let i = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${i}`;
    i++;
  }
  return candidate;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeName(name) {
  return String(name || '')
    .replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ') // NBSP/zero-width chars from copy-pasted sheet cells
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function createApp(options = {}) {
  const apiKey = options.apiKey || process.env.API_KEY || 'changeme';
  const adminKeys = parseAdminKeys(
    options.adminKeysRaw !== undefined ? options.adminKeysRaw : process.env.ADMIN_KEYS
  );
  const mappingFile = options.mappingFile || path.join(__dirname, 'groups-config.json');

  const kvStore = options.kvStore || createKVStore(options.storeOptions);

  const storageBackend = kvStore instanceof SupabaseKVStore
    ? 'supabase'
    : (kvStore && !kvStore.useLocalFallback ? 'turso' : 'local');

  let gatewayConfigCache = { value: null, expiresAt: 0 };

  async function loadGatewayConfig({ bypassCache = false } = {}) {
    if (!bypassCache && Date.now() < gatewayConfigCache.expiresAt) {
      return gatewayConfigCache.value;
    }
    try {
      const raw = await kvStore.get('openwa-gateway-config');
      const parsed = raw ? JSON.parse(raw) : null;
      gatewayConfigCache = { value: parsed, expiresAt: Date.now() + 5000 };
      return parsed;
    } catch (e) {
      console.error('[server] failed to load gateway config:', e.message);
      return null;
    }
  }

  async function saveGatewayConfig(config) {
    await kvStore.set('openwa-gateway-config', JSON.stringify(config));
    gatewayConfigCache = { value: config, expiresAt: Date.now() + 5000 };
  }

  const gateway = options.gateway || new OpenWAGateway({
    baseUrl: process.env.OPENWA_BASE_URL,
    apiKey: process.env.OPENWA_API_KEY,
    keyFile: process.env.OPENWA_KEY_FILE,
    configLoader: () => loadGatewayConfig()
  });

  // ---------- accounts registry (Turso / local KV fallback) ----------
  async function loadAccountsRegistry() {
    try {
      const raw = await kvStore.get('accounts-registry');
      const parsed = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(parsed) ? parsed : [];
      if (!list.find(a => a.id === DEFAULT_ACCOUNT_ID)) {
        list.unshift({ id: DEFAULT_ACCOUNT_ID, label: 'Default' });
      }
      return list;
    } catch (e) {
      console.error('[server] failed to load accounts registry, falling back to default only:', e.message);
      return [{ id: DEFAULT_ACCOUNT_ID, label: 'Default' }];
    }
  }

  async function saveAccountsRegistry(list) {
    await kvStore.set('accounts-registry', JSON.stringify(list));
  }

  async function updateAccountSessionId(accountId, openwaSessionId) {
    if (!openwaSessionId) return;
    try {
      const list = await loadAccountsRegistry();
      const target = list.find(a => a.id === accountId);
      if (target && target.openwa_session_id !== openwaSessionId) {
        target.openwa_session_id = openwaSessionId;
        await saveAccountsRegistry(list);
      }
    } catch (e) {
      console.error(`[server] failed to persist OpenWA session ID for "${accountId}":`, e.message);
    }
  }

  // ---------- KAM → sending account mapping ----------
  async function loadKamMapping() {
    try {
      const raw = await kvStore.get('kam-account-mapping');
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error('[server] failed to load KAM mapping from Turso:', e.message);
      return {};
    }
  }

  async function saveKamMapping(mapping) {
    await kvStore.set('kam-account-mapping', JSON.stringify(mapping));
  }

  // ---------- group mapping ----------
  async function loadMapping() {
    try {
      const raw = await kvStore.get('group-mapping');
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.error('[server] failed to load group mapping from Turso, falling back to local file:', e.message);
    }
    try {
      return JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  async function saveMapping(mapping) {
    await kvStore.set('group-mapping', JSON.stringify(mapping));
    try { fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2)); } catch (_) {}
  }

  // ---------- live OpenWA status sync ----------
  async function getAccountsWithStatus({ autoCreateMissing = true, autoStartCreated = false } = {}) {
    const registry = await loadAccountsRegistry();
    let sessionsList = null;
    let gatewayError = null;

    try {
      sessionsList = await gateway.listSessions();
    } catch (err) {
      gatewayError = err.message || 'OpenWA gateway unreachable';
    }

    let registryMutated = false;
    const results = [];

    for (const acc of registry) {
      if (gatewayError) {
        results.push(gateway.formatPublicAccount(acc, null, {
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          gatewayError
        }));
        continue;
      }

      try {
        let session = await gateway.findSession(acc, sessionsList);
        if (!session && autoCreateMissing) {
          const ensured = await gateway.ensureSession(acc, {
            autoStart: autoStartCreated,
            sessionsList
          });
          session = ensured.session;
          if (ensured.sessionIdChanged && session) {
            acc.openwa_session_id = session.id;
            registryMutated = true;
          }
        } else if (session && acc.openwa_session_id !== session.id) {
          acc.openwa_session_id = session.id;
          registryMutated = true;
          if (autoStartCreated && session.status === 'created' && !session.engineLoaded) {
            session = await gateway.startSessionIfIdle(session);
          }
        } else if (session && autoStartCreated && session.status === 'created' && !session.engineLoaded) {
          session = await gateway.startSessionIfIdle(session);
        }

        results.push(gateway.formatPublicAccount(acc, session, {
          defaultAccountId: DEFAULT_ACCOUNT_ID
        }));
      } catch (err) {
        results.push(gateway.formatPublicAccount(acc, null, {
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          gatewayError: err.message
        }));
      }
    }

    if (registryMutated) {
      try { await saveAccountsRegistry(registry); } catch (_) {}
    }

    return { accounts: results, gatewayError };
  }

  // ---------- express app ----------
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  function requireApiKey(req, res, next) {
    const key = req.header('x-api-key');
    if (key === apiKey) {
      req.adminName = 'default';
      req.isMasterAdmin = true;
      return next();
    }
    if (key && adminKeys.has(key)) {
      req.adminName = adminKeys.get(key);
      req.isMasterAdmin = false;
      return next();
    }
    return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
  }

  function maskSecret(secret) {
    const s = String(secret || '').trim();
    if (!s) return null;
    if (s.length <= 12) return '••••••••';
    return `${s.slice(0, 9)}••••${s.slice(-4)}`;
  }

  async function requireAccount(req, res, next) {
    try {
      const registry = await loadAccountsRegistry();
      const acc = registry.find(a => a.id === req.params.accountId);
      if (!acc) {
        return res.status(404).json({ error: `Unknown account "${req.params.accountId}"` });
      }
      req.account = acc;
      req.accountsRegistry = registry;
      return next();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // When running inside the all-in-one Docker image (/app/dist/main present),
  // expose OpenWA's authenticated SDK API under `/openwa/*` (protected by OpenWA's 71-char API_MASTER_KEY)
  // so single-port Docker hosts (like Render Free or VPS :3000) can seamlessly act as the remote
  // OpenWA engine for the permanent Vercel + Supabase front-end with zero route collisions.
  const localOpenwaTarget = options.localOpenwaProxyTarget
    || (fs.existsSync('/app/dist/main')
      ? `http://127.0.0.1:${process.env.OPENWA_INTERNAL_PORT || 2785}`
      : null);

  if (localOpenwaTarget) {
    app.use('/openwa', async (req, res) => {
      try {
        const subPath = req.originalUrl.replace(/^\/openwa(?=\/|$)/, '') || '/';
        const targetUrl = `${localOpenwaTarget.replace(/\/+$/, '')}${subPath}`;
        const fwdHeaders = {};
        for (const h of ['x-api-key', 'authorization', 'content-type', 'accept', 'idempotency-key']) {
          const val = req.header(h);
          if (val !== undefined) fwdHeaders[h] = val;
        }
        const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase())
          && req.body !== undefined
          && Object.keys(req.body || {}).length > 0;
        const upstream = await fetch(targetUrl, {
          method: req.method,
          headers: fwdHeaders,
          body: hasBody ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(30000)
        });
        res.status(upstream.status);
        const ct = upstream.headers.get('content-type');
        if (ct) res.setHeader('Content-Type', ct);
        const buf = Buffer.from(await upstream.arrayBuffer());
        return res.send(buf);
      } catch (err) {
        return res.status(502).json({ error: `Local OpenWA upstream unavailable: ${err.message}` });
      }
    });
  }

  // Health probe for Vercel / Render / Docker Compose
  app.get('/api/health', async (req, res) => {
    const openwa = await gateway.checkHealth();
    res.json({
      ok: true,
      bridge: 'ready',
      storage: storageBackend,
      openwa
    });
  });

  // Dynamic OpenWA Gateway connection config (stored in Supabase / KV)
  app.get('/api/gateway-config', requireApiKey, async (req, res) => {
    if (!req.isMasterAdmin) {
      return res.status(403).json({ error: 'Master API_KEY required to inspect gateway configuration' });
    }
    const saved = await loadGatewayConfig({ bypassCache: true });
    const envBaseUrl = process.env.OPENWA_BASE_URL ? process.env.OPENWA_BASE_URL.trim() : '';
    const envApiKey = process.env.OPENWA_API_KEY ? process.env.OPENWA_API_KEY.trim() : '';
    const openwa = await gateway.checkHealth();

    res.json({
      storage_backend: storageBackend,
      base_url: envBaseUrl || (saved && saved.base_url) || '',
      has_api_key: Boolean(envApiKey || (saved && saved.api_key)),
      masked_api_key: maskSecret(envApiKey || (saved && saved.api_key)),
      env_override: Boolean(envBaseUrl),
      openwa
    });
  });

  app.post('/api/gateway-config', requireApiKey, async (req, res) => {
    if (!req.isMasterAdmin) {
      return res.status(403).json({ error: 'Master API_KEY required to update gateway configuration' });
    }
    const rawUrl = String((req.body && req.body.base_url) || '').trim();
    const rawKey = String((req.body && req.body.api_key) || '').trim();

    if (!rawUrl) {
      return res.status(400).json({ error: 'base_url is required (e.g. https://your-openwa.onrender.com or http://VPS_IP:2785)' });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch (_) {
      return res.status(400).json({ error: 'Invalid URL. Include http:// or https:// (e.g. https://your-openwa.onrender.com)' });
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'URL must start with http:// or https://' });
    }
    const hostLower = parsedUrl.hostname.toLowerCase();
    if (hostLower === '169.254.169.254' || hostLower === 'metadata.google.internal') {
      return res.status(400).json({ error: 'Disallowed gateway hostname' });
    }

    const cleanBaseUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, '')}`;
    const existing = (await loadGatewayConfig({ bypassCache: true })) || {};
    const finalApiKey = rawKey || existing.api_key || '';

    if (!finalApiKey) {
      return res.status(400).json({ error: 'api_key is required when connecting OpenWA for the first time' });
    }

    await saveGatewayConfig({
      base_url: cleanBaseUrl,
      api_key: finalApiKey,
      updated_at: new Date().toISOString()
    });

    const openwa = await gateway.checkHealth();
    res.json({
      ok: true,
      storage_backend: storageBackend,
      base_url: cleanBaseUrl,
      masked_api_key: maskSecret(finalApiKey),
      openwa
    });
  });

  // Status page
  app.get('/', async (req, res) => {
    const [{ accounts, gatewayError }, health] = await Promise.all([
      getAccountsWithStatus({ autoCreateMissing: true, autoStartCreated: false }),
      gateway.checkHealth()
    ]);

    const rows = accounts.map(a => {
      const idEnc = encodeURIComponent(a.id);
      const statusCell = a.ready
        ? escapeHtml(a.name || 'Connected')
        : `<a href="/qr/${idEnc}">/qr</a> · <a href="/pair/${idEnc}">/pair</a>` +
          (a.last_status ? ` <small>(${escapeHtml(a.last_status)})</small>` : '');
      return `
        <tr>
          <td>${escapeHtml(a.label)}</td>
          <td><code>${escapeHtml(a.id)}</code></td>
          <td><span class="badge ${a.ready ? 'on' : 'off'}">${a.ready ? 'Connected' : 'Not connected'}</span></td>
          <td>${statusCell}</td>
        </tr>
      `;
    }).join('');

    const gatewayBanner = health.ready
      ? `<p class="gw ok">OpenWA Gateway: <strong>Online</strong>${health.version ? ` (v${escapeHtml(health.version)})` : ''}</p>`
      : `<p class="gw warn">OpenWA Gateway: <strong>${health.reachable ? 'Initializing...' : 'Waiting for connection'}</strong>${gatewayError ? ` — ${escapeHtml(gatewayError)}` : ''}</p>`;

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>CarryBee WhatsApp Bridge (OpenWA)</title>
      <style>
        body{font-family:'Plus Jakarta Sans',Arial,sans-serif;background:#FFFDF7;color:#1c1c1c;max-width:740px;margin:60px auto;padding:0 20px;}
        h1{font-family:'Space Grotesk',sans-serif;font-size:20px;}
        .badge{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:600;font-size:13px;}
        .on{background:#e9f6ee;color:#2E8B57;}
        .off{background:#fdeceb;color:#D64545;}
        .gw{font-size:13px;padding:8px 12px;border-radius:8px;margin:12px 0;}
        .gw.ok{background:#e9f6ee;color:#2E8B57;}
        .gw.warn{background:#fff6e0;color:#8a5d00;}
        a{color:#141414;font-weight:600;}
        code{background:#faf8f0;padding:2px 6px;border-radius:4px;}
        table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px;}
        td,th{text-align:left;padding:8px 10px;border-bottom:1px solid #eee;}
        footer{margin-top:40px;font-size:11px;color:#7a7566;}
      </style>
    </head>
    <body>
      <h1>🐝 CarryBee WhatsApp Bridge</h1>
      ${gatewayBanner}
      <p>${accounts.length} WhatsApp account(s) configured. Manage accounts and group mappings from <a href="/admin">/admin</a>.</p>
      <table>
        <thead><tr><th>Label</th><th>Account ID</th><th>Status</th><th>Connect / logged in as</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <footer>Powered by OpenWA · CarryBee Bridge by NAHID</footer>
    </body>
    </html>
    `);
  });

  // QR code page (per account)
  app.get('/qr/:accountId', requireAccount, async (req, res) => {
    const acc = req.account;
    const idEnc = encodeURIComponent(acc.id);
    try {
      const qrResult = await gateway.getQrForAccount(acc);
      if (qrResult.sessionIdChanged && qrResult.session) {
        await updateAccountSessionId(acc.id, qrResult.session.id);
      }

      if (qrResult.ready) {
        const pub = gateway.formatPublicAccount(acc, qrResult.session, { defaultAccountId: DEFAULT_ACCOUNT_ID });
        return res.send(
          `<p style="font-family:sans-serif">"${escapeHtml(acc.label)}" is already connected${pub.name ? ` as <strong>${escapeHtml(pub.name)}</strong>` : ''}. <a href="/">Back to status</a></p>`
        );
      }

      if (!qrResult.qrCode) {
        const statusText = qrResult.session ? qrResult.session.status : 'starting';
        const errText = qrResult.session && qrResult.session.lastError
          ? ` — ${escapeHtml(qrResult.session.lastError)}`
          : '';
        return res.send(`
          <!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="4"><title>Waiting for QR — ${escapeHtml(acc.label)}</title></head>
          <body style="font-family:sans-serif;text-align:center;margin-top:60px;background:#FFFDF7;color:#141414;">
            <h2>Preparing WhatsApp Web session...</h2>
            <p>Account: <strong>${escapeHtml(acc.label)}</strong></p>
            <p style="color:#555;font-size:14px;">OpenWA status: <code>${escapeHtml(statusText)}</code>${errText}</p>
            <p style="color:#7a7566;font-size:13px;">This page refreshes automatically every 4 seconds until the QR code appears.</p>
            <p><a href="/">Back to status</a></p>
          </body></html>
        `);
      }

      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="15"><title>Scan to connect — ${escapeHtml(acc.label)}</title>
        <style>body{font-family:sans-serif;text-align:center;margin-top:60px;background:#FFFDF7;color:#141414;}
        h1{font-family:sans-serif;color:#141414;}</style></head>
        <body>
          <h1>Scan with WhatsApp on your phone</h1>
          <p>Connecting: <strong>${escapeHtml(acc.label)}</strong></p>
          <p>WhatsApp → Linked devices → Link a device</p>
          <img src="${escapeHtml(qrResult.qrCode)}" style="width:280px;height:280px;border:8px solid #FFC72C;border-radius:12px;background:#fff;" />
          <p style="margin-top:24px;"><a href="/pair/${idEnc}">Prefer a phone pairing code instead of scanning?</a></p>
        </body></html>
      `);
    } catch (err) {
      return res.status(err.status || 503).send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="5"><title>Waiting for OpenWA</title></head>
        <body style="font-family:sans-serif;text-align:center;margin-top:60px;background:#FFFDF7;color:#141414;">
          <h2>Waiting for OpenWA Gateway...</h2>
          <p style="color:#D64545;font-size:14px;">${escapeHtml(err.message)}</p>
          <p style="color:#7a7566;font-size:13px;">Retrying automatically in 5 seconds.</p>
          <p><a href="/">Back to status</a></p>
        </body></html>
      `);
    }
  });

  // Pairing code page — link via phone number instead of scanning QR
  app.get('/pair/:accountId', requireAccount, async (req, res) => {
    const acc = req.account;
    const idEnc = encodeURIComponent(acc.id);
    const rawPhone = String(req.query.phone || '').replace(/[^\d]/g, '');

    const pageWrap = (body) => `
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>Link with phone number — ${escapeHtml(acc.label)}</title>
      <style>
        body{font-family:sans-serif;text-align:center;margin-top:60px;background:#FFFDF7;color:#141414;max-width:640px;margin-left:auto;margin-right:auto;padding:0 20px;}
        input{font-size:18px;padding:10px;border-radius:8px;border:1px solid #ccc;width:260px;}
        button{font-size:16px;padding:10px 20px;border-radius:8px;border:none;background:#FFC72C;font-weight:700;cursor:pointer;margin-left:8px;}
        code.pair{font-size:36px;letter-spacing:6px;background:#faf8f0;padding:16px 24px;border-radius:12px;border:8px solid #FFC72C;display:inline-block;margin-top:20px;}
      </style></head>
      <body>${body}</body></html>
    `;

    if (!rawPhone) {
      return res.send(pageWrap(`
        <h1>Link with phone number</h1>
        <p>Connecting: <strong>${escapeHtml(acc.label)}</strong></p>
        <p>Enter that WhatsApp number with country code, digits only (no spaces, no + sign).<br>Example for Bangladesh: <code>8801XXXXXXXXX</code></p>
        <form action="/pair/${idEnc}" method="GET">
          <input type="text" name="phone" placeholder="8801XXXXXXXXX" pattern="[0-9]{6,15}" required />
          <button type="submit">Get code</button>
        </form>
        <p style="margin-top:16px;color:#7a7566;font-size:12px;">Tip: Scanning the <a href="/qr/${idEnc}">QR code</a> is recommended if that phone already has other linked devices.</p>
      `));
    }

    if (!/^[0-9]{6,15}$/.test(rawPhone)) {
      return res.status(400).send(pageWrap(`
        <h1>Invalid phone number</h1>
        <p>Enter 6–15 digits with country code (e.g. <code>8801712345678</code>).</p>
        <p><a href="/pair/${idEnc}">Try again</a></p>
      `));
    }

    try {
      const result = await gateway.requestPairingCode(acc, rawPhone);
      if (result.sessionIdChanged && result.session) {
        await updateAccountSessionId(acc.id, result.session.id);
      }
      if (result.ready) {
        return res.send(pageWrap(`
          <h1>Already connected</h1>
          <p>"${escapeHtml(acc.label)}" is already connected. <a href="/">Back to status</a></p>
        `));
      }
      return res.send(pageWrap(`
        <h1>Enter this code in WhatsApp</h1>
        <p>On that phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead"</p>
        <code class="pair">${escapeHtml(result.pairingCode)}</code>
        <p style="margin-top:24px;color:#7a7566;font-size:13px;">Code expires after a few minutes — reload this page if you need a fresh code.</p>
      `));
    } catch (err) {
      return res.status(err.status || 500).send(pageWrap(`
        <h1>Could not get pairing code yet</h1>
        <p style="color:#D64545;">${escapeHtml(err.message)}</p>
        <p style="font-size:13px;color:#555;">If OpenWA just started this session, wait 5–10 seconds for WhatsApp Web to finish loading, or use <a href="/qr/${idEnc}">QR scan</a>.</p>
        <p><a href="/pair/${idEnc}?phone=${encodeURIComponent(rawPhone)}">Retry</a> · <a href="/pair/${idEnc}">Change number</a></p>
      `));
    }
  });

  // Connection status (JSON) — all accounts, or a single one
  app.get('/api/status', async (req, res) => {
    const { accounts, gatewayError } = await getAccountsWithStatus({ autoCreateMissing: true });
    res.json({
      openwa_ready: !gatewayError,
      ...(gatewayError ? { openwa_error: gatewayError } : {}),
      accounts
    });
  });

  app.get('/api/status/:accountId', requireAccount, async (req, res) => {
    const acc = req.account;
    try {
      const { session, sessionIdChanged } = await gateway.ensureSession(acc, { autoStart: false });
      if (sessionIdChanged && session) {
        await updateAccountSessionId(acc.id, session.id);
      }
      res.json(gateway.formatPublicAccount(acc, session, { defaultAccountId: DEFAULT_ACCOUNT_ID }));
    } catch (err) {
      res.json(gateway.formatPublicAccount(acc, null, {
        defaultAccountId: DEFAULT_ACCOUNT_ID,
        gatewayError: err.message
      }));
    }
  });

  // ---- account management ----
  app.get('/api/accounts', requireApiKey, async (req, res) => {
    const { accounts, gatewayError } = await getAccountsWithStatus({ autoCreateMissing: true });
    res.json({
      accounts,
      ...(gatewayError ? { openwa_error: gatewayError } : {})
    });
  });

  // Add a new WhatsApp account: { "label": "Asif's CarryBee number" }
  app.post('/api/accounts', requireApiKey, async (req, res) => {
    const { label } = req.body || {};
    if (!label || !String(label).trim()) {
      return res.status(400).json({ error: 'label is required' });
    }
    const cleanLabel = String(label).trim();
    const list = await loadAccountsRegistry();
    const id = slugify(cleanLabel, list);
    const newEntry = { id, label: cleanLabel };

    let session = null;
    let gatewayError = null;
    try {
      const ensured = await gateway.ensureSession(newEntry, { autoStart: true });
      session = ensured.session;
      if (session) newEntry.openwa_session_id = session.id;
    } catch (err) {
      gatewayError = err.message;
      console.error(`[${id}] OpenWA session init deferred:`, err.message);
    }

    list.push(newEntry);
    await saveAccountsRegistry(list);
    console.log(`[admin:${req.adminName}] added account "${cleanLabel}" (${id})`);

    const pub = gateway.formatPublicAccount(newEntry, session, {
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      gatewayError
    });

    res.json({
      ok: true,
      account: pub,
      qr_url: `/qr/${id}`,
      pair_url: `/pair/${id}`
    });
  });

  // Remove a WhatsApp account (not the default one).
  app.delete('/api/accounts/:accountId', requireApiKey, requireAccount, async (req, res) => {
    const acc = req.account;
    if (acc.id === DEFAULT_ACCOUNT_ID) {
      return res.status(400).json({ error: 'The default account cannot be removed.' });
    }
    console.log(`[admin:${req.adminName}] removing account "${acc.label}" (${acc.id})`);
    try {
      await gateway.removeSession(acc);
    } catch (err) {
      console.error(`[${acc.id}] OpenWA session cleanup warning:`, err.message);
    }
    const updated = (await loadAccountsRegistry()).filter(a => a.id !== acc.id);
    await saveAccountsRegistry(updated);
    res.json({ ok: true });
  });

  // Manually restart one account's OpenWA session
  app.post('/api/accounts/:accountId/restart', requireApiKey, requireAccount, async (req, res) => {
    const acc = req.account;
    console.log(`[admin:${req.adminName}] manual restart of "${acc.label}" (${acc.id})`);
    try {
      const { session, sessionIdChanged } = await gateway.restartSession(acc);
      if (sessionIdChanged && session) {
        await updateAccountSessionId(acc.id, session.id);
      }
      res.json({
        ok: true,
        account: gateway.formatPublicAccount(acc, session, { defaultAccountId: DEFAULT_ACCOUNT_ID })
      });
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    }
  });

  // List all WhatsApp groups a given account is a member of
  app.get('/api/groups/:accountId', requireApiKey, requireAccount, async (req, res) => {
    const acc = req.account;
    try {
      const { groups, session, sessionIdChanged } = await gateway.listGroupsForAccount(acc);
      if (sessionIdChanged && session) {
        await updateAccountSessionId(acc.id, session.id);
      }
      res.json({ groups });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // View current group mapping
  app.get('/api/mapping', requireApiKey, async (req, res) => {
    res.json(await loadMapping());
  });

  // Add or update a mapping entry:
  // { "dashboard_name": "...", "group_id": "...@g.us", "account_id": "default" }
  app.post('/api/mapping', requireApiKey, async (req, res) => {
    const { dashboard_name, group_id, account_id } = req.body || {};
    if (!dashboard_name || !group_id) {
      return res.status(400).json({ error: 'dashboard_name and group_id are required' });
    }
    const resolvedAccountId = account_id || DEFAULT_ACCOUNT_ID;
    const registry = await loadAccountsRegistry();
    if (!registry.some(a => a.id === resolvedAccountId)) {
      return res.status(400).json({ error: `Unknown account_id "${resolvedAccountId}". See GET /api/accounts.` });
    }
    const mapping = await loadMapping();
    mapping[normalizeName(dashboard_name)] = {
      label: String(dashboard_name).trim(),
      group_id: String(group_id).trim(),
      account_id: resolvedAccountId
    };
    await saveMapping(mapping);
    res.json({ ok: true, mapping });
  });

  // Remove a mapping entry
  app.delete('/api/mapping/:dashboard_name', requireApiKey, async (req, res) => {
    const mapping = await loadMapping();
    const key = normalizeName(req.params.dashboard_name);
    delete mapping[key];
    await saveMapping(mapping);
    res.json({ ok: true, mapping });
  });

  // View current KAM → sending-account mapping
  app.get('/api/kam-mapping', requireApiKey, async (req, res) => {
    res.json(await loadKamMapping());
  });

  // Add or update a KAM mapping entry: { "email": "...", "account_id": "..." }
  app.post('/api/kam-mapping', requireApiKey, async (req, res) => {
    const { email, account_id } = req.body || {};
    if (!email || !account_id) {
      return res.status(400).json({ error: 'email and account_id are required' });
    }
    const registry = await loadAccountsRegistry();
    if (!registry.some(a => a.id === account_id)) {
      return res.status(400).json({ error: `Unknown account_id "${account_id}". See GET /api/accounts.` });
    }
    const mapping = await loadKamMapping();
    mapping[normalizeEmail(email)] = { email: String(email).trim(), account_id };
    await saveKamMapping(mapping);
    res.json({ ok: true, mapping });
  });

  // Remove a KAM mapping entry
  app.delete('/api/kam-mapping/:email', requireApiKey, async (req, res) => {
    const mapping = await loadKamMapping();
    delete mapping[normalizeEmail(req.params.email)];
    await saveKamMapping(mapping);
    res.json({ ok: true, mapping });
  });

  // Main endpoint: dashboard calls this when a KAM saves a remark.
  // body: { group_name, message, kam_email?, idempotency_key? }
  app.post('/api/send-remark', requireApiKey, async (req, res) => {
    const { group_name, message, kam_email, idempotency_key } = req.body || {};
    if (!group_name || !message) {
      return res.status(400).json({ error: 'group_name and message are required' });
    }

    const mapping = await loadMapping();
    const entry = mapping[normalizeName(group_name)];
    if (!entry) {
      return res.status(404).json({
        error: `No WhatsApp group mapped for "${group_name}". Add it via POST /api/mapping or /admin first.`
      });
    }

    const registry = await loadAccountsRegistry();

    // Sending account: prefer the logged-in KAM's mapped account, then the
    // group's own account_id, then the default account.
    let accountId = entry.account_id || DEFAULT_ACCOUNT_ID;
    let accountSource = 'group mapping';
    if (kam_email) {
      const kamMapping = await loadKamMapping();
      const kamEntry = kamMapping[normalizeEmail(kam_email)];
      if (kamEntry && registry.some(a => a.id === kamEntry.account_id)) {
        accountId = kamEntry.account_id;
        accountSource = `KAM mapping (${kam_email})`;
      }
    }

    const acc = registry.find(a => a.id === accountId);
    if (!acc) {
      return res.status(500).json({ error: `${accountSource} points at unknown account "${accountId}".` });
    }

    const idemKey = req.header('idempotency-key') || idempotency_key || undefined;

    try {
      const sent = await gateway.sendGroupText(acc, entry.group_id, message, idemKey);
      if (sent.sessionIdChanged && sent.session) {
        await updateAccountSessionId(acc.id, sent.session.id);
      }
      res.json({
        ok: true,
        sent_to: entry.label,
        via_account: acc.label,
        ...(sent.messageId ? { message_id: sent.messageId } : {})
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // One-click admin page
  app.get('/admin', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>CarryBee Bridge Admin (OpenWA)</title>
      <link rel="icon" href="data:,">
      <style>
        body{font-family:'Plus Jakarta Sans',Arial,sans-serif;background:#FFFDF7;color:#1c1c1c;max-width:820px;margin:40px auto;padding:0 20px;}
        h1{font-family:'Space Grotesk',sans-serif;font-size:22px;}
        h2{font-size:15px;margin-top:36px;border-top:1px solid #eee;padding-top:24px;}
        label{display:block;font-size:12px;font-weight:600;color:#555;margin-bottom:4px;margin-top:12px;}
        input,select{width:100%;box-sizing:border-box;font-size:14px;padding:9px 10px;border-radius:8px;border:1px solid #ccc;}
        button{font-size:13px;padding:9px 16px;border-radius:8px;border:none;background:#FFC72C;font-weight:700;cursor:pointer;margin-top:12px;}
        button.secondary{background:#eee;}
        button.danger{background:#fdeceb;color:#D64545;}
        table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px;}
        td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;}
        .msg{font-size:13px;padding:8px 10px;border-radius:6px;margin-top:10px;}
        .msg.ok{background:#e9f6ee;color:#2E8B57;}
        .msg.err{background:#fdeceb;color:#D64545;}
        .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-weight:600;font-size:11px;}
        .on{background:#e9f6ee;color:#2E8B57;}
        .off{background:#fdeceb;color:#D64545;}
        .row{display:flex;gap:8px;align-items:end;}
        .row > div{flex:1;}
        code{background:#faf8f0;padding:1px 5px;border-radius:4px;font-size:12px;}
      </style>
    </head>
    <body>
      <h1>🐝 CarryBee Bridge Admin <small style="font-size:13px;color:#7a7566;font-weight:500;">(OpenWA + ${escapeHtml(storageBackend.toUpperCase())})</small></h1>

      <label>Bridge API Key</label>
      <input type="password" id="apiKey" placeholder="paste your API_KEY here" />
      <p style="font-size:11px;color:#888;">This stays only in your browser tab — it's sent with each button click below, nothing is saved anywhere.</p>

      <h2>0. OpenWA Gateway Connection <small style="font-size:12px;color:#7a7566;font-weight:400;">(for Vercel / External Docker)</small></h2>
      <p style="font-size:11px;color:#666;margin-top:-6px;">When CarryBee Bridge runs on <strong>Vercel + Supabase</strong>, paste your OpenWA Docker URL (Render Docker today, or XeonBD VPS IP in a few days) &amp; OpenWA API Key below. When running all-in-one inside Docker, this connects automatically.</p>
      <div class="row">
        <div>
          <label>OpenWA Gateway URL</label>
          <input type="text" id="gwBaseUrl" placeholder="https://your-openwa-docker.onrender.com  or  http://VPS_IP:2785" />
        </div>
        <div>
          <label>OpenWA API Key <span id="gwKeyHint" style="color:#2E8B57;font-weight:400;"></span></label>
          <input type="password" id="gwApiKey" placeholder="owa_k1_..." />
        </div>
      </div>
      <button onclick="saveGatewayConfig()">Save &amp; Test OpenWA Connection</button>
      <button class="secondary" onclick="loadGatewayConfig()" style="margin-left:6px;">Check Current Gateway</button>
      <div id="gwMsg"></div>

      <h2>1. WhatsApp accounts</h2>
      <button onclick="loadAccounts()">Refresh accounts</button>
      <div id="accountsMsg"></div>
      <table id="accountsTable" style="display:none;">
        <thead><tr><th>Label</th><th>ID</th><th>Status</th><th>Connect / Actions</th><th></th></tr></thead>
        <tbody id="accountsBody"></tbody>
      </table>

      <div class="row" style="margin-top:16px;">
        <div>
          <label>Add another WhatsApp account (e.g. a colleague's CarryBee number)</label>
          <input type="text" id="newAccountLabel" placeholder="e.g. Asif's CarryBee number" />
        </div>
      </div>
      <button onclick="addAccount()">Add account</button>
      <div id="addAccountMsg"></div>

      <h2>2. Your WhatsApp groups</h2>
      <label>Which account should we list groups for?</label>
      <select id="groupsAccountSelect"><option value="">Load accounts above first</option></select>
      <button onclick="loadGroups()">Load groups for this account</button>
      <div id="groupsMsg"></div>
      <table id="groupsTable" style="display:none;">
        <thead><tr><th>Group name</th><th>Group ID</th></tr></thead>
        <tbody id="groupsBody"></tbody>
      </table>

      <h2>3. Map a dashboard group name → WhatsApp group</h2>
      <div class="row">
        <div>
          <label>Dashboard group name (exact text, e.g. "CarryBee Issue Group || NN1")</label>
          <input type="text" id="mapName" placeholder="CarryBee Issue Group || NN1" />
        </div>
      </div>
      <label>WhatsApp group (from the list loaded above, for the account selected above)</label>
      <select id="mapGroupSelect" style="width:100%;">
        <option value="">Load groups above first</option>
      </select>
      <button onclick="saveMapping()">Save mapping</button>
      <div id="mapMsg"></div>

      <h2>4. Current mappings</h2>
      <button class="secondary" onclick="loadMappings()">Refresh current mappings</button>
      <div id="mappingsMsg"></div>
      <table id="mappingsTable" style="display:none;">
        <thead><tr><th>Dashboard group name</th><th>WhatsApp group ID</th><th>Sends via</th><th></th></tr></thead>
        <tbody id="mappingsBody"></tbody>
      </table>

      <h2>5. Map a KAM (dashboard login) → sending WhatsApp account</h2>
      <p style="font-size:11px;color:#888;margin-top:-6px;">This decides whose WhatsApp number a KAM's remarks go out from — independent of which group they're going to. Without an entry here, that KAM's sends fall back to the group's default account.</p>
      <div class="row">
        <div>
          <label>KAM's dashboard login email</label>
          <input type="text" id="kamEmail" placeholder="nuruzzaman.nahid@carrybee.com" />
        </div>
      </div>
      <label>Sends via WhatsApp account</label>
      <select id="kamAccountSelect" style="width:100%;">
        <option value="">Load accounts above first</option>
      </select>
      <button onclick="saveKamMapping()">Save KAM mapping</button>
      <div id="kamMapMsg"></div>

      <h2>6. Current KAM mappings</h2>
      <button class="secondary" onclick="loadKamMappings()">Refresh KAM mappings</button>
      <div id="kamMappingsMsg"></div>
      <table id="kamMappingsTable" style="display:none;">
        <thead><tr><th>KAM email</th><th>Sends via</th><th></th></tr></thead>
        <tbody id="kamMappingsBody"></tbody>
      </table>

      <script>
        function esc(s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }
        function key() { return document.getElementById('apiKey').value.trim(); }
        function showMsg(elId, html, ok) {
          document.getElementById(elId).innerHTML = '<div class="msg ' + (ok ? 'ok' : 'err') + '">' + html + '</div>';
        }
        async function api(path, opts = {}) {
          const res = await fetch(path, {
            ...opts,
            headers: { 'Content-Type': 'application/json', 'x-api-key': key(), ...(opts.headers || {}) }
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status));
          return data;
        }

        let lastAccounts = [];
        let lastGroups = [];

        async function loadGatewayConfig() {
          if (!key()) { showMsg('gwMsg', 'Enter your Bridge API key above first.', false); return; }
          showMsg('gwMsg', 'Checking OpenWA Gateway status...', true);
          try {
            const data = await api('/api/gateway-config');
            if (data.base_url) document.getElementById('gwBaseUrl').value = data.base_url;
            document.getElementById('gwKeyHint').textContent = data.masked_api_key ? ('(saved: ' + data.masked_api_key + ')') : '';
            const gw = data.openwa || {};
            if (gw.ready) {
              showMsg('gwMsg', 'Connected to OpenWA Gateway at <code>' + esc(gw.base_url) + '</code>' + (gw.version ? ' (v' + esc(gw.version) + ')' : '') + ' · Storage: <strong>' + esc(data.storage_backend) + '</strong>.', true);
            } else {
              showMsg('gwMsg', 'Storage: <strong>' + esc(data.storage_backend) + '</strong> · OpenWA not ready yet: ' + esc(gw.error || 'Not configured'), false);
            }
          } catch (e) {
            showMsg('gwMsg', esc(e.message), false);
          }
        }

        async function saveGatewayConfig() {
          if (!key()) { showMsg('gwMsg', 'Enter your Bridge API key above first.', false); return; }
          const base_url = document.getElementById('gwBaseUrl').value.trim();
          const api_key = document.getElementById('gwApiKey').value.trim();
          if (!base_url) { showMsg('gwMsg', 'Enter your OpenWA Gateway URL first.', false); return; }
          showMsg('gwMsg', 'Saving to Supabase & testing OpenWA connection...', true);
          try {
            const data = await api('/api/gateway-config', {
              method: 'POST',
              body: JSON.stringify({ base_url, api_key })
            });
            document.getElementById('gwApiKey').value = '';
            document.getElementById('gwKeyHint').textContent = data.masked_api_key ? ('(saved: ' + data.masked_api_key + ')') : '';
            const gw = data.openwa || {};
            if (gw.ready) {
              showMsg('gwMsg', 'Saved & Connected! OpenWA is live at <code>' + esc(gw.base_url) + '</code>' + (gw.version ? ' (v' + esc(gw.version) + ')' : '') + '. Refreshing accounts...', true);
              loadAccounts();
            } else {
              showMsg('gwMsg', 'Saved in ' + esc(data.storage_backend) + ', but OpenWA returned: ' + esc(gw.error || 'Still warming up'), false);
            }
          } catch (e) {
            showMsg('gwMsg', esc(e.message), false);
          }
        }

        async function loadAccounts() {
          if (!key()) { showMsg('accountsMsg', 'Enter your API key first.', false); return; }
          showMsg('accountsMsg', 'Loading...', true);
          try {
            const data = await api('/api/accounts');
            lastAccounts = data.accounts || [];
            const body = document.getElementById('accountsBody');
            body.innerHTML = lastAccounts.map(a => {
              const idAttr = esc(a.id);
              const idUri = encodeURIComponent(a.id);
              const statusLabel = a.ready
                ? ('Connected' + (a.name ? ' as ' + esc(a.name) : ''))
                : ('Not connected' + (a.last_status ? ' (' + esc(a.last_status) + ')' : ''));
              const actions = a.ready
                ? ('<a href="#" data-id="' + idAttr + '" onclick="restartAccount(this.dataset.id);return false;">restart</a>')
                : ('<a href="/qr/' + idUri + '" target="_blank">QR</a> / <a href="/pair/' + idUri + '" target="_blank">code</a> / <a href="#" data-id="' + idAttr + '" onclick="restartAccount(this.dataset.id);return false;">restart</a>');
              const delBtn = a.deletable
                ? '<button class="danger" data-id="' + idAttr + '" onclick="removeAccount(this.dataset.id)">Remove</button>'
                : '';
              return '<tr><td>' + esc(a.label) + '</td><td><code>' + esc(a.id) + '</code></td>' +
                '<td><span class="badge ' + (a.ready ? 'on' : 'off') + '">' + statusLabel + '</span></td>' +
                '<td>' + actions + '</td>' +
                '<td>' + delBtn + '</td></tr>';
            }).join('');
            document.getElementById('accountsTable').style.display = lastAccounts.length ? 'table' : 'none';
            const optsHtml = lastAccounts.map(a =>
              '<option value="' + esc(a.id) + '">' + esc(a.label) + (a.ready ? '' : ' (not connected)') + '</option>'
            ).join('');
            document.getElementById('groupsAccountSelect').innerHTML = optsHtml;
            document.getElementById('kamAccountSelect').innerHTML = optsHtml;
            if (data.openwa_error) {
              showMsg('accountsMsg', 'Loaded ' + lastAccounts.length + ' account(s), but OpenWA reported: ' + esc(data.openwa_error), false);
            } else {
              showMsg('accountsMsg', 'Loaded ' + lastAccounts.length + ' account(s).', true);
            }
          } catch (e) {
            showMsg('accountsMsg', esc(e.message), false);
          }
        }

        async function restartAccount(id) {
          if (!key()) return;
          try {
            await api('/api/accounts/' + encodeURIComponent(id) + '/restart', { method: 'POST' });
            showMsg('accountsMsg', 'Restarting "' + esc(id) + '" in OpenWA... refresh or open its QR page in a few seconds.', true);
            setTimeout(loadAccounts, 2000);
          } catch (e) {
            showMsg('accountsMsg', esc(e.message), false);
          }
        }

        async function addAccount() {
          if (!key()) { showMsg('addAccountMsg', 'Enter your API key first.', false); return; }
          const label = document.getElementById('newAccountLabel').value.trim();
          if (!label) { showMsg('addAccountMsg', 'Give the account a label first.', false); return; }
          try {
            const data = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ label }) });
            showMsg('addAccountMsg', 'Added "' + esc(label) + '". Open <a href="' + esc(data.qr_url) + '" target="_blank">' + esc(data.qr_url) + '</a> to scan it in.', true);
            document.getElementById('newAccountLabel').value = '';
            loadAccounts();
          } catch (e) {
            showMsg('addAccountMsg', esc(e.message), false);
          }
        }

        async function removeAccount(id) {
          if (!key()) return;
          if (!confirm('Remove this WhatsApp account? Any group mappings still pointing at it will stop working until re-mapped.')) return;
          try {
            await api('/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
            loadAccounts();
          } catch (e) {
            showMsg('accountsMsg', esc(e.message), false);
          }
        }

        async function loadGroups() {
          if (!key()) { showMsg('groupsMsg', 'Enter your API key first.', false); return; }
          const accountId = document.getElementById('groupsAccountSelect').value;
          if (!accountId) { showMsg('groupsMsg', 'Load and pick an account first.', false); return; }
          showMsg('groupsMsg', 'Loading groups from OpenWA...', true);
          try {
            const data = await api('/api/groups/' + encodeURIComponent(accountId));
            lastGroups = (data.groups || []).map(g => ({ ...g, account_id: accountId }));
            const body = document.getElementById('groupsBody');
            body.innerHTML = lastGroups.map(g => '<tr><td>' + esc(g.name) + '</td><td><code>' + esc(g.id) + '</code></td></tr>').join('');
            document.getElementById('groupsTable').style.display = lastGroups.length ? 'table' : 'none';
            const select = document.getElementById('mapGroupSelect');
            select.innerHTML = lastGroups.map(g => '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>').join('');
            showMsg('groupsMsg', 'Loaded ' + lastGroups.length + ' groups for this account.', true);
          } catch (e) {
            showMsg('groupsMsg', esc(e.message), false);
          }
        }

        async function saveMapping() {
          if (!key()) { showMsg('mapMsg', 'Enter your API key first.', false); return; }
          const dashboard_name = document.getElementById('mapName').value.trim();
          const group_id = document.getElementById('mapGroupSelect').value;
          const accountId = document.getElementById('groupsAccountSelect').value;
          if (!dashboard_name || !group_id) { showMsg('mapMsg', 'Fill in both the dashboard name and pick a WhatsApp group.', false); return; }
          try {
            await api('/api/mapping', { method: 'POST', body: JSON.stringify({ dashboard_name, group_id, account_id: accountId }) });
            showMsg('mapMsg', 'Saved: "' + esc(dashboard_name) + '" → that WhatsApp group.', true);
            document.getElementById('mapName').value = '';
            loadMappings();
          } catch (e) {
            showMsg('mapMsg', esc(e.message), false);
          }
        }

        async function loadMappings() {
          if (!key()) { showMsg('mappingsMsg', 'Enter your API key first.', false); return; }
          try {
            const data = await api('/api/mapping');
            const entries = Object.entries(data);
            const body = document.getElementById('mappingsBody');
            body.innerHTML = entries.map(([k, v]) =>
              '<tr><td>' + esc(v.label) + '</td><td><code>' + esc(v.group_id) + '</code></td><td>' + esc(v.account_id || 'default') + '</td>' +
              '<td><button class="secondary" data-label="' + esc(v.label) + '" onclick="removeMapping(this.dataset.label)">Remove</button></td></tr>'
            ).join('');
            document.getElementById('mappingsTable').style.display = entries.length ? 'table' : 'none';
            showMsg('mappingsMsg', entries.length + ' mapping(s) saved.', true);
          } catch (e) {
            showMsg('mappingsMsg', esc(e.message), false);
          }
        }

        async function removeMapping(name) {
          if (!key()) return;
          try {
            await api('/api/mapping/' + encodeURIComponent(name), { method: 'DELETE' });
            loadMappings();
          } catch (e) {
            showMsg('mappingsMsg', esc(e.message), false);
          }
        }

        async function saveKamMapping() {
          if (!key()) { showMsg('kamMapMsg', 'Enter your API key first.', false); return; }
          const email = document.getElementById('kamEmail').value.trim();
          const account_id = document.getElementById('kamAccountSelect').value;
          if (!email || !account_id) { showMsg('kamMapMsg', 'Fill in the email and pick an account.', false); return; }
          try {
            await api('/api/kam-mapping', { method: 'POST', body: JSON.stringify({ email, account_id }) });
            showMsg('kamMapMsg', 'Saved: "' + esc(email) + '" sends via that account.', true);
            document.getElementById('kamEmail').value = '';
            loadKamMappings();
          } catch (e) {
            showMsg('kamMapMsg', esc(e.message), false);
          }
        }

        async function loadKamMappings() {
          if (!key()) { showMsg('kamMappingsMsg', 'Enter your API key first.', false); return; }
          try {
            const data = await api('/api/kam-mapping');
            const entries = Object.entries(data);
            const body = document.getElementById('kamMappingsBody');
            body.innerHTML = entries.map(([emailKey, v]) => {
              const acc = lastAccounts.find(a => a.id === v.account_id);
              return '<tr><td>' + esc(v.email) + '</td><td>' + esc(acc ? acc.label : v.account_id) + '</td>' +
                '<td><button class="secondary" data-email="' + esc(v.email) + '" onclick="removeKamMapping(this.dataset.email)">Remove</button></td></tr>';
            }).join('');
            document.getElementById('kamMappingsTable').style.display = entries.length ? 'table' : 'none';
            showMsg('kamMappingsMsg', entries.length + ' KAM mapping(s) saved.', true);
          } catch (e) {
            showMsg('kamMappingsMsg', esc(e.message), false);
          }
        }

        async function removeKamMapping(email) {
          if (!key()) return;
          try {
            await api('/api/kam-mapping/' + encodeURIComponent(email), { method: 'DELETE' });
            loadKamMappings();
          } catch (e) {
            showMsg('kamMappingsMsg', esc(e.message), false);
          }
        }
      </script>
    </body>
    </html>
    `);
  });

  app.syncAccountsOnBoot = async function syncAccountsOnBoot({ maxAttempts = 10 } = {}) {
    // If running inside Docker with a known public URL (e.g. Render Docker or VPS) and shared Supabase KV,
    // auto-register this OpenWA Gateway URL + API key so the Vercel front-end links automatically.
    const publicGatewayUrl = (process.env.PUBLIC_GATEWAY_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
    const localOpenwaKey = (process.env.OPENWA_API_KEY || '').trim();
    if (publicGatewayUrl && localOpenwaKey && fs.existsSync('/app/dist/main')) {
      const gatewayEndpoint = publicGatewayUrl.endsWith('/openwa')
        ? publicGatewayUrl
        : `${publicGatewayUrl}/openwa`;
      try {
        await saveGatewayConfig({
          base_url: gatewayEndpoint,
          api_key: localOpenwaKey,
          updated_at: new Date().toISOString()
        });
        console.log(`[server] Auto-registered OpenWA Gateway (${gatewayEndpoint}) in ${storageBackend} for Vercel.`);
      } catch (e) {
        console.warn('[server] Could not auto-register gateway URL:', e.message);
      }
    }

    let lastBaseUrl = 'http://127.0.0.1:2785';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const health = await gateway.checkHealth();
      if (health.base_url) lastBaseUrl = health.base_url;
      if (health.ready) {
        const { accounts } = await getAccountsWithStatus({
          autoCreateMissing: true,
          autoStartCreated: true
        });
        console.log(`[server] OpenWA Gateway connected (${lastBaseUrl}) — synced ${accounts.length} CarryBee account(s).`);
        return;
      }
      const delayMs = Math.min(2000 * attempt, 10000);
      if (attempt === 1 || attempt === maxAttempts) {
        console.log(`[server] Waiting for OpenWA Gateway (${lastBaseUrl}) — attempt ${attempt}/${maxAttempts}...`);
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    console.warn(`[server] OpenWA Gateway not ready yet at ${lastBaseUrl}; accounts will sync automatically on the next request.`);
  };

  return app;
}

const app = createApp();
app.createApp = createApp;

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CarryBee WhatsApp Bridge (OpenWA) running on http://0.0.0.0:${PORT}`);
    app.syncAccountsOnBoot().catch(err => {
      console.error('[server] initial OpenWA sync error:', err.message);
    });
  });
}

module.exports = app;
