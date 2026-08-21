/**
 * Дифференциальный тест быстрого пути DemSampler.sampleLod
 * (docs/boost.md, GPT#1): эталонная копия прежней логики на cell()
 * сравнивается побитово с текущей реализацией — сетки точек, границы
 * тайлов, отсутствующие тайлы.
 */

import { describe, expect, it, vi } from "vitest";
import { DemSampler, TILE_SIZE, type DemIndex } from "../src/core/dem";

const INDEX: DemIndex = {
  bbox: [-180, -90, 180, 90],
  encoding: "gzip",
  filter: "delta-x",
  tileExt: ".bin.gz",
  lods: [
    {
      cellDeg: 1 / 512,
      quantM: 2,
      gridWidth: 360 * 512,
      gridHeight: 180 * 512,
      tilesX: 720,
      tilesY: 360,
      coverage: "",
    },
    {
      cellDeg: 1 / 64,
      quantM: 8,
      gridWidth: 360 * 64,
      gridHeight: 180 * 64,
      tilesX: 90,
      tilesY: 45,
      coverage: "",
    },
  ],
};

/** Детерминированный ГПСЧ (mulberry32) */
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

/** Детерминированный int16-тайл */
function makeTile(seed: number): Int16Array {
  const tile = new Int16Array(TILE_SIZE * TILE_SIZE);
  const rand = rng(seed);
  for (let i = 0; i < tile.length; i++) {
    tile[i] = Math.floor(rand() * 6000) - 200;
  }
  return tile;
}

/** Эталонная копия прежней sampleLod на cell() */
function refSampleLod(
  tiles: Map<string, Int16Array | null>,
  index: DemIndex,
  pos: { lat: number; lon: number },
  lodIndex: number,
): number {
  const lod = index.lods[lodIndex];
  const gx = (pos.lon - index.bbox[0]) / lod.cellDeg;
  const gy = (index.bbox[3] - pos.lat) / lod.cellDeg;
  if (gx < 0 || gy < 0 || gx >= lod.gridWidth - 1 || gy >= lod.gridHeight - 1)
    return NaN;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const cell = (cx: number, cy: number): number | null => {
    const tx = Math.floor(cx / TILE_SIZE);
    const ty = Math.floor(cy / TILE_SIZE);
    const tile = tiles.get(`${lodIndex}/${tx}/${ty}`) ?? null;
    if (tile === null) return null;
    return (
      tile[(cy - ty * TILE_SIZE) * TILE_SIZE + (cx - tx * TILE_SIZE)] *
      (index.lods[lodIndex]?.quantM ?? 1)
    );
  };
  const h00 = cell(x0, y0);
  const h10 = cell(x0 + 1, y0);
  const h01 = cell(x0, y0 + 1);
  const h11 = cell(x0 + 1, y0 + 1);
  if (h00 === null || h10 === null || h01 === null || h11 === null) return NaN;
  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  return top + (bottom - top) * fy;
}

function makeHarness(): {
  sampler: DemSampler;
  tiles: Map<string, Int16Array | null>;
} {
  const sampler = new DemSampler({ baseUrl: "tiles/global" });
  const tiles = new Map<string, Int16Array | null>();
  (sampler as unknown as { index: DemIndex }).index = INDEX;
  (sampler as unknown as { tiles: Map<string, Int16Array | null> }).tiles =
    tiles;
  return { sampler, tiles };
}

/** Позиция по координатам сетки gx/gy (обратная проекция bbox) */
function posAt(
  lodIndex: number,
  gx: number,
  gy: number,
): { lat: number; lon: number } {
  const lod = INDEX.lods[lodIndex];
  return { lon: gx * lod.cellDeg - 180, lat: 90 - gy * lod.cellDeg };
}

