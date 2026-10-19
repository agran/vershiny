/**
 * Калибровка камеры по ОДНОМУ фото: линия неба на снимке ↔ силуэт DEM.
 *
 * Известно положение наблюдателя (EXIF), а значит и силуэт гор вокруг него
 * (panorama.horizon: угол возвышения по 3600 лучам). Неизвестно, как была
 * повёрнута и устроена камера: азимут оптической оси, её возвышение,
 * крен вокруг оси и фокусное расстояние. Все четыре величины ищутся одной
 * подгонкой: линия неба на снимке превращается в лучи (азимут, возвышение)
 * при гипотезе камеры, и мера согласия — расстояние от этих лучей до
 * силуэта DEM в УГЛАХ (устойчивая, насыщающаяся — облако, человек, лес
 * и неточность DEM на ближних склонах не утягивают решение).
 *
 * Поиск в три ступени:
 *   1. глобальный — по кругу азимутов (шаг 0.5°) для каждой гипотезы
 *      (FOV, крен, наклон); оценка только по вертикали, дёшево;
 *   2. доводка лучших затравок Нелдером—Мидом с «отжигом» порога
 *      насыщения 2° → 0.8° → 0.4°, расстояние до ломаной силуэта (крутые
 *      скалы тоже считаются честно);
 *   3. гейты доверия: доля совпавших точек, охват кадра, единственность
 *      (второй азимутальный минимум заметно хуже) и наблюдаемость FOV.
 *
 * Всё — чистые функции над массивами: проверяются на синтетическом
 * рельефе без камеры (test/photo-fit.test.ts).
 */

import { fovForFrame } from "./camera-fov";
import type { SkylinePoints } from "./photo-skyline";
import {
  liftSilhouetteByPeaks,
  type SilhouetteAnchor,
} from "./silhouette-lift";

export { liftSilhouetteByPeaks, type SilhouetteAnchor };

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/** Поза камеры. Крен — поворот оверлея по часовой, как view.rollRad */
export interface CameraPose {
  /** Азимут оптической оси, рад */
  azRad: number;
  /** Возвышение оптической оси, рад (+ вверх) */
  elevRad: number;
  /** Крен, рад */
  rollRad: number;
  /** Горизонтальный FOV ПОЛНОГО кадра, рад */
  fovHRad: number;
}

export type PhotoFitFailure =
  "no-skyline" | "no-terrain" | "flat-horizon" | "poor-fit" | "ambiguous";

export interface PhotoFitDiagnostics {
  /** Доля точек линии неба, легших на силуэт DEM */
  inlierFrac: number;
  /**
   * Доля точек, не совпавших, но лежащих ниже силуэта сплошными участками:
   * гору на этих участках, вероятно, закрыло облако
   */
  occludedFrac: number;
  /** Среднеквадратичная невязка совпавших точек, px кадра */
  rmsPx: number;
  /** Доля ширины кадра, охваченная совпавшими точками */
  coverage: number;
  /** Во сколько раз второй азимутальный минимум хуже лучшего (∞ — один) */
  uniqueness: number;
  /** Нормированная стоимость решения (0 — идеал, 1 — всё мимо) */
  cost: number;
  /** FOV однозначно определяется формой линии (иначе взят приор) */
  fovObservable: boolean;
  /** Сколько затравок найдено глобальным поиском */
  seeds: number;
  /** Самый длинный непрерывный участок линии, легший на силуэт, доля ширины кадра */
  runFrac?: number;
  /** Размах высоты линии на этом участке, градусы (0 — участок «прямая линия») */
  runReliefDeg?: number;
}

export interface PhotoAlternative {
  pose: CameraPose;
  observerDeltaM: number;
  /** Доля совпавших точек линии в угловом допуске спасения */
  inlierFrac: number;
}

export interface PhotoFitResult {
  ok: boolean;
  reason?: PhotoFitFailure;
  /** Чем подобрана поза */
  method?: "skyline";
  /** Подобранный сдвиг высоты наблюдателя относительно панорамы, м (+ выше) */
  observerDeltaM?: number;
  /**
   * «approximate»: решение лучшее из найденных, но совпало не всё (DEM
   * сглаживает острые вершины) или второй азимут почти не хуже — поза
   * применима, но пользователя стоит предупредить.
   */
  quality?: "good" | "approximate";
  pose: CameraPose;
  diagnostics: PhotoFitDiagnostics;
  /**
   * При отказе из-за неоднозначности: несколько правдоподобных поз в разных
   * направлениях (не меньше двух), лучшая первой. По форме линии выбрать
   * нельзя — вызывающий может показать лучшую и дать перебрать остальные.
   */
  alternatives?: PhotoAlternative[];
}

export interface PhotoFitOptions {
  width: number;
  height: number;
  points: SkylinePoints;
  /** Силуэт DEM: угол возвышения по лучам от севера, −Infinity — нет рельефа */
  horizon: Float32Array;
  stepRad: number;
  /** Начальная поза: центр поиска и приор */
  prior: CameraPose;
  /** FOV известен (EXIF): поиск в узком коридоре вокруг приора */
  fovKnown?: boolean;
  /** Азимут приора надёжен (EXIF GPSImgDirection) — разрешает ничьи */
  azKnown?: boolean;
  /**
   * Линия на фото ниже силуэта DEM может быть облаком, закрывшим гору:
   * такие колонки штрафуются слабее несовпавших выше силуэта. По умолчанию
   * включено; выключатель нужен для сравнения в тестах.
   */
  occlusion?: boolean;
  /**
   * Дистанция до точки силуэта по лучам, м (panorama.distanceToHorizonM):
   * с ней подгонка допускает ошибку высоты наблюдателя (GPS в EXIF) — ближние
   * гребни при неверной высоте сдвигаются сильнее дальних.
   */
  distanceM?: Float32Array;
  /**
   * Подсказка азимута оси (пользователь повернул панораму в сторону
   * съёмки): поиск идёт только в окне ±halfRad. Нужна, когда по форме линии
   * несколько направлений подходят одинаково — по одной линии DEM и
   * телеобъектива их не разделить. Результат с подсказкой всегда
   * «приблизительно».
   */
  azHint?: { centerRad: number; halfRad: number };
  /**
   * Спасательная стадия при плохом совпадении (DEM расходится с кадром, см.
   * rescueByRun). Дорогая и осмысленна только на надёжной линии неба; у
   * вызывающего, который сначала пробует ненадёжную, её можно отложить.
   * По умолчанию включена.
   */
  rescue?: boolean;
  /**
   * Известные вершины (OSM): подтягивают силуэт DEM к настоящим высотам —
   * см. liftSilhouetteByPeaks. Без них силуэт берётся как есть.
   */
  anchors?: readonly SilhouetteAnchor[];
  /** Уступить циклу событий (UI не должен замирать на подгонке) */
  yieldToUi?: () => Promise<void>;
  onProgress?: (fraction: number) => void;
  /** Диагностика: итоговые кандидаты (лучший первым) до гейтов доверия */
  onCandidates?: (candidates: { pose: CameraPose; cost: number }[]) => void;
}

// ---- Настройки поиска -------------------------------------------------------

/** Сетка FOV по длинной стороне для слепого поиска: геометрическая, шаг 9 % */
const FOV_GRID_LONG_MIN_DEG = 24;
const FOV_GRID_RATIO = 1.09;
/** Допустимый FOV по длинной стороне, градусы (как CALIBRATION_LIMITS) */
const FOV_LONG_MIN_DEG = 14;
const FOV_LONG_MAX_DEG = 120;
/** Коридор FOV при известном фокусном (EXIF): ±12 % по тангенсу */
const FOV_KNOWN_SPAN = 0.12;
const TILT_MIN_DEG = -25;
const TILT_MAX_DEG = 35;
const TILT_STEP_DEG = 2.5;
/** Добавки к наклону узла сетки: внутри шага наклон сдвигает силуэт по вертикали */
const TILT_SUBSTEPS_DEG = [-0.85, 0, 0.85] as const;
/**
 * Запас при досрочном выходе из суммирования: частичная сумма должна
 * превысить лучшую оценку с зазором, чтобы округление не отбросило
 * кандидата, равного лучшему
 */
