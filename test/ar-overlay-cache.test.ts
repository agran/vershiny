// @vitest-environment jsdom
/**
 * Кэш AR-оверлея: полный рендер только по порогам дрейфа/смене содержимого,
 * а живой кадр — два blit. Проверяем пороги и что крен — это поворот blit'а,
 * а не перерендер.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    AR_OVERLAY_REFRESH_FRAMES,
    createArOverlayCache,
    drawArOverlayCached,
} from "../src/ui/ar";
import type { PanoramaState, ViewState } from "../src/ui/panorama";

const VIEW: ViewState = {
  centerAzRad: 1.0,
  tiltRad: 0.1,
  fovRad: (60 * Math.PI) / 180,
  fovVRad: (45 * Math.PI) / 180,
  rollRad: 0.3,
};

function makeState(): PanoramaState {
  return {
    horizon: new Float32Array(360),
    stepRad: (2 * Math.PI) / 360,
    peaks: [],
    layers: [new Float32Array(360)],
  };
}

/** Общий счётчик вызовов всех 2D-контекстов (экран + offscreen-кэш) */
const draws = { drawImage: 0, stroke: 0, fillText: 0, rotate: 0 };

/** Холст-заглушка с записывающим 2D-контекстом */
function makeCanvas(w = 800, h = 450) {
  const canvas = document.createElement("canvas");
  Object.defineProperties(canvas, {
    width: { value: w, writable: true },
    height: { value: h, writable: true },
    clientWidth: { value: w },
    clientHeight: { value: h },
  });
  const ctx = {
    canvas,
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(() => draws.rotate++),
    drawImage: vi.fn(() => draws.drawImage++),
    stroke: vi.fn(() => draws.stroke++),
    strokeText: vi.fn(),
    fillText: vi.fn(() => draws.fillText++),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    createLinearGradient: vi.fn(() => ({ addColorStop: () => {} })),
    set globalAlpha(_v: number) {},
    get globalAlpha() { return 1; },
    set fillStyle(_v: unknown) {},
    set strokeStyle(_v: unknown) {},
    set lineWidth(_v: number) {},
    set lineJoin(_v: string) {},
    set lineCap(_v: string) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
    set miterLimit(_v: number) {},
  };
  canvas.getContext = vi.fn(() => ctx) as never;
  return { canvas, ctx, draws };
}

