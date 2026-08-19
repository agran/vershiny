// @vitest-environment jsdom
/**
 * Программная ориентация экрана (core/screen-orientation.ts): выбор
 * запоминается, поворот — CSS-трансформом body (без системного lock),
 * виртуальный viewport меняет местами ширину и высоту, координаты
 * указателя конвертируются в локальные оси.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Модуль читает localStorage/screen при вызове, так что окружение можно
// настраивать до импорта на каждый тест через vi.resetModules.

async function fresh() {
  vi.resetModules();
  return import("../src/core/screen-orientation");
}

describe("screen-orientation", () => {
  beforeEach(() => {
    localStorage.clear();
    // Поворот прошлого теста не должен протечь в следующий
    document.body.style.cssText = "";
    // В jsdom screen.orientation read-only getter — подменяем через defineProperty
    Object.defineProperty(screen, "orientation", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("по умолчанию — авто, без localStorage — авто", async () => {
    const m = await fresh();
    expect(m.storedOrientation()).toBe("auto");
  });

  it("запоминает выбор", async () => {
    const m = await fresh();
    m.rememberOrientation("landscape");
    expect(m.storedOrientation()).toBe("landscape");
    m.rememberOrientation("portrait");
    expect(m.storedOrientation()).toBe("portrait");
    m.rememberOrientation("auto");
    expect(m.storedOrientation()).toBe("auto");
  });

  it("мусор в хранилище читается как авто", async () => {
    localStorage.setItem("vershiny-orientation", "diagonal");
    const m = await fresh();
    expect(m.storedOrientation()).toBe("auto");
  });

  /** Подменить screen.orientation (read-only в jsdom) */
  function setOrientation(value: unknown): void {
    Object.defineProperty(screen, "orientation", {
      value,
      writable: true,
      configurable: true,
    });
  }

  it("applyOrientation: «авто» не поворачивает", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary" });
    expect(m.applyOrientation("auto")).toBe(false);
    expect(m.softRotated()).toBe(false);
    expect(document.body.style.transform).toBe("");
  });

  it("applyOrientation: «ландшафт» на портретном экране поворачивает body", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary" });
    expect(m.applyOrientation("landscape")).toBe(true);
    expect(m.softRotated()).toBe(true);
    expect(document.body.style.transform).toBe("rotate(90deg)");
    // Повторное применение — состояние уже то же, изменения нет
    expect(m.applyOrientation("landscape")).toBe(false);
    expect(m.softRotated()).toBe(true);
  });

  it("applyOrientation: «ландшафт» на ландшафтном окне — поворот не нужен", async () => {
    const m = await fresh();
    setOrientation({ type: "landscape-primary" });
    expect(m.applyOrientation("landscape")).toBe(false);
    expect(m.softRotated()).toBe(false);
  });

  it("applyOrientation: «портрет» на ландшафтном окне поворачивает", async () => {
    const m = await fresh();
    setOrientation({ type: "landscape-primary" });
    expect(m.applyOrientation("portrait")).toBe(true);
    expect(m.softRotated()).toBe(true);
  });

  it("applyOrientation: возврат в «авто» снимает поворот и чистит стили", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary" });
    m.applyOrientation("landscape");
    expect(m.applyOrientation("auto")).toBe(true);
    expect(m.softRotated()).toBe(false);
    expect(document.body.style.transform).toBe("");
    expect(document.body.style.width).toBe("");
  });

  it("effectiveOrientation читает type, без type — форму окна", async () => {
    const m = await fresh();
    setOrientation({ type: "landscape-secondary" });
    expect(m.effectiveOrientation()).toBe("landscape");
    setOrientation({ type: "portrait-primary" });
    expect(m.effectiveOrientation()).toBe("portrait");
  });

  it("виртуальный viewport при повороте меняет местами ширину и высоту", async () => {
    const m = await fresh();
    const { innerWidth: w, innerHeight: h } = window;
    let vv = m.virtualViewport();
    expect(vv.w).toBe(w);
    expect(vv.h).toBe(h);
    setOrientation({ type: "portrait-primary" });
    m.applyOrientation("landscape");
    vv = m.virtualViewport();
    expect(vv.w).toBe(h);
    expect(vv.h).toBe(w);
  });

  it("дельты указателя: без поворота — как есть, при повороте — оси переставлены", async () => {
    const m = await fresh();
    expect(m.toLocalDelta(10, 20)).toEqual({ x: 10, y: 20 });
    expect(m.toLocalPoint(10, 20)).toEqual({ x: 10, y: 20 });
    setOrientation({ type: "portrait-primary" });
    m.applyOrientation("landscape");
    // Поворот на 90°: локальный +x — физический +y, локальный +y — физический −x
    expect(m.toLocalDelta(10, 20)).toEqual({ x: 20, y: -10 });
  });

  it("программный поворот: нет body — сообщаем неуспех", async () => {
    const m = await fresh();
    // document.body в jsdom есть всегда; имитируем его отсутствие
    const body = document.body;
    Object.defineProperty(document, "body", {
      value: null,
      configurable: true,
    });
    expect(m.applySoftRotation(true)).toBe(false);
    Object.defineProperty(document, "body", {
      value: body,
      configurable: true,
    });
  });
});
