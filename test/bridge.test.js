const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TursoKVStore = require('../turso-store');
const { SupabaseKVStore, createKVStore } = require('../supabase-store');
const { OpenWAGateway, toSessionName } = require('../openwa-gateway');
const { createApp } = require('../server');

function listenServer(appOrHandler) {
  return new Promise((resolve, reject) => {
    const server = typeof appOrHandler === 'function' && !appOrHandler.listen
      ? http.createServer(appOrHandler)
      : http.createServer(appOrHandler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise(r => server.close(r))
      });
    });
    server.on('error', reject);
  });
}

function createMockOpenWAServer({ apiKey = 'owa_test_secret_key_1234567890abcdef' } = {}) {
  const sessions = new Map();
  const sentMessages = [];
  const qrBySession = new Map();

  const handler = async (req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsed.pathname;

    const sendJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    if (pathname === '/api/health/live' && req.method === 'GET') {
      return sendJson(200, { status: 'ok' });
    }

    if (req.headers['x-api-key'] !== apiKey) {
      return sendJson(401, { message: 'Invalid API key' });
    }

    const readBody = () => new Promise((resolve) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); }
      });
    });

    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(200, { status: 'ok', version: '0.26.0' });
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
      let list = Array.from(sessions.values());
      const filterName = parsed.searchParams.get('name');
      if (filterName) {
        list = list.filter(s => s.name === filterName);
      }
      return sendJson(200, list);
    }

    if (pathname === '/api/sessions' && req.method === 'POST') {
      const body = await readBody();
      if (!body.name || !/^[a-zA-Z0-9-]{3,50}$/.test(body.name)) {
        return sendJson(400, { message: 'Invalid session name' });
      }
      for (const s of sessions.values()) {
        if (s.name === body.name) {
          return sendJson(409, { message: 'Session already exists' });
        }
      }
      const now = new Date().toISOString();
      const session = {
        id: crypto.randomUUID(),
        name: body.name,
        status: 'created',
        phone: null,
        pushName: null,
        connectedAt: null,
        lastActive: null,
        createdAt: now,
        updatedAt: now,
        lastError: null,
        restriction: null,
        engineLoaded: false
      };
      sessions.set(session.id, session);
      return sendJson(201, session);
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const rest = sessionMatch[2] || '';
      const session = sessions.get(sessionId);
      if (!session) {
        return sendJson(404, { message: 'Session not found' });
      }

      if (rest === '' && req.method === 'GET') {
        return sendJson(200, session);
      }

      if (rest === '' && req.method === 'DELETE') {
        sessions.delete(sessionId);
        res.writeHead(204);
        return res.end();
      }

      if (rest === 'start' && req.method === 'POST') {
        if (session.engineLoaded) {
          return sendJson(409, { message: 'Session already started' });
        }
        session.engineLoaded = true;
        session.status = session.phone ? 'ready' : 'qr_ready';
        if (session.status === 'qr_ready' && !qrBySession.has(session.id)) {
          qrBySession.set(session.id, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
        }
        return sendJson(200, session);
      }

      if (rest === 'stop' && req.method === 'POST') {
        session.engineLoaded = false;
        session.status = 'disconnected';
        return sendJson(200, session);
      }

      if (rest === 'logout' && req.method === 'POST') {
        session.engineLoaded = false;
        session.phone = null;
        session.pushName = null;
        session.status = 'disconnected';
        return sendJson(200, session);
      }

      if (rest === 'qr' && req.method === 'GET') {
        const qr = qrBySession.get(session.id);
        if (!qr) {
          return sendJson(400, { message: 'QR not ready yet' });
        }
        return sendJson(200, { qrCode: qr, status: session.status });
      }

      if (rest === 'pairing-code' && req.method === 'POST') {
        const body = await readBody();
        if (!body.phoneNumber || !/^[0-9]{6,15}$/.test(body.phoneNumber)) {
          return sendJson(400, { message: 'Invalid phoneNumber' });
        }
        return sendJson(201, { pairingCode: 'CB991234', status: 'qr_ready' });
      }

      if (rest === 'groups' && req.method === 'GET') {
        if (session.status !== 'ready') {
          return sendJson(409, { message: 'Session not ready' });
        }
        return sendJson(200, [
          { id: '120363000111222@g.us', name: 'AD Group || NN1', linkedParentJID: null },
          { id: '120363000333444@g.us', name: 'CarryBee Issue Group || NN1', linkedParentJID: null }
        ]);
      }

      if (rest === 'messages/send-text' && req.method === 'POST') {
        if (session.status !== 'ready') {
          return sendJson(409, { message: 'Session not connected' });
        }
        const body = await readBody();
        const record = {
          sessionId: session.id,
          sessionName: session.name,
          chatId: body.chatId,
          text: body.text,
          idempotencyKey: req.headers['idempotency-key'] || null
        };
        sentMessages.push(record);
        return sendJson(201, {
          messageId: `msg_${sentMessages.length}`,
          timestamp: Math.floor(Date.now() / 1000)
        });
      }
    }

    return sendJson(404, { message: `Unhandled mock route ${req.method} ${pathname}` });
  };

  return { handler, sessions, sentMessages, qrBySession, apiKey };
}

