/**
 * DEM-сэмплер: чтение прекомпилированных int16-тайлов 256×256.
 * Формат — см. docs/DATA-PIPELINE.md:
 *   /tiles/{region}/{lod}/{x}/{y}.bin     — int16 LE, без заголовка
 *   /tiles/global/{lod}/{x}/{y}.bin.gz    — то же + дельта по строкам и gzip
 *   .../index.json                        — bbox, размеры ячеек, список LOD
 *
 * Глобальная пирамида (tools/glo90-to-tiles) разреженная: тайла может не быть
 * (море, равнина, не попал в бюджет) — тогда берём следующий, более грубый LOD,
 * а если и там пусто, вызывающий уходит на Terrarium (dem-source.ts).
 *
 * LOD-выборка по расстоянию от наблюдателя: чем дальше луч, тем грубее ячейка
 * (детальнее ≠ лучше — угловой размер дальних хребтов мал, а трафик реален).
 */

import { gunzipSync } from "fflate";
import { demStorePrefix } from "./dem-config";
import type { LatLon } from "./geo";
import { distanceM } from "./geo";
import { root } from "./globals";

export const TILE_SIZE = 256;
/** Метры в одном градусе широты (для перевода размера ячейки в метры) */
const METERS_PER_DEG_LAT = 111_320;
/** Ячейка не должна быть мельче, чем ~1/150 дальности луча (ALGORITHMS.md) */
const RES_PER_DIST = 1 / 150;

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
  /** Шаг квантования высоты в метрах (значения в файле умножаются на него) */
  quantM?: number;
  /** base64-битсет существующих тайлов (ty·tilesX + tx); без него — пробуем все */
  coverage?: string;
  /** Средний вес тайла в байтах — для честной оценки офлайн-загрузки */
  avgTileBytes?: number;
}

export interface DemIndex {
  /** Границы региона: [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  lods: DemLod[];
  /** Сжатие тайлов: 'gzip' — распаковываем через DecompressionStream */
  encoding?: "gzip";
  /** Фильтр перед сжатием: 'delta-x' — дельта вдоль строк */
  filter?: "delta-x";
  /** Расширение файла тайла (по умолчанию '.bin') */
  tileExt?: string;
}

/** base64 → байты (atob есть в окне, воркере и Node 18+) */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** iOS < 16.4: `DecompressionStream` в воркере нет — тогда fflate */
const HAS_DECOMPRESSION_STREAM = typeof DecompressionStream === "function";

/** Распаковка gzip: нативный потоковый API, на старом Safari — fflate */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (HAS_DECOMPRESSION_STREAM) {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return gunzipSync(bytes);
}

export interface DemSamplerOptions {
  /** Базовый URL тайлов, напр. 'tiles/elbrus' */
  baseUrl: string;
  /** Переопределение загрузки (для тестов/офлайн-кеша) */
  fetchFn?: typeof fetch;
}

/**
 * Сэмплер рельефа региона. Тайлы подгружаются лениво и кешируются в памяти;
 * постоянное хранение — IndexedDB (см. `db.ts`): сжатые байты как есть.
 */
/**
 * Версия содержимого пирамиды: меняется при любой пересборке, влияющей на
 * байты тайлов (квант, покрытие, сетка). Поля схемы (cellDeg, tilesX/Y) +
 * квант + средний вес — детерминированный слепок без лишнего поля в формате.
 *
 * Нужна для инвалидации офлайн-тайлов: они хранятся сжатыми, а квант
 * подставляется при распаковке — тайл от прошлой пересборки с новым
 * index.json молча дал бы неверные высоты (квант 2 м → 4 м = высоты ×2).
 */
export function indexVersion(index: DemIndex): string {
  return index.lods
    .map(
      (l) =>
        `${l.cellDeg}:${l.quantM ?? 1}:${l.avgTileBytes ?? 0}:${l.tilesX}x${l.tilesY}`,
    )
    .join("|");
}

