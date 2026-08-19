// @vitest-environment jsdom
/**
 * Программная ориентация экрана (core/screen-orientation.ts): выбор
 * запоминается, поворот — CSS-трансформом body (без системного lock и
 * fullscreen). Проверка «режим действует» — по пропорциям окна с поправкой
 * на наш трансформ, а не по строке type: при повороте ровно на 90°
 * primary/secondary меняются местами, и примитивное сравнение ложно решало
 * бы, что поворот не сработал.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Модуль читает localStorage/screen при вызове, так что окружение можно
// настраивать до импорта на каждый тест через vi.resetModules.

async function fresh() {
  vi.resetModules();
  return import("../src/core/screen-orientation");
}

/** Подменить screen.orientation (read-only в jsdom) */
function setOrientation(value: unknown): void {
  Object.defineProperty(screen, "orientation", {
    value,
    writable: true,
    configurable: true,
  });
}

describe("screen-orientation", () => {
  beforeEach(() => {
    localStorage.clear();
    // Поворот и стили прошлого теста не должны протечь в следующий
    document.body.style.cssText = "";
    document.documentElement.style.cssText = "";
    setOrientation(undefined);
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

  it("effectiveOrientation читает type, без type — форму окна", async () => {
    const m = await fresh();
    setOrientation({ type: "landscape-secondary" });
    expect(m.effectiveOrientation()).toBe("landscape");
    setOrientation({ type: "portrait-primary" });
    expect(m.effectiveOrientation()).toBe("portrait");
  });

  it("«авто» не поворачивает", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary" });
    expect(m.applyOrientation("auto")).toBe(true);
    expect(m.softRotated()).toBe(false);
    expect(document.body.style.transform).toBe("");
  });

  it("«ландшафт» на портретном экране поворачивает body на 90°", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary" });
    expect(m.applyOrientation("landscape")).toBe(true);
    expect(m.softRotated()).toBe(true);
    expect(document.body.style.transform).toBe("rotate(90deg)");
  });

  it("«ландшафт» на ландшафтном окне — поворот не нужен (манифест сработал)", async () => {
    const m = await fresh();
    setOrientation({ type: "landscape-primary" });
    expect(m.applyOrientation("landscape")).toBe(true);
    expect(m.softRotated()).toBe(false);
  });

  it("«портрет» на портретном окне — поворот не нужен", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary" });
    expect(m.applyOrientation("portrait")).toBe(true);
    expect(m.softRotated()).toBe(false);
  });

  it("«портрет» на ландшафтном окне поворачивает обратно", async () => {
    const m = await fresh();
    setOrientation({ type: "landscape-primary" });
    expect(m.applyOrientation("portrait")).toBe(true);
    expect(m.softRotated()).toBe(true);
  });

  it("возврат в «авто» снимает поворот и чистит стили", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary" });
    m.applyOrientation("landscape");
    expect(m.softRotated()).toBe(true);
    expect(m.applyOrientation("auto")).toBe(true);
    expect(m.softRotated()).toBe(false);
    expect(document.body.style.transform).toBe("");
    expect(document.body.style.width).toBe("");
  });

  it("orientationMatches: поворот НЕ считается слетевшим", async () => {
    // Регрессия двойного поворота: после rotate(90deg) системная ориентация
    // типа «landscape-primary» физически становится «portrait-primary»
    // (смена осей). Сравнение по строке type ложно решало бы, что поворот
    // не сработал, и пере-применение крутило бы экран при каждом возврате.
    setOrientation({ type: "portrait-primary" });
    const m = await fresh();
    m.applyOrientation("landscape");
    // jsdom не считает реальную геометрию повёрнутого окна: innerWidth/
    // innerHeight остаются портретными, что для видимой формы при нашем
    // повороте как раз и означает «ландшафт». Проверяем инвариант:
    // matches не должно требовать повторного применения.
    expect(m.orientationMatches("landscape")).toBe(true);
    expect(m.orientationMatches("portrait")).toBe(false);
    expect(m.orientationMatches("auto")).toBe(true); // авто не может слететь
  });

  it("orientationMatches: слетевший/ненужный поворот детектируется", async () => {
    const m = await fresh();
    // Экран портретный, выбран ландшафт, поворота нет — не совпадает
    setOrientation({ type: "portrait-primary" });
    expect(m.orientationMatches("landscape")).toBe(false);
    // Физический ландшафт под выбранный ландшафт (манифест) — совпадает
    setOrientation({ type: "landscape-primary" });
    expect(m.orientationMatches("landscape")).toBe(true);
    // А «портрет» на ландшафтном окне без поворота — не совпадает
    expect(m.orientationMatches("portrait")).toBe(false);
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
