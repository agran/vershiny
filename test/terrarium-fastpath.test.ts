/**
 * Дифференциальный тест быстрого пути TerrariumSampler.sample
 * (docs/boost.md, DS-C1): эталонная копия прежних sample/pixelAt
 * сравнивается побитово с текущей реализацией — сетки точек, границы
 * тайлов, шов ±180°, полюсные кромки, отсутствующие соседние тайлы.
 */

import { describe, expect, it, vi } from "vitest";
import { lonLatToTileAndPixel, TerrariumSampler } from "../src/core/terrarium";

const TILE_PX = 256; // = TILE_PX в terrarium.ts (константа не экспортируется)

/** Детерминированный ГПСЧ (mulberry32) — одинаковая сетка на каждом прогоне */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Детерминированный тайл высот по (z, tx, ty) */
function makeTile(z: number, tx: number, ty: number): Float32Array {
  const tile = new Float32Array(TILE_PX * TILE_PX);
  const rand = rng(z * 1000003 + tx * 7919 + ty * 104729);
  for (let i = 0; i < tile.length; i++) tile[i] = -200 + 6000 * rand();
  return tile;
}

/** Эталонные копии прежних pixelAt/sample (до быстрого пути) */
function refPixelAt(
  tiles: Map<string, Float32Array | null>,
  gx: number,
  gy: number,
  zoom: number,
): number {
  const n = 2 ** zoom;
  const world = n * TILE_PX;
  let x = gx % world;
  if (x < 0) x += world;
  const y = Math.min(world - 1, Math.max(0, gy));
  const tile =
    tiles.get(
      `${zoom}/${Math.floor(x / TILE_PX)}/${Math.floor(y / TILE_PX)}`,
    ) ?? null;
  if (tile === null) return NaN;
  return tile[(y % TILE_PX) * TILE_PX + (x % TILE_PX)];
}

function refSample(
  tiles: Map<string, Float32Array | null>,
  pos: { lat: number; lon: number },
  zoom: number,
  zoomHint?: number,
): number {
  const z = zoomHint ?? zoom;
  const t = lonLatToTileAndPixel(pos, z);
  const tile = tiles.get(`${z}/${t.tx}/${t.ty}`) ?? null;
  if (tile === null) return NaN;
  const gx = t.tx * TILE_PX + t.px;
  const gy = t.ty * TILE_PX + t.py;
  const gx0 = Math.floor(gx);
  const gy0 = Math.floor(gy);
  const fx = gx - gx0;
  const fy = gy - gy0;
  const h00 = refPixelAt(tiles, gx0, gy0, z);
  const at = (ax: number, ay: number): number => {
    const v = refPixelAt(tiles, ax, ay, z);
    return Number.isNaN(v) ? h00 : v;
  };
  const h10 = at(gx0 + 1, gy0);
  const h01 = at(gx0, gy0 + 1);
  const h11 = at(gx0 + 1, gy0 + 1);
  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  return top + (bottom - top) * fy;
}

/** Широта по дробной y-координате проекции (в единицах тайлов) */
const latAtY = (yf: number, zoom: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * yf) / 2 ** zoom))) * 180) / Math.PI;

function makeHarness(): {
  sampler: TerrariumSampler;
  tiles: Map<string, Float32Array | null>;
} {
  const sampler = new TerrariumSampler();
  const tiles = new Map<string, Float32Array | null>();
  (sampler as unknown as { tiles: Map<string, Float32Array | null> }).tiles =
    tiles;
  return { sampler, tiles };
}

/** Тайл создаётся один раз на ключ — кеш последнего тайла не устаревает */
function fill(
  tiles: Map<string, Float32Array | null>,
  z: number,
  tx: number,
  ty: number,
): void {
  const key = `${z}/${tx}/${ty}`;
  if (!tiles.has(key)) tiles.set(key, makeTile(z, tx, ty));
}

/** Центральный тайл + соседи для билинейки (восток/юг/юго-восток) */
function fillAround(
  tiles: Map<string, Float32Array | null>,
  z: number,
  tx: number,
  ty: number,
  neighbors: boolean,
): void {
  const n = 2 ** z;
  fill(tiles, z, tx, ty);
  if (!neighbors) return;
  fill(tiles, z, (((tx + 1) % n) + n) % n, ty);
  if (ty + 1 < n) {
    fill(tiles, z, tx, ty + 1);
    fill(tiles, z, (((tx + 1) % n) + n) % n, ty + 1);
  }
}

/** Ручные точки на границах тайла/пикселя (для fallback-ветки) */
function boundaryPoints(
  zoom: number,
  tx: number,
  ty: number,
): { lat: number; lon: number }[] {
  const cellDeg = 360 / (2 ** zoom * TILE_PX);
  const lon0 = (tx / 2 ** zoom) * 360 - 180;
  const lat0 = latAtY(ty, zoom);
  return [
    { lat: lat0, lon: lon0 }, // центр тайла (px, py ≈ 0)
    { lat: lat0, lon: lon0 + 0.5 * cellDeg }, // px ≈ 0.5 — быстрый путь
    { lat: lat0, lon: lon0 + cellDeg - 0.5 * cellDeg }, // px ≈ 255.5
    { lat: latAtY(ty + 0.5 / TILE_PX, zoom), lon: lon0 }, // py ≈ 0.5
    { lat: latAtY(ty + 1 - 0.5 / TILE_PX, zoom), lon: lon0 }, // py ≈ 255.5
    {
      lat: latAtY(ty + 1 - 0.5 / TILE_PX, zoom),
      lon: lon0 + cellDeg - 0.5 * cellDeg,
    }, // угол тайла
  ];
}

