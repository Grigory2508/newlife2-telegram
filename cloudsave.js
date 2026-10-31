// Облачная копия сохранений New Life 2 в Telegram CloudStorage (задача 1.7).
//
// Игра (Construct 3) хранит прогресс в IndexedDB браузера:
//   c3-localstorage-<id>  — плагин LocalStorage (монеты, рекорд, кладбище, язык…)
//   c3-savegames-<id>     — сохранение текущей жизни (mysave1)
// В Telegram WebView это хранилище может очищаться, и оно не переезжает на другое устройство.
// Этот скрипт держит копию в CloudStorage пользователя (до 1024 ключей по 4096 символов)
// и восстанавливает её, если локально данных нет или облачная копия новее.
// Рантайм и main.js не трогаются: перехватываются только записи в IndexedDB.
//
// Формат в облаке: nl2_meta = {"v":1,"ts":…,"n":N,"enc":"gz64"|"json64","len":…}
//                  nl2_c0 … nl2_c{N-1} = части строки base64.
(function () {
  const PROJECT_ID = '4bild1ewg3i';
  const DBS = ['c3-localstorage-' + PROJECT_ID, 'c3-savegames-' + PROJECT_ID];
  const STORE = 'keyvaluepairs';
  const CHUNK = 4000, MAX_CHUNKS = 900, DEBOUNCE_MS = 20000;
  const LS_SYNC = 'nl2_sync_ts', LS_DIRTY = 'nl2_dirty_ts', LS_HASH = 'nl2_sync_hash';

  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = !!(tg && tg.initData);
  const cs = tg && tg.CloudStorage;
  const supported = inTelegram && cs && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9');
  const log = (...a) => console.log('[NL2Cloud]', ...a);
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) {} };

  // Снимок до старта игры: по нему решаем, чья копия новее.
  const startSync = +lsGet(LS_SYNC) || 0;
  const startDirty = +lsGet(LS_DIRTY) || 0;

  // ---- перехват записей в IndexedDB игры ----------------------------------------------
  const listeners = [];
  window.NL2Storage = { onWrite: (fn) => listeners.push(fn) };
  const P = IDBObjectStore.prototype;
  for (const m of ['put', 'add', 'delete', 'clear']) {
    const orig = P[m];
    P[m] = function (...args) {
      try {
        const db = this.transaction && this.transaction.db && this.transaction.db.name;
        if (DBS.includes(db) && !window.__nl2Restoring) {
          const key = m === 'put' || m === 'add' ? args[1] : args[0];
          const val = m === 'put' || m === 'add' ? args[0] : undefined;
          for (const fn of listeners) { try { fn(db, m, key, val); } catch (e) {} }
        }
      } catch (e) {}
      return orig.apply(this, args);
    };
  }

  // ---- IndexedDB: чтение/запись целиком -----------------------------------------------
  const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  async function openDb(name, create) {
    const names = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : null;
    const exists = names ? names.includes(name) : null;
    if (exists === false && !create) return null;
    return new Promise((ok, no) => {
      // Существующую базу открываем в её текущей версии; новую создаём версии 1.
      const r = exists ? indexedDB.open(name) : indexedDB.open(name, 1);
      // Та же схема, что у localforage в Construct: одна таблица keyvaluepairs, версия 1.
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    });
  }
  async function dumpDb(name) {
    const db = await openDb(name, false);
    if (!db) return {};
    try {
      if (!db.objectStoreNames.contains(STORE)) return {};
      const st = db.transaction(STORE).objectStore(STORE);
      const [keys, vals] = await Promise.all([req(st.getAllKeys()), req(st.getAll())]);
      const out = {};
      keys.forEach((k, i) => { out[k] = vals[i]; });
      return out;
    } finally { db.close(); }
  }
  async function loadDb(name, data) {
    const db = await openDb(name, true);
    try {
      const tx = db.transaction(STORE, 'readwrite'); const st = tx.objectStore(STORE);
      st.clear();
      for (const [k, v] of Object.entries(data)) st.put(v, k);
      await new Promise((ok, no) => { tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    } finally { db.close(); }
  }

  // ---- кодирование ------------------------------------------------------------------------
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const canGz = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  async function pipe(u8, stream) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer()); }
  async function encode(obj) {
    const u8 = new TextEncoder().encode(JSON.stringify(obj));
    return canGz ? { enc: 'gz64', s: b64(await pipe(u8, new CompressionStream('gzip'))) } : { enc: 'json64', s: b64(u8) };
  }
  async function decode(enc, s) {
    let u8 = unb64(s);
    if (enc === 'gz64') u8 = await pipe(u8, new DecompressionStream('gzip'));
    return JSON.parse(new TextDecoder().decode(u8));
  }
  async function hash(s) {
    if (!(crypto && crypto.subtle)) return String(s.length);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
    return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ---- CloudStorage (колбэки -> промисы) ------------------------------------------------
  const cget = (k) => new Promise((ok, no) => cs.getItem(k, (e, v) => (e ? no(e) : ok(v))));
  const cgetMany = (ks) => new Promise((ok, no) => cs.getItems(ks, (e, v) => (e ? no(e) : ok(v))));
  const cset = (k, v) => new Promise((ok, no) => cs.setItem(k, v, (e, r) => (e ? no(e) : ok(r))));
  const cdel = (ks) => new Promise((ok) => (ks.length ? cs.removeItems(ks, () => ok()) : ok()));
  const ckeys = () => new Promise((ok, no) => cs.getKeys((e, v) => (e ? no(e) : ok(v || []))));

  async function readCloud() {
    const raw = await cget('nl2_meta');
    if (!raw) return null;
    const meta = JSON.parse(raw);
    const names = Array.from({ length: meta.n }, (_, i) => 'nl2_c' + i);
    let s = '';
    for (let i = 0; i < names.length; i += 50) {   // getItems — пачками
      const part = await cgetMany(names.slice(i, i + 50));
      for (const k of names.slice(i, i + 50)) s += part[k] || '';
    }
    if (s.length !== meta.len) throw new Error('cloud copy incomplete');
    return { meta, data: await decode(meta.enc, s) };
  }

  // ---- выгрузка в облако -------------------------------------------------------------------
  let timer = null, pushing = false, again = false;
  async function push(reason) {
    if (pushing) { again = true; return; }
    pushing = true;
    try {
      const data = { ls: await dumpDb(DBS[0]), sg: await dumpDb(DBS[1]) };
      let { enc, s } = await encode(data);
      if (Math.ceil(s.length / CHUNK) > MAX_CHUNKS) {   // не влезает — сохраняем только мета-прогресс
        log('save too big for CloudStorage, keeping progress only', s.length);
        ({ enc, s } = await encode({ ls: data.ls, sg: {} }));
      }
      const h = await hash(s);
      if (h === lsGet(LS_HASH)) { lsSet(LS_SYNC, +lsGet(LS_DIRTY) || Date.now()); return; }
      const n = Math.ceil(s.length / CHUNK), ts = Date.now();
      for (let i = 0; i < n; i++) await cset('nl2_c' + i, s.slice(i * CHUNK, (i + 1) * CHUNK));
      await cset('nl2_meta', JSON.stringify({ v: 1, ts, n, enc, len: s.length }));
      const stale = (await ckeys()).filter((k) => /^nl2_c\d+$/.test(k) && +k.slice(5) >= n);
      await cdel(stale);
      lsSet(LS_SYNC, ts); lsSet(LS_HASH, h);
      log('pushed', reason, n, 'chunks', s.length, 'chars');
    } catch (e) {
      console.warn('[NL2Cloud] push failed', e);
    } finally {
      pushing = false;
      if (again) { again = false; schedule(5000); }
    }
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(() => push('debounce'), ms); }

  window.NL2Cloud = { supported, push: () => push('manual'), readCloud: supported ? readCloud : null };
  if (!supported) { log('disabled', inTelegram ? '(CloudStorage < 6.9)' : '(not in Telegram)'); return; }

  window.NL2Storage.onWrite(() => { lsSet(LS_DIRTY, Date.now()); schedule(DEBOUNCE_MS); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && timer) { clearTimeout(timer); timer = null; push('hidden'); } });

  // ---- восстановление при запуске -----------------------------------------------------------
  (async () => {
    try {
      const raw = await cget('nl2_meta');
      if (!raw) { log('no cloud copy yet'); return; }
      const meta = JSON.parse(raw);
      const localNewest = Math.max(startSync, startDirty);
      // Облако новее того, что было на этом устройстве к старту, — забираем его.
      if (meta.ts <= localNewest) { log('local copy is current'); return; }
      const { data } = await readCloud();
      window.__nl2Restoring = true;
      await loadDb(DBS[0], data.ls || {});
      if (data.sg && Object.keys(data.sg).length) await loadDb(DBS[1], data.sg);
      lsSet(LS_SYNC, meta.ts); lsSet(LS_DIRTY, meta.ts); lsSet(LS_HASH, '');
      log('restored from cloud', new Date(meta.ts).toISOString());
      window.NL2Analytics && window.NL2Analytics.capture('cloud_restore', { cloud_ts: meta.ts, had_local: localNewest > 0 });
      // Игра уже прочитала старые данные — перезапускаем страницу, чтобы она взяла восстановленные.
      setTimeout(() => location.reload(), 300);
    } catch (e) {
      window.__nl2Restoring = false;
      console.warn('[NL2Cloud] restore failed', e);
    }
  })();
})();
