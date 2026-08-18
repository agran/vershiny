/**
 * Предзагрузка региона для офлайна (ROADMAP 4.2, критерии приёмки).
 *
 * Качаются три слоя, каждый под свою задачу:
 *   - вся площадь региона из глобальной пирамиды (217 м) — далёкие хребты,
 *     ~1–3 МБ сжатыми байтами;
 *   - детальный слой p1–p2 (~87 м) из vershiny-dem-hi — вне его покрытия
 *     (прочие регионы) ключей ноль, ничего не добавляет;
 *   - круг DETAIL_RADIUS_M вокруг точки из Terrarium (90 м) — ближняя зона,
 *     где разница в разрешении видна на панораме.
 *
 * Раньше качался Terrarium z9–z12 по всему bbox и хранился распакованным:
 * медианный регион — 8.6 тыс. тайлов ≈ 2.2 ГБ в IndexedDB, Гренландия ≈ 160 ГБ.
 * Такая загрузка не могла завершиться в принципе — упиралась в квоту браузера.
 */

import { TerrariumSampler } from "../core/terrarium";
import { DemSampler } from "../core/dem";
import { GLOBAL_DEM_HI_URL, GLOBAL_DEM_URL } from "../core/dem-config";
import { PEAK_VISIBILITY_RADIUS_M } from "../core/peaks";
import { bboxContains, destination, type LatLon } from "../core/geo";
import { savePeaks, markRegionDownloaded, getDemTile } from "../core/db";
import { root } from "../core/globals";
import { getLocale } from "../core/i18n";

/** Радиус детальной зоны (Terrarium 90 м) вокруг точки наблюдения */
export const DETAIL_RADIUS_M = 30_000;
/** Метров в градусе широты — для расстояния до границ региона */
const M_PER_DEG_LAT = 111_320;
/** Зумы детальной зоны: 12 ≈ 38 м/пиксель на экваторе, 11 — запас на фолбэк */
const DETAIL_ZOOMS = [12, 11];
/** Средний вес Terrarium-PNG (замер по выборке тайлов разных зумов) */
const TERRARIUM_TILE_BYTES = 60_000;

/**
 * Какая доля тайлов должна лечь на устройство, чтобы регион считался
 * скачанным. Не 100%: в покрытии Terrarium есть законные дыры (океан,
 * полярные шапки), и упираться в них — значит не дать скачать ничего.
 */
const MIN_SAVED_RATIO = 0.9;

export interface RegionInfo {
  title_ru?: string;
  title_en?: string;
  bbox: [number, number, number, number];
  priority?: number;
  group?: string;
  core_ru?: string;
  core_en?: string;
}

export interface DownloadProgress {
  /** Загружено тайлов */
  done: number;
  /** Всего тайлов */
  total: number;
  /** Текущая фаза */
  phase: "peaks" | "tiles" | "done" | "error";
  /** Текст ошибки */
  error?: string;
}

/** Точка внутри bbox (с учётом перехода через антимеридиан) */
export function inBBox(
  pos: LatLon,
  bbox: [number, number, number, number],
): boolean {
  return bboxContains(pos, bbox);
}

/**
 * Центр bbox — корректно и для перехода через антимеридиан.
 *
 * Наивная формула для Врангеля (177.5…−177.5) давала долготу 0: детальную
 * зону качали вокруг нулевого меридиана, то есть в Гвинейском заливе, а не у
 * острова. Считаем по развёрнутому диапазону и заворачиваем результат обратно.
 */
export function bboxCenter(bbox: [number, number, number, number]): LatLon {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const east = maxLon < minLon ? maxLon + 360 : maxLon;
  const lon = (((minLon + east) / 2 + 540) % 360) - 180;
  return { lat: (minLat + maxLat) / 2, lon };
}