describe("TerrariumSampler.sample: быстрый путь ≡ прежняя логика (побитово)", () => {
  it(
    "побитово совпадает с эталоном на случайной сетке и границах",
    { timeout: 60_000 },
    () => {
      const { sampler, tiles } = makeHarness();
      const rand = rng(0x5eed);
      const ZOOMS = [9, 10, 11, 12];
      const cases: { pos: { lat: number; lon: number }; zoom: number }[] = [];

      for (const zoom of ZOOMS) {
        const n = 2 ** zoom;
        // Случайная сетка
        for (let k = 0; k < 40; k++) {
          cases.push({
            pos: { lat: -84.5 + 169 * rand(), lon: -180 + 360 * rand() },
            zoom,
          });
        }
        // Ручные точки на границах случайных тайлов
        for (let t = 0; t < 6; t++) {
          const tx = Math.floor(rand() * n);
          const ty = Math.floor(rand() * n);
          for (const pos of boundaryPoints(zoom, tx, ty)) {
            cases.push({ pos, zoom });
          }
        }
        // Шов ±180° и полюсные кромки
        for (let t = 0; t < 6; t++) {
          const ty = Math.floor(rand() * n);
          cases.push(
            {
              pos: { lat: latAtY(ty + 0.5 / TILE_PX, zoom), lon: 179.9999 },
              zoom,
            },
            {
              pos: { lat: latAtY(ty + 0.5 / TILE_PX, zoom), lon: -179.9999 },
              zoom,
            },
            { pos: { lat: 85.0511, lon: -180 + 360 * rand() }, zoom },
            { pos: { lat: -85.0511, lon: -180 + 360 * rand() }, zoom },
          );
        }
      }

      for (const c of cases) {
        const t = lonLatToTileAndPixel(c.pos, c.zoom);
        fillAround(tiles, c.zoom, t.tx, t.ty, true);
        const got = sampler.sample(c.pos, c.zoom);
        const want = refSample(tiles, c.pos, c.zoom);
        // toBe — сравнение Object.is: NaN равен NaN, −0 отличим от 0
        expect(got).toBe(want);
      }
    },
  );

  it("без соседних тайлов fallback повторяет краевой пиксель, как раньше", () => {
    // Сосед не загружен → pixelAt отдаёт NaN, `at` подменяет его своим
    // краевым пикселем h00. Эталон обязан совпасть и здесь
    const { sampler, tiles } = makeHarness();
    const rand = rng(0x101);
    for (const zoom of [10, 11]) {
      const n = 2 ** zoom;
      for (let t = 0; t < 25; t++) {
        const tx = Math.floor(rand() * n);
        const ty = Math.floor(rand() * n);
        // Только центральный тайл, соседей нет
        for (const pos of boundaryPoints(zoom, tx, ty)) {
          fill(tiles, zoom, tx, ty);
          expect(sampler.sample(pos, zoom)).toBe(refSample(tiles, pos, zoom));
        }
        // Точка в тайле, которого, скорее всего, нет: NaN у обеих
        const far = { lat: -84 + 168 * rand(), lon: -180 + 360 * rand() };
        const t2 = lonLatToTileAndPixel(far, zoom);
        if (!tiles.has(`${zoom}/${t2.tx}/${t2.ty}`)) {
          expect(sampler.sample(far, zoom)).toBe(refSample(tiles, far, zoom));
        }
      }
    }
  });

  it("подсказка зума эквивалентна эталону", () => {
    const { sampler, tiles } = makeHarness();
    const rand = rng(0xabc);
    const pairs = [
      [12, 11],
      [11, 9],
      [10, 10],
      [9, 8],
    ] as const;
    for (const [zoomArg, zoomHint] of pairs) {
      for (let k = 0; k < 60; k++) {
        const pos = { lat: -84 + 168 * rand(), lon: -180 + 360 * rand() };
        const t = lonLatToTileAndPixel(pos, zoomHint);
        fillAround(tiles, zoomHint, t.tx, t.ty, true);
        expect(sampler.sample(pos, zoomArg, zoomHint)).toBe(
          refSample(tiles, pos, zoomArg, zoomHint),
        );
      }
    }
  });

  it("быстрый путь не зовёт pixelAt, граничный случай — зовёт", () => {
    const { sampler, tiles } = makeHarness();
    const zoom = 11;
    const tx = 500;
    const ty = 500;
    const cellDeg = 360 / (2 ** zoom * TILE_PX);
    const lon0 = (tx / 2 ** zoom) * 360 - 180;
    // px = 0.5, py = 0.5 — все четыре узла внутри тайла
    const interior = {
      lat: latAtY(ty + 0.5 / TILE_PX, zoom),
      lon: lon0 + 0.5 * cellDeg,
    };
    // px ≈ 255.5, py ≈ 255.5 — соседи из соседних тайлов
    const edge = {
      lat: latAtY(ty + 1 - 0.5 / TILE_PX, zoom),
      lon: lon0 + cellDeg - 0.5 * cellDeg,
    };
    fillAround(tiles, zoom, tx, ty, true);

    const spy = vi.spyOn(
      sampler as unknown as {
        pixelAt: (gx: number, gy: number, zoom: number) => number;
      },
      "pixelAt",
    );
    expect(sampler.sample(interior, zoom)).toBe(
      refSample(tiles, interior, zoom),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(sampler.sample(edge, zoom)).toBe(refSample(tiles, edge, zoom));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
