/**
 * Грубое совмещение профиля «небо/земля» с горизонтом по рельефу — по
 * ПОЛНОМУ кругу азимутов, а не в окне ±25° вокруг компаса.
 *
 * Зачем: компас может врать на десятки градусов (железо, чехол с магнитом),
 * а бывает, человек смотрит вообще не туда — и оконный поиск принципиально
 * не находит правды. Здесь окно кадра скользит по кольцу горизонта через
 * круговую нормированную кросс-корреляцию (ZNCC) — все сдвиги за три БПФ.
 *
 * Три проектных решения:
 *
 * 1. **Коррелируется производная профиля, а не сам профиль.** Производная
 *    инвариантна к постоянному вертикальному сдвигу — то есть к ошибке
 *    наклона (датчик врёт на пару градусов, человек держит телефон криво).
 *    По абсолютным высотам корреляция на крутых гребнях умирала бы от
 *    сдвига на полтора градуса; по форме — нет. Наклон поэтому в грубом
 *    поиске вообще не фигурирует и доводится потом, локально.
 *
 * 2. **Ложные совпадения отсекаются отношением к второму максимуму.**
 *    Горные гребни периодичны, «похожий» силуэт найдётся всегда. Мера
 *    однозначности — разрыв между лучшим и вторым несоседним максимумом.
 *
 * 3. **Вершины-якоря.** Видимые вершины с известными азимутами/возвышениями
 *    (посчитаны воркером) — независимая проверка: ложный максимум формы
 *    почти никогда не угадает ещё и позицию Эльбруса.
 */

import { fft } from './fft';
import { wrapAngle } from './geo';
import type { VisiblePeak } from './horizon';

/** Гипотеза совмещения: куда на самом деле смотрит камера */
export interface CoarseHypothesis {
  /** Азимут центра кадра, рад [0, 2π) */
  centerAzRad: number;
  /** ZNCC производных профилей (−1…1) */
  score: number;
  /** Отношение к второму несоседнему максимуму: >1.25 — однозначно */
  uniqueness: number;
  /** Доля ожидаемых вершин, подтверждённых локальным пиком профиля (0…1, −1 — проверять нечего) */
  anchorScore: number;
}

export interface CoarseMatchOptions {
  /** Горизонт по лучам: элемент i — угол возвышения на азимуте i·stepRad */
  horizon: Float32Array;
  stepRad: number;
  /**
   * Профиль кадра в углах возвышения относительно текущего наклона
   * (`tiltRad + (horizonFrac − yFrac)·fovVRad`), рад; NaN — колонка без
   * надёжной границы. Индекс — колонка кадра слева направо.
   */
  frameElev: Array<number>;
  /** Азимут первой колонки frameElev, рад (левый край кадра по компасу) */
  leftAzRad: number;
  /** Ширина кадра по азимуту, рад (fovRad) */
  fovRad: number;
  /**
   * Подсказка компаса: её score получает мягкий бонус, но окном она не
   * ограничивает — за этим весь модуль. null — компаса нет.
   */
  hintAzRad?: number | null;
  /** Видимые вершины для якорной проверки (могут отсутствовать) */
  peaks?: VisiblePeak[];
  /** Сколько гипотез вернуть (умолчание 5) */
  topK?: number;
}

/** Минимальная доля валидных колонок кадра: меньше — совмещать нечего */
export const MIN_VALID_FRAC = 0.4;
/**
 * Минимальный разброс профиля кадра, рад (~0.3°): ниже — равнина, туман,
 * стена; совпадение найдётся при любом азимуте и ничего не значит
 */
export const MIN_PROFILE_STD = 0.005;
/** Мягкий бонус подсказке компаса, доля от score (окном не ограничиваем) */
const COMPASS_BONUS = 0.08;
/** Минимальный ZNCC гипотезы: ниже — это шум, а не силуэт (порог «не нашёл») */
export const MIN_COARSE_SCORE = 0.6;
/** Разрыв с вторым несоседним максимумом для уверенного ответа */
export const MIN_UNIQUENESS = 1.1;
/** Соседние максимумы ближе этого не считаются конкурентами, рад (~5°) */
const PEAK_SEPARATION_RAD = (5 * Math.PI) / 180;
/** Окно поиска локального пика профиля вокруг ожидаемой вершины, рад */
const ANCHOR_WINDOW_RAD = (0.6 * Math.PI) / 180;
/** Предел расхождения по возвышению для подтверждения якоря, рад (~0.5°) */
const ANCHOR_ELEV_TOL_RAD = (0.5 * Math.PI) / 180;

