// @vitest-environment jsdom
/**
 * Компенсация крена (core/roll-compensation.ts): включена всегда —
 * настройки нет, оверлей доворачивается на видимый крен кадра.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Модули читают screen и держат состояние хвата между тестами —
// пересоздаём на каждый тест и сбрасываем состояние.
async function fresh() {
  vi.resetModules();
  const rc = await import("../src/core/roll-compensation");
  const so = await import("../src/core/screen-orientation");
  so._resetOrientationForTests();
  return { rc, so };
}

/** Подменить screen.orientation (read-only в jsdom) */
function setOrientation(value: unknown): void {
  Object.defineProperty(screen, "orientation", {
    value,
    writable: true,
    configurable: true,
  });
}

describe("overlayRollRad", () => {
  const deg = (v: number): number => (v * Math.PI) / 180;

  beforeEach(() => {
    setOrientation(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("без программного поворота — тождественность", async () => {
    const { rc } = await fresh();
    expect(rc.overlayRollRad(0.123, 0)).toBeCloseTo(0.123, 12);
  });

  it("ровный ландшафтный хват даёт нулевой видимый крен", async () => {
    const { rc } = await fresh();
    // Хват влево: крен датчика −90° при повороте UI −90° — картинка ровная
    expect(rc.overlayRollRad(-Math.PI / 2, -90)).toBeCloseTo(0, 12);
    // Хват вправо: +90° при повороте +90°
    expect(rc.overlayRollRad(Math.PI / 2, 90)).toBeCloseTo(0, 12);
  });

  it("отклонение от ровного хвата проходит без изменений", async () => {
    const { rc } = await fresh();
    // Хват влево с доворотом на 5° по часовой: крен датчика −85°
    expect(rc.overlayRollRad(deg(-85), -90)).toBeCloseTo(deg(5), 12);
    // Хват вправо с доворотом на 5° против часовой: крен датчика +85°
    expect(rc.overlayRollRad(deg(85), 90)).toBeCloseTo(deg(-5), 12);
  });

  it("ландшафтное окно + ландшафтный хват (Android, датчик в координатах устройства): вычитается доворот окна", async () => {
    const { rc, so } = await fresh();
    setOrientation({ type: "landscape-primary", angle: 90 });
    so.notePhysicalTilt(98); // ровный ландшафтный хват: крен датчика ≈ +90°
    // Браузер уже довернул кадр под окно на 90°: видимый крен = 98 − 90 = 8°
    expect(rc.overlayRollRad(deg(98), 0)).toBeCloseTo(deg(8), 12);
    // Второй бок: landscape-secondary, крен −90° → −90 + 90 = 0
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    now += 1000;
    setOrientation({ type: "landscape-secondary", angle: 270 });
    so.notePhysicalTilt(-90);
    expect(rc.overlayRollRad(deg(-90), 0)).toBeCloseTo(0, 12);
  });

  it("ландшафтное окно + события в координатах экрана (iOS, крен ≈ 0): коррекции нет", async () => {
    const { rc, so } = await fresh();
    setOrientation({ type: "landscape-primary", angle: 90 });
    // iOS пересчитывает β/γ под окно: ландшафтный хват выглядит портретным
    so.notePhysicalTilt(0);
    expect(rc.overlayRollRad(0.1, 0)).toBeCloseTo(0.1, 12);
  });

  it("портретное окно не трогает доворот окна даже при ландшафтном хвате", async () => {
    const { rc, so } = await fresh();
    setOrientation({ type: "portrait-primary", angle: 0 });
    so.notePhysicalTilt(-90);
    // Программный ландшафт: вычитается только softAngle, окно не ландшафтное
    expect(rc.overlayRollRad(deg(-90), -90)).toBeCloseTo(0, 12);
  });

  it("при вращении из ландшафта в портрет коррекция не отключается на середине дуги", async () => {
    const { rc, so } = await fresh();
    setOrientation({ type: "landscape-primary", angle: 90 });
    so.notePhysicalTilt(98); // ровный ландшафтный хват: детектор ставит координаты устройства
    // Вращение к портрету: окно ещё ландшафтное, крен прошёл «портретную»
    // зону (30° < 40° — форма хвата по гистерезису уже портретная), но
    // коррекция окна должна держаться: видимый крен = 30 − 90 = −60°
    so.notePhysicalTilt(30);
    expect(rc.overlayRollRad(deg(30), 0)).toBeCloseTo(deg(-60), 12);
    // Дошли до портретного окна: коррекция окна снимается, крен как есть
    setOrientation({ type: "portrait-primary", angle: 0 });
    so.notePhysicalTilt(10);
    expect(rc.overlayRollRad(deg(10), 0)).toBeCloseTo(deg(10), 12);
  });
});
