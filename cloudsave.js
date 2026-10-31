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
  const CHUNK = 4000, MAX_CHUNKS = 450, PARALLEL = 4, POLL_MS = 15000, DEBOUNCE_MS = 3000;
  const LS_PUSHING = 'nl2_push_started', LS_SYNC = 'nl2_sync_ts', LS_DIRTY = 'nl2_dirty_ts', LS_HASH = 'nl2_sync_hash', LS_GEN = 'nl2_sync_gen';

  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = !!(tg && tg.initData);
  const cs = tg && tg.CloudStorage;
  const supported = inTelegram && cs && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9');
  const log = (...a) => console.log('[NL2Cloud]', ...a);
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) {} };
  // Диагностика синхронизации в аналитику (analytics.js подключается после этого файла — берём лениво).
  const diag = (ev, props) => { try { window.NL2Analytics && window.NL2Analytics.capture(ev, props); } catch (e) {} };

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

  // ---- сжатие сохранения ---------------------------------------------------------------------
  // В сохранении Construct лежат целиком все массивы игры (~830 КБ), почти все — копии JSON-файлов сборки
  // с несколькими изменёнными ячейками. В облако кладём ссылку на файл и список отличий: ~7 частей вместо ~40.
  const PACK_INDEX = {"401x7x1":["200_years.json"],"23x28x1":["Achievements_EN.json","Achievements_RU.json"],"16x9x1":["Activity_EN.json","Activity_RU.json","Sport_EN.json","Sport_RU.json"],"33x6x1":["AdoptedMembers_EN.json","AdoptedMembers_RU.json"],"994x4x1":["AllText_New_EN.json","AllText_New_RU.json"],"191x12x1":["Buisness_EN.json","Buisness_RU.json"],"25x4x1":["ButtonsText_EN.json","ButtonsText_RU.json"],"11x7x1":["Clothes_EN.json","Clothes_RU.json","GameType.json","GameType_EN.json"],"12x14x1":["CoffeeOrSleep.json"],"134x73x1":["ComplexEvents_EN.json","ComplexEvents_RU.json"],"16x10x1":["Credits.json"],"50x16x1":["Diseases_EN.json","Diseases_RU.json"],"15x3x1":["Distribution_EN.json","Distribution_RU.json"],"68x8x1":["Divorce_EN.json","Divorce_RU.json"],"30x10x1":["Events_EN.json","Events_RU.json"],"200x25x1":["Family_EN.json","Family_RU.json"],"7x7x1":["Food_EN.json","Food_RU.json"],"27x4x1":["ForTravel.json","ForTravels_EN.json"],"12x10x1":["FreeTime_EN.json","FreeTime_RU.json"],"59x15x1":["Freelance_EN.json","Freelance_RU.json"],"28x9x1":["Gifts_EN.json","Gifts_RU.json","Packs_EN.json","Packs_RU.json"],"50x12x1":["Hobbies_SelfDevelop_EN.json","Hobbies_SelfDevelop_RU.json"],"22x24x1":["HomeList.json"],"12x23x1":["Home_EN.json","Home_RU.json"],"202x10x1":["Houses.json"],"82x10x1":["Human_EN.json","Human_RU.json"],"259x19x1":["Inventory_New.json"],"7x20x1":["Invest_EN.json","Invest_RU.json"],"24x4x1":["ItemEffectText_EN.json","ItemEffectText_RU.json"],"362x10x1":["Job_EN.json","Job_RU.json"],"702x7x1":["Kladbishe.json"],"12x7x1":["KladbishePlaces_EN.json","KladbishePlaces_RU.json","SpecialActions_EN.json","SpecialActions_RU.json"],"52x7x1":["Levels_RU.json"],"959x1x1":["Localize_EN.json","Localize_RU.json"],"17x12x1":["Managers.json"],"48x8x1":["Mogily_EN.json","Mogily_RU.json"],"13x3x1":["NMPrice_EN.json","NMPrice_RU.json"],"606x5x1":["Names_EN.json","Names_RU.json"],"13x11x1":["NotMobList_RU.json"],"22x14x1":["NotMob_EN.json","NotMob_RU.json"],"202x18x1":["NotRandomAction_RU.json","NotRandomEvents_RU.json","NotRandom_Actions_EN.json","NotRandom_Events_EN.json"],"302x17x1":["OtherPeoples.json"],"302x20x1":["People.json"],"211x7x1":["Pets_EN.json","Pets_RU.json"],"32x10x1":["RandomDeath_EN.json","RandomDeath_RU.json"],"66x4x1":["Results_EN.json","Results_RU.json"],"13x2x1":["Rooms_EN.json","Rooms_RU.json"],"302x4x1":["SexList.json"],"39x4x1":["Skills_EN.json","Skills_RU.json"],"39x8x1":["SocActions_EN.json","SocActions_RU.json"],"67x19x1":["SpecialShopNew_RU.json","SpecialShop_New_EN.json"],"48x10x1":["SpecialShop_EN.json","SpecialShop_RU.json"],"41x7x1":["Statistica_EN.json","Statistica_RU.json"],"34x5x1":["TeamCredits_EN.json","TeamCredits_RU.json"],"201x8x1":["TextContent_EN.json","TextContent_RU.json"],"32x4x1":["Transport_EN.json","Transport_RU.json"],"1801x17x1":["TravelActions_New_EN.json","TravelActions_New_RU.json"],"49x12x1":["TravelPoints_EN.json","TravelPoints_RU.json"],"12x11x1":["Travel_ADSPacks.json"],"32x8x1":["Vacations.json"]};   // размер массива -> файлы сборки такого размера
  const fileCache = {};
  const getFile = (name) => (fileCache[name] = fileCache[name] ||
    fetch(name).then((r) => { if (!r.ok) throw new Error('fetch ' + name + ' ' + r.status); return r.json(); }).then((j) => j.data));
  const cellEq = (a, b) => {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  async function packSave(save, lang) {
    let n = 0;
    const rank = (f) => (f.includes('_' + lang + '.') ? 0 : /_(RU|EN)\./.test(f) ? 2 : 1);
    const need = new Set();
    for (const t of Object.values(save.types || {})) for (const inst of t.instances || []) {
      const dd = inst.data, c = dd && Array.isArray(dd.size) && PACK_INDEX[dd.size.join('x')];
      if (c) need.add(c.slice().sort((a, b) => rank(a) - rank(b))[0]);
    }
    await Promise.all([...need].map((f) => getFile(f).catch(() => null)));
    for (const t of Object.values(save.types || {})) for (const inst of t.instances || []) {
      const dd = inst.data;
      if (!dd || !Array.isArray(dd.size) || !Array.isArray(dd.data) || Object.keys(dd).length !== 2) continue;
      let cands = PACK_INDEX[dd.size.join('x')];
      if (!cands) continue;
      // сначала файл текущего языка, потом общий, потом другой язык (его скачиваем, только если первый не подошёл)
      cands = cands.slice().sort((a, b) => rank(a) - rank(b));
      const [X, Y] = dd.size, limit = (X * Y) / 4;
      let best = null;
      for (const f of cands) {
        let fd; try { fd = await getFile(f); } catch (e) { continue; }
        const d = []; let ok = fd.length === X;
        for (let x = 0; x < X && ok; x++) for (let y = 0; y < Y && ok; y++) {
          if (!cellEq(dd.data[x][y], fd[x][y])) { d.push([x, y, dd.data[x][y]]); if (d.length > limit) ok = false; }
        }
        if (ok && (!best || d.length < best.d.length)) best = { $nl2f: f, s: dd.size, d };
        if (best && best.d.length <= (X * Y) / 20) break;
      }
      if (best) { inst.data = best; n++; }
    }
    return n;
  }
  async function unpackSave(save) {
    const need = new Set();
    for (const t of Object.values(save.types || {})) for (const inst of t.instances || []) if (inst.data && inst.data.$nl2f) need.add(inst.data.$nl2f);
    await Promise.all([...need].map(getFile));   // все файлы сразу, а не по одному
    for (const t of Object.values(save.types || {})) for (const inst of t.instances || []) {
      const p = inst.data;
      if (!p || !p.$nl2f) continue;
      const fd = await getFile(p.$nl2f);
      const data = fd.map((row) => row.map((c) => (Array.isArray(c) ? c.slice() : c)));
      for (const [x, y, v] of p.d) data[x][y] = v;
      inst.data = { size: p.s, data };
    }
    return save;
  }
  // sg (база сохранений) -> sgp: сохранения Construct сжаты, остальное как есть
  async function packSg(sg, lang) {
    const out = {};
    for (const [k, v] of Object.entries(sg)) {
      try {
        const obj = typeof v === 'string' ? JSON.parse(v) : v;
        if (obj && obj.c3save && obj.types) { await packSave(obj, lang); out[k] = { p: obj, str: typeof v === 'string' }; continue; }
      } catch (e) {}
      out[k] = { r: v };
    }
    return out;
  }
  async function unpackSg(sgp) {
    const out = {};
    for (const [k, e] of Object.entries(sgp)) {
      if ('r' in e) { out[k] = e.r; continue; }
      const obj = await unpackSave(e.p);
      out[k] = e.str ? JSON.stringify(obj) : obj;
    }
    return out;
  }
  window.__nl2Pack = { packSg, unpackSg };   // для тестов

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
    const t0 = Date.now(); let stage = 'dump';
    lsSet(LS_PUSHING, t0);
    try {
      const dirtyAtDump = +lsGet(LS_DIRTY) || Date.now();   // записи после этого момента останутся «невыгруженными»
      const raw = { ls: await dumpDb(DBS[0]), sg: await dumpDb(DBS[1]) };
      stage = 'pack';
      let data;
      const lang = +raw.ls.Language === 1 ? 'EN' : 'RU';
      try { data = { ls: raw.ls, sgp: await packSg(raw.sg, lang) }; } catch (e) { console.warn('[NL2Cloud] pack failed', e); data = raw; }
      stage = 'encode';
      let { enc, s } = await encode(data);
      if (Math.ceil(s.length / CHUNK) > MAX_CHUNKS) {   // не влезает — сохраняем только мета-прогресс
        log('save too big for CloudStorage, keeping progress only', s.length);
        ({ enc, s } = await encode({ ls: raw.ls, sg: {} }));
      }
      const h = await hash(s);
      if (h === lsGet(LS_HASH)) { lsSet(LS_SYNC, dirtyAtDump); try { localStorage.removeItem(LS_PUSHING); } catch (e) {} return; }
      let cloudGen = 0, cloudSlot = 'c';
      try { const m = JSON.parse((await cget('nl2_meta')) || 'null'); if (m) { cloudGen = m.gen || 0; cloudSlot = m.slot || 'c'; } } catch (e) {}
      const myGen = +lsGet(LS_GEN) || 0;
      if (cloudGen > myGen) log('cloud changed on another device since last sync — overwriting (last writer wins)', cloudGen, myGen);
      const gen = Math.max(cloudGen, myGen) + 1, slot = cloudSlot === 'a' ? 'b' : 'a';
      const n = Math.ceil(s.length / CHUNK), ts = Date.now();
      const tUp = Date.now(); stage = 'chunks';
      const part = (j) => cset('nl2_' + slot + j, s.slice(j * CHUNK, (j + 1) * CHUNK));
      try {   // по PARALLEL запросов сразу: один запрос к CloudStorage идёт ~0,2–1 с
        for (let i = 0; i < n; i += PARALLEL) await Promise.all(Array.from({ length: Math.min(PARALLEL, n - i) }, (_, k) => part(i + k)));
      } catch (e) {   // Telegram отклонил параллельные запросы — повторяем по одному
        diag('cloud_parallel_failed', { error: String((e && e.message) || e).slice(0, 200) });
        for (let j = 0; j < n; j++) await part(j);
      }
      stage = 'meta';
      await cset('nl2_meta', JSON.stringify({ v: 1, gen, slot, ts, n, enc, len: s.length }));
      // лишние части этой ячейки от прошлых выгрузок и части первой версии (nl2_c*)
      const stale = (await ckeys()).filter((k) => { const m = /^nl2_([abc])(\d+)$/.exec(k); return m && (m[1] === 'c' || (m[1] === slot && +m[2] >= n)); });
      await cdel(stale);
      lsSet(LS_SYNC, dirtyAtDump); lsSet(LS_HASH, h); lsSet(LS_GEN, gen);
      try { localStorage.removeItem(LS_PUSHING); } catch (e) {}
      log('pushed', reason, 'gen', gen, n, 'chunks', s.length, 'chars');
      diag('cloud_push', { reason, gen, cloud_gen_before: cloudGen, my_gen_before: myGen, chunks: n, ms: Date.now() - t0, upload_ms: Date.now() - tUp });
    } catch (e) {
      try { localStorage.removeItem(LS_PUSHING); } catch (e2) {}
      console.warn('[NL2Cloud] push failed', e);
      diag('cloud_push_failed', { reason, stage, error: String((e && e.message) || e).slice(0, 200), ms: Date.now() - t0 });
    } finally {
      pushing = false;
      if (again) { again = false; setTimeout(() => push('again'), 0); }   // изменения пришли во время выгрузки — догружаем сразу
    }
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(() => push('debounce'), ms); }

  window.NL2Cloud = { supported, push: () => push('manual'), readCloud: supported ? readCloud : null };
  if (!supported) { window.NL2CloudReady = Promise.resolve(); log('disabled', inTelegram ? '(CloudStorage < 6.9)' : '(not in Telegram)'); return; }

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
      if (!atStart && dirty > sync) return false;   // во время игры свои невыгруженные изменения важнее: сначала выгрузим их
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
        if (!raw) { if (atStart) { log('no cloud copy yet'); diag('cloud_check', { reason, result: 'empty' }); } return; }
        const meta = JSON.parse(raw);
        const take = await decide(meta, atStart);
        if (atStart || take) diag('cloud_check', { reason, result: take ? 'restore' : 'keep_local', cloud_gen: meta.gen || 0, cloud_slot: meta.slot || 'c', my_gen: +lsGet(LS_GEN) || 0,
          cloud_age_s: Math.round((Date.now() - meta.ts) / 1000), local_sync_age_s: Math.round((Date.now() - (atStart ? startSync : +lsGet(LS_SYNC) || 0)) / 1000),
          local_dirty_age_s: Math.round((Date.now() - (atStart ? startDirty : +lsGet(LS_DIRTY) || 0)) / 1000) });
        if (!take) { if (atStart) log('local copy is current'); return; }
        const { data } = await readCloud();
        const sg = data.sgp ? await unpackSg(data.sgp) : data.sg;   // sgp — сжатая копия (нужны JSON-файлы сборки); до записи в базы
        restoring = true; window.__nl2Restoring = true; clearTimeout(timer); timer = null;
        await loadDb(DBS[0], data.ls || {});
        if (sg && Object.keys(sg).length) await loadDb(DBS[1], sg);
        lsSet(LS_SYNC, meta.ts); lsSet(LS_DIRTY, meta.ts); lsSet(LS_HASH, ''); lsSet(LS_GEN, meta.gen || 0);
        log('restored from cloud', reason, 'gen', meta.gen, new Date(meta.ts).toISOString());
        window.NL2Analytics && window.NL2Analytics.capture('cloud_restore', { reason, cloud_gen: meta.gen || 0, cloud_ts: meta.ts });
        // Игра уже прочитала старые данные — перезапускаем страницу, чтобы она взяла восстановленные.
        if (atStart && !window.__nl2GameStarted) {   // игра ещё не запущена (ждёт облако) — перезагрузка не нужна
          restoring = false; window.__nl2Restoring = false; return;
        }
        try { window.NL2Analytics && window.NL2Analytics.flush(); } catch (e) {}
        setTimeout(() => location.reload(), 400);
      } catch (e) {
        restoring = false; window.__nl2Restoring = false;
        console.warn('[NL2Cloud] restore failed', e);
        diag('cloud_restore_failed', { reason, error: String((e && e.message) || e).slice(0, 200) });
      } finally { checking = null; }
    })();
    return checking;
  }
  const interrupted = +lsGet(LS_PUSHING) || 0;
  if (interrupted) { try { localStorage.removeItem(LS_PUSHING); } catch (e) {} setTimeout(() => diag('cloud_push_interrupted', { age_s: Math.round((Date.now() - interrupted) / 1000) }), 0); }
  // index.html ждёт этот промис (не дольше 5 с) и только потом запускает игру: нужная копия загружается сразу.
  window.NL2CloudReady = check('start') || Promise.resolve();
  // Не успели выгрузить в прошлый раз — выгружаем сразу после старта.
  window.NL2CloudReady.then(() => { if (!restoring && unsynced()) schedule(2000); });
  // Пока игра открыта: проверка облака каждые POLL_MS и при возвращении в окно (окно Telegram Desktop не сворачивается).
  setInterval(() => { if (document.visibilityState === 'visible' && !pushing) check('poll'); }, POLL_MS);
  window.addEventListener('focus', () => check('focus'));
  // Прогрев: заранее скачиваем (из кэша браузера) нужные JSON-файлы, чтобы выгрузка при закрытии не ждала сети.
  // Через 6 с после старта и при первой записи сохранения, если его ещё не было.
  let warmed = false, warming = false;
  async function warm() {
    if (warmed || warming || restoring) return;
    warming = true;
    try {
      if (checking) await checking;
      const ls = await dumpDb(DBS[0]), sg = await dumpDb(DBS[1]);
      if (!Object.keys(sg).length) return;
      const t = Date.now(); await packSg(sg, +ls.Language === 1 ? 'EN' : 'RU');
      warmed = true; log('pack cache warm', Date.now() - t, 'ms');
    } catch (e) {} finally { warming = false; }
  }
  setTimeout(warm, 6000);
  window.NL2Storage.onWrite((db) => { if (!warmed && db === DBS[1]) setTimeout(warm, 1000); });
})();
