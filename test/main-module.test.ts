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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Захваченные из замоканных модулей аргументы: AR-сессия получает объект
 * панорамы по ссылке, и регрессия с подменой этого объекта видна именно
 * через сохранённую ссылку
 */
const captured = vi.hoisted(() => ({
  arStates: [] as Array<{ peaks: unknown[] }>,
  settingsOptions: [] as Array<{ onRegionChange: (region: string) => void }>,
}));

// Камера в jsdom невозможна — startAr подменяется, объект панорамы запоминается
vi.mock("../src/ui/ar", () => ({
  startAr: vi.fn(
    async (
      _video: HTMLVideoElement,
      _canvas: HTMLCanvasElement,
      state: { peaks: unknown[] },
    ) => {
      captured.arStates.push(state);
      return {
        stop: () => {},
        fullFrameFov: () => ({ h: 1, v: 1 }),
        frameHorizonFrac: () => 0.5,
        grabFrame: () => null,
      };
    },
  ),
}));

// Настройки подменяются: тесту нужен лишь колбэк смены региона
vi.mock("../src/ui/settings", () => ({
  openSettings: vi.fn(
    (
      _region: string,
      _origin: unknown,
      options: { onRegionChange: (region: string) => void },
    ) => {
      captured.settingsOptions.push(options);
      return () => {};
    },
  ),
}));

// Рендер — вне предмета теста (jsdom без canvas), остальное модуля — настоящее
vi.mock("../src/ui/panorama", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/ui/panorama")>();
  return { ...original, renderPanorama: vi.fn() };
});

/** Экземпляры стаба Worker: у созданного в main.ts вызываем onmessage вручную */
const workerInstances: Array<{
  onmessage: ((ev: MessageEvent) => void) | null;
}> = [];

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
      onmessage: ((ev: MessageEvent) => void) | null = null;
      postMessage() {}
      addEventListener() {}
      removeEventListener() {}
      constructor() {
        workerInstances.push(this);
      }
    },
  );
}

/** Ответ воркера с одной вершиной: поля — по ResultMessage */
function resultMessage(peaks: unknown[]): MessageEvent {
  return {
    data: {
      type: "result",
      horizon: new Float32Array(1),
      stepRad: 0.1,
      peaks,
      layers: [],
      distanceToHorizonM: new Float32Array(1),
      crests: [],
      observerH: 2000,
      computeMs: 1,
    },
  } as unknown as MessageEvent;
}

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (!btn) throw new Error(`Кнопка «${label}» не создана`);
  return btn;
}

function stubEnvironment(): void {
  document.body.innerHTML =
    '<div id="app"></div><div id="status">Загрузка…</div>';
  localStorage.clear();
  // Локаль ru: кнопку ищем по подписи «Включить компас» (i18n читает
  // хранилище при вычислении модуля, поэтому кладём её до импорта)
  localStorage.setItem("vershiny-locale", "ru");
  workerInstances.length = 0;
  captured.arStates.length = 0;
  captured.settingsOptions.length = 0;
  stubWorker();
  stubIosSensorApi();
  // jsdom без пакета canvas не умеет getContext и пишет «Not implemented»
  // в stderr — до отрисовки в тесте дело не доходит, хватит заглушки
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as never,
  );
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
}

describe("main.ts грузится при iOS-пути старта ориентации", () => {
  beforeEach(() => {
    stubEnvironment();
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

describe("смена региона при активной AR-сессии", () => {
  beforeEach(() => {
    stubEnvironment();
  });

  it("не подменяет объект панорамы, захваченный оверлеем", async () => {
    vi.resetModules();
    await import("../src/main");

    // Первая панорама от воркера: объект создан и уходит в AR по ссылке
    const peak = { name: "Тест", lat: 43, lon: 42, ele: 5000 };
    workerInstances[0].onmessage?.(resultMessage([peak]));
    findButton("Включить камеру").click();
    await vi.waitFor(() => expect(captured.arStates).toHaveLength(1));
    const heldByAr = captured.arStates[0];
    expect(heldByAr.peaks).toHaveLength(1);

    // Регресс: switchRegion подменял panorama новым объектом (`{ ...panorama,
    // peaks: [] }`), и AR-оверлей, держащий старую ссылку, навсегда оставался
    // на вершинах прежнего региона
    findButton("Настройки").click();
    await vi.waitFor(() => expect(captured.settingsOptions).toHaveLength(1));
    captured.settingsOptions[0].onRegionChange("alps-west");
    expect(heldByAr.peaks).toHaveLength(0);

    // Следующий расчёт доезжает в тот же объект — оверлей живой
    workerInstances[0].onmessage?.(resultMessage([peak, peak]));
    expect(heldByAr.peaks).toHaveLength(2);
  });
});

describe("гонка таймера статуса", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("новый статус переживает таймаут автоочистки прежнего", async () => {
    vi.resetModules();
    await import("../src/main");

    // Геолокация есть, но спутники не отвечают: «К моему положению»
    // завершится отказом, и статус получит таймер автоочистки (4 с)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response('{"region":"x","generated":"","peaks":[]}', {
        headers: { "content-type": "application/json" },
      }),
    ));
    const failingGeolocation = {
      // Отказ приходит не сразу: сначала срабатывает таймаут «быстрого
      // фикса» (4 с), и только потом — отказ точного запроса. Так статус
      // «Не удалось определить положение» появляется ПОСЛЕ наших advance,
      // и его 4-секундная автоочистка не успевает сработать внутри окна
      getCurrentPosition: (
        _ok: unknown,
        err: () => void,
      ) => {
        setTimeout(err, 5_000);
      },
    };
    Object.defineProperty(navigator, "geolocation", {
      value: failingGeolocation,
      configurable: true,
    });

    vi.useFakeTimers();
    findButton("К моей геопозиции").click();
    // Быстрый фикс (4 с) — по таймауту; отказ точного запроса — через 5 с
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const statusEl = document.getElementById("status")!;
    expect(statusEl.textContent).toBe("Не удалось определить положение");

    // Поверх тоста с таймером приходит статус без таймаута («Расчёт…»).
    // Устаревший setTimeout чистильщика не должен его стереть
    findButton("Вперёд").click();
    expect(statusEl.textContent).toBe("Расчёт панорамы…");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(statusEl.textContent).toBe("Расчёт панорамы…");
  });
});
