// @vitest-environment jsdom
/**
 * Компенсация крена (core/roll-compensation.ts): включена по умолчанию,
 * отключается и запоминается; мусор в хранилище читается как «вкл».
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    isRollCompensationOn,
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
