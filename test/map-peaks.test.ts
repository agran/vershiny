/**
 * Базовый слой вершин карты (src/ui/map.ts): отбор по зуму и проекция
 * на экран. От этих функций зависит, что на карте без сети видно вообще
 * хоть что-то — тайлы OpenTopoMap тогда не приходят.
 */

import { describe, it, expect } from "vitest";
import {
  MAP_PEAK_CANDIDATE_CAP,
  mapPeakLabelSize,
  selectMapPeaks,
  projectPeaks,
  placeMapPeakLabels,
  createLabelLayoutState,
} from "../src/ui/map";
import type { Peak } from "../src/core/peaks";

const peak = (name: string, ele: number, lat = 43, lon = 42): Peak => ({
  name,
  ele,
  lat,
  lon,
});

describe("потолки слоя вершин", () => {
  it("кадр не отдаёт больше страховочного потолка кандидатов", () => {
    // Реальный предел подписей — размещение без перекрытий (placeMapPeakLabels);
    // здесь лишь защита от плотного кадра (сортировка/проекция/DOM)
    const count = MAP_PEAK_CANDIDATE_CAP + 100;
    const many = Array.from({ length: count }, (_, i) =>
      peak(`V${i}`, 1000 + i, 42 + (i % 30) * 0.02, 41 + ((i / 30) | 0) * 0.02),
    );
    const selected = selectMapPeaks(many, 11);
    expect(selected).toHaveLength(MAP_PEAK_CANDIDATE_CAP);
    expect(selected[0].name).toBe(`V${count - 1}`); // самая высокая — первой
  });

  it("оценка подписи ограничена max-width из стилей метки", () => {
    expect(mapPeakLabelSize("Фишт 2854").w).toBeLessThan(148);
    expect(mapPeakLabelSize(`${"О".repeat(100)} 5000`).w).toBe(148);
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
      peak(
        `V${i}`,
        1000 + ((i * 7919) % 3000),
        42 + (i % 25) * 0.05,
        41 + ((i / 25) | 0) * 0.07,
      ),
    );
    const a = selectMapPeaks(many, 9).map((p) => p.name);
    const b = selectMapPeaks(many, 9).map((p) => p.name);
    expect(a).toEqual(b);
    expect(a).toHaveLength(MAP_PEAK_CANDIDATE_CAP);
    // Верхушка высоты обязана попасть: при незаданной изоляции счёт = ele
    const top = [...many]
      .sort((x, y) => (y.ele ?? 0) - (x.ele ?? 0))
      .slice(0, MAP_PEAK_CANDIDATE_CAP);
    for (const p of top) expect(a).toContain(p.name);
  });

  it("кандидаты не режутся по счёту: все вершины кадра, в порядке значимости", () => {
    // Регрессия: фиксированный «топ-N на зум» вытеснял вершину из подписей,
    // когда в кадр входили более значимые соседи, даже при свободном месте
    // на экране. Теперь счёт ограничен только страховочным потолком, а
    // перекрытия разрешает renderPeaks
    const selected = selectMapPeaks(peaks, 8);
    expect(selected).toHaveLength(peaks.length);
    expect(selected[0].name).toBe("Эльбрус");
    expect(selected[selected.length - 1].name).toBe("Холм");
  });

  it("на крупном зуме отдаёт всех, но отсортированных по значимости", () => {
    const selected = selectMapPeaks(peaks, 15);
    expect(selected).toHaveLength(peaks.length);
    expect(selected[0].name).toBe("Эльбрус"); // главная — первой (в DOM — последней)
  });

  it("одноимённые дедуплицируются при отборе: выживает главная", () => {
    // Регрессия: раньше дедуп был в renderPeaks ПОСЛЕ лимита и шёл с хвоста —
    // пачка однофамильцев съедала квоту, на экране оставалось меньше
    // подписей, чем позволяет зум, а главную из одноимённых выкидывало
    const many = [
      peak("Пик №3", 3000, 43.0, 42.0),
      peak("Пик №3", 2900, 43.01, 42.01),
      peak("Пик №3", 2800, 43.02, 42.02),
      peak("Альфа", 2500, 43.03, 42.03),
      peak("Бета", 2400, 43.04, 42.04),
      peak("Гамма", 2300, 43.05, 42.05),
      peak("Дельта", 2200, 43.06, 42.06),
      peak("Эпсилон", 2100, 43.07, 42.07),
    ];
    const selected = selectMapPeaks(many, 2);
    const names = selected.map((p) => p.name);
    expect(selected).toHaveLength(6); // 8 минус два одноимённых дубля
    expect(names.filter((n) => n === "Пик №3")).toHaveLength(1);
    expect(selected.find((p) => p.name === "Пик №3")?.ele).toBe(3000); // главная
    expect(names).toContain("Эпсилон"); // слабая, но уникальная — влезла
  });

  it("безымянные вершины не схлопываются в одну метку", () => {
    // В OSM имя есть не у всех natural=peak (name пуст); peakName даёт
    // заглушку '—', и раньше такие вершины дедуплицировались друг в друга:
    // одна метка на весь кадр
    const unnamed: Peak[] = Array.from({ length: 4 }, (_, i) => ({
      name: "",
      ele: 1000 + i * 100,
      lat: 43 + i * 0.01,
      lon: 42,
    }));
    expect(selectMapPeaks(unnamed, 9)).toHaveLength(4);
  });

  it("на крупном зуме одноимённые показываются все", () => {
    const twins = [
      peak("Двойня", 3000, 43.0, 42.0),
      peak("Двойня", 2900, 43.001, 42.001),
    ];
    expect(selectMapPeaks(twins, 14)).toHaveLength(2);
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

describe("selectMapPeaks с кадром карты", () => {
  it("лимит идёт по вершинам в кадре, а не по всему региону", () => {
    // Регрессия: из Краснодара (кадр z11 вокруг 44.98, 38.98) карта показывала
    // Эльбрус и соседей — глобальный топ региона, — а стоящий на виду Оштен
    // в лимит не проходил. Теперь сначала кадр, потом топ-N внутри него.
    const many = [
      // далеко за кадром, но очень значимые
      peak("Эльбрус", 5642, 43.35, 42.44),
      peak("Дыхтау", 5205, 43.05, 43.13),
      peak("Казбек", 5054, 42.7, 44.5),
      // в кадре — скромнее, но свои
      peak("Оштен", 2804, 43.997, 39.929),
      peak("Фишт", 2854, 43.953, 39.903),
      peak("Пшеха-Су", 2744, 43.99, 39.83),
    ];
    // Кадр: Фишт-Оштеновский массив (как из Краснодара, но придвинутый на запад)
    const selected = selectMapPeaks(
      many,
      11,
      { lat: 44.0, lon: 39.87 },
      800,
      600,
    );
    const names = selected.map((p) => p.name);
    expect(names).toContain("Оштен");
    expect(names).toContain("Фишт");
    expect(names).not.toContain("Эльбрус");
  });

  it("без кадра отдаёт весь набор (до страховочного потолка)", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      peak(
        `V${i}`,
        1000 + i * 100,
        42 + (i % 6) * 0.05,
        41 + ((i / 6) | 0) * 0.07,
      ),
    );
    const selected = selectMapPeaks(many, 9);
    expect(selected).toHaveLength(30);
    expect(selected[0].name).toBe("V29"); // порядок — по значимости
  });

  it("кадр у антимеридиана не теряет вершины за ±180°", () => {
    const p = peak("Сосед", 1000, 0, -179.9);
    const selected = selectMapPeaks([p], 11, { lat: 0, lon: 179.9 }, 800, 600);
    expect(selected).toHaveLength(1);
  });
});

describe("projectPeaks", () => {
  const center = { lat: 43, lon: 42 };

  it("вершина в центре — в центре экрана", () => {
    const [p] = projectPeaks(
      [peak("Центр", 1000, 43, 42)],
      center,
      11,
      800,
      600,
    );
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

describe("placeMapPeakLabels", () => {
  // В тестовом окружении canvas-замер недоступен → ширина ≈ 6.5px/символ + 8
  const item = (key: string, x: number, y: number, text = key) => ({
    key,
    text,
    x,
    y,
  });

  it("размещает всех, пока подписи не перекрываются", () => {
    const state = createLabelLayoutState();
    const placed = placeMapPeakLabels(
      [item("a", 100, 100), item("b", 400, 100), item("c", 100, 400)],
      state,
    );
    expect(placed).toHaveLength(3);
    expect(placed.every((p) => p.shift === 0)).toBe(true); // всем хватило центра
  });

  it("при нехватке места подпись уходит на сдвинутый якорь, а не пропадает", () => {
    const state = createLabelLayoutState();
    const placed = placeMapPeakLabels(
      [item("a", 100, 100), item("b", 130, 100, "оченьдлинноеимя 9999")],
      state,
    );
    const b = placed.find((p) => p.key === "b");
    expect(b).toBeDefined();
    expect(b!.shift).not.toBe(0);
  });

  it("совсем тесная метка пропускается, но не рвёт остальных", () => {
    const state = createLabelLayoutState();
    // «b» в той же точке, что и «a»: ни один из трёх якорей не влезает
    const placed = placeMapPeakLabels(
      [item("a", 100, 100), item("b", 100, 100), item("c", 500, 100)],
      state,
    );
    expect(placed.map((p) => p.key)).toEqual(["a", "c"]);
  });

  it("липкость: вошедшая более значимая вершина не выбивает уже стоящую", () => {
    // Регрессия: пользователь ведёт карту к вершине у края, в кадр входят
    // более значимые соседи — и целевая исчезала, хотя место на экране было
    const state = createLabelLayoutState();
    // Кадр 1: целевая стоит одна
    placeMapPeakLabels([item("target", 200, 200)], state);
    // Кадр 2: новичок значимее (первым в списке) и почти в той же точке —
    // без липкости он занял бы центр, а «target» не влез бы ни в один якорь
    const placed = placeMapPeakLabels(
      [item("new", 200, 200), item("target", 200, 200)],
      state,
    );
    expect(placed.map((p) => p.key)).toContain("target");
  });

  it("приподнятая сдвинутая подпись не наезжает на вершину выше неё", () => {
    const state = createLabelLayoutState();
    const placed = placeMapPeakLabels(
      [
        item("a", 100, 100),
        // «b» тесно с «a» — уходит на правый якорь и приподнимается (LABEL_LIFT)
        item("b", 108, 100, "оченьдлинноеимя 9999"),
        // «c» стоит над сдвинутой подписью «b»: без учёта подъёма её центральный
        // якорь влезал бы впритык под метку, на которую она визуально наехала
        item("c", 200, 68),
      ],
      state,
    );
    const b = placed.find((p) => p.key === "b");
    expect(b!.shift).toBeGreaterThan(0);
    // Все якоря «c» пересекают приподнятый бокс «b» — метка честно пропущена
    expect(placed.find((p) => p.key === "c")).toBeUndefined();
  });

  it("липкий якорь не прыгает: метка держит прошлую сторону, пока она свободна", () => {
    const state = createLabelLayoutState();
    placeMapPeakLabels(
      [item("a", 100, 100), item("b", 130, 100, "оченьдлинноеимя 9999")],
      state,
    );
    // Кадр 2: «a» ушла, у «b» центр свободен — но якорь липкий, не дёргаемся
    const placed = placeMapPeakLabels(
      [item("b", 130, 100, "оченьдлинноеимя 9999")],
      state,
    );
    expect(placed[0].shift).not.toBe(0);
  });
});
