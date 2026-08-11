/**
 * DEM-сэмплер: чтение прекомпилированных int16-тайлов 256×256.
 * Формат — см. docs/DATA-PIPELINE.md:
 *   /tiles/{region}/{lod}/{x}/{y}.bin  — int16 LE, без заголовка
 *   /tiles/{region}/index.json         — bbox, размеры ячеек, список LOD
 *
 * LOD-выборка по расстоянию от наблюдателя:
 *   d < 30 км  — самый детальный слой (90 м)
 *   дальше     — самый грубый (250–500 м)
 */

import type { LatLon } from './geo';
import { distanceM } from './geo';

export const TILE_SIZE = 256;
/** Метры в одном градусе широты (для перевода размера ячейки в метры) */
const METERS_PER_DEG_LAT = 111_320;

export interface DemLod {
  /** Размер ячейки в градусах */
  cellDeg: number;
  /** Размер сетки региона в этом LOD: [width, height] в ячейках */
  gridWidth: number;
  gridHeight: number;
  /** Ширина региона в тайлах */
  tilesX: number;
  /** Высота региона в тайлах */
  tilesY: number;
}

export interface DemIndex {
  /** Границы региона: [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  lods: DemLod[];
}

export interface DemSamplerOptions {
  /** Базовый URL тайлов, напр. 'tiles/elbrus' */
  baseUrl: string;
  /** Переопределение загрузки (для тестов/офлайн-кеша) */
  fetchFn?: typeof fetch;
}

/**
 * Сэмплер рельефа региона. Тайлы подгружаются лениво и кешируются в памяти;
 * постоянное хранение (IndexedDB) — слой поверх, через fetchFn.
 */
export class DemSampler {
  private index: DemIndex | null = null;
  /** Кеш тайлов: 'lod/x/y' → Int16Array (null = тайл отсутствует/море) */
  private tiles = new Map<string, Int16Array | null>();
  private pending = new Map<string, Promise<Int16Array | null>>();
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  /** Порог переключения LOD, метры (DATA-PIPELINE: 30 км) */
  lodSwitchM = 30_000;

  constructor(options: DemSamplerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  }

  async loadIndex(): Promise<DemIndex> {
    if (this.index) return this.index;
    const res = await this.fetchFn(`${this.baseUrl}/index.json`);
    if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
    this.index = (await res.json()) as DemIndex;
    return this.index;
  }

  /** Приблизительное разрешение LOD в метрах на широте наблюдателя */
  lodResolutionM(lodIndex: number, atLat: number): number {
    if (!this.index) throw new Error('loadIndex() не вызван');
    const lod = this.index.lods[lodIndex];
    // Ячейка квадратная в градусах; по широте метры постоянны,
    // по долготе сжимаются cos φ — берём худший случай для выбора LOD
    void atLat;
    return lod.cellDeg * METERS_PER_DEG_LAT;
  }

  /** Номер LOD для луча на дистанции distM: 0 — самый детальный */
  lodForDistance(distM: number): number {
    if (!this.index) throw new Error('loadIndex() не вызван');
    return distM < this.lodSwitchM ? 0 : this.index.lods.length - 1;
  }

  /**
   * Высота точки (метры) с билинейной интерполяцией.
   * NaN — вне покрытия региона. Требует, чтобы тайлы были предзагружены
   * (prefetchAlongRay / prefetchPoint); синхронная — для использования в worker.
   */
  sample(pos: LatLon, lodIndex: number): number {
    if (!this.index) throw new Error('loadIndex() не вызван');
    const lod = this.index.lods[lodIndex];
    const minLon = this.index.bbox[0];

    const gx = (pos.lon - minLon) / lod.cellDeg;
    const gy = (this.index.bbox[3] - pos.lat) / lod.cellDeg; // сетка с севера на юг
    if (gx < 0 || gy < 0 || gx >= lod.gridWidth - 1 || gy >= lod.gridHeight - 1) {
      return NaN;
    }

    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;

    const h00 = this.cell(lodIndex, x0, y0);
    const h10 = this.cell(lodIndex, x0 + 1, y0);
    const h01 = this.cell(lodIndex, x0, y0 + 1);
    const h11 = this.cell(lodIndex, x0 + 1, y0 + 1);
    if (h00 === null || h10 === null || h01 === null || h11 === null) return NaN;

    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return top + (bottom - top) * fy;
  }

