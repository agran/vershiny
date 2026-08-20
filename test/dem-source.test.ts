/**
 * DemSource: предзагрузка грубой пирамиды в лакунах детального слоя.
 *
 * Регресс: при fineAtOrigin coarse пропускался целиком, и офлайн в лакунах
 * hi-слоя получались дыры — скачанные базовые тайлы лежали в IndexedDB,
 * но в память сэмплера (синхронный sample) не читались.
 */

import { zlibSync } from "fflate";
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

// --- Кеш lastHit: фолбэк дальней зоны не должен «прилипать» к ближней ---

/** CRC32 для PNG-чанков */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Terrarium-PNG 256×256 с постоянным цветом (высота = r*256 + g − 32768) */
function makeTerrariumPng256(r: number, g: number, b: number): Uint8Array {
  const w = 256;
  const h = 256;
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // фильтр 0
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // битовая глубина
  ihdr[9] = 2; // colorType RGB
  // сжатие 0, фильтр 0, без чересстрочности
  const chunks = new Uint8Array(8 + 12 + 13 + 12 + zlibSync(raw).length + 12);
  let off = 0;
  chunks.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  off = 8;
  chunks.set(pngChunk("IHDR", ihdr), off);
  off += 25;
  const idat = pngChunk("IDAT", zlibSync(raw));
  chunks.set(idat, off);
  off += idat.length;
  chunks.set(pngChunk("IEND", new Uint8Array(0)), off);
  return chunks;
}

describe("DemSource: кеш источника по зонам", () => {
  it("фолбэк дальней зоны на coarse не портит ближние выборки следующего луча", async () => {
    // Регресс (разрыв контура у Краснодара): lastHit был один на все зоны.
    // Хвост луча падал на грубую пирамиду (Terrarium-тайл не догрузился),
    // кеш «прилипал» к ней, и следующие лучи читали ближнюю зону (первые
    // сотни метров!) из 217-м пирамиды — скачок детализации на стыке лучей.
    const png = makeTerrariumPng256(128, 10, 0); // везде 10 м

    const fetchFn = (async (url: string) => {
      const u = String(url);
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
      if (u.includes("terrarium")) {
        return new Response(png as unknown as BodyInit, {
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const source = new DemSource({
      patchBaseUrls: ["tiles/coarse"],
      terrariumBaseUrl: "https://example.invalid/terrarium",
      fetchFn,
    });
    await source.init();
    // Северный луч: ближние z12 и дальние тайлы обоих источников
    await source.prefetchAlongRay(ORIGIN, 0, 60_000, 500, destination);

    // Ближняя зона: Terrarium загружен → 10 м
    const near = destination(ORIGIN, 0, 150);
    expect(source.sample(near, 150, { lod: 0, zoom: 12 })).toBeCloseTo(10, 5);

    // Дальняя зона: coarse первый в порядке → нули (его тайл загружен)
    const far = destination(ORIGIN, 0, 40_000);
    expect(source.sample(far, 40_000, { lod: 0, zoom: 9 })).toBe(0);

    // Снова ближняя: источник обязан вернуться к Terrarium,
    // а не читать 0 из «прилипшего» coarse
    expect(source.sample(near, 150, { lod: 0, zoom: 12 })).toBeCloseTo(10, 5);
  });
});
