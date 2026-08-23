/**
 * Бенчмарк кадрового пути: buildRidgeSegments + decimateSegments (RDP)
 * на реалистичных профилях гребней. Плюс проверка гипотезы «проход только
 * по видимым индексам» (аудит №2.4) — побитово ли и сколько экономит.
 *
 * Запуск: npx tsx tools/perf/bench-ridge.ts
 */

import {
  buildRidgeSegments,
  decimateSegments,
} from "../../src/ui/panorama";
import { wrapAngle } from "../../src/core/geo";

const RAY_COUNT = 3600;
const STEP_RAD = (2 * Math.PI) / RAY_COUNT;
const WIDTH = 1280;
const HEIGHT = 720;
const EPS = 5e-4;

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
 * Реалистичный профиль гребня: базовый склон + шум + несколько пиков.
 * Часть лучей −Infinity (нет данных) — как в реальном кадре.
 */
function makeProfile(seed: number, baseElev: number): Float32Array {
  const prof = new Float32Array(RAY_COUNT).fill(-Infinity);
  const rand = rng(seed);
  let v = baseElev;
  for (let i = 0; i < RAY_COUNT; i++) {
    // ~15% лучей без данных
    if (rand() < 0.15) continue;
    v += (rand() - 0.5) * 0.002;
    // Периодические пики (гребни)
    const bump = Math.exp(-Math.pow(((i % 300) - 150) / 20, 2)) * 0.05;
    prof[i] = v + bump;
  }
  return prof;
}

// 8 профилей гребней (как CREST_COUNT) с нарастающей базовой высотой
const profiles: Float32Array[] = [];
for (let k = 0; k < 8; k++) profiles.push(makeProfile(1000 + k, 0.02 + k * 0.01));

const centerAz = 1.0;
const tilt = 0.0;
const fovRad = 1.2;
const fovVRad = 0.7;
const azToX = (az: number): number =>
  (wrapAngle(az - centerAz) / fovRad) * WIDTH + WIDTH / 2;
const elevToY = (elev: number): number =>
  HEIGHT * 0.62 - ((elev - tilt) / fovVRad) * HEIGHT;

