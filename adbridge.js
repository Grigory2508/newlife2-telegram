// Мост рекламы для HTML5-сборки New Life 2.
// В Android-версии реклама шла через AdMob (Cordova). Здесь все вызовы
// плагина Mobile Advert перехватываются и идут в window.NL2Ads.
//
// Реклама за награду в Telegram: AdsGram (sad.min.js подключён в index.html).
// Вне Telegram (нет initData) или без blockId — заглушка: награда выдаётся сразу.
//
// callback плагина: cb(error, result). error != null => событие "failed".

// ---- Настройки AdsGram ----------------------------------------------------
// blockId блока типа Reward из partner.adsgram.ai (строка, например "1234").
const ADSGRAM_BLOCK_ID = window.NL2_ADSGRAM_BLOCK_ID || '';
// true = AdsGram отдаёт тестовую рекламу (статистика и Reward URL не пишутся).
// Перед релизом обязательно false.
// window.NL2_ADSGRAM_* можно задать до загрузки игры (для тестов).
const ADSGRAM_DEBUG = window.NL2_ADSGRAM_DEBUG ?? false;
// ---------------------------------------------------------------------------

const tgInfo = window.NL2Telegram || {};
const ads = window.NL2Ads = window.NL2Ads || {};

// Сколько ждать ad.show() максимум (рантайм всё это время на паузе).
const ADSGRAM_SHOW_TIMEOUT_MS = 90000;

function makeAdsgramRewarded() {
  if (!tgInfo.inTelegram) return null;
  if (!ADSGRAM_BLOCK_ID) {
    // В Telegram без blockId награду НЕ выдаём: иначе релиз с пустым ID раздаёт всё бесплатно.
    console.error('[NL2Ads] ADSGRAM_BLOCK_ID не задан: реклама в Telegram отключена, награды не будет');
    return async () => { ads.lastOutcome = 'no_block_id'; return false; };
  }
  // sad.min.js грузится async: контроллер создаём при первом показе, когда скрипт уже есть.
  let controller = null;
  const getController = () => {
    if (!controller && window.Adsgram) {
      try { controller = window.Adsgram.init({ blockId: ADSGRAM_BLOCK_ID, debug: ADSGRAM_DEBUG }); }
      catch (e) { console.warn('[NL2Ads] Adsgram.init failed', e); }
    }
    return controller;
  };
  getController();
  let busy = false;
  return async (kind) => {
    getController();
    // Скрипт AdsGram не загрузился (блокировщик, сеть) — без награды, игра даст утешительный бонус.
    if (!controller) { console.warn('[NL2Ads] AdsGram недоступен'); ads.lastOutcome = 'no_sdk'; return false; }
    if (busy) { ads.lastOutcome = 'busy'; return false; }
    busy = true;
    try {
      // Защита от зависания: если show() не ответил, снимаем паузу и считаем, что награды нет.
      const r = await Promise.race([
        controller.show(),
        new Promise((_, rej) => setTimeout(() => rej({ done: false, description: 'timeout' }), ADSGRAM_SHOW_TIMEOUT_MS)),
      ]);
      console.log('[NL2Ads] AdsGram resolved', kind, r);
      ads.lastOutcome = r && r.done ? 'done' : 'not_done';
      return !!(r && r.done);
    } catch (r) {
      // Пропуск, ошибка воспроизведения или нет рекламы (no fill).
      console.log('[NL2Ads] AdsGram rejected', kind, r);
      ads.lastOutcome = (r && r.description) === 'timeout' ? 'timeout' : (r && r.state) || (r && r.description) || 'rejected';
      return false;
    } finally { busy = false; }
  };
}

ads.showRewarded ??= makeAdsgramRewarded()
  || (async (kind) => { console.log('[NL2Ads] rewarded →', kind, '(stub: granted)'); ads.lastOutcome = 'stub'; return true; });
ads.showInterstitial ??= async (kind) => { console.log('[NL2Ads] interstitial →', kind, '(stub: skipped)'); };
// Заглушка отвечает мгновенно, паузить игру не нужно. Настоящую рекламу — нужно (см. ниже).
ads.pauseGame ??= !!(tgInfo.inTelegram && ADSGRAM_BLOCK_ID);

