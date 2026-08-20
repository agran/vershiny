/**
 * TerrariumSampler — глобальный базовый DEM (docs/DATA-PIPELINE.md, слой 1).
 * AWS Open Data «Terrain Tiles» (Mapzen Joerd), Terrarium PNG, зумы 0–15:
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 * Декодирование: h = R·256 + G + B/256 − 32768.
 * Покрытие 85°S–85°N: SRTM + GLO-90 + ArcticDEM + … — решает проблему >60°N.
 *
 * PNG декодируется через createImageBitmap + OffscreenCanvas (работает
 * в worker, Chrome и Safari 15+). На iOS < 16.4, где OffscreenCanvas нет,
 * декодируем чистым JS (src/core/png.ts).
 */

import { fetchWithTimeout } from "./fetch-timeout";
import { normalizeLon, type LatLon } from "./geo";
import { root } from "./globals";
import { decodePngToRgba } from "./png";

export const TERRARIUM_BASE_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

const TILE_PX = 256;
const MAX_LATITUDE = 85.051_128_78; // предел Web Mercator

/** Пиксель z15 на экваторе ≈ 4.8 м, но данные внутри — класса 90 м (SRTM 3″) */
export interface ZoomRule {
  /** Дистанция луча до которой применяется зум, метры */
  upToDistM: number;
  zoom: number;
}

/**
 * Выбор зума по дальности луча (аналог LOD из DATA-PIPELINE).
 * Принцип: пиксель тайла ≲ шага луча (90 м вблизи → 700 м вдали).
 * Метры/пиксель на экваторе: z12 ≈ 38, z11 ≈ 76, z10 ≈ 153, z9 ≈ 306.
 * Родное разрешение данных ~90 м — зумы выше z12 впустую качают пиксели:
 * проверено, что правило «<30 км → z15» даёт 1341 тайл (~130 МБ) на панораму.
 */
export const ZOOM_RULES: ZoomRule[] = [
  { upToDistM: 2_000, zoom: 12 },
  { upToDistM: 10_000, zoom: 11 },
  { upToDistM: 40_000, zoom: 10 },
  { upToDistM: Infinity, zoom: 9 },
];

export function zoomForDistance(distM: number): number {
  for (const rule of ZOOM_RULES) {
    if (distM < rule.upToDistM) return rule.zoom;
  }
  return ZOOM_RULES[ZOOM_RULES.length - 1].zoom;
}

/** lon/lat → индексы тайла slippy map */
export function lonLatToTile(
  pos: LatLon,
  zoom: number,
): { x: number; y: number } {
  const t = lonLatToTileAndPixel(pos, zoom);
  return { x: t.tx, y: t.ty };
}

/** Дробная позиция пикселя внутри тайла: [0..256) */
export function lonLatToPixel(
  pos: LatLon,
  zoom: number,
): { px: number; py: number } {
  const t = lonLatToTileAndPixel(pos, zoom);
  return { px: t.px, py: t.py };
}

/**
 * Тайл и дробный пиксель одной проекцией Меркатора. Раньше lonLatToTile и
 * lonLatToPixel считали normalizeLon и log(tan)+sec каждая — двойная работа
 * на каждую выборку (~4.3 млн на панораму). Выражения сохранены как были:
 * результаты совпадают побитово.
 */
export function lonLatToTileAndPixel(
  pos: LatLon,
  zoom: number,
): { tx: number; ty: number; px: number; py: number } {
  const n = 2 ** zoom;
  const lat = Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, pos.lat));
  const latRad = (lat * Math.PI) / 180;
  const wx = ((normalizeLon(pos.lon) + 180) / 360) * n;
  const wy =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    n;
  // По долготе мир замкнут — индекс заворачивается; по широте упираемся в край
  // проекции. Раньше зажимались оба, и точка за антимеридианом (луч на Врангеле
  // уходит туда сразу) получала нулевой тайл — с другого края планеты
  const tx = ((Math.floor(wx) % n) + n) % n;
  const ty = Math.min(n - 1, Math.max(0, Math.floor(wy)));
  return {
    tx,
    ty,
    px: (wx * TILE_PX) % TILE_PX,
    py: (wy * TILE_PX) % TILE_PX,
  };
}

/** Декодирование Terrarium RGB → высота, метры */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Bbox тайла Mercator [minLon, minLat, maxLon, maxLat] —
 *  для секторных границ обрыва луча (core/sector-bounds.ts) */
