/**
 * Матрица направления взгляда (core/orientation.ts, lookFromDeviceOrientation):
 * независимая проверка по полной матрице поворота W3C.
 *
 * Эталон считается в самом тесте обычным умножением матриц 3×3, а НЕ
 * формулами модуля: если аналитика и тест выведут одну и ту же ошибку,
 * она пройдёт как «правильный» результат. Плюс точки вырождения
 * (β ≈ ±90°, β ≈ 0) — именно там исторически уезжала панорама.
 *
 * Свойства, которые проверяются:
 *   - сетка + случайные тройки (α, β, γ) против эталонной матрицы;
 *   - четыре квадранта азимута с выписанными вручную ответами;
 *   - вырождение β=0/γ=0 (телефон плашмя): наклон ±90°, азимут конечен;
 *   - крен вокруг оси взгляда при β=90°: (α+φ, 90, γ−φ) — та же поза;
 *   - альтернативное представление той же позы: (α+180, −β, −γ);
 *   - переход портрет → ландшафт: три представления одной позы;
 *   - гироскоп: проекция rotationRate на земную вертикаль согласована
 *     с изменением азимута, которое даёт эталонная матрица.
 */

import { describe, expect, it } from "vitest";
import {
    lookFromDeviceOrientation,
    verticalRateFromGyro,
} from "../src/core/orientation";

const RAD = Math.PI / 180;
const deg = (rad: number): number => (rad * 180) / Math.PI;
const norm = (rad: number): number => {
  let a = rad % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a;
};

// --- Эталонная реализация: полные матрицы ---

function rotZ(t: number): number[][] {
  const [s, c] = [Math.sin(t), Math.cos(t)];
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}

function rotX(t: number): number[][] {
  const [s, c] = [Math.sin(t), Math.cos(t)];
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
}

function rotY(t: number): number[][] {
  const [s, c] = [Math.sin(t), Math.cos(t)];
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
}

function mul(a: number[][], b: number[][]): number[][] {
  return a.map((row) =>
    b[0].map((_, j) => row.reduce((sum, v, k) => sum + v * b[k][j], 0)),
  );
}

/**
 * Эталон направления взгляда: R = Rz(α)·Rx(β)·Ry(γ), взгляд = −(3-й столбец).
 * Оси Земли по спецификации: X — восток, Y — север, Z — вверх.
 */
function lookRef(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
): { azimuthRad: number; elevationRad: number } {
  const r = mul(mul(rotZ(alphaDeg * RAD), rotX(betaDeg * RAD)), rotY(gammaDeg * RAD));
  const look = [-r[0][2], -r[1][2], -r[2][2]];
  const horizontal = Math.hypot(look[0], look[1]);
  return {
    azimuthRad: norm(Math.atan2(look[0], look[1])),
    elevationRad: Math.atan2(look[2], horizontal),
  };
}

function expectSameLook(
  actual: { azimuthRad: number; elevationRad: number },
  expected: { azimuthRad: number; elevationRad: number },
): void {
  expect(Math.abs(actual.elevationRad - expected.elevationRad)).toBeLessThan(
    1e-9,
  );
  // При почти вертикальном взгляде горизонтальная проекция ≈ 0, и азимут
  // физически не определён: sin(π) в плавающей точке — это 1e-16, из-за
  // чего atan2 двух «нулей» скачет на π от пути округления. Требуем только,
  // чтобы азимут оставался конечным числом (NaN заражал бы всю отрисовку)
  if (Math.abs(expected.elevationRad) > (Math.PI / 2 - 1e-6)) {
    expect(Number.isFinite(actual.azimuthRad)).toBe(true);
    return;
  }
  // Азимут сравниваем по кратчайшей дуге: 359.999° и 0.001° — одно и то же
  const d = Math.abs(norm(actual.azimuthRad - expected.azimuthRad));
  expect(Math.min(d, 2 * Math.PI - d)).toBeLessThan(1e-9);
}

