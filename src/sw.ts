/**
 * Service Worker: офлайн-first для тайлов и данных (ROADMAP 4.2, DATA-PIPELINE).
 *
 * Стратегии:
 *   - Тайлы (.bin, .bin.gz, Terrarium .png) → cache-first (не меняются никогда)
 *   - index.json, peaks/*.json, regions.json → network-first (могут обновиться)
 *   - Остальное (бандл, шрифты) → stale-while-revalidate
 */

declare const self: ServiceWorkerGlobalScope;

const TILE_CACHE = 'vershiny-tiles-v1';
const DATA_CACHE = 'vershiny-data-v1';
const APP_CACHE = 'vershiny-app-v1';

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
  ev.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (ev) => {
  const url = ev.request.url;

  if (isTile(url)) {
    ev.respondWith(cacheFirst(ev.request, TILE_CACHE));
  } else if (isData(url)) {
    ev.respondWith(networkFirst(ev.request, DATA_CACHE));
  } else if (ev.request.mode === 'navigate' || url.includes('/assets/')) {
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
  const fetched = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  });
  return cached ?? fetched;
}

export {};