export function tileBbox(
  z: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const n = 2 ** z;
  const minLon = (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;
  const latOf = (ty: number): number =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  const maxLat = Math.min(MAX_LATITUDE, latOf(y));
  const minLat = Math.max(-MAX_LATITUDE, latOf(y + 1));
  return [minLon, minLat, maxLon, maxLat];
}

/** iOS < 16.4: в воркере нет OffscreenCanvas/createImageBitmap */
const HAS_NATIVE_PNG_DECODE =
  typeof OffscreenCanvas === "function" &&
  typeof createImageBitmap === "function";

/** Декодирование Terrarium-PNG чистым JS (фолбэк для старого Safari) */
function decodeTerrariumPngFallback(bytes: Uint8Array): Float32Array {
  const img = decodePngToRgba(bytes);
  if (img.width !== TILE_PX || img.height !== TILE_PX) {
    throw new Error(
      `неожиданный размер тайла Terrarium: ${img.width}×${img.height}`,
    );
  }
  const tile = new Float32Array(TILE_PX * TILE_PX);
  const rgba = img.data;
  for (let i = 0; i < tile.length; i++) {
    tile[i] = decodeTerrarium(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return tile;
}

export interface TerrariumOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class TerrariumSampler {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  /** Декодированные тайлы: 'z/x/y' → Float32Array 256×256 (null = вне покрытия) */
  private tiles = new Map<string, Float32Array | null>();
  private pending = new Map<string, Promise<Float32Array | null>>();
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  /** Офлайн-кеш (IndexedDB); undefined = ещё не инициализирован */
  private dbCache: typeof import("./db") | null | undefined;

  constructor(options: TerrariumOptions = {}) {
    this.baseUrl = (options.baseUrl ?? TERRARIUM_BASE_URL).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetchWithTimeout;
  }

  /** Ленивая загрузка db.ts (в тестах и приватном режиме IndexedDB может не быть) */
  private async db() {
    if (this.dbCache === undefined) {
      try {
        this.dbCache = root.indexedDB ? await import("./db") : null;
      } catch {
        this.dbCache = null;
      }
    }
    return this.dbCache;
  }

  private ensureCanvas(): OffscreenCanvasRenderingContext2D {
    if (!this.ctx) {
      this.canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
      const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("OffscreenCanvas 2d недоступен");
      this.ctx = ctx;
    }
    return this.ctx;
  }

  async loadTile(
    z: number,
    x: number,
    y: number,
  ): Promise<Float32Array | null> {
    const key = `${z}/${x}/${y}`;
    const cached = this.tiles.get(key);
    if (cached !== undefined) return cached;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const promise = (async () => {
      // Любой отказ — «сейчас нет», а не «пусто здесь»: возвращаем null, дыру
      // не запоминаем, запись из pending снимаем в finally. Отклонённый промис,
      // залипший в pending, ронял бы каждый следующий расчёт до перезагрузки
      try {
        const db = await this.db().catch(() => null);

        // 1. Офлайн-кеш (IndexedDB) — работает без сети
        if (db) {
          // Запрет хранилища (приватный режим) не должен ронять расчёт
          const offline = await db.getTerrariumTile(key).catch(() => undefined);
          if (offline) {
            const tile = await this.decodePng(offline, key);
            this.setTile(key, tile);
            return tile;
          }
        }

        // 2. Сеть (через SW cache-first, если он зарегистрирован)
        const res = await this.fetchFn(`${this.baseUrl}/${z}/${x}/${y}.png`);
        let tile: Float32Array | null = null;
        if (res.ok) {
          const raw = new Uint8Array(await res.arrayBuffer());
          tile = await this.decodePng(raw, key);
          // Сохраняем в офлайн-кеш для следующего запуска
          if (db) db.saveTerrariumTile(key, raw).catch(() => {});
        } else if (res.status === 404) {
          tile = null; // вне покрытия (океан южнее/севернее 85°)
        } else {
          // Офлайн Service Worker отвечает 503 на всё, чего нет в кеше. Раньше
          // это летело исключением через весь worker, и вместо панорамы человек
          // видел «Ошибка: HTTP 503» — при том что рельеф лежал в хранилище
          return null;
        }
        this.setTile(key, tile);
        return tile;
      } catch {
        return null;
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, promise);
    return promise;
  }

  /**
   * Скачать тайл в офлайн-хранилище, не декодируя PNG.
   *
   * Отдельно от `loadTile` по двум причинам. Во-первых, честный ответ:
   * `loadTile` любой отказ превращает в `null` (это верно для расчёта
   * панорамы — «сейчас нет данных»), и загрузка региона считала успехом
   * ровно всё, включая 503 от офлайнового Service Worker'а. Регион при этом
   * помечался скачанным, а в горах оказывался пустым. Во-вторых, скорость:
   * при массовой загрузке декодировать каждый тайл через ImageBitmap незачем,
   * в хранилище всё равно ложатся исходные байты.
   *
   * @returns `saved` — байты в хранилище; `missing` — законная дыра покрытия
   *   (океан, полярная шапка); `failed` — отказ, тайла на устройстве нет
   */
  async saveTileOffline(
    z: number,
    x: number,
    y: number,
  ): Promise<"saved" | "missing" | "failed"> {
    const key = `${z}/${x}/${y}`;
    try {
      const db = await this.db();
      if (db && (await db.getTerrariumTile(key))) return "saved"; // уже лежит
      const res = await this.fetchFn(`${this.baseUrl}/${z}/${x}/${y}.png`);
      if (res.status === 404) return "missing";
      if (!res.ok) return "failed";
      if (!db) return "failed"; // скачали, но положить некуда
      await db.saveTerrariumTile(key, new Uint8Array(await res.arrayBuffer()));
      return "saved";
    } catch {
      return "failed";
    }
  }

  /** PNG-байты → сетка высот 256×256; key — 'z/x/y' для карты максимумов */
  private async decodePng(
    bytes: Uint8Array,
    key: string,
  ): Promise<Float32Array> {
    // Современные браузеры идут прежним путём; фолбэк включается только там,
    // где OffscreenCanvas нет (iOS < 16.4) — свежим айфонам ничего не меняет
    let tile: Float32Array;
    if (!HAS_NATIVE_PNG_DECODE) {
      tile = decodeTerrariumPngFallback(bytes);
    } else {
      const blob = new Blob([bytes as BlobPart], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      const ctx = this.ensureCanvas();
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const img = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
      tile = new Float32Array(TILE_PX * TILE_PX);
      for (let i = 0; i < tile.length; i++) {
        tile[i] = decodeTerrarium(img[i * 4], img[i * 4 + 1], img[i * 4 + 2]);
      }
    }
    let max = -Infinity;
    for (let i = 0; i < tile.length; i++) {
      if (tile[i] > max) max = tile[i];
    }
    if (Number.isFinite(max)) {
      this.tileMaxMap.set(key, max);
      if (max > this.maxDecodedHeight) this.maxDecodedHeight = max;
    }
    return tile;
  }

  /** Максимум высоты по загруженным тайлам — для обрыва луча (№4) */
  private maxDecodedHeight = -Infinity;
  /** Максимумы высот декодированных тайлов: 'z/x/y' → м (для секторных границ) */
  private tileMaxMap = new Map<string, number>();

  /** Максимумы высот декодированных тайлов — читается DemSource для секторных границ */
  get loadedTileMaxes(): ReadonlyMap<string, number> {
    return this.tileMaxMap;
  }

  /** Верхняя граница высоты по загруженным тайлам — для обрыва луча (№4) */
  get loadedMaxHeight(): number {
    return this.maxDecodedHeight;
  }

  // Кеш последнего запрошенного тайла: четыре чтения билинейной
  // интерполяции и десятки шагов луча подряд попадают в один тайл, а строка
  // ключа и lookup в Map строились на каждый читаемый пиксель
  private lastPixZ = -1;
  private lastPixX = -1;
  private lastPixY = -1;
  private lastPixTile: Float32Array | null = null;

  /** Запись тайла с инвалидацией кеша последнего (null мог обновиться данными) */
  private setTile(key: string, tile: Float32Array | null): void {
    this.tiles.set(key, tile);
    this.lastPixZ = -1;
  }

  /** Тайл по индексам (null — не загружен или вне покрытия), с кешем последнего */
  private tileAt(zoom: number, tx: number, ty: number): Float32Array | null {
    if (
      zoom === this.lastPixZ &&
      tx === this.lastPixX &&
      ty === this.lastPixY
    ) {
      return this.lastPixTile;
    }
    const tile = this.tiles.get(`${zoom}/${tx}/${ty}`) ?? null;
    this.lastPixZ = zoom;
    this.lastPixX = tx;
    this.lastPixY = ty;
    this.lastPixTile = tile;
    return tile;
  }

  /**
   * Значение пикселя по глобальным координатам зума (не внутри одного тайла).
   *
   * Нужен именно глобальный доступ: интерполяция на стыке тайлов берёт
   * соседей из соседнего тайла. Раньше индексы зажимались внутрь своего
   * тайла, и на каждом стыке дублировался краевой пиксель — шов шириной до
   * ячейки (38–150 м в зависимости от зума). При этом `heightAt` соседей
   * честно подгружал, а `sample` их не использовал.
   */
  private pixelAt(gx: number, gy: number, zoom: number): number {
    const n = 2 ** zoom;
    const world = n * TILE_PX;
    // По долготе мир замкнут, по широте — упираемся в край проекции
    let x = gx % world;
    if (x < 0) x += world;
    const y = Math.min(world - 1, Math.max(0, gy));
    const tile = this.tileAt(
      zoom,
      Math.floor(x / TILE_PX),
      Math.floor(y / TILE_PX),
    );
    if (tile === null) return NaN;
    return tile[(y % TILE_PX) * TILE_PX + (x % TILE_PX)];
  }

  /**
   * Синхронная выборка высоты (после prefetch).
   * Билинейная интерполяция; NaN — тайл не загружен или вне покрытия.
   * zoomHint — зум по дальности из таблицы марша (тождествен zoomForDistance).
   */
  sample(pos: LatLon, zoom: number, zoomHint?: number): number {
    const z = zoomHint ?? zoom;
    const t = lonLatToTileAndPixel(pos, z);
    const tile = this.tileAt(z, t.tx, t.ty);
    if (tile === null) return NaN;

    const gx = t.tx * TILE_PX + t.px;
    const gy = t.ty * TILE_PX + t.py;
    const gx0 = Math.floor(gx);
    const gy0 = Math.floor(gy);
    const fx = gx - gx0;
    const fy = gy - gy0;

    const h00 = this.pixelAt(gx0, gy0, z);
    // Соседний тайл может быть не загружен — тогда ведём себя как раньше
    // и повторяем свой краевой пиксель, а не отдаём NaN на весь луч
    const at = (ax: number, ay: number): number => {
      const v = this.pixelAt(ax, ay, z);
      return Number.isNaN(v) ? h00 : v;
    };
    const h10 = at(gx0 + 1, gy0);
    const h01 = at(gx0, gy0 + 1);
    const h11 = at(gx0 + 1, gy0 + 1);
    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return top + (bottom - top) * fy;
  }

  /** Предзагрузка тайлов вдоль луча (перед ray-marching) */
  async prefetchAlongRay(
    origin: LatLon,
    azRad: number,
    maxDistM: number,
    stepM: number,
    destinationFn: (o: LatLon, az: number, d: number) => LatLon,
  ): Promise<void> {
    const keys = new Set<string>();
    for (let d = 0; d <= maxDistM; d += stepM) {
      const p = destinationFn(origin, azRad, d);
      const z = zoomForDistance(d);
      const { x, y } = lonLatToTile(p, z);
      keys.add(`${z}/${x}/${y}`);
    }
    await Promise.all(
      [...keys].map((key) => {
        const [z, x, y] = key.split("/").map(Number);
        return this.loadTile(z, x, y);
      }),
    );
  }

  /**
   * Окрестность 3×3 тайлов вокруг точки на каждом ближнем зуме.
   *
   * Веер лучей ближнюю зону не покрывает: на первых километрах все 3600 лучей
   * лежат в одном-двух тайлах, а предзагрузка идёт по точкам через 8 км с
   * шагом 5° — то есть ровно один тайл на зум. Замер по четырём точкам:
   * до 65% выборок ближе 2 км приходились на незагруженный тайл. Дырой в
   * панораме это не становилось только потому, что рядом лежит глобальная
   * пирамида, — но передний план молча считался по 217 м вместо 90 м.
   *
   * Восемь соседей на зум — это единицы мегабайт и единственный способ
   * закрыть зону, где разница в разрешении как раз и видна.
   */
  async prefetchAround(pos: LatLon, zoom: number): Promise<void> {
    const n = 2 ** zoom;
    const { x, y } = lonLatToTile(pos, zoom);
    const tasks: Promise<unknown>[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      const ty = y + dy;
      if (ty < 0 || ty >= n) continue; // по широте мир не замкнут
      for (let dx = -1; dx <= 1; dx++) {
        tasks.push(this.loadTile(zoom, (((x + dx) % n) + n) % n, ty));
      }
    }
    await Promise.all(tasks);
  }

  /** Высота точки (максимальный зум) */
  async heightAt(pos: LatLon): Promise<number> {
    const z = ZOOM_RULES[0].zoom;
    const { x, y } = lonLatToTile(pos, z);
    await this.loadTile(z, x, y);
    // Соседи для интерполяции на границах тайлов. По долготе мир замкнут:
    // правый сосед крайнего тайла — тайл 0 (как в prefetchAround), иначе
    // на шве ±180° интерполяция молча откатывалась на краевой пиксель
    const { px, py } = lonLatToPixel(pos, z);
    const n = 2 ** z;
    const nx = (x + 1) % n;
    const neighbors: Array<[number, number]> = [];
    if (px > TILE_PX - 1.5) neighbors.push([nx, y]);
    if (py > TILE_PX - 1.5 && y + 1 < n) neighbors.push([x, y + 1]);
    if (neighbors.length === 2) neighbors.push([nx, y + 1]);
    await Promise.all(neighbors.map(([nx, ny]) => this.loadTile(z, nx, ny)));
    const h = this.sample(pos, z);
    if (Number.isNaN(h)) throw new Error("Точка вне покрытия Terrarium");
    return h;
  }
}
