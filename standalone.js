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

  /* ---- AI script writing, paid for one of three ways ----
     own key: the visitor's Anthropic key goes straight from this browser to Anthropic with the official
              SDK. Reelsmith's server never sees it. Kept in this browser only if they tick "remember".
     invite:  the site owner's key, through /api/script, with an invite code the owner handed out.
     open:    the site owner's key for anyone (only when the owner switched that on). */
  const aiErr = (code, extra) => Object.assign(new Error(code), { code }, extra || {});
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.8.0/+esm';
  const OWN_KEY = 'reelsmith-own-key', INVITE_KEY = 'reelsmith-invite';
  const ls = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
  };
  const held = { own: ls.get(OWN_KEY), invite: ls.get(INVITE_KEY) };
  let server = { enabled: false, invite: false, open: false };

  async function writeWithOwnKey(req) {
    let P, Anthropic;
    try { [P, { default: Anthropic }] = await Promise.all([import('./script-prompt.js'), import(SDK_URL)]); }
    catch (e) { throw aiErr('offline'); }
    const q = P.readRequest(req); if (!q) throw aiErr('bad_request');
    const client = new Anthropic({ apiKey: held.own, dangerouslyAllowBrowser: true, maxRetries: 1 });
    let msg;
    try { msg = await client.beta.messages.create(P.scriptParams(q)); }
    catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) { window.RS_AI.forget('own'); throw aiErr('bad_key'); }
      if (e instanceof Anthropic.RateLimitError) throw aiErr('key_rate_limited');
      if (e instanceof Anthropic.BadRequestError) throw aiErr(/credit/i.test(e.message || '') ? 'no_credit' : 'failed');
      if (e instanceof Anthropic.APIConnectionError) throw aiErr('offline');
      throw aiErr('failed');
    }
    const out = P.readScriptMessage(msg);
    if (out.error) throw aiErr(out.error);
    return out.data;
  }

  window.RS_AI = {
    // What the site's own writer allows: { enabled, invite, open }.
    async status() {
      try { const r = await fetch('api/script', { cache: 'no-store' }); if (r.ok) { const b = await r.json(); server = { enabled: !!b.enabled, invite: !!b.invite, open: !!b.open }; } } catch (e) {}
      return server;
    },
    // How the next script would be paid for: 'own' | 'invite' | 'open' | null (needs a code or a key).
    access() { return held.own ? 'own' : held.invite && server.invite ? 'invite' : server.open ? 'open' : null; },
    remembered() { return !!ls.get(OWN_KEY); },
    looksLikeKey: k => /^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(k),
    setOwnKey(key, remember) { held.own = key; ls.set(OWN_KEY, remember ? key : ''); },
    setInvite(code) { held.invite = code; ls.set(INVITE_KEY, code); },
    forget(which) {
      if (which !== 'invite') { held.own = ''; ls.set(OWN_KEY, ''); }
      if (which !== 'own') { held.invite = ''; ls.set(INVITE_KEY, ''); }
    },
    async write(req) {
      const how = this.access();
      if (!how) throw aiErr('needs_access');
      if (how === 'own') return writeWithOwnKey(req);
      const headers = { 'content-type': 'application/json' };
      if (how === 'invite') headers['x-reelsmith-invite'] = held.invite;
      let r;
      try { r = await fetch('api/script', { method: 'POST', headers, body: JSON.stringify(req) }); }
      catch (e) { throw aiErr('offline'); }
      let body = null; try { body = await r.json(); } catch (e) {}
      const code = (body && body.error) || 'failed';
      if (code === 'bad_invite' || code === 'invite_required') this.forget('invite');
      if (!r.ok) throw aiErr(code, { retryAfter: body && body.retryAfter });
      if (!body || !Array.isArray(body.scenes)) throw aiErr('shape');
      return body;
    }
  };

  /* ---- Anonymous usage counts: api/event.js. Skipped when the browser asks not to be tracked. ---- */
  const noTrack = navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';
  window.RS_TRACK = (e, v) => {
    if (noTrack) return;
    const body = JSON.stringify(v ? { e, v } : { e });
    try { if (!(navigator.sendBeacon && navigator.sendBeacon('api/event', new Blob([body], { type: 'text/plain' })))) fetch('api/event', { method: 'POST', body, keepalive: true }).catch(() => {}); } catch (err) {}
  };

  const user = { canEdit: async () => true };
  const caps = { db, assets, downloads, user };
  // Script writing and AI images ('sample') only exist in the Claude version, so they resolve to null here.
  window.claude = { use: async name => caps[name] || null };
})();
