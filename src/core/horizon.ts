/**
 * Ray-marching горизонта (ALGORITHMS.md §1–2).
 * Чистые функции без I/O — DEM передаётся как синхронный сэмплер,
 * поэтому код одинаково работает в Web Worker и в тестах.
 */

import {
    azimuthRad,
    distanceM,
    EARTH_RADIUS_M,
    earthDrop,
    elevationAngleRad,
    makeRayMarcher,
    type LatLon,
} from "./geo";
import type { Peak } from "./peaks";
import { PEAK_VISIBILITY_RADIUS_M, peakScore } from "./peaks";
import { zoomForDistance } from "./terrarium";

/** Синхронная выборка высоты: (pos, дистанция, подсказки шага) → метры | NaN.
 * Подсказки (LOD пирамиды, зум Terrarium) предвычислены таблицей марша;
 * простейшие сэмплеры могут их игнорировать. */
export type SampleFn = (
  pos: LatLon,
  distM: number,
  hint?: SampleHint,
) => number;

/** Подсказки шага луча: LOD-выборка зависит только от дистанции (таблица марша) */
export interface SampleHint {
  lod: number;
  zoom: number;
}

export interface HorizonOptions {
  /** Шаг по азимуту, рад. 0.1° → 3600 лучей */
  azimuthStepRad?: number;
  /** Максимальная дальность луча, м */
  maxDistM?: number;
  /** Начало луча, м (ближе — свой склон, шум) */
  minDistM?: number;
  /** Высота глаз/телефона над землёй, м */
  observerElevationM?: number;
  /** Зависимости таблицы марша (LOD-выборка по дальности) */
  marchDeps?: MarchDeps;
  /**
   * Верхние границы высот по секторам азимута (core/sector-bounds.ts).
   * Луч обрывается, когда даже высочайший тайл сектора не даёт наклона
   * выше всего, что луч уже видел, — хвост добавил бы только рельеф,
   * скрытый за текущим максимумом. Граница консервативна: видимое не теряется
   */
  sectorMax?: Float32Array;
  /**
   * Зонд «в точке ещё могут быть данные» — для обрезки хвоста офлайн-лучей.
   * До марша по пробным шагам вычисляется первый шаг, после которого данные
   * уже никогда не вернутся; луч обрывается на нём. Онлайн зонд отвечает
   * true всегда — обрезка не срабатывает.
   */
  coverageProbe?: (pos: LatLon, distM: number) => boolean;
}

/** Насколько выше земли глаз наблюдателя (телефон в руках), м */
export const OBSERVER_EYE_M = 1.7;

/** Дистанционные корзины для слоёв (метры) */
export const LAYER_BOUNDS = [
  0, 5_000, 15_000, 40_000, 100_000, 200_000,
] as const;
export const LAYER_COUNT = LAYER_BOUNDS.length - 1;

/**
 * Дистанционные корзины для гребней (метры).
 * Гребень = точка, где угол возвышения вдоль луча достиг локального максимума
 * и дальше падает: именно такие точки видны в кадре как линия силуэта.
 */
export const CREST_BOUNDS = [
  0, 800, 2_000, 5_000, 12_000, 30_000, 70_000, 200_001,
] as const;
export const CREST_COUNT = CREST_BOUNDS.length - 1;
/** Насколько угол должен упасть после максимума, чтобы это считалось гребнем, рад (~0.09°) */
export const CREST_DROP_RAD = 0.0015;

/**
 * Порог «чуть-чуть не видно» для подписи скрытой вершины.
 *
 * Считаем в метрах недобора до гребня, а не в углах: угловой порог на разных
 * дальностях означает совершенно разное. 1° на 5 км — это вершина, которой не
 * хватило полусотни метров; 1° на 100 км — гора, погребённая под километром
 * рельефа (так в кадр лезло «Сашевардно · 1558 м · 105 км»).
 *
 * Порог щедрый: сколько таких подписей реально показать, решает уже раскладка
 * по бюджету кадра (drawLabels) — в пустом кадре их нужно больше, в плотном
 * не нужно вовсе. Угловой предел (~3°) не даёт подписи уползти глубоко
 * в область рельефа, где она выглядела бы висящей на склоне.
 */
