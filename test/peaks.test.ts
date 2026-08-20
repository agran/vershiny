/**
 * Эвристика «интересности» вершины: изоляция (расстояние до ближайшей более
 * высокой) как заменитель prominence, которого в OSM практически нет.
 */

import { describe, expect, it } from "vitest";
import {
    annotateIsolation,
    isolationWeight,
    peakScore,
    type Peak,
} from "../src/core/peaks";

/** Вершина по смещению в километрах от условного центра */
function at(kmEast: number, kmNorth: number, ele: number, name = "X"): Peak {
  return {
    lat: 43 + kmNorth / 111.32,
    lon: 42 + kmEast / (111.32 * Math.cos((43 * Math.PI) / 180)),
    ele,
    name,
  };
}

describe("изоляция вершин", () => {
  it("в тесной группе главной становится самая высокая", () => {
    // Три вершины в пределах километра: 4700, 4690, 4680
    const peaks = [
      at(0, 0, 4700, "Главная"),
      at(0.6, 0, 4690, "Побочная A"),
      at(0, 0.8, 4680, "Побочная B"),
    ];
    annotateIsolation(peaks);

    // У побочных изоляция — сотни метров, у главной поиск упёрся в предел
    expect(peaks[1].isoM).toBeCloseTo(600, -2);
    expect(peaks[2].isoM).toBeCloseTo(800, -2);
    expect(peaks[0].isoM!).toBeGreaterThan(30_000);

    // Приоритет подписи: главная выигрывает, хотя разница высот 10-20 м
    const scores = peaks.map((p) => peakScore(p, 10_000));
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[0]).toBeGreaterThan(scores[2]);
  });

  it("одиноко стоящая вершина обгоняет более высокий побочный пик", () => {
    const peaks = [
      at(0, 0, 4000, "Массив главная"),
      at(0.5, 0, 3900, "Массив побочная"),
      at(60, 0, 3600, "Одинокая"),
    ];
    annotateIsolation(peaks);

    expect(peaks[1].isoM).toBeCloseTo(500, -2);
    expect(peaks[2].isoM!).toBeGreaterThan(30_000);

    // С одной дистанции наблюдения одинокая 3600 важнее побочной 3900
    const lonely = peakScore(peaks[2], 20_000);
    const subordinate = peakScore(peaks[1], 20_000);
    expect(lonely).toBeGreaterThan(subordinate);

    // Но главную вершину массива (4000 м) она не обгоняет
    expect(peakScore(peaks[0], 20_000)).toBeGreaterThan(lonely);
  });

  it("вес изоляции растёт логарифмически и насыщается", () => {
    expect(isolationWeight(100)).toBeCloseTo(0.55, 2);
    expect(isolationWeight(300)).toBeCloseTo(0.55, 2);
    expect(isolationWeight(30_000)).toBeCloseTo(1, 2);
    expect(isolationWeight(300_000)).toBeCloseTo(1, 2);
    // Между порогами — монотонный рост
    expect(isolationWeight(3_000)).toBeGreaterThan(isolationWeight(1_000));
    expect(isolationWeight(10_000)).toBeGreaterThan(isolationWeight(3_000));
    // Данных нет — приоритет не меняем
    expect(isolationWeight(undefined)).toBe(1);
  });

  it("вершина без высоты не становится «более высоким соседом» другой", () => {
    // Две безысотные вершины рядом и одна настоящая (3000 м) в 50 км.
    // Первая безысотная раньше вставлялась в сетку как «выше» второй,
    // и изоляция второй считалась до неё, а не до настоящей горы
    const p = (kmEast: number, kmNorth: number, name: string): Peak => ({
      lat: 43 + kmNorth / 111.32,
      lon: 42 + kmEast / (111.32 * Math.cos((43 * Math.PI) / 180)),
      name,
    });
    const peaks: Peak[] = [
      p(0, 0, "Безысотная 1"),
      p(0.1, 0, "Безысотная 2"),
      at(50, 0, 3000, "Настоящая"),
    ];
    annotateIsolation(peaks);

    // Обе изолированы от настоящей вершины, а не друг от друга
    expect(peaks[0].isoM).toBeGreaterThan(10_000);
    expect(peaks[1].isoM).toBeGreaterThan(10_000);
  });

  it("справляется с крупным регионом за разумное время", () => {
    // 50 тыс. вершин на 600×600 км — как iberia.json
    const peaks: Peak[] = [];
    let seed = 1;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 50_000; i++) {
      peaks.push(at(rnd() * 600, rnd() * 600, 500 + rnd() * 3000));
    }
    const t0 = performance.now();
    annotateIsolation(peaks);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(peaks.every((p) => p.isoM !== undefined)).toBe(true);
  });
});
