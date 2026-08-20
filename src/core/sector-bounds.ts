/**
 * Секторные верхние границы высот для обрыва лучей (CODE-REVIEW P4).
 *
 * Идея: если даже высочайший из загруженных тайлов сектора азимута не даёт
 * наклона выше всего, что луч уже видел, — оставшийся хвост луча добавит
 * только рельеф, скрытый за текущим максимумом (в рендере он невидим:
 * силуэт — максимум по слоям, гребни — по бегущему максимуму). Глобальная
 * граница «максимум всех тайлов» у горного наблюдателя бесполезна (высота
 * наблюдателя H > hO), а вот секторная — рабочая.
 *
 * Консервативность = корректность: каждый тайл приписывается всем секторам,
 * пересекающим его ОПИСАННУЮ ОКРУЖНОСТЬ (радиус — половина диагонали bbox)
 * плюс один сектор окаймления. Тайлы, целиком ближе порога отсечения, в
 * границы не входят: их высоты луч дальше порога не читает, и ближняя гора
 * под ногами не гасила бы обрыв в своём секторе.
 */

import { azimuthRad, distanceM, normalizeAz, normalizeLon, type LatLon } from "./geo";

/** С какого расстояния луча работает обрыв (синхронно с horizon.ts) */
export const SECTOR_CULL_START_M = 60_000;

const TWO_PI = 2 * Math.PI;
/** Метров в градусе широты */
const M_PER_DEG_LAT = 111_320;

/** Тайл с максимумом высоты: bbox + h */
export interface SectorTile {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  /** Максимум высоты в тайле, м */
  h: number;
}

/**
 * Верхняя граница высоты по секторам азимута (sectorCount секторов).
 * Значения — метры. Сектор без загруженных тайлов получает 0: дальше
 * порога луч в таком секторе читает только незагруженные тайлы (NaN),
 * поэтому 0 — честная верхняя граница, и обрыв работает и над равниной/морем
 */
export function sectorBoundsForTiles(
  origin: LatLon,
  tiles: SectorTile[],
  sectorCount: number,
  cullStartM = SECTOR_CULL_START_M,
): Float32Array {
  const out = new Float32Array(sectorCount).fill(0);
  const sectorRad = TWO_PI / sectorCount;

  const fill = (s0: number, s1: number, h: number): void => {
    if (s1 - s0 + 1 >= sectorCount) {
      for (let s = 0; s < sectorCount; s++) {
        if (h > out[s]) out[s] = h;
      }
      return;
    }
    for (let s = s0; s <= s1; s++) {
      const idx = ((s % sectorCount) + sectorCount) % sectorCount;
      if (h > out[idx]) out[idx] = h;
    }
  };

  for (const t of tiles) {
    const midLat = (t.minLat + t.maxLat) / 2;
    // Центр по долготе корректно и для bbox через антимеридиан
    const midLon =
      t.minLon <= t.maxLon
        ? (t.minLon + t.maxLon) / 2
        : normalizeLon((t.minLon + t.maxLon + 360) / 2);
    const dC = distanceM(origin, { lat: midLat, lon: midLon });

    const lonSpanDeg = Math.abs(t.maxLon - t.minLon);
    const lonSpanM =
      (lonSpanDeg > 180 ? 360 - lonSpanDeg : lonSpanDeg) *
      M_PER_DEG_LAT *
      Math.cos((midLat * Math.PI) / 180);
    const latSpanM = (t.maxLat - t.minLat) * M_PER_DEG_LAT;
    // Радиус описанной окружности: половина диагонали bbox
    const r = Math.hypot(lonSpanM, latSpanM) / 2;

    // Тайл целиком ближе зоны отсечения — луч дальше порога его не читает
    if (dC + r < cullStartM) continue;

    if (dC <= r) {
      // Наблюдатель внутри круга тайла — тайл на любом азимуте
      fill(0, sectorCount - 1, t.h);
      continue;
    }
    // Полуугол круга тайла из точки наблюдателя + сектор окаймления
    const half = Math.atan2(r, dC) + sectorRad;
    const azC = normalizeAz(azimuthRad(origin, { lat: midLat, lon: midLon }));
    const s0 = Math.floor((azC - half) / sectorRad);
    const s1 = Math.ceil((azC + half) / sectorRad) - 1;
    fill(s0, s1, t.h);
  }
  return out;
}
