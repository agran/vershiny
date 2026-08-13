/**
 * Web Worker: ray-marching горизонта и видимость пиков (ARCHITECTURE.md).
 * Источник высот — DemSource (new-geo-data.md): локальный патч → Terrarium.
 *
 * Протокол сообщений:
 *   → { type: 'init', patchBaseUrl? }
 *   → { type: 'compute', origin, peaks }
 *   → { type: 'viewpoint', peak }   — подобрать точку, откуда вершина видна
 *   ← { type: 'result', horizon, stepRad, peaks, observerH, computeMs }
 *   ← { type: 'viewpoint', origin, azimuthRad }
 *   ← { type: 'error', message }
 */

import { DemSource } from '../core/dem-source';
import {
  checkPeakVisibility,
  computeLayeredHorizon,
  filterVisiblePeaks,
  type VisiblePeak,
} from '../core/horizon';
import { azimuthRad, destination, type LatLon } from '../core/geo';
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

/** Подобрать точку, с которой вершина действительно видна */
export interface ViewpointMessage {
  type: 'viewpoint';
  peak: Peak;
  /** Желаемое удаление от вершины, м */
  distM?: number;
}

export interface ViewpointResult {
  type: 'viewpoint';
  origin: LatLon;
  /** Азимут с точки на вершину, рад */
  azimuthRad: number;
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
  /** Гребни силуэта по корзинам дистанций [корзина][луч] */
  crests: Float32Array[];
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

export type WorkerInMessage = InitMessage | ComputeMessage | ViewpointMessage;
export type WorkerOutMessage = ResultMessage | ErrorMessage | ViewpointResult;

let dem: DemSource | null = null;

/** Максимальная дальность луча — синхронизирована с computeHorizon */
const MAX_DIST_M = 200_000;

async function compute(origin: LatLon, peaks: Peak[], heightOverride?: number): Promise<ResultMessage> {
  if (!dem) throw new Error('Worker не инициализирован (init)');
  const t0 = performance.now();

  // Высота наблюдателя: max по окрестности 3×3 (не ниже поверхности)
  const observerH = heightOverride ?? (await dem.observerHeightSafe(origin));

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
    crests: layered.crests,
    peaks: visible,
    observerH,
    computeMs: performance.now() - t0,
  };
}

/**
 * Выбор точки обзора для «перелёта» к вершине.
 *
 * Раньше точка ставилась просто по обратному азимуту от прежнего места — при
 * прыжке через полпланеты направление случайное, и наблюдатель оказывался в
 * цирке под соседней стеной: искали Белуху, а видели Корону Алтая в километре.
 *
 * Пробуем 12 азимутов вокруг вершины и берём тот, откуда она действительно
 * видна, а из таких — самый низкий (открытая долина, гора возвышается целиком).
 */
async function pickViewpoint(peak: Peak, distM: number): Promise<ViewpointResult> {
  if (!dem) throw new Error('Worker не инициализирован (init)');
  const summit: LatLon = { lat: peak.lat, lon: peak.lon };
  const candidates: { origin: LatLon; observerH: number; visible: boolean }[] = [];

  for (let i = 0; i < 12; i++) {
    const az = (i * 2 * Math.PI) / 12;
    const origin = destination(summit, az, distM);
    const toPeak = azimuthRad(origin, summit);
    try {
      await dem.prefetchAlongRay(origin, toPeak, distM * 1.2, 200, destination);
      const observerH = await dem.observerHeightSafe(origin);
      const sample = (pos: LatLon, d: number): number => dem!.sample(pos, d);
      const check = checkPeakVisibility(origin, observerH, peak, sample, Infinity);
      candidates.push({ origin, observerH, visible: check?.visibility === 'visible' });
    } catch {
      /* нет данных в этой точке — пропускаем */
    }
  }

  const visible = candidates.filter((c) => c.visible);
  const pool = visible.length ? visible : candidates;
  if (!pool.length) {
    return { type: 'viewpoint', origin: summit, azimuthRad: 0 };
  }
  // Из точек с видимой вершиной — самая низкая: оттуда гора видна целиком
  const best = pool.reduce((a, b) => (b.observerH < a.observerH ? b : a));
  return {
    type: 'viewpoint',
    origin: best.origin,
    azimuthRad: azimuthRad(best.origin, summit),
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
    if (msg.type === 'viewpoint') {
      self.postMessage(await pickViewpoint(msg.peak, msg.distM ?? 6_000));
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