/**
 * Грубое совмещение по полному кругу. Пустой массив — кадр неинформативен
 * (равнина, туман, стена): честный отказ лучше уверенного мусора.
 */
export function matchSkylineCoarse(options: CoarseMatchOptions): CoarseHypothesis[] {
  const { horizon, stepRad, frameElev, fovRad, topK = 5 } = options;
  const n = horizon.length;
  if (!n || stepRad <= 0) return [];
  // leftAzRad не входит в координаты ответа: поиск полный, а догадка компаса
  // — только мягкий приор (COMPASS_BONUS ниже)

  // Валидные колонки и их профиль на сетке лучей
  const valid = frameElev.filter((v) => Number.isFinite(v));
  if (valid.length < frameElev.length * MIN_VALID_FRAC) return [];
  const std = Math.sqrt(
    valid.reduce((s, v) => s + v * v, 0) / valid.length -
      (valid.reduce((s, v) => s + v, 0) / valid.length) ** 2,
  );
  if (std < MIN_PROFILE_STD) return [];

  // Профиль кадра на сетке лучей, с маской валидности.
  //
  // Коррелируем САМ профиль, а не производную: кадр из камеры квантуется
  // экстрактором (сетка ~120 строк), и производная на длинных плато нулевая —
  // ZNCC по производной там умирал. Инвариантность к ошибке наклона получаем
  // иначе: ZNCC сама вычитает среднее окна, поэтому постоянный сдвиг наклона
  // на неё не влияет, а остаток доводит уровень B.
  const raysInFrame = Math.max(2, Math.round(fovRad / stepRad));
  const frameVals = new Float64Array(raysInFrame);
  const frameMask = new Float64Array(raysInFrame);
  for (let r = 0; r < raysInFrame; r++) {
    // Колонка кадра, покрывающая этот луч
    const fx = (r / raysInFrame) * frameElev.length;
    const i0 = Math.floor(fx);
    const f = fx - i0;
    const a = frameElev[Math.min(i0, frameElev.length - 1)];
    const b = frameElev[Math.min(i0 + 1, frameElev.length - 1)];
    if (Number.isFinite(a) && Number.isFinite(b)) {
      frameVals[r] = a + (b - a) * f;
      frameMask[r] = 1;
    }
  }
  const cCount = frameMask.reduce((s, v) => s + v, 0);
  if (cCount < raysInFrame * MIN_VALID_FRAC) return [];
  // Нормировка окна кадра (ZNCC сама вычитает среднее — значит, инвариантна
  // к постоянному сдвигу наклона)
  const cMean = frameVals.reduce((s, v, i) => s + (frameMask[i] ? v : 0), 0) / cCount;
  const cStd = Math.sqrt(
    frameVals.reduce((s, v, i) => s + (frameMask[i] ? (v - cMean) ** 2 : 0), 0) / cCount,
  );
  if (cStd < MIN_PROFILE_STD) return []; // профиль плоский
  const c = new Float64Array(raysInFrame);
  for (let r = 0; r < raysInFrame; r++) {
    c[r] = frameMask[r] ? (frameVals[r] - cMean) / cStd : 0;
  }

  // Горизонт по кольцу (дыры −Infinity разрывают валидность)
  const hVal = new Float64Array(n);
  const hMask = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(horizon[i])) {
      hVal[i] = horizon[i];
      hMask[i] = 1;
    }
  }

  // Круговая ZNCC окна c по кольцу h — через БПФ длины n2 (степень 2 ≥ 2n).
  //
  // ВНИМАНИЕ, две тонкости, на которых эта схема горит:
  //
  // 1. Сопряжения нет: наш fft() считает с экспонентой e^(+2πi·jk/n)
  //    (обратный знак от классической ДПФ), поэтому обычное произведение
  //    спектров уже даёт кросс-корреляцию: score[s] = Σ c[r]·h[(s+r)%n].
  //
  // 2. Маска валидности ДВУСТОРОННЯЯ: суммы считаются не по Σc·hMask
  //    (c ≠ 0 не совпадает с derMask — у окна есть край), а по
  //    Σ derMask·hMask: только пары, где валидны И кадр, И горизонт. Иначе
  //    нормировка по «мнимым» членам занижала корреляцию до отсечения.
  //
  // 3. Кольцо удвоено (h дважды подряд), а не нулевой паддинг: окно кадра
  //    обязано видеть горизонт за швом 0°/360°. С нулями окно, висящее на
  //    шве, получало заниженную дисперсию и ложно выигрывало.
  let n2 = 1;
  while (n2 < 2 * n + raysInFrame) n2 *= 2;

  const pack = (vals: Float64Array, mask: Float64Array): [Float64Array, Float64Array] => {
    const re = new Float64Array(n2);
    const im = new Float64Array(n2);
    for (let i = 0; i < 2 * n; i++) re[i] = vals[i % n] * mask[i % n];
    return [re, im];
  };
  const [reCH, imCH] = pack(hVal, hMask); // h·mask
  const [reM, imM] = pack(new Float64Array(n).fill(1), hMask); // mask
  const [reH2, imH2] = pack(
    Float64Array.from(hVal, (v) => v * v),
    hMask,
  ); // h²·mask

  // Два развёрнутых ядра: значения c и её маска
  const kernelC = new Float64Array(n2);
  const kernelCMask = new Float64Array(n2);
  for (let r = 0; r < raysInFrame; r++) {
    kernelC[(n2 - r) % n2] = c[r];
    kernelCMask[(n2 - r) % n2] = frameMask[r];
  }

  // БПФ всем входам: реальная И мнимая части пишутся в одни и те же
  // массивы (fft in-place), иначе im у ядер остаётся нулём, а корреляция
  // считается по половине спектра
  const prep = (re: Float64Array, im: Float64Array): void => {
    fft(re, im);
  };
  prep(reCH, imCH);
  prep(reM, imM);
  prep(reH2, imH2);
  const reK = kernelC;
  const imK = new Float64Array(n2);
  fft(reK, imK);
  const reKm = kernelCMask;
  const imKm = new Float64Array(n2);
  fft(reKm, imKm);

  const [reH, imH] = [reCH, imCH]; // для читаемости ниже

  /**
   * Круговая корреляция Σ kernel[r]·hSeq[(s+r)%n] по всем сдвигам s.
   * Без сопряжения — см. замечание выше.
   */
  const corrWith = (
    reA: Float64Array,
    imA: Float64Array,
    reKernel: Float64Array,
    imKernel: Float64Array,
  ): Float64Array => {
    const re = new Float64Array(n2);
    const im = new Float64Array(n2);
    for (let i = 0; i < n2; i++) {
      re[i] = reA[i] * reKernel[i] - imA[i] * imKernel[i];
      im[i] = reA[i] * imKernel[i] + imA[i] * reKernel[i];
    }
    fft(re, im, true);
    const out = new Float64Array(n);
    for (let s = 0; s < n; s++) out[s] = re[s] / n2;
    return out;
  };

  const sumCH = corrWith(reH, imH, reK, imK); // Σ c·h (обе стороны валидны — c=0 там, где маски нет)
  const sumPairs = corrWith(reM, imM, reKm, imKm); // Σ derMask·hMask
  const sumH = corrWith(reH, imH, reKm, imKm); // Σ h по валидным парам
  const sumH2 = corrWith(reH2, imH2, reKm, imKm); // Σ h² по валидным парам

  const sumC = c.reduce((s, v) => s + v, 0);
  const sumC2 = c.reduce((s, v) => s + v * v, 0);
  const scores = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    const m = sumPairs[s];
    if (m < cCount * MIN_VALID_FRAC) {
      scores[s] = -1;
      continue;
    }
    const meanH = sumH[s] / m;
    const varH = sumH2[s] / m - meanH * meanH;
    if (varH <= 1e-12) {
      scores[s] = -1;
      continue;
    }
    // ZNCC по валидным парам: num/den — классическая формула Пирсона
    const num = sumCH[s] - (sumC * sumH[s]) / m;
    const den = Math.sqrt(Math.max(sumC2 - (sumC * sumC) / m, 0) * m * varH);
    scores[s] = den > 0 ? num / den : -1;
  }

  // Локальные максимумы с подавлением соседей
  const sepRays = Math.round(PEAK_SEPARATION_RAD / stepRad);
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => scores[b] - scores[a],
  );
  const taken = new Uint8Array(n);
  const hypotheses: CoarseHypothesis[] = [];
  const distinctScores: number[] = [];

  for (const s of order) {
    if (scores[s] <= 0) break;
    if (taken[s]) continue;
    for (let k = -sepRays; k <= sepRays; k++) {
      taken[(((s + k) % n) + n) % n] = 1;
    }
    // Первые два РАЗНЫХ (несоседних) максимума — для разрыва однозначности
    distinctScores.push(scores[s]);
    // s — луч левого края кадра в горизонте, то есть ИСТИННЫЙ азимут левого
    // края (горизонт индексируется от истинного севера, а не от догадки
    // компаса). Ответ потому абсолютный: leftAzRad участвует только как
    // мягкий приор (COMPASS_BONUS), в координаты результата не входит.
    const centerAz = wrapAngle(s * stepRad + fovRad / 2);
    hypotheses.push({
      centerAzRad: centerAz,
      score: scores[s],
      uniqueness: 0, // заполним после цикла
      anchorScore: -1,
    });
    if (hypotheses.length >= topK) break;
  }
  if (!hypotheses.length) return [];

  const bestScore = hypotheses[0].score;
  const secondDistinct = distinctScores.length > 1 ? distinctScores[1] : 0;
  for (const h of hypotheses) {
    h.uniqueness = secondDistinct > 0 ? bestScore / secondDistinct : 2;
    // Подсказка компаса: мягкий бонус, окном не ограничивает
    if (options.hintAzRad != null) {
      const d = Math.abs(wrapAngle(h.centerAzRad - options.hintAzRad));
      if (d < (20 * Math.PI) / 180) h.score += bestScore * COMPASS_BONUS;
    }
    h.anchorScore = anchorScore(h.centerAzRad, options);
  }

  return hypotheses
    .filter((h) => h.score >= MIN_COARSE_SCORE)
    .sort((a, b) => b.score - a.score);
}

