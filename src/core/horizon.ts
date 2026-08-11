/**
 * Ray-marching горизонта (ALGORITHMS.md §1–2).
 * Чистые функции без I/O — DEM передаётся как синхронный сэмплер,
 * поэтому код одинаково работает в Web Worker и в тестах.
 */

import {
  destination,
  earthDrop,
  elevationAngleRad,
  distanceM,
  azimuthRad,
  type LatLon,
} from './geo';
import type { Peak } from './peaks';
import { PEAK_VISIBILITY_RADIUS_M } from './peaks';

/** Синхронная выборка высоты: (pos, дистанция от наблюдателя) → метры | NaN */
export type SampleFn = (pos: LatLon, distM: number) => number;

export interface HorizonOptions {
  /** Шаг по азимуту, рад. 0.1° → 3600 лучей */
  azimuthStepRad?: number;
  /** Максимальная дальность луча, м */
  maxDistM?: number;
  /** Начало луча, м (ближе — свой склон, шум) */
  minDistM?: number;
  /** Высота глаз/телефона над землёй, м */
  observerElevationM?: number;
}

export interface VisiblePeak extends Peak {
  /** Истинный азимут на пик, рад [0, 2π) */
  azimuthRad: number;
  /** Угол возвышения пика, рад */
  elevationRad: number;
  /** Расстояние, м */
  distanceM: number;
}

const TWO_PI = 2 * Math.PI;

/**
 * Адаптивный шаг вдоль луча: 90 м вблизи → 500 м+ вдали (ALGORITHMS.md §1).
 * Возвращает следующую дистанцию.
 */
export function nextRayStep(distM: number): number {
  if (distM < 5_000) return 90;
  if (distM < 30_000) return 180;
  if (distM < 100_000) return 350;
  return 700;
}

/**
 * Профиль горизонта: для каждого азимута — максимальный угол возвышения
 * видимого рельефа. Возвращает Float32Array длиной ceil(2π/step).
 */
export function computeHorizon(
  origin: LatLon,
  observerH: number,
  sample: SampleFn,
  options: HorizonOptions = {},
): { angles: Float32Array; stepRad: number } {
  const stepRad = options.azimuthStepRad ?? (0.1 * Math.PI) / 180;
  const maxDist = options.maxDistM ?? 200_000;
  const minDist = options.minDistM ?? 100;
  const hO = observerH + (options.observerElevationM ?? 1.7);

  const rayCount = Math.ceil(TWO_PI / stepRad);
  const angles = new Float32Array(rayCount).fill(-Infinity);

  for (let i = 0; i < rayCount; i++) {
    const az = i * stepRad;
    let maxAngle = -Infinity;
    // Локальный «фронт»: как только земля ушла за горизонт с запасом,
    // дальше можно шагать крупнее — реализовано в nextRayStep
    for (let d = minDist; d <= maxDist; d += nextRayStep(d)) {
      const p = destination(origin, az, d);
      const h = sample(p, d);
      if (Number.isNaN(h)) continue;
      const apparentH = h - earthDrop(d);
      const angle = Math.atan2(apparentH - hO, d);
      if (angle > maxAngle) maxAngle = angle;
      // Ранний выход: рельеф опустился ниже −0.5° и мы далеко —
      // выше уже не поднимется (кривизна давит квадратично)
      if (d > 60_000 && angle < maxAngle - 0.02 && maxAngle < -0.005) break;
    }
    angles[i] = maxAngle;
  }
  return { angles, stepRad };
}

/**
 * Видимость пика: точный луч в его азимуте (ALGORITHMS.md §2).
 * Пик виден, если его угол возвышения ≥ профиля луча − ε.
 */
export function checkPeakVisibility(
  origin: LatLon,
  observerH: number,
  peak: Peak,
  sample: SampleFn,
  epsilonRad = 0.0009, // ~0.05°
): VisiblePeak | null {
  const target: LatLon = { lat: peak.lat, lon: peak.lon };
  const dist = distanceM(origin, target);
  if (dist > PEAK_VISIBILITY_RADIUS_M || dist < 1) return null;
  if (peak.ele === undefined) return null;

  const az = azimuthRad(origin, target);
  const hO = observerH + 1.7;

  // Марш луча до пика: ищем максимальный угол рельефа строго до пика
  let maxAngle = -Infinity;
  for (let d = 100; d < dist - 100; d += nextRayStep(d)) {
    const p = destination(origin, az, d);
    const h = sample(p, d);
    if (Number.isNaN(h)) continue;
    const angle = Math.atan2(h - earthDrop(d) - hO, d);
    if (angle > maxAngle) maxAngle = angle;
  }

  const peakAngle = elevationAngleRad(hO, peak.ele, dist);
  if (peakAngle < maxAngle - epsilonRad) return null;

  return {
    ...peak,
    azimuthRad: az,
    elevationRad: peakAngle,
    distanceM: dist,
  };
}

/** Массовая проверка видимости списка пиков */
export function filterVisiblePeaks(
  origin: LatLon,
  observerH: number,
  peaks: Peak[],
  sample: SampleFn,
): VisiblePeak[] {
  const result: VisiblePeak[] = [];
  for (const peak of peaks) {
    const visible = checkPeakVisibility(origin, observerH, peak, sample);
    if (visible) result.push(visible);
  }
  // Ближние и высокие — первыми (для кластеризации подписей)
  result.sort((a, b) => (b.ele ?? 0) / b.distanceM - (a.ele ?? 0) / a.distanceM);
  return result;
}