/** Детерминированный псевдослучайный генератор (тесты воспроизводимы) */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("lookFromDeviceOrientation против эталонной матрицы", () => {
  it("сетка 15° по всем трём углам", () => {
    for (let a = 0; a < 360; a += 15) {
      for (let b = -180; b <= 180; b += 15) {
        for (let g = -90; g <= 90; g += 15) {
          expectSameLook(
            lookFromDeviceOrientation(a, b, g),
            lookRef(a, b, g),
          );
        }
      }
    }
  });

  it("случайные тройки углов (детерминированная выборка)", () => {
    const rand = lcg(42);
    for (let i = 0; i < 300; i++) {
      const a = rand() * 720 - 360; // за пределами [0,360) тоже
      const b = rand() * 540 - 270;
      const g = rand() * 360 - 180;
      expectSameLook(
        lookFromDeviceOrientation(a, b, g),
        lookRef(a, b, g),
      );
    }
  });
});

describe("четыре квадранта азимута (ответы выписаны вручную)", () => {
  it("портрет β=90°: азимут = −(α+γ)", () => {
    // (0, 90, −45): z = (sin(−45), −cos(−45), 0), взгляд (√2/2, √2/2, 0) — северо-восток
    expect(deg(lookFromDeviceOrientation(0, 90, -45).azimuthRad)).toBeCloseTo(
      45,
      9,
    );
    expect(deg(lookFromDeviceOrientation(0, 90, -135).azimuthRad)).toBeCloseTo(
      135,
      9,
    );
    expect(deg(lookFromDeviceOrientation(0, 90, 135).azimuthRad)).toBeCloseTo(
      225,
      9,
    );
    expect(deg(lookFromDeviceOrientation(0, 90, 45).azimuthRad)).toBeCloseTo(
      315,
      9,
    );
    // Наклон при β=90° всегда нулевой, что бы ни делали α и γ
    expect(deg(lookFromDeviceOrientation(0, 90, -45).elevationRad)).toBeCloseTo(
      0,
      9,
    );
  });

  it("ландшафт γ=90°: азимут = (270° − α) mod 360", () => {
    expect(deg(lookFromDeviceOrientation(180, 0, 90).azimuthRad)).toBeCloseTo(
      90,
      9,
    ); // восток
    expect(deg(lookFromDeviceOrientation(225, 0, 90).azimuthRad)).toBeCloseTo(
      45,
      9,
    ); // северо-восток
    expect(deg(lookFromDeviceOrientation(315, 0, 90).azimuthRad)).toBeCloseTo(
      315,
      9,
    ); // северо-запад
    expect(deg(lookFromDeviceOrientation(45, 0, 90).azimuthRad)).toBeCloseTo(
      225,
      9,
    ); // юго-запад
  });

  it("ландшафт γ=−90°: азимут = (90° − α) mod 360", () => {
    expect(deg(lookFromDeviceOrientation(180, 0, -90).azimuthRad)).toBeCloseTo(
      270,
      9,
    ); // запад
    expect(deg(lookFromDeviceOrientation(0, 0, -90).azimuthRad)).toBeCloseTo(
      90,
      9,
    ); // восток
    expect(deg(lookFromDeviceOrientation(45, 0, -90).azimuthRad)).toBeCloseTo(
      45,
      9,
    ); // северо-восток
  });
});