export class DemSampler {
  private index: DemIndex | null = null;
  /** Кеш тайлов: 'lod/x/y' → Int16Array (null = тайл отсутствует/море) */
  private tiles = new Map<string, Int16Array | null>();
  private pending = new Map<string, Promise<Int16Array | null>>();
  /** Битсеты покрытия по LOD (если index их содержит) */
  private coverage: (Uint8Array | null)[] = [];
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  /** Префикс ключа в офлайн-хранилище: у каждого источника своя сетка тайлов */
  private readonly storePrefix: string;
  /** Офлайн-хранилище (IndexedDB); null — недоступно (тесты, приватный режим) */
  private dbCache: typeof import("./db") | null | undefined;

  /** Порог переключения LOD, метры (DATA-PIPELINE: 30 км) */
  lodSwitchM = 30_000;

  constructor(options: DemSamplerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch.bind(root);
    this.storePrefix = demStorePrefix(this.baseUrl);
  }

  /** Ключ тайла в офлайн-хранилище (см. demStorePrefix) */
  storeKey(key: string): string {
    return `${this.storePrefix}${key}`;
  }

  /** Версия содержимого пирамиды (после loadIndex) — свежесть офлайн-регионов */
  get version(): string | undefined {
    return this.index ? indexVersion(this.index) : undefined;
  }

  /**
   * URL тайла с версией пирамиды: пересборка меняет байты по тем же адресам,
   * а старый Service Worker держит их в cache-first без срока годности —
   * без суффикса повторное скачивание после чистки втащило бы протухшие
   * байты обратно. Pages query игнорирует, старый SW такой URL под паттерн
   * тайла (якорь `$`) не подхватывает и отдаёт сеть напрямую
   */
  private tileUrl(key: string): string {
    const ext = this.index?.tileExt ?? ".bin";
    const v = this.version;
    return `${this.baseUrl}/${key}${ext}${v ? `?v=${encodeURIComponent(v)}` : ""}`;
  }

  /** Ленивая загрузка db.ts (в тестах IndexedDB может не быть) */
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

  async loadIndex(): Promise<DemIndex> {
    if (this.index) return this.index;
    const db = await this.db();
    try {
      const res = await this.fetchFn(`${this.baseUrl}/index.json`);
      if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
      this.index = (await res.json()) as DemIndex;
      if (db) {
        // Пересборка пирамиды = другие байты тайлов: старые из офлайн-
        // хранилища несовместимы (см. indexVersion) — вычищаем источник.
        // Порядок важен: кешированный прошлый индекс читаем ДО его
        // перезаписи — по нему отличаем «первая версия фичи, пересборки
        // не было» (тайлы совместимы, чистить нельзя) от настоящей смены
        // содержимого
        const current = indexVersion(this.index);
        const stored = await db
          .getDemVersion(this.storePrefix)
          .catch(() => undefined);
        if (stored !== current) {
          const previous = stored
            ? undefined
            : ((await db.getDemIndex(this.baseUrl).catch(() => undefined)) as
                DemIndex | undefined);
          const compatibleLegacy =
            !stored && previous && indexVersion(previous) === current;
          if (!compatibleLegacy) {
            const removed = await db
              .deleteDemTilesByPrefix(this.storePrefix)
              .catch(() => 0);
            if (removed > 0) {
              await db.saveDemPurged(this.storePrefix, current).catch(() => {});
            }
          }
          await db.saveDemVersion(this.storePrefix, current).catch(() => {});
        }
        void db.saveDemIndex(this.baseUrl, this.index).catch(() => {});
      }
    } catch (err) {
      // Офлайн: индекс из прошлой загрузки — без него не стартует даже то,
      // что уже лежит в хранилище
      const cached = db ? await db.getDemIndex(this.baseUrl) : undefined;
      if (!cached) throw err;
      this.index = cached as DemIndex;
      // Наследие без версии: тайлы согласованы с этим (старым) индексом,
      // чистить их офлайн нельзя — просто фиксируем базовую версию; реальная
      // сверка и чистка случатся при первом онлайне
      if (db) {
        const v = indexVersion(this.index);
        const stored = await db
          .getDemVersion(this.storePrefix)
          .catch(() => undefined);
        if (!stored)
          await db.saveDemVersion(this.storePrefix, v).catch(() => {});
      }
    }
    this.coverage = this.index.lods.map((lod) =>
      lod.coverage ? base64ToBytes(lod.coverage) : null,
    );
    return this.index;
  }

