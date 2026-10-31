const fs = require('fs');
const crypto = require('crypto');
const {
  OpenWAClient,
  OpenWAApiError,
  OpenWAAuthError,
  OpenWAConflictError,
  OpenWANotFoundError,
  OpenWATimeoutError
} = require('@rmyndharis/openwa');

const DEFAULT_BASE_URL = 'http://127.0.0.1:2785';
const DEFAULT_KEY_FILE = '/app/data/.api-key';

function hasBundledOpenWA() {
  return process.env.CARRYBEE_BUNDLED_OPENWA === 'true'
    || fs.existsSync('/app/dist/main.js')
    || fs.existsSync('/app/dist/main');
}

function toSessionName(accountId) {
  const raw = String(accountId || 'default').trim().toLowerCase();
  let cleaned = raw
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!cleaned) cleaned = 'account';
  if (cleaned.length < 3) {
    cleaned = `cb-${cleaned}`;
  }
  if (cleaned.length > 50) {
    const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
    const prefix = cleaned.slice(0, 41).replace(/-+$/g, '');
    cleaned = `${prefix}-${hash}`;
  }
  return cleaned;
}

function formatConnectedIdentity(session) {
  if (!session) return null;
  if (session.pushName && session.phone) {
    return `${session.pushName} (+${session.phone})`;
  }
  if (session.pushName) return session.pushName;
  if (session.phone) return `+${session.phone}`;
  return null;
}

function extractApiErrorMessage(err) {
  if (!err) return 'Unknown OpenWA error';
  if (err instanceof OpenWAApiError) {
    const body = err.body;
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string' && body.message) return body.message;
      if (Array.isArray(body.message) && body.message.length) return body.message.join('; ');
      if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') {
        return body.error.message;
      }
      if (typeof body.error === 'string' && body.error) return body.error;
    }
    return err.message;
  }
  return err.message || String(err);
}