export const HIDDEN_LABEL_DEFICIT_M = 400;
export const HIDDEN_LABEL_DEPTH_RAD = 0.052; // ~3°

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
  visibility: "visible" | "onSlope" | "hidden";
  /** Для скрытых: сколько метров не хватило до линии гребня */
  hiddenDeficitM?: number;
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
 * Таблица шагов марша: дистанции и предвычисленные sin/cos(d/R).
 * Последовательность дистанций зависит только от старта и `nextRayStep`,
 * поэтому общая для всех 3600 лучей — тригонометрия дистанции внутри
 * `destination()` считается один раз на всю панораму.
 */
export interface MarchTable {
  /** Дистанции шагов, м */
  d: Float64Array;
  /** sin(d / R) */
  sinD: Float64Array;
  /** cos(d / R) */
  cosD: Float64Array;
  /** earthDrop(d) — формула та же, входы те же, значения тождественны */
  drop: Float64Array;
  /** Подсказки LOD-выборки: lod пирамиды и zoom Terrarium по дальности шага */
  hints: SampleHint[];
  /** Корзина слоя (LAYER_BOUNDS) — функция только от дистанции */
  bin: Uint8Array;
  /** Число шагов */
  count: number;
}

/** Зависимости таблицы марша: выборка LOD по дальности */
export interface MarchDeps {
  /** lodForDistance самого детального источника (выборка патчей — всегда LOD 0) */
  lodForDistance?: (distM: number) => number;
}

/** Дистанции марша и всё, что зависит только от дистанции — раз на пучок лучей */
export function buildMarchTable(
  startM: number,
  maxDistM: number,
  deps: MarchDeps = {},
): MarchTable {
  const dists: number[] = [];
  for (let dist = startM; dist <= maxDistM; dist += nextRayStep(dist)) {
    dists.push(dist);
  }
  const n = dists.length;
  const d = new Float64Array(dists);
  const sinD = new Float64Array(n);
  const cosD = new Float64Array(n);
  const drop = new Float64Array(n);
  const hints = new Array<SampleHint>(n);
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = d[i] / EARTH_RADIUS_M;
    sinD[i] = Math.sin(a);
    cosD[i] = Math.cos(a);
    drop[i] = earthDrop(d[i]);
    hints[i] = {
      lod: deps.lodForDistance ? deps.lodForDistance(d[i]) : 0,
      zoom: zoomForDistance(d[i]),
    };
    // Тот же перебор границ, что был в цикле марша, — один раз на таблицу.
    // По умолчанию — последняя корзина (d ≥ верхней границы); условие от k
    // не зависело, а выполнялось в каждой итерации
    let b = LAYER_COUNT - 1;
    for (let k = 0; k < LAYER_COUNT; k++) {
      if (d[i] >= LAYER_BOUNDS[k] && d[i] < LAYER_BOUNDS[k + 1]) {
        b = k;
        break;
      }
    }
    bin[i] = b;
  }
  return { d, sinD, cosD, drop, hints, bin, count: n };
}

/** Шаг зонда покрытия: между пробниками покрытие не меняется заметно
 *  (тайлы — десятки км), поэтому 64 шагов марша достаточно для точного
 *  поиска «последней покрытой» точки с последующим бинарным уточнением */
const COVERAGE_PROBE_EVERY = 64;

/** Первый шаг марша, на котором данные закончились навсегда (число шагов
 *  марша — покрыт весь луч, обрезки нет). Зонд по пробникам: покрытие может
 *  прерваться и вернуться (луч пересекает второй скачанный регион) —
 *  обрезаем только после последнего покрытого пробника, уточняя границу
 *  бинарным поиском. */
