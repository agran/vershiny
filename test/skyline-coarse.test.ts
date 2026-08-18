/**
 * Грубое совмещение по полному кругу (core/skyline-match.ts).
 *
 * Главное свойство: камера, повёрнутая на ЛЮБОЙ угол (включая 90° и 180°,
 * куда оконный поиск ±25° не достаёт), должна находиться корреляцией. Кадр
 * синтетический, по тому же профилю рельефа — настоящая камера не нужна.
 */

import { describe, it, expect } from "vitest";
import {
  matchSkylineCoarse,
  type CoarseMatchOptions,
} from "../src/core/skyline-match";

const deg = (d: number): number => (d * Math.PI) / 180;
const RAYS = 3600;
const STEP = (2 * Math.PI) / RAYS;

/** Горизонт с узнаваемым гребнем: две вершины и седловина (как в skyline.test) */
function makeHorizon(): Float32Array {
  const horizon = new Float32Array(RAYS);
  for (let i = 0; i < RAYS; i++) {
    const az = i * STEP;
    horizon[i] =
      deg(4) * Math.sin(az * 3) +
      deg(7) * Math.exp(-(((az - 1.0) / 0.12) ** 2)) +
      deg(5) * Math.exp(-(((az - 1.35) / 0.08) ** 2));
  }
  return horizon;
}
const HORIZON = makeHorizon();

const FOV = deg(70);

/**
 * Профиль кадра (как его отдал бы matchSkyline): углы возвышения по колонкам
 * слева направо для камеры, смотрящей на azTrue с наклоном tiltTrue.
 */
function frameProfile(azTrue: number, tiltTrue: number, cols = 160): number[] {
  const out: number[] = [];
  for (let x = 0; x < cols; x++) {
    const az = azTrue + ((x + 0.5) / cols - 0.5) * FOV;
    const idx = az / STEP;
    const i0 = Math.floor(idx);
    const f = idx - i0;
    const a = HORIZON[((i0 % RAYS) + RAYS) % RAYS];
    const b = HORIZON[(((i0 + 1) % RAYS) + RAYS) % RAYS];
    out.push(a + (b - a) * f - tiltTrue);
  }
  return out;
}

function opts(azGuess: number, frameElev: number[]): CoarseMatchOptions {
  return {
    horizon: HORIZON,
    stepRad: STEP,
    frameElev,
    // leftAzRad — то, что видит приложение: левый край по показаниям компаса.
    // Поиск полный, поэтому догадка на результат не влияет — лишь сдвигает
    // ответ абсолютно (как и положено: ответ = где мы на самом деле).
    leftAzRad: azGuess - FOV / 2,
    fovRad: FOV,
  };
}

describe("грубое совмещение по полному кругу", () => {
  it("компас врёт на 180°: лучшая гипотеза — всё равно истинное окно", () => {
    // Ответ модуля — азимут в координатах ДОГАДКИ (leftAzRad компаса):
    // поправка = ответ − догадка. Компас врёт на 180° → ждём поправку −180°.
    const azTrue = deg(60);
    const frame = frameProfile(azTrue, 0);
    const hyps = matchSkylineCoarse(opts(azTrue + Math.PI, frame));

    expect(hyps.length).toBeGreaterThan(0);
    // Ответ — АБСОЛЮТНЫЙ азимут центра кадра (от истинного севера), независимо
    // от догадки компаса: именно в этом смысл поиска по полному кругу
    const gotDeg = ((hyps[0].centerAzRad * 180) / Math.PI + 360) % 360;
    const azTrueDeg = (azTrue * 180) / Math.PI;
    const errDeg = Math.abs(((gotDeg - azTrueDeg + 540) % 360) - 180);
    expect(errDeg).toBeLessThan(2);
    expect(hyps[0].score).toBeGreaterThan(0.9);
  });

  it("находит кадр при ошибке компаса в 90°", () => {
    const azTrue = deg(200);
    const frame = frameProfile(azTrue, 0);
    const hyps = matchSkylineCoarse(opts(azTrue + deg(90), frame));

    // Гармоника sin(3·az) периодична на 120°: грубый этап законно держит
    // несколько одинаково сильных гипотез (истина 200° + 120°к = …, 320°, …).
    // Истина обязана быть СРЕДИ них — разбирать их дальше уровень B/якоря.
    const azTrueDeg = (azTrue * 180) / Math.PI;
    const found = hyps.some((h) => {
      const gotDeg = ((h.centerAzRad * 180) / Math.PI + 360) % 360;
      return Math.abs(((gotDeg - azTrueDeg + 540) % 360) - 180) < 2;
    });
    expect(found).toBe(true);
  });

  it("ошибка наклона не мешает: коррелируется форма, а не высоты", () => {
    const azTrue = deg(120);
    // Камера наклонена на 3° вверх относительно того, что думает приложение
    const frame = frameProfile(azTrue, deg(3));
    const hyps = matchSkylineCoarse(opts(azTrue + deg(45), frame));

    const gotDeg = ((hyps[0].centerAzRad * 180) / Math.PI + 360) % 360;
    const azTrueDeg = (azTrue * 180) / Math.PI;
    const errDeg = Math.abs(((gotDeg - azTrueDeg + 540) % 360) - 180);
    expect(errDeg).toBeLessThan(2);
  });

  it("плоский кадр (равнина/туман) — честный отказ, а не мусор", () => {
    const flat = Array.from({ length: 160 }, () => deg(1));
    expect(matchSkylineCoarse(opts(0, flat))).toEqual([]);
  });

  it("почти все колонки без границы — отказ", () => {
    const mostlyNaN = Array.from({ length: 160 }, (_, i) =>
      i < 20 ? deg(2) + Math.sin(i) * deg(1) : NaN,
    );
    expect(matchSkylineCoarse(opts(0, mostlyNaN))).toEqual([]);
  });

  it("рождает гипотезы с мерой однозначности против второго разного пика", () => {
    const frame = frameProfile(deg(60), 0);
    const hyps = matchSkylineCoarse(opts(deg(100), frame));
    expect(hyps.length).toBeGreaterThan(0);
    // Разрыв лучшего с вторым РАЗНЫМ максимумом (не соседом) — мера
    // однозначности; на узнаваемом гребне он должен быть заметным
    expect(hyps[0].uniqueness).toBeGreaterThan(1);
    expect(hyps[0].score).toBeGreaterThan(0.9);
  });
});
