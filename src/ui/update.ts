/**
 * Обновление PWA.
 *
 * Новая версия не подменяет старую молча: браузер держит свежий worker в
 * состоянии waiting, а мы показываем плашку «Доступно обновление». Иначе
 * страница осталась бы с половиной старых чанков в памяти и новыми в кеше.
 *
 * По нажатию отправляем SKIP_WAITING и перезагружаемся на controllerchange —
 * это единственный момент, когда версия действительно меняется.
 */

import { t } from '../core/i18n';

/** Как часто спрашивать сервер о новой версии (мс) */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export function setupUpdates(registration: ServiceWorkerRegistration): void {
  // Worker мог оказаться в waiting ещё до подписки на updatefound
  if (registration.waiting && navigator.serviceWorker.controller) {
    showUpdateBanner(registration.waiting);
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // controller есть — значит это обновление, а не первая установка
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        showUpdateBanner(installing);
      }
    });
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  // Проверяем обновления при возвращении на вкладку и раз в час: у PWA
  // на телефоне вкладка живёт неделями, перезагрузки может не случиться
  const check = (): void => {
    registration.update().catch(() => {
      /* нет сети — не беда, проверим позже */
    });
  };
  setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

function showUpdateBanner(worker: ServiceWorker): void {
  if (document.getElementById('update-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText =
    'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));' +
    'transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:12px;' +
    'background:#1a1a2e;border:1px solid #415a77;border-radius:12px;' +
    'padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.5);' +
    'font:14px/1.3 system-ui,sans-serif;color:#f1faee;max-width:calc(100vw - 32px)';

  const text = document.createElement('span');
  text.textContent = t('updateAvailable');

  const apply = document.createElement('button');
  apply.textContent = t('updateApply');
  apply.style.cssText =
    'background:#4cc9f0;color:#1a1a2e;border:none;border-radius:8px;' +
    'padding:8px 14px;font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap';
  apply.onclick = () => {
    apply.disabled = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  };

  const dismiss = document.createElement('button');
  dismiss.textContent = '✕';
  dismiss.title = t('close');
  dismiss.style.cssText =
    'background:none;color:#f1faee;border:none;font-size:16px;cursor:pointer;opacity:.7';
  dismiss.onclick = () => banner.remove();

  banner.append(text, apply, dismiss);
  document.body.appendChild(banner);
}
