// @vitest-environment jsdom
/**
 * Детектор «кадр сенсора боком» (ui/ar.ts isSensorFrameSideways): когда
 * интерфейс повёрнут программно (landscape на портретном телефоне), а Android
 * отдаёт кадр в нативной ландшафтной ориентации сенсора — видео надо
 * доворачивать в вертикаль. Иначе сцена лежит боком, а контуры (в осях UI)
 * стоят правильно.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { isSensorFrameSideways } from "../src/ui/ar";
import { applySoftRotation } from "../src/core/screen-orientation";

describe("isSensorFrameSideways", () => {
  beforeEach(() => {
    // Сброс поворота и типа ориентации между тестами
    applySoftRotation(false);
    document.body.style.cssText = "";
    Object.defineProperty(screen, "orientation", {
      value: { type: "portrait-primary", angle: 0 },
      writable: true,
      configurable: true,
    });
  });

  it("без программного поворота — не боком (iOS доворачивает сам, Android в ландшафтном окне ровно)", () => {
    // Кадр ландшафтный, холст ландшафтный (физический ландшафт) — ровно
    expect(isSensorFrameSideways(1920, 1080, 1280, 720)).toBe(false);
    // Кадр ландшафтный, холст портретный, НО поворота нет — не трогаем
    // (это обычный портретный режим: cover-кроп по краям, видео стоит)
    expect(isSensorFrameSideways(1920, 1080, 360, 800)).toBe(false);
  });

  it("программный ландшафт + ландшафтный кадр сенсора → боком, доворачиваем", () => {
    // Телефон физически портретный (окно портретное), UI повёрнут в ландшафт:
    // холст стал «высоким» в локальных осях (высота > ширины у body после
    // перестановки), а кадр сенсора остался ландшафтным
    applySoftRotation(true);
    expect(isSensorFrameSideways(1920, 1080, 360, 800)).toBe(true);
  });

  it("программный ландшафт + портретный кадр — не боком", () => {
    applySoftRotation(true);
    // Редкий случай: сенсор отдал портретный кадр — доворачивать нечего
    expect(isSensorFrameSideways(1080, 1920, 360, 800)).toBe(false);
  });

  it("программный поворот снят — снова не боком", () => {
    applySoftRotation(true);
    expect(isSensorFrameSideways(1920, 1080, 360, 800)).toBe(true);
    applySoftRotation(false);
    expect(isSensorFrameSideways(1920, 1080, 360, 800)).toBe(false);
  });
});