const PRUNE_SLACK = 1 + 1e-12;
/** Гипотезы крена глобального поиска: допуск ~2 % ширины не покрывает крен > 1.5° */
const ROLL_COARSE_DEG = [-2.5, 0, 2.5];
const YAW_STEP_DEG = 0.5;
/** Точек в глобальном (вертикальном) поиске и в доводке */
const COARSE_POINTS = 48;
const FINE_POINTS = 220;
/**
 * Пороги насыщения — доли ширины кадра, а не градусы: невязка меряется в
 * пикселях фото. Допуск в градусах «схлопывал» решение в узкий FOV (при
 * малом угле любая линия умещается в допуск), в пикселях — нет.
 */
const COARSE_TAU_W = 0.02;
const TAU_STAGES_W = [0.06, 0.035, 0.02, 0.012, 0.008, 0.004];
/** Сколько азимутальных минимумов брать на каждый FOV сетки / сколько доводить точно */
const SEEDS_PER_FOV = 3;
const SEED_KEEP_PRECISE = 8;
/** Окно подавления соседних минимумов по азимуту, градусы */
const SEED_NMS_DEG = 3;
const NM_MAX_EVALS = 140;
const NM_RESTARTS = 2;
/** Веса приоров в долях насыщения (стоимость данных ∈ [0, 1]) */
const PRIOR_ROLL_SIGMA_DEG = 3;
const PRIOR_ROLL_WEIGHT = 0.02;
const PRIOR_TILT_SIGMA_DEG = 20;
const PRIOR_TILT_WEIGHT = 0.01;
const PRIOR_FOV_SIGMA = 0.06;
const PRIOR_FOV_WEIGHT = 0.04;
/**
 * Высота наблюдателя из EXIF/DEM врёт на десятки метров; подгонка допускает
 * сдвиг до ±HEIGHT_MAX_M с мягким приором. Единица параметра — 50 м.
 */
const HEIGHT_UNIT_M = 50;
const HEIGHT_MAX_M = 200;
const PRIOR_HEIGHT_SIGMA_M = 60;
const PRIOR_HEIGHT_WEIGHT = 0.02;
/** Ближе этого сдвиг высоты не моделируется: 1/дистанция взрывается */
const HEIGHT_MIN_DIST_M = 300;
/** FOV считается определённым, если сдвиг на ±8 % поднимает стоимость хотя бы на столько */
const FOV_OBSERVABLE_RISE = 0.015;

// ---- Гейты доверия ----------------------------------------------------------

const MIN_POINTS = 24;
const MIN_INLIER_FRAC = 0.4;
const MIN_COVERAGE = 0.4;
const MIN_UNIQUENESS = 1.2;
/** Выше этих порогов результат «хороший», между ними и гейтами — «приблизительный» */
const GOOD_INLIER_FRAC = 0.65;
const GOOD_UNIQUENESS = 1.3;
/** Закрытого облаком больше этой доли — результат только «приблизительный» */
const GOOD_OCCLUDED_FRAC = 0.15;
/**
 * Облако закрывает гору: стоимость такой колонки (хуже настоящего совпадения,
 * заметно лучше промаха) и наибольшая глубина закрытия под силуэтом DEM
 */
const OCC_COST = 0.3;
const OCC_MAX_DEG = 12;
/** Закрытый участок — не меньше этого числа подряд идущих точек и доли линии */
const OCC_MIN_RUN_POINTS = 4;
const OCC_MIN_RUN_FRAC = 0.03;
/**
 * «Сильный участок»: DEM совпал с линией на протяжённом непрерывном куске
 * кадра, и форма куска сложная. Так бывает, когда DEM врёт на флангах
 * (дымка, облака, не тот гребень), а главная стена ложится точно: доля
 * совпавших ниже общего порога, но случайно такой кусок не совпадает.
 */
const RUN_MIN_WIDTH_FRAC = 0.4;
const RUN_MIN_RELIEF_DEG = 5;
/**
 * На телеобъективе весь кадр 15–20° по высоте, и 5° рельефа недостижимы:
 * порог не выше 15 % вертикального FOV (но не ниже, чем нужно прямой)
 */
const RUN_MIN_RELIEF_FRAC = 0.15;
/**
 * Строгость «сильного участка»: 0 — абсолютные пороги (слепой FOV); 1 —
 * рельеф относительно высоты кадра (FOV известен по EXIF); 2 — ещё и участок
 * поуже, 0.3, и рельеф 12 % (есть подсказка азимута: окно ±15° само снимает
 * неоднозначность, а человек в кадре рвёт линию на куски)
 */
type StrongLevel = 0 | 1 | 2 | 3;
const RUN_HINT_MIN_WIDTH_FRAC = 0.3;
const RUN_HINT_MIN_RELIEF_FRAC = 0.12;
/**
 * Варианты направления (3): честная линия по текстуре почти не шумит, и
 * рельеф реальной стены на телеобъективе — 10 % кадра. Порог ниже уровня 2
 * допустим только здесь: варианты пользователь видит и перебирает сам, а
 * применять их как единственный ответ нельзя
 */
const RUN_ALT_MIN_WIDTH_FRAC = 0.25;
const RUN_ALT_MIN_RELIEF_FRAC = 0.09;
/** Отклонение куска от прямой, доля ширины кадра: прямой отрезок подходит любой позе */
const RUN_MIN_CURVE_FRAC = 0.01;
/** Не больше выпавших подряд точек (доля числа точек) внутри участка */
const RUN_GAP_FRAC = 0.03;
/** Доля совпавших точек внутри участка */
const RUN_MIN_DENSITY = 0.85;
/** Единственность по участку: лучший участок во столько раз сильнее конкурента */
const RUN_MIN_UNIQUENESS = 1.5;
/**
 * Спасательная стадия при отказе гейтов: DEM врёт на 5–20 px (острая стена
 * занижена, фланги завышены), и финальный допуск 0.4 % ширины не отличает
 * истинную позу от чужих. Лучшие кандидаты дотачиваются с широким допуском,
 * а доверие даёт только протяжённый участок совпадения такого же допуска,
 * в разы сильнее, чем у конкурента из другого азимута.
 */
const RESCUE_STAGES_W = [0.04, 0.025, 0.015];
const RESCUE_TOL_W = 0.012;
/**
 * Угловой пол допуска спасения, градусы: DEM 90 м ошибается на 0.3–1° (стена
 * занижена, гребни сглажены) независимо от фокусного, а допуск в долях
 * ширины на телеобъективе (28°) сжимается до 0.3°
 */
const RESCUE_TOL_MIN_DEG = 0.7;
const RESCUE_CANDIDATES = 8;
/** Лучший участок обязан быть сильнее нулевого (чужие азимуты) во столько раз */
const RESCUE_NULL_RATIO = 2;
const NULL_AZ_STEP_DEG = 20;
const NULL_TILT_DEG = [-6, -3, 0, 3, 6];
const DEG_TO_RAD = Math.PI / 180;
/** FOV при известном фокусном в спасении свободнее: ±22 % вместо ±12 % */
const RESCUE_FOV_SPAN = 0.22;
/** Телефонная камера шире 100° по горизонтали не бывает: такое решение — подгонка под шум */
const RESCUE_MAX_HFOV_DEG = 100;
/**
 * Без EXIF-фокусного верхний предел жёстче: широкий кадр сжимает любую
 * гладкую линию в «рельеф» (случайная ломаная проходила на FOV 95°)
 */
const RESCUE_BLIND_MAX_HFOV_DEG = 85;
/** Неоднозначность спасается, только пока строгая подгонка объясняет меньше этой доли линии */
const RESCUE_AMBIGUOUS_MAX_INLIER = 0.5;
/** Конкурент из другого азимута с такой долей совпавших от победителя делает ответ неоднозначным */
const RESCUE_RIVAL_INLIER_RATIO = 0.9;
/** Итог спасения: ответ либо отказ с перечнем правдоподобных направлений */
interface RescueOutcome {
  result: PhotoFitResult | null;
  alternatives: PhotoAlternative[];
}
/**
 * Варианты для перебора пользователем (только при известном FOV): доля
 * совпавших не ниже, не больше ALT_MAX, между направлениями ≥ 6°. Ранг —
 * доля совпавших × правдоподобие наклона (σ 10°): снимок вниз на 5–8° реже
 */
