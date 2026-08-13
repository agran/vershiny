/**
 * Вершины (POI): типы и приоритезация подписей.
 * Данные прекомпилированы tools/peaks-to-json в peaks/{region}.json.
 */

export interface Peak {
  /** Широта */
  lat: number;
  /** Долгота */
  lon: number;
  /** Высота, м (может отсутствовать в OSM — тогда из DEM) */
  ele?: number;
  /** Название (name из OSM — локальное) */
  name: string;
  /** Русское название (name:ru), если есть */
  name_ru?: string;
  /** Английское название (name:en), если есть */
  name_en?: string;
  /** Wikidata QID, если есть */
  wikidata?: string;
  /** Вулкан (natural=volcano в OSM) */
  volcano?: boolean;
  /**
   * Изоляция: расстояние до ближайшей более высокой вершины, м.
   * Считается по загруженному набору (annotateIsolation), не из OSM.
   */
  isoM?: number;
}

export interface PeaksFile {
  region: string;
  generated: string;
  peaks: Peak[];
}

/** Метров в градусе широты */
const M_PER_DEG_LAT = 111_320;
/** Изоляция, с которой вершина считается полностью самостоятельной */
const ISO_DOMINANT_M = 30_000;
/** Ниже этого вершина — часть соседнего массива, а не самостоятельная */
const ISO_SUBORDINATE_M = 300;
/** Во сколько раз подпись побочной вершины менее приоритетна самостоятельной */
const ISO_MIN_WEIGHT = 0.55;
/** Дальше искать незачем: вес изоляции всё равно насыщается на ISO_DOMINANT_M */
const ISO_SEARCH_LIMIT_M = ISO_DOMINANT_M * 1.2;
/** Сторона ячейки сетки поиска, м */
const ISO_CELL_M = 5_000;

/**
 * Изоляция каждой вершины — расстояние до ближайшей более высокой (метры).
 *
 * Это стандартная альпинистская мера значимости и лучший доступный нам
 * заменитель prominence: тег `prominence` в OSM почти не заполнен
 * (DATA-PIPELINE.md), а изоляция считается из самого набора вершин.
 *
 * Она разом решает обе задачи отбора подписей:
 *   • группа рядом стоящих вершин — у побочных изоляция сотни метров
 *     (до соседа-«главного»), у главной она огромная → подписываем главную;
 *   • одиноко стоящая гора — ближайшая более высокая далеко → высокая
 *     изоляция → вершина интересна, даже если по абсолютной высоте скромна.
 *
 * Поиск идёт по сетке в порядке убывания высоты (более высокие уже в сетке)
 * и обрывается на ISO_SEARCH_LIMIT_M: дальше вес всё равно не растёт, а в
 * регионе бывает до 50 тыс. вершин — полный перебор пар там немыслим.
 */
export function annotateIsolation(peaks: Peak[]): void {
  if (!peaks.length) return;

  // Локальная проекция в метры: регион мал, одного cos φ достаточно
  const lat0 = peaks.reduce((sum, p) => sum + p.lat, 0) / peaks.length;
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const xs = new Float64Array(peaks.length);
  const ys = new Float64Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    xs[i] = peaks[i].lon * kx;
    ys[i] = peaks[i].lat * M_PER_DEG_LAT;
  }

  const order = peaks
    .map((_, i) => i)
    .sort((a, b) => (peaks[b].ele ?? 0) - (peaks[a].ele ?? 0) || a - b);

  const grid = new Map<string, number[]>();
  const cell = (v: number): number => Math.floor(v / ISO_CELL_M);
  const maxRing = Math.ceil(ISO_SEARCH_LIMIT_M / ISO_CELL_M);

  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const gx = cell(xs[i]);
    const gy = cell(ys[i]);

    let best2 = Infinity;
    for (let r = 0; r <= maxRing; r++) {
      // Точки кольца r лежат не ближе (r−1) ячеек: если уже нашли что-то ближе,
      // дальше искать нечего. Тот же предел обрывает поиск у одиноких вершин.
      const reach = Math.max(0, r - 1) * ISO_CELL_M;
      if (r > 0 && reach * reach > Math.min(best2, ISO_SEARCH_LIMIT_M ** 2)) break;
      for (let cx = gx - r; cx <= gx + r; cx++) {
        for (let cy = gy - r; cy <= gy + r; cy++) {
          // Только внешнее кольцо: внутренние уже просмотрены
          if (Math.max(Math.abs(cx - gx), Math.abs(cy - gy)) !== r) continue;
          const bucket = grid.get(`${cx},${cy}`);
          if (!bucket) continue;
          for (const j of bucket) {
            const dx = xs[j] - xs[i];
            const dy = ys[j] - ys[i];
            const d2 = dx * dx + dy * dy;
            if (d2 < best2) best2 = d2;
          }
        }
      }
    }

    peaks[i].isoM =
      best2 === Infinity
        ? ISO_SEARCH_LIMIT_M
        : Math.min(Math.sqrt(best2), ISO_SEARCH_LIMIT_M);

    const key = `${gx},${gy}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }
}

/**
 * Значимость вершины по изоляции: 0.55 у побочного пика в группе → 1.0
 * у самостоятельной горы. Шкала логарифмическая: изоляция меняется на три
 * порядка (сотни метров у жандарма на гребне — десятки километров у
 * самостоятельной горы), и линейная шкала свела бы всё в один угол.
 */
export function isolationWeight(isoM: number | undefined): number {
  if (isoM === undefined || !Number.isFinite(isoM)) return 1;
  if (isoM <= ISO_SUBORDINATE_M) return ISO_MIN_WEIGHT;
  const t = Math.min(
    1,
    Math.log(isoM / ISO_SUBORDINATE_M) / Math.log(ISO_DOMINANT_M / ISO_SUBORDINATE_M),
  );
  return ISO_MIN_WEIGHT + (1 - ISO_MIN_WEIGHT) * t;
}

/**
 * Приоритет подписи (ALGORITHMS.md §4).
 *
 * Три множителя:
 *   • абсолютная высота — основа;
 *   • близость к наблюдателю (до +40%, затухает к ~40 км): при близкой высоте
 *     выигрывает ближняя вершина;
 *   • изоляция (0.55…1.0): из тесной группы вершин побеждает главная, а
 *     одиноко стоящая гора не проигрывает побочному пику соседнего массива.
 *
 * Прежняя формула ele/distance была слишком чувствительна к дистанции:
 * холм 3000 м в 5 км «побеждал» Эльбрус в 20 км.
 */
export function peakScore(peak: Peak, distanceM: number): number {
  const ele = peak.ele ?? 0;
  const proximity = Math.exp(-Math.max(distanceM, 0) / 40_000);
  return ele * (1 + 0.4 * proximity) * isolationWeight(peak.isoM);
}

/** Фильтр пиков в радиусе видимости (200 км по ROADMAP) */
export const PEAK_VISIBILITY_RADIUS_M = 200_000;
