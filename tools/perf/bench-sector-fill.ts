/**
 * Изолированный замер экономии кеша строки наклонов секторной границы:
 * заполнение строки (537 делений) × 3600 лучей (ДО) vs × 72 сектора (ПОСЛЕ).
 *
 * Запуск: npx tsx tools/perf/bench-sector-fill.ts
 */

import { buildMarchTable } from "../../src/core/horizon";

const march = buildMarchTable(135, 200_000);
const steps = march.count;
const boundSlopes = new Float64Array(steps);

function bench(fn: () => void, iters: number): number {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

const fillMs = bench(() => {
  for (let s = 0; s < steps; s++) {
    boundSlopes[s] = (5200 - march.drop[s] - 4128.7) / march.d[s];
  }
}, 20000);

console.log(`заполнение строки (${steps} шагов): ${(fillMs * 1000).toFixed(1)} мкс`);
console.log(`ДО   (3600 лучей): ${(fillMs * 3600).toFixed(1)} мс на расчёт`);
console.log(`ПОСЛЕ (72 сектора): ${(fillMs * 72).toFixed(2)} мс на расчёт`);
console.log(
  `экономия: ~${(fillMs * (3600 - 72)).toFixed(1)} мс на полный марш (~${((fillMs * (3600 - 72)) / 133 * 100).toFixed(1)} % от 133 мс марша)`,
);
