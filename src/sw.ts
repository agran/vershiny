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
const VERSION =
  (self as unknown as { __SW_VERSION__?: string }).__SW_VERSION__ ?? "dev";

/**
 * Чанки приложения на предзагрузку (подставляются сборкой, см.
 * vite.sw.config.ts). Ленивые чанки — настройки, карта, поиск, загрузка
 * региона — иначе попадали в кеш только после того, как человек их открыл
 * онлайн. В горах без связи кнопка настроек просто ничего не делала.
 */
const PRECACHE =
  (self as unknown as { __SW_ASSETS__?: string[] }).__SW_ASSETS__ ?? [];

/**
 * Оболочка приложения: без неё офлайн-запуск сразу после установки упирался
 * в 503 вместо страницы. Чанки предзагружались, а сам `index.html` попадал в
 * кеш только по факту успешной онлайн-навигации — то есть «поставил PWA и
 * ушёл в горы, ни разу не перезагрузив страницу» кончалось белым экраном.
 */
const SHELL = [
  "./",
  "./index.html",
  "./install.html",
  "./manifest.webmanifest",
  "./manifest-en.webmanifest",
  "./favicon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];

/**
 * Тайлы не меняются никогда — их кеш переживает обновления приложения.
 *
 * v2: пересборка пирамиды 2026-08-18 (квант 4 м на LOD 0) сменила байты по
 * тем же URL, а cache-first не знает об этом — кеш бампнут, старый снесётся
 * при активации. С тех пор клиент добавляет `?v=<версия>` к адресам тайлов,
 * и протухание по содержимому больше не застаёт ни этот кеш, ни наследие
 * v1 у уже обновлённых клиентов (такие URL под паттерн не попадают — сеть
 * напрямую, что и нужно при пересборке).
 */
const TILE_CACHE = "vershiny-tiles-v2";
/**
 * Данные (peaks, index.json, regions.json) тоже не привязаны к версии
 * оболочки: стратегия network-first обновляет их сама, как только есть сеть.
 * Раньше имя кеша содержало версию — после каждого обновления приложения
 * человек офлайн терял и список регионов, и вершины.
 */
const DATA_CACHE = "vershiny-data-v1";
const APP_CACHE = `vershiny-app-${VERSION}`;
/** Кеши, которые не удаляем при активации новой версии */
const KEEP = new Set([TILE_CACHE, DATA_CACHE, APP_CACHE]);

const TILE_PATTERNS = [
  // `?v=<версия>` у тайлов пирамиды — антикеш после пересборки (см. TILE_CACHE);
  // записи прошлых версий оседают в кеше мусором, но пересборки редки
  /\/tiles\/.*\.bin(\.gz)?(\?.*)?$/,
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

self.addEventListener("install", (ev) => {
  // Ждём в состоянии waiting: решение об обновлении принимает пользователь.
  // Кладём в кеш только оболочку; чанки приложения — позже (см. ниже):
  // иначе на первом запуске скачивание ~20 чанков соревновалось за пул
  // соединений с веером тайлов панорамы, и на слабой сети человек ждал
  // и то, и другое
  ev.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      // Каждый по отдельности: один отвалившийся файл не должен отменять всё
      await Promise.all(
        SHELL.map((path) =>
          cache.add(new URL(path, self.location.href).href).catch(() => {}),
        ),
      );
    })(),
  );
});

/**
 * Догрузка чанков приложения в кеш — по сигналу «первая панорама готова»
 * (страница шлёт PRECACHE_READY) или через минуту после активации: так
 * офлайн остаются доступны настройки/карта/поиск, но первый расчёт не
 * делит с ними соединения
 */
let precacheTimer: ReturnType<typeof setTimeout> | undefined;
let precacheDone = false;
async function precacheChunks(): Promise<void> {
  if (precacheDone) return;
  precacheDone = true;
  if (precacheTimer !== undefined) clearTimeout(precacheTimer);
  const cache = await caches.open(APP_CACHE);
  await Promise.all(
    PRECACHE.map((path) =>
      cache.add(new URL(path, self.location.href).href).catch(() => {}),
    ),
  );
}

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    (async () => {
      // Чистим кеши прошлых версий, иначе они копятся навсегда
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("vershiny-") && !KEEP.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
      // Страховка: если страница не пришлёт сигнал (упала раньше), чанки
      // всё равно докачаются — просто не в момент первого расчёта
      precacheTimer = setTimeout(() => void precacheChunks(), 60_000);
    })(),
  );
});

self.addEventListener("message", (ev) => {
  const type = (ev.data as { type?: string } | undefined)?.type;
  if (type === "SKIP_WAITING") {
    void self.skipWaiting();
  } else if (type === "PRECACHE_READY") {
    void precacheChunks();
  }
});

