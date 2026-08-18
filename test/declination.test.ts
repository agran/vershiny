/**
 * Магнитное склонение (core/declination.ts) — сверка с эталоном.
 *
 * Эталон посчитан pygeomag (порт NOAA WMM, общественное достояние) по тем же
 * коэффициентам WMM-2025; точка «Сиэтл 2025.25 = 15.0656°» — документированное
 * контрольное значение самой NOAA. Допуск 0.01°: алгоритм один, разница
 * возможна только от арифметики с плавающей точкой.
 */

import { describe, it, expect } from "vitest";
import { decimalYear, magneticDeclinationDeg } from "../src/core/declination";

describe("магнитное склонение (WMM-2025)", () => {
  const cases = [
    { lat: 43.318, lon: 42.458, year: 2026.63, expect: 7.4751 }, // Эльбрус
    { lat: 61.5, lon: 159.0, year: 2026.63, expect: -9.2282 }, // Камчатка
    { lat: 46.85, lon: 9.53, year: 2026.63, expect: 3.8206 }, // Альпы
    { lat: 64.0, lon: -21.0, year: 2026.63, expect: -10.5596 }, // Исландия
    { lat: -33.87, lon: 151.21, year: 2026.63, expect: 12.8243 }, // Сидней
    { lat: 35.36, lon: 138.73, year: 2026.63, expect: -7.9783 }, // Фудзи
    { lat: 27.98, lon: 86.92, year: 2025.0, expect: 0.2638 }, // Эверест, эпоха
    { lat: 47.62, lon: -122.35, year: 2025.25, expect: 15.0656 }, // Сиэтл, эталон NOAA
    { lat: -3.07, lon: 37.35, year: 2028.0, expect: -0.5702 }, // Килиманджаро
    { lat: 0.0, lon: 0.0, year: 2029.9, expect: -3.4098 }, // край срока модели
    { lat: 89.0, lon: 0.0, year: 2026.0, expect: 11.9881 }, // у полюса
    { lat: -77.85, lon: 166.67, year: 2026.0, expect: 140.2682 }, // Антарктида
  ];

  for (const { lat, lon, year, expect: expected } of cases) {
    it(`(${lat}, ${lon}) на ${year} → ${expected}°`, () => {
      expect(magneticDeclinationDeg(lat, lon, year)).toBeCloseTo(expected, 2);
    });
  }

  it("дату за пределами срока модели прижимает, а не экстраполирует", () => {
    const clamped = magneticDeclinationDeg(43.318, 42.458, 2099.0);
    const atEdge = magneticDeclinationDeg(43.318, 42.458, 2031.0);
    expect(clamped).toBeCloseTo(atEdge, 6);
  });

  it("десятичный год считается от доли года", () => {
    const mid = decimalYear(new Date(Date.UTC(2026, 6, 2, 12)));
    expect(mid).toBeGreaterThan(2026.4);
    expect(mid).toBeLessThan(2026.6);
    expect(decimalYear(new Date(Date.UTC(2026, 0, 1)))).toBe(2026);
  });
});