  private cell(lodIndex: number, gx: number, gy: number): number | null {
    const tx = Math.floor(gx / TILE_SIZE);
    const ty = Math.floor(gy / TILE_SIZE);
    const tile = this.tiles.get(`${lodIndex}/${tx}/${ty}`);
    if (tile === undefined || tile === null) return null;
    const cx = gx - tx * TILE_SIZE;
    const cy = gy - ty * TILE_SIZE;
    return tile[cy * TILE_SIZE + cx];
  }

  /** Загрузка одного тайла (с дедупликацией параллельных запросов) */
  async loadTile(lodIndex: number, tx: number, ty: number): Promise<Int16Array | null> {
    const key = `${lodIndex}/${tx}/${ty}`;
    const cached = this.tiles.get(key);
    if (cached !== undefined) return cached;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const promise = (async () => {
      const res = await this.fetchFn(`${this.baseUrl}/${lodIndex}/${tx}/${ty}.bin`);
      let tile: Int16Array | null = null;
      if (res.ok) {
        const buf = await res.arrayBuffer();
        tile = new Int16Array(buf);
      } else if (res.status === 404) {
        tile = null; // вне покрытия (море, край региона)
      } else {
        throw new Error(`tile ${key}: HTTP ${res.status}`);
      }
      this.tiles.set(key, tile);
      this.pending.delete(key);
      return tile;
    })();

    this.pending.set(key, promise);
    return promise;
  }

  /**
   * Предзагрузка тайлов вдоль луча: из origin по азимуту azRad до maxDistM.
   * Вызывается worker'ом перед ray-marching'ом луча.
   */
  async prefetchAlongRay(
    origin: LatLon,
    azRad: number,
    maxDistM: number,
    stepM: number,
    destinationFn: (o: LatLon, az: number, d: number) => LatLon,
  ): Promise<void> {
    if (!this.index) await this.loadIndex();
    const lod = this.lodForDistance(maxDistM / 2);
    const keys = new Set<string>();
    for (let d = 0; d <= maxDistM; d += stepM) {
      const p = destinationFn(origin, azRad, d);
      const lodIdx = this.lodForDistance(d);
      const l = this.index!.lods[lodIdx];
      const gx = Math.floor((p.lon - this.index!.bbox[0]) / l.cellDeg / TILE_SIZE);
      const gy = Math.floor((this.index!.bbox[3] - p.lat) / l.cellDeg / TILE_SIZE);
      if (gx >= 0 && gy >= 0 && gx < l.tilesX && gy < l.tilesY) {
        keys.add(`${lodIdx}/${gx}/${gy}`);
      }
      void lod;
    }
    await Promise.all(
      [...keys].map((key) => {
        const [l, x, y] = key.split('/').map(Number);
        return this.loadTile(l, x, y);
      }),
    );
  }

  /** Высота наблюдателя по координате (из самого детального LOD) */
  async observerHeight(pos: LatLon): Promise<number> {
    await this.loadIndex();
    const lod = this.index!.lods[0];
    const tx = Math.floor((pos.lon - this.index!.bbox[0]) / lod.cellDeg / TILE_SIZE);
    const ty = Math.floor((this.index!.bbox[3] - pos.lat) / lod.cellDeg / TILE_SIZE);
    await this.loadTile(0, tx, ty);
    // Соседние тайлы для интерполяции на границе
    await Promise.all([
      this.loadTile(0, tx + 1, ty),
      this.loadTile(0, tx, ty + 1),
      this.loadTile(0, tx + 1, ty + 1),
    ]);
    const h = this.sample(pos, 0);
    if (Number.isNaN(h)) throw new Error('Точка вне покрытия DEM');
    return h;
  }

  /** Высота над уровнем моря с учётом высоты наблюдателя над землёй */
  async groundHeightAt(pos: LatLon): Promise<number> {
    return this.observerHeight(pos);
  }
}

/** Расстояние от наблюдателя до точки — хелпер для LOD-логики */
export function distFrom(observer: LatLon, pos: LatLon): number {
  return distanceM(observer, pos);
}