/** Тайлы Terrarium, попадающие в круг радиуса radiusM вокруг центра */
function detailTileKeys(center: LatLon, radiusM: number): string[] {
  const keys: string[] = [];
  const north = destination(center, 0, radiusM).lat;
  const south = destination(center, Math.PI, radiusM).lat;
  const east = destination(center, Math.PI / 2, radiusM).lon;
  const west = destination(center, -Math.PI / 2, radiusM).lon;
  for (const zoom of DETAIL_ZOOMS) {
    const n = 2 ** zoom;
    const clamp = (lat: number) => Math.max(-85.05, Math.min(85.05, lat));
    const tileY = (lat: number) => {
      const rad = (clamp(lat) * Math.PI) / 180;
      return (
        ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
      );
    };
    const y0 = Math.floor(tileY(north));
    const y1 = Math.ceil(tileY(south));
    const x0 = Math.floor(((west + 180) / 360) * n);
    let x1 = Math.ceil(((east + 180) / 360) * n);
    // Круг через антимеридиан: восточный край оказывается «левее» западного.
    // Разворачиваем диапазон за край мира — ключи ниже всё равно заворачиваются.
    // Без этого цикл не выполнялся бы ни разу, и Врангель скачался бы вовсе
    // без детальной зоны, отчитавшись об успехе
    if (x1 <= x0) x1 += n;
    for (let x = x0; x < x1; x++) {
      for (let y = y0; y < y1; y++) {
        // Тайлы за границей мира по долготе заворачиваются, по широте — нет
        if (y < 0 || y >= n) continue;
        keys.push(`${zoom}/${((x % n) + n) % n}/${y}`);
      }
    }
  }
  return keys;
}

/**
 * Предикат дедупликации слоёв: базовый LOD 0 (217 м) избыточен в ячейках 1°,
 * полностью покрытых hi-слоем (87 м) — hi строго детальнее и тоже качается.
 * Ячейка считается покрытой, только если у hi есть все 25 тайлов 0.2°:
 * частично покрытую (берег, дыра в данных) ячейку базовый слой страхует.
 */
export function keepBaseTileKey(demHi: DemSampler): (key: string) => boolean {
  return (key) => {
    const [lod, tx, ty] = key.split("/").map(Number);
    if (lod !== 0) return true;
    // Ячейка 1° базовой пирамиды (тайл 0.5°) ↔ квадрат 5×5 тайлов hi (0.2°)
    const cx = Math.floor(tx / 2);
    const cy = Math.floor(ty / 2);
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        if (!demHi.hasTile(0, cx * 5 + i, cy * 5 + j)) return true;
      }
    }
    return false;
  };
}

/**
 * Оценка объёма загрузки региона в байтах: пирамида по bbox + детальная зона.
 * Считается по реальному числу тайлов, а не по площади: разреженная пирамида
 * не хранит море и равнины, и разница доходит до порядка.
 */
export async function estimateRegionBytes(
  info: RegionInfo,
  origin: LatLon,
  sampler?: DemSampler,
): Promise<number> {
  const dem = sampler ?? (await sharedPyramid());
  const center = inBBox(origin, info.bbox) ? origin : bboxCenter(info.bbox);
  // Детальный слой разрежён: вне p1–p3 даст ноль байт; недоступен — не мешает.
  // Где hi есть, базовый LOD 0 в оценку не входит — качать его не будем
  const demHi = await sharedPyramidHi().catch(() => null);
  const hiBytes = demHi?.bboxDownloadBytes(info.bbox) ?? 0;
  const baseBytes = dem.bboxDownloadBytes(
    info.bbox,
    demHi ? keepBaseTileKey(demHi) : undefined,
  );
  return (
    baseBytes +
    hiBytes +
    detailTileKeys(center, DETAIL_RADIUS_M).length * TERRARIUM_TILE_BYTES
  );
}

/**
 * Общий сэмплер пирамиды: index.json (54 КБ) грузится один раз на страницу.
 *
 * При неудаче память сбрасывается: отклонённый промис, оставшийся в
 * переменной, ломал бы и оценку размеров, и саму загрузку регионов до
 * перезагрузки страницы — а сеть в горах появляется и пропадает.
 */
let pyramid: Promise<DemSampler> | null = null;
function sharedPyramid(): Promise<DemSampler> {
  pyramid ??= (async () => {
    const dem = new DemSampler({ baseUrl: GLOBAL_DEM_URL });
    await dem.loadIndex();
    return dem;
  })().catch((err) => {
    pyramid = null;
    throw err;
  });
  return pyramid;
}

/** Детальный слой p1–p3; не развёрнут или офлайн — регион качается без него */
let pyramidHi: Promise<DemSampler> | null = null;
function sharedPyramidHi(): Promise<DemSampler> {
  pyramidHi ??= (async () => {
    const dem = new DemSampler({ baseUrl: GLOBAL_DEM_HI_URL });
    await dem.loadIndex();
    return dem;
  })().catch((err) => {
    pyramidHi = null;
    throw err;
  });
  return pyramidHi;
}

/**
 * Загрузка региона для офлайна. Возвращает число сохранённых тайлов.
 */
