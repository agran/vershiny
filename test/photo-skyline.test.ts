/**
 * Линия неба фото в пикселях полного кадра (core/photo-skyline.ts).
 *
 * Кадр синтетический: гладкое небо над рельефом с шершавой текстурой.
 * Проверяется то, ради чего модуль существует: точки лежат на настоящей
 * кромке с точностью порядка пикселя (грубая сетка экстрактора 160×120
 * дала бы 3–6 px), а не на сетке и не на выбросах.
 */

import { describe, it, expect } from "vitest";
import { extractPhotoSkylinePoints } from "../src/core/photo-skyline";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Высота кромки (строка первого пикселя земли) в колонке x */
function ridgeAt(x: number, h: number): number {
  return (
    0.45 * h +
    0.08 * h * Math.sin(x / 140) +
    0.04 * h * Math.sin(x / 37 + 1) +
    (x > 700 && x < 820 ? 0.12 * h : 0)
  );
}

function renderFrame(w: number, h: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const rand = rng(5);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const edge = ridgeAt(x, h);
      // Субпиксельная кромка: пиксель на границе — смесь неба и земли
      const cover = Math.max(0, Math.min(1, y + 1 - edge));
      const skyR = 110 + 30 * (y / h);
      const skyG = 160 + 20 * (y / h);
      const skyB = 225;
      const noise = (rand() - 0.5) * 70;
      const gr = 70 + noise;
      const gg = 85 + noise;
      const gb = 60 + noise * 0.8;
      rgba[i] = skyR * (1 - cover) + gr * cover;
      rgba[i + 1] = skyG * (1 - cover) + gg * cover;
      rgba[i + 2] = skyB * (1 - cover) + gb * cover;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe("extractPhotoSkylinePoints", () => {
  it("точки лежат на кромке с точностью порядка пикселя", () => {
    const w = 1280;
    const h = 720;
    const pts = extractPhotoSkylinePoints(renderFrame(w, h), w, h);
    expect(pts.x.length).toBeGreaterThan(200);
    const errs: number[] = [];
    for (let k = 0; k < pts.x.length; k++) {
      errs.push(Math.abs(pts.y[k] - ridgeAt(pts.x[k] - 0.5, h)));
    }
    errs.sort((a, b) => a - b);
    const median = errs[errs.length >> 1];
    const p90 = errs[Math.floor(errs.length * 0.9)];
    expect(median).toBeLessThan(1.2);
    expect(p90).toBeLessThan(3);
    // Охват: линия идёт почти через весь кадр
    const span = pts.x[pts.x.length - 1] - pts.x[0];
    expect(span).toBeGreaterThan(w * 0.9);
  });

  it("затравка нейросети: линия идёт по гребню, а не по кромке тучи выше", () => {
    const w = 1280;
    const h = 720;
    const rgba = renderFrame(w, h);
    // Тёмная туча над гребнем: её нижняя кромка резче, чем «небо/земля»
    for (let y = Math.round(0.12 * h); y < Math.round(0.2 * h); y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = 40;
        rgba[i + 1] = 45;
        rgba[i + 2] = 60;
      }
    }
    // Затравка — гребень с ошибкой нейросети в пару пикселей, 518 колонок
    const seed = new Float32Array(518);
    for (let c = 0; c < seed.length; c++) {
      const x = ((c + 0.5) / seed.length) * w;
      seed[c] = (ridgeAt(x, h) + 2.5) / h;
    }
    const pts = extractPhotoSkylinePoints(rgba, w, h, { seed });
    expect(pts.x.length).toBeGreaterThan(200);
    const errs: number[] = [];
    for (let k = 0; k < pts.x.length; k++) {
      errs.push(Math.abs(pts.y[k] - ridgeAt(pts.x[k] - 0.5, h)));
    }
    errs.sort((a, b) => a - b);
    // Затравка сдвинута на 2.5 px, доводка по перепаду возвращает на кромку
    expect(errs[errs.length >> 1]).toBeLessThan(1.5);
    expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(4);
  });

  it("текстура под кромкой: линия идёт по гребню, а не по кромке тёмной тучи", () => {
    const w = 1280;
    const h = 720;
    const rgba = renderFrame(w, h);
    // Тёмная плотная туча над гребнем с мягким рельефом яркости: её нижняя
    // кромка контрастнее «небо/земля», но мелкой фактуры у неё нет
    for (let y = Math.round(0.12 * h); y < Math.round(0.24 * h); y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const k = 1 + 0.15 * Math.sin(x / 90 + y / 30);
        rgba[i] = 40 * k;
        rgba[i + 1] = 45 * k;
        rgba[i + 2] = 60 * k;
      }
    }
    const pts = extractPhotoSkylinePoints(rgba, w, h, { texture: true });
    expect(pts.source).toBe("texture");
    expect(pts.x.length).toBeGreaterThan(200);
    const errs: number[] = [];
    for (let k = 0; k < pts.x.length; k++) {
      errs.push(Math.abs(pts.y[k] - ridgeAt(pts.x[k] - 0.5, h)));
    }
    errs.sort((a, b) => a - b);
    expect(errs[errs.length >> 1]).toBeLessThan(2);
    expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(5);
    const span = pts.x[pts.x.length - 1] - pts.x[0];
    expect(span).toBeGreaterThan(w * 0.9);
  });

  it("текстура под кромкой: чистое небо — результат как у обычного кадра", () => {
    const w = 1280;
    const h = 720;
    const pts = extractPhotoSkylinePoints(renderFrame(w, h), w, h, {
      texture: true,
    });
    expect(pts.source).toBe("texture");
    const errs = Array.from(pts.x, (x, k) =>
      Math.abs(pts.y[k] - ridgeAt(x - 0.5, h)),
    ).sort((a, b) => a - b);
    expect(errs[errs.length >> 1]).toBeLessThan(1.5);
  });

  it("текстура под кромкой: сплошное небо — нет линии, откат на обычный экстрактор", () => {
    const w = 640;
    const h = 360;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = 100;
        rgba[i + 1] = 150 + (y / h) * 10;
        rgba[i + 2] = 230;
        rgba[i + 3] = 255;
      }
    }
    const pts = extractPhotoSkylinePoints(rgba, w, h, { texture: true });
    expect(pts.source).not.toBe("texture");
    expect(pts.x.length).toBeLessThan(40);
  });

  it("сплошное небо без земли — почти пустой результат", () => {
    const w = 640;
    const h = 360;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = 100;
        rgba[i + 1] = 150 + (y / h) * 10;
        rgba[i + 2] = 230;
        rgba[i + 3] = 255;
      }
    }
    const pts = extractPhotoSkylinePoints(rgba, w, h);
    expect(pts.x.length).toBeLessThan(40);
  });

  it("слишком маленький кадр — пусто, без исключений", () => {
    const pts = extractPhotoSkylinePoints(
      new Uint8ClampedArray(64 * 64 * 4),
      64,
      64,
    );
    expect(pts.x.length).toBe(0);
  });
});
