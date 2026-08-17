/**
 * Автокалибровка по кадру камеры (ROADMAP 6.1, ALGORITHMS.md §3, приём №4).
 *
 * Компас врёт систематически: магнитное склонение (теперь убирается заранее
 * по WMM — core/declination.ts), железо рядом, дешёвый магнитометр. Ручные
 * ползунки это лечат, но требуют, чтобы человек стоял и подгонял контуры
 * пальцем. Здесь то же самое делает программа: из кадра достаётся линия
 * «небо / земля», и она совмещается с горизонтом, посчитанным по рельефу.
 *
 * Почему это работает без нейросетей: линия горизонта — самая контрастная
 * горизонтальная граница в кадре, а форма гребня уникальна, как штрихкод.
 * Достаточно одномерного сравнения профилей — гомография и прочая тяжёлая
 * геометрия не нужны, потому что обе кривые уже в одних координатах (угол
 * возвышения от азимута).
 *
 * Всё, что здесь есть, — чистые функции над массивами: их можно прогнать в
 * тестах на синтетическом рельефе, не поднимая камеру.
 */

import { wrapAngle } from './geo';
import { matchSkylineCoarse } from './skyline-match';

/** Ширина рабочей сетки: больше не нужно, гребень — крупная форма */
const GRID_W = 160;
const GRID_H = 120;

/**
 * Профиль неба из кадра: для каждой из GRID_W колонок — доля высоты кадра,
 * на которой проходит граница «небо / земля» (0 — верх кадра, 1 — низ).
 * NaN, если в колонке границы нет (сплошное небо или сплошная земля).
 *
 * Способ разделения — поколоночный порог по Оцу: ищем строку, которая делит
 * колонку на две максимально непохожие части. Простой порог яркости не годится
 * — снежная вершина ярче неба в дымке, а лес в тени темнее скалы; важна не
 * абсолютная яркость, а то, что небо однородно, а земля нет.
 */
export function extractSkyline(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const grid = downsample(rgba, width, height);
  const profile = new Float32Array(GRID_W);

  for (let x = 0; x < GRID_W; x++) {
    // Префиксные суммы по колонке: split за один проход вместо квадрата
    let sum = 0;
    let sumSq = 0;
    const values = new Float32Array(GRID_H);
    for (let y = 0; y < GRID_H; y++) {
      const v = grid[y * GRID_W + x];
      values[y] = v;
      sum += v;
      sumSq += v * v;
    }

    let bestScore = 0;
    let bestY = -1;
    let bestDiff = 0;
    let above = 0;
    for (let y = 1; y < GRID_H - 1; y++) {
      above += values[y - 1];
      const nAbove = y;
      const nBelow = GRID_H - y;
      const meanAbove = above / nAbove;
      const meanBelow = (sum - above) / nBelow;
      const diff = meanAbove - meanBelow;
      // Небо всегда «небеснее» земли: отрицательную разницу не рассматриваем,
      // иначе граница уедет на тень под гребнем
      if (diff <= 0) continue;
      const score = nAbove * nBelow * diff * diff;
      if (score > bestScore) {
        bestScore = score;
        bestY = y;
        bestDiff = diff;
      }
    }

    // Насколько уверенно разделилась колонка. Двух проверок мало по
    // отдельности: относительная (насколько разделение лучше разброса внутри
    // колонки) сходит с ума на почти однородной картинке — засвеченное небо
    // делится «идеально» при разнице в пару единиц яркости. Поэтому вторая,
    // абсолютная: настоящая граница неба и земли даёт разницу в разы большую
    const variance = sumSq / GRID_H - (sum / GRID_H) ** 2;
    const separation = bestScore / (GRID_H * GRID_H * Math.max(variance, 1e-6));
    const weak = bestY < 0 || separation < 0.25 || bestDiff < MIN_CONTRAST;
    profile[x] = weak ? NaN : bestY / GRID_H;
  }
  return profile;
}

/**
 * Наименьшая разница «небесности» неба и земли, при которой верим границе.
 * Ниже — туман, засветка или объектив, упёртый в стену.
 */
const MIN_CONTRAST = 0.06;

/** Кадр → сетка GRID_W×GRID_H значений «небесности» 0…1 */
function downsample(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const grid = new Float32Array(GRID_W * GRID_H);
  const counts = new Float32Array(GRID_W * GRID_H);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(GRID_H - 1, ((y / height) * GRID_H) | 0);
    for (let x = 0; x < width; x++) {
      const gx = Math.min(GRID_W - 1, ((x / width) * GRID_W) | 0);
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      // Яркость плюс «синева»: небо и светлое, и синее, а скала с лесом —
      // ни то ни другое. Снег ловится яркостью, дымка над хребтом — синевой
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const blue = (b - Math.max(r, g)) / 255;
      const cell = gy * GRID_W + gx;
      grid[cell] += 0.6 * lum + 0.4 * (blue + 1) * 0.5;
      counts[cell]++;
    }
  }
  for (let i = 0; i < grid.length; i++) if (counts[i]) grid[i] /= counts[i];
  return grid;
}