const ALT_MIN_INLIER = 0.55;
const ALT_MAX = 4;
const ALT_MIN_AZ_GAP_DEG = 6;
const ALT_TILT_SIGMA_DEG = 10;
/** Ближе к границе FOV, чем на 3 % (по логарифму), решение не принимается */
const RESCUE_FOV_EDGE_LN = 0.03;

/** Рельеф в кадре ровнее этого — крен, FOV и наклон не определить */
const MIN_RELIEF_DEG = 0.8;
/** Порог «совпало»: не точнее 4 px и не точнее 0.5 % ширины кадра */
const INLIER_PX = 4;
const INLIER_W = 0.005;

// ---- Геометрия --------------------------------------------------------------

interface Scene {
  w: number;
  h: number;
  /** Точки относительно центра кадра, px (y вниз) */
  xc: Float64Array;
  yc: Float64Array;
  wt: Float64Array;
  n: number;
  dem: Float64Array;
  nDem: number;
  step: number;
  /** 1 / дистанция до точки силуэта по лучам, 1/м; null — дистанций нет */
  invDist: Float64Array | null;
}

function buildScene(options: PhotoFitOptions, indices: number[]): Scene {
  const { points, width, height } = options;
  const n = indices.length;
  const xc = new Float64Array(n);
  const yc = new Float64Array(n);
  const wt = new Float64Array(n);
  indices.forEach((i, k) => {
    xc[k] = points.x[i] - width / 2;
    yc[k] = points.y[i] - height / 2;
    wt[k] = points.w[i];
  });
  const dem = new Float64Array(options.horizon.length);
  for (let i = 0; i < dem.length; i++) dem[i] = options.horizon[i];
  let invDist: Float64Array | null = null;
  const dist = options.distanceM;
  if (dist && dist.length === dem.length) {
    invDist = new Float64Array(dist.length);
    for (let i = 0; i < dist.length; i++) {
      // Ближе 300 м или без дистанции: сдвиг высоты не моделируется (1/d взрывается)
      invDist[i] = dist[i] > HEIGHT_MIN_DIST_M ? 1 / dist[i] : 0;
    }
  }
  return {
    w: width,
    h: height,
    xc,
    yc,
    wt,
    n,
    dem,
    nDem: dem.length,
    step: options.stepRad,
    invDist,
  };
}

/**
 * Сдвиг высоты наблюдателя на dhM метров опускает видимый угол точки
 * силуэта на dh/дистанция. Вместо пересчёта DEM поднимаем на ту же величину
 * лучи фото: расстояние до силуэта то же.
 */
function applyHeightShift(
  s: Scene,
  az: Float64Array,
  el: Float64Array,
  dhM: number,
): void {
  const inv = s.invDist;
  if (!inv || dhM === 0) return;
  const n = s.nDem;
  for (let j = 0; j < s.n; j++) {
    const k = ((Math.round(az[j] / s.step) % n) + n) % n;
    el[j] += dhM * inv[k];
  }
}

/** Равномерная выборка индексов точек линии */
function pickIndices(count: number, max: number): number[] {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(Math.floor(((k + 0.5) * count) / max));
  return out;
}

/**
 * Пиксели → лучи (азимут, возвышение) при позе камеры. Точное обращение
 * createPinholeProjection (λ = 0) с креном как поворотом картинной плоскости
 * вокруг центра кадра — тот же, что делает rotateAroundCenter у оверлея.
 */
function mapPoints(
  s: Scene,
  pose: CameraPose,
  outAz: Float64Array,
  outEl: Float64Array,
): void {
  const f = s.w / 2 / Math.tan(pose.fovHRad / 2);
  const cosR = Math.cos(pose.rollRad);
  const sinR = Math.sin(pose.rollRad);
  const cosC = Math.cos(pose.elevRad);
  const sinC = Math.sin(pose.elevRad);
  for (let j = 0; j < s.n; j++) {
    const mx = cosR * s.xc[j] + sinR * s.yc[j];
    const my = -sinR * s.xc[j] + cosR * s.yc[j];
    const ux = mx / f;
    const uy = -my / f;
    const dy = cosC * uy + sinC;
    const dz = -sinC * uy + cosC;
    outAz[j] = pose.azRad + Math.atan2(ux, dz);
    outEl[j] = Math.atan2(dy, Math.sqrt(ux * ux + dz * dz));
  }
}

/** Силуэт DEM в азимуте a с линейной интерполяцией; NaN — рельефа нет */
function demAt(s: Scene, a: number): number {
  const idx = a / s.step;
  const i0 = Math.floor(idx);
  const f = idx - i0;
  const n = s.nDem;
  const k0 = ((i0 % n) + n) % n;
  const k1 = k0 + 1 === n ? 0 : k0 + 1;
  const e0 = s.dem[k0];
  const e1 = s.dem[k1];
  if (!(e0 > -1e8) || !(e1 > -1e8)) return NaN;
  return e0 + (e1 - e0) * f;
}

/**
 * Квадрат расстояния от луча (az, el) до ломаной силуэта в локально
 * равноугловых координатах (азимут × cos el), насыщенный на τ².
 */
