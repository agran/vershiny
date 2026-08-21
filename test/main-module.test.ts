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
 * Захваченные из замоканных модулей аргументы: AR-сессия получает геттер
 * панорамы, и регрессия с подменой объекта видна через вызов геттера — он
 * обязан возвращать один и тот же объект до и после смены региона
 */
const captured = vi.hoisted(() => ({
  arStates: [] as Array<() => { peaks: unknown[] } | null>,
  settingsOptions: [] as Array<{ onRegionChange: (region: string) => void }>,
  posted: [] as Array<{
    type: string;
    gen?: number;
    reqId?: number;
    _w: number;
  }>,
}));

// Камера в jsdom невозможна — startAr подменяется, геттер панорамы запоминается
vi.mock("../src/ui/ar", () => ({
  startAr: vi.fn(
    async (
      _video: HTMLVideoElement,
      _canvas: HTMLCanvasElement,
      getState: () => { peaks: unknown[] } | null,
    ) => {
      captured.arStates.push(getState);
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

// Загрузка региона идёт по сети тысячи тайлов — в тесте это заглушка;
// поведение ПОСЛЕ успешной докачки (пересоздание DEM воркера) — настоящее
vi.mock("../src/ui/download", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/ui/download")>();
  return { ...original, downloadRegion: vi.fn().mockResolvedValue(42) };
});

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
      postMessage(msg: unknown) {
        // Метка экземпляра: фоновые цепочки инстансов main.ts из прошлых
        // тестов постят в тот же captured.posted — их надо отфильтровывать
        // (у старых инстансов в обновлённом workerInstances их уже нет,
        // indexOf даёт −1)
        captured.posted.push({
          ...(msg as object),
          _w: workerInstances.indexOf(this),
        } as {
          type: string;
          gen?: number;
          reqId?: number;
          _w: number;
        });
      }
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
      prefetchMs: 1,
      marchMs: 1,
      peaksMs: 1,
      packMs: 1,
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
  // Геолокация-стаб из теста гонки таймеров не должен протекать в соседние
  // тесты: с ним getPosition ждал бы «спутники» по 4–5 с
  Reflect.deleteProperty(navigator, "geolocation");
  workerInstances.length = 0;
  captured.arStates.length = 0;
  captured.settingsOptions.length = 0;
  captured.posted.length = 0;
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
      (b) => b.getAttribute("aria-label") === "Нажмите, чтобы включить компас",
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
    const heldByAr = captured.arStates[0]();
    expect(heldByAr).not.toBeNull();
    const panoramaRef = heldByAr!;
    expect(panoramaRef.peaks).toHaveLength(1);

    // Регресс: switchRegion подменял panorama новым объектом (`{ ...panorama,
    // peaks: [] }`), и AR-оверлей, держащий старую ссылку, навсегда оставался
    // на вершинах прежнего региона. Геттер обязан вернуть ТОТ ЖЕ объект
    findButton("Настройки").click();
    await vi.waitFor(() => expect(captured.settingsOptions).toHaveLength(1));
    captured.settingsOptions[0].onRegionChange("alps-west");
    expect(captured.arStates[0]()).toBe(panoramaRef);
    expect(panoramaRef.peaks).toHaveLength(0);

    // Следующий расчёт доезжает в тот же объект — оверлей живой
    workerInstances[0].onmessage?.(resultMessage([peak, peak]));
    expect(panoramaRef.peaks).toHaveLength(2);
  });
});

