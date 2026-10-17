require('dotenv').config();

// Safety net: log unexpected errors instead of letting one bad promise
// crash the entire bridge and force a re-pair.
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
const qrcode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const TursoKVStore = require('./turso-store');
const useTursoAuthState = require('./baileys-auth');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'changeme';
const MAPPING_FILE = path.join(__dirname, 'groups-config.json');
const DEFAULT_ACCOUNT_ID = 'default';

// Reconnect backoff (ms). Prevents the instant-reconnect loop that used to
// hammer WhatsApp and never reach the QR stage when a handshake was rejected.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;

// ---------- named admins ----------
// ADMIN_KEYS lets more than one person use /admin, each with their own key.
// Format (comma-separated): ADMIN_KEYS=Nahid:long-random,Asif:another-long-random
// The original API_KEY still works too (as an unnamed admin).
const ADMIN_KEYS = new Map(); // key string -> label
(process.env.ADMIN_KEYS || '').split(',').forEach((entry) => {
  const idx = entry.indexOf(':');
  if (idx === -1) return;
  const label = entry.slice(0, idx).trim();
  const key = entry.slice(idx + 1).trim();
  if (label && key) ADMIN_KEYS.set(key, label);
});

// ---------- per-account state ----------
// accounts[id] = { id, label, sock, isReady, userInfo, latestQr,
//                  lastStatus, lastError, retries, reconnectTimer }
// The first account is always "default" and uses bare Turso keys (no prefix),
// so an already-connected number keeps its session.
const accounts = {};

function keyPrefixFor(accountId) {
  return accountId === DEFAULT_ACCOUNT_ID ? '' : `${accountId}::`;
}

function publicAccountInfo(a) {
  return {
    id: a.id,
    label: a.label,
    ready: !!a.isReady,
    name: a.isReady && a.userInfo ? (a.userInfo.name || a.userInfo.id) : null,
    deletable: a.id !== DEFAULT_ACCOUNT_ID,
    last_status: a.lastStatus || null,
    last_error: a.lastError || null
  };
}

