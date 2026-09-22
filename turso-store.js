class TursoKVStore {
  constructor({ url, token }) {
    this.url = url;
    this.token = token;
    this.ready = false;
  }

  async _run(requests) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
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
    await this._ensureTable();
    const rows = await this._query('SELECT value_text FROM baileys_auth WHERE key_name = ?', [key]);
    return rows.length ? rows[0].value_text : null;
  }

  async set(key, value) {
    await this.setMany([{ key, value }]);
  }

  async setMany(entries) {
    if (!entries.length) return;
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

  // Wipes the entire table. Kept only for backwards compatibility with
  // any code that still calls it directly — prefer clearAccountSession()
  // below, which is scoped to one WhatsApp account so wiping a dead
  // session never nukes other accounts' creds or the group mapping.
  async clearAll() {
    await this._ensureTable();
    await this._query('DELETE FROM baileys_auth');
  }

  // ---------- outgoing message cache (for Baileys retry receipts) ----------
  // Stored as regular rows in the same table, under an "outgoing::" key
  // prefix, so it survives a Render restart/spin-down the same way the
  // session creds already do — that's the whole point of this fix.
  async rememberOutgoing(msgKey, message) {
    await this.set(`outgoing::${msgKey}`, JSON.stringify(message));
  }

  async getOutgoing(msgKey) {
    const raw = await this.get(`outgoing::${msgKey}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // Retry receipts only ever arrive within minutes of the original send,
  // so anything older than a day is just dead weight. Called on a timer,
  // not on every send, to keep the hot path (sendMessage) to one write.
  async pruneOutgoing(maxAgeMs) {
    await this._ensureTable();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    await this._query(
      "DELETE FROM baileys_auth WHERE key_name LIKE 'outgoing::%' AND updated_at < ?",
      [cutoff]
    );
  }

  // Wipes only the stored session for one WhatsApp account. Used when
  // WhatsApp reports that account's session as logged out — the stored
  // creds are dead, so we clear just that account's keys and start it
  // clean, leaving every other account and the group mapping untouched.
  //
  // keyPrefix is '' for the original/default account (whose keys are
  // bare, e.g. "creds", "pre-key-1") and "<accountId>::" for any
  // additionally-added account.
  async clearAccountSession(keyPrefix) {
    await this._ensureTable();
    if (keyPrefix) {
      await this._query(
        "DELETE FROM baileys_auth WHERE key_name LIKE ?",
        [`${keyPrefix}%`]
      );
    } else {
      // Default account: its keys never contain "::", so scope the
      // delete to bare keys and explicitly spare the two singleton
      // keys that aren't part of any account's session.
      await this._query(
        "DELETE FROM baileys_auth WHERE key_name NOT LIKE '%::%' AND key_name NOT IN ('group-mapping', 'accounts-registry')"
      );
    }
  }
}

module.exports = TursoKVStore;