export interface SkylineMatchOptions {
  /** Азимут центра кадра сейчас, рад */
  centerAzRad: number;
  /** Наклон камеры сейчас, рад */
  tiltRad: number;
  /** Горизонтальный угол обзора, рад */
  fovRad: number;
  /** Вертикальный угол обзора, рад */
  fovVRad: number;
  /** Доля высоты кадра, на которой рисуется линия горизонта (0 = верх) */
  horizonFrac: number;
  /** Горизонт по лучам: элемент i — угол возвышения на азимуте i·stepRad */
  horizon: Float32Array;
  stepRad: number;
  /** Предел поиска по азимуту, рад (склонение + железо редко больше 25°) */
  maxAzRad?: number;
  /** Предел поиска по наклону, рад */
  maxTiltRad?: number;
  /**
   * Видимые вершины из воркера (азимут/возвышение известны) — якорная
   * проверка гипотез грубого поиска по полному кругу. Без них грубый поиск
   * работает, но ложные совпадения на периодичных гребнях фильтруются слабее.
   */
  peaks?: import('./horizon').VisiblePeak[];
}

export interface SkylineMatch {
  /** Поправка азимута, рад: сколько прибавить к показаниям компаса */
  azimuthRad: number;
  /** Поправка наклона, рад */
  tiltRad: number;
  /**
   * Насколько сошлось: 0 — мимо, 1 — идеально. Ниже MIN_CONFIDENCE результат
   * применять нельзя — лучше оставить как было, чем увести панораму в сторону.
   */
  confidence: number;
  /** Сколько колонок кадра участвовало в сравнении */
  columns: number;
}

/** Порог доверия: ниже него поправка не применяется */
export const MIN_CONFIDENCE = 0.55;

/**
 * Совмещение линии неба из кадра с горизонтом по рельефу.
 *
 * Ищем сдвиг по азимуту и по наклону, при котором две кривые совпадают лучше
 * всего. Перебор идёт от грубого шага к точному: полный перебор по сетке
 * 0.1° занял бы 500×200 = 100 тыс. вариантов на кадр, а так — около 2 тыс.
 *
 * Ошибка считается устойчиво (медиана модулей, а не сумма квадратов): облако
 * на полкадра или дерево у объектива дают несколько диких колонок, и метод
 * наименьших квадратов из-за них уедет весь.
 */
