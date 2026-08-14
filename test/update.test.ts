// @vitest-environment jsdom
/**
 * Плашка «Доступно обновление»: нажатие должно заканчиваться перезагрузкой.
 *
 * Регресс, ради которого написан тест: нажимаешь «Обновить» — и ничего.
 * Причин было две: плашка лежала ниже оверлеев (z-index 60 против 70/100 у
 * карты/настроек), а перезагрузка ждала только `controllerchange`, который
 * на старых Safari приходил не всегда.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/core/i18n";
import { navigation, setupUpdates } from "../src/ui/update";

type Listener = (ev?: unknown) => void;

interface FakeWorker {
  state: ServiceWorkerState;
  postMessage: ReturnType<typeof vi.fn>;
  listeners: Record<string, Listener>;
  addEventListener: (type: string, fn: Listener) => void;
  fire: (type: string, state: ServiceWorkerState) => void;
}

function makeWorker(): FakeWorker {
  const listeners: Record<string, Listener> = {};
  const worker: FakeWorker = {
    state: "installed",
    postMessage: vi.fn(),
    listeners,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    fire: (type, state) => {
      worker.state = state;
      listeners[type]?.();
    },
  };
  return worker;
}

interface FakeRegistration {
  waiting: ServiceWorker | null;
  installing: ServiceWorker | null;
  update: ReturnType<typeof vi.fn>;
  listeners: Record<string, Listener>;
  addEventListener: (type: string, fn: Listener) => void;
}

function makeRegistration(
  waiting: ServiceWorker | null,
  installing: ServiceWorker | null,
): FakeRegistration {
  const listeners: Record<string, Listener> = {};
  return {
    waiting,
    installing,
    update: vi.fn().mockResolvedValue(false),
    listeners,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
  };
}

interface FakeSw {
  controller: object | null;
  listeners: Record<string, Listener>;
  addEventListener: (type: string, fn: Listener) => void;
}

/** jsdom не знает serviceWorker — подставляем минимум, что читает update.ts */
function stubServiceWorker(controller: object | null): FakeSw {
  const listeners: Record<string, Listener> = {};
  const sw: FakeSw = {
    controller,
    listeners,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: sw,
    configurable: true,
  });
  return sw;
}

/** Кнопка «Обновить» на плашке */
function applyButton(): HTMLButtonElement {
  const banner = document.getElementById("update-banner");
  expect(banner).not.toBeNull();
  const button = Array.from(banner!.querySelectorAll("button")).find(
    (b) => b.textContent === "Обновить",
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

describe("плашка «Доступно обновление»", () => {
  let reloadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    setLocale("ru");
    vi.useFakeTimers();
    reloadSpy = vi.spyOn(navigation, "reload").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    reloadSpy.mockRestore();
  });

  it("нажатие отправляет SKIP_WAITING и перезагружается при активации", () => {
    const worker = makeWorker();
    const reg = makeRegistration(worker as unknown as ServiceWorker, null);
    stubServiceWorker({});

    setupUpdates(reg as unknown as ServiceWorkerRegistration);

    const banner = document.getElementById("update-banner");
    // Плашка выше всех оверлеев — иначе клик уходил карте/настройкам
    expect((banner as HTMLElement).style.zIndex).toBe("1000");

    applyButton().click();

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reloadSpy).not.toHaveBeenCalled();

    worker.fire("statechange", "activated");
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("без controllerchange/statechange перезагружается по таймауту", () => {
    const worker = makeWorker();
    const reg = makeRegistration(worker as unknown as ServiceWorker, null);
    stubServiceWorker({});

    setupUpdates(reg as unknown as ServiceWorkerRegistration);
    applyButton().click();

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reloadSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("controllerchange тоже перезагружает (штатный путь)", () => {
    const worker = makeWorker();
    const reg = makeRegistration(worker as unknown as ServiceWorker, null);
    const sw = stubServiceWorker({});

    setupUpdates(reg as unknown as ServiceWorkerRegistration);
    sw.listeners.controllerchange?.();

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("плашка появляется и при updatefound → installed", () => {
    const installing = makeWorker();
    const reg = makeRegistration(null, installing as unknown as ServiceWorker);
    stubServiceWorker({});

    setupUpdates(reg as unknown as ServiceWorkerRegistration);
    expect(document.getElementById("update-banner")).toBeNull();

    reg.listeners.updatefound?.();
    installing.fire("statechange", "installed");

    expect(document.getElementById("update-banner")).not.toBeNull();
  });

  it("без активного controller плашку не показывает", () => {
    const worker = makeWorker();
    const reg = makeRegistration(worker as unknown as ServiceWorker, null);
    stubServiceWorker(null);

    setupUpdates(reg as unknown as ServiceWorkerRegistration);
    expect(document.getElementById("update-banner")).toBeNull();
  });
});