class OpenWAGateway {
  constructor(options = {}) {
    this.explicitBaseUrl = options.baseUrl !== undefined ? String(options.baseUrl).trim().replace(/\/+$/, '') : '';
    this.explicitApiKey = options.apiKey !== undefined ? String(options.apiKey).trim() : '';
    this.keyFile = options.keyFile || process.env.OPENWA_KEY_FILE || DEFAULT_KEY_FILE;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.OPENWA_TIMEOUT_MS || 30000);
    this.fetchImpl = options.fetch;
    this.configLoader = options.configLoader || null; // async () => ({ base_url, api_key }) | null
    this._cachedClient = null;
    this._cachedBaseUrl = null;
    this._cachedApiKey = null;
  }

  async resolveConnectionConfig() {
    let saved = null;
    if (this.configLoader) {
      try { saved = await this.configLoader(); } catch (_) {}
    }

    const baseUrl = (
      this.explicitBaseUrl ||
      (process.env.OPENWA_BASE_URL && process.env.OPENWA_BASE_URL.trim()) ||
      (saved && saved.base_url && String(saved.base_url).trim()) ||
      DEFAULT_BASE_URL
    ).replace(/\/+$/, '');

    let apiKey = (
      this.explicitApiKey ||
      (process.env.OPENWA_API_KEY && process.env.OPENWA_API_KEY.trim()) ||
      (saved && saved.api_key && String(saved.api_key).trim()) ||
      (process.env.API_MASTER_KEY && process.env.API_MASTER_KEY.trim()) ||
      ''
    );

    if (!apiKey && this.keyFile) {
      try {
        if (fs.existsSync(this.keyFile)) {
          const fromFile = fs.readFileSync(this.keyFile, 'utf8').trim();
          if (fromFile) apiKey = fromFile;
        }
      } catch (_) {}
    }

    const hasExplicitGateway = Boolean(
      this.explicitBaseUrl ||
      (process.env.OPENWA_BASE_URL && process.env.OPENWA_BASE_URL.trim()) ||
      (saved && saved.base_url && String(saved.base_url).trim())
    );

    return { baseUrl, apiKey, hasExplicitGateway };
  }

  isMissingBundledOpenWA(baseUrl, hasExplicitGateway) {
    const isLocalDefault = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl);
    return isLocalDefault && !hasExplicitGateway && !hasBundledOpenWA();
  }

  async getClient() {
    const { baseUrl, apiKey, hasExplicitGateway } = await this.resolveConnectionConfig();
    if (!apiKey) {
      const msg = this.isMissingBundledOpenWA(baseUrl, hasExplicitGateway)
        ? 'No OpenWA Gateway connected yet. Paste your OpenWA Gateway URL & API Key in "/admin" (Section 0) — or deploy Dockerfile on a Docker host.'
        : 'OpenWA Gateway is still initializing first-boot credentials (wait ~20s and click Refresh accounts, or set OPENWA_API_KEY).';
      const err = new Error(msg);
      err.code = 'OPENWA_KEY_MISSING';
      err.status = 503;
      throw err;
    }

    if (!this._cachedClient || this._cachedApiKey !== apiKey || this._cachedBaseUrl !== baseUrl) {
      this._cachedClient = new OpenWAClient({
        baseUrl,
        apiKey,
        timeoutMs: this.timeoutMs,
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {})
      });
      this._cachedBaseUrl = baseUrl;
      this._cachedApiKey = apiKey;
    }
    return { client: this._cachedClient, baseUrl, hasExplicitGateway };
  }

  _wrapError(err, baseUrl = DEFAULT_BASE_URL, hasExplicitGateway = false) {
    if (!err) return new Error('Unknown OpenWA gateway error');
    if (err instanceof OpenWAAuthError) {
      this._cachedClient = null;
      this._cachedApiKey = null;
      const wrapped = new Error(`OpenWA authentication failed (401) at ${baseUrl}. Check your OpenWA API key in /admin.`);
      wrapped.status = 502;
      wrapped.cause = err;
      return wrapped;
    }
    if (err instanceof OpenWATimeoutError) {
      const wrapped = new Error(`OpenWA gateway timed out after ${this.timeoutMs}ms (${baseUrl}).`);
      wrapped.status = 504;
      wrapped.cause = err;
      return wrapped;
    }
    if (err instanceof OpenWAApiError) {
      const wrapped = new Error(extractApiErrorMessage(err));
      wrapped.status = err.status || 502;
      wrapped.openwaStatus = err.status;
      wrapped.cause = err;
      return wrapped;
    }
    if (err.code === 'OPENWA_KEY_MISSING') {
      return err;
    }
    const msg = err.message || String(err);
    const hint = this.isMissingBundledOpenWA(baseUrl, hasExplicitGateway)
      ? 'Paste your OpenWA Gateway URL & API Key in /admin (Section 0).'
      : 'Make sure OpenWA is running and reachable from this server.';
    const wrapped = new Error(`Cannot reach OpenWA Gateway at ${baseUrl} (${msg}). ${hint}`);
    wrapped.status = 503;
    wrapped.code = 'OPENWA_UNREACHABLE';
    wrapped.cause = err;
    return wrapped;
  }

  async checkHealth() {
    const { baseUrl, hasExplicitGateway } = await this.resolveConnectionConfig();
    try {
      const { client } = await this.getClient();
      const health = await client.health.check();
      if (health && health.bridge === 'ready') {
        const hasOpenwaSubpath = !baseUrl.endsWith('/openwa');
        return {
          reachable: false,
          ready: false,
          is_bridge_root: true,
          base_url: baseUrl,
          error: hasOpenwaSubpath
            ? `URL "${baseUrl}" points to CarryBee Bridge root instead of "/openwa" (or that host was deployed in Node mode instead of Docker mode).`
            : `URL "${baseUrl}" is not running OpenWA.`
        };
      }
      return {
        reachable: true,
        ready: true,
        base_url: baseUrl,
        version: (health && health.version) || null
      };
    } catch (err) {
      if (!this.isMissingBundledOpenWA(baseUrl, hasExplicitGateway)) {
        try {
          const fetchFn = this.fetchImpl || globalThis.fetch;
          const res = await fetchFn(`${baseUrl}/api/health/live`, {
            signal: AbortSignal.timeout(3000)
          });
          if (res.ok) {
            return {
              reachable: true,
              ready: false,
              base_url: baseUrl,
              error: extractApiErrorMessage(err)
            };
          }
        } catch (_) {}
      }
      const wrapped = this._wrapError(err, baseUrl, hasExplicitGateway);
      return {
        reachable: false,
        ready: false,
        base_url: baseUrl,
        error: wrapped.message
      };
    }
  }

  async listSessions() {
    const { baseUrl, hasExplicitGateway } = await this.resolveConnectionConfig();
    try {
      const { client } = await this.getClient();
      return await client.sessions.list({ limit: 1000 });
    } catch (err) {
      throw this._wrapError(err, baseUrl, hasExplicitGateway);
    }
  }

  async findSession(account, sessionsList = null) {
    const { client, baseUrl, hasExplicitGateway } = await this.getClient();
    const sessionName = toSessionName(account.id);

    if (Array.isArray(sessionsList)) {
      if (account.openwa_session_id) {
        const byId = sessionsList.find(s => s.id === account.openwa_session_id);
        if (byId) return byId;
      }
      return sessionsList.find(s => s.name === sessionName) || null;
    }

    if (account.openwa_session_id) {
      try {
        return await client.sessions.get(account.openwa_session_id);
      } catch (err) {
        if (!(err instanceof OpenWANotFoundError)) {
          throw this._wrapError(err, baseUrl, hasExplicitGateway);
        }
      }
    }

    try {
      const matches = await client.sessions.list({ name: sessionName, limit: 10 });
      return matches.find(s => s.name === sessionName) || null;
    } catch (err) {
      throw this._wrapError(err, baseUrl, hasExplicitGateway);
    }
  }

  async startSessionIfIdle(session) {
    if (!session) return null;
    if (session.engineLoaded) return session;
    if (['ready', 'qr_ready', 'initializing', 'authenticating'].includes(session.status)) {
      return session;
    }
    const { client, baseUrl, hasExplicitGateway } = await this.getClient();
    try {
      return await client.sessions.start(session.id);
    } catch (err) {
      if (err instanceof OpenWAConflictError) {
        return await client.sessions.get(session.id);
      }
      throw this._wrapError(err, baseUrl, hasExplicitGateway);
    }
  }

  async ensureSession(account, { autoStart = false, sessionsList = null } = {}) {
    const { client, baseUrl, hasExplicitGateway } = await this.getClient();
    const sessionName = toSessionName(account.id);

    let session = await this.findSession(account, sessionsList);
    let sessionIdChanged = false;

    if (!session) {
      try {
        session = await client.sessions.create({ name: sessionName });
        sessionIdChanged = true;
      } catch (err) {
        if (err instanceof OpenWAConflictError) {
          const matches = await client.sessions.list({ name: sessionName, limit: 10 });
          session = matches.find(s => s.name === sessionName) || null;
          if (session) sessionIdChanged = session.id !== account.openwa_session_id;
        }
        if (!session) throw this._wrapError(err, baseUrl, hasExplicitGateway);
      }
    } else if (account.openwa_session_id !== session.id) {
      sessionIdChanged = true;
    }

    if (autoStart) {
      session = await this.startSessionIfIdle(session);
    }

    return { session, sessionIdChanged };
  }

  async restartSession(account) {
    const { client, baseUrl, hasExplicitGateway } = await this.getClient();
    const { session, sessionIdChanged } = await this.ensureSession(account, { autoStart: false });

    if (session.engineLoaded || ['ready', 'qr_ready', 'initializing', 'authenticating'].includes(session.status)) {
      try {
        await client.sessions.stop(session.id);
      } catch (err) {
        if (err instanceof OpenWAApiError && err.status === 502) {
          try { await client.sessions.forceKill(session.id); } catch (_) {}
        } else if (!(err instanceof OpenWAApiError && (err.status === 400 || err.status === 409))) {
          throw this._wrapError(err, baseUrl, hasExplicitGateway);
        }
      }
    }

    try {
      const started = await client.sessions.start(session.id);
      return { session: started, sessionIdChanged };
    } catch (err) {
      throw this._wrapError(err, baseUrl, hasExplicitGateway);
    }
  }

  async removeSession(account) {
    const { client, baseUrl, hasExplicitGateway } = await this.getClient();
    const session = await this.findSession(account);
    if (!session) return;

    if (session.engineLoaded && session.phone) {
      try {
        await client.sessions.logout(session.id);
      } catch (_) {
        try { await client.sessions.stop(session.id); } catch (_2) {}
      }
    } else if (session.engineLoaded) {
      try { await client.sessions.stop(session.id); } catch (_) {}
    }

    try {
      await client.sessions.delete(session.id);
    } catch (err) {
      if (!(err instanceof OpenWANotFoundError)) {
        throw this._wrapError(err, baseUrl, hasExplicitGateway);
      }
    }
  }

  async getQrForAccount(account) {
    const { client, baseUrl, hasExplicitGateway } = await this.getClient();
    const { session, sessionIdChanged } = await this.ensureSession(account, { autoStart: true });

    if (session.status === 'ready') {
      return {
        ready: true,
        qrCode: null,
        session,
        sessionIdChanged
      };
    }

    try {
      const qrData = await client.sessions.getQrCode(session.id);
      const qrCode = qrData && typeof qrData.qrCode === 'string' && qrData.qrCode.startsWith('data:image/')
        ? qrData.qrCode
        : null;
      return {
        ready: qrData && qrData.status === 'ready',
        qrCode,
        session: { ...session, status: (qrData && qrData.status) || session.status },
        sessionIdChanged
      };
    } catch (err) {
      if (err instanceof OpenWAApiError && (err.status === 400 || err.status === 409)) {
        let fresh = session;
        try { fresh = await client.sessions.get(session.id); } catch (_) {}
        return {
          ready: fresh.status === 'ready',
          qrCode: null,
          session: fresh,
          sessionIdChanged
        };
      }
      throw this._wrapError(err, baseUrl, hasExplicitGateway);
    }
  }

  async requestPairingCode(account, phoneNumber) {
    const { client, baseUrl, hasExplicitGateway } = await this.getClient();
    const { session, sessionIdChanged } = await this.ensureSession(account, { autoStart: true });

    if (session.status === 'ready') {
      return {
        ready: true,
        pairingCode: null,
        session,
        sessionIdChanged
      };
    }

    try {
      const res = await client.sessions.requestPairingCode(session.id, { phoneNumber });
      return {
        ready: false,
        pairingCode: res.pairingCode,
        session: { ...session, status: res.status || session.status },
        sessionIdChanged
      };
    } catch (err) {
      throw this._wrapError(err, baseUrl, hasExplicitGateway);
    }
  }

  async listGroupsForAccount(account) {
    const { client, baseUrl, hasExplicitGateway } = await this.getClient();
    const { session, sessionIdChanged } = await this.ensureSession(account, { autoStart: false });

    if (session.status !== 'ready') {
      const err = new Error(`"${account.label}" is not connected yet (status: ${session.status})`);
      err.status = 503;
      throw err;
    }

    try {
      const all = [];
      const pageSize = 1000;
      let offset = 0;
      while (true) {
        const page = await client.groups.list(session.id, { limit: pageSize, offset });
        if (!Array.isArray(page) || page.length === 0) break;
        for (const g of page) {
          all.push({ id: g.id, name: g.name || g.id });
        }
        if (page.length < pageSize) break;
        offset += pageSize;
      }
      return { groups: all, session, sessionIdChanged };
    } catch (err) {
      if (err instanceof OpenWAApiError && (err.status === 400 || err.status === 409 || err.status === 503)) {
        const notReady = new Error(`"${account.label}" is not ready in OpenWA yet (${extractApiErrorMessage(err)})`);
        notReady.status = 503;
        throw notReady;
      }
      throw this._wrapError(err, baseUrl, hasExplicitGateway);
    }
  }

  async sendGroupText(account, groupId, text, idempotencyKey) {
    const { client, baseUrl, hasExplicitGateway } = await this.getClient();
    const { session, sessionIdChanged } = await this.ensureSession(account, { autoStart: false });

    if (session.status !== 'ready') {
      const err = new Error(`WhatsApp account "${account.label}" is not connected yet (status: ${session.status})`);
      err.status = 503;
      throw err;
    }

    try {
      const result = await client.messages.sendText(
        session.id,
        {
          chatId: String(groupId).trim(),
          text: String(text)
        },
        idempotencyKey || undefined
      );
      return {
        messageId: result && result.messageId ? result.messageId : null,
        timestamp: result && result.timestamp ? result.timestamp : null,
        session,
        sessionIdChanged
      };
    } catch (err) {
      if (err instanceof OpenWAApiError && err.status === 409 && (!err.body || !err.body.code)) {
        const notReady = new Error(`WhatsApp account "${account.label}" is not connected yet`);
        notReady.status = 503;
        throw notReady;
      }
      throw this._wrapError(err, baseUrl, hasExplicitGateway);
    }
  }

  formatPublicAccount(account, session, { defaultAccountId = 'default', gatewayError = null } = {}) {
    const isReady = Boolean(!gatewayError && session && session.status === 'ready');
    let lastError = null;
    if (gatewayError) {
      lastError = gatewayError;
    } else if (session && session.restriction) {
      lastError = `WhatsApp restriction (${session.restriction.kind}: ${session.restriction.code})`;
    } else if (session && session.lastError) {
      lastError = session.lastError;
    }

    return {
      id: account.id,
      label: account.label,
      ready: isReady,
      name: isReady ? formatConnectedIdentity(session) : null,
      phone: session && session.phone ? session.phone : null,
      deletable: account.id !== defaultAccountId,
      last_status: gatewayError
        ? 'gateway_unavailable'
        : (session ? session.status : 'not_initialized'),
      last_error: lastError,
      openwa_session_id: session ? session.id : (account.openwa_session_id || null)
    };
  }
}

module.exports = {
  OpenWAGateway,
  toSessionName,
  formatConnectedIdentity,
  hasBundledOpenWA
};
