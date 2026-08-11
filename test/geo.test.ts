import { describe, expect, it } from 'vitest';
import {
  azimuthRad,
  destination,
  distanceM,
  earthDrop,
  elevationAngleRad,
  toDeg,
  wrapAngle,
  type LatLon,
} from '../src/core/geo';

describe('geo', () => {
  it('азимут на север = 0, на восток = π/2', () => {
    const o: LatLon = { lat: 43, lon: 42 };
    expect(azimuthRad(o, { lat: 44, lon: 42 })).toBeCloseTo(0, 3);
    // На восток по параллели: большой круг стартует чуть севернее 90°
    expect(azimuthRad(o, { lat: 43, lon: 43 })).toBeCloseTo(Math.PI / 2, 1);
    expect(azimuthRad(o, { lat: 43, lon: 43 })).toBeLessThan(Math.PI / 2);
  });

  it('destination обратен distance/azimuth', () => {
    const o: LatLon = { lat: 43.2912, lon: 42.4697 }; // Приют 11
    const p = destination(o, 1.234, 56_789);
    expect(distanceM(o, p)).toBeCloseTo(56_789, 0);
    expect(azimuthRad(o, p)).toBeCloseTo(1.234, 3);
  });

  it('кривизна Земли: на 100 км опускание ~672 м (с рефракцией)', () => {
    // d²·(1−k)/(2R) = 10000²·0.87/12742000 ≈ 683 м
    expect(earthDrop(100_000)).toBeCloseTo(682.7, 0);
  });

  it('угол возвышения учитывает кривизну', () => {
    // Цель той же высоты на 50 км: из-за drop кажется ниже горизонта
    const angle = elevationAngleRad(4000, 4000, 50_000);
    expect(angle).toBeLessThan(0);
    expect(toDeg(angle)).toBeCloseTo(-0.195, 2);
  });

  it('wrapAngle нормализует в (−π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngle(-2.5 * Math.PI)).toBeCloseTo(-Math.PI / 2, 10);
  });
});