function slugify(label) {
  const base = (label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'account';
  let candidate = base;
  let i = 2;
  while (accounts[candidate]) {
    candidate = `${base}-${i}`;
    i++;
  }
  return candidate;
}

// ---------- Turso KV store ----------
const kvStore = new TursoKVStore({
  url: process.env.TURSO_DB_URL,
  token: process.env.TURSO_DB_TOKEN
});

// ---------- accounts registry (Turso) ----------
async function loadAccountsRegistry() {
  try {
    const raw = await kvStore.get('accounts-registry');
    const list = raw ? JSON.parse(raw) : [];
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

// ---------- KAM → sending account mapping (Turso) ----------
// Decides WHICH connected WhatsApp account sends, based on who's logged into
// the dashboard (not on the target group).
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
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

// ---------- group mapping (Turso) ----------
// Stored in Turso (not local disk) so it survives Render restarts.
// Each entry carries account_id — which connected account posts to that group.
async function loadMapping() {
  try {
    const raw = await kvStore.get('group-mapping');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('[server] failed to load group mapping from Turso, falling back to local file:', e.message);
    try {
      return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
    } catch (e2) {
      return {};
    }
  }
}
async function saveMapping(mapping) {
  await kvStore.set('group-mapping', JSON.stringify(mapping));
  // Best-effort local copy, purely a debugging convenience — not relied on.
  try { fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2)); } catch (e) {}
}
function normalizeName(name) {
  return (name || '')
    .replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ') // NBSP/zero-width chars from copy-pasted sheet cells
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// ---------- outgoing message store (needed for Baileys retry requests) ----------
// Recipients' devices sometimes ask the sender to resend a message ("retry
// receipt"). Baileys can only answer if getMessage() returns the original
// content. Backed by Turso so a restart between send and retry doesn't lose it.
const OUTGOING_MSG_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day
const OUTGOING_MSG_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function rememberOutgoingMessage(accountId, remoteJid, id, message) {
  if (!id || !message) return;
  try {
    await kvStore.rememberOutgoing(`${accountId}::${remoteJid}::${id}`, message);
  } catch (e) {
    console.error('[server] failed to persist outgoing message for retry:', e.message);
  }
}

setInterval(() => {
  kvStore.pruneOutgoing(OUTGOING_MSG_MAX_AGE_MS)
    .catch(e => console.error('[server] failed to prune outgoing message cache:', e.message));
}, OUTGOING_MSG_PRUNE_INTERVAL_MS);

// ---------- WhatsApp version (cached) ----------
// Passing the current WA Web version is what prevents the 405 "Connection
// Failure" rejection that leaves the QR page stuck on "Waiting for QR code".
let cachedVersion = null;
let cachedVersionAt = 0;
const VERSION_TTL_MS = 6 * 60 * 60 * 1000;

async function getWaVersion() {
  const now = Date.now();
  if (cachedVersion && now - cachedVersionAt < VERSION_TTL_MS) return cachedVersion;
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    cachedVersion = version;
    cachedVersionAt = now;
    console.log(`[server] WhatsApp Web version ${version.join('.')} (isLatest: ${isLatest})`);
    return version;
  } catch (e) {
    console.error('[server] could not fetch latest WA version, using package default:', e.message);
    return cachedVersion || undefined;
  }
}

// ---------- whatsapp connections (Baileys — no Chrome needed) ----------
function clearReconnectTimer(acc) {
  if (acc && acc.reconnectTimer) {
    clearTimeout(acc.reconnectTimer);
    acc.reconnectTimer = null;
  }
}

function scheduleReconnect(accountId, delayMs) {
  const acc = accounts[accountId];
  if (!acc) return; // account was removed
  clearReconnectTimer(acc);
  acc.reconnectTimer = setTimeout(() => {
    acc.reconnectTimer = null;
    if (!accounts[accountId]) return;
    startSock(accountId, acc.label).catch(e => {
      console.error(`[${accountId}] startSock failed:`, e && e.message);
      acc.lastError = e && e.message;
      scheduleReconnect(accountId, backoffFor(acc));
    });
  }, delayMs);
}

function backoffFor(acc) {
  acc.retries = (acc.retries || 0) + 1;
  return Math.min(RECONNECT_BASE_MS * Math.pow(2, acc.retries - 1), RECONNECT_MAX_MS);
}

async function startSock(accountId, label) {
  const prefix = keyPrefixFor(accountId);

  const acc = accounts[accountId] || (accounts[accountId] = { id: accountId, label });
  acc.label = label || acc.label;
  acc.isReady = false;
  acc.latestQr = null;
  clearReconnectTimer(acc);

  // Tear down any previous socket for this account so two never run at once.
  if (acc.sock) {
    try { acc.sock.ev.removeAllListeners(); } catch (e) {}
    try { acc.sock.end(undefined); } catch (e) {}
    acc.sock = null;
  }

  console.log(`[${accountId}] loading auth state from Turso...`);
  const { state, saveCreds } = await useTursoAuthState(kvStore, prefix);
  console.log(`[${accountId}] auth state loaded (registered: ${!!state.creds.registered}). Starting socket...`);

  const version = await getWaVersion();

  // The account may have been removed while we were awaiting above.
  if (!accounts[accountId]) return;

  const sock = makeWASocket({
    version, // undefined falls back to the package default
    browser: Browsers.macOS('Chrome'),
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    // Lets Baileys resend real content when a recipient device requests a
    // retry, instead of the message staying stuck undecrypted on their end.
    getMessage: async (key) => {
      try {
        return (await kvStore.getOutgoing(`${accountId}::${key.remoteJid}::${key.id}`)) || undefined;
      } catch (e) {
        console.error('[server] failed to look up outgoing message for retry:', e.message);
        return undefined;
      }
    }
  });
  acc.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    // Ignore events from a socket that has already been replaced/removed.
    if (acc.sock !== sock || !accounts[accountId]) return;

    const { connection, lastDisconnect, qr } = update;

    if (connection === 'connecting') {
      console.log(`[${accountId}] connecting...`);
    }

    if (qr) {
      qrcode.toDataURL(qr)
        .then(dataUrl => { if (acc.sock === sock) acc.latestQr = dataUrl; })
        .catch(e => console.error(`[${accountId}] QR render failed:`, e.message));
      acc.isReady = false;
      console.log(`[${accountId}] New QR code generated. Visit /qr/${accountId} to scan it, or /pair/${accountId}?phone=YOURNUMBER for a pairing code instead.`);
    }

    if (connection === 'open') {
      acc.isReady = true;
      acc.latestQr = null;
      acc.userInfo = sock.user;
      acc.lastStatus = null;
      acc.lastError = null;
      acc.retries = 0;
      console.log(`[${accountId}] WhatsApp connected as`, acc.userInfo && (acc.userInfo.name || acc.userInfo.id));
    }

    if (connection === 'close') {
      acc.isReady = false;
      acc.latestQr = null;
      const err = lastDisconnect && lastDisconnect.error;
      const statusCode = err ? new Boom(err).output.statusCode : undefined;
      acc.lastStatus = statusCode || null;
      acc.lastError = (err && err.message) || null;
      console.log(`[${accountId}] Connection closed. Status code:`, statusCode, '|', acc.lastError);

      if (statusCode === DisconnectReason.loggedOut) {
        // Stored session is dead. Wipe just this account's keys so the next
        // start offers a fresh QR, without touching other accounts.
        console.log(`[${accountId}] logged out — clearing stale session, a new QR will be generated.`);
        acc.retries = 0;
        kvStore.clearAccountSession(prefix)
          .catch(e => console.error(`[${accountId}] failed to clear stale session:`, e.message))
          .finally(() => scheduleReconnect(accountId, 2000));
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        // Same session is live elsewhere (e.g. an old bridge deployment using
        // the same Turso DB). Reconnecting would just start a tug-of-war.
        console.log(`[${accountId}] connection replaced by another session — NOT reconnecting. Stop the other deployment, then restart this one.`);
      } else if (statusCode === DisconnectReason.restartRequired) {
        // Normal right after pairing succeeds.
        acc.retries = 0;
        scheduleReconnect(accountId, 500);
      } else {
        const delay = backoffFor(acc);
        console.log(`[${accountId}] reconnecting in ${Math.round(delay / 1000)}s (attempt ${acc.retries})...`);
        scheduleReconnect(accountId, delay);
      }
    }
  });
}

