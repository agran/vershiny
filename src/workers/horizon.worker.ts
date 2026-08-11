/**
 * Web Worker: ray-marching горизонта и видимость пиков (ARCHITECTURE.md).
 * Источник высот — DemSource (new-geo-data.md): локальный патч → Terrarium.
 *
 * Протокол сообщений:
 *   → { type: 'init', patchBaseUrl? }
 *   → { type: 'compute', origin, peaks }
 *   ← { type: 'result', horizon, stepRad, peaks, observerH, computeMs }
 *   ← { type: 'error', message }
 */

import { DemSource } from '../core/dem-source';
import {
  computeHorizon,
  filterVisiblePeaks,
  type VisiblePeak,
} from '../core/horizon';
import { destination, type LatLon } from '../core/geo';
import type { Peak } from '../core/peaks';

export interface InitMessage {
  type: 'init';
  /** URL локального патча (tiles/{region}); без него — только Terrarium */
  patchBaseUrl?: string;
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

let dem: DemSource | null = null;

/** Максимальная дальность луча — синхронизирована с computeHorizon */
const MAX_DIST_M = 200_000;

async function compute(origin: LatLon, peaks: Peak[]): Promise<ResultMessage> {
  if (!dem) throw new Error('Worker не инициализирован (init)');
  const t0 = performance.now();

  const observerH = await dem.observerHeight(origin);

  // Предзагрузка тайлов веером лучей (шаг 5° — достаточно для покрытия)
  const prefetchTasks: Promise<void>[] = [];
  for (let az = 0; az < 2 * Math.PI; az += (5 * Math.PI) / 180) {
    prefetchTasks.push(
      dem.prefetchAlongRay(origin, az, MAX_DIST_M, 8_000, destination),
    );
  }
  await Promise.all(prefetchTasks);

  const sample = (pos: LatLon, distM: number): number => dem!.sample(pos, distM);

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
      dem = new DemSource({ patchBaseUrl: msg.patchBaseUrl });
      await dem.init();
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
