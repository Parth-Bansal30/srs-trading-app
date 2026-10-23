// The phone's own little database (IndexedDB) for working without internet: the last data each screen
// showed (per person) and the entries waiting to be sent. If the browser has no IndexedDB (some private
// windows), everything still works for this visit from memory — it just isn't kept after closing.
const DB = 'srs-offline';
const STORES = ['cache', 'outbox'];
let dbp = null;
const mem = { cache: new Map(), outbox: new Map() };
let memOnly = typeof indexedDB === 'undefined';

function open() {
  if (memOnly) return Promise.resolve(null);
  if (!dbp) {
    dbp = new Promise((ok) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => { memOnly = true; ok(null); };
        r.onblocked = () => { memOnly = true; ok(null); };
      } catch { memOnly = true; ok(null); }
    });
  }
  return dbp;
}

/** Run one write and wait until it is really stored. */
function write(store, fn) {
  return open().then((db) => new Promise((ok, no) => {
    try {
      const t = db.transaction(store, 'readwrite');
      fn(t.objectStore(store));
      t.oncomplete = () => ok();
      t.onerror = () => no(t.error);
      t.onabort = () => no(t.error);
    } catch (e) { no(e); }
  }));
}

export const idb = {
  async get(store, key) {
    const db = await open();
    if (!db) return mem[store].get(key);
    return new Promise((ok) => {
      try {
        const r = db.transaction(store).objectStore(store).get(key);
        r.onsuccess = () => ok(r.result);
        r.onerror = () => ok(undefined);
      } catch { ok(undefined); }
    });
  },
  async put(store, key, value) {
    const db = await open();
    if (!db) { mem[store].set(key, value); return; }
    await write(store, (os) => { os.put(value, key); }).catch(() => { mem[store].set(key, value); });
  },
  async del(store, key) {
    const db = await open();
    if (!db) { mem[store].delete(key); return; }
    await write(store, (os) => { os.delete(key); }).catch(() => {});
    mem[store].delete(key);
  },
  /** Every [key, value] whose key starts with prefix. */
  async list(store, prefix = '') {
    const db = await open();
    if (!db) return [...mem[store]].filter(([k]) => String(k).startsWith(prefix));
    return new Promise((ok) => {
      const out = [];
      try {
        const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined;
        const r = db.transaction(store).objectStore(store).openCursor(range);
        r.onsuccess = () => { const c = r.result; if (c) { out.push([c.key, c.value]); c.continue(); } else ok(out); };
        r.onerror = () => ok(out);
      } catch { ok(out); }
    });
  },
  async clear(store, prefix = '') {
    for (const [k] of await this.list(store, prefix)) await this.del(store, k);
  },
};
