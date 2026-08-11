/**
 * Web Worker: ray-marching горизонта и видимость пиков (ARCHITECTURE.md).
 * Протокол сообщений:
 *   → { type: 'init', baseUrl }
 *   → { type: 'compute', origin, peaks }
 *   ← { type: 'result', horizon, stepRad, peaks, observerH, computeMs }
 *   ← { type: 'error', message }
 */

import { DemSampler } from '../core/dem';
import {
  computeHorizon,
  filterVisiblePeaks,
  nextRayStep,
  type VisiblePeak,
} from '../core/horizon';
import { destination, type LatLon } from '../core/geo';
import type { Peak } from '../core/peaks';

export interface InitMessage {
  type: 'init';
  baseUrl: string;
}

export interface ComputeMessage {
  type: 'compute';
  origin: LatLon;
  peaks: Peak[];
}

export interface ResultMessage {
  type: 'result';
  /** Углы горизонта по лучам, рад */
  horizon: Float32Array;
  /** Шаг между лучами, рад */
  stepRad: number;
  /** Видимые пики */
  peaks: VisiblePeak[];
  /** Высота наблюдателя из DEM */
  observerH: number;
  computeMs: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerInMessage = InitMessage | ComputeMessage;
export type WorkerOutMessage = ResultMessage | ErrorMessage;

let dem: DemSampler | null = null;

/** Максимальная дальность луча — синхронизирована с computeHorizon */
const MAX_DIST_M = 200_000;

async function compute(origin: LatLon, peaks: Peak[]): Promise<ResultMessage> {
  if (!dem) throw new Error('Worker не инициализирован (init)');
  const t0 = performance.now();

  const observerH = await dem.observerHeight(origin);

  // Предзагрузка тайлов веером лучей (шаг 5° — достаточно для покрытия:
  // ширина тайла 90 м × 256 ≈ 23 км, веер сходится плотно)
  const prefetchTasks: Promise<void>[] = [];
  for (let az = 0; az < 2 * Math.PI; az += (5 * Math.PI) / 180) {
    prefetchTasks.push(
      dem.prefetchAlongRay(origin, az, MAX_DIST_M, 8_000, destination),
    );
  }
  await Promise.all(prefetchTasks);

  const sample = (pos: LatLon, distM: number): number =>
    dem!.sample(pos, dem!.lodForDistance(distM));

  const { angles, stepRad } = computeHorizon(origin, observerH, sample);
  const visible = filterVisiblePeaks(origin, observerH, peaks, sample);

  return {
    type: 'result',
    horizon: angles,
    stepRad,
    peaks: visible,
    observerH,
    computeMs: performance.now() - t0,
  };
}

self.onmessage = async (ev: MessageEvent<WorkerInMessage>) => {
  try {
    const msg = ev.data;
    if (msg.type === 'init') {
      dem = new DemSampler({ baseUrl: msg.baseUrl });
      await dem.loadIndex();
      return;
    }
    if (msg.type === 'compute') {
      const result = await compute(msg.origin, msg.peaks);
      // Передаём буфер горизонта без копирования
      (self as unknown as Worker).postMessage(result, [result.horizon.buffer]);
    }
  } catch (err) {
    const out: ErrorMessage = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(out);
  }
};

// nextRayStep реэкспортирован для тестов worker-протокола
void nextRayStep;
