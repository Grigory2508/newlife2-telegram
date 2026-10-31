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
// Формат в облаке: nl2_meta = {"v":1,"gen":G,"ts":…,"n":N,"enc":"gz64"|"json64","len":…}
// gen — счётчик версий (+1 при каждой выгрузке): по нему сравниваем копии, часы устройств не важны.
//                  nl2_<slot>0 … nl2_<slot>{N-1} = части строки base64, slot = a|b (у первой версии — c).
// Новая копия пишется в свободную ячейку, мета переключается последней: прерванная выгрузка не портит облако.
(function () {
  const PROJECT_ID = '4bild1ewg3i';
  const DBS = ['c3-localstorage-' + PROJECT_ID, 'c3-savegames-' + PROJECT_ID];
  const STORE = 'keyvaluepairs';
  const CHUNK = 4000, MAX_CHUNKS = 450, PARALLEL = 8, DEBOUNCE_MS = 8000;
  const LS_SYNC = 'nl2_sync_ts', LS_DIRTY = 'nl2_dirty_ts', LS_HASH = 'nl2_sync_hash', LS_GEN = 'nl2_sync_gen';

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
    }).then((db) => {
      // База есть, но таблицы ещё нет (игра открывала базу, но ничего не сохраняла) — создаём её новой версией.
      if (!create || db.objectStoreNames.contains(STORE)) return db;
      const v = db.version + 1; db.close();
      return new Promise((ok, no) => {
        const r = indexedDB.open(name, v);
        r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
        r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
        r.onblocked = () => no(new Error('db upgrade blocked'));
      });
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
    const names = Array.from({ length: meta.n }, (_, i) => 'nl2_' + (meta.slot || 'c') + i);
    let s = '';
    for (let i = 0; i < names.length; i += 50) {   // getItems — пачками
      const part = await cgetMany(names.slice(i, i + 50));
      for (const k of names.slice(i, i + 50)) s += part[k] || '';
    }
    if (s.length !== meta.len) throw new Error('cloud copy incomplete');
    return { meta, data: await decode(meta.enc, s) };
  }

  // ---- выгрузка в облако -------------------------------------------------------------------
  let timer = null, pushing = false, again = false, restoring = false;
  let checking = null;   // промис проверки облака: пока идёт, не выгружаем (иначе старая копия затрёт новую)
  async function push(reason) {
    if (checking) { try { await checking; } catch (e) {} }
    if (restoring) return;
    if (pushing) { again = true; return; }
    pushing = true;
    try {
      const dirtyAtDump = +lsGet(LS_DIRTY) || Date.now();   // записи после этого момента останутся «невыгруженными»
      const data = { ls: await dumpDb(DBS[0]), sg: await dumpDb(DBS[1]) };
      let { enc, s } = await encode(data);
      if (Math.ceil(s.length / CHUNK) > MAX_CHUNKS) {   // не влезает — сохраняем только мета-прогресс
        log('save too big for CloudStorage, keeping progress only', s.length);
        ({ enc, s } = await encode({ ls: data.ls, sg: {} }));
      }
      const h = await hash(s);
      if (h === lsGet(LS_HASH)) { lsSet(LS_SYNC, dirtyAtDump); return; }
      let cloudGen = 0, cloudSlot = 'c';
      try { const m = JSON.parse((await cget('nl2_meta')) || 'null'); if (m) { cloudGen = m.gen || 0; cloudSlot = m.slot || 'c'; } } catch (e) {}
      const myGen = +lsGet(LS_GEN) || 0;
      if (cloudGen > myGen) log('cloud changed on another device since last sync — overwriting (last writer wins)', cloudGen, myGen);
      const gen = Math.max(cloudGen, myGen) + 1, slot = cloudSlot === 'a' ? 'b' : 'a';
      const n = Math.ceil(s.length / CHUNK), ts = Date.now();
      for (let i = 0; i < n; i += PARALLEL) {
        const batch = [];
        for (let j = i; j < Math.min(n, i + PARALLEL); j++) batch.push(cset('nl2_' + slot + j, s.slice(j * CHUNK, (j + 1) * CHUNK)));
        await Promise.all(batch);
      }
      await cset('nl2_meta', JSON.stringify({ v: 1, gen, slot, ts, n, enc, len: s.length }));
      // лишние части этой ячейки от прошлых выгрузок и части первой версии (nl2_c*)
      const stale = (await ckeys()).filter((k) => { const m = /^nl2_([abc])(\d+)$/.exec(k); return m && (m[1] === 'c' || (m[1] === slot && +m[2] >= n)); });
      await cdel(stale);
      lsSet(LS_SYNC, dirtyAtDump); lsSet(LS_HASH, h); lsSet(LS_GEN, gen);
      log('pushed', reason, 'gen', gen, n, 'chunks', s.length, 'chars');
    } catch (e) {
      console.warn('[NL2Cloud] push failed', e);
    } finally {
      pushing = false;
      if (again) { again = false; setTimeout(() => push('again'), 0); }   // изменения пришли во время выгрузки — догружаем сразу
    }
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(() => push('debounce'), ms); }

  window.NL2Cloud = { supported, push: () => push('manual'), readCloud: supported ? readCloud : null };
  if (!supported) { log('disabled', inTelegram ? '(CloudStorage < 6.9)' : '(not in Telegram)'); return; }

  window.NL2Storage.onWrite(() => { lsSet(LS_DIRTY, Date.now()); schedule(DEBOUNCE_MS); });

  // ---- выгрузка при закрытии/сворачивании ---------------------------------------------------
  // visibilitychange срабатывает не везде (Telegram Desktop при закрытии окна, сворачивание на телефоне),
  // поэтому слушаем ещё pagehide и события Telegram deactivated/activated (Bot API 8.0).
  const unsynced = () => (+lsGet(LS_DIRTY) || 0) > (+lsGet(LS_SYNC) || 0);
  function flushNow(reason) { clearTimeout(timer); timer = null; if (unsynced()) push(reason); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow('hidden'); else check('visible'); });
  window.addEventListener('pagehide', () => flushNow('pagehide'));
  try { tg.onEvent('deactivated', () => flushNow('deactivated')); tg.onEvent('activated', () => check('activated')); } catch (e) {}

  // ---- восстановление: при запуске и при каждом разворачивании --------------------------------
  // Берём облачную копию, если её версия новее нашей и у нас нет своих невыгруженных изменений.
  // Если изменения есть с обеих сторон — побеждает более поздняя по времени.
  async function decide(meta, atStart) {
    const myGen = +lsGet(LS_GEN) || 0;
    const sync = atStart ? startSync : (+lsGet(LS_SYNC) || 0);
    const dirty = atStart ? startDirty : (+lsGet(LS_DIRTY) || 0);
    if (meta.gen && myGen) {
      if (meta.gen <= myGen) return false;
      return dirty <= sync || meta.ts > dirty;
    }
    return meta.ts > Math.max(sync, dirty);   // копии без счётчика (первая версия) — по времени
  }
  function check(reason) {
    if (checking || restoring) return checking;
    const atStart = reason === 'start';
    checking = (async () => {
      try {
        const raw = await cget('nl2_meta');
        if (!raw) { log('no cloud copy yet'); return; }
        const meta = JSON.parse(raw);
        if (!(await decide(meta, atStart))) { if (atStart) log('local copy is current'); return; }
        const { data } = await readCloud();
        restoring = true; window.__nl2Restoring = true; clearTimeout(timer); timer = null;
        await loadDb(DBS[0], data.ls || {});
        if (data.sg && Object.keys(data.sg).length) await loadDb(DBS[1], data.sg);
        lsSet(LS_SYNC, meta.ts); lsSet(LS_DIRTY, meta.ts); lsSet(LS_HASH, ''); lsSet(LS_GEN, meta.gen || 0);
        log('restored from cloud', reason, 'gen', meta.gen, new Date(meta.ts).toISOString());
        window.NL2Analytics && window.NL2Analytics.capture('cloud_restore', { reason, cloud_gen: meta.gen || 0, cloud_ts: meta.ts });
        // Игра уже прочитала старые данные — перезапускаем страницу, чтобы она взяла восстановленные.
        setTimeout(() => location.reload(), 300);
      } catch (e) {
        restoring = false; window.__nl2Restoring = false;
        console.warn('[NL2Cloud] restore failed', e);
      } finally { checking = null; }
    })();
    return checking;
  }
  check('start');
})();
