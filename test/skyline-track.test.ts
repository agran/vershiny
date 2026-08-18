/**
 * Временна́я стабилизация профиля неба (core/skyline-track.ts).
 *
 * Проверяются три свойства: одиночный кадр проходит без изменений (режим
 * совместимости), дрожание камеры выравнивается кросс-корреляцией, а зона,
 * где линия ползёт между кадрами (облако над гребнем), уходит в честный
 * NaN — то, чего покадровый экстрактор не умеет в принципе.
 */

import { describe, it, expect } from "vitest";
import { SkylineTracker } from "../src/core/skyline-track";

const W = 160;

/** Гладкий профиль с двумя вершинами — «штрихкод» гребня, доли высоты кадра */
function trueProfile(): Float32Array {
  const p = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    p[x] =
      0.62 -
      0.1 * Math.sin((6 * Math.PI * x) / W) -
      0.175 * Math.exp(-(((x - 40) / 6) ** 2)) -
      0.125 * Math.exp(-(((x - 70) / 4) ** 2));
  }
  return p;
}

/** Сдвиг профиля на s колонок: out[x] = p[x − s], края — NaN */
function shifted(p: Float32Array, s: number): Float32Array {
  const out = new Float32Array(W).fill(NaN);
  for (let x = 0; x < W; x++) {
    const xs = x - s;
    if (xs >= 0 && xs < W) out[x] = p[xs];
  }
  return out;
}

/** Медиана |est − true| по колонкам, где оба значения есть, доли кадра */
function medianErr(est: Float32Array, truth: Float32Array): number {
  const errs: number[] = [];
  for (let x = 0; x < W; x++) {
    if (!Number.isNaN(est[x]) && !Number.isNaN(truth[x])) {
      errs.push(Math.abs(est[x] - truth[x]));
    }
  }
  errs.sort((a, b) => a - b);
  return errs[errs.length >> 1] ?? Infinity;
}

describe("временна́я стабилизация профиля неба", () => {
  it("одиночный кадр проходит как есть", () => {
    const p = trueProfile();
    p[10] = NaN; // дыра должна сохраниться дырой
    const tracker = new SkylineTracker(8);
    const out = tracker.push(p);
    for (let x = 0; x < W; x++) {
      if (Number.isNaN(p[x])) expect(Number.isNaN(out.profile[x])).toBe(true);
      else expect(out.profile[x]).toBeCloseTo(p[x], 5);
    }
  });

  it("выравнивает дрожание камеры на ±2 колонки", () => {
    const p = trueProfile();
    const tracker = new SkylineTracker(8);
    const shakes = [0, 2, -1, 2, -2, 1, 0, -1];
    let out = tracker.push(shifted(p, shakes[0]));
    for (let k = 1; k < shakes.length; k++) {
      out = tracker.push(shifted(p, shakes[k]));
    }
    // В середине кадра (края страдают от NaN при сдвигах) профиль вернулся
    // к истине: дрожание скомпенсировано
    const est = out.profile.slice(10, W - 10);
    const truth = p.slice(10, W - 10);
    expect(medianErr(est, truth)).toBeLessThan(0.01);
  });

  it("ползущее облако над гребнем уходит в NaN, гребень остаётся", () => {
    const p = trueProfile();
    const tracker = new SkylineTracker(8);
    const cloudFrom = 40;
    const cloudTo = 80;
    let out = tracker.push(p);
    for (let k = 1; k < 10; k++) {
      const frame = Float32Array.from(p);
      // Ложная граница «небо/облако» ползёт по высоте от кадра к кадру
      for (let x = cloudFrom; x < cloudTo; x++) {
        frame[x] = p[x] - 0.08 + 0.06 * Math.sin((2 * Math.PI * k) / 8);
      }
      out = tracker.push(frame);
    }
    // Облачная зона нестабильна — колонки отброшены
    for (let x = cloudFrom + 5; x < cloudTo - 5; x++) {
      expect(Number.isNaN(out.profile[x])).toBe(true);
    }
    // Чистый гребень вне облака стабилен и совпадает с истиной
    for (const x of [20, 30, 100, 130]) {
      expect(out.profile[x]).toBeCloseTo(p[x], 2);
    }
  });

  it("после reset выравнивание начинается заново", () => {
    const p = trueProfile();
    const tracker = new SkylineTracker(8);
    for (const s of [0, 2, -2]) tracker.push(shifted(p, s));
    tracker.reset();
    // Сдвинутый кадр после сброса — новая опора, сдвига нет
    const out = tracker.push(shifted(p, 3));
    expect(out.shift).toBe(0);
    expect(medianErr(out.profile, shifted(p, 3))).toBeLessThan(1e-6);
  });
});