  /** Приблизительное разрешение LOD в метрах на широте наблюдателя */
  lodResolutionM(lodIndex: number, atLat?: number): number {
    if (!this.index) throw new Error("loadIndex() не вызван");
    const lod = this.index.lods[lodIndex];
    // Ячейка квадратная в градусах; по широте метры постоянны,
    // по долготе сжимаются cos φ — берём худший случай для выбора LOD
    void atLat;
    return lod.cellDeg * METERS_PER_DEG_LAT;
  }

  /**
   * Номер LOD для луча на дистанции distM: 0 — самый детальный.
   * Нужная детализация ≈ дальность/150 (дальний хребет и так мелок на экране);
   * берём LOD, ближайший к ней по логарифму — так правило не зависит от того,
   * какая лестница уровней в index.json.
   */
  lodForDistance(distM: number): number {
    if (!this.index) throw new Error("loadIndex() не вызван");
    const targetM = Math.max(90, distM * RES_PER_DIST);
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < this.index.lods.length; i++) {
      const diff = Math.abs(Math.log(this.lodResolutionM(i) / targetM));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }

  /** Есть ли тайл по карте покрытия (нет карты — считаем, что может быть) */
  hasTile(lodIndex: number, tx: number, ty: number): boolean {
    const lod = this.index?.lods[lodIndex];
    if (!lod) return false;
    if (tx < 0 || ty < 0 || tx >= lod.tilesX || ty >= lod.tilesY) return false;
    const bits = this.coverage[lodIndex];
    if (!bits) return true;
    const bit = ty * lod.tilesX + tx;
    return (bits[bit >> 3] & (1 << (bit & 7))) !== 0;
  }

  /**
   * Высота точки (метры) с билинейной интерполяцией.
   * NaN — вне покрытия. Требует, чтобы тайлы были предзагружены
   * (prefetchAlongRay / prefetchPoint); синхронная — для использования в worker.
   * Если на запрошенном LOD данных нет (разреженная пирамида) — пробуем грубее.
   */
  sample(pos: LatLon, lodIndex: number): number {
    if (!this.index) throw new Error("loadIndex() не вызван");
    for (let lod = lodIndex; lod < this.index.lods.length; lod++) {
      const h = this.sampleLod(pos, lod);
      if (!Number.isNaN(h)) return h;
    }
    return NaN;
  }

