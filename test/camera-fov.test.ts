/**
 * Геометрия углов обзора (core/camera-fov.ts): пропорции кадра, зум,
 * cover-кроп. От этих формул зависит совпадение оверлея с кадром камеры,
 * поэтому каждая проверена численно, а не «на глаз».
 */

import { describe, it, expect } from "vitest";
import {
  applyCoverCrop,
  applyZoom,
  diagFovFromFl35,
  fovForFrame,
  horizonFracInFrame,
  longSideFovFromFl35,
} from "../src/core/camera-fov";
import {
  createLinearProjection,
  createPinholeProjection,
} from "../src/core/camera-projection";

const DEG = Math.PI / 180;
/** Угол из половинного тангенса: обратный ход формул модуля */
const fromHalfTan = (t: number) => 2 * Math.atan(t);

describe("fovForFrame", () => {
  it("длинная сторона получает базовый угол", () => {
    const land = fovForFrame(70 * DEG, 1920, 1080);
    expect(land.h).toBeCloseTo(70 * DEG, 10);
    expect(land.v).toBeLessThan(land.h);

    const port = fovForFrame(70 * DEG, 1080, 1920);
    expect(port.v).toBeCloseTo(70 * DEG, 10);
    expect(port.h).toBeLessThan(port.v);
  });

  it("пиксель «стоит» одинаково по обеим осям (угол через тангенс)", () => {
    const fov = fovForFrame(70 * DEG, 1920, 1080);
    // tan(v/2) / tan(h/2) должен равняться отношению сторон
    expect(Math.tan(fov.v / 2) / Math.tan(fov.h / 2)).toBeCloseTo(
      1080 / 1920,
      10,
    );
  });

  it("квадрат: оба угла равны базовому", () => {
    const fov = fovForFrame(60 * DEG, 100, 100);
    expect(fov.h).toBeCloseTo(60 * DEG, 10);
    expect(fov.v).toBeCloseTo(60 * DEG, 10);
  });

  it("битые размеры не роняют отрисовку", () => {
    const fov = fovForFrame(60 * DEG, 0, 0);
    expect(fov.h).toBeCloseTo(60 * DEG, 10);
  });
});

describe("fl35 → углы кадра (docs/AR-OPTICS-AUDIT.md, №5)", () => {
  const DIAG35 = Math.hypot(36, 24);

  it("диагональный угол: fl35 привязан к диагонали полного кадра", () => {
    const fl35 = 23;
    expect(diagFovFromFl35(fl35)).toBeCloseTo(
      2 * Math.atan(DIAG35 / 2 / fl35),
      10,
    );
  });

  it("кадр 3:2: длинная сторона как у полного кадра, 2·atan(18/fl35)", () => {
    const fl35 = 23;
    // 3600×2400 — 3:2: длинная/диагональ = 36/43.27 → ровно 18/fl35
    expect(longSideFovFromFl35(fl35, 3600, 2400)).toBeCloseTo(
      fromHalfTan(18 / fl35),
      10,
    );
  });

  it("кадр 4:3: длинная сторона ~на 2.8% уже наивной 2·atan(18/fl35)", () => {
    const fl35 = 23;
    const naive = fromHalfTan(18 / fl35);
    const long = longSideFovFromFl35(fl35, 4000, 3000)!;
    expect(long).toBeCloseTo(
      fromHalfTan((DIAG35 / 2 / fl35) * (4 / 5)),
      10,
    );
    expect(long).toBeLessThan(naive);
    expect((naive - long) / naive).toBeGreaterThan(0.02);
  });

  it("портрет: базовый угол получает высота, а не ширина", () => {
    const fl35 = 23;
    const land = longSideFovFromFl35(fl35, 4000, 3000)!;
    const port = longSideFovFromFl35(fl35, 3000, 4000)!;
    expect(port).toBeCloseTo(land, 10); // та же длинная сторона кадра
  });

  it("мусор на входе — null", () => {
    expect(longSideFovFromFl35(0, 4000, 3000)).toBeNull();
    expect(longSideFovFromFl35(NaN, 4000, 3000)).toBeNull();
    expect(longSideFovFromFl35(-1, 4000, 3000)).toBeNull();
    expect(longSideFovFromFl35(23, 0, 3000)).toBeNull();
    expect(diagFovFromFl35(0)).toBeNull();
  });
});

describe("applyZoom", () => {
  it("зум 2 вдвое уменьшает половинный тангенс", () => {
    const fov = fovForFrame(70 * DEG, 1920, 1080);
    const zoomed = applyZoom(fov, 2);
    expect(Math.tan(zoomed.h / 2)).toBeCloseTo(Math.tan(fov.h / 2) / 2, 10);
    expect(Math.tan(zoomed.v / 2)).toBeCloseTo(Math.tan(fov.v / 2) / 2, 10);
  });

  it("зум 1 и мусор — без изменений", () => {
    const fov = fovForFrame(70 * DEG, 1920, 1080);
    expect(applyZoom(fov, 1)).toEqual(fov);
    expect(applyZoom(fov, 0)).toEqual(fov);
    expect(applyZoom(fov, NaN)).toEqual(fov);
  });
});