export async function downloadRegion(
  region: string,
  origin: LatLon,
  onProgress: (p: DownloadProgress) => void,
): Promise<number> {
  const base = import.meta.env.BASE_URL;

  // 1. Пики
  onProgress({ done: 0, total: 0, phase: "peaks" });
  const peaksRes = await fetch(`${base}peaks/${region}.json`);
  if (
    peaksRes.ok &&
    (peaksRes.headers.get("content-type") ?? "").includes("application/json")
  ) {
    const data = await peaksRes.json();
    await savePeaks(region, data.peaks ?? []);
  }

  const regions = await loadRegions();
  const info = regions[region];
  if (!info?.bbox) {
    throw new Error(`Регион ${region} не найден в реестре`);
  }

  // 2. Пирамида по всему bbox + детальный слой p1–p3 + Terrarium вокруг точки
  // наблюдения. Если пользователь сейчас в другом регионе, детализируем центр
  // bbox — приедет он всё-таки туда.
  const dem = await sharedPyramid();
  const demHi = await sharedPyramidHi().catch(() => null);
  const allPyramidKeys = dem.tileKeysInBBox(info.bbox);
  const hiKeys = demHi?.tileKeysInBBox(info.bbox) ?? [];
  // Дедупликация: в ячейках, полностью покрытых hi (87 м), базовый LOD 0
  // (217 м) не качаем — он там избыточен. Без hi (слой недоступен) качаем всё
  const pyramidKeys = demHi
    ? allPyramidKeys.filter(keepBaseTileKey(demHi))
    : allPyramidKeys;
  const center = inBBox(origin, info.bbox) ? origin : bboxCenter(info.bbox);
  const detailKeys = detailTileKeys(center, DETAIL_RADIUS_M);
  const total = pyramidKeys.length + hiKeys.length + detailKeys.length;

  let done = 0;
  onProgress({ done, total, phase: "tiles" });
  const pyramidStats = await dem.downloadTiles(pyramidKeys, (n) => {
    done = n;
    onProgress({ done, total, phase: "tiles" });
  });
  const hiStats = demHi
    ? await demHi.downloadTiles(hiKeys, (n) => {
        done = pyramidKeys.length + n;
        onProgress({ done, total, phase: "tiles" });
      })
    : { bytes: 0, ok: 0, failed: 0 };

  const sampler = new TerrariumSampler();
  const CONCURRENCY = 6;
  let detailOk = 0;
  for (let i = 0; i < detailKeys.length; i += CONCURRENCY) {
    const batch = detailKeys.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (key) => {
        const [z, x, y] = key.split("/").map(Number);
        // Именно saveTileOffline: loadTile молча превращает в null и обрыв
        // сети, и 503 офлайнового Service Worker'а, поэтому счётчик успехов
        // по нему всегда сходился — регион «скачивался», не сохранив ничего
        const status = await sampler.saveTileOffline(z, x, y);
        // Дыра в покрытии Terrarium (океан, полярная шапка) — не отказ:
        // требовать её невозможно, а упереться в неё значит не дать скачать
        if (status !== "failed") detailOk++;
      }),
    );
    done += batch.length;
    onProgress({ done, total, phase: "tiles" });
  }

  // Регион считается скачанным только если рельеф действительно лёг на
  // устройство. Офлайн Service Worker отдаёт 503 — не исключение, а ответ,
  // поэтому цикл «успешно» завершался с нулём тайлов и ставил галочку
  const saved = pyramidStats.ok + hiStats.ok + detailOk;
  if (total > 0 && saved < total * MIN_SAVED_RATIO) {
    throw new Error(`Скачано ${saved} тайлов из ${total} — регион не сохранён`);
  }

  onProgress({ done: total, total, phase: "done" });
  await markRegionDownloaded(region, dem.version);
  return saved;
}

/**
 * Устарел ли рельеф скачанного региона: базовая пирамида пересобрана после
 * того, как регион качали (версия в метаданных не совпадает с текущей), либо
 * регион скачан до появления версий, а его тайлы уже вычищены при переходе
 * (dem-purged). Офлайн или без индекса честно отвечаем «не знаем» → false:
 * ложная тревога хуже отложенной.
 */
export async function isRegionOutdated(region: string): Promise<boolean> {
  try {
    const { getRegionMeta, getDemPurged } = await import("../core/db");
    const meta = await getRegionMeta(region);
    if (!meta) return false;
    const dem = await sharedPyramid();
    const current = dem.version;
    if (!current) return false;
    if (meta.demVersion) return meta.demVersion !== current;
    return (await getDemPurged("")) === current;
  } catch {
    return false;
  }
}

