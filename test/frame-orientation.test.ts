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
  it("без программного поворота кадр не доворачивается", () => {
    expect(frameRotationDeg(0)).toBe(0);
  });

  it("CSS +90 (хват вправо) → доворот кадра −90 (270)", () => {
    expect(frameRotationDeg(90)).toBe(270);
  });

  it("CSS −90 (хват влево) → доворот кадра +90", () => {
    expect(frameRotationDeg(-90)).toBe(90);
  });

  it("не зависит от угла окна в ветке browser-compensated", () => {
    // Окно уже ландшафтное (манифест сработал) — CSS-поворота нет, кадр ровный
    expect(frameRotationDeg(0, "browser-compensated", 90)).toBe(0);
    expect(frameRotationDeg(0, "browser-compensated", 270)).toBe(0);
  });
});

describe("frameRotationDeg (raw-sensor, старые Chrome)", () => {
  it("доворот = монтаж сенсора − угол окна − CSS", () => {
    // Сырой сенсор 90°, окно портретное, без CSS: довернуть на 90°
    expect(frameRotationDeg(0, "raw-sensor", 0, 90)).toBe(90);
    // Окно ландшафтное (90°): сенсор уже совпал с окном, доворот не нужен
    expect(frameRotationDeg(0, "raw-sensor", 90, 90)).toBe(0);
    // Окно портретное + CSS +90: 90 − 0 − 90 = 0
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