export function matchSkyline(
  frame: Float32Array,
  options: SkylineMatchOptions,
): SkylineMatch {
  const {
    centerAzRad,
    tiltRad,
    fovRad,
    fovVRad,
    horizonFrac,
    horizon,
    stepRad,
    maxAzRad = (25 * Math.PI) / 180,
    maxTiltRad = (12 * Math.PI) / 180,
  } = options;

  // Кадр: доля высоты → угол возвышения в системе «камера смотрит ровно»
  const cols: number[] = [];
  const frameElev: number[] = [];
  for (let x = 0; x < frame.length; x++) {
    const yFrac = frame[x];
    if (Number.isNaN(yFrac)) continue;
    cols.push(((x + 0.5) / frame.length - 0.5) * fovRad);
    frameElev.push(tiltRad + (horizonFrac - yFrac) * fovVRad);
  }
  if (cols.length < frame.length * 0.35) {
    // Небо не нашлось почти нигде: туман, ночь, объектив в стену
    return { azimuthRad: 0, tiltRad: 0, confidence: 0, columns: cols.length };
  }

  const demAt = (az: number): number => {
    const idx = az / stepRad;
    const i0 = Math.floor(idx);
    const f = idx - i0;
    const a = horizon[((i0 % horizon.length) + horizon.length) % horizon.length];
    const b = horizon[((i0 + 1) % horizon.length + horizon.length) % horizon.length];
    // Луч без рельефа помечен −Infinity, и интерполяция по нему даёт NaN даже
    // при f = 0 (−Inf + Inf·0). Такое значение надо возвращать явно, чтобы
    // вызывающий его отбросил, а не подмешал в статистику
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
    return a + (b - a) * f;
  };

  /**
   * Сколько колонок должно совпасть с рельефом, чтобы ответу можно было верить.
   *
   * Без нижней границы выигрывает сдвиг, при котором в горизонт попали
   * две-три колонки: медиана по ним всегда мала, и мимо-ответ получает лучшую
   * невязку, чем правильный.
   */
  const minValid = Math.max(8, Math.round(cols.length * 0.5));

  /**
   * Медиана модулей расхождения при заданных поправках.
   *
   * Колонки, где рельефа нет (дыра в горизонте), выбрасываются: NaN ломает и
   * сравнение (`sort` с NaN оставляет массив в произвольном порядке), и саму
   * медиану, и baseline для доверия — так неверная поправка получала
   * confidence под единицу и молча уводила панораму.
   */
  const residual = (dAz: number, dTilt: number): number => {
    const errors: number[] = [];
    for (let k = 0; k < cols.length; k++) {
      const dem = demAt(centerAzRad + dAz + cols[k]);
      if (!Number.isFinite(dem)) continue;
      errors.push(Math.abs(frameElev[k] + dTilt - dem));
    }
    if (errors.length < minValid) return Infinity;
    errors.sort((a, b) => a - b);
    return errors[errors.length >> 1];
  };

  /**
   * Грубый поиск по ПОЛНОМУ кругу (core/skyline-match.ts): если компас врёт
   * больше окна ±25°, оконный перебор правды не найдёт в принципе. ZNCC
   * производной профиля по кольцу горизонта даёт топ-K гипотез азимута за
   * три БПФ; лучшую доводим тем же трёхпроходным поиском ниже. Гипотезы
   * равнины/тумана (низкий разброс профиля) отсеиваются там же — сюда они
   * не доходят, и ложного совпадения «ровное с ровным» не бывает.
   */
  const coarse = matchSkylineCoarse({
    horizon,
    stepRad,
    frameElev,
    leftAzRad: centerAzRad - fovRad / 2,
    fovRad,
    hintAzRad: centerAzRad,
    peaks: options.peaks,
  });

  /**
   * Стартовые центры для доводки: (0, 0) — компас не врёт, плюс каждая
   * гипотеза грубого поиска. Доводка по-прежнему локальная (±3°/±1.5°), но
   * стартует уже рядом с правдой, куда бы компас ни смотрел.
   */
  const seeds: { az: number; tilt: number }[] = [{ az: 0, tilt: 0 }];
  for (const h of coarse) {
    seeds.push({
      az: wrapAngle(h.centerAzRad - centerAzRad),
      tilt: 0,
    });
  }

  let best = { az: 0, tilt: 0, err: Infinity };

  for (const seed of seeds) {
    let azStep = (2 * Math.PI) / 180;
    let tiltStep = (1 * Math.PI) / 180;
    // Окно первого прохода: для компаса — прежние пределы, для гипотез грубого
    // поиска ±3°/±1.5° достаточно (точность ZNCC — доли градуса)
    let azRange = seed.az === 0 && seed.tilt === 0 ? maxAzRad : (3 * Math.PI) / 180;
    let tiltRange = seed.az === 0 && seed.tilt === 0 ? maxTiltRad : (1.5 * Math.PI) / 180;
    let azCenter = seed.az;
    let tiltCenter = seed.tilt;

    for (let pass = 0; pass < 3; pass++) {
      for (let az = azCenter - azRange; az <= azCenter + azRange + 1e-9; az += azStep) {
        for (
          let tilt = tiltCenter - tiltRange;
          tilt <= tiltCenter + tiltRange + 1e-9;
          tilt += tiltStep
        ) {
          const err = residual(az, tilt);
          if (err < best.err) best = { az, tilt, err };
        }
      }
      azCenter = best.az;
      tiltCenter = best.tilt;
      azRange = azStep;
      tiltRange = tiltStep;
      azStep /= 5;
      tiltStep /= 5;
    }
  }

  // Доверие: насколько найденный минимум лучше «типичного» сдвига. Совпадение
  // само по себе ничего не значит — ровный горизонт над морем совпадёт при
  // любом азимуте, и такой ответ надо отбросить
  if (!Number.isFinite(best.err)) {
    // Рельефа в кадре почти нет ни при каком сдвиге: сравнивать нечего
    return { azimuthRad: 0, tiltRad: 0, confidence: 0, columns: cols.length };
  }
  const baseline = medianResidualAcrossShifts(residual, maxAzRad, best.tilt);
  let confidence = baseline > 0 ? Math.max(0, 1 - best.err / baseline) : 0;

  // Если лучший ответ пришёл с гипотезы грубого поиска, его однозначность
  // (разрыв с вторым разным пиком ZNCC) и вершины-якоря входят в доверие:
  // без них «похожий соседний гребень» неотличим от истины
  const coarseBest = coarse[0];
  if (coarseBest && Math.abs(wrapAngle(best.az - wrapAngle(coarseBest.centerAzRad - centerAzRad))) < (1 * Math.PI) / 180) {
    // Ответ совпал с гипотезой грубого поиска — учитываем её качество
    confidence *= Math.min(1, coarseBest.uniqueness / 1.5);
    if (coarseBest.anchorScore >= 0.6) confidence = Math.min(1, confidence + 0.2);
    else if (coarseBest.anchorScore === 0 && options.peaks?.length) confidence *= 0.5;
  }

  return {
    azimuthRad: best.az,
    tiltRad: best.tilt,
    confidence,
    columns: cols.length,
  };
}

/** Медиана ошибки по всем азимутам — мера «а бывает ли вообще хуже» */
function medianResidualAcrossShifts(
  residual: (az: number, tilt: number) => number,
  maxAzRad: number,
  tilt: number,
): number {
  const step = (3 * Math.PI) / 180;
  const values: number[] = [];
  for (let az = -maxAzRad; az <= maxAzRad + 1e-9; az += step) {
    const err = residual(az, tilt);
    // Сдвиги, где рельефа под кадром почти нет, не характеризуют «типичную»
    // ошибку: с Infinity в выборке медиана перестаёт быть числом
    if (Number.isFinite(err)) values.push(err);
  }
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}
