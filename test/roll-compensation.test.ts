// @vitest-environment jsdom
/**
 * Компенсация крена (core/roll-compensation.ts): включена всегда —
 * настройки нет, оверлей доворачивается на видимый крен кадра.
 */

import { describe, expect, it } from "vitest";
import { overlayRollRad } from "../src/core/roll-compensation";

describe("overlayRollRad", () => {
  const deg = (v: number): number => (v * Math.PI) / 180;

  it("без программного поворота — тождественность", () => {
    expect(overlayRollRad(0.123, 0)).toBeCloseTo(0.123, 12);
  });

  it("ровный ландшафтный хват даёт нулевой видимый крен", () => {
    // Хват влево: крен датчика −90° при повороте UI −90° — картинка ровная
    expect(overlayRollRad(-Math.PI / 2, -90)).toBeCloseTo(0, 12);
    // Хват вправо: +90° при повороте +90°
    expect(overlayRollRad(Math.PI / 2, 90)).toBeCloseTo(0, 12);
  });

  it("отклонение от ровного хвата проходит без изменений", () => {
    // Хват влево с доворотом на 5° по часовой: крен датчика −85°
    expect(overlayRollRad(deg(-85), -90)).toBeCloseTo(deg(5), 12);
    // Хват вправо с доворотом на 5° против часовой: крен датчика +85°
    expect(overlayRollRad(deg(85), 90)).toBeCloseTo(deg(-5), 12);
  });
});
