/* Reelsmith standalone runtime.
   The studio page was first built to run inside Claude, where saving projects, storing
   photos/clips and downloading files are provided by the host. On a plain website those
   services do not exist, so this file supplies the same interface backed by the browser:
   projects and brand kit live in IndexedDB, media is stored as blobs, and downloads use a
   normal browser download. Must load before the main studio script. */
(() => {
  window.RS_STANDALONE = true;
  window.RS_MAX_MB = 200; // per-file cap for media kept with a saved project

  const DB_NAME = 'reelsmith', DB_VERSION = 1;
  let dbPromise = null;
  const fail = e => {
    const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
    const err = new Error((e && e.message) || 'storage error');
    err.code = quota ? 'quota_exceeded' : 'storage_error';
    return err;
  };
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((res, rej) => {
      let rq;
      try { rq = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { rej(fail(e)); return; }
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs');
        if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets');
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(fail(rq.error));
      rq.onblocked = () => rej(fail(new Error('storage blocked')));
    }).catch(e => { dbPromise = null; throw e; });
    return dbPromise;
  }
  // Runs one request in its own transaction and resolves once the transaction has committed.
  async function run(store, mode, fn) {
    const d = await openDb();
    return new Promise((res, rej) => {
      let t, rq;
      try { t = d.transaction(store, mode); rq = fn(t.objectStore(store)); } catch (e) { rej(fail(e)); return; }
      t.oncomplete = () => res(rq ? rq.result : undefined);
      t.onerror = () => rej(fail(t.error || (rq && rq.error)));
      t.onabort = () => rej(fail(t.error || (rq && rq.error)));
    });
  }

  /* ---- Documents: db.doc('projects/abc').set/get/delete, db.collection('projects').orderBy().limit().get() ---- */
  const snapshot = (id, value) => ({ id, exists: value !== undefined, data: () => value });
  const db = {
    doc(path) {
      const id = path.split('/').pop();
      return {
        set: data => run('docs', 'readwrite', s => s.put(JSON.parse(JSON.stringify(data)), path)).then(() => undefined),
        get: () => run('docs', 'readonly', s => s.get(path)).then(v => snapshot(id, v)),
        delete: () => run('docs', 'readwrite', s => s.delete(path)).then(() => undefined)
      };
    },
    collection(name) {
      const q = { field: null, dir: 'asc', max: Infinity };
      const api = {
        orderBy(field, dir) { q.field = field; q.dir = dir === 'desc' ? 'desc' : 'asc'; return api; },
        limit(n) { q.max = n; return api; },
        async get() {
          const d = await openDb();
          const rows = await new Promise((res, rej) => {
            const out = [];
            const t = d.transaction('docs', 'readonly');
            const rq = t.objectStore('docs').openCursor(IDBKeyRange.bound(name + '/', name + '/￿'));
            rq.onsuccess = () => { const c = rq.result; if (c) { out.push([String(c.key).slice(name.length + 1), c.value]); c.continue(); } };
            t.oncomplete = () => res(out);
            t.onerror = t.onabort = () => rej(fail(t.error));
          });
          if (q.field) {
            const sign = q.dir === 'desc' ? -1 : 1;
            rows.sort((a, b) => { const x = a[1] && a[1][q.field], y = b[1] && b[1][q.field]; return x === y ? 0 : (x > y ? sign : -sign); });
          }
          return { docs: rows.slice(0, q.max).map(([id, v]) => snapshot(id, v)) };
        }
      };
      return api;
    }
  };

  /* ---- Assets: photos, clips, voice clips and logos stored as blobs ---- */
  const urls = new Map(); // asset id -> object URL for this page load
  const assets = {
    async upload(blob, opts) {
      const cap = window.RS_MAX_MB * 1048576;
      if (blob.size > cap) { const e = new Error('too large'); e.code = 'too_large'; throw e; }
      const type = (opts && opts.type) || blob.type || 'application/octet-stream';
      const stored = new Blob([blob], { type });
      const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      await run('assets', 'readwrite', s => s.put(stored, id));
      urls.set(id, URL.createObjectURL(stored));
      return { id };
    },
    async delete(id) {
      await run('assets', 'readwrite', s => s.delete(id));
      const u = urls.get(id); if (u) { URL.revokeObjectURL(u); urls.delete(id); }
    }
  };
  // The studio asks for asset URLs synchronously, so blobs are loaded into object URLs first.
  window.RS_PRELOAD = async ids => {
    for (const id of ids) {
      if (!id || urls.has(id)) continue;
      const blob = await run('assets', 'readonly', s => s.get(id));
      if (blob) urls.set(id, URL.createObjectURL(blob));
    }
  };
  window.RS_ASSET_URL = id => urls.get(id) || '';

  /* ---- Downloads: a normal browser download ---- */
  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'reelsmith'; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  };

  /* ---- AI script writing: the site's /api/script function (Claude), only when the server has a key ---- */
  const aiErr = (code, extra) => Object.assign(new Error(code), { code }, extra || {});
  window.RS_AI = {
    async status() {
      try { const r = await fetch('api/script', { cache: 'no-store' }); return r.ok && (await r.json()).enabled === true; } catch (e) { return false; }
    },
    async write(req) {
      let r;
      try { r = await fetch('api/script', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }); }
      catch (e) { throw aiErr('offline'); }
      let body = null; try { body = await r.json(); } catch (e) {}
      if (!r.ok) throw aiErr((body && body.error) || 'failed', { retryAfter: body && body.retryAfter });
      if (!body || !Array.isArray(body.scenes)) throw aiErr('shape');
      return body;
    }
  };

  const user = { canEdit: async () => true };
  const caps = { db, assets, downloads, user };
  // Script writing and AI images ('sample') only exist in the Claude version, so they resolve to null here.
  window.claude = { use: async name => caps[name] || null };
})();