test('toSessionName produces valid 3-50 char alphanumeric-hyphen OpenWA session names', () => {
  assert.equal(toSessionName('default'), 'default');
  assert.equal(toSessionName('a'), 'cb-a');
  assert.equal(toSessionName('nn'), 'cb-nn');
  assert.equal(toSessionName('Asif Vai Carry Bee 2!!'), 'asif-vai-carry-bee-2');
  const veryLong = 'a'.repeat(80);
  const longResult = toSessionName(veryLong);
  assert.ok(longResult.length >= 3 && longResult.length <= 50);
  assert.match(longResult, /^[a-z0-9-]+$/);
});

test('End-to-end CarryBee Bridge workflow via OpenWA SDK (accounts, QR, pairing, groups, KAM routing, send-remark, Render->VPS rebind)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carrybee-test-'));
  const keyFile = path.join(tmpDir, '.api-key');
  const kvFile = path.join(tmpDir, 'bridge-kv.json');
  const mapFile = path.join(tmpDir, 'groups-config.json');

  const mockOwa = createMockOpenWAServer();
  fs.writeFileSync(keyFile, mockOwa.apiKey, { mode: 0o600 });

  const owaHandle = await listenServer(mockOwa.handler);
  const kvStore = new TursoKVStore({ localFilePath: kvFile });
  const gateway = new OpenWAGateway({
    baseUrl: owaHandle.url,
    keyFile
  });

  const app = createApp({
    apiKey: 'bridge-secret',
    adminKeysRaw: 'Nahid:nahid-personal-key',
    kvStore,
    gateway,
    mappingFile: mapFile
  });
  const bridgeHandle = await listenServer(app);

  try {
    // 1. Health endpoint
    const healthRes = await fetch(`${bridgeHandle.url}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.openwa.ready, true);

    // 2. Status auto-creates the default session in OpenWA
    const statusRes = await fetch(`${bridgeHandle.url}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.openwa_ready, true);
    assert.equal(statusJson.accounts.length, 1);
    assert.equal(statusJson.accounts[0].id, 'default');
    assert.equal(statusJson.accounts[0].ready, false);

    // 3. Add Asif's account using named admin key
    const addAccRes = await fetch(`${bridgeHandle.url}/api/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'nahid-personal-key'
      },
      body: JSON.stringify({ label: 'Asif Vai Carry Bee 2' })
    });
    assert.equal(addAccRes.status, 200);
    const addAccJson = await addAccRes.json();
    assert.equal(addAccJson.ok, true);
    assert.equal(addAccJson.account.id, 'asif-vai-carry-bee-2');
    assert.equal(addAccJson.qr_url, '/qr/asif-vai-carry-bee-2');

    // 4. Fetch QR page (session auto-starts & renders PNG data URL)
    const qrHtmlRes = await fetch(`${bridgeHandle.url}/qr/asif-vai-carry-bee-2`);
    assert.equal(qrHtmlRes.status, 200);
    const qrHtml = await qrHtmlRes.text();
    assert.match(qrHtml, /data:image\/png;base64,/);

    // 5. Fetch Pairing code page
    const pairHtmlRes = await fetch(`${bridgeHandle.url}/pair/asif-vai-carry-bee-2?phone=8801712345678`);
    assert.equal(pairHtmlRes.status, 200);
    const pairHtml = await pairHtmlRes.text();
    assert.match(pairHtml, /CB991234/);

    // 6. Before phone finishes linking, /api/groups returns 503
    const groupsBeforeRes = await fetch(`${bridgeHandle.url}/api/groups/asif-vai-carry-bee-2`, {
      headers: { 'x-api-key': 'bridge-secret' }
    });
    assert.equal(groupsBeforeRes.status, 503);

    // 7. Simulate Asif scanning QR in OpenWA -> session transitions to 'ready'
    const asifSession = Array.from(mockOwa.sessions.values()).find(s => s.name === 'asif-vai-carry-bee-2');
    assert.ok(asifSession);
    asifSession.status = 'ready';
    asifSession.phone = '8801712345678';
    asifSession.pushName = 'Asif Vai Carry Bee 2';

    const defaultSession = Array.from(mockOwa.sessions.values()).find(s => s.name === 'default');
    defaultSession.status = 'ready';
    defaultSession.engineLoaded = true;
    defaultSession.phone = '8801800000000';
    defaultSession.pushName = 'CarryBee Main';

    // 8. List groups via OpenWA
    const groupsRes = await fetch(`${bridgeHandle.url}/api/groups/asif-vai-carry-bee-2`, {
      headers: { 'x-api-key': 'bridge-secret' }
    });
    assert.equal(groupsRes.status, 200);
    const groupsJson = await groupsRes.json();
    assert.equal(groupsJson.groups.length, 2);
    assert.equal(groupsJson.groups[0].name, 'AD Group || NN1');

    // 9. Save group mapping (default account) & KAM mapping (Asif's email -> Asif's account)
    const mapRes = await fetch(`${bridgeHandle.url}/api/mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'bridge-secret' },
      body: JSON.stringify({
        dashboard_name: 'AD Group || NN1',
        group_id: '120363000111222@g.us',
        account_id: 'default'
      })
    });
    assert.equal(mapRes.status, 200);

    const kamRes = await fetch(`${bridgeHandle.url}/api/kam-mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'bridge-secret' },
      body: JSON.stringify({
        email: 'asif@carrybee.com',
        account_id: 'asif-vai-carry-bee-2'
      })
    });
    assert.equal(kamRes.status, 200);

    // 10. Send remark WITH NBSP/extra spaces in group_name & KAM override + Idempotency-Key
    const sendRes = await fetch(`${bridgeHandle.url}/api/send-remark`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'bridge-secret',
        'Idempotency-Key': 'remark-cb-0816'
      },
      body: JSON.stringify({
        group_name: '  ad\u00A0group  ||   nn1 ',
        message: '*CB-0816-00856*\nParcel issue resolved — Asif',
        kam_email: 'ASIF@carrybee.com'
      })
    });
    assert.equal(sendRes.status, 200);
    const sendJson = await sendRes.json();
    assert.equal(sendJson.ok, true);
    assert.equal(sendJson.sent_to, 'AD Group || NN1');
    assert.equal(sendJson.via_account, 'Asif Vai Carry Bee 2');
    assert.equal(sendJson.message_id, 'msg_1');

    assert.equal(mockOwa.sentMessages.length, 1);
    assert.equal(mockOwa.sentMessages[0].sessionName, 'asif-vai-carry-bee-2');
    assert.equal(mockOwa.sentMessages[0].chatId, '120363000111222@g.us');
    assert.equal(mockOwa.sentMessages[0].idempotencyKey, 'remark-cb-0816');

    // 11. Simulate moving from Render to a fresh KVM VPS:
    // Wipe OpenWA's sessions Map (as if starting a brand-new OpenWA container on the VPS)
    // while keeping Turso / KV mappings intact. Verify automatic session re-creation by name!
    const oldAsifUuid = asifSession.id;
    mockOwa.sessions.clear();

    const postMoveStatus = await fetch(`${bridgeHandle.url}/api/accounts`, {
      headers: { 'x-api-key': 'bridge-secret' }
    });
    assert.equal(postMoveStatus.status, 200);
    const postMoveJson = await postMoveStatus.json();
    const reboundAsif = postMoveJson.accounts.find(a => a.id === 'asif-vai-carry-bee-2');
    assert.ok(reboundAsif);
    assert.notEqual(reboundAsif.openwa_session_id, oldAsifUuid);
    assert.ok(reboundAsif.openwa_session_id);

    // 12. Default account cannot be deleted, added account can be deleted
    const delDefault = await fetch(`${bridgeHandle.url}/api/accounts/default`, {
      method: 'DELETE',
      headers: { 'x-api-key': 'bridge-secret' }
    });
    assert.equal(delDefault.status, 400);

    const delAsif = await fetch(`${bridgeHandle.url}/api/accounts/asif-vai-carry-bee-2`, {
      method: 'DELETE',
      headers: { 'x-api-key': 'bridge-secret' }
    });
    assert.equal(delAsif.status, 200);
  } finally {
    await bridgeHandle.close();
    await owaHandle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TursoKVStore speaks Turso HTTP pipeline protocol against baileys_auth table', async () => {
  const rows = new Map();
  const executedSql = [];

  const tursoMock = await listenServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const payload = JSON.parse(raw);
      const results = payload.requests.map((r) => {
        if (r.type === 'close') return { type: 'close', response: { type: 'close' } };
        const sql = r.stmt.sql;
        const args = (r.stmt.args || []).map(a => a.value);
        executedSql.push(sql);

        if (sql.startsWith('CREATE TABLE')) {
          return { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } };
        }
        if (sql.startsWith('INSERT OR REPLACE INTO baileys_auth')) {
          rows.set(args[0], args[1]);
          return { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } };
        }
        if (sql.startsWith('SELECT value_text FROM baileys_auth')) {
          const val = rows.get(args[0]);
          return {
            type: 'ok',
            response: {
              type: 'execute',
              result: {
                cols: [{ name: 'value_text' }],
                rows: val !== undefined ? [[{ type: 'text', value: val }]] : []
              }
            }
          };
        }
        if (sql.startsWith('DELETE FROM baileys_auth')) {
          rows.delete(args[0]);
          return { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
    });
  });

  try {
    const store = new TursoKVStore({ url: `${tursoMock.url}/v2/pipeline`, token: 'turso-secret' });
    await store.set('group-mapping', '{"ad group":{"label":"AD Group","group_id":"123@g.us","account_id":"default"}}');
    const fetched = await store.get('group-mapping');
    assert.match(fetched, /123@g\.us/);
    await store.delete('group-mapping');
    assert.equal(await store.get('group-mapping'), null);
    assert.ok(executedSql.some(s => s.includes('baileys_auth')));
  } finally {
    await tursoMock.close();
  }
});

test('Bridge stays up and serves status/admin cleanly while OpenWA is still warming up on cold boot', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carrybee-cold-'));
  const kvStore = new TursoKVStore({ localFilePath: path.join(tmpDir, 'kv.json') });
  const gateway = new OpenWAGateway({
    baseUrl: 'http://127.0.0.1:59999', // closed port
    apiKey: 'owa_test_key',
    timeoutMs: 500
  });
  const app = createApp({ apiKey: 'secret', kvStore, gateway });
  const handle = await listenServer(app);

  try {
    const healthRes = await fetch(`${handle.url}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.openwa.ready, false);

    const statusRes = await fetch(`${handle.url}/api/status`);
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.equal(status.openwa_ready, false);
    assert.equal(status.accounts[0].id, 'default');
    assert.equal(status.accounts[0].last_status, 'gateway_unavailable');

    const rootRes = await fetch(`${handle.url}/`);
    assert.equal(rootRes.status, 200);
    assert.match(await rootRes.text(), /Waiting for connection/);

    const adminRes = await fetch(`${handle.url}/admin`);
    assert.equal(adminRes.status, 200);
    assert.match(await adminRes.text(), /CarryBee Bridge Admin/);
  } finally {
    await handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SupabaseKVStore speaks PostgREST protocol (get, upsert, delete) and createKVStore prioritizes Supabase', async () => {
  const tableRows = new Map();
  let sawBearerHeader = false;

  const supabaseMock = await listenServer(async (req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    if (req.headers['authorization'] && req.headers['authorization'].startsWith('Bearer eyJ')) {
      sawBearerHeader = true;
    }

    if (req.method === 'GET' && parsed.pathname === '/rest/v1/carrybee_kv') {
      const keyFilter = parsed.searchParams.get('key_name') || '';
      const key = keyFilter.replace(/^eq\./, '');
      const val = tableRows.get(key);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(val !== undefined ? [{ value_text: val }] : []));
    }

    if (req.method === 'POST' && parsed.pathname === '/rest/v1/carrybee_kv') {
      let raw = '';
      for await (const c of req) raw += c;
      const items = JSON.parse(raw);
      for (const item of items) {
        tableRows.set(item.key_name, item.value_text);
      }
      res.writeHead(201);
      return res.end();
    }

    if (req.method === 'DELETE' && parsed.pathname === '/rest/v1/carrybee_kv') {
      const keyFilter = parsed.searchParams.get('key_name') || '';
      const key = keyFilter.replace(/^eq\./, '');
      tableRows.delete(key);
      res.writeHead(204);
      return res.end();
    }

    res.writeHead(404);
    res.end();
  });

  try {
    const store = createKVStore({
      supabaseUrl: supabaseMock.url,
      supabaseServiceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.sig'
    });
    assert.ok(store instanceof SupabaseKVStore);

    await store.set('accounts-registry', '[{"id":"default","label":"Default"}]');
    assert.equal(await store.get('accounts-registry'), '[{"id":"default","label":"Default"}]');
    assert.equal(sawBearerHeader, true);

    await store.delete('accounts-registry');
    assert.equal(await store.get('accounts-registry'), null);
  } finally {
    await supabaseMock.close();
  }
});

