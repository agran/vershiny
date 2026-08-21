/**
 * Дифференциальный тест пакета оптимизаций ядра марша (docs/boost.md,
 * DS-C2/DS-C4/DS-C5): эталонная копия ПРЕЖНЕГО computeLayeredHorizon
 * (замыкание recordCrest, пошаговое деление секторной границы, `%` в
 * сглаживании) сравнивается побитово с текущей реализацией на
 * конфигурациях границ секторов.
 */

import { describe, expect, it } from "vitest";
import { makeRayMarcher, type LatLon } from "../src/core/geo";
import {
  buildMarchTable,
  computeLayeredHorizon,
  CREST_BOUNDS,
  CREST_COUNT,
  CREST_DROP_RAD,
  LAYER_COUNT,
  smoothLayers,
  type LayeredHorizon,
  type SampleFn,
  type VisibleFront,
} from "../src/core/horizon";

const TWO_PI = 2 * Math.PI;
const ORIGIN: LatLon = { lat: 43.318, lon: 42.458 };

/** Детерминированный ГПСЧ (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Эталон прежнего сглаживания — с делением по модулю */
function referenceSmoothLayers(
  layers: Float32Array[],
  layerDistM: Float32Array[],
  stepRad: number,
): Float32Array[] {
  const rayCount = layers[0].length;
  const smoothed = layers.map((layer) => new Float32Array(layer.length));

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const dists = layerDistM[layerIdx];
    const out = smoothed[layerIdx];

    for (let i = 0; i < rayCount; i++) {
      if (layer[i] === -Infinity) {
        out[i] = -Infinity;
        continue;
      }
      const dist = dists[i];
      if (!Number.isFinite(dist)) {
        out[i] = layer[i];
        continue;
      }
      const cellSizeM = Math.max(90, dist / 150);
      const halfWin = Math.min(
        8,
        Math.max(0, Math.round(cellSizeM / 2 / dist / stepRad)),
      );
      let sum = 0;
      let n = 0;
      for (let j = -halfWin; j <= halfWin; j++) {
        const k = (i + j + rayCount) % rayCount;
        const dk = dists[k];
        if (!Number.isFinite(dk)) continue;
        if (Math.abs(dk - dist) / dist > 0.5) continue;
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
 * Эталонная копия прежнего computeLayeredHorizon (до пакета из
 * docs/boost.md): замыкание recordCrest, чтение march.* через поля,
 * пошаговое деление наклона секторной границы, `%` в сглаживании.
 */
function referenceLayeredHorizon(
  origin: LatLon,
  observerH: number,
  sample: SampleFn,
  options: {
    azimuthStepRad?: number;
    maxDistM?: number;
    sectorMax?: Float32Array;
  },
): LayeredHorizon {
  const stepRad = options.azimuthStepRad ?? (0.1 * Math.PI) / 180;
  const maxDist = options.maxDistM ?? 200_000;
  const minDist = 100;
  const hO = observerH + 1.7; // OBSERVER_EYE_M

  const rayCount = Math.ceil(TWO_PI / stepRad);
  const layers = Array.from({ length: LAYER_COUNT }, () =>
    new Float32Array(rayCount).fill(-Infinity),
  );
  const distanceToHorizonM = new Float32Array(rayCount).fill(Infinity);
  const layerDistM = Array.from({ length: LAYER_COUNT }, () =>
    new Float32Array(rayCount).fill(Infinity),
  );
  const fronts: VisibleFront[][] = Array.from({ length: rayCount }, () => []);
  const crests = Array.from({ length: CREST_COUNT }, () =>
    new Float32Array(rayCount).fill(-Infinity),
  );

  const march = buildMarchTable(minDist * 1.5, maxDist);
  const steps = march.count;

  const FRONT_INITIAL = 32;
  let fDist = new Float64Array(FRONT_INITIAL);
  let fEnd = new Float64Array(FRONT_INITIAL);
  let fStartRad = new Float64Array(FRONT_INITIAL);
  let fMaxRad = new Float64Array(FRONT_INITIAL);
  const growFronts = (): void => {
    const doubled = (src: Float64Array): Float64Array => {
      const next = new Float64Array(src.length * 2);
      next.set(src);
      return next;
    };
    fDist = doubled(fDist);
    fEnd = doubled(fEnd);
    fStartRad = doubled(fStartRad);
    fMaxRad = doubled(fMaxRad);
  };

  const binMaxSlope = new Float64Array(LAYER_COUNT);
  const binDist = new Float64Array(LAYER_COUNT);
  const binMaxAngle = new Float64Array(LAYER_COUNT);
  const binExitSlope = new Float64Array(LAYER_COUNT);

  for (let i = 0; i < rayCount; i++) {
    const pointAt = makeRayMarcher(origin, i * stepRad, march);
    binMaxSlope.fill(-Infinity);
    binDist.fill(Infinity);
    binMaxAngle.fill(-Infinity);
    binExitSlope.fill(-Infinity);

    const sectorMax = options.sectorMax;
    const sector =
      sectorMax && sectorMax.length > 0
        ? Math.floor((i * sectorMax.length) / rayCount)
        : -1;
    const sectorBound = sector >= 0 && sectorMax ? sectorMax[sector] : NaN;
    let rayMaxSlope = -Infinity;

    let frontCount = 0;
    let currentMaxSlope = -Infinity;
    const nearSkip = 500;

    let crestMaxSlope = -Infinity;
    let crestMaxAngle = -Infinity;
    let crestDropSlope = -Infinity;
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
      if (crestMaxAngle > crests[b][i]) crests[b][i] = crestMaxAngle;
      crestPending = false;
    };

    for (let s = 0; s < steps; s++) {
      const d = march.d[s];
      const h = sample(pointAt(s), d, march.hints[s]);
      if (h !== h) continue;
      const slope = (h - march.drop[s] - hO) / d;
      const bin = march.bin[s];
      if (slope > rayMaxSlope) rayMaxSlope = slope;

      if (slope > binMaxSlope[bin]) {
        binMaxSlope[bin] = slope;
        binDist[bin] = d;
        const a = Math.atan(slope);
        binMaxAngle[bin] = a;
        binExitSlope[bin] = Math.tan(a - 0.02);
      }

      if (slope > crestMaxSlope) {
        crestMaxSlope = slope;
        crestMaxAngle = Math.atan(slope);
        crestDropSlope = Math.tan(crestMaxAngle - CREST_DROP_RAD);
        crestDist = d;
        crestPending = true;
      } else if (crestPending && slope < crestDropSlope) {
        recordCrest();
      }

      if (slope > currentMaxSlope && d >= nearSkip) {
        const angle = Math.atan(slope);
        if (frontCount === 0 || d - fEnd[frontCount - 1] > 2000) {
          if (frontCount === fDist.length) growFronts();
          fDist[frontCount] = d;
          fEnd[frontCount] = d;
          fStartRad[frontCount] = angle;
          fMaxRad[frontCount] = angle;
          frontCount++;
        } else {
          fEnd[frontCount - 1] = d;
          if (angle > fMaxRad[frontCount - 1]) fMaxRad[frontCount - 1] = angle;
        }
        currentMaxSlope = slope;
      }

      if (d > 60_000 && slope < binExitSlope[bin] && binMaxAngle[bin] < -0.005)
        break;

      if (
        d > 20_000 &&
        Number.isFinite(sectorBound) &&
        rayMaxSlope > -Infinity
      ) {
        const boundSlope = (sectorBound - march.drop[s] - hO) / d;
        if (boundSlope < rayMaxSlope) break;
      }
    }

    recordCrest();

    for (let b = 0; b < LAYER_COUNT; b++) {
      if (binMaxAngle[b] > -Infinity) {
        layers[b][i] = binMaxAngle[b];
        layerDistM[b][i] = binDist[b];
        if (b === 0 || binDist[b] < distanceToHorizonM[i]) {
          distanceToHorizonM[i] = binDist[b];
        }
      }
    }

    const rayFronts = new Array<VisibleFront>(frontCount);
    for (let f = 0; f < frontCount; f++) {
      rayFronts[f] = {
        distM: fDist[f],
        distEndM: fEnd[f],
        elevStartRad: fStartRad[f],
        elevMaxRad: fMaxRad[f],
      };
    }
    fronts[i] = rayFronts;
  }

  const smoothed = referenceSmoothLayers(layers, layerDistM, stepRad);
  return { layers: smoothed, stepRad, distanceToHorizonM, fronts, crests };
}

/** Рельеф с гребнями, долинами и дырами данных (NaN-провалы луча) */
const terrain: SampleFn = (pos, d) => {
  const az = Math.atan2(pos.lon - ORIGIN.lon, pos.lat - ORIGIN.lat);
  if (Math.sin(az * 17 + 0.7) > 0.93) return NaN;
  return 2600 + 900 * Math.sin(az * 5) + 1400 * Math.sin(az * 11 + d * 2e-5);
};

describe("ядерный марш: пакет оптимизаций ≡ прежняя логика (побитово)", () => {
  const STEP = (0.5 * Math.PI) / 180; // 720 лучей

  const assertBitwise = (options: {
    azimuthStepRad: number;
    maxDistM: number;
    sectorMax?: Float32Array;
  }): void => {
    const ref = referenceLayeredHorizon(ORIGIN, 0, terrain, options);
    const got = computeLayeredHorizon(ORIGIN, 0, terrain, options);
    expect(got.stepRad).toBe(ref.stepRad);
    expect(got.layers).toEqual(ref.layers);
    expect(got.distanceToHorizonM).toEqual(ref.distanceToHorizonM);
    expect(got.crests).toEqual(ref.crests);
    expect(got.fronts).toEqual(ref.fronts);
  };

  it("побитово совпадает с эталоном на всех конфигурациях границ", () => {
    const sectorArray = (v: number, sectors = 72): Float32Array =>
      new Float32Array(sectors).fill(v);
    for (const bound of [5500, 300, 0, NaN, Infinity]) {
      assertBitwise({
        azimuthStepRad: STEP,
        maxDistM: 120_000,
        sectorMax: sectorArray(bound),
      });
    }
    // Реалистичные 72 сектора: высоты чередуются — часть лучей обрывается
    const realistic = new Float32Array(72);
    for (let i = 0; i < 72; i++) {
      realistic[i] = 800 + 4200 * (0.5 + 0.5 * Math.sin(i * 0.7 + 1.3));
    }
    assertBitwise({
      azimuthStepRad: STEP,
      maxDistM: 120_000,
      sectorMax: realistic,
    });
    // Полный марш без секторов (200 км)
    assertBitwise({ azimuthStepRad: STEP, maxDistM: 200_000 });
  });
});

describe("smoothLayers: ветка-обёртка ≡ %", () => {
  it("побитово совпадает с эталоном на % (окно 1, заворот на краях)", () => {
    const rayCount = 1000;
    const stepRad = (2 * Math.PI) / rayCount;
    const layer = new Float32Array(rayCount);
    const dists = new Float32Array(rayCount);
    const rand = rng(11);
    for (let i = 0; i < rayCount; i++) {
      layer[i] = -0.2 + 0.4 * rand();
      // 60 км → cellSizeM = 400 м → halfWin = 1: окно заворачивается
      // на краях (луч 0 читает луч rayCount−1 и наоборот)
      dists[i] = 60_000;
    }
    // Дыры и разрывы: все ветки фильтра окна должны сработать
    for (const i of [7, 123, 456, 789]) dists[i] = Infinity;
    for (const i of [21, 321, 521]) dists[i] = 10_000; // разрыв > 50 %
    for (const i of [3, 4, 5, 500, 501]) layer[i] = -Infinity;

    const ref = referenceSmoothLayers([layer], [dists], stepRad)[0];
    const got = smoothLayers([layer], [dists], stepRad)[0];
    expect(got).toEqual(ref);
  });

  it("на малом rayCount окно нулевое — сглаживание не включается", () => {
    // rayCount = 16, дистанция 300 м: halfWin = round(90/600/stepRad) = 0 —
    // заворот не нужен, выход тождествен входу
    const rayCount = 16;
    const stepRad = (2 * Math.PI) / rayCount;
    const layer = new Float32Array(rayCount);
    const dists = new Float32Array(rayCount).fill(300);
    for (let i = 0; i < rayCount; i++) layer[i] = i * 0.01;
    const got = smoothLayers([layer], [dists], stepRad)[0];
    expect(got).toEqual(layer);
  });
});
