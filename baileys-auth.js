const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

// keyPrefix namespaces every stored key so multiple WhatsApp accounts can
// share the same Turso table without colliding. The original single-account
// deployment used bare keys ("creds", "pre-key-1", ...) — pass '' as the
// prefix to keep reading/writing those same bare keys so the very first
// (default) account never needs to re-scan a QR code after this upgrade.
async function useTursoAuthState(store, keyPrefix = '') {
  const credsKey = `${keyPrefix}creds`;

  let creds;
  try {
    const credsRaw = await store.get(credsKey);
    creds = credsRaw ? JSON.parse(credsRaw, BufferJSON.reviver) : initAuthCreds();
  } catch (e) {
    console.error(`[baileys-auth:${keyPrefix || 'default'}] failed to load creds from Turso, starting fresh:`, e.message);
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          try {
            await Promise.all(ids.map(async (id) => {
              let value = await store.get(`${keyPrefix}${type}-${id}`);
              if (value) {
                value = JSON.parse(value, BufferJSON.reviver);
                if (type === 'app-state-sync-key' && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
              }
              data[id] = value;
            }));
          } catch (e) {
            console.error(`[baileys-auth:${keyPrefix || 'default'}] keys.get failed, continuing:`, e.message);
          }
          return data;
        },
        set: async (data) => {
          const toSave = [];
          const toDelete = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${keyPrefix}${category}-${id}`;
              if (value) {
                toSave.push({ key, value: JSON.stringify(value, BufferJSON.replacer) });
              } else {
                toDelete.push(key);
              }
            }
          }
          try {
            if (toSave.length) await store.setMany(toSave);
            if (toDelete.length) await store.deleteMany(toDelete);
          } catch (e) {
            console.error(`[baileys-auth:${keyPrefix || 'default'}] keys.set failed, continuing:`, e.message);
          }
        }
      }
    },
    saveCreds: async () => {
      try {
        await store.set(credsKey, JSON.stringify(creds, BufferJSON.replacer));
      } catch (e) {
        console.error(`[baileys-auth:${keyPrefix || 'default'}] saveCreds failed, continuing:`, e.message);
      }
    }
  };
}

module.exports = useTursoAuthState;
