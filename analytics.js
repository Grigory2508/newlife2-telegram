// Аналитика New Life 2 (задача 1.8): несколько событий в PostHog EU без библиотеки posthog-js.
// Только внутри Telegram (вне Telegram события не уходят, если не задан window.NL2_ANALYTICS_FORCE).
// Без автосбора, без записи экрана, без cookies. Пользователь — псевдоним: хэш Telegram id.
(function () {
  const KEY = 'phc_AGgZyFbhD9MYYTxAgq3TyBPrEi8qnoupKAHyHhJpJSCp';   // публичный ключ проекта (только запись событий)
  const HOST = 'https://eu.i.posthog.com';
  const APP_VERSION = '1.7.3.0-tg';
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = !!(tg && tg.initData);
  const enabled = inTelegram || !!window.NL2_ANALYTICS_FORCE;
  const t0 = Date.now();
  const queue = [];
  let distinctId = null, flushTimer = null;
  const stats = { ads_shown: 0, ads_granted: 0 };

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  async function sha(s) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
    return Array.from(h.slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const ready = (async () => {
    const uid = inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id;
    if (uid && crypto && crypto.subtle) { distinctId = 'tg_' + await sha('nl2:' + uid); return; }
    distinctId = lsGet('nl2_aid');
    if (!distinctId) { distinctId = 'anon_' + Math.random().toString(36).slice(2) + Date.now().toString(36); lsSet('nl2_aid', distinctId); }
  })();

  const base = () => ({
    $lib: 'nl2-lite', app_version: APP_VERSION, in_telegram: inTelegram,
    tg_platform: tg && tg.platform, tg_version: tg && tg.version,
    tg_lang: tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code,
    $process_person_profile: false,   // без профилей людей: только анонимные события
  });

  function send(events, beacon) {
    if (!events.length) return;
    if (window.NL2_ANALYTICS_DRYRUN) { (window.__nl2Sent = window.__nl2Sent || []).push(...events); console.log('[NL2Analytics] dry-run', events); return; }
    const body = JSON.stringify({ api_key: KEY, batch: events });
    try {
      if (beacon && navigator.sendBeacon) { navigator.sendBeacon(HOST + '/batch/', new Blob([body], { type: 'text/plain' })); return; }
      fetch(HOST + '/batch/', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true })
        .catch((e) => console.warn('[NL2Analytics]', e));
    } catch (e) { console.warn('[NL2Analytics]', e); }
  }
  function flush(beacon) { clearTimeout(flushTimer); flushTimer = null; send(queue.splice(0), beacon); }

  function capture(event, props) {
    if (!enabled) return;
    const ts = new Date().toISOString();
    ready.then(() => {
      queue.push({ event, distinct_id: distinctId, timestamp: ts, properties: Object.assign(base(), props || {}) });
      if (!flushTimer) flushTimer = setTimeout(() => flush(false), 3000);
    });
  }
  window.NL2Analytics = { capture, stats, enabled };
  if (!enabled) return;

  const firstOpen = !lsGet('nl2_seen');
  lsSet('nl2_seen', '1');
  capture('app_open', {
    first_open: firstOpen,
    start_param: tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param,
  });

  // События игры видны по записям в её хранилище (см. cloudsave.js: window.NL2Storage).
  if (window.NL2Storage) {
    let lastDeaths = null;
    window.NL2Storage.onWrite((db, op, key, val) => {
      if (op !== 'put') return;
      if (key === 'Deathes' && val !== lastDeaths) { lastDeaths = val; capture('life_end', { lives_total: +val || 0 }); }
      if (key === 'Record') capture('record', { years: +val || 0 });
      if (key === 'Language') capture('language_set', { game_lang: +val === 1 ? 'en' : 'ru' });
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    capture('session_pause', { seconds: Math.round((Date.now() - t0) / 1000), ads_shown: stats.ads_shown, ads_granted: stats.ads_granted });
    ready.then(() => flush(true));
  });
})();