function chamferSq(s: Scene, az: number, el: number, tau: number): number {
  const wx = Math.cos(el);
  const idx = az / s.step;
  const i0 = Math.floor(idx);
  const reach = Math.min(60, Math.ceil(tau / (s.step * Math.max(wx, 0.2))) + 1);
  const n = s.nDem;
  let best = tau * tau;
  let havePrev = false;
  let px = 0;
  let py = 0;
  for (let k = i0 - reach; k <= i0 + reach + 1; k++) {
    const e = s.dem[((k % n) + n) % n];
    if (!(e > -1e8)) {
      havePrev = false;
      continue;
    }
    const qx = (k - idx) * s.step * wx;
    const qy = e - el;
    if (havePrev) {
      const dx = qx - px;
      const dy = qy - py;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? -(px * dx + py * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = px + t * dx;
      const cy = py + t * dy;
      const d2 = cx * cx + cy * cy;
      if (d2 < best) best = d2;
    } else {
      const d2 = qx * qx + qy * qy;
      if (d2 < best) best = d2;
    }
    px = qx;
    py = qy;
    havePrev = true;
  }
  return best;
}

type Metric = "vertical" | "chamfer";

/**
 * Нормированная стоимость позы ∈ [0, 1]: средневзвешенное u/(1+u),
 * u = (d/τ)² — квадратична у нуля и насыщается на 1 (Геммана—Мак-Клюра).
 * τ задан в пикселях кадра (долей ширины) и пересчитывается в угол по
 * фокусному гипотезы.
 */
function dataCost(
  s: Scene,
  pose: CameraPose,
  tauW: number,
  metric: Metric,
  az: Float64Array,
  el: Float64Array,
  occlusion: boolean,
  dhM: number,
  tauFloorRad = 0,
): number {
  mapPoints(s, pose, az, el);
  applyHeightShift(s, az, el, dhM);
  const tau = Math.max(tauW * 2 * Math.tan(pose.fovHRad / 2), tauFloorRad);
  const tau2 = tau * tau;
  const occMax = OCC_MAX_DEG * DEG;
  let sum = 0;
  let wsum = 0;
  for (let j = 0; j < s.n; j++) {
    let d2: number;
    let dv = NaN;
    if (metric === "vertical") {
      const e = demAt(s, az[j]);
      dv = e - el[j];
      d2 = Number.isNaN(e) ? tau2 : Math.min(tau2, dv * dv);
    } else {
      d2 = chamferSq(s, az[j], el[j], tau);
      if (occlusion) dv = demAt(s, az[j]) - el[j];
    }
    const u = d2 / tau2;
    let c = u / (1 + u);
    // Линия на фото ниже силуэта DEM — гору мог закрыть облак: такая
    // колонка стоит OCC_COST, но не 1 и не 0 (хуже настоящего совпадения)
    if (occlusion && dv > 0 && dv < occMax && c > OCC_COST) c = OCC_COST;
    sum += s.wt[j] * c;
    wsum += s.wt[j];
  }
  return wsum > 0 ? sum / wsum : 1;
}

// ---- Параметризация и приоры ------------------------------------------------

interface FitContext {
  prior: CameraPose;
  lnFovMin: number;
  lnFovMax: number;
  fovKnown: boolean;
  /** Учитывать, что линия на фото ниже силуэта могла быть закрыта облаком */
  occlusion: boolean;
  /** Есть дистанции до силуэта: высоту наблюдателя можно подгонять */
  heightFree: boolean;
  /**
   * Нижняя граница допуска τ, рад: ошибка DEM угловая, а допуск в долях
   * ширины кадра при телеобъективе сжимается в доли градуса (0 — без пола)
   */
  tauFloorRad: number;
  /** Азимутальное окно поиска (подсказка пользователя); null — весь круг */
  azWindow: { centerRad: number; halfRad: number } | null;
}

function poseFromVector(v: number[]): CameraPose {
  return {
    azRad: v[0] * DEG,
    elevRad: v[1] * DEG,
    rollRad: v[2] * DEG,
    fovHRad: Math.exp(v[3]),
  };
}

function vectorFromPose(p: CameraPose, dhM = 0): number[] {
  return [
    p.azRad / DEG,
    p.elevRad / DEG,
    p.rollRad / DEG,
    Math.log(p.fovHRad),
    dhM / HEIGHT_UNIT_M,
  ];
}

function priorCost(ctx: FitContext, pose: CameraPose, dhM: number): number {
  const rollDeg = pose.rollRad / DEG;
  const tiltDeg = pose.elevRad / DEG;
  let c =
    PRIOR_ROLL_WEIGHT * (rollDeg / PRIOR_ROLL_SIGMA_DEG) ** 2 +
    PRIOR_TILT_WEIGHT * (tiltDeg / PRIOR_TILT_SIGMA_DEG) ** 2 +
    PRIOR_HEIGHT_WEIGHT * (dhM / PRIOR_HEIGHT_SIGMA_M) ** 2;
  if (ctx.fovKnown) {
    const dl = Math.log(pose.fovHRad / ctx.prior.fovHRad);
    c += PRIOR_FOV_WEIGHT * (dl / PRIOR_FOV_SIGMA) ** 2;
  }
  return c;
}

// ---- Нелдер—Мид -------------------------------------------------------------

interface NmResult {
  x: number[];
  fx: number;
}

/** Нелдер—Мид по свободным координатам (остальные остаются как в x0) */
function nelderMead(
  fn: (v: number[]) => number,
  x0: number[],
  steps: number[],
  free: boolean[],
  maxEvals: number,
): NmResult {
  const idx = free.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
  const dim = idx.length;
  const expand = (reduced: number[]): number[] => {
    const full = x0.slice();
    idx.forEach((gi, k) => {
      full[gi] = reduced[k];
    });
    return full;
  };
  let evals = 0;
  const evalReduced = (r: number[]): number => {
    evals++;
    return fn(expand(r));
  };
  const simplex: number[][] = [idx.map((gi) => x0[gi])];
  for (let k = 0; k < dim; k++) {
    const p = simplex[0].slice();
    p[k] += steps[idx[k]];
    simplex.push(p);
  }
  const values = simplex.map(evalReduced);
  const sortSimplex = (): void => {
    const perm = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    const s2 = perm.map((i) => simplex[i]);
    const v2 = perm.map((i) => values[i]);
    for (let i = 0; i < s2.length; i++) {
      simplex[i] = s2[i];
      values[i] = v2[i];
    }
  };
  sortSimplex();
  while (evals < maxEvals) {
    let size = 0;
    for (let i = 1; i <= dim; i++) {
      for (let k = 0; k < dim; k++) {
        size = Math.max(
          size,
          Math.abs(simplex[i][k] - simplex[0][k]) / steps[idx[k]],
        );
      }
    }
    if (size < 0.02) break;
    const centroid = new Array<number>(dim).fill(0);
    for (let i = 0; i < dim; i++) {
      for (let k = 0; k < dim; k++) centroid[k] += simplex[i][k] / dim;
    }
    const worst = simplex[dim];
    const reflect = centroid.map((c, k) => c + (c - worst[k]));
    const fr = evalReduced(reflect);
    if (fr < values[0]) {
      const grown = centroid.map((c, k) => c + 2 * (c - worst[k]));
      const fe = evalReduced(grown);
      simplex[dim] = fe < fr ? grown : reflect;
      values[dim] = Math.min(fe, fr);
    } else if (fr < values[dim - 1]) {
      simplex[dim] = reflect;
      values[dim] = fr;
    } else {
      const outside = fr < values[dim];
      const contracted = centroid.map(
        (c, k) => c + (outside ? 0.5 : -0.5) * (c - worst[k]),
      );
      const fc = evalReduced(contracted);
      if (fc < (outside ? fr : values[dim])) {
        simplex[dim] = contracted;
        values[dim] = fc;
      } else {
        for (let i = 1; i <= dim; i++) {
          simplex[i] = simplex[i].map(
            (v, k) => simplex[0][k] + 0.5 * (v - simplex[0][k]),
          );
          values[i] = evalReduced(simplex[i]);
        }
      }
    }
    sortSimplex();
  }
  return { x: expand(simplex[0]), fx: values[0] };
}

// ---- Глобальный поиск -------------------------------------------------------

interface Seed {
  pose: CameraPose;
  coarseCost: number;
}

function fovGrid(options: PhotoFitOptions, ctx: FitContext): number[] {
  if (ctx.fovKnown) {
    const tanHalf = Math.tan(ctx.prior.fovHRad / 2);
    return [0.96, 1, 1.04].map((m) => 2 * Math.atan(tanHalf * m));
  }
  const out: number[] = [];
  for (
    let d = FOV_GRID_LONG_MIN_DEG;
    d <= FOV_LONG_MAX_DEG + 1e-9;
    d *= FOV_GRID_RATIO
  ) {
    out.push(fovForFrame(d * DEG, options.width, options.height).h);
  }
  return out;
}

/**
 * Круг азимутов × гипотезы (FOV, наклон): затравки по лучшим минимумам.
 *
 * Крен в глобальном поиске — три гипотезы (0, ±2.5°), точное значение
 * находит доводка. Наклон внутри шага сетки приближённо заменён
 * вертикальным сдвигом линии — на поиск это влияет в пределах допуска,
 * зато азимутальная развёртка не умножается на мелкую сетку наклонов.
 */
async function globalSeeds(
  options: PhotoFitOptions,
  ctx: FitContext,
  coarse: Scene,
): Promise<Seed[]> {
  const az = new Float64Array(coarse.n);
  const el = new Float64Array(coarse.n);
  const k0 = new Int32Array(coarse.n);
  const frac = new Float64Array(coarse.n);
  // Азимут шага сетки кратен шагу лучей — доля индекса при сдвиге на yaw не
  // меняется, и интерполяция сводится к целочисленному смещению. Массив
  // удвоен: смещение < n не требует взятия по модулю в горячем цикле.
  const demN = coarse.nDem;
  const yawSteps = Math.max(1, Math.round((YAW_STEP_DEG * DEG) / coarse.step));
  const yawN = Math.floor(demN / yawSteps);
  const demX = new Float64Array(2 * demN + 1);
  for (let k = 0; k < demX.length; k++) {
    const v = coarse.dem[k % demN];
    demX[k] = v > -1e8 ? v : NaN;
  }
  let wTotal = 0;
  for (let j = 0; j < coarse.n; j++) wTotal += coarse.wt[j];
  const fovs = fovGrid(options, ctx);
  // Лучшая оценка на каждую пару (FOV, азимут): без разделения по FOV
  // ложный широкоугольный минимум подавлял соседний верный
  const bestCost = new Float64Array(fovs.length * yawN).fill(Infinity);
  const bestPose: (CameraPose | null)[] = new Array(fovs.length * yawN).fill(
    null,
  );
  const tilts: number[] = [];
  for (let t = TILT_MIN_DEG; t <= TILT_MAX_DEG + 1e-9; t += TILT_STEP_DEG) {
    tilts.push(t);
  }
  const deltas = TILT_SUBSTEPS_DEG.map((d) => d * DEG);
  // Развёрнутый цикл рассчитан ровно на три сдвига наклона
  const [delta0, delta1, delta2] = deltas;
  const occ = ctx.occlusion;
  const win = ctx.azWindow;
  const occMax = OCC_MAX_DEG * DEG;
  for (let fi = 0; fi < fovs.length; fi++) {
    const fov = fovs[fi];
    // Допуск — в пикселях кадра, поэтому в углах он зависит от FOV гипотезы
    const tau = Math.max(COARSE_TAU_W * 2 * Math.tan(fov / 2), ctx.tauFloorRad);
    const tau2 = tau * tau;
    const base = fi * yawN;
    for (const rollDeg of ROLL_COARSE_DEG) {
      for (const tiltDeg of tilts) {
        const pose: CameraPose = {
          azRad: 0,
          elevRad: tiltDeg * DEG,
          rollRad: ctx.prior.rollRad + rollDeg * DEG,
          fovHRad: fov,
        };
        mapPoints(coarse, pose, az, el);
        for (let j = 0; j < coarse.n; j++) {
          const idx = az[j] / coarse.step;
          const i0 = Math.floor(idx);
          frac[j] = idx - i0;
          k0[j] = ((i0 % demN) + demN) % demN;
        }
        for (let yi = 0; yi < yawN; yi++) {
          const off = yi * yawSteps;
          if (win && azDiff(off * coarse.step, win.centerRad) > win.halfRad) {
            continue;
          }
          // Три сдвига наклона за один проход по точкам; досрочный выход,
          // когда частичные суммы всех трёх уже не побьют лучшую оценку
          // этого азимута (стоимости неотрицательны — итог не изменится)
          const bi = base + yi;
          const limit = bestCost[bi] * wTotal * PRUNE_SLACK;
          let s0 = 0;
          let s1 = 0;
          let s2 = 0;
          let j = 0;
          const n = coarse.n;
          for (; j < n; j++) {
            const a = demX[k0[j] + off];
            const b = demX[k0[j] + off + 1];
            const r = a + (b - a) * frac[j] - el[j];
            const w = coarse.wt[j];
            // NaN (нет рельефа) не проходит сравнение — получает полный штраф
            let dv = r - delta0;
            let d2 = dv * dv < tau2 ? dv * dv : tau2;
            let u = d2 / tau2;
            let c1 = u / (1 + u);
            if (occ && dv > 0 && dv < occMax && c1 > OCC_COST) c1 = OCC_COST;
            s0 += w * c1;
            dv = r - delta1;
            d2 = dv * dv < tau2 ? dv * dv : tau2;
            u = d2 / tau2;
            c1 = u / (1 + u);
            if (occ && dv > 0 && dv < occMax && c1 > OCC_COST) c1 = OCC_COST;
            s1 += w * c1;
            dv = r - delta2;
            d2 = dv * dv < tau2 ? dv * dv : tau2;
            u = d2 / tau2;
            c1 = u / (1 + u);
            if (occ && dv > 0 && dv < occMax && c1 > OCC_COST) c1 = OCC_COST;
            s2 += w * c1;
            if ((j & 7) === 7 && s0 > limit && s1 > limit && s2 > limit) {
              break;
            }
          }
          if (j < n) continue; // ни один сдвиг не побьёт лучшую оценку
          for (let di = 0; di < 3; di++) {
            const c = (di === 0 ? s0 : di === 1 ? s1 : s2) / wTotal;
            if (c < bestCost[bi]) {
              bestCost[bi] = c;
              bestPose[bi] = {
                ...pose,
                azRad: off * coarse.step,
                elevRad: pose.elevRad + deltas[di],
              };
            }
          }
        }
      }
    }
    options.onProgress?.(0.05 + 0.3 * ((fi + 1) / fovs.length));
    await options.yieldToUi?.();
  }
  // Для каждого FOV — несколько лучших азимутальных минимумов с подавлением
  // соседей по кругу
  const nmsCells = Math.round(SEED_NMS_DEG / YAW_STEP_DEG);
  const seeds: Seed[] = [];
  for (let fi = 0; fi < fovs.length; fi++) {
    const base = fi * yawN;
    const order = Array.from({ length: yawN }, (_, i) => i).sort(
      (a, b) => bestCost[base + a] - bestCost[base + b],
    );
    const picked: number[] = [];
    for (const yi of order) {
      if (!Number.isFinite(bestCost[base + yi])) break;
      const near = picked.some((p) => {
        const d = Math.abs(p - yi);
        return Math.min(d, yawN - d) <= nmsCells;
      });
      if (!near) picked.push(yi);
      if (picked.length >= SEEDS_PER_FOV) break;
    }
    for (const yi of picked) {
      const pose = bestPose[base + yi];
      if (pose) seeds.push({ pose, coarseCost: bestCost[base + yi] });
    }
  }
  // Азимут приора, если он надёжен, всегда получает затравку
  if (options.azKnown) {
    const cell = YAW_STEP_DEG * DEG;
    const pyi =
      Math.round((((ctx.prior.azRad % TWO_PI) + TWO_PI) % TWO_PI) / cell) %
      yawN;
    let bestIdx = -1;
    for (let fi = 0; fi < fovs.length; fi++) {
      for (let d = -20; d <= 20; d++) {
        const idx = fi * yawN + ((((pyi + d) % yawN) + yawN) % yawN);
        if (bestIdx < 0 || bestCost[idx] < bestCost[bestIdx]) bestIdx = idx;
      }
    }
    const pose = bestIdx >= 0 ? bestPose[bestIdx] : null;
    if (pose) seeds.push({ pose, coarseCost: bestCost[bestIdx] });
  }
  return seeds;
}

// ---- Доводка ----------------------------------------------------------------

interface Refined {
  pose: CameraPose;
  cost: number;
  /** Сдвиг высоты наблюдателя относительно высоты панорамы, м */
  dhM: number;
}

function refine(
  ctx: FitContext,
  fine: Scene,
  seed: CameraPose,
  stagesW: number[],
  freeFov: boolean,
  dh0 = 0,
  freeHeight = ctx.heightFree,
): Refined {
  const az = new Float64Array(fine.n);
  const el = new Float64Array(fine.n);
  let x = vectorFromPose(seed, dh0);
  let cost = Infinity;
  const free = [true, true, true, freeFov, freeHeight];
  const dhMax = HEIGHT_MAX_M / HEIGHT_UNIT_M;
  for (const stageW of stagesW) {
    const metric: Metric = stageW >= TAU_STAGES_W[2] ? "vertical" : "chamfer";
    const fn = (v: number[]): number => {
      if (v[3] < ctx.lnFovMin || v[3] > ctx.lnFovMax) return 1e3;
      if (Math.abs(v[4]) > dhMax) return 1e3;
      const pose = poseFromVector(v);
      const dhM = v[4] * HEIGHT_UNIT_M;
      const data = dataCost(
        fine,
        pose,
        stageW,
        metric,
        az,
        el,
        ctx.occlusion,
        dhM,
        ctx.tauFloorRad,
      );
      return data + priorCost(ctx, pose, dhM);
    };
    // Шаги симплекса ~ ширина бассейна: τ в пикселях → в угол по текущему FOV
    const tauDeg = (stageW * 2 * Math.tan(Math.exp(x[3]) / 2)) / DEG;
    const steps = [
      1.5 * tauDeg,
      1.5 * tauDeg,
      (1.5 * stageW) / DEG,
      3 * stageW,
      Math.max(0.2, 15 * stageW),
    ];
    // Повторный запуск с новым симплексом выводит из ложной остановки
    // Нелдера—Мида в узкой долине (FOV ↔ азимут ↔ наклон)
    for (let rep = 0; rep < NM_RESTARTS; rep++) {
      const res = nelderMead(fn, x, steps, free, NM_MAX_EVALS);
      x = res.x;
      cost = res.fx;
    }
  }
  return { pose: poseFromVector(x), cost, dhM: x[4] * HEIGHT_UNIT_M };
}

// ---- Метрики ----------------------------------------------------------------

function fitMetrics(
  s: Scene,
  pose: CameraPose,
  dhM: number,
  tolW = INLIER_W,
  tolMinRad = 0,
  relaxRelief: StrongLevel = 0,
): {
  inlierFrac: number;
  occludedFrac: number;
  rmsPx: number;
  coverage: number;
  runFrac: number;
  runReliefDeg: number;
  /** Участок прошёл условия «сильного»: длинный, не прямой, с рельефом */
  runStrong: boolean;
} {
  const az = new Float64Array(s.n);
  const el = new Float64Array(s.n);
  mapPoints(s, pose, az, el);
  applyHeightShift(s, az, el, dhM);
  const f = s.w / 2 / Math.tan(pose.fovHRad / 2);
  const thr = Math.max(INLIER_PX / f, (tolW * s.w) / f, tolMinRad);
  const occMax = OCC_MAX_DEG * DEG;
  let inl = 0;
  let sq = 0;
  const xs: number[] = [];
  const isInlier = new Uint8Array(s.n);
  // «Закрыто»: не совпало, но линия ниже силуэта; считается только если
  // таких точек подряд не меньше OCC_MIN_RUN — облако закрывает участок,
  // а не разбросанные колонки
  const occluded = new Uint8Array(s.n);
  for (let j = 0; j < s.n; j++) {
    const d2 = chamferSq(s, az[j], el[j], thr * 1.5);
    if (d2 <= thr * thr) {
      inl++;
      sq += d2;
      xs.push(s.xc[j]);
      isInlier[j] = 1;
      continue;
    }
    const dv = demAt(s, az[j]) - el[j];
    if (dv > thr && dv < occMax) occluded[j] = 1;
  }
  const minRun = Math.max(
    OCC_MIN_RUN_POINTS,
    Math.round(OCC_MIN_RUN_FRAC * s.n),
  );
  let occ = 0;
  for (let j = 0; j < s.n;) {
    if (!occluded[j]) {
      j++;
      continue;
    }
    let k = j;
    while (k < s.n && occluded[k]) k++;
    if (k - j >= minRun) occ += k - j;
    j = k;
  }
  xs.sort((a, b) => a - b);
  const lo = xs.length ? xs[Math.floor(0.05 * (xs.length - 1))] : 0;
  const hi = xs.length ? xs[Math.ceil(0.95 * (xs.length - 1))] : 0;
  const run = longestRun(s, isInlier, el, f, relaxRelief);
  return {
    inlierFrac: s.n ? inl / s.n : 0,
    occludedFrac: s.n ? occ / s.n : 0,
    rmsPx: inl ? Math.sqrt(sq / inl) * f : Infinity,
    coverage: (hi - lo) / s.w,
    ...run,
  };
}

/**
 * Самый протяжённый непрерывный участок совпавших точек (допускает короткие
 * выпадения: человек, дерево) с его размахом высоты и отклонением от прямой.
 */
function longestRun(
  s: Scene,
  isInlier: Uint8Array,
  el: Float64Array,
  f: number,
  relaxRelief: StrongLevel,
): { runFrac: number; runReliefDeg: number; runStrong: boolean } {
  const gap = Math.max(2, Math.round(RUN_GAP_FRAC * s.n));
  const vfovDeg = (2 * Math.atan(s.h / 2 / f)) / DEG;
  // Относительные пороги — только при известном фокусном: при слепом FOV
  // гладкую линию можно растянуть на узкий кадр и выдать за рельеф
  const minReliefFrac =
    relaxRelief === 3
      ? RUN_ALT_MIN_RELIEF_FRAC
      : relaxRelief === 2
        ? RUN_HINT_MIN_RELIEF_FRAC
        : RUN_MIN_RELIEF_FRAC;
  const minReliefDeg =
    relaxRelief === 0
      ? RUN_MIN_RELIEF_DEG
      : Math.min(RUN_MIN_RELIEF_DEG, minReliefFrac * vfovDeg);
  const minWidthFrac =
    relaxRelief === 3
      ? RUN_ALT_MIN_WIDTH_FRAC
      : relaxRelief === 2
        ? RUN_HINT_MIN_WIDTH_FRAC
        : RUN_MIN_WIDTH_FRAC;
  let best = { widthFrac: 0, reliefDeg: 0, strong: false };
  const close = (first: number, last: number): void => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let j = first; j <= last; j++) {
      if (!isInlier[j]) continue;
      n++;
      sx += s.xc[j];
      sy += el[j];
    }
    const widthFrac = (s.xc[last] - s.xc[first]) / s.w;
    if (n < (last - first + 1) * RUN_MIN_DENSITY) return;
    const mx = sx / n;
    const my = sy / n;
    let sxx = 0;
    let sxy = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = first; j <= last; j++) {
      if (!isInlier[j]) continue;
      sxx += (s.xc[j] - mx) ** 2;
      sxy += (s.xc[j] - mx) * (el[j] - my);
      lo = Math.min(lo, el[j]);
      hi = Math.max(hi, el[j]);
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    let res = 0;
    for (let j = first; j <= last; j++) {
      if (!isInlier[j]) continue;
      res += (el[j] - my - slope * (s.xc[j] - mx)) ** 2;
    }
    const curvePx = Math.sqrt(res / n) * f;
    const reliefDeg = (hi - lo) / DEG;
    const strong =
      widthFrac >= minWidthFrac &&
      reliefDeg >= minReliefDeg &&
      curvePx >= RUN_MIN_CURVE_FRAC * s.w;
    // Сильный участок важнее длинного, но прямого
    if (
      (strong && !best.strong) ||
      (strong === best.strong && widthFrac > best.widthFrac)
    ) {
      best = { widthFrac, reliefDeg, strong };
    }
  };
  let first = -1;
  let last = -1;
  for (let j = 0; j < s.n; j++) {
    if (!isInlier[j]) continue;
    if (first >= 0 && j - last > gap) {
      close(first, last);
      first = -1;
    }
    if (first < 0) first = j;
    last = j;
  }
  if (first >= 0) close(first, last);
  return {
    runFrac: best.widthFrac,
    runReliefDeg: best.reliefDeg,
    runStrong: best.strong,
  };
}

