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
}

export interface PeaksFile {
  region: string;
  generated: string;
  peaks: Peak[];
}

/**
 * Приоритет подписи (ALGORITHMS.md §4).
 *
 * Главный критерий — абсолютная высота: из двух соседних вершин подписываем
 * более высокую. Близость даёт бонус (до +40% на нулевой дистанции, затухает
 * к ~40 км), поэтому при близкой высоте выигрывает ближняя вершина.
 *
 * Прежняя формула ele/distance была слишком чувствительна к дистанции:
 * холм 3000 м в 5 км «побеждал» Эльбрус в 20 км.
 */
export function peakScore(peak: Peak, distanceM: number): number {
  const ele = peak.ele ?? 0;
  const proximity = Math.exp(-Math.max(distanceM, 0) / 40_000);
  return ele * (1 + 0.4 * proximity);
}

/** Фильтр пиков в радиусе видимости (200 км по ROADMAP) */
export const PEAK_VISIBILITY_RADIUS_M = 200_000;
