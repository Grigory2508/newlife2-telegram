// Интеграция с Telegram Mini Apps для New Life 2.
// Вне Telegram ничего не ломает: просто открывает ссылки в новой вкладке.
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = !!(tg && tg.initData);   // initData пуст, если открыто не из Telegram
  window.NL2Telegram = { tg, inTelegram };

  // Ссылки из игры (кнопки "Дневники разработки", документ и т.п.).
  // Рантайм вызывает это вместо перехода на URL, чтобы Mini App не уходил со страницы игры.
  window.NL2OpenURL = function (url) {
    if (inTelegram) {
      if (/^https?:\/\/t\.me\//i.test(url)) tg.openTelegramLink(url);
      else tg.openLink(url);
    } else {
      window.open(url, '_blank');
    }
  };

  if (!inTelegram) return;

  const v = (min) => tg.isVersionAtLeast && tg.isVersionAtLeast(min);
  try {
    tg.ready();
    tg.expand();
    if (v('6.1')) { tg.setHeaderColor('#008ca7'); tg.setBackgroundColor('#59bed4'); }
    if (v('7.10')) tg.setBottomBarColor('#008ca7');
    if (v('7.7')) tg.disableVerticalSwipes();   // свайп по игре не сворачивает Mini App
    if (v('8.0')) tg.lockOrientation();         // портрет, как на телефоне
    // Случайный свайп вниз или крестик не закрывают игру молча: Telegram переспросит.
    if (v('6.2')) tg.enableClosingConfirmation();
  } catch (e) { console.warn('[NL2Telegram]', e); }
})();
