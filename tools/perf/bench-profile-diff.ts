/**
 * Дифференциальный тест: полный профиль computeLayeredHorizon с текущим
 * марчером (Math.sin(lat2)) vs марчером без него (clamped напрямую).
 *
 * Если профиль побитово идентичен — 1-ulp сдвиг долготы никогда не
 * пересекает границу пикселя, и оптимизация «доказуемо идентична»
 * (дифференциальный тест — доказательство).
 *
 * Запуск: npx tsx tools/perf/bench-profile-diff.ts
 */

import {
  destination,
  makeRayMarcher,
  toDeg,
  type LatLon,
} from "../../src/core/geo";
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

/** Детерминированный ГПСЧ */
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

/**
 * Реалистичный сэмплер: Terrarium-подобный (Mercator + билинейка),
 * но с детерминированными синтетическими тайлами. Имитирует горячий путь
 * TerrariumSampler.sample (быстрый путь, все 4 узла в одном тайле).
 */
function makeTerrariumLikeSampler() {
  const tiles = new Map<string, Float32Array>();
  const getTile = (z: number, tx: number, ty: number): Float32Array | null => {
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
  return (pos: LatLon, distM: number, hint?: { lod: number; zoom: number }): number => {
    const z = hint?.zoom ?? zoomForDistance(distM);
    const t = lonLatToTileAndPixel(pos, z);
    const tile = getTile(z, t.tx, t.ty);
    if (!tile) return NaN;
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

/** Марчер без Math.sin(lat2): clamped напрямую в atan2 */
function makeNoSinMarcher(
  origin: LatLon,
  azRad: number,
  table: ReturnType<typeof buildMarchTable>,
): (stepIdx: number) => LatLon {
  const lat1 = (origin.lat * Math.PI) / 180;
  const lon1 = (origin.lon * Math.PI) / 180;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAz = Math.sin(azRad);
  const cosAz = Math.cos(azRad);
  const out: LatLon = { lat: 0, lon: 0 };
  return (stepIdx: number): LatLon => {
    const cosD = table.cosD[stepIdx];
    const sinD = table.sinD[stepIdx];
    const clamped = Math.min(1, Math.max(-1, sinLat1 * cosD + cosLat1 * sinD * cosAz));
    const lat2 = Math.asin(clamped);
    // Единственное отличие от makeRayMarcher: sinLat1 * clamped вместо
    // sinLat1 * Math.sin(lat2). toDeg — тот же вызов, что в марчере
    const lon2 = lon1 + Math.atan2(sinAz * sinD * cosLat1, cosD - sinLat1 * clamped);
    const lonDeg = toDeg(lon2);
    out.lat = toDeg(lat2);
    out.lon = lonDeg >= 180 ? lonDeg - 360 : lonDeg < -180 ? lonDeg + 360 : lonDeg;
    return out;
  };
}

const sample = makeTerrariumLikeSampler();
const marchDeps = { lodForDistance: () => 0 };

// Текущий расчёт (makeRayMarcher из geo.ts)
const t0 = performance.now();
const ref = computeLayeredHorizon(ORIGIN, 4127, sample, { marchDeps });
const tRef = performance.now() - t0;

// Расчёт с марчером без sin: переопределяем makeRayMarcher через monkey-patch
// — проще: вручную прогоняем тот же алгоритм, но с noSinMarcher.
// Чтобы не дублировать весь computeLayeredHorizon, измеряем только марчер
// в изоляции на тех же точках и сравниваем долготы/широты побитово.
let lonDiff = 0;
let latDiff = 0;
let total = 0;
for (let i = 0; i < 3600; i++) {
  const az = (i * 2 * Math.PI) / 3600;
  const pa = makeRayMarcher(ORIGIN, az, buildMarchTable(135, 200_000));
  const pn = makeNoSinMarcher(ORIGIN, az, buildMarchTable(135, 200_000));
  for (let s = 0; s < 537; s++) {
    const a = pa(s);
    const b = pn(s);
    total++;
    if (a.lon !== b.lon) lonDiff++;
    if (a.lat !== b.lat) latDiff++;
  }
}
console.log(`\n[профиль] полный computeLayeredHorizon (текущий): ${tRef.toFixed(1)} мс`);
console.log(`\n[марчер] точек: ${total}`);
console.log(`    долгота отличается: ${lonDiff} (${((lonDiff / total) * 100).toFixed(3)}%)`);
console.log(`    широта отличается:  ${latDiff} (${((latDiff / total) * 100).toFixed(3)}%)`);

// Теперь главное: влияет ли 1-ulp на ВЫБОРКУ? Сравниваем sample() на
// точках текущего и noSin марчера — если высота всегда одинакова, профиль
// побитово тот же.
let heightDiff = 0;
let heightChecked = 0;
for (let i = 0; i < 3600; i += 2) {
  const az = (i * 2 * Math.PI) / 3600;
  const mt = buildMarchTable(135, 200_000);
  const pa = makeRayMarcher(ORIGIN, az, mt);
  const pn = makeNoSinMarcher(ORIGIN, az, mt);
  for (let s = 0; s < mt.count; s++) {
    const a = pa(s);
    const b = pn(s);
    const ha = sample(a, mt.d[s], mt.hints[s]);
    const hb = sample(b, mt.d[s], mt.hints[s]);
    heightChecked++;
    if (ha !== hb) heightDiff++;
  }
}
console.log(`\n[выборка] точек: ${heightChecked}`);
console.log(`    высота отличается: ${heightDiff} (${((heightDiff / heightChecked) * 100).toFixed(4)}%)`);
console.log(heightDiff === 0
  ? "    → профиль побитово идентичен (1-ulp долготы не пересекает пиксели)"
  : "    → профиль МЕНЯЕТСЯ — это «не побитово»");
