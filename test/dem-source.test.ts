/**
 * DemSource: предзагрузка грубой пирамиды в лакунах детального слоя.
 *
 * Регресс: при fineAtOrigin coarse пропускался целиком, и офлайн в лакунах
 * hi-слоя получались дыры — скачанные базовые тайлы лежали в IndexedDB,
 * но в память сэмплера (синхронный sample) не читались.
 */

import { describe, expect, it } from "vitest";
import { TILE_SIZE, type DemIndex } from "../src/core/dem";
import { DemSource } from "../src/core/dem-source";
import { destination, type LatLon } from "../src/core/geo";

const ORIGIN: LatLon = { lat: 43, lon: 42 };

/** Битсет покрытия fine-слоя: заняты тайлы tx 0..3, восточнее — лакуна */
function fineCoverage(): string {
  const tilesX = 12;
  const tilesY = 12;
  const bits = new Uint8Array(Math.ceil((tilesX * tilesY) / 8));
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx <= 3; tx++) {
      const bit = ty * tilesX + tx;
      bits[bit >> 3] |= 1 << (bit & 7);
    }
  }
  let binary = "";
  for (const byte of bits) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const FINE_INDEX: DemIndex = {
  bbox: [41, 42, 44, 45],
  lods: [
    {
      cellDeg: 0.001, // тайл 0.256°
      gridWidth: 3000,
      gridHeight: 3000,
      tilesX: 12,
      tilesY: 12,
      coverage: fineCoverage(),
    },
    {
      cellDeg: 0.004,
      gridWidth: 750,
      gridHeight: 750,
      tilesX: 3,
      tilesY: 3,
      coverage: fineCoverage(),
    },
  ],
};

const COARSE_INDEX: DemIndex = {
  bbox: [-180, -90, 180, 90],
  lods: [
    {
      cellDeg: 1 / 64,
      gridWidth: 360 * 64,
      gridHeight: 180 * 64,
      tilesX: 90,
      tilesY: 45,
    },
  ],
};

function makeSource(): { source: DemSource; coarseTileRequests: () => number } {
  const requested: string[] = [];
  const fetchFn = (async (url: string) => {
    const u = String(url);
    requested.push(u);
    if (u.includes("tiles/fine/index.json")) {
      return new Response(JSON.stringify(FINE_INDEX), {
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("tiles/coarse/index.json")) {
      return new Response(JSON.stringify(COARSE_INDEX), {
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("tiles/coarse/")) {
      // Полный int16-тайл 256×256 (нулевые высоты): cell() читает любую ячейку
      return new Response(
        new Uint8Array(TILE_SIZE * TILE_SIZE * 2) as unknown as BodyInit,
      );
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  const source = new DemSource({
    patchBaseUrls: ["tiles/fine", "tiles/coarse"],
    fetchFn,
  });
  return {
    source,
    coarseTileRequests: () =>
      requested.filter((u) => u.includes("tiles/coarse/") && !u.includes("index")).length,
  };
}

describe("DemSource: предзагрузка грубой пирамиды", () => {
  it("coarse не тянется там, где fine покрывает, и тянется в лакунах", async () => {
    const { source, coarseTileRequests } = makeSource();
    await source.init();

    // На запад от наблюдателя fine покрывает весь луч: coarse — ни одного запроса
    await source.prefetchAlongRay(ORIGIN, -Math.PI / 2, 10_000, 500, destination);
    expect(coarseTileRequests()).toBe(0);

    // На восток за ~2 км начинается лакуна fine: coarse должен подтянуться
    await source.prefetchAlongRay(ORIGIN, Math.PI / 2, 10_000, 500, destination);
    expect(coarseTileRequests()).toBeGreaterThan(0);

    // И в лакуне синхронная выборка падает на coarse, а не в NaN
    const inHole = destination(ORIGIN, Math.PI / 2, 8_000);
    const h = source.sample(inHole, 8_000, {
      lod: source.lodForDistance(8_000),
      zoom: 9,
    });
    expect(Number.isFinite(h)).toBe(true);
  });

  it("без fine-слоя у наблюдателя coarse тянется как раньше", async () => {
    const { source, coarseTileRequests } = makeSource();
    await source.init();
    // Наблюдатель вне bbox fine — fineAtOrigin ложен, coarse предзагружается
    await source.prefetchAlongRay(
      { lat: 40, lon: 30 },
      Math.PI / 2,
      10_000,
      500,
      destination,
    );
    expect(coarseTileRequests()).toBeGreaterThan(0);
  });

  it("высота наблюдателя падает на грубый слой, когда у fine bbox есть, а тайлов нет", async () => {
    // Как у hi-слоя: bbox глобальный, покрытие разреженное. Точка в bbox,
    // но без тайлов (Краснодар — равнина вне p-регионов). Раньше
    // observerHeightSafe бросал «Точка вне покрытия DEM» при живом coarse
    const sparseFine: DemIndex = {
      bbox: [-180, -90, 180, 90],
      lods: [
        {
          cellDeg: 0.001,
          gridWidth: 360_000,
          gridHeight: 180_000,
          tilesX: 1407,
          tilesY: 704,
          // Покрыт только тайл (0,0) — далеко от точки
          coverage: (() => {
            const bits = new Uint8Array(Math.ceil((1407 * 704) / 8));
            bits[0] = 1;
            let binary = "";
            for (const byte of bits) binary += String.fromCharCode(byte);
            return btoa(binary);
          })(),
        },
      ],
    };
    const requested: string[] = [];
    const fetchFn = (async (url: string) => {
      const u = String(url);
      requested.push(u);
      if (u.includes("tiles/sparse/index.json")) {
        return new Response(JSON.stringify(sparseFine), {
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("tiles/coarse/index.json")) {
        return new Response(JSON.stringify(COARSE_INDEX), {
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("tiles/coarse/")) {
        return new Response(
          new Uint8Array(TILE_SIZE * TILE_SIZE * 2) as unknown as BodyInit,
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const source = new DemSource({
      patchBaseUrls: ["tiles/sparse", "tiles/coarse"],
      fetchFn,
    });
    await source.init();

    const h = await source.observerHeightSafe({ lat: 45.035, lon: 38.976 });
    // Coarse-тайл из нулей → высота 0, но главное — не исключение
    expect(h).toBe(0);
  });
});