test('Vercel + Supabase dynamic /api/gateway-config links cleanly to a Docker host /openwa endpoint', async () => {
  const tableRows = new Map([
    ['accounts-registry', JSON.stringify([
      { id: 'default', label: 'Default' },
      { id: '01701207943', label: '01701207943' }
    ])]
  ]);

  const supabaseMock = await listenServer(async (req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && parsed.pathname === '/rest/v1/carrybee_kv') {
      const key = (parsed.searchParams.get('key_name') || '').replace(/^eq\./, '');
      const val = tableRows.get(key);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(val !== undefined ? [{ value_text: val }] : []));
    }
    if (req.method === 'POST' && parsed.pathname === '/rest/v1/carrybee_kv') {
      let raw = '';
      for await (const c of req) raw += c;
      for (const item of JSON.parse(raw)) tableRows.set(item.key_name, item.value_text);
      res.writeHead(201);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });

  const mockOwa = createMockOpenWAServer({ apiKey: 'owa_k1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
  const owaInternal = await listenServer(mockOwa.handler);

  // Docker host running CarryBee Bridge with `/openwa` passthrough enabled
  const dockerStore = new SupabaseKVStore({ url: supabaseMock.url, serviceKey: 'eyJ.service' });
  const dockerGateway = new OpenWAGateway({ baseUrl: owaInternal.url, apiKey: mockOwa.apiKey });
  const dockerApp = createApp({
    apiKey: 'master-bridge-key',
    kvStore: dockerStore,
    gateway: dockerGateway,
    localOpenwaProxyTarget: owaInternal.url
  });
  const dockerHost = await listenServer(dockerApp);

  // Stateless Vercel instance backed by the SAME Supabase store, initially with NO OpenWA env vars
  const vercelStore = new SupabaseKVStore({ url: supabaseMock.url, serviceKey: 'eyJ.service' });
  const vercelApp = createApp({
    apiKey: 'master-bridge-key',
    adminKeysRaw: 'Nahid:kam-restricted-key',
    kvStore: vercelStore
  });
  const vercelHost = await listenServer(vercelApp);

  try {
    // Non-master KAM key is forbidden from reading or changing gateway-config
    const forbiddenRes = await fetch(`${vercelHost.url}/api/gateway-config`, {
      headers: { 'x-api-key': 'kam-restricted-key' }
    });
    assert.equal(forbiddenRes.status, 403);

    // Master admin links Vercel to Docker host's `/openwa` endpoint via POST /api/gateway-config
    const linkRes = await fetch(`${vercelHost.url}/api/gateway-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'master-bridge-key' },
      body: JSON.stringify({
        base_url: `${dockerHost.url}/openwa`,
        api_key: mockOwa.apiKey
      })
    });
    assert.equal(linkRes.status, 200);
    const linkJson = await linkRes.json();
    assert.equal(linkJson.ok, true);
    assert.equal(linkJson.storage_backend, 'supabase');
    assert.equal(linkJson.openwa.ready, true);
    assert.match(linkJson.masked_api_key, /^owa_k1_01••••cdef$/);

    // Vercel now lists and initializes sessions on the remote Docker OpenWA container!
    const accRes = await fetch(`${vercelHost.url}/api/accounts`, {
      headers: { 'x-api-key': 'master-bridge-key' }
    });
    assert.equal(accRes.status, 200);
    const accJson = await accRes.json();
    assert.equal(accJson.accounts.length, 2);
    assert.equal(accJson.accounts[1].id, '01701207943');
    assert.equal(mockOwa.sessions.size, 2);
  } finally {
    await vercelHost.close();
    await dockerHost.close();
    await owaInternal.close();
    await supabaseMock.close();
  }
});