describe("гонка таймера статуса", () => {
  beforeEach(() => {
    stubEnvironment();
  });

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

    // Дождаться собственного стартового расчёта ДО fake-таймеров: иначе его
    // requestCompute доползает уже во время advance и перетирает «Не удалось
    // определить положение» своим «Расчёт панорамы…»
    await vi.waitFor(
      () =>
        expect(
          captured.posted.some((m) => m.type === "compute" && m._w === 0),
        ).toBe(true),
      { timeout: 10_000 },
    );

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

/** Ответ воркера с превью (грубый ближний кадр, без пиков) */
function previewMessage(): MessageEvent {
  return {
    data: {
      type: "preview",
      horizon: new Float32Array(1),
      stepRad: 0.5,
      layers: [],
      distanceToHorizonM: new Float32Array(1),
      crests: [],
      observerH: 2000,
      computeMs: 1,
    },
  } as unknown as MessageEvent;
}

describe("превью до полного расчёта", () => {
  beforeEach(() => {
    stubEnvironment();
  });

  it("рисует грубый кадр со статусом «Уточняем детали…», не запуская камеру", async () => {
    vi.resetModules();
    await import("../src/main");

    // Превью приходит первым: панорама есть, но статус неблокирующий
    workerInstances[0].onmessage?.(previewMessage());
    const statusEl = document.getElementById("status")!;
    expect(statusEl.textContent).toBe("Уточняем детали…");
    // Камеру превью не запускает: оверлею нужны пики, их в превью нет
    expect(captured.arStates).toHaveLength(0);

    // Полный результат доезжает: статус гаснет, пики появляются
    workerInstances[0].onmessage?.(
      resultMessage([{ name: "Тест", lat: 43, lon: 42, ele: 5000 }]),
    );
    expect(statusEl.textContent).toBe("");
  });
});

describe("быстрая смена региона не постит устаревший init", () => {
  beforeEach(() => {
    stubEnvironment();
  });

  it("после A→B воркер получает init только последнего региона", async () => {
    vi.resetModules();
    await import("../src/main");

    // Только сообщения воркера ТЕКУЩЕГО инстанса main.ts
    const posted = () => captured.posted.filter((m) => m._w === 0);

    // Стартовый расчёт ушёл — базовая линия зафиксирована
    await vi.waitFor(
      () => expect(posted().some((m) => m.type === "compute")).toBe(true),
      { timeout: 10_000 },
    );
    const computesBefore = posted().filter((m) => m.type === "compute").length;

    findButton("Настройки").click();
    await vi.waitFor(() => expect(captured.settingsOptions).toHaveLength(1));
    const change = captured.settingsOptions[0].onRegionChange;

    // Две смены подряд: init первой отменяется токеном поколения, иначе
    // поздний init A переключал воркер на патч A уже после init B, и расчёт
    // последнего региона шёл по чужому рельефу
    change("region-a");
    change("region-b");

    await vi.waitFor(
      () => {
        const inits = posted().filter(
          (m) => m.type === "init" && (m.gen ?? 0) > 0,
        );
        expect(inits).toHaveLength(1);
        expect(inits[0].gen).toBe(2);
      },
      { timeout: 10_000 },
    );
    // Отменённая смена не пересчитывает панораму: compute — только от
    // последнего региона (все микрозадачи уже открутились, числа финальные)
    const computes = posted().filter((m) => m.type === "compute");
    expect(computes).toHaveLength(computesBefore + 1);
  });
});

describe("докачка региона обновляет DEM воркера", () => {
  beforeEach(() => {
    stubEnvironment();
  });

  it("после успешной загрузки идёт новый init и пересчёт панорамы", async () => {
    vi.resetModules();
    await import("../src/main");

    // Только сообщения воркера ТЕКУЩЕГО инстанса main.ts
    const posted = () => captured.posted.filter((m) => m._w === 0);

    // Стартовый расчёт ушёл — базовая линия зафиксирована
    await vi.waitFor(
      () => expect(posted().some((m) => m.type === "compute")).toBe(true),
      { timeout: 10_000 },
    );
    const initsBefore = posted().filter((m) => m.type === "init").length;
    const computesBefore = posted().filter((m) => m.type === "compute").length;

    // Сэмплеры офлайн-режима запоминали отсутствовавшие тайлы как «пусто»
    // (setTile null), и докачка их не отменяла: новый расчёт возвращал дыры
    // до перезагрузки. Теперь загрузка пересоздаёт источник воркера
    findButton("Скачать регион для офлайна").click();

    await vi.waitFor(
      () => {
        expect(posted().filter((m) => m.type === "init").length).toBe(
          initsBefore + 1,
        );
      },
      { timeout: 10_000 },
    );
    expect(posted().filter((m) => m.type === "compute").length).toBe(
      computesBefore + 1,
    );
  });
});

