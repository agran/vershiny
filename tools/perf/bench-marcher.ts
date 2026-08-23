/**
 * Бенчмарк марчера луча (makeRayMarcher) и гипотезы sin(asin(x)) === x.
 *
 * Запускается: npx tsx tools/perf/bench-marcher.ts
 *
 * Цель: измерить, можно ли убрать Math.sin(lat2) из марчера (lat2 = asin(...)),
 * сохранив побитовый паритет с destination(). Если sin(asin(x)) !== x на
 * реальных входах — гипотеза мёртвая, и это «не побитово».
 */

import {
  destination,
  makeRayMarcher,
  EARTH_RADIUS_M,
  type LatLon,
} from "../../src/core/geo";
import { buildMarchTable } from "../../src/core/horizon";

const ORIGIN: LatLon = { lat: 43.318, lon: 42.458 }; // Приют 11

function bench(fn: () => void, iters: number): number {
  // разгон
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return performance.now() - t0;
}

// Таблица марша как в полном расчёте (135 м → 200 км)
const march = buildMarchTable(135, 200_000);
const steps = march.count;
const rayCount = 3600;
const stepRad = (2 * Math.PI) / rayCount;

console.log(`шагов марша: ${steps}, лучей: ${rayCount}, всего точек: ${steps * rayCount}`);

// --- 1. Гипотеза sin(asin(x)) === x на реальных входах марчера ---
// Собираем распределение clamped-значений по всем лучам/шагам (подвыборка)
let mismatches = 0;
let checked = 0;
let maxAbsDiff = 0;
for (let i = 0; i < rayCount; i += 3) {
  const az = i * stepRad;
  const sinLat1 = Math.sin((ORIGIN.lat * Math.PI) / 180);
  const cosLat1 = Math.cos((ORIGIN.lat * Math.PI) / 180);
  const cosAz = Math.cos(az);
  for (let s = 0; s < steps; s++) {
    const cosD = march.cosD[s];
    const sinD = march.sinD[s];
    const clamped = Math.min(1, Math.max(-1, sinLat1 * cosD + cosLat1 * sinD * cosAz));
    const lat2 = Math.asin(clamped);
    const back = Math.sin(lat2);
    checked++;
    if (back !== clamped) {
      mismatches++;
      const d = Math.abs(back - clamped);
      if (d > maxAbsDiff) maxAbsDiff = d;
    }
  }
}
console.log(`\n[1] sin(asin(x)) === x:`);
console.log(`    проверено: ${checked}, расхождений: ${mismatches}`);
console.log(`    max |sin(asin(x)) − x| = ${maxAbsDiff.toExponential(3)}`);

// --- 2. Побитовый паритет марчера с destination (как в тесте-инварианте) ---
let parityMismatch = 0;
for (let i = 0; i < rayCount; i += 7) {
  const az = i * stepRad;
  const pointAt = makeRayMarcher(ORIGIN, az, march);
  for (let s = 0; s < steps; s += 11) {
    const a = pointAt(s);
    const b = destination(ORIGIN, az, march.d[s]);
    if (a.lat !== b.lat || a.lon !== b.lon) parityMismatch++;
  }
}
console.log(`\n[2] makeRayMarcher ≡ destination (побитово): расхождений ${parityMismatch}`);

// --- 3. Стоимость марчера: текущий vs без Math.sin(lat2) ---
// Текущий марчер (как в geo.ts)
function currentMarcher(origin: LatLon, azRad: number, table: typeof march) {
  const lat1 = (origin.lat * Math.PI) / 180;
  const lon1 = (origin.lon * Math.PI) / 180;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAz = Math.sin(azRad);
  const cosAz = Math.cos(azRad);
  const out = { lat: 0, lon: 0 };
  return (stepIdx: number) => {
    const cosD = table.cosD[stepIdx];
    const sinD = table.sinD[stepIdx];
    const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat1 * cosD + cosLat1 * sinD * cosAz)));
    const lon2 = lon1 + Math.atan2(sinAz * sinD * cosLat1, cosD - sinLat1 * Math.sin(lat2));
    const lonDeg = lon2 / ((Math.PI) / 180);
    out.lat = lat2 / ((Math.PI) / 180);
    out.lon = lonDeg >= 180 ? lonDeg - 360 : lonDeg < -180 ? lonDeg + 360 : lonDeg;
    return out;
  };
}
// Марчер без Math.sin(lat2): используем clamped напрямую (sin(asin(x)) → x)
function noSinMarcher(origin: LatLon, azRad: number, table: typeof march) {
  const lat1 = (origin.lat * Math.PI) / 180;
  const lon1 = (origin.lon * Math.PI) / 180;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAz = Math.sin(azRad);
  const cosAz = Math.cos(azRad);
  const out = { lat: 0, lon: 0 };
  return (stepIdx: number) => {
    const cosD = table.cosD[stepIdx];
    const sinD = table.sinD[stepIdx];
    const clamped = Math.min(1, Math.max(-1, sinLat1 * cosD + cosLat1 * sinD * cosAz));
    const lat2 = Math.asin(clamped);
    const lon2 = lon1 + Math.atan2(sinAz * sinD * cosLat1, cosD - sinLat1 * clamped);
    const lonDeg = lon2 / ((Math.PI) / 180);
    out.lat = lat2 / ((Math.PI) / 180);
    out.lon = lonDeg >= 180 ? lonDeg - 360 : lonDeg < -180 ? lonDeg + 360 : lonDeg;
    return out;
  };
}

// Полный проход по всем лучам/шагам (1.93 млн вызовов)
const N = 3;
const tCur = bench(() => {
  for (let i = 0; i < rayCount; i++) {
    const pa = currentMarcher(ORIGIN, i * stepRad, march);
    for (let s = 0; s < steps; s++) pa(s);
  }
}, N);
const tNoSin = bench(() => {
  for (let i = 0; i < rayCount; i++) {
    const pa = noSinMarcher(ORIGIN, i * stepRad, march);
    for (let s = 0; s < steps; s++) pa(s);
  }
}, N);
console.log(`\n[3] марчер, ${N}× полный проход (${(steps * rayCount * N / 1e6).toFixed(1)} млн вызовов):`);
console.log(`    текущий (с Math.sin(lat2)): ${(tCur / N).toFixed(1)} мс`);
console.log(`    без Math.sin(lat2):         ${(tNoSin / N).toFixed(1)} мс`);
console.log(`    экономия: ${((1 - tNoSin / tCur) * 100).toFixed(1)}%`);