/**
 * Доля видимых вершин, рядом с азимутом которых в профиле кадра есть
 * локальный пик подходящей высоты. −1 — проверять нечего (вершин нет).
 */
function anchorScore(centerAzRad: number, options: CoarseMatchOptions): number {
  const { peaks, frameElev, fovRad } = options;
  if (!peaks?.length) return -1;

  // Вершины, которые должны попасть в кадр при этой гипотезе
  const inFrame = peaks.filter((p) => {
    const d = Math.abs(wrapAngle(p.azimuthRad - centerAzRad));
    return p.visibility === 'visible' && d < fovRad / 2;
  });
  if (inFrame.length < 2) return -1; // одна вершина ничего не доказывает

  // Левый край кадра при этой гипотезе — абсолютный (centerAzRad абсолютен)
  const leftAzRad = wrapAngle(centerAzRad - fovRad / 2);

  let confirmed = 0;
  for (const p of inFrame) {
    // Колонка кадра под азимутом вершины
    const frac = wrapAngle(p.azimuthRad - leftAzRad) / fovRad;
    const x0 = frac * frameElev.length;
    const winCols = Math.max(1, Math.round((ANCHOR_WINDOW_RAD / fovRad) * frameElev.length));
    // Ищем локальный максимум профиля рядом с этой колонкой
    let best = NaN;
    for (let x = Math.round(x0) - winCols; x <= Math.round(x0) + winCols; x++) {
      const v = frameElev[((x % frameElev.length) + frameElev.length) % frameElev.length];
      if (Number.isFinite(v) && (!Number.isFinite(best) || v > best)) best = v;
    }
    if (!Number.isFinite(best)) continue;
    if (Math.abs(best - p.elevationRad) < ANCHOR_ELEV_TOL_RAD) {
      confirmed++;
    }
  }
  return confirmed / inFrame.length;
}
