// @vitest-environment jsdom
/**
 * Ориентация экрана (core/screen-orientation.ts): гибридная стратегия.
 * Выбор запоминается; системный lock пробуется первым (Android PWA),
 * при его отказе или отсутствии (iOS, Firefox, вкладка) — CSS-поворот
 * body на 90°. Проверка «режим действует» — по пропорциям окна, а не по
 * строке type: при повороте ровно на 90° primary/secondary меняются
 * местами и примитивное сравнение ложно решало бы, что фолбэк не сработал.
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
    // jsdom: requestFullscreen у элементов нет — но тесты, где он нужен,
    // подменяют его сами
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

  it("canLockOrientation: ложно без lock в API (iOS), истинно при наличии", async () => {
    const m = await fresh();
    // screen.orientation нет вовсе
    expect(m.canLockOrientation()).toBe(false);
    // iOS: orientation есть, lock — нет
    setOrientation({ type: "portrait-primary" });
    expect(m.canLockOrientation()).toBe(false);
    // Android: lock есть
    setOrientation({ type: "portrait-primary", lock: vi.fn() });
    expect(m.canLockOrientation()).toBe(true);
  });

  it("effectiveOrientation читает type, без type — форму окна", async () => {
    const m = await fresh();
    setOrientation({ type: "landscape-secondary" });
    expect(m.effectiveOrientation()).toBe("landscape");
    setOrientation({ type: "portrait-primary" });
    expect(m.effectiveOrientation()).toBe("portrait");
  });

  it("системный lock срабатывает: CSS-поворот не включается", async () => {
    const lock = vi.fn().mockResolvedValue(undefined);
    setOrientation({ type: "portrait-primary", lock, unlock: vi.fn() });
    const m = await fresh();
    expect(await m.applyOrientation("landscape")).toBe(true);
    expect(lock).toHaveBeenCalledWith("landscape");
    expect(m.softRotated()).toBe(false);
    expect(document.body.style.transform).toBe("");
  });

  it("lock отклонён (нет API) — CSS-поворот body на 90°", async () => {
    // iOS: lock отсутствует
    setOrientation({ type: "portrait-primary" });
    const m = await fresh();
    expect(await m.applyOrientation("landscape")).toBe(true);
    expect(m.softRotated()).toBe(true);
    expect(document.body.style.transform).toBe("rotate(90deg)");
  });

  it("lock отклонён промисом — CSS-поворот body на 90°", async () => {
    // Firefox Android / отказ политики
    setOrientation({
      type: "portrait-primary",
      lock: vi.fn().mockRejectedValue(new Error("fullscreen required")),
      unlock: vi.fn(),
    });
    const m = await fresh();
    expect(await m.applyOrientation("landscape")).toBe(true);
    expect(m.softRotated()).toBe(true);
    expect(document.body.style.transform).toBe("rotate(90deg)");
  });

  it("«портрет» на портретном окне — поворот не нужен", async () => {
    setOrientation({ type: "portrait-primary" });
    const m = await fresh();
    expect(await m.applyOrientation("portrait")).toBe(true);
    expect(m.softRotated()).toBe(false);
    expect(document.body.style.transform).toBe("");
  });

  it("«портрет» на ландшафтном окне — поворачиваем обратно", async () => {
    setOrientation({ type: "landscape-primary" });
    const m = await fresh();
    expect(await m.applyOrientation("portrait")).toBe(true);
    expect(m.softRotated()).toBe(true);
  });

  it("«ландшафт» на ландшафтном окне — поворот не нужен", async () => {
    setOrientation({ type: "landscape-primary" });
    const m = await fresh();
    expect(await m.applyOrientation("landscape")).toBe(true);
    expect(m.softRotated()).toBe(false);
  });

  it("«авто» снимает системный lock", async () => {
    const unlock = vi.fn();
    setOrientation({ type: "portrait-primary", lock: vi.fn(), unlock });
    const m = await fresh();
    // lock успешен — CSS-поворот не включается
    await m.applyOrientation("landscape");
    expect(m.softRotated()).toBe(false);
    expect(await m.applyOrientation("auto")).toBe(true);
    expect(unlock).toHaveBeenCalled();
  });

  it("«авто» снимает CSS-поворот", async () => {
    // iOS: lock нет — «ландшафт» пошёл через CSS
    setOrientation({ type: "portrait-primary" });
    const m = await fresh();
    await m.applyOrientation("landscape");
    expect(m.softRotated()).toBe(true);
    expect(await m.applyOrientation("auto")).toBe(true);
    expect(m.softRotated()).toBe(false);
    expect(document.body.style.transform).toBe("");
  });

  it("orientationMatches: CSS-поворот НЕ считается слетевшим", async () => {
    // Регрессия двойного поворота: после rotate(90deg) системный
    // «landscape-primary» физически становится «portrait-primary» (смена
    // осей). Сравнение по строке type ложно решало бы, что поворот не
    // сработал, и relock крутил бы экран каждый возврат в приложение.
    setOrientation({ type: "portrait-primary" });
    const m = await fresh();
    await m.applyOrientation("landscape"); // lock API нет → CSS-поворот
    // jsdom не считает реальную геометрию повёрнутого окна: innerWidth/
    // innerHeight остаются портретными, что для видимой формы при нашем
    // повороте как раз и означает «ландшафт». Проверяем сам инвариант:
    // matches не должно требовать повторного применения.
    expect(m.orientationMatches("landscape")).toBe(true);
    expect(m.orientationMatches("portrait")).toBe(false);
    expect(m.orientationMatches("auto")).toBe(true); // авто не может слететь
  });

  it("orientationMatches: слетевший системный lock детектируется", async () => {
    const m = await fresh();
    // Экран портретный, а выбран ландшафт, и поворота нет — слетело
    setOrientation({ type: "portrait-primary" });
    expect(m.orientationMatches("landscape")).toBe(false);
    // Физический ландшафт под выбранный ландшафт — на месте
    setOrientation({ type: "landscape-primary" });
    expect(m.orientationMatches("landscape")).toBe(true);
  });

  it("виртуальный viewport при повороте меняет местами ширину и высоту", async () => {
    setOrientation({ type: "portrait-primary" });
    const m = await fresh();
    const { innerWidth: w, innerHeight: h } = window;
    let vv = m.virtualViewport();
    expect(vv.w).toBe(w);
    expect(vv.h).toBe(h);
    await m.applyOrientation("landscape");
    vv = m.virtualViewport();
    expect(vv.w).toBe(h);
    expect(vv.h).toBe(w);
  });

  it("дельты указателя: без поворота — как есть, при повороте — оси переставлены", async () => {
    const m = await fresh();
    expect(m.toLocalDelta(10, 20)).toEqual({ x: 10, y: 20 });
    expect(m.toLocalPoint(10, 20)).toEqual({ x: 10, y: 20 });
    setOrientation({ type: "portrait-primary" });
    await m.applyOrientation("landscape");
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
