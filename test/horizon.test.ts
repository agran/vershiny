import { describe, expect, it } from 'vitest';
import {
  checkPeakVisibility,
  computeHorizon,
  nextRayStep,
  type SampleFn,
} from '../src/core/horizon';
import { destination, type LatLon } from '../src/core/geo';
import type { Peak } from '../src/core/peaks';

/** Синтетический рельеф: один конус высотой peakH на дистанции coneDist по азимуту coneAz */
function conicSampler(
  origin: LatLon,
  coneAz: number,
  coneDist: number,
  peakH: number,
): SampleFn {
  const apex = destination(origin, coneAz, coneDist);
  return (pos) => {
    const d = Math.hypot(pos.lat - apex.lat, pos.lon - apex.lon) * 111_320;
    return Math.max(0, peakH - d * 0.5); // склон 0.5 м/м
  };
}

const ORIGIN: LatLon = { lat: 43, lon: 42 };

describe('ray-marching горизонта', () => {
  it('адаптивный шаг растёт с дистанцией', () => {
    expect(nextRayStep(1_000)).toBe(90);
    expect(nextRayStep(10_000)).toBe(180);
    expect(nextRayStep(50_000)).toBe(350);
    expect(nextRayStep(150_000)).toBe(700);
  });

  it('конус виден на горизонте под своим азимутом', () => {
    const coneAz = Math.PI / 3;
    const sample = conicSampler(ORIGIN, coneAz, 20_000, 3000);
    const { angles, stepRad } = computeHorizon(ORIGIN, 0, sample, {
      maxDistM: 50_000,
    });
    const idx = Math.round(coneAz / stepRad);
    // Угол на конус: atan((3000 − drop(20км)) / 20000) ≈ 8.4°
    expect(angles[idx]).toBeGreaterThan(0.12);
    expect(angles[idx]).toBeLessThan(0.16);
    // Перпендикулярный азимут — ровная земля, горизонт ≈ 0
    const flatIdx = Math.round(((coneAz + Math.PI) % (2 * Math.PI)) / stepRad);
    expect(angles[flatIdx]).toBeLessThan(0.005);
  });

  it('пик за высоким хребтом невидим, без хребта — виден', () => {
    const far: Peak = { lat: 0, lon: 0, name: 'Дальняя', ele: 5000 };
    // Разместим дальний пик через destination на 80 км на восток
    const farPos = destination(ORIGIN, Math.PI / 2, 80_000);
    far.lat = farPos.lat;
    far.lon = farPos.lon;

    // Рельеф: хребет 4000 м на 30 км — закрывает дальний пик
    const blocked = conicSampler(ORIGIN, Math.PI / 2, 30_000, 4000);
    expect(checkPeakVisibility(ORIGIN, 1000, far, blocked, 30_000)).toBeNull();

    // Ровная земля — пик виден (угол ~0.4°)
    const flat: SampleFn = () => 0;
    const visible = checkPeakVisibility(ORIGIN, 1000, far, flat, Infinity);
    expect(visible).not.toBeNull();
    expect(visible!.distanceM).toBeCloseTo(80_000, -3);
  });

  it('пик вне 200 км отбрасывается', () => {
    const flat: SampleFn = () => 0;
    const farPos = destination(ORIGIN, 0, 250_000);
    const peak: Peak = { ...farPos, name: 'Очень дальняя', ele: 8000 };
    expect(checkPeakVisibility(ORIGIN, 1000, peak, flat, Infinity)).toBeNull();
  });
});