/**
 * Докачан ли у региона детальный слой hi (p1–p3, ~87 м).
 *
 * Регионы, скачанные до появления hi-слоя, содержат только базовую пирамиду
 * 217 м — кнопка в настройках должна предлагать «Обновить», а не стоять
 * мёртвой «Скачан». У регионов вне покрытия hi (p4) тайлов нет вовсе — там
 * обновлять нечего, ответ true.
 *
 * Проверяем только LOD 0 (детальный): LOD 1 — грубая вся-суша, её наличие
 * качества не добавляет. Признак — хотя бы один тайл LOD 0 в хранилище.
 */
export async function hasHiDetail(region: RegionInfo): Promise<boolean> {
  if (!region.bbox) return true;
  try {
    const hi = await sharedPyramidHi();
    const keys = hi
      .tileKeysInBBox(region.bbox)
      .filter((k) => k.startsWith("0/"));
    if (keys.length === 0) return true; // вне покрытия hi (p4) — нечего качать
    for (const key of keys) {
      if (await getDemTile(`hi/${key}`)) return true;
    }
    return false;
  } catch {
    // Индекс hi недоступен (офлайн и не кеширован) — не блокируем UI
    return true;
  }
}

/**
 * Хранилище реестра между запусками. Вынесено интерфейсом, чтобы тесты
 * обходились без IndexedDB.
 */
export interface RegionsStore {
  save(regions: Record<string, RegionInfo>): Promise<void>;
  load(): Promise<Record<string, RegionInfo> | undefined>;
}

/** Реестр из последней успешной загрузки: одна страница — одно чтение */
let registryCache: Record<string, RegionInfo> | null = null;
/** Идущее чтение: параллельные вызовы не должны дублировать запрос */
let registryPending: Promise<Record<string, RegionInfo>> | null = null;

/** Сброс памяти реестра (тесты; в приложении реестр живёт до перезагрузки) */
export function resetRegionsCache(): void {
  registryCache = null;
  registryPending = null;
}

const idbRegionsStore: RegionsStore = {
  async save(regions) {
    if (!root.indexedDB) return;
    const { saveRegionsRegistry } = await import("../core/db");
    await saveRegionsRegistry(regions);
  },
  async load() {
    if (!root.indexedDB) return undefined;
    const { getRegionsRegistry } = await import("../core/db");
    return (await getRegionsRegistry()) as
      Record<string, RegionInfo> | undefined;
  },
};

/**
 * Чтение реестра регионов (public/regions.json, копия tools/regions.json).
 *
 * Реестр — единственный способ узнать, какие регионы вообще есть, и сменить
 * активный. Офлайн сеть его не отдаёт, а Service Worker кеширует файл только
 * если тот хоть раз запрашивался онлайн (при ручном выборе региона это могло
 * не случиться ни разу). Поэтому каждая успешная загрузка складывается в
 * IndexedDB, и офлайн список берётся оттуда.
 */
export function loadRegions(
  options: { fetchFn?: typeof fetch; store?: RegionsStore } = {},
): Promise<Record<string, RegionInfo>> {
  if (registryCache) return Promise.resolve(registryCache);
  registryPending ??= readRegistry(options).then((regions) => {
    registryPending = null;
    if (Object.keys(regions).length > 0) registryCache = regions;
    return regions;
  });
  return registryPending;
}

async function readRegistry(options: {
  fetchFn?: typeof fetch;
  store?: RegionsStore;
}): Promise<Record<string, RegionInfo>> {
  const fetchFn = options.fetchFn ?? fetch;
  const store = options.store ?? idbRegionsStore;
  const base = import.meta.env.BASE_URL;

  try {
    const res = await fetchFn(`${base}regions.json`);
    if (!res.ok) throw new Error(`regions.json: HTTP ${res.status}`);
    // Vite и GitHub Pages на 404 отдают index.html — проверяем тип
    if (!(res.headers.get("content-type") ?? "").includes("json")) {
      throw new Error("regions.json: не JSON");
    }
    const regions = (await res.json()) as Record<string, RegionInfo>;
    void store.save(regions).catch(() => {});
    return regions;
  } catch (err) {
    const cached = await store.load().catch(() => undefined);
    if (cached && Object.keys(cached).length > 0) return cached;
    console.warn("Реестр регионов недоступен:", err);
    return {};
  }
}

/** Авто-выбор региона по позиции: первый, чей bbox содержит точку.
 *  При пересечении — приоритет меньше = конкретнее. */
export function findRegionForPosition(
  pos: LatLon,
  regions: Record<string, RegionInfo>,
): string | null {
  let best: string | null = null;
  let bestPriority = Infinity;
  for (const [key, info] of Object.entries(regions)) {
    if (key.startsWith("$") || typeof info !== "object" || !info.bbox) continue;
    if (inBBox(pos, info.bbox)) {
      const priority =
        (info as RegionInfo & { priority?: number }).priority ?? 9;
      if (priority < bestPriority) {
        best = key;
        bestPriority = priority;
      }
    }
  }
  return best;
}

