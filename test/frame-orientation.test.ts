// @vitest-environment jsdom
/**
 * Доворот кадра камеры (core/frame-orientation.ts): при программном повороте
 * UI окно остаётся системно портретным, а кадр ориентирован относительно окна
 * (современный Chrome компенсирует монтаж сенсора под окно) — поэтому кадр
 * доворачиваем на −CSS-угол. Это константа сессии, не функция хвата.
 */

import { describe, expect, it } from "vitest";
import {
    frameRotationDeg,
    rotatedFrameSize,
} from "../src/core/frame-orientation";

describe("frameRotationDeg (browser-compensated)", () => {
  it("кадр уже ориентирован под окно, body повёрнут вместе с видео — доворот не нужен", () => {
    // Подтверждено на Samsung: в программном ландшафте frame портретный
    // (1080×1920), доворот ложил его боком. R = 0 при любом CSS-угле.
    expect(frameRotationDeg(0)).toBe(0);
    expect(frameRotationDeg(90)).toBe(0);
    expect(frameRotationDeg(-90)).toBe(0);
  });

  it("не зависит от угла окна в ветке browser-compensated", () => {
    expect(frameRotationDeg(0, "browser-compensated", 90)).toBe(0);
    expect(frameRotationDeg(0, "browser-compensated", 270)).toBe(0);
  });
});

describe("frameRotationDeg (raw-sensor, старые Chrome)", () => {
  it("доворот = монтаж сенсора − угол окна − CSS", () => {
    expect(frameRotationDeg(0, "raw-sensor", 0, 90)).toBe(90);
    expect(frameRotationDeg(0, "raw-sensor", 90, 90)).toBe(0);
    expect(frameRotationDeg(90, "raw-sensor", 0, 90)).toBe(0);
  });
});

describe("rotatedFrameSize", () => {
  it("при ±90° ширина и высота меняются местами", () => {
    expect(rotatedFrameSize(1920, 1080, 90)).toEqual({ w: 1080, h: 1920 });
    expect(rotatedFrameSize(1920, 1080, 270)).toEqual({ w: 1080, h: 1920 });
  });

  it("при 0/180 — как есть", () => {
    expect(rotatedFrameSize(1920, 1080, 0)).toEqual({ w: 1920, h: 1080 });
    expect(rotatedFrameSize(1920, 1080, 180)).toEqual({ w: 1920, h: 1080 });
  });
});
