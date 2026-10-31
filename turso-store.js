const fs = require('fs');
const path = require('path');

function normalizeTursoUrl(rawUrl) {
  if (!rawUrl) return '';
  const trimmed = String(rawUrl).trim();
  if (trimmed.startsWith('libsql://')) {
    const hostPath = trimmed.slice('libsql://'.length).replace(/\/+$/, '');
    return hostPath.endsWith('/v2/pipeline')
      ? `https://${hostPath}`
      : `https://${hostPath}/v2/pipeline`;
  }
  return trimmed;
}

class TursoKVStore {
  constructor({ url, token, localFilePath } = {}) {
    this.url = normalizeTursoUrl(url);
    this.token = token ? String(token).trim() : '';
    this.useLocalFallback = !(this.url && this.token);
    this.localFilePath = localFilePath
      || process.env.BRIDGE_LOCAL_KV_FILE
      || path.join(__dirname, 'data', 'bridge-kv.json');
    this.ready = false;
    this._warnedFallback = false;
  }

  _readLocalStore() {
    if (!this._warnedFallback) {
      this._warnedFallback = true;
      console.log(`[turso-store] TURSO_DB_URL/TURSO_DB_TOKEN not configured — storing bridge config locally at ${this.localFilePath}`);
    }
    try {
      if (!fs.existsSync(this.localFilePath)) return {};
      return JSON.parse(fs.readFileSync(this.localFilePath, 'utf8')) || {};
    } catch (e) {
      return {};
    }
  }

  _writeLocalStore(obj) {
    const dir = path.dirname(this.localFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.localFilePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.localFilePath);
  }

  async _run(requests) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ requests: [...requests, { type: 'close' }] })
    });
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
    const data = await res.json();
    if (!data.results) throw new Error('Turso: no results in response');
    data.results.forEach((r, i) => {
      if (r && r.type === 'error') {
        throw new Error(`Turso statement ${i} failed: ${(r.error && r.error.message) || 'unknown error'}`);
      }
    });
    return data.results;
  }

  async _query(sql, args = []) {
    const stmt = { sql };
    if (args.length) {
      stmt.args = args.map(a => ({ type: 'text', value: String(a) }));
    }
    const results = await this._run([{ type: 'execute', stmt }]);
    const execResult = results[0];
    const result = execResult.response.result;
    const cols = (result.cols || []).map(c => c.name);
    return (result.rows || []).map(row => {
      const obj = {};
      row.forEach((cell, i) => { obj[cols[i]] = cell.type === 'null' ? null : cell.value; });
      return obj;
    });
  }

  // Table name `baileys_auth` is kept intentionally so existing production
  // Turso databases keep all saved `group-mapping`, `kam-account-mapping`,
  // and `accounts-registry` rows with zero data migration needed.
  async _ensureTable() {
    if (this.ready) return;
    await this._query(`CREATE TABLE IF NOT EXISTS baileys_auth (
      key_name TEXT PRIMARY KEY,
      value_text TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.ready = true;
  }

  async get(key) {
    if (this.useLocalFallback) {
      const data = this._readLocalStore();
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    }
    await this._ensureTable();
    const rows = await this._query('SELECT value_text FROM baileys_auth WHERE key_name = ?', [key]);
    return rows.length ? rows[0].value_text : null;
  }

  async set(key, value) {
    await this.setMany([{ key, value }]);
  }

  async setMany(entries) {
    if (!entries.length) return;
    if (this.useLocalFallback) {
      const data = this._readLocalStore();
      for (const { key, value } of entries) {
        data[String(key)] = String(value);
      }
      this._writeLocalStore(data);
      return;
    }
    await this._ensureTable();
    const now = new Date().toISOString();
    const requests = entries.map(({ key, value }) => ({
      type: 'execute',
      stmt: {
        sql: 'INSERT OR REPLACE INTO baileys_auth (key_name, value_text, updated_at) VALUES (?, ?, ?)',
        args: [
          { type: 'text', value: String(key) },
          { type: 'text', value: String(value) },
          { type: 'text', value: now }
        ]
      }
    }));
    await this._run(requests);
  }

  async delete(key) {
    await this.deleteMany([key]);
  }

  async deleteMany(keys) {
    if (!keys.length) return;
    if (this.useLocalFallback) {
      const data = this._readLocalStore();
      for (const key of keys) {
        delete data[String(key)];
      }
      this._writeLocalStore(data);
      return;
    }
    await this._ensureTable();
    const requests = keys.map(key => ({
      type: 'execute',
      stmt: {
        sql: 'DELETE FROM baileys_auth WHERE key_name = ?',
        args: [{ type: 'text', value: String(key) }]
      }
    }));
    await this._run(requests);
  }
}

module.exports = TursoKVStore;