/** Размах силуэта DEM под линией неба кадра: есть ли чем определять крен/FOV */
function reliefInView(s: Scene, pose: CameraPose): number {
  const az = new Float64Array(s.n);
  const el = new Float64Array(s.n);
  mapPoints(s, pose, az, el);
  const vals: number[] = [];
  for (let j = 0; j < s.n; j++) {
    const e = demAt(s, az[j]);
    if (!Number.isNaN(e)) vals.push(e);
  }
  if (vals.length < 4) return 0;
  vals.sort((a, b) => a - b);
  const hi = vals[Math.ceil(0.95 * (vals.length - 1))];
  const lo = vals[Math.floor(0.05 * (vals.length - 1))];
  return (hi - lo) / DEG;
}

const EMPTY_DIAG: PhotoFitDiagnostics = {
  inlierFrac: 0,
  occludedFrac: 0,
  rmsPx: Infinity,
  coverage: 0,
  uniqueness: 0,
  cost: 1,
  fovObservable: false,
  seeds: 0,
};

function fail(
  reason: PhotoFitFailure,
  pose: CameraPose,
  diag: Partial<PhotoFitDiagnostics> = {},
): PhotoFitResult {
  return { ok: false, reason, pose, diagnostics: { ...EMPTY_DIAG, ...diag } };
}

