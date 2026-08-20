// @vitest-environment jsdom
/**
 * Режим камеры включается сам — но не любой ценой.
 *
 * Две крайности, между которыми выбирает `shouldAutoStartAr`: приложение,
 * которое просит камеру при каждой загрузке даже после отказа, и приложение,
 * где главный режим спрятан за кнопкой в углу.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearArAutoStartMark,
    hadArAutostartKill,
    isMiBrowser,
    markArAutoStart,
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

/** Установленное приложение: media-запрос display-mode отвечает на standalone */
function stubStandalone(): void {
  // В jsdom matchMedia нет — фейковый MQL собираем сами
  const orig =
    typeof matchMedia === "function" ? matchMedia.bind(globalThis) : undefined;
  const fake = (query: string): MediaQueryList => {
    const mql = (orig
      ? orig(query)
      : {
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList;
    Object.defineProperty(mql, "matches", {
      configurable: true,
      get: () => query === "(display-mode: standalone)",
    });
    return mql;
  };
  vi.stubGlobal("matchMedia", fake);
}

beforeEach(() => {
  localStorage.clear();
  stubCamera(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it("в установленном приложении первый запуск — с камерой, как во вкладке", () => {
    // Камера по умолчанию включена везде (это главный режим). От убийства
    // процесса на HyperOS защищает сторож в main.ts, а не этот предикат
    stubStandalone();
    expect(shouldAutoStartAr("unset", true)).toBe(true);
  });

  it("в установленном приложении выбор «on» уважается", () => {
    // Человек уже показал, что AR — его режим: автозапуск остаётся
    stubStandalone();
    expect(shouldAutoStartAr("on", true)).toBe(true);
  });

  it("в обычной вкладке первый запуск на телефоне — как раньше, с камерой", () => {
    // display-mode в jsdom по умолчанию не standalone
    expect(shouldAutoStartAr("unset", true)).toBe(true);
  });

  it("Mi Browser камеру не включает — там её нет вовсе", () => {
    Object.defineProperty(navigator, "userAgent", {
      value:
        "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 " +
        "Mobile Safari/537.36 XiaoMi/MiuiBrowser/19.3.2",
      configurable: true,
    });
    expect(isMiBrowser()).toBe(true);
    expect(shouldAutoStartAr("on", true)).toBe(false);
  });

  it("метка сторожа автозапуска ставится и снимается", () => {
    expect(hadArAutostartKill()).toBe(false);
    markArAutoStart();
    expect(hadArAutostartKill()).toBe(true);
    clearArAutoStartMark();
    expect(hadArAutostartKill()).toBe(false);
  });
});
