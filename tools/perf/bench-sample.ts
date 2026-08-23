/**
 * Разбор стоимости sample() в горячем цикле: Mercator-проекция vs билинейка,
 * и аллокация объекта в lonLatToTileAndPixel.
 *
 * Запуск: npx tsx tools/perf/bench-sample.ts
 */

import { toRad, normalizeLon, type LatLon } from "../../src/core/geo";
import { buildMarchTable } from "../../src/core/horizon";
import {
  lonLatToTileAndPixel,
  zoomForDistance,
} from "../../src/core/terrarium";

const ORIGIN: LatLon = { lat: 43.318, lon: 42.458 };
const march = buildMarchTable(135, 200_000);
const rayCount = 3600;
const stepRad = (2 * Math.PI) / rayCount;
const TILE_PX = 256;

// Детерминированные тайлы (как в TerrariumSampler)
const tiles = new Map<string, Float32Array>();
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
function getTile(z: number, tx: number, ty: number): Float32Array {
  const key = `${z}/${tx}/${ty}`;
  let t = tiles.get(key);
  if (!t) {
    t = new Float32Array(TILE_PX * TILE_PX);
    const rand = rng(z * 1000003 + tx * 7919 + ty * 104729);
    for (let i = 0; i < t.length; i++) t[i] = -200 + 6000 * rand();
    tiles.set(key, t);
  }
  return t;
}

// Марчер (реальный)
import { makeRayMarcher } from "../../src/core/geo";

function bench(fn: () => void, iters: number): number {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

// Собираем все точки лучей один раз (чтобы мерить только sample, не марчер)
const N = 2;

// [A] Полный sample: lonLatToTileAndPixel (с аллокацией) + билинейка
function sampleFull(pos: LatLon, distM: number, hint?: { lod: number; zoom: number }): number {
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
}

// [B] Только Mercator (lonLatToTileAndPixel), без билинейки
function mercatorOnly(pos: LatLon, distM: number, hint?: { lod: number; zoom: number }): number {
  const z = hint?.zoom ?? zoomForDistance(distM);
  const t = lonLatToTileAndPixel(pos, z);
  return t.tx + t.ty + t.px + t.py;
}

// [C] Mercator ИНЛАЙН (без аллокации объекта) + билинейка — та же формула
const MAX_LATITUDE = 85.05112878;
function sampleInline(pos: LatLon, distM: number, hint?: { lod: number; zoom: number }): number {
  const z = hint?.zoom ?? zoomForDistance(distM);
  const n = 2 ** z;
  const lat = Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, pos.lat));
  // ТОЧНО как в lonLatToTileAndPixel: (lat * Math.PI) / 180, не toRad
  const latRad = (lat * Math.PI) / 180;
  const wx = ((normalizeLon(pos.lon) + 180) / 360) * n;
  const wy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tx = ((Math.floor(wx) % n) + n) % n;
  const ty = Math.min(n - 1, Math.max(0, Math.floor(wy)));
  const px = (wx * TILE_PX) % TILE_PX;
  const py = (wy * TILE_PX) % TILE_PX;
  const tile = getTile(z, tx, ty);
  const gx = tx * TILE_PX + px;
  const gy = ty * TILE_PX + py;
  const gx0 = Math.floor(gx);
  const gy0 = Math.floor(gy);
  const fx = gx - gx0;
  const fy = gy - gy0;
  const lx0 = gx0 - tx * TILE_PX;
  const ly0 = gy0 - ty * TILE_PX;
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
}

// Проверка побитовости: sampleFull ≡ sampleInline
let mismatch = 0;
let checked = 0;
for (let i = 0; i < rayCount; i += 5) {
  const az = i * stepRad;
  const pa = makeRayMarcher(ORIGIN, az, march);
  for (let s = 0; s < march.count; s++) {
    const pos = pa(s);
    const a = sampleFull(pos, march.d[s], march.hints[s]);
    const b = sampleInline(pos, march.d[s], march.hints[s]);
    checked++;
    if (a !== b) mismatch++;
  }
}
console.log(`[побитово] sampleFull ≡ sampleInline: ${checked} точек, расхождений ${mismatch}`);

// Замеры на полном проходе (все лучи × шаги)
const tFull = bench(() => {
  for (let i = 0; i < rayCount; i++) {
    const pa = makeRayMarcher(ORIGIN, i * stepRad, march);
    for (let s = 0; s < march.count; s++) sampleFull(pa(s), march.d[s], march.hints[s]);
  }
}, N);
const tMerc = bench(() => {
  for (let i = 0; i < rayCount; i++) {
    const pa = makeRayMarcher(ORIGIN, i * stepRad, march);
    for (let s = 0; s < march.count; s++) mercatorOnly(pa(s), march.d[s], march.hints[s]);
  }
}, N);
const tInline = bench(() => {
  for (let i = 0; i < rayCount; i++) {
    const pa = makeRayMarcher(ORIGIN, i * stepRad, march);
    for (let s = 0; s < march.count; s++) sampleInline(pa(s), march.d[s], march.hints[s]);
  }
}, N);

const totalPts = rayCount * march.count;
console.log(`\n[замеры] ${N}× полный проход (${(totalPts * N / 1e6).toFixed(1)} млн выборок):`);
console.log(`    sampleFull (Mercator+аллокация+билинейка): ${tFull.toFixed(1)} мс`);
console.log(`    mercatorOnly (только проекция):            ${tMerc.toFixed(1)} мс`);
console.log(`    sampleInline (Mercator инлайн+билинейка):  ${tInline.toFixed(1)} мс`);
console.log(`    → билинейка ≈ ${(tFull - tMerc).toFixed(1)} мс`);
console.log(`    → экономия от инлайна (убрать аллокацию):  ${((1 - tInline / tFull) * 100).toFixed(1)}%`);
