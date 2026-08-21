/**
 * Обрезка офлайн-лучей по зонду покрытия (computeNeverAgain): интеграционный
 * прогон с РЕАЛЬНЫМИ сэмплерами. Инвариант: профиль, посчитанный с зондом,
 * обязан совпадать бит-в-бит с профилем без зонда — зонд консервативен
 * (любой загруженный тайл = «данные есть»), поэтому обрезка не должна
 * терять ни одного видимого шага.
 *
 * Регресс: после внедрения зонда контуры пропадали при предзагруженных
 * данных региона.
 */

import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { computeLayeredHorizon } from "../src/core/horizon";
import { DemSource } from "../src/core/dem-source";
import { TILE_SIZE, type DemIndex } from "../src/core/dem";
import { destination, type LatLon } from "../src/core/geo";

const ORIGIN: LatLon = { lat: 43.318, lon: 42.458 }; // Приют 11

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Тайл с линейным «склоном»: высота = 1000 + x·4 + y·8 метров */
function slopeTile(): Int16Array {
  const heights = new Int16Array(TILE_SIZE * TILE_SIZE);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      heights[y * TILE_SIZE + x] = 1000 + x * 4 + y * 8;
    }
  }
  return heights;
}

async function encodeTile(heights: Int16Array, quantM: number): Promise<Uint8Array> {
  const delta = new Int16Array(TILE_SIZE * TILE_SIZE);
  for (let y = 0; y < TILE_SIZE; y++) {
    const row = y * TILE_SIZE;
    let prev = 0;
    for (let x = 0; x < TILE_SIZE; x++) {
      const value = Math.round(heights[row + x] / quantM);
      delta[row + x] = x === 0 ? value : value - prev;
      prev = value;
    }
  }
  return gzip(new Uint8Array(delta.buffer));
}