async function initAccounts() {
  const list = await loadAccountsRegistry();
  await saveAccountsRegistry(list); // persist the default entry if it was just added
  for (const a of list) {
    accounts[a.id] = { id: a.id, label: a.label, isReady: false, userInfo: null, latestQr: null, retries: 0 };
  }
  // Sequential on purpose — avoids interleaved QR/log noise on boot.
  for (const a of list) {
    try {
      await startSock(a.id, a.label);
    } catch (e) {
      console.error(`[${a.id}] initial startSock failed:`, e && e.message);
      if (accounts[a.id]) {
        accounts[a.id].lastError = e && e.message;
        scheduleReconnect(a.id, backoffFor(accounts[a.id]));
      }
    }
  }
}

initAccounts().catch(e => console.error('[server] initAccounts failed:', e));

// ---------- express app ----------
const app = express();
app.use(cors());
app.use(express.json());

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (key === API_KEY) {
    req.adminName = 'default';
    return next();
  }
  if (key && ADMIN_KEYS.has(key)) {
    req.adminName = ADMIN_KEYS.get(key);
    return next();
  }
  return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
}

function requireAccount(req, res, next) {
  const acc = accounts[req.params.accountId];
  if (!acc) return res.status(404).json({ error: `Unknown account "${req.params.accountId}"` });
  req.account = acc;
  next();
}

