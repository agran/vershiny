/**
 * Service Worker: офлайн-first для тайлов и данных (ROADMAP 4.2, DATA-PIPELINE).
 *
 * Стратегии:
 *   - Тайлы (.bin, .bin.gz, Terrarium .png) → cache-first (не меняются никогда)
 *   - index.json, peaks/*.json, regions.json → network-first (могут обновиться)
 *   - Бандл и оболочка → stale-while-revalidate
 *
 * Обновление приложения: новый worker НЕ вытесняет старый молча — он ждёт,
 * страница показывает «Доступно обновление», и только по команде SKIP_WAITING
 * происходит смена версии с перезагрузкой. Иначе пользователь остался бы с
 * половиной старых чанков в памяти и половиной новых в кеше.
 */

declare const self: ServiceWorkerGlobalScope;

/**
 * Версия оболочки. Меняется при сборке (см. vite.sw.config.ts): в файл
 * подставляется хеш содержимого, иначе браузер не увидит разницы в sw.js
 * и обновление никогда не приедет.
 */
const VERSION = (self as unknown as { __SW_VERSION__?: string }).__SW_VERSION__ ?? 'dev';

/**
 * Чанки приложения на предзагрузку (подставляются сборкой, см.
 * vite.sw.config.ts). Ленивые чанки — настройки, карта, поиск, загрузка
 * региона — иначе попадали в кеш только после того, как человек их открыл
 * онлайн. В горах без связи кнопка настроек просто ничего не делала.
 */
const PRECACHE = (self as unknown as { __SW_ASSETS__?: string[] }).__SW_ASSETS__ ?? [];

/** Тайлы не меняются никогда — их кеш переживает обновления приложения */
const TILE_CACHE = 'vershiny-tiles-v1';
/**
 * Данные (peaks, index.json, regions.json) тоже не привязаны к версии
 * оболочки: стратегия network-first обновляет их сама, как только есть сеть.
 * Раньше имя кеша содержало версию — после каждого обновления приложения
 * человек офлайн терял и список регионов, и вершины.
 */
const DATA_CACHE = 'vershiny-data-v1';
const APP_CACHE = `vershiny-app-${VERSION}`;
/** Кеши, которые не удаляем при активации новой версии */
const KEEP = new Set([TILE_CACHE, DATA_CACHE, APP_CACHE]);

const TILE_PATTERNS = [
  /\/tiles\/.*\.bin(\.gz)?$/,
  /elevation-tiles-prod.*\.png$/,
];

const DATA_PATTERNS = [
  /\/index\.json$/,
  /\/peaks\/.*\.json$/,
  /\/regions\.json$/,
];

function isTile(url: string): boolean {
  return TILE_PATTERNS.some((re) => re.test(url));
}

function isData(url: string): boolean {
  return DATA_PATTERNS.some((re) => re.test(url));
}

self.addEventListener('install', (ev) => {
  // Ждём в состоянии waiting: решение об обновлении принимает пользователь.
  // Но чанки складываем в кеш сразу — иначе офлайн доступно только то,
  // что успели открыть при живой сети
  ev.waitUntil(
    (async () => {
      if (PRECACHE.length === 0) return;
      const cache = await caches.open(APP_CACHE);
      // Каждый по отдельности: один отвалившийся файл не должен отменять всё
      await Promise.all(
        PRECACHE.map((path) =>
          cache.add(new URL(path, self.location.href).href).catch(() => {}),
        ),
      );
    })(),
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    (async () => {
      // Чистим кеши прошлых версий, иначе они копятся навсегда
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('vershiny-') && !KEEP.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (ev) => {
  if ((ev.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('fetch', (ev) => {
  const url = ev.request.url;

  // Кешируем только GET: остальное (если появится) ломает Cache API
  if (ev.request.method !== 'GET') return;

  if (isTile(url)) {
    ev.respondWith(cacheFirst(ev.request, TILE_CACHE));
  } else if (isData(url)) {
    ev.respondWith(networkFirst(ev.request, DATA_CACHE));
  } else if (ev.request.mode === 'navigate') {
    // Оболочка: сеть впереди, кеш — офлайн-запас. Так свежий index.html
    // с новыми хешами чанков приезжает сразу, а не через раз
    ev.respondWith(networkFirst(ev.request, APP_CACHE));
  } else if (url.includes('/assets/') || url.includes('/icons/')) {
    ev.respondWith(staleWhileRevalidate(ev.request, APP_CACHE));
  }
});

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(
  request: Request,
  cacheName: string,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  // Фоновое обновление не должно ронять ответ: офлайн оно отклоняется на
  // каждом ассете, и без catch это россыпь необработанных отклонений в worker'е
  const fetched = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch((err) => {
      if (cached) return cached.clone();
      throw err;
    });
  return cached ?? fetched;
}

export {};
