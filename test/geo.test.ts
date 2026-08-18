import { describe, expect, it } from "vitest";
import {
  azimuthRad,
  bboxContains,
  destination,
  distanceM,
  earthDrop,
  elevationAngleRad,
  isValidLatLon,
  normalizeAz,
  normalizeLon,
  toDeg,
  wrapAngle,
  type LatLon,
} from "../src/core/geo";

describe("geo", () => {
  it("азимут на север = 0, на восток = π/2", () => {
    const o: LatLon = { lat: 43, lon: 42 };
    expect(azimuthRad(o, { lat: 44, lon: 42 })).toBeCloseTo(0, 3);
    // На восток по параллели: большой круг стартует чуть севернее 90°
    expect(azimuthRad(o, { lat: 43, lon: 43 })).toBeCloseTo(Math.PI / 2, 1);
    expect(azimuthRad(o, { lat: 43, lon: 43 })).toBeLessThan(Math.PI / 2);
  });

  it("destination обратен distance/azimuth", () => {
    const o: LatLon = { lat: 43.2912, lon: 42.4697 }; // Приют 11
    const p = destination(o, 1.234, 56_789);
    expect(distanceM(o, p)).toBeCloseTo(56_789, 0);
    expect(azimuthRad(o, p)).toBeCloseTo(1.234, 3);
  });

  it("кривизна Земли: на 100 км опускание ~672 м (с рефракцией)", () => {
    // d²·(1−k)/(2R) = 10000²·0.87/12742000 ≈ 683 м
    expect(earthDrop(100_000)).toBeCloseTo(682.7, 0);
  });

  it("угол возвышения учитывает кривизну", () => {
    // Цель той же высоты на 50 км: из-за drop кажется ниже горизонта
    const angle = elevationAngleRad(4000, 4000, 50_000);
    expect(angle).toBeLessThan(0);
    expect(toDeg(angle)).toBeCloseTo(-0.195, 2);
  });

  it("wrapAngle нормализует в (−π, π]", () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngle(-2.5 * Math.PI)).toBeCloseTo(-Math.PI / 2, 10);
  });

  it("разность азимутов через wrapAngle, а не через %", () => {
    // Остаток в JS сохраняет знак делимого: ((0 − 6 + π) % 2π) − π = −6,
    // то есть «расхождение 6 рад» вместо настоящих 0.28. На этом автонаклон
    // брал медиану чужого сектора, а маркеры вершин — не тот фронт
    const naive = Math.abs(((0 - 6.0 + Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(naive).toBeCloseTo(6.0, 6);
    expect(Math.abs(wrapAngle(0 - 6.0))).toBeCloseTo(0.2832, 3);
  });

  it("normalizeAz приводит азимут к [0, 2π)", () => {
    // Свайп крутит камеру вычитанием без границ: азимут уходит и в минус,
    // и за 2π, а вся арифметика вокруг считает его нормальным
    expect(normalizeAz(-0.5)).toBeCloseTo(2 * Math.PI - 0.5, 10);
    expect(normalizeAz(7 * Math.PI)).toBeCloseTo(Math.PI, 10);
    expect(normalizeAz(1.2)).toBeCloseTo(1.2, 10);
    expect(normalizeAz(0)).toBe(0);
  });

  it("isValidLatLon отбраковывает мусор из ?lat=/lon=", () => {
    expect(isValidLatLon({ lat: 43.3, lon: 42.4 })).toBe(true);
    expect(isValidLatLon({ lat: 999, lon: 42.4 })).toBe(false);
    expect(isValidLatLon({ lat: 43.3, lon: 200 })).toBe(false);
    expect(isValidLatLon({ lat: NaN, lon: 0 })).toBe(false);
    // Границы диапазона законны: полюс и антимеридиан
    expect(isValidLatLon({ lat: 90, lon: -180 })).toBe(true);
  });

  it("destination не выпускает долготу за антимеридиан", () => {
    // За 180° счёт продолжался: 180.84°. Арифметически честно, но каждый
    // потребитель считает такую долготу «за краем мира» — Terrarium зажимал
    // индекс тайла в нулевой, пирамида отсекала точку по gx < 0, и у
    // наблюдателя на Врангеле оба источника молчали разом
    const west = destination({ lat: 71.2, lon: -180 }, -Math.PI / 2, 30_000);
    const east = destination({ lat: 71.2, lon: 180 }, Math.PI / 2, 30_000);
    expect(west.lon).toBeGreaterThan(0); // ушли за −180 и вернулись справа
    expect(east.lon).toBeLessThan(0);
    for (const p of [west, east]) {
      expect(isValidLatLon(p)).toBe(true);
      expect(Math.abs(p.lon)).toBeLessThanOrEqual(180);
    }
    // Точка та же самая: расстояние до неё честные 30 км
    expect(distanceM({ lat: 71.2, lon: 180 }, east)).toBeCloseTo(30_000, 0);
  });

  it("bboxContains: bbox через антимеридиан (Врангель, 177.5…−177.5)", () => {
    const wrangel: [number, number, number, number] = [177.5, 70.5, -177.5, 72];
    expect(bboxContains({ lat: 71.2, lon: 179.9 }, wrangel)).toBe(true);
    expect(bboxContains({ lat: 71.2, lon: -179.9 }, wrangel)).toBe(true);
    expect(bboxContains({ lat: 71.2, lon: 0 }, wrangel)).toBe(false);
    expect(bboxContains({ lat: 71.2, lon: 170 }, wrangel)).toBe(false);
    expect(bboxContains({ lat: 73, lon: 179 }, wrangel)).toBe(false); // шире по широте
    // Обычный bbox без перехода
    const elbrus: [number, number, number, number] = [42, 42.8, 44.5, 43.8];
    expect(bboxContains({ lat: 43.35, lon: 42.44 }, elbrus)).toBe(true);
    expect(bboxContains({ lat: 43.35, lon: 45 }, elbrus)).toBe(false);
  });

  it("normalizeLon: край диапазона и многократные обороты", () => {
    expect(normalizeLon(180)).toBe(-180); // 180 и −180 — одна долгота
    expect(normalizeLon(-180)).toBe(-180);
    expect(normalizeLon(180.837)).toBeCloseTo(-179.163, 6);
    expect(normalizeLon(-540.5)).toBeCloseTo(179.5, 6);
    expect(normalizeLon(42.4)).toBeCloseTo(42.4, 10);
  });
});