function computeNeverAgain(
  origin: LatLon,
  rayCount: number,
  stepRad: number,
  march: MarchTable,
  probe: (pos: LatLon, distM: number) => boolean,
): Int32Array {
  const steps = march.count;
  const neverAgain = new Int32Array(rayCount).fill(steps);
  const probeCount = Math.ceil(steps / COVERAGE_PROBE_EVERY);
  for (let i = 0; i < rayCount; i++) {
    const pointAt = makeRayMarcher(origin, i * stepRad, march);
    let lastCovered = -1;
    for (let p = 0; p < probeCount; p++) {
      const s = Math.min(p * COVERAGE_PROBE_EVERY, steps - 1);
      if (probe(pointAt(s), march.d[s])) lastCovered = p;
    }
    if (lastCovered < 0) {
      // Нет данных даже у наблюдателя — пустой луч, как и без обрезки
      neverAgain[i] = 0;
      continue;
    }
    if (lastCovered === probeCount - 1) continue; // покрыт до конца
    // Первый непокрытый шаг — между последним покрытым и следующим пробником
    const loStep = Math.min(lastCovered * COVERAGE_PROBE_EVERY + 1, steps - 1);
    const hiStep = Math.min((lastCovered + 1) * COVERAGE_PROBE_EVERY, steps - 1);
    let lo = loStep;
    let hi = hiStep;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (probe(pointAt(mid), march.d[mid])) lo = mid + 1;
      else hi = mid;
    }
    neverAgain[i] = lo;
  }
  return neverAgain;
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
  const hO = observerH + (options.observerElevationM ?? OBSERVER_EYE_M);

  const rayCount = Math.ceil(TWO_PI / stepRad);
  const angles = new Float32Array(rayCount).fill(-Infinity);
  const march = buildMarchTable(minDist, maxDist, options.marchDeps);

  for (let i = 0; i < rayCount; i++) {
    const pointAt = makeRayMarcher(origin, i * stepRad, march);
    // Сравниваем наклоны (возвышение/дистанция), а не углы: atan2 монотонна,
    // порядок сравнений тот же, а трансцендентная функция нужна только при
    // обновлении максимума и при записи результата (подробно — в
    // computeLayeredHorizon)
    let maxSlope = -Infinity;
    // Пороги раннего выхода — пересчёт при каждом обновлении максимума
    let exitSlope = -Infinity;
    let exitAllowed = false;
    for (let s = 0; s < march.count; s++) {
      const d = march.d[s];
      const h = sample(pointAt(s), d, march.hints[s]);
      if (h !== h) continue;
      const slope = (h - march.drop[s] - hO) / d;

      // Корзина по дистанции
      if (slope > maxSlope) {
        maxSlope = slope;
        const maxAngle = Math.atan(slope);
        exitSlope = Math.tan(maxAngle - 0.02);
        exitAllowed = maxAngle < -0.005;
      }
      // Ранний выход: рельеф опустился ниже −0.5° и мы далеко —
      // выше уже не поднимется (кривизна давит квадратично)
      if (d > 60_000 && slope < exitSlope && exitAllowed) break;
    }
    if (maxSlope > -Infinity) angles[i] = Math.atan(maxSlope);
  }
  return { angles, stepRad };
}

/**
 * Фиксация видимого перегиба в корзину гребней. Модульная функция вместо
 * замыкания: замыкание создавалось на каждый из 3600 лучей (аллокация на
 * расчёт), а обращения шли через него. Возвращает новое значение pending
 * (ложь после фиксации — поведение тождественно прежнему).
 */