/** Угловая разница азимутов, рад [0, π] */
function azDiff(a: number, b: number): number {
  const d = (((a - b) % TWO_PI) + TWO_PI) % TWO_PI;
  return d > Math.PI ? TWO_PI - d : d;
}

/**
 * Подгонка позы камеры по линии неба фото.
 * При отказе `pose` = приор: ничего применять не нужно.
 */
async function fitBySkyline(
  rawOptions: PhotoFitOptions,
): Promise<PhotoFitResult> {
  const options: PhotoFitOptions = rawOptions.anchors?.length
    ? {
        ...rawOptions,
        horizon: liftSilhouetteByPeaks(
          rawOptions.horizon,
          rawOptions.stepRad,
          rawOptions.anchors,
        ),
      }
    : rawOptions;
  const { points, prior } = options;
  if (points.x.length < MIN_POINTS) return fail("no-skyline", prior);
  let finiteDem = 0;
  for (const v of options.horizon) if (Number.isFinite(v)) finiteDem++;
  if (finiteDem < options.horizon.length * 0.2) {
    return fail("no-terrain", prior);
  }

  const fovKnown = options.fovKnown === true;
  const hFor = (longDeg: number): number =>
    fovForFrame(longDeg * DEG, options.width, options.height).h;
  const priorTan = Math.tan(prior.fovHRad / 2);
  const ctx: FitContext = {
    prior,
    fovKnown,
    occlusion: options.occlusion !== false,
    heightFree:
      !!options.distanceM &&
      options.distanceM.length === options.horizon.length,
    tauFloorRad: 0,
    azWindow: options.azHint ?? null,
    lnFovMin: Math.log(
      fovKnown
        ? 2 * Math.atan(priorTan * (1 - FOV_KNOWN_SPAN))
        : hFor(FOV_LONG_MIN_DEG),
    ),
    lnFovMax: Math.log(
      fovKnown
        ? 2 * Math.atan(priorTan * (1 + FOV_KNOWN_SPAN))
        : hFor(FOV_LONG_MAX_DEG),
    ),
  };

  const coarse = buildScene(
    options,
    pickIndices(points.x.length, COARSE_POINTS),
  );
  const fine = buildScene(options, pickIndices(points.x.length, FINE_POINTS));
  options.onProgress?.(0.02);

  const seeds = await globalSeeds(options, ctx, coarse);
  if (seeds.length === 0) return fail("no-terrain", prior);

  // Первая стадия — по всем затравкам, точные — по лучшим несовпадающим
  const rough: Refined[] = [];
  for (let i = 0; i < seeds.length; i++) {
    rough.push(
      refine(ctx, fine, seeds[i].pose, TAU_STAGES_W.slice(0, 3), true),
    );
    options.onProgress?.(0.35 + 0.3 * ((i + 1) / seeds.length));
    await options.yieldToUi?.();
  }
  rough.sort((a, b) => a.cost - b.cost);
  // Затравки соседних FOV сходятся в один минимум — доводим его один раз
  const keep: Refined[] = [];
  for (const r of rough) {
    const dup = keep.some(
      (k) =>
        azDiff(k.pose.azRad, r.pose.azRad) < 1.5 * DEG &&
        Math.abs(k.pose.elevRad - r.pose.elevRad) < 1.5 * DEG &&
        Math.abs(Math.log(k.pose.fovHRad / r.pose.fovHRad)) < 0.05,
    );
    if (!dup) keep.push(r);
    if (keep.length >= SEED_KEEP_PRECISE) break;
  }
  const precise: Refined[] = [];
  for (let i = 0; i < keep.length; i++) {
    precise.push(refine(ctx, fine, keep[i].pose, TAU_STAGES_W.slice(3), true));
    options.onProgress?.(0.65 + 0.25 * ((i + 1) / keep.length));
    await options.yieldToUi?.();
  }
  precise.sort((a, b) => a.cost - b.cost);
  options.onCandidates?.(precise);
  const best = precise[0];

  // Единственность: лучший конкурент из другого азимутального минимума
  const rival = precise.find(
    (r) => azDiff(r.pose.azRad, best.pose.azRad) > SEED_NMS_DEG * DEG,
  );
  let uniqueness = rival ? rival.cost / Math.max(best.cost, 1e-6) : Infinity;
  let chosen = best;
  // Азимут приора надёжен, а конкурент почти не хуже — берём ближний к приору
  if (options.azKnown && rival && uniqueness < MIN_UNIQUENESS) {
    const near = precise.filter(
      (r) =>
        r.cost <= best.cost * 1.15 &&
        azDiff(r.pose.azRad, prior.azRad) < 20 * DEG,
    );
    if (near.length) {
      chosen = near.reduce((a, b) =>
        azDiff(a.pose.azRad, prior.azRad) <= azDiff(b.pose.azRad, prior.azRad)
          ? a
          : b,
      );
      uniqueness = Infinity;
    }
  }

  // Наблюдаемость FOV: если сдвиг на ±8 % почти не портит стоимость, форма
  // линии масштаба не знает — оставляем приор и подгоняем остальное
  let pose = chosen.pose;
  let cost = chosen.cost;
  let dhM = chosen.dhM;
  let fovObservable = true;
  if (!fovKnown) {
    const tanHalf = Math.tan(pose.fovHRad / 2);
    const finalStages = TAU_STAGES_W.slice(4);
    const rises = [0.92, 1.08].map((m) => {
      const shifted: CameraPose = {
        ...pose,
        fovHRad: 2 * Math.atan(tanHalf * m),
      };
      return (
        refine(ctx, fine, shifted, finalStages, false, chosen.dhM).cost -
        chosen.cost
      );
    });
    fovObservable = Math.min(...rises) > FOV_OBSERVABLE_RISE;
    if (!fovObservable) {
      const refit = refine(
        ctx,
        fine,
        { ...pose, fovHRad: prior.fovHRad },
        finalStages,
        false,
        chosen.dhM,
      );
      pose = refit.pose;
      cost = refit.cost;
      dhM = refit.dhM;
    }
  }

  const m = fitMetrics(fine, pose, dhM);
  const diagnostics: PhotoFitDiagnostics = {
    inlierFrac: m.inlierFrac,
    occludedFrac: m.occludedFrac,
    rmsPx: m.rmsPx,
    coverage: m.coverage,
    uniqueness,
    cost,
    fovObservable,
    seeds: seeds.length,
    runFrac: m.runFrac,
    runReliefDeg: m.runReliefDeg,
  };
  options.onProgress?.(0.95);

  if (reliefInView(fine, pose) < MIN_RELIEF_DEG) {
    return fail("flat-horizon", prior, diagnostics);
  }
  const failure: PhotoFitFailure | null =
    m.inlierFrac < MIN_INLIER_FRAC || m.coverage < MIN_COVERAGE
      ? "poor-fit"
      : uniqueness < MIN_UNIQUENESS
        ? "ambiguous"
        : null;
  // Спасение: DEM врёт, а форма линии может быть сильной. При неоднозначности
  // — только если строгая подгонка объясняет меньше половины линии: иначе
  // рельеф повторяется и неоднозначность настоящая (чужие рельефы с долей
  // совпавших 0.9 спасение принимало за свои)
  if (
    failure &&
    options.rescue !== false &&
    (failure === "poor-fit" || m.inlierFrac < RESCUE_AMBIGUOUS_MAX_INLIER)
  ) {
    // Своё решение спасения обязано пройти проверки конкурента и нулевой
    // гипотезы
    const rescued = await rescueByRun(
      options,
      ctx,
      fine,
      coarse,
      precise,
      seeds.length,
    );
    if (rescued.result) return rescued.result;
    const refusal = fail(failure, prior, diagnostics);
    if (rescued.alternatives.length >= 2) {
      refusal.alternatives = rescued.alternatives;
    }
    return refusal;
  }
  if (failure) return fail(failure, prior, diagnostics);
  const approximate =
    !!options.azHint ||
    m.inlierFrac < GOOD_INLIER_FRAC ||
    uniqueness < GOOD_UNIQUENESS ||
    m.occludedFrac > GOOD_OCCLUDED_FRAC;
  return {
    ok: true,
    method: "skyline",
    quality: approximate ? "approximate" : "good",
    observerDeltaM: dhM,
    pose,
    diagnostics,
  };
}

