/**
 * Замер стоимости секторной границы обрыва в computeLayeredHorizon:
 * строка наклонов (sectorBound − drop − hO)/d сейчас пересчитывается
 * на КАЖДОМ луче, хотя зависит только от сектора (72 сектора на 3600
 * лучей = 50 лучей на сектор). Сравниваем полный расчёт с конечной
 * границей и без неё — разница и есть цена границы (заполнение строки
 * + сравнения в шаге).
 *
 * Запуск: npx tsx tools/perf/bench-sector.ts
 */

import type { LatLon } from "../../src/core/geo";
import {
  buildMarchTable,
  computeLayeredHorizon,
  type SampleFn,
} from "../../src/core/horizon";
import {
  lonLatToTileAndPixel,
  zoomForDistance,
} from "../../src/core/terrarium";

const ORIGIN: LatLon = { lat: 43.318, lon: 42.458 };
const TILE_PX = 256;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + (Math.imul(t ^ (t >>> 7), 61 | t)) ^ t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSampler(): SampleFn {
  const tiles = new Map<string, Float32Array>();
  const getTile = (z: number, tx: number, ty: number): Float32Array => {
    const key = `${z}/${tx}/${ty}`;
    let t = tiles.get(key);
    if (!t) {
      t = new Float32Array(TILE_PX * TILE_PX);
      const rand = rng(z * 1000003 + tx * 7919 + ty * 104729);
      for (let i = 0; i < t.length; i++) t[i] = -200 + 6000 * rand();
      tiles.set(key, t);
    }
    return t;
  };
  return (pos, distM, hint) => {
    const z = hint?.zoom ?? zoomForDistance(distM);
    const t = lonLatToTileAndPixel(pos, z);
    const tile = getTile(z, t.tx, t.ty);
    const gx = t.tx * TILE_PX + t.px;
    const gy = t.ty * TILE_PX + t.py;
    const gx0 = Math.floor(gx);
    const gy0 = Math.floor(gy);
    const fx = gx - gx0;
    const fy = gy - gy0;
    const lx0 = gx0 - t.tx * TILE_PX;
    const ly0 = gy0 - t.ty * TILE_PX;
    if (lx0 < TILE_PX - 1 && ly0 < TILE_PX - 1) {
      const row0 = ly0 * TILE_PX;
      const h00 = tile[row0 + lx0];
      const h10 = tile[row0 + lx0 + 1];
      const h01 = tile[row0 + TILE_PX + lx0];
      const h11 = tile[row0 + TILE_PX + lx0 + 1];
      const top = h00 + (h10 - h00) * fx;
      const bottom = h01 + (h11 - h01) * fx;
      return top + (bottom - top) * fy;
    }
    return tile[ly0 * TILE_PX + lx0];
  };
}

const sample = makeSampler();
const marchDeps = { lodForDistance: () => 0 };

// Реалистичная секторная граница: у горного наблюдателя H > hO почти везде
const SECTOR_COUNT = 72;
const sectorMax = new Float32Array(SECTOR_COUNT).fill(5200);

function bench(fn: () => void, iters: number): number {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

const withBound = bench(
  () => void computeLayeredHorizon(ORIGIN, 4127, sample, { marchDeps, sectorMax }),
  5,
);
const noBound = bench(
  () => void computeLayeredHorizon(ORIGIN, 4127, sample, { marchDeps }),
  5,
);

console.log(`полный расчёт С границей:    ${withBound.toFixed(1)} мс`);
console.log(`полный расчёт БЕЗ границы:   ${noBound.toFixed(1)} мс`);
console.log(`цена секторной границы:      ${(withBound - noBound).toFixed(1)} мс`);

// Отдельно: стоимость заполнения строки наклонов (537 делений) —
// столько раз она пересчитывается на каждый луч сектора
const march = buildMarchTable(135, 200_000);
const steps = march.count;
const boundSlopes = new Float64Array(steps);
const fillMs = bench(() => {
  for (let s = 0; s < steps; s++) {
    boundSlopes[s] = (5200 - march.drop[s] - 4128.7) / march.d[s];
  }
}, 20000);
console.log(`заполнение строки (${steps} шагов): ${(fillMs * 1000).toFixed(1)} мкс`);
console.log(
  `  × 3600 лучей = ${(fillMs * 3600).toFixed(1)} мс на расчёт; ` +
  `после кеша по сектору: ${(fillMs * SECTOR_COUNT).toFixed(2)} мс`,
);