/** Индекс глобальной пирамиды (карты покрытия нет — «может быть» везде) */
function pyramidIndex(cellDeg: number, quantM: number): DemIndex {
  const grid = Math.round(360 / cellDeg);
  const gridH = Math.round(180 / cellDeg);
  return {
    bbox: [-180, -90, 180, 90],
    encoding: "gzip",
    filter: "delta-x",
    lods: [
      {
        cellDeg,
        quantM,
        gridWidth: grid,
        gridHeight: gridH,
        tilesX: grid / TILE_SIZE,
        tilesY: gridH / TILE_SIZE,
      },
    ],
  };
}

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
function makeTerrariumPng256(r: number, g: number, b: number): Uint8Array {
  const w = 256;
  const h = 256;
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
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
  ihdr[8] = 8;
  ihdr[9] = 2;
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

/** Ташлый ключ тайла пирамиды для точки (глобальная сетка, cellDeg) */
function pyramidTileKey(pos: LatLon, cellDeg: number, lod = 0): string {
  const gx = Math.floor((pos.lon + 180) / cellDeg / TILE_SIZE);
  const gy = Math.floor((90 - pos.lat) / cellDeg / TILE_SIZE);
  return `${lod}/${gx}/${gy}`;
}

/** Офлайн-источник: данные только в «скачанном» bbox вокруг наблюдателя */
async function makeOfflineSource(opts: {
  regionBbox: [number, number, number, number];
  hiCellDeg: number;
  hiQuant: number;
  globalCellDeg: number;
  globalQuant: number;
  terrariumZooms: Set<number>;
  terrariumHole?: [number, number, number]; // z/x/y без данных (дыра в кеше)
}): Promise<{ source: DemSource; loaded: Set<string> }> {
  const hiIndex = pyramidIndex(opts.hiCellDeg, opts.hiQuant);
  const globalIndex = pyramidIndex(opts.globalCellDeg, opts.globalQuant);
  const tileCache = new Map<string, Uint8Array>();
  const loaded = new Set<string>();

  // «Скачанный» набор: все тайлы пирамид и Terrarium внутри regionBbox

  const seedPyramid = async (cellDeg: number, quant: number, base: string) => {
    const step = cellDeg * TILE_SIZE;
    for (let lon = opts.regionBbox[0]; lon <= opts.regionBbox[2]; lon += step) {
      for (let lat = opts.regionBbox[1]; lat <= opts.regionBbox[3]; lat += step) {
        const key = pyramidTileKey({ lat: Math.min(lat, 89.9), lon }, cellDeg);
        if (!tileCache.has(key)) {
          tileCache.set(key, await encodeTile(slopeTile(), quant));
          loaded.add(`${base}/${key}`);
        }
      }
    }
  };
  await seedPyramid(opts.hiCellDeg, opts.hiQuant, "hi");
  await seedPyramid(opts.globalCellDeg, opts.globalQuant, "global");

  // Terrarium: z10-тайл над наблюдателем (и соседние) — «PNG в кеше»
  const zTiles: [number, number][] = [];
  for (const z of opts.terrariumZooms) {
    const n = 2 ** z;
    const tx = Math.floor(((ORIGIN.lon + 180) / 360) * n);
    const ty = Math.floor(((90 - ORIGIN.lat) / 180) * n);
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ] as const) {
      zTiles.push([tx + dx, ty + dy]);
    }
  }
  const png = makeTerrariumPng256(128, 10, 0); // везде 10 м

  const fetchFn = (async (url: string) => {
    const u = String(url);
    if (u.includes("tiles/hi/index.json")) {
      return new Response(JSON.stringify(hiIndex), {
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("tiles/global/index.json")) {
      return new Response(JSON.stringify(globalIndex), {
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("tiles/hi/") || u.includes("tiles/global/")) {
      const key = u.split("tiles/")[1].split("?")[0];
      const body = tileCache.get(key);
      if (!body) return new Response("", { status: 404 });
      return new Response(body as unknown as BodyInit);
    }
    if (u.includes("terrarium")) {
      const m = u.match(/(\d+)\/(\d+)\/(\d+)\.png/);
      if (!m) return new Response("", { status: 404 });
      const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (
        opts.terrariumHole &&
        z === opts.terrariumHole[0] &&
        x === opts.terrariumHole[1] &&
        y === opts.terrariumHole[2]
      ) {
        return new Response("", { status: 404 });
      }
      if (opts.terrariumZooms.has(z) && zTiles.some(([a, b]) => a === x && b === y)) {
        return new Response(png as unknown as BodyInit, {
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  const source = new DemSource({
    patchBaseUrls: ["tiles/hi", "tiles/global"],
    terrariumBaseUrl: "https://example.invalid/terrarium",
    fetchFn,
    offlineFirst: true,
  });
  await source.init();
  return { source, loaded };
}

/** Волна 2 воркера: полный веер до 200 км */
async function fullPrefetch(source: DemSource): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (let az = 0; az < 2 * Math.PI; az += (5 * Math.PI) / 180) {
    tasks.push(source.prefetchAlongRay(ORIGIN, az, 200_000, 8_000, destination));
  }
  await Promise.all(tasks);
}

function assertBitwiseEqual(baseline: unknown, capped: unknown): void {
  expect(capped).toEqual(baseline);
}

describe("Офлайн-обрезка лучей: зонд ≡ выборка", () => {
  it("скачанный регион: обрезка по зонду не меняет профиль бит-в-бит", async () => {
    const { source } = await makeOfflineSource({
      regionBbox: [41.5, 42.5, 44, 44],
      hiCellDeg: 1 / 512,
      hiQuant: 2,
      globalCellDeg: 1 / 512,
      globalQuant: 4,
      terrariumZooms: new Set([9, 10, 11, 12]),
    });
    await fullPrefetch(source);

    const sampleFn = (pos: LatLon, distM: number, hint?: { lod: number; zoom: number }) =>
      source.sample(pos, distM, hint);
    const marchDeps = { lodForDistance: (d: number) => source.lodForDistance(d) };

    const baseline = computeLayeredHorizon(ORIGIN, 4208, sampleFn, { marchDeps });
    const capped = computeLayeredHorizon(ORIGIN, 4208, sampleFn, {
      marchDeps,
      coverageProbe: (pos: LatLon) => source.mayHaveOfflineData(pos),
    });

    assertBitwiseEqual(baseline.layers, capped.layers);
    assertBitwiseEqual(baseline.distanceToHorizonM, capped.distanceToHorizonM);
    assertBitwiseEqual(baseline.crests, capped.crests);
    assertBitwiseEqual(baseline.fronts, capped.fronts);
  });

  it("дыра в кеше Terrarium не режет данные за ней (вход в соседний тайл)", async () => {
    // Луч проходит загруженный z10-тайл, дыру (404) и снова загруженный
    // тайл. Бинарное уточнение зонда обязано найти ПОСЛЕДНИЙ выход из
    // покрытия, а не первый — иначе за дырой теряется рельеф
    const { source } = await makeOfflineSource({
      regionBbox: [41.5, 42.5, 44, 44],
      hiCellDeg: 1 / 512,
      hiQuant: 2,
      globalCellDeg: 1 / 512,
      globalQuant: 4,
      terrariumZooms: new Set([10]),
      // Дыра на пути северного луча: z10-тайл, соседний с тайлом наблюдателя
      terrariumHole: [
        10,
        Math.floor(((ORIGIN.lon + 180) / 360) * 1024),
        Math.floor(((90 - ORIGIN.lat) / 180) * 1024) - 1,
      ],
    });
    await fullPrefetch(source);

    const sampleFn = (pos: LatLon, distM: number, hint?: { lod: number; zoom: number }) =>
      source.sample(pos, distM, hint);
    const marchDeps = { lodForDistance: (d: number) => source.lodForDistance(d) };

    const baseline = computeLayeredHorizon(ORIGIN, 4208, sampleFn, { marchDeps });
    const capped = computeLayeredHorizon(ORIGIN, 4208, sampleFn, {
      marchDeps,
      coverageProbe: (pos: LatLon) => source.mayHaveOfflineData(pos),
    });

    assertBitwiseEqual(baseline.layers, capped.layers);
    assertBitwiseEqual(baseline.distanceToHorizonM, capped.distanceToHorizonM);
    assertBitwiseEqual(baseline.crests, capped.crests);
    assertBitwiseEqual(baseline.fronts, capped.fronts);
  });
});
