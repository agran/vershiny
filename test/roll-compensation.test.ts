// @vitest-environment jsdom
/**
 * Компенсация крена (core/roll-compensation.ts): включена по умолчанию,
 * отключается и запоминается; мусор в хранилище читается как «вкл».
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    isRollCompensationOn,
    overlayRollRad,
    setRollCompensation,
} from "../src/core/roll-compensation";

describe("roll-compensation", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("по умолчанию включена", () => {
    expect(isRollCompensationOn()).toBe(true);
  });

  it("отключение запоминается", () => {
    setRollCompensation(false);
    expect(isRollCompensationOn()).toBe(false);
    setRollCompensation(true);
    expect(isRollCompensationOn()).toBe(true);
  });

  it("мусор в хранилище читается как «вкл» (дефолт безопаснее)", () => {
    localStorage.setItem("vershiny-roll-compensation", "junk");
    expect(isRollCompensationOn()).toBe(true);
  });
});

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