// Аналитика показов (analytics.js): тип, результат, длительность.
function report(kind, granted, outcome, t) {
  const a = window.NL2Analytics; if (!a) return;
  a.stats.ads_shown++; if (granted) a.stats.ads_granted++;
  a.capture('ad_result', { kind, granted: !!granted, outcome, ms: Date.now() - t });
}

const ok   = (cb, v) => cb(null, v);
const fail = (cb, e) => cb(e, null);
const last = (args) => args[args.length - 1];

function patch() {
  const api = self.C3MobileAdvertsAPI && self.C3MobileAdvertsAPI.web;
  if (!api) return false;

  // Пока идёт реклама, рантайм Construct должен стоять на паузе.
  // Экран ADS считает таймаут (10 тиков по 1.2 c ≈ 12 c), пока видео "не загружено";
  // во время показа оно тоже "не загружено". Без паузы через 12 c игра уходит
  // с экрана с утешительным бонусом и сообщением "нет интернета", а досмотренная
  // реклама теряется. На Android AdMob ставил приложение на паузу сам.
  // suspendRuntime/resumeRuntime подкладывает в api сам плагин Mobile Advert.
  const withPause = async (fn) => {
    const pause = ads.pauseGame;
    if (pause && api.suspendRuntime) api.suspendRuntime();
    try { return await fn(); }
    finally { if (pause && api.resumeRuntime) api.resumeRuntime(); }
  };
  const rewarded = (kind) => async (...a) => { const cb = last(a);
    let granted; const t = Date.now(); ads.lastOutcome = 'unknown';
    try { granted = await withPause(() => ads.showRewarded(kind)); }
    catch (e) { report(kind, false, 'exception', t); return fail(cb, String(e)); }
    report(kind, granted, ads.lastOutcome, t);
    // Рантайм уже снят с паузы, поэтому OnVideoComplete / OnVideoCancelled сработают сразу.
    granted ? ok(cb, JSON.stringify(['Reward', 1])) : fail(cb, 'closed with no reward');
  };

  const quiet = (msg) => (...a) => ok(last(a), msg);
  Object.assign(api, {
    Configure:                         quiet('UNKNOWN&&not-determined&&true'),
    RequestConsent:                    quiet('UNKNOWN&&not-determined&&true'),
    StatusUpdate:                      quiet('UNKNOWN&&not-determined&&true'),
    RequestIDFA:                       quiet('not-determined'),
    SetMaxAdContentRating:             quiet('ok'),
    TagForChildDirectedTreatment:      quiet('ok'),
    TagForUnderAgeOfConsent:           quiet('ok'),
    CreateBannerAdvert:                (...a) => fail(last(a), 'banners disabled in html5'),
    ShowBannerAdvert:                  (...a) => fail(last(a), 'banners disabled in html5'),
    HideBannerAdvert:                  quiet('banner hidden'),
    CreateInterstitialAdvert:          quiet('interstitial created'),
    CreateVideoAdvert:                 quiet('video created'),
    CreateRewardedAdvert:              quiet('rewarded created'),
    CreateRewardedInterstitialAdvert:  quiet('rewarded interstitial created'),
    ShowInterstitialAdvert: async (...a) => { const cb = last(a);
      try { await withPause(() => ads.showInterstitial('interstitial')); ok(cb, 'interstitial shown'); } catch (e) { fail(cb, String(e)); } },
    // В игре "Video" = видео за награду (кнопки "...(VideoADS)"), рантайм ждёт JSON [тип, кол-во].
    ShowVideoAdvert:                rewarded('video'),
    ShowRewardedAdvert:             rewarded('rewarded'),
    ShowRewardedInterstitialAdvert: rewarded('rewarded-interstitial'),
  });
  return true;
}
if (!patch()) console.warn('[NL2Ads] advert web API not found');

// Не грузим скрипт Google AdSense (H5 Games Ads), который рантайм пытается
// подключить сам: в вебе/Telegram он не нужен. Притворяемся, что загрузился.
const _append = Element.prototype.appendChild;
Element.prototype.appendChild = function (el) {
  if (el && el.tagName === 'SCRIPT' && /googlesyndication|adsbygoogle/.test(el.src || '')) {
    console.log('[NL2Ads] blocked', el.src);
    setTimeout(() => el.onload && el.onload());
    return el;
  }
  return _append.call(this, el);
};
