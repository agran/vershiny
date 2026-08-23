/**
 * Бенчмарк быстрого пути DemSampler.sampleLod (самодостаточный, без импорта
 * DemSampler — он тянет dem-config.ts с import.meta.env, недоступным в Node).
 *
 * Суть находки: быстрый путь sampleLod делает
 *   this.tiles.get(`${lodIndex}/${tx}/${ty}`)
 * на КАЖДУЮ выборку — строка-ключ + Map.get — минуя кеш последнего тайла
 * (lastLod/lastTx/lastTy/lastTile), которым пользуется cell() и который есть
 * у TerrariumSampler.tileAt. Луч идёт внутри одного тайла десятки шагов,
 * поэтому кеш последнего тайла почти всегда попадает.
 *
 * Гипотеза: добавить тот же кеш последнего тайла в быстрый путь. Значения
 * побитово те же (тот же объект тайла, тот же квант), но строка и Map.get
 * уходят из горячего цикла.
 *
 * Запуск: npx tsx tools/perf/bench-dem-fastpath.ts
 */

import { makeRayMarcher, type LatLon } from "../../src/core/geo";
import { buildMarchTable } from "../../src/core/horizon";

const TILE_SIZE = 256;
const ORIGIN: LatLon = { lat: 43.318, lon: 42.458 };
const march = buildMarchTable(135, 200_000);
const rayCount = 3600;
const stepRad = (2 * Math.PI) / rayCount;

// Индекс как в dem-fastpath.test.ts: LOD 0 = 90 м (1/512°), bbox elbrus
const bbox: [number, number, number, number] = [41, 42, 44.5, 44.3];
const cellDeg = 1 / 512;
const quantM = 2;
const gridWidth = 3.5 * 512;
const gridHeight = 2.3 * 512;

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

// Тайлы, покрывающие bbox (ключ '0/tx/ty')
const tiles = new Map<string, Int16Array | null>();
{
  const tilesX = Math.ceil((bbox[2] - bbox[0]) / (cellDeg * TILE_SIZE));
  const tilesY = Math.ceil((bbox[3] - bbox[1]) / (cellDeg * TILE_SIZE));
  for (let tx = 0; tx < tilesX; tx++) {
    for (let ty = 0; ty < tilesY; ty++) {
      const t = new Int16Array(TILE_SIZE * TILE_SIZE);
      const rand = rng(tx * 7919 + ty * 104729);
      for (let i = 0; i < t.length; i++) t[i] = Math.floor(rand() * 6000) - 200;
      tiles.set(`0/${tx}/${ty}`, t);
    }
  }
}

// --- Текущий быстрый путь: Map.get(`${lod}/${tx}/${ty}`) на каждую выборку ---
function sampleCurrent(pos: LatLon): number {
  const gx = (pos.lon - bbox[0]) / cellDeg;
  const gy = (bbox[3] - pos.lat) / cellDeg;
  if (gx < 0 || gy < 0 || gx >= gridWidth - 1 || gy >= gridHeight - 1) return NaN;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const lx0 = x0 % TILE_SIZE;
  const ly0 = y0 % TILE_SIZE;
  if (lx0 < TILE_SIZE - 1 && ly0 < TILE_SIZE - 1) {
    const tx = (x0 - lx0) / TILE_SIZE;
    const ty = (y0 - ly0) / TILE_SIZE;
    const tile = tiles.get(`0/${tx}/${ty}`) ?? null;
    if (tile === null) return NaN;
    const row0 = ly0 * TILE_SIZE;
    const h00 = tile[row0 + lx0] * quantM;
    const h10 = tile[row0 + lx0 + 1] * quantM;
    const h01 = tile[row0 + TILE_SIZE + lx0] * quantM;
    const h11 = tile[row0 + TILE_SIZE + lx0 + 1] * quantM;
    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return top + (bottom - top) * fy;
  }
  return NaN; // граница тайла — редкий путь, не мерим
}

// --- Гипотеза: кеш последнего тайла (как в cell()) ---
let lastTx = -1;
let lastTy = -1;
let lastTile: Int16Array | null = null;
function sampleCached(pos: LatLon): number {
  const gx = (pos.lon - bbox[0]) / cellDeg;
  const gy = (bbox[3] - pos.lat) / cellDeg;
  if (gx < 0 || gy < 0 || gx >= gridWidth - 1 || gy >= gridHeight - 1) return NaN;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const lx0 = x0 % TILE_SIZE;
  const ly0 = y0 % TILE_SIZE;
  if (lx0 < TILE_SIZE - 1 && ly0 < TILE_SIZE - 1) {
    const tx = (x0 - lx0) / TILE_SIZE;
    const ty = (y0 - ly0) / TILE_SIZE;
    let tile: Int16Array | null;
    if (tx === lastTx && ty === lastTy) {
      tile = lastTile;
    } else {
      tile = tiles.get(`0/${tx}/${ty}`) ?? null;
      lastTx = tx;
      lastTy = ty;
      lastTile = tile;
    }
    if (tile === null) return NaN;
    const row0 = ly0 * TILE_SIZE;
    const h00 = tile[row0 + lx0] * quantM;
    const h10 = tile[row0 + lx0 + 1] * quantM;
    const h01 = tile[row0 + TILE_SIZE + lx0] * quantM;
    const h11 = tile[row0 + TILE_SIZE + lx0 + 1] * quantM;
    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return top + (bottom - top) * fy;
  }
  return NaN;
}

// --- Побитовая сверка ---
let mismatch = 0;
let checked = 0;
for (let i = 0; i < rayCount; i += 3) {
  const az = i * stepRad;
  const pa = makeRayMarcher(ORIGIN, az, march);
  for (let st = 0; st < march.count; st++) {
    const pos = pa(st);
    const a = sampleCurrent(pos);
    const b = sampleCached(pos);
    checked++;
    // NaN === NaN по значению (оба «нет данных») — считаем совпадением
    if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) mismatch++;
  }
}
console.log(`[побитово] sampleCurrent ≡ sampleCached: ${checked} точек, расхождений ${mismatch}`);

// --- Замеры на полном проходе ---
function bench(fn: (p: (s: number) => LatLon) => void, iters: number): number {
  const p0 = makeRayMarcher(ORIGIN, 0, march);
  fn(p0);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    for (let r = 0; r < rayCount; r++) {
      const p = makeRayMarcher(ORIGIN, r * stepRad, march);
      fn(p);
    }
  }
  return (performance.now() - t0) / iters;
}
const N = 3;
const tCur = bench((p) => { for (let st = 0; st < march.count; st++) sampleCurrent(p(st)); }, N);
const tCached = bench((p) => { for (let st = 0; st < march.count; st++) sampleCached(p(st)); }, N);
console.log(`\n[замеры] ${N}× полный проход (${((rayCount * march.count * N) / 1e6).toFixed(1)} млн выборок):`);
console.log(`    текущий (Map.get на выборку):  ${tCur.toFixed(1)} мс`);
console.log(`    с кешем последнего тайла:      ${tCached.toFixed(1)} мс`);
console.log(`    экономия: ${((1 - tCached / tCur) * 100).toFixed(1)}%`);