/** Расстояние от точки до bbox по поверхности, метры (0 — точка внутри) */
export function distanceToBBox(
  pos: LatLon,
  bbox: [number, number, number, number],
): number {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const dLat =
    pos.lat < minLat
      ? minLat - pos.lat
      : pos.lat > maxLat
        ? pos.lat - maxLat
        : 0;
  // По долготе мир замкнут: до края считаем кратчайший зазор, а не разность
  const gapDeg = (a: number, b: number): number =>
    Math.abs(((((a - b) % 360) + 540) % 360) - 180);
  const insideLon =
    minLon <= maxLon
      ? pos.lon >= minLon && pos.lon <= maxLon
      : pos.lon >= minLon || pos.lon <= maxLon;
  const dLon = insideLon
    ? 0
    : Math.min(gapDeg(pos.lon, minLon), gapDeg(pos.lon, maxLon));
  return Math.hypot(
    dLat * M_PER_DEG_LAT,
    dLon * M_PER_DEG_LAT * Math.cos((pos.lat * Math.PI) / 180),
  );
}

/**
 * Ближайший регион, вершины которого отсюда в принципе могут быть видны.
 *
 * Реестр покрывает горные узлы, а не всю сушу: в Краснодаре, Ростове или
 * Тбилиси человек оказывается вне всех bbox, и правило «регион тот, чей bbox
 * содержит точку» не отвечает ничего — приложение молчало, оставляя вершины
 * прежнего района, хотя рядом есть подходящий.
 *
 * Дальше радиуса видимости вершин не смотрим: район, чьи горы отсюда не видны
 * ни при какой погоде, предлагать незачем — это был бы шум.
 */
export function nearestRegionForPosition(
  pos: LatLon,
  regions: Record<string, RegionInfo>,
  maxDistM: number = PEAK_VISIBILITY_RADIUS_M,
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  let bestPriority = Infinity;
  for (const [key, info] of Object.entries(regions)) {
    if (key.startsWith("$") || typeof info !== "object" || !info.bbox) continue;
    const dist = distanceToBBox(pos, info.bbox);
    if (dist > maxDistM) continue;
    const priority = info.priority ?? 9;
    // На равных расстояниях выигрывает более конкретный район
    if (dist < bestDist || (dist === bestDist && priority < bestPriority)) {
      best = key;
      bestDist = dist;
      bestPriority = priority;
    }
  }
  return best;
}

/**
 * Район под эту точку: содержащий её, а если таких нет — ближайший.
 * Единая точка выбора для старта по GPS, переноса с карты и предложения
 * сменить регион.
 */
export function regionForPosition(
  pos: LatLon,
  regions: Record<string, RegionInfo>,
): string | null {
  return (
    findRegionForPosition(pos, regions) ??
    nearestRegionForPosition(pos, regions)
  );
}

/** Имя региона для UI с учётом локали */
export function regionLabel(info: RegionInfo): string {
  return getLocale() === "ru"
    ? (info.title_ru ?? info.title_en ?? "")
    : (info.title_en ?? info.title_ru ?? "");
}

/**
 * Какой регион предложить для точки, если активный ей больше не подходит.
 * null — предлагать нечего: активный регион точку содержит, кандидата нет или
 * это он же.
 *
 * Пока текущий регион содержит точку, молчим даже при более приоритетном
 * соседе: регионы реестра сильно перекрываются (буфер 200 км с каждой
 * стороны), и работающий регион менять незачем — это только мешало бы.
 *
 * Вне всех bbox (равнина у подножия: Краснодар, Ростов) берётся ближайший
 * подходящий район. Раньше там не предлагалось ничего, и человек оставался
 * с вершинами того района, который выбрал когда-то на другом конце страны.
 */
export function suggestRegionForPosition(
  pos: LatLon,
  currentRegion: string,
  regions: Record<string, RegionInfo>,
): string | null {
  const current = regions[currentRegion];
  if (current?.bbox && inBBox(pos, current.bbox)) return null;
  const best = regionForPosition(pos, regions);
  return best && best !== currentRegion ? best : null;
}

/** Ключевые вершины региона для UI с учётом локали */
export function regionCore(info: RegionInfo): string {
  return getLocale() === "ru"
    ? (info.core_ru ?? info.core_en ?? "")
    : (info.core_en ?? info.core_ru ?? "");
}
