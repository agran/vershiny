/**
 * Ray-marching горизонта (ALGORITHMS.md §1–2).
 * Чистые функции без I/O — DEM передаётся как синхронный сэмплер,
 * поэтому код одинаково работает в Web Worker и в тестах.
 */

import {
  destination,
  earthDrop,
  elevationAngleRad,
  distanceM,
  azimuthRad,
  type LatLon,
} from './geo';
import type { Peak } from './peaks';
import { PEAK_VISIBILITY_RADIUS_M } from './peaks';

/** Синхронная выборка высоты: (pos, дистанция от наблюдателя) → метры | NaN */
export type SampleFn = (pos: LatLon, distM: number) => number;

export interface HorizonOptions {
  /** Шаг по азимуту, рад. 0.1° → 3600 лучей */
  azimuthStepRad?: number;
  /** Максимальная дальность луча, м */
  maxDistM?: number;
  /** Начало луча, м (ближе — свой склон, шум) */
  minDistM?: number;
  /** Высота глаз/телефона над землёй, м */
  observerElevationM?: number;
}

/** Дистанционные корзины для слоёв (метры) */
export const LAYER_BOUNDS = [0, 5_000, 15_000, 40_000, 100_000, 200_000] as const;
export const LAYER_COUNT = LAYER_BOUNDS.length - 1;

/**
 * Дистанционные корзины для гребней (метры).
 * Гребень = точка, где угол возвышения вдоль луча достиг локального максимума
 * и дальше падает: именно такие точки видны в кадре как линия силуэта.
 */
export const CREST_BOUNDS = [0, 800, 2_000, 5_000, 12_000, 30_000, 70_000, 200_001] as const;
export const CREST_COUNT = CREST_BOUNDS.length - 1;
/** Насколько угол должен упасть после максимума, чтобы это считалось гребнем, рад (~0.09°) */
const CREST_DROP_RAD = 0.0015;

/** Видимый фронт: участок рельефа, пробивающийся над ближним */
export interface VisibleFront {
  /** Дистанция начала фронта, м */
  distM: number;
  /** Дистанция конца фронта (где перекрывается следующим), м */
  distEndM: number;
  /** Угол, с которого фронт виден (низ видимой части), рад */
  elevStartRad: number;
  /** Максимальный угол внутри фронта (гребень), рад */
  elevMaxRad: number;
}

export interface LayeredHorizon {
  /** Для каждого слоя: углы горизонта по лучам */
  layers: Float32Array[];
  /** Шаг между лучами, рад */
  stepRad: number;
  /** Для каждого луча: дистанция до видимой точки горизонта (для классификации пиков) */
  distanceToHorizonM: Float32Array;
  /** Для каждого луча: фронты видимости (локальные максимумы по дистанции) */
  fronts: VisibleFront[][];
  /** Гребни по дистанционным корзинам: [корзина][луч] — углы видимых перегибов */
  crests: Float32Array[];
}

export interface VisiblePeak extends Peak {
  /** Истинный азимут на пик, рад [0, 2π) */
  azimuthRad: number;
  /** Угол возвышения пика, рад */
  elevationRad: number;
  /** Расстояние, м */
  distanceM: number;
  /** Видимость: выше горизонта / на склоне / скрыт хребтом */
  visibility: 'visible' | 'onSlope' | 'hidden';
}

const TWO_PI = 2 * Math.PI;

/**
 * Адаптивный шаг вдоль луча: 90 м вблизи → 500 м+ вдали (ALGORITHMS.md §1).
 * Возвращает следующую дистанцию.
 */
export function nextRayStep(distM: number): number {
  if (distM < 5_000) return 90;
  if (distM < 30_000) return 180;
  if (distM < 100_000) return 350;
  return 700;
}

/**
 * Профиль горизонта: для каждого азимута — максимальный угол возвышения
 * видимого рельефа. Возвращает Float32Array длиной ceil(2π/step).
 */
export function computeHorizon(
  origin: LatLon,
  observerH: number,
  sample: SampleFn,
  options: HorizonOptions = {},
): { angles: Float32Array; stepRad: number } {
  const stepRad = options.azimuthStepRad ?? (0.1 * Math.PI) / 180;
  const maxDist = options.maxDistM ?? 200_000;
  const minDist = options.minDistM ?? 100;
  const hO = observerH + (options.observerElevationM ?? 1.7);

  const rayCount = Math.ceil(TWO_PI / stepRad);
  const angles = new Float32Array(rayCount).fill(-Infinity);

  for (let i = 0; i < rayCount; i++) {
    const az = i * stepRad;
    let maxAngle = -Infinity;
    // Локальный «фронт»: как только земля ушла за горизонт с запасом,
    // дальше можно шагать крупнее — реализовано в nextRayStep
    for (let d = minDist; d <= maxDist; d += nextRayStep(d)) {
      const p = destination(origin, az, d);
      const h = sample(p, d);
      if (Number.isNaN(h)) continue;
      const apparentH = h - earthDrop(d);
      const angle = Math.atan2(apparentH - hO, d);
      if (angle > maxAngle) maxAngle = angle;
      // Ранний выход: рельеф опустился ниже −0.5° и мы далеко —
      // выше уже не поднимется (кривизна давит квадратично)
      if (d > 60_000 && angle < maxAngle - 0.02 && maxAngle < -0.005) break;
    }
    angles[i] = maxAngle;
  }
  return { angles, stepRad };
}

