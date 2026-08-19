/**
 * Обновление PWA.
 *
 * Новая версия не подменяет старую молча: браузер держит свежий worker в
 * состоянии waiting, а мы показываем плашку «Доступно обновление». Иначе
 * страница осталась бы с половиной старых чанков в памяти и новыми в кеше.
 *
 * По нажатию отправляем SKIP_WAITING. Перезагружаемся по первому же сигналу,
 * что новая версия взяла управление: `controllerchange` или активация нового
 * worker'а. Плюс страховка по таймауту — «нажал и ничего» быть не должно.
 */

import { t } from "../core/i18n";

/** Как часто спрашивать сервер о новой версии (мс) */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/**
 * Перезагрузка страницы. Обёртка ради теста: `location.reload` в jsdom
 * неконфигурируем и подменить его нельзя, а `navigation.reload` — можно.
 */
export const navigation = {
  reload: (): void => location.reload(),
};

/**
 * Свежа ли страница относительно сервера: хеш Vite в имени собственного
 * главного чанка сравнивается с чанком из index.html, который сервер отдаёт
 * сейчас. Свежая страница = актуальная версия приложения уже загружена —
 * плашка «Доступно обновление» тогда не нужна.
 *
 * Обычный fetch проходит мимо Service Worker (его стратегии ловят только
 * навигации, тайлы, данные и assets), поэтому ответ — всегда из сети;
 * офлайн (или неразборчивая оболочка) — считаем страницу старой, плашка
 * ведёт себя как раньше.
 */
export async function pageIsCurrent(): Promise<boolean> {
  const own = document
    .querySelector('script[type="module"][src]')
    ?.getAttribute("src");
  if (!own) return false;
  try {
    const res = await fetch(new URL("index.html", location.href).href, {
      cache: "no-store",
    });
    if (!res.ok) return false;
    const html = await res.text();
    const match = /src="([^"]*index-[^"]+\.js)"/.exec(html);
    if (!match) return false;
    return (
      new URL(match[1], location.href).pathname ===
      new URL(own, location.href).pathname
    );
  } catch {
    return false;
  }
}

export function setupUpdates(registration: ServiceWorkerRegistration): void {
  // Один раз перезагрузить страницу, когда новая версия взяла управление.
  // Защита от повторного срабатывания: controllerchange, активация worker'а
  // и таймаут зовут один и тот же reload
  let reloading = false;
  const reload = (): void => {
    if (reloading) return;
    reloading = true;
    navigation.reload();
  };

  // Решение о плашке откладывается до вердикта pageIsCurrent: при холодном
  // запуске страница может загрузиться уже новой версией (оболочка —
  // network-first), а новый SW в это же время встаёт в waiting — тогда
  // плашка была бы ложной. Каждая новая установка SW — новая проверка:
  // за время сессии могло выйти ещё одно обновление
  let pageCurrent: boolean | null = null;
  let checkSeq = 0;
  const refreshPageStatus = (): void => {
    pageCurrent = null;
    const seq = ++checkSeq;
    void (async () => {
      const cur = await pageIsCurrent();
      if (seq !== checkSeq) return; // началась более свежая проверка
      pageCurrent = cur;
      maybeShow();
    })();
  };
  const maybeShow = (): void => {
    if (pageCurrent !== false) return; // свежая страница — плашки нет
    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdateBanner(registration, registration.waiting, reload);
    }
  };

  // Worker мог оказаться в waiting ещё до подписки на updatefound
  if (registration.waiting && navigator.serviceWorker.controller) {
    refreshPageStatus();
  }

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      // controller есть — значит это обновление, а не первая установка
      if (
        installing.state === "installed" &&
        navigator.serviceWorker.controller
      ) {
        refreshPageStatus();
      }
    });
  });

  navigator.serviceWorker.addEventListener("controllerchange", reload);

  // Проверяем обновления при возвращении на вкладку и раз в час: у PWA
  // на телефоне вкладка живёт неделями, перезагрузки может не случиться
  const check = (): void => {
    registration.update().catch(() => {
      /* нет сети — не беда, проверим позже */
    });
  };
  setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
}

function showUpdateBanner(
  registration: ServiceWorkerRegistration,
  worker: ServiceWorker,
  reload: () => void,
): void {
  if (document.getElementById("update-banner")) return;

  const banner = document.createElement("div");
  banner.id = "update-banner";
  banner.style.cssText =
    "position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));" +
    "transform:translateX(-50%);z-index:1000;display:flex;align-items:center;gap:12px;" +
    "background:#1a1a2e;border:1px solid #415a77;border-radius:12px;" +
    "padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.5);" +
    "font:14px/1.3 system-ui,sans-serif;color:#f1faee;max-width:calc(100vw - 32px)";

  const text = document.createElement("span");
  text.textContent = t("updateAvailable");

  const apply = document.createElement("button");
  apply.textContent = t("updateApply");
  apply.style.cssText =
    "background:#4cc9f0;color:#1a1a2e;border:none;border-radius:8px;" +
    "padding:8px 14px;font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap";
  apply.onclick = () => {
    apply.disabled = true;
    // На момент клика берём свежего waiting'а: за время показа плашки
    // update() мог установить ещё более нового worker'а
    const target = registration.waiting ?? worker;
    // Как только новый worker активировался — версия сменилась. Полагаться
    // только на controllerchange нельзя: на старых Safari он приходил не
    // всегда, и кнопка выглядела «мёртвой»
    target.addEventListener("statechange", () => {
      if (target.state === "activated") reload();
    });
    // Страховка от «нажал и ничего»: если ни одно событие не пришло,
    // перезагружаемся сами — ждущий worker возьмёт управление при старте
    setTimeout(reload, 5000);
    target.postMessage({ type: "SKIP_WAITING" });
  };

  const dismiss = document.createElement("button");
  dismiss.textContent = "✕";
  dismiss.title = t("close");
  dismiss.style.cssText =
    "background:none;color:#f1faee;border:none;font-size:16px;cursor:pointer;opacity:.7";
  dismiss.onclick = () => banner.remove();

  banner.append(text, apply, dismiss);
  document.body.appendChild(banner);
}