function recordCrest(
  crests: Float32Array[],
  i: number,
  crestDist: number,
  crestMaxAngle: number,
  crestPending: boolean,
): boolean {
  if (!crestPending) return crestPending;
  let b = CREST_COUNT - 1;
  for (let k = 0; k < CREST_COUNT; k++) {
    if (crestDist >= CREST_BOUNDS[k] && crestDist < CREST_BOUNDS[k + 1]) {
      b = k;
      break;
    }
  }
  if (crestMaxAngle > crests[b][i]) crests[b][i] = crestMaxAngle;
  return false;
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
  const hO = observerH + (options.observerElevationM ?? OBSERVER_EYE_M);

  const rayCount = Math.ceil(TWO_PI / stepRad);
  const layers = Array.from({ length: LAYER_COUNT }, () =>
    new Float32Array(rayCount).fill(-Infinity),
  );
  const distanceToHorizonM = new Float32Array(rayCount).fill(Infinity);
  // Дистанция горизонта ПО СЛОЮ: ближний гребень на луче не должен задавать
  // окно сглаживания и фильтр разрывов дальнему слою (острые дальние пики
  // смазывались окном, посчитанным от ближней дистанции)
  const layerDistM = Array.from({ length: LAYER_COUNT }, () =>
    new Float32Array(rayCount).fill(Infinity),
  );
  const fronts: VisibleFront[][] = Array.from({ length: rayCount }, () => []);
  // Гребни: видимые перегибы силуэта по корзинам дистанций
  const crests = Array.from({ length: CREST_COUNT }, () =>
    new Float32Array(rayCount).fill(-Infinity),
  );

  // Марш начинаем с 1.5 ячейки DEM (численная стабильность atan2)
  const marchStart = minDist * 1.5; // ~135 м для 90 м DEM
  // Таблица шагов общая для всех лучей: sin/cos(d/R) и drop считаются один раз
  const march = buildMarchTable(marchStart, maxDist, options.marchDeps);
  const steps = march.count;
  // Хойсты горячего цикла: таблица марша читается по локальным ссылкам,
  // а не через поля объекта на каждом шаге каждого луча
  const marchD = march.d;
  const marchDrop = march.drop;
  const marchHints = march.hints;
  const marchBin = march.bin;
  // Строка наклонов секторной границы — один буфер на весь расчёт
  // (заполняется на луч только при конечной границе сектора)
  const boundSlopes = new Float64Array(steps);

  // Обрезка хвоста офлайн-лучей: за пределами скачанных тайлов все
  // источники отвечают NaN, и дальняя зона (до 2/3 шагов) считалась
  // впустую. Зонд покрытия по загруженным тайлам даёт для каждого луча
  // первый «навсегда пустой» шаг — обрезка точна, видимое не теряется
  const coverageProbe = options.coverageProbe;
  const neverAgain = coverageProbe
    ? computeNeverAgain(origin, rayCount, stepRad, march, coverageProbe)
    : null;

  // Фронты в плоских массивах (SoA): объекты VisibleFront аллоцируются один
  // раз на луч при сборе, а не на каждый обнаруженный фронт. Буферы растут
  // по требованию: жёсткий кап в 32 молча терял дальние фронты в сложном
  // рельефе, и маркеры вершин уезжали на запасные позиции
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

  // Буферы состояния луча переиспользуются: 3600 лучей × 4 массива
  // Float64Array(5) — это 14.4 тыс. короткоживущих аллокаций на расчёт
  const binMaxSlope = new Float64Array(LAYER_COUNT);
  const binDist = new Float64Array(LAYER_COUNT);
  const binMaxAngle = new Float64Array(LAYER_COUNT);
  const binExitSlope = new Float64Array(LAYER_COUNT);

  for (let i = 0; i < rayCount; i++) {
    const pointAt = makeRayMarcher(origin, i * stepRad, march);
    // Максимумы храним как наклоны (возвышение/дистанция): atan2 монотонна,
    // поэтому все сравнения эквивалентны, а трансцендентные функции нужны
    // лишь при обновлении максимума (редко) и при записи результата — это
    // убирает ~2 млн вызовов atan2 из горячего цикла. Угловые пороги
    // (ранний выход, CREST_DROP_RAD) переводятся в наклоны через tan
    // при каждом обновлении соответствующего максимума
    binMaxSlope.fill(-Infinity);
    binDist.fill(Infinity);
    binMaxAngle.fill(-Infinity);
    binExitSlope.fill(-Infinity);

    // Секторная граница обрыва (P4): сектор луча + максимум тайлов сектора
    const sectorMax = options.sectorMax;
    const sector =
      sectorMax && sectorMax.length > 0
        ? Math.floor((i * sectorMax.length) / rayCount)
        : -1;
    const sectorBound = sector >= 0 && sectorMax ? sectorMax[sector] : NaN;
    // Наклоны верхней границы сектора по шагам луча: выражение зависит
    // только от (сектор, шаг), а делилось на каждом шаге каждого луча.
    // Те же операнды в том же порядке — побитово те же значения
    const hasBound = Number.isFinite(sectorBound);
    if (hasBound) {
      for (let s = 0; s < steps; s++) {
        boundSlopes[s] = (sectorBound - marchDrop[s] - hO) / marchD[s];
      }
    }
    // Максимальный наклон, который луч уже видел (любая дистанция): всё,
    // что ниже его, для рендера и маркеров невидимо — силуэт берёт максимум,
    // гребни — бегущий максимум по ближним профилям
    let rayMaxSlope = -Infinity;

    // Фронты: точки, где рельеф пробивает текущий максимум
    let frontCount = 0;
    let currentMaxSlope = -Infinity;

    // Пропускаем ближнюю зону для фронтов (0–500 м): мы на этом склоне
    const nearSkip = 500;

    // Гребни: отслеживаем текущий максимум наклона и дистанцию, на которой он достигнут
    let crestMaxSlope = -Infinity;
    let crestMaxAngle = -Infinity;
    // Порог фиксации перегиба, в наклонах: tan(crestMaxAngle − CREST_DROP_RAD)
    let crestDropSlope = -Infinity;
    let crestDist = 0;
    let crestPending = false;

    // Первый «навсегда пустой» шаг этого луча (обрезка офлайн-хвоста) —
    // читается один раз на луч
    const neverAgainI = neverAgain ? neverAgain[i] : steps;

    for (let s = 0; s < steps; s++) {
      // Хвост луча за пределами скачанных тайлов: данных нет по построению
      if (s >= neverAgainI) break;
      const d = marchD[s];
      const h = sample(pointAt(s), d, marchHints[s]);
      if (h !== h) continue;
      const slope = (h - marchDrop[s] - hO) / d;
      const bin = marchBin[s];
      if (slope > rayMaxSlope) rayMaxSlope = slope;

      if (slope > binMaxSlope[bin]) {
        binMaxSlope[bin] = slope;
        binDist[bin] = d;
        const a = Math.atan(slope);
        binMaxAngle[bin] = a;
        binExitSlope[bin] = Math.tan(a - 0.02);
      }

      // Гребни: фиксируем локальный максимум угла вдоль луча.
      // Растёт — запоминаем; заметно упал — значит проехали перегиб (видимый гребень).
      if (slope > crestMaxSlope) {
        crestMaxSlope = slope;
        crestMaxAngle = Math.atan(slope);
        crestDropSlope = Math.tan(crestMaxAngle - CREST_DROP_RAD);
        crestDist = d;
        crestPending = true;
      } else if (crestPending && slope < crestDropSlope) {
        crestPending = recordCrest(
          crests,
          i,
          crestDist,
          crestMaxAngle,
          crestPending,
        );
      }

      // Фронт: новый максимум = начало или продолжение.
      //
      // Провал закрывать отдельно не нужно: `distEndM` — это дистанция
      // последнего максимума, и следующий максимум дальше чем через 2 км
      // сам откроет новый фронт. Раньше здесь была ветка «провал — закрываем
      // фронт», которая на каждой точке ниже максимума растягивала `distEndM`
      // до текущей дистанции. Тогда разрыва между фронтами не возникало
      // никогда: дальний хребет прилипал к ближнему, и один фронт тянулся
      // от 3 до 25 км — маркеры вершин выбирали его для чего угодно.
      if (slope > currentMaxSlope && d >= nearSkip) {
        const angle = Math.atan(slope);
        if (frontCount === 0 || d - fEnd[frontCount - 1] > 2000) {
          // Новый фронт (после провала >2 км)
          if (frontCount === fDist.length) growFronts();
          fDist[frontCount] = d;
          fEnd[frontCount] = d;
          fStartRad[frontCount] = angle;
          fMaxRad[frontCount] = angle;
          frontCount++;
        } else {
          // Продолжение текущего фронта
          fEnd[frontCount - 1] = d;
          if (angle > fMaxRad[frontCount - 1]) fMaxRad[frontCount - 1] = angle;
        }
        currentMaxSlope = slope;
      }

      // Ранний выход
      if (
        d > 60_000 &&
        slope < binExitSlope[bin] &&
        binMaxAngle[bin] < -0.005
      )
        break;

      // Секторная граница (P4): (максимум высоты сектора − drop − hO)/d —
      // монотонно убывает с дистанцией, поэтому если уже сейчас наклон
      // верхней границы ниже всего виденного, дальше он не поднимется —
      // хвост луча добавляет только скрытый за максимумом рельеф.
      // Порог с 60 км снижен до 20 км: граница консервативна (максимум по
      // всем загруженным тайлам сектора, а prefetch завершается до марша —
      // занизить её нельзя), так что обрыв не теряет видимый рельеф, а в
      // равнинных/приморских секторах экономит весь хвост луча
      // Наклоны границы предвычислены на луч (строка выше) — в шаге
      // осталось только сравнение
      if (d > 20_000 && hasBound && rayMaxSlope > -Infinity) {
        if (boundSlopes[s] < rayMaxSlope) break;
      }
    }

    // Последний максимум по лучу — это линия неба (skyline)
    crestPending = recordCrest(
      crests,
      i,
      crestDist,
      crestMaxAngle,
      crestPending,
    );

    // Слои
    for (let b = 0; b < LAYER_COUNT; b++) {
      if (binMaxAngle[b] > -Infinity) {
        layers[b][i] = binMaxAngle[b];
        layerDistM[b][i] = binDist[b];
        if (b === 0 || binDist[b] < distanceToHorizonM[i]) {
          distanceToHorizonM[i] = binDist[b];
        }
      }
    }

    // Сборка фронтов луча в объекты — один раз на луч
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

  // Адаптивное сглаживание с защитой разрывов дистанции
  const smoothed = smoothLayers(layers, layerDistM, stepRad);

  return { layers: smoothed, stepRad, distanceToHorizonM, fronts, crests };
}

/** Адаптивное сглаживание силуэта: ширина окна ~ полразмера ячейки в лучах.
 *  Каждый слой гладится своей дистанцией горизонта — см. layerDistM.
 *  Экспортируется для тестов (сверка с эталонной копией на `%`) */
export function smoothLayers(
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

      // Полразмера ячейки данных в лучах: (cell / dist) / stepRad.
      // Ячейка не 90 м: на дальних лучах работает LOD ~ dist/150 (у патча) и
      // Terrarium z11–z9 (76–306 м). Фиксированные 90 м занижали окно в
      // 2–20 раз, и дальние гребни оставались «пилой» от квантования высоты
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
        // Ветка-обёртка вместо деления по модулю. halfWin ≤ 8, а лучей
        // сотни; при rayCount < 9 окно всегда нулевое (дистанция марша
        // ≥ 150 м против условия dist·stepRad ≤ 90 м), поэтому каждая
        // ветка срабатывает не больше одного раза и результат в точности
        // равен fmod
        let k = i + j;
        if (k < 0) k += rayCount;
        if (k >= rayCount) k -= rayCount;
        // Не сглаживать через разрывы дистанции — своей, а не чужого слоя
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
 * Видимость пика: точный луч в его азимуте (ALGORITHMS.md §2).
 * Классификация: visible (выше горизонта) / onSlope (на видимом склоне) /
 * hidden (чуть за гребнем — подписываем, но без маркера вершины).
 */
export function checkPeakVisibility(
  origin: LatLon,
  observerH: number,
  peak: Peak,
  sample: SampleFn,
  distanceToHorizonM: number,
  epsilonRad = 0.0009, // ~0.05°
  march?: MarchTable,
  /** Предвычисленные азимут/дистанция (filterVisiblePeaks): те же входы —
   * побитово те же значения, лишняя тригонометрия не тратится */
  pre?: { azRad: number; distM: number },
): VisiblePeak | null {
  const target: LatLon = { lat: peak.lat, lon: peak.lon };
  const dist = pre?.distM ?? distanceM(origin, target);
  if (dist > PEAK_VISIBILITY_RADIUS_M || dist < 1) return null;
  if (peak.ele === undefined) return null;

  const az = pre?.azRad ?? azimuthRad(origin, target);
  const hO = observerH + OBSERVER_EYE_M;
  const table = march ?? buildMarchTable(100, dist);
  const pointAt = makeRayMarcher(origin, az, table);

  const peakAngle = elevationAngleRad(hO, peak.ele, dist);
  // Наклон пика — та же величина, что tan(peakAngle), без лишней тригонометрии
  const peakSlope = (peak.ele - hO - earthDrop(dist)) / dist;
  // Максимум вдоль луча растёт монотонно: как только глубина пика под
  // профилем превысила порог подписи скрытых, вердикт от дальнейшего марша
  // уже не зависит («onSlope» не использует величину максимума, «hidden»
  // исключён глубиной) — выходим досрочно, не теряя точности вердикта
  const hiddenLimitSlope = Math.tan(peakAngle + HIDDEN_LABEL_DEPTH_RAD);

  // Марш луча до пика: ищем максимальный угол рельефа строго до пика.
  // Сравниваем наклоны: atan2 монотонна, порядок тот же (см. выше)
  let maxSlope = -Infinity;
  for (let s = 0; s < table.count; s++) {
    const d = table.d[s];
    if (d >= dist - 100) break;
    const h = sample(pointAt(s), d, table.hints[s]);
    if (h !== h) continue;
    const slope = (h - table.drop[s] - hO) / d;
    if (slope > maxSlope) maxSlope = slope;
    if (maxSlope > hiddenLimitSlope) break;
  }

  const maxAngle = maxSlope === -Infinity ? -Infinity : Math.atan(maxSlope);

  // Классификация по углу и дистанции до горизонта
  if (peakAngle < maxAngle - epsilonRad) {
    // Пик ниже профиля луча — скрыт или на склоне
    if (dist < distanceToHorizonM) {
      return {
        ...peak,
        azimuthRad: az,
        elevationRad: peakAngle,
        distanceM: dist,
        visibility: "onSlope",
      };
    }
    // За хребтом. Подписываем «чуть-чуть» скрытые: вершине не хватило десятков
    // метров до гребня — это полезно («она вон там, за склоном»). Сколько таких
    // подписей показать, решает раскладка по бюджету кадра.
    const depthRad = maxAngle - peakAngle;
    // tan(угол) — это и есть наклон (atan2/tan взаимно обратны), считаем разность наклонов напрямую
    const deficitM = (maxSlope - peakSlope) * dist;
    if (
      depthRad <= HIDDEN_LABEL_DEPTH_RAD &&
      deficitM <= HIDDEN_LABEL_DEFICIT_M
    ) {
      return {
        ...peak,
        azimuthRad: az,
        elevationRad: peakAngle,
        distanceM: dist,
        visibility: "hidden",
        hiddenDeficitM: deficitM,
      };
    }
    return null;
  }

  return {
    ...peak,
    azimuthRad: az,
    elevationRad: peakAngle,
    distanceM: dist,
    visibility: "visible",
  };
}

/** Массовая проверка видимости списка пиков */
export function filterVisiblePeaks(
  origin: LatLon,
  observerH: number,
  peaks: Peak[],
  sample: SampleFn,
  layered?: LayeredHorizon,
  marchDeps?: MarchDeps,
): VisiblePeak[] {
  const result: VisiblePeak[] = [];
  // Таблица шагов общая для всех пиков: луч каждого пика — её префикс
  const march = buildMarchTable(100, PEAK_VISIBILITY_RADIUS_M, marchDeps);
  for (const peak of peaks) {
    // Отсев до тригонометрии азимута: эти пики checkPeakVisibility
    // отбросил бы всё равно (радиус видимости, отсутствие высоты)
    if (peak.ele === undefined) continue;
    const dist = distanceM(origin, peak);
    if (dist > PEAK_VISIBILITY_RADIUS_M || dist < 1) continue;
    const az = azimuthRad(origin, peak);
    const distToHorizon = layered
      ? layered.distanceToHorizonM[
          Math.round(az / layered.stepRad) % layered.distanceToHorizonM.length
        ]
      : Infinity;
    const visible = checkPeakVisibility(
      origin,
      observerH,
      peak,
      sample,
      distToHorizon,
      undefined,
      march,
      // Тот же азимут и дистанция, что посчитаны строкой выше, —
      // внутри повторной тригонометрии нет
      { azRad: az, distM: dist },
    );
    if (visible) result.push(visible);
  }
  // Сортировка: видимые → на склоне → скрытые; внутри — по приоритету подписи
  const order = { visible: 0, onSlope: 1, hidden: 2 };
  result.sort((a, b) => {
    const oa = order[a.visibility];
    const ob = order[b.visibility];
    if (oa !== ob) return oa - ob;
    return peakScore(b, b.distanceM) - peakScore(a, a.distanceM);
  });
  return result;
}