function bench(fn: () => void, iters: number): number {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

// --- Текущий путь: buildRidgeSegments (все лучи) + decimateSegments ---
const runningMax = new Float32Array(RAY_COUNT).fill(-Infinity);
function currentFrame(): number {
  let pts = 0;
  for (const prof of profiles) {
    const segments = buildRidgeSegments(
      prof, runningMax, EPS, STEP_RAD, azToX, elevToY, WIDTH, HEIGHT, 20,
    );
    const simplified = decimateSegments(segments);
    for (const s of simplified) pts += s.length;
    for (let i = 0; i < RAY_COUNT; i++) if (prof[i] > runningMax[i]) runningMax[i] = prof[i];
  }
  return pts;
}

// --- Гипотеза: предвычислить «видимые индексы» (выше runningMax), в кадре
//     ходить только по ним. runningMax-маска не зависит от view ---
// Предвычисление (раз на панораму): для каждого профиля — список индексов,
// где prof[i] > runningMax_before[i] + EPS
function precomputeVisibleIndices(): number[][] {
  const rm = new Float32Array(RAY_COUNT).fill(-Infinity);
  const lists: number[][] = [];
  for (const prof of profiles) {
    const idx: number[] = [];
    for (let i = 0; i < RAY_COUNT; i++) {
      if (prof[i] !== -Infinity && prof[i] > rm[i] + EPS) idx.push(i);
    }
    lists.push(idx);
    for (let i = 0; i < RAY_COUNT; i++) if (prof[i] > rm[i]) rm[i] = prof[i];
  }
  return lists;
}

const visibleLists = precomputeVisibleIndices();
const totalVisible = visibleLists.reduce((s, l) => s + l.length, 0);
console.log(`видимых индексов всего: ${totalVisible} из ${RAY_COUNT * profiles.length} (${((totalVisible / (RAY_COUNT * profiles.length)) * 100).toFixed(1)}%)`);

// Кадр по видимым индексам: та же логика buildRidgeSegments, но только по списку
function frameByIndices(): number {
  let pts = 0;
  const maxGap = WIDTH * 0.25;
  const maxStepRad = 15 * STEP_RAD;
  for (let k = 0; k < profiles.length; k++) {
    const prof = profiles[k];
    const idx = visibleLists[k];
    const segments: { x: number; y: number }[][] = [];
    let current: { x: number; y: number }[] = [];
    let prevX = NaN;
    let prevV = NaN;
    let prevI = -Infinity;
    const flush = (): void => {
      if (current.length > 1) segments.push(current);
      current = [];
      prevX = NaN;
      prevV = NaN;
    };
    for (const i of idx) {
      // Между видимыми индексами были невидимые (flush в оригинале)
      if (i > prevI + 1) { prevX = NaN; prevV = NaN; }
      const v = prof[i];
      const x = azToX(i * STEP_RAD);
      if (x < -20 || x > WIDTH + 20) { flush(); prevI = i; continue; }
      const y = elevToY(v);
      if (y < -HEIGHT || y > HEIGHT * 2) { flush(); prevI = i; continue; }
      if (!Number.isNaN(prevX) && Math.abs(x - prevX) > maxGap) flush();
      if (!Number.isNaN(prevV) && Math.abs(v - prevV) > maxStepRad) flush();
      current.push({ x, y });
      prevX = x;
      prevV = v;
      prevI = i;
    }
    flush();
    const simplified = decimateSegments(segments);
    for (const s of simplified) pts += s.length;
  }
  return pts;
}

// --- Побитовая сверка: текущий путь vs путь по индексам ---
// Собираем сегменты (до RDP) обоими путями и сравниваем
function collectSegmentsCurrent(): { x: number; y: number }[][] {
  const rm = new Float32Array(RAY_COUNT).fill(-Infinity);
  const all: { x: number; y: number }[][] = [];
  for (const prof of profiles) {
    const segs = buildRidgeSegments(prof, rm, EPS, STEP_RAD, azToX, elevToY, WIDTH, HEIGHT, 20);
    all.push(...segs);
    for (let i = 0; i < RAY_COUNT; i++) if (prof[i] > rm[i]) rm[i] = prof[i];
  }
  return all;
}
function collectSegmentsByIndices(): { x: number; y: number }[][] {
  const all: { x: number; y: number }[][] = [];
  const maxGap = WIDTH * 0.25;
  const maxStepRad = 15 * STEP_RAD;
  for (let k = 0; k < profiles.length; k++) {
    const prof = profiles[k];
    const idx = visibleLists[k];
    const segments: { x: number; y: number }[][] = [];
    let current: { x: number; y: number }[] = [];
    let prevX = NaN;
    let prevV = NaN;
    let prevI = -Infinity;
    const flush = (): void => {
      if (current.length > 1) segments.push(current);
      current = [];
      prevX = NaN;
      prevV = NaN;
    };
    for (const i of idx) {
      if (i > prevI + 1) { prevX = NaN; prevV = NaN; }
      const v = prof[i];
      const x = azToX(i * STEP_RAD);
      if (x < -20 || x > WIDTH + 20) { flush(); prevI = i; continue; }
      const y = elevToY(v);
      if (y < -HEIGHT || y > HEIGHT * 2) { flush(); prevI = i; continue; }
      if (!Number.isNaN(prevX) && Math.abs(x - prevX) > maxGap) flush();
      if (!Number.isNaN(prevV) && Math.abs(v - prevV) > maxStepRad) flush();
      current.push({ x, y });
      prevX = x;
      prevV = v;
      prevI = i;
    }
    flush();
    all.push(...segments);
  }
  return all;
}

const segA = collectSegmentsCurrent();
const segB = collectSegmentsByIndices();
let segMismatch = 0;
const minLen = Math.min(segA.length, segB.length);
for (let s = 0; s < minLen; s++) {
  if (segA[s].length !== segB[s].length) { segMismatch++; continue; }
  for (let p = 0; p < segA[s].length; p++) {
    if (segA[s][p].x !== segB[s][p].x || segA[s][p].y !== segB[s][p].y) { segMismatch++; break; }
  }
}
console.log(`\n[побитово] сегменты: текущий ${segA.length} vs по-индексам ${segB.length}, расхождений ${segMismatch}`);

// --- Замеры ---
const N = 30;
const tCur = bench(currentFrame, N);
const tIdx = bench(frameByIndices, N);
console.log(`\n[замеры] ${N} кадров (8 профилей × 3600 лучей):`);
console.log(`    текущий (все лучи):        ${tCur.toFixed(2)} мс/кадр`);
console.log(`    по видимым индексам:       ${tIdx.toFixed(2)} мс/кадр`);
console.log(`    экономия: ${((1 - tIdx / tCur) * 100).toFixed(1)}%`);
