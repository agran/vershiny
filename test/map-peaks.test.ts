/**
 * Базовый слой вершин карты (src/ui/map.ts): отбор по зуму и проекция
 * на экран. От этих функций зависит, что на карте без сети видно вообще
 * хоть что-то — тайлы OpenTopoMap тогда не приходят.
 */

import { describe, it, expect } from "vitest";
import {
  mapPeakLimit,
  selectMapPeaks,
  projectPeaks,
} from "../src/ui/map";
import type { Peak } from "../src/core/peaks";

const peak = (name: string, ele: number, lat = 43, lon = 42): Peak => ({
  name,
  ele,
  lat,
  lon,
});

describe("mapPeakLimit", () => {
  it("на мелком зуме подписываем всё", () => {
    expect(mapPeakLimit(14)).toBe(Infinity);
    expect(mapPeakLimit(17)).toBe(Infinity);
  });

  it("чем дальше, тем меньше подписей", () => {
    expect(mapPeakLimit(11)).toBe(24);
    expect(mapPeakLimit(9)).toBe(12);
    expect(mapPeakLimit(2)).toBe(6);
  });
});

describe("selectMapPeaks", () => {
  const peaks = [
    peak("Холм", 800),
    peak("Гора", 3000),
    peak("Эльбрус", 5642),
    peak("Пригорок", 1200),
    peak("Вершина", 2200),
    peak("Пик", 1800),
    peak("Сопка", 900),
  ];

  it("отбор стабилен к положению камеры: те же вершины при любом центре", () => {
    // Раньше отбор шёл по видимому окну с `peakScore(p, расстояние)`:
    // состав слоя менялся при КАЖДОМ микросдвиге карты — подписи мигали
    // веером. Теперь отбор по чистой значимости, окно влияет только на
    // отрисовку (projectPeaks)
    const count = 500;
    const many = Array.from({ length: count }, (_, i) =>
      peak(`V${i}`, 1000 + ((i * 7919) % 3000), 42 + (i % 25) * 0.05, 41 + ((i / 25) | 0) * 0.07),
    );
    const a = selectMapPeaks(many, 9).map((p) => p.name);
    const b = selectMapPeaks(many, 9).map((p) => p.name);
    expect(a).toEqual(b);
    expect(a).toHaveLength(12); // лимит зума 9
    // Верхушка высоты обязана попасть: при незаданной изоляции счёт = ele
    const top12 = [...many].sort((x, y) => (y.ele ?? 0) - (x.ele ?? 0)).slice(0, 12);
    for (const p of top12) expect(a).toContain(p.name);
  });

  it("берёт N самых высоких на мелком зуме", () => {
    const selected = selectMapPeaks(peaks, 8); // лимит 6
    expect(selected).toHaveLength(6);
    expect(selected.map((p) => p.name)).toContain("Эльбрус");
    expect(selected.map((p) => p.name)).not.toContain("Холм");
  });

  it("на крупном зуме отдаёт всех, но отсортированных по значимости", () => {
    const selected = selectMapPeaks(peaks, 15);
    expect(selected).toHaveLength(peaks.length);
    expect(selected[0].name).toBe("Эльбрус"); // главная — первой (в DOM — последней)
  });

  it("изоляция влияет на отбор: побочный пик группы проигрывает", () => {
    // Жандарм рядом с главной вершиной: высота почти та же, изоляция крошечная
    const group = [
      { ...peak("Главная", 5000), isoM: 20000 },
      { ...peak("Жандарм", 4900), isoM: 200 }, // подчинённая
      { ...peak("Отдельная", 3000), isoM: 20000 },
    ];
    const selected = selectMapPeaks(group, 2); // лимит 6 — возьмёт всех, но порядок важен
    expect(selected[0].name).toBe("Главная");
    // «Отдельная» (3 км, самостоятельная) важнее «Жандарма» (4.9 км, побочного)
    expect(selected.findIndex((p) => p.name === "Отдельная")).toBeLessThan(
      selected.findIndex((p) => p.name === "Жандарм"),
    );
  });
});

describe("projectPeaks", () => {
  const center = { lat: 43, lon: 42 };

  it("вершина в центре — в центре экрана", () => {
    const [p] = projectPeaks([peak("Центр", 1000, 43, 42)], center, 11, 800, 600);
    expect(p.x).toBeCloseTo(400, 5);
    expect(p.y).toBeCloseTo(300, 5);
  });

  it("вершина за краем экрана отсекается", () => {
    const far = peak("Далеко", 1000, 43.5, 42.5); // на z11 — далеко за экраном
    expect(projectPeaks([far], center, 11, 800, 600)).toHaveLength(0);
  });

  it("у антимеридиана вершины по соседству не теряются", () => {
    const edge = { lat: 0, lon: 179.9 };
    const near = peak("Сосед", 1000, 0, -179.9); // 0.2° восточнее — за «краем мира»
    const [p] = projectPeaks([near], edge, 11, 800, 600);
    expect(p).toBeDefined();
    // Кратчайший путь по долготе — через антимеридиан на восток: вершина
    // чуть правее центра, а не «за левым краем мира» в сотнях тысяч пикселей
    expect(p.x).toBeGreaterThan(400);
    expect(p.x).toBeLessThan(800);
  });
});
