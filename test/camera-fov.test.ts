/**
 * Геометрия углов обзора (core/camera-fov.ts): пропорции кадра, зум,
 * cover-кроп. От этих формул зависит совпадение оверлея с кадром камеры,
 * поэтому каждая проверена численно, а не «на глаз».
 */

import { describe, it, expect } from "vitest";
import {
  applyCoverCrop,
  applyZoom,
  fovForFrame,
  horizonFracInFrame,
} from "../src/core/camera-fov";

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