describe("точки вырождения", () => {
  it("телефон плашмя экраном вверх (β=0, γ=0): взгляд вниз, азимут конечен", () => {
    const flat = lookFromDeviceOrientation(0, 0, 0);
    expect(deg(flat.elevationRad)).toBeCloseTo(-90, 9);
    expect(Number.isFinite(flat.azimuthRad)).toBe(true);
    // Любое α: горизонтальная проекция нулевая, NaN в азимут не попадает
    for (const a of [0, 45, 123, 333]) {
      const v = lookFromDeviceOrientation(a, 0, 0);
      expect(Number.isFinite(v.azimuthRad)).toBe(true);
      expect(deg(v.elevationRad)).toBeCloseTo(-90, 9);
    }
  });

  it("телефон плашмя экраном вниз (β=180): взгляд в зенит, азимут конечен", () => {
    const up = lookFromDeviceOrientation(0, 180, 0);
    expect(deg(up.elevationRad)).toBeCloseTo(90, 9);
    expect(Number.isFinite(up.azimuthRad)).toBe(true);
  });

  it("перевёрнутый портрет (β=−90°): азимут = (γ − α + 180) mod 360", () => {
    // Тот же поднятый вертикально телефон, но экран смотрит в другую сторону:
    // взгляд разворачивается на 180°, наклон остаётся нулевым
    expect(deg(lookFromDeviceOrientation(0, -90, 0).azimuthRad)).toBeCloseTo(
      180,
      9,
    );
    expect(deg(lookFromDeviceOrientation(0, -90, 0).elevationRad)).toBeCloseTo(
      0,
      9,
    );
    expect(deg(lookFromDeviceOrientation(90, -90, 45).azimuthRad)).toBeCloseTo(
      135,
      9,
    ); // 45−90+180
  });

  it("крен вокруг оси взгляда при β=90° не меняет взгляд", () => {
    // В точке вырождения α и γ ковариантны: поворот вокруг оси взгляда на φ
    // перекладывается между ними. Разные представления ОДНОЙ позы обязаны
    // давать одинаковый азимут и наклон — иначе панорама «уезжает»
    for (const alpha of [0, 45, 123]) {
      for (const gamma of [0, -30, 77]) {
        const base = lookFromDeviceOrientation(alpha, 90, gamma);
        for (const phi of [90, 180, 270]) {
          expectSameLook(
            lookFromDeviceOrientation(alpha + phi, 90, gamma - phi),
            base,
          );
        }
      }
    }
  });

  it("альтернативное представление той же позы: (α+180, −β, −γ)", () => {
    // Браузер при пересечении точки вырождения может выдать другое
    // представление того же поворота. Функция обязана быть инвариантной
    const rand = lcg(7);
    for (let i = 0; i < 100; i++) {
      const a = rand() * 360 - 180;
      const b = rand() * 180 - 90;
      const g = rand() * 180 - 90;
      expectSameLook(
        lookFromDeviceOrientation(a + 180, -b, -g),
        lookFromDeviceOrientation(a, b, g),
      );
    }
  });

  it("портрет → ландшафт: три представления одной позы «смотрим на север»", () => {
    // Та же поза в трёх эквивалентных записях: строго вертикально,
    // ландшафт влево, ландшафт вправо — и промежуточное β=45°
    const portrait = lookFromDeviceOrientation(0, 90, 0);
    expectSameLook(lookFromDeviceOrientation(90, 0, -90), portrait);
    expectSameLook(lookFromDeviceOrientation(270, 0, 90), portrait);
    expectSameLook(lookFromDeviceOrientation(90, 45, -90), portrait);
  });
});

describe("гироскоп: согласованность с матрицей", () => {
  it("проекция rotationRate на земную вертикаль восстанавливает Ω", () => {
    // Поза вращается вокруг ЗЕМНОЙ вертикали со скоростью Ω. В осях
    // устройства это ставки Ω·(третья СТРОКА R): земная вертикаль,
    // выраженная в осях устройства (R^T·e3). Порядок компонент ставок —
    // alpha (ось Z устройства), beta (X), gamma (Y).
    const rand = lcg(13);
    const omegaDps = 30;
    for (let i = 0; i < 50; i++) {
      const b = rand() * 180 - 90;
      const g = rand() * 180 - 90;
      const r = mul(mul(rotZ(0), rotX(b * RAD)), rotY(g * RAD));
      const [rx, ry, rz] = [r[2][0], r[2][1], r[2][2]]; // 3-я строка
      const rate = verticalRateFromGyro(
        b,
        g,
        omegaDps * rz, // alpha: ось Z устройства
        omegaDps * rx, // beta: ось X устройства
        omegaDps * ry, // gamma: ось Y устройства
      );
      // Азимут отсчитывается по часовой, а +Ω — против: ответ должен быть −Ω
      expect(rate / RAD).toBeCloseTo(-omegaDps, 9);
    }
  });

  it("знак: +φ к α (поворот вокруг земной вертикали) уводит азимут на −φ", () => {
    // Rz(φ)·R = Rz(φ+α)Rx(β)Ry(γ): поворот позы вокруг земной вертикали —
    // это +φ к α. Компас по часовой: азимут при этом уменьшается на φ
    const before = lookFromDeviceOrientation(0, 90, 0).azimuthRad; // 0
    const after = lookFromDeviceOrientation(10, 90, 0).azimuthRad; // 350°
    expect(norm(after - before)).toBeCloseTo(
      2 * Math.PI - (10 * Math.PI) / 180,
      9,
    ); // −10° по кратчайшей дуге
  });
});
