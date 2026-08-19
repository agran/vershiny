// @vitest-environment jsdom
/**
 * Доворот кадра камеры (core/frame-orientation.ts): кадр getUserMedia
 * приходит «ровным» относительно окна, а интерфейс может быть повёрнут
 * CSS-трансформом body (программный ландшафт) — при отрисовке кадр
 * доворачивается обратно на −softAngle, иначе картинка лежит на боку.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Свежие модули на каждый тест: softAngle — состояние между тестами не течёт */
async function fresh() {
  vi.resetModules();
  const fo = await import("../src/core/frame-orientation");
  const so = await import("../src/core/screen-orientation");
  so._resetOrientationForTests();
  return { fo, so };
}

/** Подменить screen.orientation (read-only в jsdom) */
function setOrientation(value: unknown): void {
  Object.defineProperty(screen, "orientation", {
    value,
    writable: true,
    configurable: true,
  });
}

/** Контекст-заглушка, записывающая вызовы трансформов и drawImage */
function recordingCtx(): {
  ctx: CanvasRenderingContext2D;
  calls: string[];
} {
  const calls: string[] = [];
  const ctx = {
    canvas: { width: 0, height: 0 } as HTMLCanvasElement,
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    translate: (x: number, y: number) =>
      calls.push(`translate ${x} ${y}`),
    rotate: (a: number) => calls.push(`rotate ${a}`),
    scale: (x: number, y: number) => calls.push(`scale ${x} ${y}`),
    drawImage: (_video: unknown, ...rest: number[]) =>
      calls.push(`drawImage ${rest.join(" ")}`),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("frame-orientation", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.style.cssText = "";
    document.documentElement.style.cssText = "";
    setOrientation(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("без программного поворота доворот нулевой", async () => {
    const { fo } = await fresh();
    expect(fo.frameRotationDeg(0)).toBe(0);
    expect(fo.currentFrameRotationDeg()).toBe(0);
  });

  it("поворот интерфейса на ±90° даёт обратный доворот кадра", async () => {
    const { fo } = await fresh();
    expect(fo.frameRotationDeg(90)).toBe(270);
    expect(fo.frameRotationDeg(-90)).toBe(90);
  });

  it("в программном ландшафте доворот равен −softAngle", async () => {
    const { fo, so } = await fresh();
    setOrientation({ type: "portrait-primary", angle: 0 });
    // Управляем временем: дебаунс перехвата не должен глушить возврат
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    so.notePhysicalTilt(-80); // хват влево
    so.syncOrientation();
    expect(so.softAngleDeg()).toBe(-90);
    expect(fo.currentFrameRotationDeg()).toBe(90);
    // Возврат в портретный хват снимает и доворот
    now += 1000;
    so.notePhysicalTilt(0);
    so.syncOrientation();
    expect(fo.currentFrameRotationDeg()).toBe(0);
  });

  it("эффективные размеры кадра при ±90° меняются местами", async () => {
    const { fo } = await fresh();
    expect(fo.rotatedFrameSize(1920, 1080, 0)).toEqual({ w: 1920, h: 1080 });
    expect(fo.rotatedFrameSize(1920, 1080, 90)).toEqual({ w: 1080, h: 1920 });
    expect(fo.rotatedFrameSize(1920, 1080, 270)).toEqual({ w: 1080, h: 1920 });
    expect(fo.rotatedFrameSize(1920, 1080, 180)).toEqual({ w: 1920, h: 1080 });
  });

  it("drawVideoAligned: без доворота — обычный cover-кроп по центру", async () => {
    const { fo } = await fresh();
    const { ctx, calls } = recordingCtx();
    const video = {
      videoWidth: 640,
      videoHeight: 480,
    } as HTMLVideoElement;
    // Цель 1280×720: масштаб 2 — кадр 1280×960, срезается сверху/снизу
    fo.drawVideoAligned(ctx, video, 1280, 720, 0);
    expect(calls).toEqual(["drawImage 0 -120 1280 960"]);
  });

  it("drawVideoAligned: при 90° рисует через поворот, кропа нет при своих пропорциях", async () => {
    const { fo } = await fresh();
    const { ctx, calls } = recordingCtx();
    const video = {
      videoWidth: 640,
      videoHeight: 480,
    } as HTMLVideoElement;
    // Повёрнутый кадр 480×640, цель 480×640 — масштаб 1, без кропа
    fo.drawVideoAligned(ctx, video, 480, 640, 90);
    expect(calls).toEqual([
      "save",
      "translate 240 320",
      `rotate ${Math.PI / 2}`,
      "scale 1 1",
      "drawImage -320 -240",
      "restore",
    ]);
  });
});
