// @vitest-environment jsdom
/**
 * Доступ к компасу на iOS.
 *
 * Регресс, ради которого написан тест: `requestPermission()` вызывался при
 * загрузке модуля. iOS 13+ отдаёт датчики только из обработчика жеста
 * пользователя, поэтому запрос отклонялся молча — и компас на iPhone не
 * включался вообще никогда, оставался лишь ручной свайп.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    needsUserGesture,
    orientationTracker,
    type OrientationState,
} from "../src/core/orientation";

/** Подмена платформы: iOS-подобный DeviceOrientationEvent с запросом доступа */
function stubIOS(result: string): ReturnType<typeof vi.fn> {
  const requestPermission = vi.fn(async () => result);
  vi.stubGlobal(
    "DeviceOrientationEvent",
    class {
      static requestPermission = requestPermission;
    },
  );
  return requestPermission;
}

afterEach(() => {
  orientationTracker.stop();
  vi.unstubAllGlobals();
});

describe("разрешение на датчики (iOS)", () => {
  it("start() не трогает разрешение сам — ждёт жеста", async () => {
    const requestPermission = stubIOS("granted");
    expect(needsUserGesture()).toBe(true);

    const states: OrientationState[] = [];
    orientationTracker.start((s) => states.push({ ...s }));

    // Ни одного запроса до нажатия: iOS отклонил бы его молча и навсегда
    expect(requestPermission).not.toHaveBeenCalled();
    // Интерфейс по этому флагу показывает кнопку «Включить компас»
    expect(orientationTracker.needsPermission).toBe(true);
    expect(states.at(-1)?.source).toBe("manual");

    await expect(orientationTracker.requestPermission()).resolves.toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(orientationTracker.needsPermission).toBe(false);
  });

  it("отказ оставляет ручную подстройку и кнопку на месте", async () => {
    stubIOS("denied");
    const states: OrientationState[] = [];
    orientationTracker.start((s) => states.push({ ...s }));

    await expect(orientationTracker.requestPermission()).resolves.toBe(false);
    expect(states.at(-1)?.source).toBe("manual");
    // Человек мог отказать случайно — предложение остаётся доступным
    expect(orientationTracker.needsPermission).toBe(true);
  });

  it("два быстрых нажатия не открывают два системных диалога", async () => {
    // Запрос идёт через await: без общего промиса повторное нажатие успевало
    // проскочить проверку `listening` и звало requestPermission ещё раз
    const requestPermission = stubIOS("granted");
    orientationTracker.start(() => {});

    const [a, b] = await Promise.all([
      orientationTracker.requestPermission(),
      orientationTracker.requestPermission(),
    ]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("первое касание в любом месте запрашивает доступ само", async () => {
    // iOS требует жест, но не обязательно по кнопке компаса: старт сессии
    // вешает хук, и первое же касание (панорама, любая кнопка) зовёт
    // requestPermission — искать невзрачную иконку человек не должен
    const requestPermission = stubIOS("granted");
    orientationTracker.start(() => {});
    expect(requestPermission).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pointerdown"));
    // Ждём завершения промиса запроса, а не только его вызова:
    // permissionPending снимается после await Promise.allSettled
    await vi.waitFor(() =>
      expect(orientationTracker.needsPermission).toBe(false),
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("после отказа касания диалог не спамят — остаётся кнопка", async () => {
    // Хук одноразовый: повторный отказ означает «человек отказал», и каждое
    // касание открывать системный диалог нельзя. Кнопка остаётся на месте
    const requestPermission = stubIOS("denied");
    orientationTracker.start(() => {});

    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() =>
      expect(requestPermission).toHaveBeenCalledTimes(1),
    );
    expect(orientationTracker.needsPermission).toBe(true);
  });

  it("на Android разрешение не нужно: слушаем сразу", () => {
    vi.stubGlobal("DeviceOrientationEvent", class {});
    expect(needsUserGesture()).toBe(false);

    const states: OrientationState[] = [];
    orientationTracker.start((s) => states.push({ ...s }));
    expect(orientationTracker.needsPermission).toBe(false);
  });
});

describe("раскалиброванный компас (iOS)", () => {
  it("отрицательная точность — повод для подсказки, положительная её снимает", async () => {
    stubIOS("granted");
    const states: OrientationState[] = [];
    orientationTracker.start((s) => states.push({ ...s }));
    await orientationTracker.requestPermission();

    expect(orientationTracker.needsCalibration).toBe(false);

    // iOS: компас с точностью −1 (раскалиброван) — показаниям нельзя верить
    const bad = new Event("deviceorientation") as Event &
      DeviceOrientationEvent;
    Object.assign(bad, {
      alpha: 0,
      beta: 90,
      gamma: 0,
      webkitCompassHeading: 42,
      webkitCompassAccuracy: -1,
    });
    window.dispatchEvent(bad);
    expect(orientationTracker.needsCalibration).toBe(true);
    expect(states.at(-1)?.accuracyDeg).toBe(-1);

    // После «восьмёрки» точность вернулась — подсказку снимаем
    const good = new Event("deviceorientation") as Event &
      DeviceOrientationEvent;
    Object.assign(good, {
      alpha: 0,
      beta: 90,
      gamma: 0,
      webkitCompassHeading: 42,
      webkitCompassAccuracy: 5,
    });
    window.dispatchEvent(good);
    expect(orientationTracker.needsCalibration).toBe(false);
  });

  it("системное событие compassneedscalibration тоже поднимает флаг", async () => {
    stubIOS("granted");
    orientationTracker.start(() => {});
    await orientationTracker.requestPermission();

    window.dispatchEvent(new Event("compassneedscalibration"));
    expect(orientationTracker.needsCalibration).toBe(true);

    // Нормальное показание снимает и этот флаг
    const good = new Event("deviceorientation") as Event &
      DeviceOrientationEvent;
    Object.assign(good, {
      alpha: 0,
      beta: 90,
      gamma: 0,
      webkitCompassHeading: 10,
      webkitCompassAccuracy: 3,
    });
    window.dispatchEvent(good);
    expect(orientationTracker.needsCalibration).toBe(false);
  });
});

describe("точность компаса на Android", () => {
  /**
   * Регресс: без webkitCompass* (весь Android) точность присваивалась −1 —
   * iOS-код «магнитометр раскалиброван». Подсказка про «восьмёрку» висела
   * вечно, сколько телефон ни крути (жалоба с Samsung).
   */
  it("без webkitCompass* точность неизвестна (NaN), а не «плохая»", () => {
    vi.stubGlobal("DeviceOrientationEvent", class {});
    Object.defineProperty(window, "ondeviceorientationabsolute", {
      value: null,
      configurable: true,
    });
    const states: OrientationState[] = [];
    orientationTracker.start((s) => states.push({ ...s }));

    const ev = new Event("deviceorientationabsolute") as Event &
      DeviceOrientationEvent;
    Object.assign(ev, { alpha: 10, beta: 45, gamma: 0, absolute: true });
    window.dispatchEvent(ev);

    expect(orientationTracker.needsCalibration).toBe(false);
    expect(states.at(-1)?.source).toBe("sensor");
    expect(states.at(-1)?.accuracyDeg).toBeNaN();
  });

  it("просьба о калибровке без точности сама гаснет по таймауту", () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("DeviceOrientationEvent", class {});
      orientationTracker.start(() => {});

      window.dispatchEvent(new Event("compassneedscalibration"));
      expect(orientationTracker.needsCalibration).toBe(true);

      // Событие приходит повторно, пока датчик плох; 15 с тишины — в норме
      vi.advanceTimersByTime(15000);
      expect(orientationTracker.needsCalibration).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