describe("applyCoverCrop", () => {
  it("те же пропорции — тот же угол", () => {
    const fov = fovForFrame(70 * DEG, 1920, 1080);
    const same = applyCoverCrop(fov, 1920, 1080, 960, 540);
    expect(same.h).toBeCloseTo(fov.h, 10);
    expect(same.v).toBeCloseTo(fov.v, 10);
  });

  it("портретный экран обрезает кадр 16:9 по горизонтали", () => {
    const fov = fovForFrame(70 * DEG, 1920, 1080);
    // Телефон вертикально: видно только центральную полосу кадра
    const cropped = applyCoverCrop(fov, 1920, 1080, 1080, 1920);
    // Вертикаль не обрезана: кадр высотой ровно в экран
    expect(cropped.v).toBeCloseTo(fov.v, 10);
    // Видимая доля ширины: scale = 1920/1080, ширина кадра 3413 px, видно 1080
    const frac = 1080 / (1920 * (1920 / 1080));
    expect(cropped.h).toBeCloseTo(fromHalfTan(Math.tan(fov.h / 2) * frac), 10);
    expect(cropped.h).toBeLessThan(fov.h / 2); // видно меньше половины кадра
  });

  it("битые размеры возвращают исходный угол", () => {
    const fov = fovForFrame(70 * DEG, 1920, 1080);
    expect(applyCoverCrop(fov, 0, 1080, 100, 100)).toEqual(fov);
  });

  it("central cover и скорректированный pinhole-FOV совпадают для матрицы пропорций", () => {
    const frames = [
      [400, 300], // 4:3
      [450, 300], // 3:2
      [480, 270], // 16:9
      [300, 400], // 3:4
    ];
    const viewports = [
      [400, 300], // 4:3
      [480, 270], // 16:9
      [270, 480], // 9:16
    ];
    const azimuths = [-0.3, -0.1, 0, 0.14, 0.28];
    const elevations = [-0.18, -0.05, 0.08, 0.2];

    for (const [frameW, frameH] of frames) {
      const fullFov = fovForFrame(76 * DEG, frameW, frameH);
      const full = createPinholeProjection({
        width: frameW,
        height: frameH,
        centerAzRad: 1.1,
        tiltRad: 0.08,
        fovRad: fullFov.h,
        fovVRad: fullFov.v,
        horizonFrac: 0.5,
      });
      for (const [viewW, viewH] of viewports) {
        const visibleFov = applyCoverCrop(
          fullFov,
          frameW,
          frameH,
          viewW,
          viewH,
        );
        const visible = createPinholeProjection({
          width: viewW,
          height: viewH,
          centerAzRad: 1.1,
          tiltRad: 0.08,
          fovRad: visibleFov.h,
          fovVRad: visibleFov.v,
          horizonFrac: 0.5,
        });
        const scale = Math.max(viewW / frameW, viewH / frameH);
        const offsetX = (viewW - frameW * scale) / 2;
        const offsetY = (viewH - frameH * scale) / 2;

        for (const azimuthOffset of azimuths) {
          for (const elevationOffset of elevations) {
            const azimuth = 1.1 + azimuthOffset;
            const elevation = 0.08 + elevationOffset;
            const fullPoint = full.angleToView(azimuth, elevation)!;
            const expected = {
              x: fullPoint.x * scale + offsetX,
              y: fullPoint.y * scale + offsetY,
            };
            const actual = visible.angleToView(azimuth, elevation)!;
            if (
              expected.x < 0 ||
              expected.x > viewW ||
              expected.y < 0 ||
              expected.y > viewH
            ) {
              continue;
            }
            expect(actual.x).toBeCloseTo(expected.x, 9);
            expect(actual.y).toBeCloseTo(expected.y, 9);
          }
        }
      }
    }
  });

  it("линейная модель заметно расходится с прямолинейной камерой у края", () => {
    const width = 480;
    const height = 270;
    const fov = fovForFrame(90 * DEG, width, height);
    const params = {
      width,
      height,
      centerAzRad: 1.1,
      tiltRad: 0,
      fovRad: fov.h,
      fovVRad: fov.v,
      horizonFrac: 0.5,
    };
    const pinhole = createPinholeProjection(params);
    const linear = createLinearProjection(params);
    const azimuth = params.centerAzRad + 30 * DEG;
    const pinholePoint = pinhole.angleToView(azimuth, 0)!;
    const linearPoint = linear.angleToView(azimuth, 0)!;

    expect(Math.abs(linearPoint.x - pinholePoint.x)).toBeGreaterThan(20);
  });
});

describe("horizonFracInFrame", () => {
  it("без кропа линия горизонта на той же доле высоты", () => {
    expect(horizonFracInFrame(1920, 1080, 960, 540, 0.62)).toBeCloseTo(
      0.62,
      10,
    );
  });

  it("горизонтальный кроп не двигает линию горизонта", () => {
    // Портретный экран, кадр 16:9: обрезка по бокам, высота совпадает
    expect(horizonFracInFrame(1920, 1080, 1080, 1920, 0.62)).toBeCloseTo(
      0.62,
      10,
    );
  });

  it("вертикальный кроп сдвигает линию к центру полного кадра", () => {
    // Широкий низкий экран: верх и низ кадра обрезаны, экранные 0.62 — это
    // строка ниже середины, в полном кадре она ближе к середине
    const frac = horizonFracInFrame(1920, 1080, 1920, 800, 0.62);
    // scale = 1, кадр 1080 px при экране 800: видно строки 140..940
    expect(frac).toBeCloseTo((0.62 * 800 + 140) / 1080, 10);
    expect(frac).toBeLessThan(0.62);
    expect(frac).toBeGreaterThan(0.5);
  });
});