// Status page
app.get('/', (req, res) => {
  const rows = Object.values(accounts).map(a => `
    <tr>
      <td>${a.label}</td>
      <td><code>${a.id}</code></td>
      <td><span class="badge ${a.isReady ? 'on' : 'off'}">${a.isReady ? 'Connected' : 'Not connected'}</span></td>
      <td>${a.isReady && a.userInfo ? (a.userInfo.name || a.userInfo.id) : `<a href="/qr/${a.id}">/qr</a> · <a href="/pair/${a.id}">/pair</a>${a.lastStatus ? ` <small>(last status ${a.lastStatus})</small>` : ''}`}</td>
    </tr>
  `).join('');
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>CarryBee WhatsApp Bridge</title>
    <style>
      body{font-family:'Plus Jakarta Sans',Arial,sans-serif;background:#FFFDF7;color:#1c1c1c;max-width:720px;margin:60px auto;padding:0 20px;}
      h1{font-family:'Space Grotesk',sans-serif;font-size:20px;}
      .badge{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:600;font-size:13px;}
      .on{background:#e9f6ee;color:#2E8B57;}
      .off{background:#fdeceb;color:#D64545;}
      a{color:#141414;font-weight:600;}
      code{background:#faf8f0;padding:2px 6px;border-radius:4px;}
      table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px;}
      td,th{text-align:left;padding:8px 10px;border-bottom:1px solid #eee;}
      footer{margin-top:40px;font-size:11px;color:#7a7566;}
    </style>
  </head>
  <body>
    <h1>🐝 CarryBee WhatsApp Bridge</h1>
    <p>${Object.keys(accounts).length} WhatsApp account(s) configured. Manage accounts and group mappings from <a href="/admin">/admin</a>.</p>
    <table>
      <thead><tr><th>Label</th><th>Account ID</th><th>Status</th><th>Connect / logged in as</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <footer>Powered by NAHID</footer>
  </body>
  </html>
  `);
});

// QR code page (per account)
app.get('/qr/:accountId', requireAccount, (req, res) => {
  const acc = req.account;
  if (acc.isReady) {
    return res.send(`<p style="font-family:sans-serif">"${acc.label}" is already connected. <a href="/">Back to status</a></p>`);
  }
  if (!acc.latestQr) {
    const diag = acc.lastStatus
      ? `<p style="color:#D64545;font-size:13px;">Last disconnect status: <b>${acc.lastStatus}</b>${acc.lastError ? ' — ' + acc.lastError : ''}. Retrying automatically.</p>`
      : '';
    return res.send(`
      <!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="4"><title>Waiting for QR</title></head>
      <body style="font-family:sans-serif">
        <p>Waiting for QR code to generate... this page refreshes automatically.</p>
        ${diag}
      </body></html>
    `);
  }
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="20"><title>Scan to connect — ${acc.label}</title>
    <style>body{font-family:sans-serif;text-align:center;margin-top:60px;background:#FFFDF7;}
    h1{font-family:sans-serif;color:#141414;}</style></head>
    <body>
      <h1>Scan with WhatsApp on your phone</h1>
      <p>Connecting: <strong>${acc.label}</strong></p>
      <p>WhatsApp → Linked devices → Link a device</p>
      <img src="${acc.latestQr}" style="width:280px;height:280px;border:8px solid #FFC72C;border-radius:12px;" />
      <p style="margin-top:24px;"><a href="/pair/${acc.id}">Prefer a code instead of scanning?</a></p>
    </body></html>
  `);
});

// Pairing code page — type this into WhatsApp instead of scanning a QR code (per account)
app.get('/pair/:accountId', requireAccount, async (req, res) => {
  const acc = req.account;
  if (acc.isReady) {
    return res.send(`<p style="font-family:sans-serif">"${acc.label}" is already connected. <a href="/">Back to status</a></p>`);
  }

  const rawPhone = (req.query.phone || '').replace(/[^\d]/g, '');

  const pageWrap = (body) => `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Link with phone number — ${acc.label}</title>
    <style>
      body{font-family:sans-serif;text-align:center;margin-top:60px;background:#FFFDF7;color:#141414;}
      input{font-size:18px;padding:10px;border-radius:8px;border:1px solid #ccc;width:260px;}
      button{font-size:16px;padding:10px 20px;border-radius:8px;border:none;background:#FFC72C;font-weight:700;cursor:pointer;margin-left:8px;}
      code{font-size:36px;letter-spacing:6px;background:#faf8f0;padding:16px 24px;border-radius:12px;border:8px solid #FFC72C;display:inline-block;margin-top:20px;}
    </style></head>
    <body>${body}</body></html>
  `;

  if (!rawPhone) {
    return res.send(pageWrap(`
      <h1>Link with phone number</h1>
      <p>Connecting: <strong>${acc.label}</strong></p>
      <p>Enter that WhatsApp number, with country code, no spaces, no + sign.<br>Example for Bangladesh: 8801XXXXXXXXX</p>
      <form action="/pair/${acc.id}" method="GET">
        <input type="text" name="phone" placeholder="8801XXXXXXXXX" required />
        <button type="submit">Get code</button>
      </form>
      <p style="margin-top:24px;"><a href="/qr/${acc.id}">Prefer to scan a QR code instead?</a></p>
    `));
  }

  if (!acc.sock || !acc.sock.authState || acc.sock.authState.creds.registered) {
    return res.send(pageWrap(`
      <h1>Not ready yet</h1>
      <p>The bridge is still starting up, or is already registered. Wait a few seconds and reload, or check <a href="/">the status page</a>.</p>
      ${acc.lastStatus ? `<p style="color:#D64545;font-size:13px;">Last disconnect status: <b>${acc.lastStatus}</b>${acc.lastError ? ' — ' + acc.lastError : ''}</p>` : ''}
    `));
  }

  try {
    const code = await acc.sock.requestPairingCode(rawPhone);
    res.send(pageWrap(`
      <h1>Enter this code in WhatsApp</h1>
      <p>On that phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead"</p>
      <code>${code}</code>
      <p style="margin-top:24px;color:#7a7566;font-size:13px;">Code expires after a short time — if it stops working, reload this page for a new one.</p>
    `));
  } catch (e) {
    res.send(pageWrap(`
      <h1>Something went wrong</h1>
      <p>${e.message}</p>
      <p><a href="/pair/${acc.id}">Try again</a></p>
    `));
  }
});

// Connection status (JSON) — all accounts, or a single one
app.get('/api/status', (req, res) => {
  res.json({ accounts: Object.values(accounts).map(publicAccountInfo) });
});
app.get('/api/status/:accountId', requireAccount, (req, res) => {
  res.json(publicAccountInfo(req.account));
});

// ---- account management ----
app.get('/api/accounts', requireApiKey, (req, res) => {
  res.json({ accounts: Object.values(accounts).map(publicAccountInfo) });
});

// Add a new WhatsApp account: { "label": "Asif's CarryBee number" }
app.post('/api/accounts', requireApiKey, async (req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) {
    return res.status(400).json({ error: 'label is required' });
  }
  const id = slugify(label);
  const list = await loadAccountsRegistry();
  list.push({ id, label: label.trim() });
  await saveAccountsRegistry(list);
  accounts[id] = { id, label: label.trim(), isReady: false, userInfo: null, latestQr: null, retries: 0 };
  console.log(`[admin:${req.adminName}] added account "${label.trim()}" (${id})`);
  // Don't block the response on the socket handshake.
  startSock(id, label.trim()).catch(e => {
    console.error(`[${id}] startSock failed:`, e && e.message);
    if (accounts[id]) {
      accounts[id].lastError = e && e.message;
      scheduleReconnect(id, backoffFor(accounts[id]));
    }
  });
  res.json({ ok: true, account: publicAccountInfo(accounts[id]), qr_url: `/qr/${id}`, pair_url: `/pair/${id}` });
});

// Remove a WhatsApp account (not the default one). Logs it out, wipes only
// its own session keys, and leaves the group mapping as-is — mapping entries
// pointing at it will fail with a clear error on send until re-pointed.
app.delete('/api/accounts/:accountId', requireApiKey, requireAccount, async (req, res) => {
  const acc = req.account;
  if (acc.id === DEFAULT_ACCOUNT_ID) {
    return res.status(400).json({ error: 'The default account cannot be removed.' });
  }
  console.log(`[admin:${req.adminName}] removing account "${acc.label}" (${acc.id})`);
  try {
    // Remove from memory FIRST so the close event from logout() can't
    // resurrect the account via the reconnect logic.
    delete accounts[acc.id];
    clearReconnectTimer(acc);
    if (acc.sock) {
      try { await acc.sock.logout(); } catch (e) { /* best-effort */ }
      try { acc.sock.ev.removeAllListeners(); } catch (e) {}
      try { acc.sock.end(undefined); } catch (e) {}
    }
  } finally {
    await kvStore.clearAccountSession(keyPrefixFor(acc.id));
    const list = (await loadAccountsRegistry()).filter(a => a.id !== acc.id);
    await saveAccountsRegistry(list);
  }
  res.json({ ok: true });
});

// Manually restart one account's connection (useful if it gets stuck)
app.post('/api/accounts/:accountId/restart', requireApiKey, requireAccount, async (req, res) => {
  const acc = req.account;
  console.log(`[admin:${req.adminName}] manual restart of "${acc.label}" (${acc.id})`);
  acc.retries = 0;
  startSock(acc.id, acc.label).catch(e => {
    console.error(`[${acc.id}] startSock failed:`, e && e.message);
    acc.lastError = e && e.message;
    scheduleReconnect(acc.id, backoffFor(acc));
  });
  res.json({ ok: true });
});

// List all WhatsApp groups a given account is a member of
app.get('/api/groups/:accountId', requireApiKey, requireAccount, async (req, res) => {
  const acc = req.account;
  if (!acc.isReady) return res.status(503).json({ error: `"${acc.label}" is not connected yet` });
  try {
    const groupsObj = await acc.sock.groupFetchAllParticipating();
    const groups = Object.values(groupsObj).map(g => ({ id: g.id, name: g.subject }));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// View current mapping
app.get('/api/mapping', requireApiKey, async (req, res) => {
  res.json(await loadMapping());
});

// Add or update a mapping entry:
// { "dashboard_name": "...", "group_id": "...@g.us", "account_id": "default" }
app.post('/api/mapping', requireApiKey, async (req, res) => {
  const { dashboard_name, group_id, account_id } = req.body;
  if (!dashboard_name || !group_id) {
    return res.status(400).json({ error: 'dashboard_name and group_id are required' });
  }
  const resolvedAccountId = account_id || DEFAULT_ACCOUNT_ID;
  if (!accounts[resolvedAccountId]) {
    return res.status(400).json({ error: `Unknown account_id "${resolvedAccountId}". See GET /api/accounts.` });
  }
  const mapping = await loadMapping();
  mapping[normalizeName(dashboard_name)] = { label: dashboard_name, group_id, account_id: resolvedAccountId };
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
  const { email, account_id } = req.body;
  if (!email || !account_id) {
    return res.status(400).json({ error: 'email and account_id are required' });
  }
  if (!accounts[account_id]) {
    return res.status(400).json({ error: `Unknown account_id "${account_id}". See GET /api/accounts.` });
  }
  const mapping = await loadKamMapping();
  mapping[normalizeEmail(email)] = { email, account_id };
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
// body: { group_name, message, kam_email? }
app.post('/api/send-remark', requireApiKey, async (req, res) => {
  const { group_name, message, kam_email } = req.body;
  if (!group_name || !message) {
    return res.status(400).json({ error: 'group_name and message are required' });
  }

  const mapping = await loadMapping();
  const entry = mapping[normalizeName(group_name)];
  if (!entry) {
    return res.status(404).json({
      error: `No WhatsApp group mapped for "${group_name}". Add it via POST /api/mapping first.`
    });
  }

  // Sending account: prefer the logged-in KAM's mapped account, then the
  // group's own account_id, then the default account.
  let accountId = entry.account_id || DEFAULT_ACCOUNT_ID;
  let accountSource = 'group mapping';
  if (kam_email) {
    const kamMapping = await loadKamMapping();
    const kamEntry = kamMapping[normalizeEmail(kam_email)];
    if (kamEntry && accounts[kamEntry.account_id]) {
      accountId = kamEntry.account_id;
      accountSource = `KAM mapping (${kam_email})`;
    }
  }

  const acc = accounts[accountId];
  if (!acc) {
    return res.status(500).json({ error: `${accountSource} points at unknown account "${accountId}".` });
  }
  if (!acc.isReady) {
    return res.status(503).json({ error: `WhatsApp account "${acc.label}" is not connected yet` });
  }

  try {
    const sentMsg = await acc.sock.sendMessage(entry.group_id, { text: message });
    if (sentMsg && sentMsg.key && sentMsg.message) {
      await rememberOutgoingMessage(accountId, entry.group_id, sentMsg.key.id, sentMsg.message);
    }
    res.json({ ok: true, sent_to: entry.label, via_account: acc.label });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-click admin page — no commands, no headers to type by hand.
// The API key you enter here stays only in your browser and is sent
// automatically with each button click.
app.get('/admin', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>CarryBee Bridge Admin</title>
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
    <h1>🐝 CarryBee Bridge Admin</h1>

    <label>Bridge API Key</label>
    <input type="password" id="apiKey" placeholder="paste your API_KEY here" />
    <p style="font-size:11px;color:#888;">This stays only in your browser tab — it's sent with each button click below, nothing is saved anywhere.</p>

    <h2>1. WhatsApp accounts</h2>
    <button onclick="loadAccounts()">Refresh accounts</button>
    <div id="accountsMsg"></div>
    <table id="accountsTable" style="display:none;">
      <thead><tr><th>Label</th><th>ID</th><th>Status</th><th>Connect</th><th></th></tr></thead>
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
      function key() { return document.getElementById('apiKey').value.trim(); }
      function showMsg(elId, text, ok) {
        document.getElementById(elId).innerHTML = '<div class="msg ' + (ok ? 'ok' : 'err') + '">' + text + '</div>';
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

      async function loadAccounts() {
        if (!key()) { showMsg('accountsMsg', 'Enter your API key first.', false); return; }
        showMsg('accountsMsg', 'Loading...', true);
        try {
          const data = await api('/api/accounts');
          lastAccounts = data.accounts || [];
          const body = document.getElementById('accountsBody');
          body.innerHTML = lastAccounts.map(a =>
            '<tr><td>' + a.label + '</td><td><code>' + a.id + '</code></td>' +
            '<td><span class="badge ' + (a.ready ? 'on' : 'off') + '">' + (a.ready ? ('Connected' + (a.name ? ' as ' + a.name : '')) : ('Not connected' + (a.last_status ? ' (' + a.last_status + ')' : ''))) + '</span></td>' +
            '<td>' + (a.ready ? '—' : ('<a href="/qr/' + a.id + '" target="_blank">QR</a> / <a href="/pair/' + a.id + '" target="_blank">code</a> / <a href="#" onclick="restartAccount(\\'' + a.id + '\\');return false;">restart</a>')) + '</td>' +
            '<td>' + (a.deletable ? '<button class="danger" onclick="removeAccount(\\'' + a.id + '\\')">Remove</button>' : '') + '</td></tr>'
          ).join('');
          document.getElementById('accountsTable').style.display = lastAccounts.length ? 'table' : 'none';
          const select = document.getElementById('groupsAccountSelect');
          select.innerHTML = lastAccounts.map(a => '<option value="' + a.id + '">' + a.label + (a.ready ? '' : ' (not connected)') + '</option>').join('');
          const kamSelect = document.getElementById('kamAccountSelect');
          kamSelect.innerHTML = lastAccounts.map(a => '<option value="' + a.id + '">' + a.label + (a.ready ? '' : ' (not connected)') + '</option>').join('');
          showMsg('accountsMsg', 'Loaded ' + lastAccounts.length + ' account(s).', true);
        } catch (e) {
          showMsg('accountsMsg', e.message, false);
        }
      }

      async function restartAccount(id) {
        if (!key()) return;
        try {
          await api('/api/accounts/' + encodeURIComponent(id) + '/restart', { method: 'POST' });
          showMsg('accountsMsg', 'Restarting "' + id + '"... open its QR page in a few seconds.', true);
        } catch (e) {
          showMsg('accountsMsg', e.message, false);
        }
      }

      async function addAccount() {
        if (!key()) { showMsg('addAccountMsg', 'Enter your API key first.', false); return; }
        const label = document.getElementById('newAccountLabel').value.trim();
        if (!label) { showMsg('addAccountMsg', 'Give the account a label first.', false); return; }
        try {
          const data = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ label }) });
          showMsg('addAccountMsg', 'Added "' + label + '". Open <a href="' + data.qr_url + '" target="_blank">' + data.qr_url + '</a> to scan it in.', true);
          document.getElementById('newAccountLabel').value = '';
          loadAccounts();
        } catch (e) {
          showMsg('addAccountMsg', e.message, false);
        }
      }

      async function removeAccount(id) {
        if (!key()) return;
        if (!confirm('Remove this WhatsApp account? Any group mappings still pointing at it will stop working until re-mapped.')) return;
        try {
          await api('/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
          loadAccounts();
        } catch (e) {
          showMsg('accountsMsg', e.message, false);
        }
      }

      async function loadGroups() {
        if (!key()) { showMsg('groupsMsg', 'Enter your API key first.', false); return; }
        const accountId = document.getElementById('groupsAccountSelect').value;
        if (!accountId) { showMsg('groupsMsg', 'Load and pick an account first.', false); return; }
        showMsg('groupsMsg', 'Loading...', true);
        try {
          const data = await api('/api/groups/' + encodeURIComponent(accountId));
          lastGroups = (data.groups || []).map(g => ({ ...g, account_id: accountId }));
          const body = document.getElementById('groupsBody');
          body.innerHTML = lastGroups.map(g => '<tr><td>' + g.name + '</td><td><code>' + g.id + '</code></td></tr>').join('');
          document.getElementById('groupsTable').style.display = lastGroups.length ? 'table' : 'none';
          const select = document.getElementById('mapGroupSelect');
          select.innerHTML = lastGroups.map(g => '<option value="' + g.id + '">' + g.name + '</option>').join('');
          showMsg('groupsMsg', 'Loaded ' + lastGroups.length + ' groups for this account.', true);
        } catch (e) {
          showMsg('groupsMsg', e.message, false);
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
          showMsg('mapMsg', 'Saved: "' + dashboard_name + '" → that WhatsApp group.', true);
          document.getElementById('mapName').value = '';
          loadMappings();
        } catch (e) {
          showMsg('mapMsg', e.message, false);
        }
      }

      async function loadMappings() {
        if (!key()) { showMsg('mappingsMsg', 'Enter your API key first.', false); return; }
        try {
          const data = await api('/api/mapping');
          const entries = Object.entries(data);
          const body = document.getElementById('mappingsBody');
          body.innerHTML = entries.map(([k, v]) =>
            '<tr><td>' + v.label + '</td><td><code>' + v.group_id + '</code></td><td>' + (v.account_id || 'default') + '</td>' +
            '<td><button class="secondary" onclick="removeMapping(\\'' + v.label.replace(/'/g, "\\\\'") + '\\')">Remove</button></td></tr>'
          ).join('');
          document.getElementById('mappingsTable').style.display = entries.length ? 'table' : 'none';
          showMsg('mappingsMsg', entries.length + ' mapping(s) saved.', true);
        } catch (e) {
          showMsg('mappingsMsg', e.message, false);
        }
      }

      async function removeMapping(name) {
        if (!key()) return;
        try {
          await api('/api/mapping/' + encodeURIComponent(name), { method: 'DELETE' });
          loadMappings();
        } catch (e) {
          showMsg('mappingsMsg', e.message, false);
        }
      }

      async function saveKamMapping() {
        if (!key()) { showMsg('kamMapMsg', 'Enter your API key first.', false); return; }
        const email = document.getElementById('kamEmail').value.trim();
        const account_id = document.getElementById('kamAccountSelect').value;
        if (!email || !account_id) { showMsg('kamMapMsg', 'Fill in the email and pick an account.', false); return; }
        try {
          await api('/api/kam-mapping', { method: 'POST', body: JSON.stringify({ email, account_id }) });
          showMsg('kamMapMsg', 'Saved: "' + email + '" sends via that account.', true);
          document.getElementById('kamEmail').value = '';
          loadKamMappings();
        } catch (e) {
          showMsg('kamMapMsg', e.message, false);
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
            return '<tr><td>' + v.email + '</td><td>' + (acc ? acc.label : v.account_id) + '</td>' +
              '<td><button class="secondary" onclick="removeKamMapping(\\'' + v.email.replace(/'/g, "\\\\'") + '\\')">Remove</button></td></tr>';
          }).join('');
          document.getElementById('kamMappingsTable').style.display = entries.length ? 'table' : 'none';
          showMsg('kamMappingsMsg', entries.length + ' KAM mapping(s) saved.', true);
        } catch (e) {
          showMsg('kamMappingsMsg', e.message, false);
        }
      }

      async function removeKamMapping(email) {
        if (!key()) return;
        try {
          await api('/api/kam-mapping/' + encodeURIComponent(email), { method: 'DELETE' });
          loadKamMappings();
        } catch (e) {
          showMsg('kamMappingsMsg', e.message, false);
        }
      }
    </script>
  </body>
  </html>
  `);
});

app.listen(PORT, () => {
  console.log(`CarryBee WhatsApp Bridge running on port ${PORT}`);
});
