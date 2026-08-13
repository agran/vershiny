/**
 * Формат глобальной пирамиды (tools/glo90-to-tiles): gzip + дельта по строкам
 * + квантование высоты, разреженное покрытие с фолбэком на грубый LOD.
 */

import { describe, it, expect } from 'vitest';
import { DemSampler, TILE_SIZE, type DemIndex } from '../src/core/dem';

/** gzip средствами платформы — как и распаковка в dem.ts */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new CompressionStream('gzip'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Кодирование тайла так же, как это делает glo90_to_tiles.encode_tile */
function encodeTile(heights: Int16Array, quantM: number): Promise<Uint8Array> {
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

/** Битсет покрытия (ty·tilesX + tx) → base64, как в index.json */
function coverage(tiles: Array<[number, number]>, tilesX: number, tilesY: number): string {
  const bits = new Uint8Array(Math.ceil((tilesX * tilesY) / 8));
  for (const [tx, ty] of tiles) {
    const bit = ty * tilesX + tx;
    bits[bit >> 3] |= 1 << (bit & 7);
  }
  return toBase64(bits);
}

const INDEX: DemIndex = {
  bbox: [-180, -90, 180, 90],
  encoding: 'gzip',
  filter: 'delta-x',
  tileExt: '.bin.gz',
  lods: [
    {
      cellDeg: 1 / 512,
      quantM: 2,
      gridWidth: 360 * 512,
      gridHeight: 180 * 512,
      tilesX: 720,
      tilesY: 360,
      // 444/92 — Приэльбрусье; 716/38 и 2/38 — по обе стороны антимеридиана
      coverage: coverage(
        [
          [444, 92],
          [716, 38],
          [2, 38],
        ],
        720,
        360,
      ),
    },
    {
      cellDeg: 1 / 64,
      quantM: 8,
      gridWidth: 360 * 64,
      gridHeight: 180 * 64,
      tilesX: 90,
      tilesY: 45,
      coverage: coverage([[55, 11]], 90, 45),
    },
  ],
};

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

function samplerWith(
  tiles: Record<string, Uint8Array>,
  requested: string[] = [],
): DemSampler {
  const fetchFn = (async (url: string) => {
    const path = String(url);
    requested.push(path);
    if (path.endsWith('index.json')) {
      return new Response(JSON.stringify(INDEX), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const key = path.replace('tiles/global/', '');
    const body = tiles[key];
    if (!body) return new Response('', { status: 404 });
    return new Response(body as unknown as BodyInit);
  }) as unknown as typeof fetch;
  return new DemSampler({ baseUrl: 'tiles/global', fetchFn });
}

describe('DemSampler: формат глобальной пирамиды', () => {
  it('распаковывает gzip + дельту и возвращает высоты в метрах', async () => {
    const sampler = samplerWith({ '0/444/92.bin.gz': await encodeTile(slopeTile(), 2) });
    await sampler.loadIndex();
    await sampler.loadTile(0, 444, 92);

    // Левый верхний угол тайла 0/444/92 — это 42° в.д., 44° с.ш.
    const h = sampler.sample({ lat: 44, lon: 42 }, 0);
    expect(h).toBeCloseTo(1000, 0);

    // Шаг по x — 4 м на ячейку, по y — 8 м (квант 2 м погрешности не вносит)
    const cell = 1 / 512;
    expect(sampler.sample({ lat: 44, lon: 42 + cell * 10 }, 0)).toBeCloseTo(1040, 0);
    expect(sampler.sample({ lat: 44 - cell * 10, lon: 42 }, 0)).toBeCloseTo(1080, 0);
  });

  it('не запрашивает тайлы, которых нет в карте покрытия', async () => {
    const requested: string[] = [];
    const sampler = samplerWith({}, requested);
    await sampler.loadIndex();
    requested.length = 0;

    expect(await sampler.loadTile(0, 100, 100)).toBeNull();
    expect(requested).toHaveLength(0);
    expect(sampler.hasTile(0, 444, 92)).toBe(true);
    expect(sampler.hasTile(0, 100, 100)).toBe(false);
  });

  it('падает на грубый LOD, если детального тайла нет', async () => {
    const coarse = new Int16Array(TILE_SIZE * TILE_SIZE).fill(2400);
    const sampler = samplerWith({ '1/55/11.bin.gz': await encodeTile(coarse, 8) });
    await sampler.loadIndex();
    await sampler.loadTile(1, 55, 11);

    // Точка попадает в дыру LOD 0, но покрыта LOD 1
    expect(sampler.sample({ lat: 43.5, lon: 42.5 }, 0)).toBeCloseTo(2400, 0);
  });

  it('выбирает LOD по дальности луча', async () => {
    const sampler = samplerWith({});
    await sampler.loadIndex();

    expect(sampler.lodForDistance(1_000)).toBe(0); // ближняя зона — детальный
    expect(sampler.lodForDistance(50_000)).toBe(0); // 217 м ещё уместны
    expect(sampler.lodForDistance(100_000)).toBe(1); // дальше хватает 1.7 км
    expect(sampler.lodForDistance(200_000)).toBe(1);
    expect(sampler.finestResM()).toBeCloseTo(217, 0);
  });
});

describe('DemSampler: тайлы для офлайн-загрузки', () => {
  it('собирает существующие тайлы bbox по всем LOD', async () => {
    const sampler = samplerWith({});
    await sampler.loadIndex();

    // bbox вокруг Приэльбрусья: покрыты тайлы 0/444/92 и 1/55/11
    const keys = sampler.tileKeysInBBox([42, 42.5, 43, 44]);
    expect(keys).toContain('0/444/92');
    expect(keys).toContain('1/55/11');
    // Пустые тайлы в bbox не запрашиваются — иначе счёт размера был бы враньём
    expect(keys).toHaveLength(2);
  });

  it('не теряет тайлы у bbox через антимеридиан', async () => {
    const sampler = samplerWith({});
    await sampler.loadIndex();

    // Врангель: 177.5°в.д. … −177.5°з.д. Наивное сравнение min<max даёт
    // пустой диапазон, и регион молча скачивался без единого тайла
    const keys = sampler.tileKeysInBBox([177.5, 70.5, -177.5, 72]);
    expect(keys).toContain('0/716/38'); // восточнее антимеридиана
    expect(keys).toContain('0/2/38'); // западнее
  });

  it('считает вес bbox по среднему весу тайла из индекса', async () => {
    const sampler = samplerWith({});
    const index = await sampler.loadIndex();
    index.lods[0].avgTileBytes = 40_000;
    index.lods[1].avgTileBytes = 18_000;

    expect(sampler.bboxDownloadBytes([42, 42.5, 43, 44])).toBe(58_000);
  });
});