describe("DemSampler.sampleLod: быстрый путь ≡ cell() (побитово)", () => {
  it("побитово совпадает с эталоном на случайной сетке и границах", () => {
    const { sampler, tiles } = makeHarness();
    const rand = rng(0xd3d3);
    for (const lodIndex of [0, 1]) {
      // Случайная сетка: тайлы вокруг точки заполняются (3×3)
      for (let k = 0; k < 200; k++) {
        const pos = { lat: -80 + 160 * rand(), lon: -180 + 360 * rand() };
        const lod = INDEX.lods[lodIndex];
        const gx = (pos.lon + 180) / lod.cellDeg;
        const gy = (90 - pos.lat) / lod.cellDeg;
        const tx = Math.floor(gx / TILE_SIZE);
        const ty = Math.floor(gy / TILE_SIZE);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const key = `${lodIndex}/${tx + dx}/${ty + dy}`;
            if (!tiles.has(key)) {
              tiles.set(
                key,
                makeTile(lodIndex * 100000 + tx + dx + 7919 * (ty + dy)),
              );
            }
          }
        }
        expect(sampler.sample(pos, lodIndex)).toBe(
          refSampleLod(tiles, INDEX, pos, lodIndex),
        );
      }
      // Границы тайлов: lx0/ly0 = 0 (быстрый путь) и 255 (fallback)
      for (let t = 0; t < 30; t++) {
        const tx = 1 + Math.floor(rand() * 200);
        const ty = 1 + Math.floor(rand() * 100);
        const base = [
          [tx * TILE_SIZE + 0.5, ty * TILE_SIZE + 0.5], // внутри
          [tx * TILE_SIZE - 0.5, ty * TILE_SIZE - 0.5], // стык четырёх
          [tx * TILE_SIZE + 0.5, ty * TILE_SIZE - 0.5],
          [tx * TILE_SIZE - 0.5, ty * TILE_SIZE + 0.5],
        ] as const;
        for (const [gx0, gy0] of base) {
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const key = `${lodIndex}/${tx + dx}/${ty + dy}`;
              if (!tiles.has(key)) {
                tiles.set(
                  key,
                  makeTile(lodIndex * 100000 + tx + dx + 7919 * (ty + dy)),
                );
              }
            }
          }
          const pos = posAt(lodIndex, gx0, gy0);
          expect(sampler.sample(pos, lodIndex)).toBe(
            refSampleLod(tiles, INDEX, pos, lodIndex),
          );
        }
      }
      // Сетка целиком за пределами bbox → NaN у обеих
      expect(sampler.sample({ lat: 91, lon: 0 }, lodIndex)).toBe(
        refSampleLod(tiles, INDEX, { lat: 91, lon: 0 }, lodIndex),
      );
    }
  });

  it("отсутствующий тайл даёт NaN у обеих реализаций", () => {
    const { sampler, tiles } = makeHarness();
    const rand = rng(0x777);
    for (const lodIndex of [0, 1]) {
      for (let k = 0; k < 100; k++) {
        const pos = { lat: -80 + 160 * rand(), lon: -180 + 360 * rand() };
        // Тайлы не заполняем — либо NaN, либо (если тайл уже есть) равные
        expect(sampler.sample(pos, lodIndex)).toBe(
          refSampleLod(tiles, INDEX, pos, lodIndex),
        );
      }
    }
  });

  it("быстрый путь не зовёт cell, граничный случай — зовёт", () => {
    const { sampler, tiles } = makeHarness();
    const lodIndex = 0;
    const tx = 100;
    const ty = 40;
    const interior = posAt(
      lodIndex,
      tx * TILE_SIZE + 0.5,
      ty * TILE_SIZE + 0.5,
    );
    const edge = posAt(lodIndex, tx * TILE_SIZE - 0.5, ty * TILE_SIZE - 0.5);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        tiles.set(
          `${lodIndex}/${tx + dx}/${ty + dy}`,
          makeTile(tx + dx + 7919 * (ty + dy)),
        );
      }
    }

    const spy = vi.spyOn(
      sampler as unknown as {
        cell: (lodIndex: number, gx: number, gy: number) => number | null;
      },
      "cell",
    );
    expect(sampler.sample(interior, lodIndex)).toBe(
      refSampleLod(tiles, INDEX, interior, lodIndex),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(sampler.sample(edge, lodIndex)).toBe(
      refSampleLod(tiles, INDEX, edge, lodIndex),
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
