/**
 * TerrariumSampler — глобальный базовый DEM (docs/DATA-PIPELINE.md, слой 1).
 * AWS Open Data «Terrain Tiles» (Mapzen Joerd), Terrarium PNG, зумы 0–15:
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 * Декодирование: h = R·256 + G + B/256 − 32768.
 * Покрытие 85°S–85°N: SRTM + GLO-90 + ArcticDEM + … — решает проблему >60°N.
 *
 * PNG декодируется через createImageBitmap + OffscreenCanvas (работает
 * в worker, Chrome и Safari 15+).
 */

import type { LatLon } from './geo';

export const TERRARIUM_BASE_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

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
export function lonLatToTile(pos: LatLon, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const lat = Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, pos.lat));
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((pos.lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

/** Дробная позиция пикселя внутри тайла: [0..256) */
export function lonLatToPixel(pos: LatLon, zoom: number): { px: number; py: number } {
  const n = 2 ** zoom;
  const lat = Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, pos.lat));
  const latRad = (lat * Math.PI) / 180;
  const px = ((pos.lon + 180) / 360) * n * TILE_PX;
  const py =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    n *
    TILE_PX;
  return { px: px % TILE_PX, py: py % TILE_PX };
}

/** Декодирование Terrarium RGB → высота, метры */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
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
  private dbCache: typeof import('./db') | null | undefined;

  constructor(options: TerrariumOptions = {}) {
    this.baseUrl = (options.baseUrl ?? TERRARIUM_BASE_URL).replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  }

  /** Ленивая загрузка db.ts (в тестах и приватном режиме IndexedDB может не быть) */
  private async db() {
    if (this.dbCache === undefined) {
      try {
        this.dbCache = globalThis.indexedDB ? await import('./db') : null;
      } catch {
        this.dbCache = null;
      }
    }
    return this.dbCache;
  }

  private ensureCanvas(): OffscreenCanvasRenderingContext2D {
    if (!this.ctx) {
      this.canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('OffscreenCanvas 2d недоступен');
      this.ctx = ctx;
    }
    return this.ctx;
  }

  async loadTile(z: number, x: number, y: number): Promise<Float32Array | null> {
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
            const tile = await this.decodePng(offline);
            this.tiles.set(key, tile);
            return tile;
          }
        }

        // 2. Сеть (через SW cache-first, если он зарегистрирован)
        const res = await this.fetchFn(`${this.baseUrl}/${z}/${x}/${y}.png`);
        let tile: Float32Array | null = null;
        if (res.ok) {
          const raw = new Uint8Array(await res.arrayBuffer());
          tile = await this.decodePng(raw);
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
        this.tiles.set(key, tile);
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

  /** PNG-байты → сетка высот 256×256 */
  private async decodePng(bytes: Uint8Array): Promise<Float32Array> {
    const blob = new Blob([bytes as BlobPart], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const ctx = this.ensureCanvas();
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const img = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
    const tile = new Float32Array(TILE_PX * TILE_PX);
    for (let i = 0; i < tile.length; i++) {
      tile[i] = decodeTerrarium(img[i * 4], img[i * 4 + 1], img[i * 4 + 2]);
    }
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
    const tile = this.tiles.get(
      `${zoom}/${Math.floor(x / TILE_PX)}/${Math.floor(y / TILE_PX)}`,
    );
    if (tile === undefined || tile === null) return NaN;
    return tile[(y % TILE_PX) * TILE_PX + (x % TILE_PX)];
  }

  /**
   * Синхронная выборка высоты (после prefetch).
   * Билинейная интерполяция; NaN — тайл не загружен или вне покрытия.
   */
  sample(pos: LatLon, zoom: number): number {
    const { x, y } = lonLatToTile(pos, zoom);
    const { px, py } = lonLatToPixel(pos, zoom);
    const tile = this.tiles.get(`${zoom}/${x}/${y}`);
    if (tile === undefined || tile === null) return NaN;

    const gx = x * TILE_PX + px;
    const gy = y * TILE_PX + py;
    const gx0 = Math.floor(gx);
    const gy0 = Math.floor(gy);
    const fx = gx - gx0;
    const fy = gy - gy0;

    const h00 = this.pixelAt(gx0, gy0, zoom);
    // Соседний тайл может быть не загружен — тогда ведём себя как раньше
    // и повторяем свой краевой пиксель, а не отдаём NaN на весь луч
    const at = (ax: number, ay: number): number => {
      const v = this.pixelAt(ax, ay, zoom);
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
        const [z, x, y] = key.split('/').map(Number);
        return this.loadTile(z, x, y);
      }),
    );
  }

  /** Высота точки (максимальный зум) */
  async heightAt(pos: LatLon): Promise<number> {
    const z = ZOOM_RULES[0].zoom;
    const { x, y } = lonLatToTile(pos, z);
    await this.loadTile(z, x, y);
    // Соседи для интерполяции на границах тайлов
    const { px, py } = lonLatToPixel(pos, z);
    const n = 2 ** z;
    const neighbors: Array<[number, number]> = [];
    if (px > TILE_PX - 1.5 && x + 1 < n) neighbors.push([x + 1, y]);
    if (py > TILE_PX - 1.5 && y + 1 < n) neighbors.push([x, y + 1]);
    if (neighbors.length === 2) neighbors.push([x + 1, y + 1]);
    await Promise.all(neighbors.map(([nx, ny]) => this.loadTile(z, nx, ny)));
    const h = this.sample(pos, z);
    if (Number.isNaN(h)) throw new Error('Точка вне покрытия Terrarium');
    return h;
  }
}
