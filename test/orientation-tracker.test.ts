// @vitest-environment jsdom
/**
 * Поведение синглтона OrientationTracker, требующее DOM-событий датчиков
 * (jsdom). Чистые функции модуля — в orientation.test.ts.
 *
 * Кнопка «К моей геопозиции» сбрасывает ручную подстройку азимута: контуры
 * должны встать на текущий компас сразу, а не после следующего события
 * датчика. Здесь проверяется, что resetOffset() пересобирает состояние.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Синтетическое deviceorientation с заданными углами (absolute-показание) */
function sensorEvent(alpha: number, beta: number, gamma: number): Event {
  const ev = new Event("deviceorientation") as Event & {
    alpha: number;
    beta: number;
    gamma: number;
    absolute: boolean;
  };
  Object.defineProperties(ev, {
    alpha: { value: alpha },
    beta: { value: beta },
    gamma: { value: gamma },
    absolute: { value: true },
  });
  return ev;
}

describe("OrientationTracker: сброс ручной подстройки азимута", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    // iOS-стаб: доступ к датчикам по requestPermission() из жеста
    vi.stubGlobal(
      "DeviceOrientationEvent",
      class {
        static requestPermission = () => Promise.resolve("granted");
      },
    );
  });

  it("resetOffset обнуляет калибровку и сразу пересобирает азимут без офсета", async () => {
    const { orientationTracker } = await import("../src/core/orientation");
    const { setCalibration, getCalibration } =
      await import("../src/core/calibration");

    const seen: number[] = [];
    orientationTracker.start((state) => seen.push(state.azimuthRad));
    // iOS-путь: start() ждёт жеста, запрос доступа включает слушатели
    expect(await orientationTracker.requestPermission()).toBe(true);

    setCalibration({ azimuthDeg: 10 });
    // Портрет, взгляд на юг (alpha=180°): азимут ≈ π, без датчиков гироскопа
    // работает прежняя схема — круговое среднее + followAzimuth
    window.dispatchEvent(sensorEvent(180, 90, 0));

    const before = seen[seen.length - 1];
    expect(before).toBeCloseTo(Math.PI + (10 * Math.PI) / 180, 6);

    orientationTracker.resetOffset();

    expect(getCalibration().azimuthDeg).toBe(0);
    // Состояние пересобрано сразу: офсет снят, азимут — чистый компас
    expect(seen[seen.length - 1]).toBeCloseTo(Math.PI, 6);
  });

  it("без сенсорных показаний resetOffset только обнуляет калибровку", async () => {
    const { orientationTracker } = await import("../src/core/orientation");
    const { setCalibration, getCalibration } =
      await import("../src/core/calibration");

    setCalibration({ azimuthDeg: 7 });
    let calls = 0;
    orientationTracker.start(() => calls++);
    // iOS-путь: start() сообщает «manual» синхронно
    expect(calls).toBe(1);

    orientationTracker.resetOffset();

    expect(getCalibration().azimuthDeg).toBe(0);
    // Данных датчика не было — пересобирать нечего, нового события нет
    expect(calls).toBe(1);
  });
});