self.addEventListener("fetch", (ev) => {
  const url = ev.request.url;

  // Кешируем только GET: остальное (если появится) ломает Cache API
  if (ev.request.method !== "GET") return;

  if (isTile(url)) {
    ev.respondWith(cacheFirst(ev.request, TILE_CACHE, ev));
  } else if (isData(url)) {
    ev.respondWith(networkFirst(ev.request, DATA_CACHE, ev));
  } else if (ev.request.mode === "navigate") {
    // Оболочка: сеть впереди, кеш — офлайн-запас. Так свежий index.html
    // с новыми хешами чанков приезжает сразу, а не через раз.
    // Запасной адрес обязателен: ссылкой делятся с координатами
    // (?lat=43.318&lon=42.458), а в кеше оболочка лежит без параметров —
    // офлайн такая ссылка упиралась в 503 вместо панорамы
    ev.respondWith(
      networkFirst(
        ev.request,
        APP_CACHE,
        ev,
        new URL("./", self.location.href).href,
      ),
    );
  } else if (url.includes("/assets/") || url.includes("/icons/")) {
    ev.respondWith(staleWhileRevalidate(ev.request, APP_CACHE, ev));
  }
});

/** Сколько ждать сеть из воркера: при «мёртвой» сети (DNS/TCP проходят, ответ
 *  не приходит) fetch без таймаута висит до TCP-таймаута ОС. Страница свои
 *  запросы уже обрывает по 8 с — воркер не должен держать соединения дольше */
const NET_TIMEOUT_MS = 8_000;

/** fetch с таймаутом: AbortController + setTimeout (AbortSignal.timeout в
 *  Safari < 16 нет), клиентский abort пробрасывается слушателем */
function fetchWithTimeout(request: Request): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);
  const clientSignal = request.signal;
  if (clientSignal) {
    if (clientSignal.aborted) controller.abort();
    else {
      clientSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }
  return fetch(request, { signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Запись в кеш живёт дольше ответа: без `waitUntil` браузер вправе остановить
 * worker сразу после `respondWith`, и `cache.put` без await не успевал —
 * кеш «недописывался» через раз, а офлайн это ровно те файлы, которых нет.
 */
function keep(ev: FetchEvent, promise: Promise<unknown>): void {
  ev.waitUntil(promise.catch(() => {}));
}

async function cacheFirst(
  request: Request,
  cacheName: string,
  ev: FetchEvent,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetchWithTimeout(request);
    if (response.ok) {
      keep(ev, cache.put(request, response.clone()));
    }
    return response;
  } catch {
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function networkFirst(
  request: Request,
  cacheName: string,
  ev: FetchEvent,
  fallbackUrl?: string,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const offline = async (): Promise<Response | undefined> =>
    (await cache.match(request)) ??
    (fallbackUrl ? await cache.match(fallbackUrl) : undefined);
  try {
    const response = await fetchWithTimeout(request);
    if (response.ok) {
      keep(ev, cache.put(request, response.clone()));
      return response;
    }
    // Сервер ответил, но плохо (битый деплой Pages, 404 на месте данных).
    // Кеш проверялся только в catch — и приложение показывало ошибку, имея
    // рядом рабочую копию regions.json или самой оболочки
    return (await offline()) ?? response;
  } catch {
    return (
      (await offline()) ??
      new Response("Offline", { status: 503, statusText: "Offline" })
    );
  }
}

async function staleWhileRevalidate(
  request: Request,
  cacheName: string,
  ev: FetchEvent,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetched = fetchWithTimeout(request).then((response) => {
    if (response.ok) {
      keep(ev, cache.put(request, response.clone()));
    }
    return response;
  });

  if (cached) {
    // Ответ уже отдан из кеша, обновление идёт в фоне. Его нужно удержать
    // через waitUntil: запрос, которого никто не ждёт, браузер вправе
    // оборвать — и обновление кеша не доезжало.
    //
    // Отказ фонового запроса раньше ловился через `cached.clone()`, но к
    // этому моменту страница тело ответа уже прочитала, и клонирование само
    // падало: консоль забивалась «Response body is already used» — по ошибке
    // на каждый ассет при каждой загрузке
    keep(ev, fetched);
    return cached;
  }

  // В кеше пусто — ждать нечего, отдаём сеть. Отказ превращаем в 503, как в
  // остальных стратегиях: необработанных отклонений в worker'е быть не должно
  return fetched.catch(
    () => new Response("Offline", { status: 503, statusText: "Offline" }),
  );
}

export {};