/**
 * Лучший сильный участок на «чужих» азимутах той же позы: сдвиги азимута
 * на 20°…340° и наклона на ±6° (наклон в поиске свободный, и честная
 * нулевая гипотеза обязана его подстраивать).
 */
function nullRunScore(
  fine: Scene,
  pose: CameraPose,
  dhM: number,
  relaxRelief: StrongLevel,
): number {
  let best = 0;
  for (
    let shift = NULL_AZ_STEP_DEG;
    shift < 360 - 1e-6;
    shift += NULL_AZ_STEP_DEG
  ) {
    for (const dTilt of NULL_TILT_DEG) {
      const m = fitMetrics(
        fine,
        {
          ...pose,
          azRad: pose.azRad + shift * DEG_TO_RAD,
          elevRad: pose.elevRad + dTilt * DEG_TO_RAD,
        },
        dhM,
        RESCUE_TOL_W,
        RESCUE_TOL_MIN_DEG * DEG_TO_RAD,
        relaxRelief,
      );
      if (m.runStrong) best = Math.max(best, m.runFrac * m.runReliefDeg);
    }
  }
  return best;
}

/**
 * Спасение по сильному участку (см. RESCUE_*): null — доверия нет.
 * Всегда «приблизительно»: полной доли совпавших здесь нет по определению.
 */