  private sampleLod(pos: LatLon, lodIndex: number): number {
    const lod = this.index!.lods[lodIndex];
    const minLon = this.index!.bbox[0];

    const gx = (pos.lon - minLon) / lod.cellDeg;
    const gy = (this.index!.bbox[3] - pos.lat) / lod.cellDeg; // сетка с севера на юг
    if (
      gx < 0 ||
      gy < 0 ||
      gx >= lod.gridWidth - 1 ||
      gy >= lod.gridHeight - 1
    ) {
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
    if (h00 === null || h10 === null || h01 === null || h11 === null)
      return NaN;

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
  async loadTile(
    lodIndex: number,
    tx: number,
    ty: number,
  ): Promise<Int16Array | null> {
    const key = `${lodIndex}/${tx}/${ty}`;
    const cached = this.tiles.get(key);
    if (cached !== undefined) return cached;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    // Карта покрытия известна — не тратим запрос на заведомо пустой тайл
    if (this.index && !this.hasTile(lodIndex, tx, ty)) {
      this.tiles.set(key, null);
      return null;
    }

    const promise = (async () => {
      // Любой отказ (обрыв сети, CORS, запрет IndexedDB, битый тайл) — это
      // «сейчас нет», а не «пусто здесь»: возвращаем null, дыру не запоминаем
      // и обязательно убираем запись из pending. Иначе отклонённый промис
      // оставался в карте навсегда и ронял каждый следующий расчёт панорамы
      // до перезагрузки страницы — даже когда сеть уже вернулась
      try {
        // Офлайн-хранилище: тайлы не меняются, поэтому кеш безусловно свежий
        const db = await this.db().catch(() => null);
        if (db) {
          const stored = await db
            .getDemTile(this.storeKey(key))
            .catch(() => undefined);
          if (stored) {
            const tile = await this.decodeTile(
              stored.buffer.slice(
                stored.byteOffset,
                stored.byteOffset + stored.byteLength,
              ) as ArrayBuffer,
              lodIndex,
            );
            this.tiles.set(key, tile);
            return tile;
          }
        }

        const res = await this.fetchFn(this.tileUrl(key));
        let tile: Int16Array | null = null;
        if (res.ok) {
          tile = await this.decodeTile(await res.arrayBuffer(), lodIndex);
        } else if (res.status === 404) {
          tile = null; // вне покрытия (море, край региона, не попал в бюджет)
        } else {
          // Временный отказ: офлайн Service Worker отдаёт 503 на всё, чего нет
          // в кеше. Это не повод ронять весь расчёт — рисуем по тому, что есть,
          // и не запоминаем «дыру»: с возвратом сети тайл догрузится
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

  /** Ключи всех существующих тайлов, попадающих в bbox (все LOD) */
  tileKeysInBBox(bbox: [number, number, number, number]): string[] {
    if (!this.index) throw new Error("loadIndex() не вызван");
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const keys: string[] = [];
    for (let lodIndex = 0; lodIndex < this.index.lods.length; lodIndex++) {
      const lod = this.index.lods[lodIndex];
      const tileDeg = lod.cellDeg * TILE_SIZE;
      // bbox через антимеридиан (Врангель: 177.5…−177.5) — два диапазона
      const lonRanges: [number, number][] =
        minLon <= maxLon
          ? [[minLon, maxLon]]
          : [
              [minLon, 180],
              [-180, maxLon],
            ];
      const y0 = Math.floor(
        (this.index.bbox[3] - Math.min(maxLat, 90)) / tileDeg,
      );
      const y1 = Math.ceil(
        (this.index.bbox[3] - Math.max(minLat, -90)) / tileDeg,
      );
      for (const [lon0, lon1] of lonRanges) {
        const x0 = Math.floor((lon0 - this.index.bbox[0]) / tileDeg);
        const x1 = Math.ceil((lon1 - this.index.bbox[0]) / tileDeg);
        for (let tx = x0; tx < x1; tx++) {
          for (let ty = y0; ty < y1; ty++) {
            if (this.hasTile(lodIndex, tx, ty))
              keys.push(`${lodIndex}/${tx}/${ty}`);
          }
        }
      }
    }
    return keys;
  }

  /** Оценка веса тайлов bbox в байтах (по среднему весу тайла из индекса) */
  bboxDownloadBytes(
    bbox: [number, number, number, number],
    filter?: (key: string) => boolean,
  ): number {
    if (!this.index) throw new Error("loadIndex() не вызван");
    let bytes = 0;
    for (const key of this.tileKeysInBBox(bbox)) {
      if (filter && !filter(key)) continue;
      const lodIndex = Number(key.split("/")[0]);
      bytes += this.index.lods[lodIndex].avgTileBytes ?? 40_000;
    }
    return bytes;
  }

  /**
   * Скачать тайлы в офлайн-хранилище (кнопка «Скачать регион»).
   * Сохраняем сжатые байты: распаковка при чтении дешевле, чем вчетверо
   * больший объём на устройстве.
   *
   * Возвращает статистику, а не только объём: сервер, отвечающий 503 на всё
   * (офлайн через Service Worker), раньше давал «успешную» загрузку нуля
   * тайлов, и регион помечался скачанным. В горах это худший вид обмана.
   */
  async downloadTiles(
    keys: string[],
    onTile: (done: number) => void,
    concurrency = 6,
  ): Promise<{ bytes: number; ok: number; failed: number }> {
    const db = await this.db();
    let done = 0;
    let bytes = 0;
    let ok = 0;
    for (let i = 0; i < keys.length; i += concurrency) {
      await Promise.all(
        keys.slice(i, i + concurrency).map(async (key) => {
          try {
            // Хранилище проверять здесь незачем: без него загрузка региона
            // отваливается раньше, на сохранении вершин (savePeaks)
            if (db && (await db.getDemTile(this.storeKey(key)))) {
              ok++; // уже скачан
              return;
            }
            const res = await this.fetchFn(this.tileUrl(key));
            if (!res.ok) return;
            const raw = new Uint8Array(await res.arrayBuffer());
            bytes += raw.byteLength;
            if (db) await db.saveDemTile(this.storeKey(key), raw);
            ok++;
          } catch {
            // Обрыв сети на одном тайле не должен ронять всю загрузку:
            // прогресс сохраняется, а недостача видна по счётчику
          } finally {
            onTile(++done);
          }
        }),
      );
    }
    return { bytes, ok, failed: keys.length - ok };
  }

  /** Распаковка тайла: gzip → дельта по строкам → квант высоты */
  private async decodeTile(
    buffer: ArrayBuffer,
    lodIndex: number,
  ): Promise<Int16Array> {
    let bytes = new Uint8Array(buffer);
    // Сигнатура gzip: сервер (или SW) мог распаковать ответ за нас
    if (
      this.index?.encoding === "gzip" &&
      bytes[0] === 0x1f &&
      bytes[1] === 0x8b
    ) {
      bytes = await gunzip(bytes);
    }
    // Int16Array требует чётного смещения — при нужде копируем
    const aligned = bytes.byteOffset % 2 === 0 ? bytes : new Uint8Array(bytes);
    const values = new Int16Array(
      aligned.buffer,
      aligned.byteOffset,
      aligned.byteLength >> 1,
    );

    if (this.index?.filter === "delta-x") {
      for (let y = 0; y < TILE_SIZE; y++) {
        const row = y * TILE_SIZE;
        let acc = 0;
        for (let x = 0; x < TILE_SIZE; x++) {
          // Накопление с переполнением int16 — так же, как кодировал Python
          acc = ((acc + values[row + x]) << 16) >> 16;
          values[row + x] = acc;
        }
      }
    }

    const quant = this.index?.lods[lodIndex]?.quantM ?? 1;
    if (quant !== 1) {
      for (let i = 0; i < values.length; i++) values[i] *= quant;
    }
    return values;
  }

  /**
   * Предзагрузка тайлов вдоль луча: из origin по азимуту azRad до maxDistM.
   * Вызывается worker'ом перед ray-marching'ом луча. Грузим выбранный LOD
   * и все более грубые — на них уходит фолбэк, если детального тайла нет.
   */
  async prefetchAlongRay(
    origin: LatLon,
    azRad: number,
    maxDistM: number,
    stepM: number,
    destinationFn: (o: LatLon, az: number, d: number) => LatLon,
  ): Promise<void> {
    if (!this.index) await this.loadIndex();
    const keys = new Set<string>();
    for (let d = 0; d <= maxDistM; d += stepM) {
      const p = destinationFn(origin, azRad, d);
      for (
        let lodIdx = this.lodForDistance(d);
        lodIdx < this.index!.lods.length;
        lodIdx++
      ) {
        const l = this.index!.lods[lodIdx];
        const gx = Math.floor(
          (p.lon - this.index!.bbox[0]) / l.cellDeg / TILE_SIZE,
        );
        const gy = Math.floor(
          (this.index!.bbox[3] - p.lat) / l.cellDeg / TILE_SIZE,
        );
        if (this.hasTile(lodIdx, gx, gy)) {
          keys.add(`${lodIdx}/${gx}/${gy}`);
        }
      }
    }
    await Promise.all(
      [...keys].map((key) => {
        const [l, x, y] = key.split("/").map(Number);
        return this.loadTile(l, x, y);
      }),
    );
  }

  /** Разрешение самого детального LOD в метрах (для выбора источника высот) */
  finestResM(): number {
    return this.index ? this.lodResolutionM(0) : Infinity;
  }

  /** Тайлы 2×2 вокруг точки на указанном LOD (для интерполяции у границы) */
  private async loadAround(pos: LatLon, lodIndex: number): Promise<void> {
    const lod = this.index!.lods[lodIndex];
    const tx = Math.floor(
      (pos.lon - this.index!.bbox[0]) / lod.cellDeg / TILE_SIZE,
    );
    const ty = Math.floor(
      (this.index!.bbox[3] - pos.lat) / lod.cellDeg / TILE_SIZE,
    );
    await Promise.all([
      this.loadTile(lodIndex, tx, ty),
      this.loadTile(lodIndex, tx + 1, ty),
      this.loadTile(lodIndex, tx, ty + 1),
      this.loadTile(lodIndex, tx + 1, ty + 1),
    ]);
  }

  /** Высота наблюдателя (детальный LOD, при его отсутствии — более грубые) */
  async observerHeight(pos: LatLon): Promise<number> {
    await this.loadIndex();
    for (let lodIndex = 0; lodIndex < this.index!.lods.length; lodIndex++) {
      await this.loadAround(pos, lodIndex);
      const h = this.sample(pos, lodIndex);
      if (!Number.isNaN(h)) return h;
    }
    throw new Error("Точка вне покрытия DEM");
  }

  /**
   * Высота наблюдателя с защитой от занижения (для ray-marching):
   * max по окрестности 3×3 ячейки. На крутом склоне билинейная
   * интерполяция занижает — соседняя ячейка выше нас.
   *
   * Возвращает именно землю: рост глаз добавляет ray-marching
   * (`observerElevationM`, 1.7 м). Раньше прибавка стояла в обоих местах,
   * и наблюдатель оказывался на 3.7 м над склоном, а индикатор высоты
   * показывал на два метра больше отметки под ногами.
   */
  async observerHeightSafe(pos: LatLon): Promise<number> {
    await this.loadIndex();
    for (let lodIndex = 0; lodIndex < this.index!.lods.length; lodIndex++) {
      const maxH = await this.maxAroundAtLod(pos, lodIndex);
      if (maxH !== null) return maxH;
    }
    throw new Error("Точка вне покрытия DEM");
  }

  /** max по окрестности 3×3 на одном LOD; null — тайлов нет */
  private async maxAroundAtLod(
    pos: LatLon,
    lodIndex: number,
  ): Promise<number | null> {
    const lod = this.index!.lods[lodIndex];
    const cellDeg = lod.cellDeg;
    const [minLon, , , maxLat] = this.index!.bbox;

    // Окрестность 3×3 ячейки вокруг точки
    const cx = Math.floor((pos.lon - minLon) / cellDeg);
    const cy = Math.floor((maxLat - pos.lat) / cellDeg);

    // Загружаем тайлы для окрестности
    const tx0 = Math.floor((cx - 1) / TILE_SIZE);
    const ty0 = Math.floor((cy - 1) / TILE_SIZE);
    const tx1 = Math.floor((cx + 1) / TILE_SIZE);
    const ty1 = Math.floor((cy + 1) / TILE_SIZE);
    const tiles: Promise<unknown>[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        tiles.push(this.loadTile(lodIndex, tx, ty));
      }
    }
    await Promise.all(tiles);

    let maxH = -Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const h = this.cell(lodIndex, cx + dx, cy + dy);
        if (h !== null && h > maxH) maxH = h;
      }
    }
    return maxH === -Infinity ? null : maxH;
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
