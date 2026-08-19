// @vitest-environment jsdom
/**
 * Автоматическая ориентация экрана (core/screen-orientation.ts): интерфейс
 * следует за хватом телефона — поворот CSS-трансформом body (без системного
 * lock и fullscreen). Форма хвата (портрет/ландшафт) и сторона берутся из
 * угла крена с гистерезисом; перехват другим боком переворачивает UI на 180°.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Модуль читает screen при вызове, так что окружение можно настраивать
// до импорта на каждый тест через vi.resetModules.

async function fresh() {
  vi.resetModules();
  const m = await import("../src/core/screen-orientation");
  // Модуль держит сторону, форму хвата и время последнего переворота между
  // тестами — сбрасываем, иначе один тест влияет на следующий
  m._resetOrientationForTests();
  return m;
}

/** Подменить screen.orientation (read-only в jsdom) */
function setOrientation(value: unknown): void {
  Object.defineProperty(screen, "orientation", {
    value,
    writable: true,
    configurable: true,
  });
}

describe("screen-orientation: автоповорот по хвату", () => {
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

  it("effectiveOrientation читает type, без type — форму окна", async () => {
    const m = await fresh();
    setOrientation({ type: "landscape-secondary" });
    expect(m.effectiveOrientation()).toBe("landscape");
    setOrientation({ type: "portrait-primary" });
    expect(m.effectiveOrientation()).toBe("portrait");
  });

  it("до первого показания датчика поворот не включается", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary" });
    expect(m.syncOrientation()).toBe(false);
    expect(m.softRotated()).toBe(false);
    expect(document.body.style.transform).toBe("");
  });

  it("портретный хват на портретном окне не поворачивает", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary", angle: 0 });
    m.notePhysicalTilt(0); // первое показание: портрет
    expect(m.syncOrientation()).toBe(true);
    expect(m.softRotated()).toBe(false);
  });

  it("ландшафтный хват на портретном окне поворачивает body по стороне хвата", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary", angle: 0 });
    m.notePhysicalTilt(-80); // хват влево
    m.syncOrientation();
    expect(m.softAngleDeg()).toBe(-90);
    expect(document.body.style.transform).toBe("rotate(-90deg)");
  });

  it("перехват другим боком переворачивает UI на 180°", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary", angle: 0 });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    m.notePhysicalTilt(-80); // хват влево
    m.syncOrientation();
    expect(m.softAngleDeg()).toBe(-90);
    now += 1000;
    m.notePhysicalTilt(80); // перехват вправо
    m.syncOrientation();
    expect(m.softAngleDeg()).toBe(90);
  });

  it("гистерезис: наклон ландшафтного хвата не роняет UI в портрет", async () => {
    const m = await fresh();
    setOrientation({ type: "portrait-primary", angle: 0 });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    m.notePhysicalTilt(-80);
    m.syncOrientation();
    expect(m.softAngleDeg()).toBe(-90);
    // Наклон к −50°: ещё ландшафт (порог возврата в портрет — 40°)
    now += 1000;
    m.notePhysicalTilt(-50);
    m.syncOrientation();
    expect(m.softAngleDeg()).toBe(-90);
    // Под 40° — возврат в портрет
    now += 1000;
    m.notePhysicalTilt(-30);
    m.syncOrientation();
    expect(m.softRotated()).toBe(false);
    expect(document.body.style.transform).toBe("");
  });

  it("onVisibleFormChange зовётся на первом показании и при смене формы/стороны", async () => {
    const m = await fresh();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const calls: number[] = [];
    m.onVisibleFormChange(() => calls.push(1));
    m.notePhysicalTilt(0); // первое показание
    expect(calls).toHaveLength(1);
    now += 1000;
    m.notePhysicalTilt(-80); // вход в ландшафт
    expect(calls).toHaveLength(2);
    // Мёртвая зона стороны (|roll| < 75°): смена не зовётся
    now += 1000;
    m.notePhysicalTilt(-50);
    expect(calls).toHaveLength(2);
    now += 1000;
    m.notePhysicalTilt(80); // перехват другим боком
    expect(calls).toHaveLength(3);
  });

  it("дебаунс глушит вспышки у порога", async () => {
    const m = await fresh();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const calls: number[] = [];
    m.onVisibleFormChange(() => calls.push(1));
    m.notePhysicalTilt(-80); // первое показание — сразу
    expect(calls).toHaveLength(1);
    now += 100;
    m.notePhysicalTilt(80); // смена стороны слишком рано — глушится
    expect(calls).toHaveLength(1);
    now += 1000;
    m.notePhysicalTilt(80); // за окном дебаунса — проходит
    expect(calls).toHaveLength(2);
  });

  it("ландшафтное окно (манифест) не поворачивается при ландшафтном хвате", async () => {
    const m = await fresh();
    setOrientation({ type: "landscape-primary", angle: 90 });
    m.notePhysicalTilt(-80);
    m.syncOrientation();
    expect(m.softRotated()).toBe(false);
  });

  it("портретный хват на ландшафтном окне поворачивает обратно", async () => {
    const m = await fresh();
    setOrientation({ type: "landscape-primary", angle: 90 });
    m.notePhysicalTilt(0);
    m.syncOrientation();
    expect(m.softRotated()).toBe(true);
  });

  it("виртуальный viewport при повороте меняет местами ширину и высоту", async () => {
    const m = await fresh();
    const { innerWidth: w, innerHeight: h } = window;
    let vv = m.virtualViewport();
    expect(vv.w).toBe(w);
    expect(vv.h).toBe(h);
    setOrientation({ type: "portrait-primary", angle: 0 });
    m.notePhysicalTilt(-80);
    m.syncOrientation();
    vv = m.virtualViewport();
    expect(vv.w).toBe(h);
    expect(vv.h).toBe(w);
  });

  it("дельты указателя: без поворота — как есть, при повороте — оси переставлены", async () => {
    const m = await fresh();
    expect(m.toLocalDelta(10, 20)).toEqual({ x: 10, y: 20 });
    expect(m.toLocalPoint(10, 20)).toEqual({ x: 10, y: 20 });
    setOrientation({ type: "portrait-primary", angle: 0 });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // Хват влево: обратный поворот R(−softAngle) —
    // локальный +x — физический −y, локальный +y — физический +x
    m.notePhysicalTilt(-80);
    m.syncOrientation();
    expect(m.toLocalDelta(10, 20)).toEqual({ x: -20, y: 10 });
    // Хват вправо — зеркально
    now += 1000;
    m.notePhysicalTilt(80);
    m.syncOrientation();
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