async function rescueByRun(
  options: PhotoFitOptions,
  ctx: FitContext,
  fine: Scene,
  coarse: Scene,
  precise: Refined[],
  seedCount: number,
): Promise<RescueOutcome> {
  const prior = options.prior;
  const priorTan = Math.tan(prior.fovHRad / 2);
  // Строгость «сильного участка»: см. StrongLevel
  const level: StrongLevel = !ctx.fovKnown ? 0 : ctx.azWindow ? 2 : 1;
  const loose: FitContext = {
    ...ctx,
    occlusion: false,
    tauFloorRad: RESCUE_TOL_MIN_DEG * DEG_TO_RAD,
    lnFovMin: ctx.fovKnown
      ? Math.log(2 * Math.atan(priorTan * (1 - RESCUE_FOV_SPAN)))
      : ctx.lnFovMin,
    lnFovMax: Math.min(
      Math.log(
        (ctx.fovKnown ? RESCUE_MAX_HFOV_DEG : RESCUE_BLIND_MAX_HFOV_DEG) *
          DEG_TO_RAD,
      ),
      ctx.fovKnown
        ? Math.log(2 * Math.atan(priorTan * (1 + RESCUE_FOV_SPAN)))
        : ctx.lnFovMax,
    ),
  };
  // Собственный глобальный проход с угловым полом допуска: строгий поиск
  // истинную позу при ошибке DEM ~1° в кандидаты не пускает
  const looseSeeds = (await globalSeeds(options, loose, coarse)).sort(
    (a, b) => a.coarseCost - b.coarseCost,
  );
  const starts: CameraPose[] = [];
  for (const s of [...looseSeeds, ...precise.slice(0, 3)]) {
    const pose = "pose" in s ? s.pose : s;
    const dup = starts.some(
      (p) =>
        azDiff(p.azRad, pose.azRad) < SEED_NMS_DEG * DEG_TO_RAD &&
        Math.abs(Math.log(p.fovHRad / pose.fovHRad)) < 0.1,
    );
    if (!dup) starts.push(pose);
    if (starts.length >= RESCUE_CANDIDATES) break;
  }
  const scored: {
    r: Refined;
    m: ReturnType<typeof fitMetrics>;
    score: number;
  }[] = [];
  for (const start of starts) {
    // Затравка за пределом коридора спасения: симплекс стартовал бы в запретной зоне
    const seed: CameraPose = {
      ...start,
      fovHRad: Math.min(
        Math.max(start.fovHRad, Math.exp(loose.lnFovMin)),
        Math.exp(loose.lnFovMax),
      ),
    };
    const r = refine(loose, fine, seed, RESCUE_STAGES_W, true, 0);
    const m = fitMetrics(
      fine,
      r.pose,
      r.dhM,
      RESCUE_TOL_W,
      RESCUE_TOL_MIN_DEG * DEG_TO_RAD,
      level,
    );
    const score = m.runStrong ? m.runFrac * m.runReliefDeg : 0;
    scored.push({ r, m, score });
    await options.yieldToUi?.();
  }
  scored.sort((a, b) => b.score - a.score);
  // Правдоподобные позы в разных направлениях — для вызывающего, если ответ
  // однозначным не окажется. Строгость «сильного участка» — уровень 2 (участок
  // ≥ 0.3 ширины): человек в кадре рвёт линию, а выбирает потом пользователь
  const alternatives = (): PhotoAlternative[] => {
    if (!ctx.fovKnown) return [];
    const picks: { alt: PhotoAlternative; rank: number }[] = [];
    for (const s of scored) {
      const lnF = Math.log(s.r.pose.fovHRad);
      if (
        lnF - loose.lnFovMin < RESCUE_FOV_EDGE_LN ||
        loose.lnFovMax - lnF < RESCUE_FOV_EDGE_LN
      ) {
        continue;
      }
      const m2 = fitMetrics(
        fine,
        s.r.pose,
        s.r.dhM,
        RESCUE_TOL_W,
        RESCUE_TOL_MIN_DEG * DEG_TO_RAD,
        3,
      );
      if (!m2.runStrong || m2.inlierFrac < ALT_MIN_INLIER) continue;
      if (reliefInView(fine, s.r.pose) < MIN_RELIEF_DEG) continue;
      // Снимки редко делают с большим наклоном: мягкий приор против −5…−8°
      const tiltDeg = s.r.pose.elevRad / DEG;
      const plausibility = Math.exp(-0.5 * (tiltDeg / ALT_TILT_SIGMA_DEG) ** 2);
      picks.push({
        alt: {
          pose: s.r.pose,
          observerDeltaM: s.r.dhM,
          inlierFrac: m2.inlierFrac,
        },
        rank: m2.inlierFrac * plausibility,
      });
    }
    picks.sort((a, b) => b.rank - a.rank);
    const out: PhotoAlternative[] = [];
    for (const p of picks) {
      if (
        out.every(
          (o) =>
            azDiff(o.pose.azRad, p.alt.pose.azRad) > ALT_MIN_AZ_GAP_DEG * DEG,
        )
      ) {
        out.push(p.alt);
      }
      if (out.length >= ALT_MAX) break;
    }
    return out;
  };
  const refuse = (withAlternatives: boolean): RescueOutcome => ({
    result: null,
    alternatives: withAlternatives ? alternatives() : [],
  });
  const best = scored[0];
  if (!best || best.score <= 0) return refuse(true);
  // Решение, упёршееся в границу FOV, — подгонка под шум (гладкую линию
  // можно растянуть на любой рельеф)
  const lnFov = Math.log(best.r.pose.fovHRad);
  if (
    lnFov - loose.lnFovMin < RESCUE_FOV_EDGE_LN ||
    loose.lnFovMax - lnFov < RESCUE_FOV_EDGE_LN
  ) {
    return refuse(false);
  }
  const rival = scored.find(
    (s) => azDiff(s.r.pose.azRad, best.r.pose.azRad) > SEED_NMS_DEG * DEG,
  );
  if (rival && best.score < RUN_MIN_UNIQUENESS * rival.score) {
    return refuse(true);
  }
  // Другое направление объясняет линию не хуже (доля совпавших) — по форме
  // силуэта выбрать нельзя, и «сильный участок» у победителя мог перевесить
  // на пороге. Честнее отказать, чем показать случайное из подходящих
  const rivalSupport = scored.some(
    (s) =>
      azDiff(s.r.pose.azRad, best.r.pose.azRad) > SEED_NMS_DEG * DEG &&
      s.m.inlierFrac >= RESCUE_RIVAL_INLIER_RATIO * best.m.inlierFrac,
  );
  if (rivalSupport) return refuse(true);
  // Нулевая гипотеза: тот же участок на чужих азимутах (с подстройкой
  // наклона) не должен совпадать так же. Широкий допуск без этой проверки
  // принимает любую гладкую линию за гребень
  const nullScore = nullRunScore(fine, best.r.pose, best.r.dhM, level);
  if (best.score < RESCUE_NULL_RATIO * nullScore) return refuse(false);
  if (reliefInView(fine, best.r.pose) < MIN_RELIEF_DEG) return refuse(false);
  return {
    alternatives: [],
    result: {
      ok: true,
      method: "skyline",
      quality: "approximate",
      observerDeltaM: best.r.dhM,
      pose: best.r.pose,
      diagnostics: {
        inlierFrac: best.m.inlierFrac,
        occludedFrac: best.m.occludedFrac,
        rmsPx: best.m.rmsPx,
        coverage: best.m.coverage,
        uniqueness: rival ? best.score / Math.max(rival.score, 1e-6) : Infinity,
        cost: best.r.cost,
        fovObservable: true,
        seeds: seedCount,
        runFrac: best.m.runFrac,
        runReliefDeg: best.m.runReliefDeg,
      },
    },
  };
}

/**
 * Калибровка камеры по линии неба на кадре. При отказе `pose` = приор:
 * ничего применять не нужно.
 */
export async function fitPhotoCamera(
  options: PhotoFitOptions,
): Promise<PhotoFitResult> {
  return fitBySkyline(options);
}
