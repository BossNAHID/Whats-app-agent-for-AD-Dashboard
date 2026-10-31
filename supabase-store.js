const TursoKVStore = require('./turso-store');

class SupabaseKVStore {
  constructor({ url, serviceKey, table = 'carrybee_kv', fetch: fetchImpl } = {}) {
    this.url = String(url || '').trim().replace(/\/+$/, '');
    this.serviceKey = String(serviceKey || '').trim();
    this.table = table;
    this.fetchImpl = fetchImpl || ((input, init) => globalThis.fetch(input, init));
  }

  _headers(extra = {}) {
    const headers = {
      'apikey': this.serviceKey,
      ...extra
    };
    // Classic Supabase `service_role` keys are JWTs (`eyJ...`) and use Authorization: Bearer.
    // Newer `sb_secret_...` keys authenticate via `apikey` alone (Supabase API gateway mints the JWT).
    if (this.serviceKey.startsWith('eyJ')) {
      headers['Authorization'] = `Bearer ${this.serviceKey}`;
    }
    return headers;
  }

  _endpoint(query = '') {
    return `${this.url}/rest/v1/${encodeURIComponent(this.table)}${query ? `?${query}` : ''}`;
  }

  async get(key) {
    const qs = `select=value_text&key_name=eq.${encodeURIComponent(String(key))}&limit=1`;
    const res = await this.fetchImpl(this._endpoint(qs), {
      method: 'GET',
      headers: this._headers({ 'Accept': 'application/json' })
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Supabase GET failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0].value_text : null;
  }

  async set(key, value) {
    await this.setMany([{ key, value }]);
  }

  async setMany(entries) {
    if (!entries.length) return;
    const now = new Date().toISOString();
    const payload = entries.map(({ key, value }) => ({
      key_name: String(key),
      value_text: String(value),
      updated_at: now
    }));
    const res = await this.fetchImpl(this._endpoint('on_conflict=key_name'), {
      method: 'POST',
      headers: this._headers({
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Supabase UPSERT failed (${res.status}): ${detail.slice(0, 200)}`);
    }
  }

  async delete(key) {
    await this.deleteMany([key]);
  }

  async deleteMany(keys) {
    if (!keys.length) return;
    await Promise.all(keys.map(async (key) => {
      const qs = `key_name=eq.${encodeURIComponent(String(key))}`;
      const res = await this.fetchImpl(this._endpoint(qs), {
        method: 'DELETE',
        headers: this._headers({ 'Prefer': 'return=minimal' })
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Supabase DELETE failed (${res.status}): ${detail.slice(0, 200)}`);
      }
    }));
  }
}

function createKVStore(options = {}) {
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
  const supabaseKey = options.supabaseServiceKey
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SECRET_KEY;

  if (supabaseUrl && supabaseKey) {
    return new SupabaseKVStore({
      url: supabaseUrl,
      serviceKey: supabaseKey,
      fetch: options.fetch
    });
  }

  return new TursoKVStore({
    url: options.tursoUrl !== undefined ? options.tursoUrl : process.env.TURSO_DB_URL,
    token: options.tursoToken !== undefined ? options.tursoToken : process.env.TURSO_DB_TOKEN,
    localFilePath: options.localFilePath
  });
}

module.exports = {
  SupabaseKVStore,
  createKVStore
};
