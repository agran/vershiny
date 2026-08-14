// @vitest-environment jsdom
/**
 * Модуль `main.ts` исполняется целиком при импорте. На iOS
 * `orientationTracker.start()` вызывает свой callback синхронно (доступ к
 * датчикам — только по жесту, поэтому кнопка «Включить компас» создаётся
 * сразу), а тот пишет в `localizedTitles`.
 *
 * Регресс: константа `localizedTitles` была объявлена ниже по файлу, и первое
 * обращение к ней попадало в temporal dead zone —
 * `ReferenceError: Cannot access uninitialized variable`, после чего страница
 * навсегда оставалась на «Загрузка…» (только на iPhone: на Android/десктопе
 * callback при старте не вызывается, и константа успевала инициализироваться).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

function stubIosSensorApi(): void {
  // iOS: нужен жест пользователя → start() зовёт callback синхронно
  vi.stubGlobal(
    "DeviceOrientationEvent",
    class {
      static requestPermission = () => Promise.resolve("granted");
    },
  );
}

function stubWorker(): void {
  vi.stubGlobal(
    "Worker",
    class {
      postMessage() {}
      addEventListener() {}
      removeEventListener() {}
    },
  );
}

describe("main.ts грузится при iOS-пути старта ориентации", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="app"></div><div id="status">Загрузка…</div>';
    localStorage.clear();
    // Локаль ru: кнопку ищем по подписи «Включить компас» (i18n читает
    // хранилище при вычислении модуля, поэтому кладём её до импорта)
    localStorage.setItem("vershiny-locale", "ru");
    stubWorker();
    stubIosSensorApi();
    // jsdom без пакета canvas не умеет getContext и пишет «Not implemented»
    // в stderr — до отрисовки в тесте дело не доходит, хватит заглушки
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    // Сеть в тесте не нужна: любой fetch отдаёт валидный JSON, чтобы main()
    // не уходил в IndexedDB (его в jsdom нет) и не ронял незахваченный промис.
    // Response создаётся на каждый вызов: один и тот же ответ нельзя читать
    // дважды («Body is unusable»)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            resolve(
              new Response('{"region":"x","generated":"","peaks":[]}', {
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
      ),
    );
  });

  it("импорт не падает, а кнопка «Включить компас» создаётся сразу", async () => {
    vi.resetModules();
    // TDZ кидала бы здесь: синхронно, при вычислении модуля
    await expect(import("../src/main")).resolves.toBeDefined();

    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Включить компас",
    );
    expect(btn).toBeDefined();
  });
});
