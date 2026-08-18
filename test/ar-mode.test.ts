// @vitest-environment jsdom
/**
 * Режим камеры включается сам — но не любой ценой.
 *
 * Две крайности, между которыми выбирает `shouldAutoStartAr`: приложение,
 * которое просит камеру при каждой загрузке даже после отказа, и приложение,
 * где главный режим спрятан за кнопкой в углу.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  rememberArMode,
  shouldAutoStartAr,
  storedArPreference,
} from "../src/core/ar-mode";

/** Камера в браузере есть (сам вызов в этих тестах не делается) */
function stubCamera(available: boolean): void {
  vi.stubGlobal("navigator", {
    ...navigator,
    maxTouchPoints: navigator.maxTouchPoints,
    mediaDevices: available ? { getUserMedia: vi.fn() } : undefined,
  });
}

beforeEach(() => {
  localStorage.clear();
  stubCamera(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("режим камеры", () => {
  it("первый запуск на телефоне включает камеру сам", () => {
    expect(shouldAutoStartAr("unset", true)).toBe(true);
  });

  it("на десктопе камеру при запуске не просит", () => {
    // Узкое окно браузера на ноутбуке — не повод открывать камеру
    expect(shouldAutoStartAr("unset", false)).toBe(false);
  });

  it("отказ помнится: диалог не всплывает при каждой загрузке", () => {
    expect(shouldAutoStartAr("off", true)).toBe(false);
  });

  it("вышел в режиме камеры — в нём и вернулся, даже на десктопе", () => {
    // Ноутбук с веб-камерой: человек включил AR сам, значит это его выбор
    expect(shouldAutoStartAr("on", false)).toBe(true);
  });

  it("без getUserMedia не пытается вовсе", () => {
    stubCamera(false);
    expect(shouldAutoStartAr("on", true)).toBe(false);
  });

  it("выбор переживает перезапуск", () => {
    expect(storedArPreference()).toBe("unset");
    rememberArMode(true);
    expect(storedArPreference()).toBe("on");
    rememberArMode(false);
    expect(storedArPreference()).toBe("off");
  });

  it("мусор в хранилище читается как «ещё не решал»", () => {
    localStorage.setItem("vershiny-ar", '{"on":true}');
    expect(storedArPreference()).toBe("unset");
  });
});
