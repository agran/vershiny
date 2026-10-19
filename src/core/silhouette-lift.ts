/**
 * Подтяжка силуэта DEM к известным вершинам (OSM).
 *
 * Высоты и положения вершин в OSM точнее модели рельефа, а ближняя острая
 * вершина в 90-метровом DEM бывает ниже настоящей на 80–100 м — это 2° на
 * дистанции 2.7 км, то есть сотни пикселей на фото из похода. Вокруг каждой
 * такой вершины силуэт поднимается треугольным «горбом» на величину
 * недобора; выше DEM силуэт не опускается.
 */

import { CREST_BOUNDS, LAYER_BOUNDS } from "./horizon";

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/** Известная вершина: задаёт гребень, который DEM занижает */
export interface SilhouetteAnchor {
  azimuthRad: number;
  elevationRad: number;
  distanceM: number;
}

/** DEM занижает ближние острые вершины (сглаживание ~90 м): порог значимого занижения */
const ANCHOR_MIN_LIFT_DEG = 0.25;
/** Вершины дальше этого не поднимаем: заметной угловой ошибки там нет */
const ANCHOR_MAX_DIST_M = 25_000;
/** Полуширина «горба» вершины в метрах: на ближней вершине это градусы, на дальней — доли */
const ANCHOR_HALF_WIDTH_M = 500;
const ANCHOR_MIN_HALF_WIDTH_DEG = 1;
const ANCHOR_MAX_HALF_WIDTH_DEG = 9;

/** Копия профиля, подтянутая к вершинам; −Infinity (нет рельефа) не трогается */
export function liftSilhouetteByPeaks(
  horizon: Float32Array,
  stepRad: number,
  anchors: readonly SilhouetteAnchor[],
): Float32Array {
  const out = Float32Array.from(horizon);
  const n = out.length;
  for (const a of anchors) {
    if (
      !(a.distanceM > 0) ||
      a.distanceM > ANCHOR_MAX_DIST_M ||
      !Number.isFinite(a.elevationRad)
    ) {
      continue;
    }
    const idx = Math.round(
      (((a.azimuthRad % TWO_PI) + TWO_PI) % TWO_PI) / stepRad,
    );
    // Силуэт у вершины: максимум в ±1° (положение вершины в DEM плавает)
    const near = Math.ceil((1 * DEG) / stepRad);
    let base = -Infinity;
    for (let d = -near; d <= near; d++) {
      const v = horizon[(((idx + d) % n) + n) % n];
      if (v > base) base = v;
    }
    const lift = Number.isFinite(base) ? a.elevationRad - base : 0;
    if (!(lift > ANCHOR_MIN_LIFT_DEG * DEG)) continue;
    const half = Math.min(
      ANCHOR_MAX_HALF_WIDTH_DEG * DEG,
      Math.max(
        ANCHOR_MIN_HALF_WIDTH_DEG * DEG,
        Math.atan(ANCHOR_HALF_WIDTH_M / a.distanceM),
      ),
    );
    const span = Math.ceil(half / stepRad);
    for (let d = -span; d <= span; d++) {
      const k = (((idx + d) % n) + n) % n;
      const v = horizon[k];
      if (!Number.isFinite(v)) continue;
      const bump = lift * Math.pow(1 - Math.abs(d) / (span + 1), 1.2);
      if (v + bump > out[k]) out[k] = v + bump;
    }
  }
  return out;
}

/** Профили панорамы, которые рисуются как контуры (мутируются на месте) */
export interface LiftableProfiles {
  horizon: Float32Array;
  stepRad: number;
  layers?: Float32Array[];
  crests?: Float32Array[];
}

/** Вершины с дистанцией в корзине [lo, hi) */
function inBin(
  anchors: readonly SilhouetteAnchor[],
  lo: number,
  hi: number,
): SilhouetteAnchor[] {
  return anchors.filter((a) => a.distanceM >= lo && a.distanceM < hi);
}

function liftInPlace(
  profile: Float32Array | undefined,
  stepRad: number,
  anchors: readonly SilhouetteAnchor[],
): void {
  if (!profile || !anchors.length) return;
  profile.set(liftSilhouetteByPeaks(profile, stepRad, anchors));
}

/**
 * Подтянуть к вершинам сами профили панорамы — то, что рисуется контурами.
 * Вершина поднимает только ту корзину гребней/слоёв, в которой лежит её
 * дистанция, и верхний слой `horizon`: ближний склон не вырастает от
 * дальней вершины, а окклюзия гребней остаётся честной.
 *
 * @param anchors видимые вершины (скрытые за хребтом передавать не нужно)
 */
export function liftPanoramaByPeaks(
  panorama: LiftableProfiles,
  anchors: readonly SilhouetteAnchor[],
): void {
  if (!anchors.length) return;
  const { stepRad } = panorama;
  liftInPlace(panorama.horizon, stepRad, anchors);
  panorama.crests?.forEach((profile, i) => {
    liftInPlace(
      profile,
      stepRad,
      inBin(
        anchors,
        CREST_BOUNDS[i] ?? Infinity,
        CREST_BOUNDS[i + 1] ?? Infinity,
      ),
    );
  });
  panorama.layers?.forEach((profile, i) => {
    liftInPlace(
      profile,
      stepRad,
      inBin(
        anchors,
        LAYER_BOUNDS[i] ?? Infinity,
        LAYER_BOUNDS[i + 1] ?? Infinity,
      ),
    );
  });
}