describe("AR overlay cache", () => {
  beforeEach(() => {
    draws.drawImage = 0;
    draws.stroke = 0;
    draws.fillText = 0;
    draws.rotate = 0;
    // jsdom не умеет 2D: подменяем getContext на всех canvas (включая
    // offscreen-холсты кэша, которые создаются внутри drawArOverlayCached)
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        return ((this as unknown as { __ctx?: unknown }).__ctx ??= {
          canvas: this,
          save: vi.fn(),
          restore: vi.fn(),
          translate: vi.fn(),
          rotate: vi.fn(() => draws.rotate++),
          drawImage: vi.fn(() => draws.drawImage++),
          stroke: vi.fn(() => draws.stroke++),
          strokeText: vi.fn(),
          fillText: vi.fn(() => draws.fillText++),
          setTransform: vi.fn(),
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          quadraticCurveTo: vi.fn(),
          arc: vi.fn(),
          fill: vi.fn(),
          setLineDash: vi.fn(),
          measureText: vi.fn(() => ({ width: 10 })),
          createLinearGradient: vi.fn(() => ({ addColorStop: () => {} })),
          set globalAlpha(_v: number) {},
          get globalAlpha() { return 1; },
          set fillStyle(_v: unknown) {},
          set strokeStyle(_v: unknown) {},
          set lineWidth(_v: number) {},
          set lineJoin(_v: string) {},
          set lineCap(_v: string) {},
          set font(_v: string) {},
          set textAlign(_v: string) {},
          set textBaseline(_v: string) {},
          set miterLimit(_v: number) {},
        }) as never;
      },
    );
  });

  it("первый кадр — полный рендер, последующие — blit", () => {
    const { ctx, draws } = makeCanvas();
    const cache = createArOverlayCache();
    const state = makeState();

    drawArOverlayCached(ctx as never, state, VIEW, 0.3, 0.55, 1, cache);
    const firstRenderStrokes = draws.stroke;
    expect(firstRenderStrokes).toBeGreaterThan(0);
    expect(draws.drawImage).toBe(2); // ridges + labels

    // Тот же вид — только blit, без stroke
    draws.stroke = 0;
    draws.drawImage = 0;
    drawArOverlayCached(ctx as never, state, VIEW, 0.3, 0.55, 1, cache);
    expect(draws.stroke).toBe(0);
    expect(draws.drawImage).toBe(2);
  });

  it("смена крена — поворот blit'а, а не перерендер", () => {
    const { ctx, draws } = makeCanvas();
    const cache = createArOverlayCache();
    const state = makeState();

    drawArOverlayCached(ctx as never, state, VIEW, 0.3, 0.55, 1, cache);
    const renders = draws.stroke;
    expect(renders).toBeGreaterThan(0);

    draws.stroke = 0;
    draws.rotate = 0;
    drawArOverlayCached(ctx as never, state, VIEW, 0.35, 0.55, 1, cache);
    expect(draws.stroke).toBe(0); // не перерендерилось
    expect(draws.rotate).toBe(2); // оба blit повернулись
  });

  it("дрейф азимута за порог перерендеривает, внутри — blit", () => {
    const { ctx, draws } = makeCanvas();
    const cache = createArOverlayCache();
    const state = makeState();

    drawArOverlayCached(ctx as never, state, VIEW, 0, 0.55, 1, cache);
    draws.stroke = 0;

    // Малый дрейф: blit
    const near = { ...VIEW, centerAzRad: VIEW.centerAzRad + 0.01 };
    drawArOverlayCached(ctx as never, state, near, 0, 0.55, 1, cache);
    expect(draws.stroke).toBe(0);

    // Дрейф за половину запаса: перерендер
    const far = {
      ...VIEW,
      centerAzRad: VIEW.centerAzRad + (VIEW.fovRad / 800) * 800 * 0.45 * 0.6,
    };
    drawArOverlayCached(ctx as never, state, far, 0, 0.55, 1, cache);
    expect(draws.stroke).toBeGreaterThan(0);
  });

  it("смена пиков перерендеривает немедленно", () => {
    const { ctx, draws } = makeCanvas();
    const cache = createArOverlayCache();
    const state = makeState();
    drawArOverlayCached(ctx as never, state, VIEW, 0, 0.55, 1, cache);
    draws.stroke = 0;

    const state2 = { ...makeState(), peaks: [{ azimuthRad: 1 } as never] };
    drawArOverlayCached(ctx as never, state2, VIEW, 0, 0.55, 1, cache);
    expect(draws.stroke).toBeGreaterThan(0);
  });

  it("регламентное обновление раз в N кадров", () => {
    const { ctx, draws } = makeCanvas();
    const cache = createArOverlayCache();
    const state = makeState();
    drawArOverlayCached(ctx as never, state, VIEW, 0, 0.55, 1, cache);
    draws.stroke = 0;

    for (let i = 0; i < AR_OVERLAY_REFRESH_FRAMES; i++) {
      drawArOverlayCached(ctx as never, state, VIEW, 0, 0.55, 1, cache);
    }
    expect(draws.stroke).toBeGreaterThan(0);
  });

  it("наклон дальше субпикселя перерендеривает", () => {
    const { ctx, draws } = makeCanvas();
    const cache = createArOverlayCache();
    const state = makeState();
    drawArOverlayCached(ctx as never, state, VIEW, 0, 0.55, 1, cache);
    draws.stroke = 0;

    const tilted = { ...VIEW, tiltRad: VIEW.tiltRad + 0.01 };
    drawArOverlayCached(ctx as never, state, tilted, 0, 0.55, 1, cache);
    expect(draws.stroke).toBeGreaterThan(0);
  });
});