/**
 * Слоистый горизонт: для каждой корзины дистанций — свой профиль.
 * Также собираем фронты видимости (локальные максимумы по дистанции).
 *
 * После сбора — адаптивное сглаживание с защитой разрывов дистанции.
 */
export function computeLayeredHorizon(
  origin: LatLon,
  observerH: number,
  sample: SampleFn,
  options: HorizonOptions = {},
): LayeredHorizon {
  const stepRad = options.azimuthStepRad ?? (0.1 * Math.PI) / 180;
  const maxDist = options.maxDistM ?? 200_000;
  const minDist = options.minDistM ?? 100;
  const hO = observerH + (options.observerElevationM ?? 1.7);

  const rayCount = Math.ceil(TWO_PI / stepRad);
  const layers = Array.from({ length: LAYER_COUNT }, () => new Float32Array(rayCount).fill(-Infinity));
  const distanceToHorizonM = new Float32Array(rayCount).fill(Infinity);
  const fronts: VisibleFront[][] = Array.from({ length: rayCount }, () => []);
  // Гребни: видимые перегибы силуэта по корзинам дистанций
  const crests = Array.from({ length: CREST_COUNT }, () => new Float32Array(rayCount).fill(-Infinity));

  // Марш начинаем с 1.5 ячейки DEM (численная стабильность atan2)
  const marchStart = minDist * 1.5; // ~135 м для 90 м DEM

  for (let i = 0; i < rayCount; i++) {
    const az = i * stepRad;
    // Для каждой корзины — свой максимум
    const binMax = new Float64Array(LAYER_COUNT).fill(-Infinity);
    const binDist = new Float64Array(LAYER_COUNT).fill(Infinity);

    // Фронты: точки, где рельеф пробивает текущий максимум
    const rayFronts: VisibleFront[] = [];
    let currentMax = -Infinity;
    let frontStartDist = 0;

    // Пропускаем ближнюю зону для фронтов (0–500 м): мы на этом склоне
    const nearSkip = 500;

    // Гребни: отслеживаем текущий максимум угла и дистанцию, на которой он достигнут
    let crestMax = -Infinity;
    let crestDist = 0;
    let crestPending = false;
    const recordCrest = (): void => {
      if (!crestPending) return;
      let b = CREST_COUNT - 1;
      for (let k = 0; k < CREST_COUNT; k++) {
        if (crestDist >= CREST_BOUNDS[k] && crestDist < CREST_BOUNDS[k + 1]) {
          b = k;
          break;
        }
      }
      if (crestMax > crests[b][i]) crests[b][i] = crestMax;
      crestPending = false;
    };

    for (let d = marchStart; d <= maxDist; d += nextRayStep(d)) {
      const p = destination(origin, az, d);
      const h = sample(p, d);
      if (Number.isNaN(h)) continue;
      const apparentH = h - earthDrop(d);
      const angle = Math.atan2(apparentH - hO, d);

      // Корзина по дистанции
      let bin = 0;
      for (let b = 0; b < LAYER_COUNT; b++) {
        if (d >= LAYER_BOUNDS[b] && d < LAYER_BOUNDS[b + 1]) {
          bin = b;
          break;
        }
        if (d >= LAYER_BOUNDS[LAYER_COUNT]) bin = LAYER_COUNT - 1;
      }

      if (angle > binMax[bin]) {
        binMax[bin] = angle;
        binDist[bin] = d;
      }

      // Гребни: фиксируем локальный максимум угла вдоль луча.
      // Растёт — запоминаем; заметно упал — значит проехали перегиб (видимый гребень).
      if (angle > crestMax) {
        crestMax = angle;
        crestDist = d;
        crestPending = true;
      } else if (crestPending && angle < crestMax - CREST_DROP_RAD) {
        recordCrest();
      }

      // Фронт: новый максимум = начало или продолжение
      if (angle > currentMax && d >= nearSkip) {
        if (rayFronts.length === 0 || d - rayFronts[rayFronts.length - 1].distEndM > 2000) {
          // Новый фронт (после провала >2 км)
          rayFronts.push({
            distM: d,
            distEndM: d,
            elevStartRad: angle,
            elevMaxRad: angle,
          });
          frontStartDist = d;
        } else {
          // Продолжение текущего фронта
          const front = rayFronts[rayFronts.length - 1];
          front.distEndM = d;
          if (angle > front.elevMaxRad) front.elevMaxRad = angle;
        }
        currentMax = angle;
      } else if (rayFronts.length > 0 && d - frontStartDist > 2000) {
        // Провал — закрываем фронт
        const front = rayFronts[rayFronts.length - 1];
        front.distEndM = d;
      }

      // Ранний выход
      if (d > 60_000 && angle < binMax[bin] - 0.02 && binMax[bin] < -0.005) break;
    }

    // Последний максимум по лучу — это линия неба (skyline)
    recordCrest();

    // Слои
    for (let b = 0; b < LAYER_COUNT; b++) {
      if (binMax[b] > -Infinity) {
        layers[b][i] = binMax[b];
        if (b === 0 || binDist[b] < distanceToHorizonM[i]) {
          distanceToHorizonM[i] = binDist[b];
        }
      }
    }

    fronts[i] = rayFronts;
  }

  // Адаптивное сглаживание с защитой разрывов дистанции
  const smoothed = smoothLayers(layers, distanceToHorizonM, stepRad);

  return { layers: smoothed, stepRad, distanceToHorizonM, fronts, crests };
}

