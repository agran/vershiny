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
  computeLayeredHorizon,
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
  /** Переопределение высоты наблюдателя (для навигации вверх/вниз) */
  observerHeightOverride?: number;
}

export interface ResultMessage {
  type: 'result';
  /** Углы горизонта по лучам, рад (верхний слой) */
  horizon: Float32Array;
  /** Шаг между лучами, рад */
  stepRad: number;
  /** Слои горизонта по дистанционным корзинам */
  layers: Float32Array[];
  /** Дистанция до точки горизонта по лучам */
  distanceToHorizonM: Float32Array;
  /** Фронты видимости по лучам (для точных маркеров) */
  fronts: import('../core/horizon').VisibleFront[][];
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

async function compute(origin: LatLon, peaks: Peak[], heightOverride?: number): Promise<ResultMessage> {
  if (!dem) throw new Error('Worker не инициализирован (init)');
  const t0 = performance.now();

  const observerH = heightOverride ?? (await dem.observerHeight(origin));

  // Предзагрузка тайлов веером лучей (шаг 5° — достаточно для покрытия)
  const prefetchTasks: Promise<void>[] = [];
  for (let az = 0; az < 2 * Math.PI; az += (5 * Math.PI) / 180) {
    prefetchTasks.push(
      dem.prefetchAlongRay(origin, az, MAX_DIST_M, 8_000, destination),
    );
  }
  await Promise.all(prefetchTasks);

  const sample = (pos: LatLon, distM: number): number => dem!.sample(pos, distM);

  const layered = computeLayeredHorizon(origin, observerH, sample);
  const visible = filterVisiblePeaks(origin, observerH, peaks, sample, layered);

  return {
    type: 'result',
    horizon: layered.layers[0], // ближний слой = основной горизонт
    stepRad: layered.stepRad,
    layers: layered.layers,
    distanceToHorizonM: layered.distanceToHorizonM,
    fronts: layered.fronts,
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
      const result = await compute(msg.origin, msg.peaks, msg.observerHeightOverride);
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
