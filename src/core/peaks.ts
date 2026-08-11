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
  /** Название: ru → name → en */
  name: string;
  /** Wikidata QID, если есть */
  wikidata?: string;
}

export interface PeaksFile {
  region: string;
  generated: string;
  peaks: Peak[];
}

/**
 * Приоритет подписи: score = ele / distance (ALGORITHMS.md §4).
 * Чем выше и ближе — тем важнее.
 */
export function peakScore(peak: Peak, distanceM: number): number {
  const ele = peak.ele ?? 0;
  return ele / Math.max(distanceM, 1);
}

/** Фильтр пиков в радиусе видимости (200 км по ROADMAP) */
export const PEAK_VISIBILITY_RADIUS_M = 200_000;