/** Адаптивное сглаживание силуэта: ширина окна ~ полразмера ячейки в лучах */
function smoothLayers(
  layers: Float32Array[],
  distanceToHorizonM: Float32Array,
  stepRad: number,
): Float32Array[] {
  const rayCount = layers[0].length;
  const smoothed = layers.map((layer) => new Float32Array(layer.length));

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const out = smoothed[layerIdx];

    for (let i = 0; i < rayCount; i++) {
      if (layer[i] === -Infinity) {
        out[i] = -Infinity;
        continue;
      }

      // Полразмера ячейки в лучах: (90 / dist) / stepRad
      const dist = distanceToHorizonM[i];
      const cellSizeM = 90; // DEM 90 м
      const halfWin = Math.min(
        8,
        Math.max(0, Math.round((cellSizeM / 2 / dist) / stepRad)),
      );

      let sum = 0;
      let n = 0;
      for (let j = -halfWin; j <= halfWin; j++) {
        const k = (i + j + rayCount) % rayCount;
        // Не сглаживать через разрывы дистанции
        if (Math.abs(distanceToHorizonM[k] - dist) / dist > 0.5) continue;
        if (layer[k] === -Infinity) continue;
        sum += layer[k];
        n++;
      }
      out[i] = n > 0 ? sum / n : layer[i];
    }
  }

  return smoothed;
}

/**
 * Видимость пика: точный луч в его азимуте (ALGORITHMS.md §2).
 * Классификация: visible (выше горизонта) / onSlope (на видимом склоне) / hidden (за хребтом).
 */
export function checkPeakVisibility(
  origin: LatLon,
  observerH: number,
  peak: Peak,
  sample: SampleFn,
  distanceToHorizonM: number,
  epsilonRad = 0.0009, // ~0.05°
): VisiblePeak | null {
  const target: LatLon = { lat: peak.lat, lon: peak.lon };
  const dist = distanceM(origin, target);
  if (dist > PEAK_VISIBILITY_RADIUS_M || dist < 1) return null;
  if (peak.ele === undefined) return null;

  const az = azimuthRad(origin, target);
  const hO = observerH + 1.7;

  // Марш луча до пика: ищем максимальный угол рельефа строго до пика
  let maxAngle = -Infinity;
  for (let d = 100; d < dist - 100; d += nextRayStep(d)) {
    const p = destination(origin, az, d);
    const h = sample(p, d);
    if (Number.isNaN(h)) continue;
    const angle = Math.atan2(h - earthDrop(d) - hO, d);
    if (angle > maxAngle) maxAngle = angle;
  }

  const peakAngle = elevationAngleRad(hO, peak.ele, dist);

  // Классификация по углу и дистанции до горизонта
  if (peakAngle < maxAngle - epsilonRad) {
    // Пик ниже профиля луча — скрыт или на склоне
    if (dist < distanceToHorizonM) {
      return {
        ...peak,
        azimuthRad: az,
        elevationRad: peakAngle,
        distanceM: dist,
        visibility: 'onSlope',
      };
    }
    return null; // скрыт хребтом — не показываем
  }

  return {
    ...peak,
    azimuthRad: az,
    elevationRad: peakAngle,
    distanceM: dist,
    visibility: 'visible',
  };
}

/** Массовая проверка видимости списка пиков */
export function filterVisiblePeaks(
  origin: LatLon,
  observerH: number,
  peaks: Peak[],
  sample: SampleFn,
  layered?: LayeredHorizon,
): VisiblePeak[] {
  const result: VisiblePeak[] = [];
  for (const peak of peaks) {
    const distToHorizon = layered
      ? layered.distanceToHorizonM[Math.round(azimuthRad(origin, peak) / layered.stepRad) % layered.distanceToHorizonM.length]
      : Infinity;
    const visible = checkPeakVisibility(origin, observerH, peak, sample, distToHorizon);
    if (visible) result.push(visible);
  }
  // Сортировка: видимые → на склоне → скрытые; внутри — по score
  const order = { visible: 0, onSlope: 1, hidden: 2 };
  result.sort((a, b) => {
    const oa = order[a.visibility];
    const ob = order[b.visibility];
    if (oa !== ob) return oa - ob;
    return (b.ele ?? 0) / b.distanceM - (a.ele ?? 0) / a.distanceM;
  });
  return result;
}
