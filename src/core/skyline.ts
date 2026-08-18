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

import { wrapAngle } from "./geo";
import { matchSkylineCoarse } from "./skyline-match";

/** Ширина рабочей сетки: больше не нужно, гребень — крупная форма */
const GRID_W = 160;
const GRID_H = 120;

// Веса и пороги экстрактора. Подобраны на синтетике (test/skyline-weather.test.ts:
// матрица «погода × рельеф»), менять — только вместе с прогоном той матрицы.

/**
 * Вес скачка текстуры «внизу шершаво — вверху гладко» относительно
 * градиентных членов. Сами градиенты входят в силу как dY + dC + 0.5·dS
 * (яркость, цвет B−R, насыщенность) — см. edgeAll.
 */
const W_TEX = 5.0;
/** Скачок текстуры слабее этого — сенсорный шум, а не признак */
const TEX_JUMP_MIN = 0.004;
/** Потолок текстурного члена: не должен перекрикивать градиенты */
const TEX_CAP = 0.06;
/** Полуокно вертикальных полос текстуры вокруг кандидата, строк */
const TEX_WIN = 4;

/** Проверка «небо сверху»: средняя локальная текстура выше кандидата */
const SKY_TEX_MAX = 0.015;
/** Проверка «небо сверху»: σ яркости выше кандидата (градиент неба допустим) */
const SKY_STD_MAX = 0.12;

/** ДП: штраф за излом линии λ·|Δy|^1.5 — приор непрерывности горизонта */
const DP_LAMBDA = 0.02;
/** ДП: наибольший перепад линии между соседними колонками, строк сетки */
const DP_MAX_STEP = 6;
/** ДП: цена колонки без границы; слабее этого уровня границе не верим */
const DP_NONE_COST = 0.04;
/**
 * ДП: цена ВОЗОБНОВЛЕНИЯ линии после разрыва (переход NONE→y). Без неё
 * линия бесплатно соскакивала с гребня на одиночный сильный выброс ниже
 * (фонарь, блик): выгода −strength доставалась даром. Теперь выброс должен
 * окупить вход, а честный гребень окупает его серией колонок.
 */
const DP_ENTER_COST = 0.25;

/**
 * Окно поиска обратного перепада вокруг кандидата, строк сетки. Граница
 * «небо/земля» — ступенька: ниже неё земля тянется до низа кадра, выше —
 * небо до верха. Фонарь и снежное поле — импульс: через несколько строк
 * яркость возвращается обратным перепадом. 20 строк хватает и на точечные
 * огни, и на поля высотой ~15 строк.
 */
const PULSE_WIN = 20;
/** Обратный перепад сильнее этой доли основного — кандидат импульс, не граница */
const PULSE_RATIO = 0.7;
/**
 * ...но не слабее этого абсолютного уровня: пятна текстуры склона дают
 * обратные перепады всегда, и без абсолютного порога каждая вторая колонка
 * леса объявлялась бы «импульсом»
 */
const PULSE_ABS = 0.05;

/**
 * «Граница неба — самая верхняя значимая граница колонки»: перепад выше
 * кандидата сильнее этого уровня отбрасывает кандидата (снежные поля,
 * поляны, нижние кромки фонарей лежат НИЖЕ гребня)
 */
const EDGE_ABOVE_MIN = 0.1;
/** ...или сильнее этой доли собственной силы кандидата */
const EDGE_ABOVE_RATIO = 0.5;

/**
 * Профиль неба из кадра: для каждой из GRID_W колонок — доля высоты кадра,
 * на которой проходит граница «небо / земля» (0 — верх кадра, 1 — низ).
 * NaN, если в колонке границы нет (сплошное небо, сплошная земля, засветка).
 *
 * Вместо поколоночного порога Оцу (он ломался на закате — «синева»
 * отрицательна, в дымке — ловил ближний склон, в пасмурность — снежные поля)
 * здесь глобально-согласованная линия (план docs/SKYLINE-EXTRACT-NEXT.md,
 * подход A):
 *
 * 1. Каждой ячейке ставится в соответствие СИЛА кандидата — сумма модулей
 *    вертикальных градиентов яркости, цветового вектора и насыщенности плюс
 *    скачок текстуры. Признаки — про ПЕРЕПАД, а не про абсолютный цвет,
 *    поэтому работают на закате (небо оранжевое — всё равно другого вектора,
 *    чем склон), в пасмурность и ночью (знак перепада не используется).
 * 2. Кандидат обязан пройти проверку «небо сверху»: область выше него гладкая
 *    (низкая локальная текстура) и однородная по яркости. Снежное поле на
 *    склоне её проваливает — над ним шершавый лес/скалы.
 * 3. Линия выбирается динамическим программированием слева направо: сила
 *    кандидатов минус штраф за излом, с состоянием NONE («в этой колонке
 *    границы нет»). Физический приор непрерывности горизонта вшит в штрафы:
 *    слабая, но непрерывная линия дальнего гребня выигрывает у сильной,
 *    но рваной линии «туман/ближний склон».
 */
export function extractSkyline(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const { lum, cbr, sat } = downsampleFeatures(rgba, width, height);
  const W = GRID_W;
  const H = GRID_H;

  // Локальная текстура яркости: |отклонение от среднего четырёх соседей|.
  // Считается по сглаженной 3×3 яркости: белый сенсорный шум (небо ночью)
  // бокс-фильтр давит втрое, а текстура леса после даунскейла живёт на
  // масштабе нескольких ячеек и выживает.
  const smooth = box3x3(lum);
  const tex = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      tex[i] =
        Math.abs(
          4 * smooth[i] -
            smooth[i - 1] -
            smooth[i + 1] -
            smooth[i - W] -
            smooth[i + W],
        ) / 4;
    }
  }

  // Интегральные суммы по колонкам: текстура, яркость, яркость².
  // pref[x + (y+1)·W] — сумма по строкам [0..y] включительно: проверка
  // «небо сверху» и полосы текстуры считаются за O(1) на кандидата.
  const prefT = new Float32Array(W * (H + 1));
  const prefY = new Float32Array(W * (H + 1));
  const prefY2 = new Float32Array(W * (H + 1));
  for (let x = 0; x < W; x++) {
    let st = 0;
    let sy = 0;
    let sy2 = 0;
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      st += tex[i];
      sy += lum[i];
      sy2 += lum[i] * lum[i];
      const p = (y + 1) * W + x;
      prefT[p] = st;
      prefY[p] = sy;
      prefY2[p] = sy2;
    }
  }

  // Сырые перепады по всей высоте: правилам «импульс» и «сильная граница
  // выше» нужны соседи кандидата, в том числе вне диапазона [Y_MIN..Y_MAX].
  // Знак перепада яркости храним: ночью граница может быть инвертированной,
  // поэтому в силу идёт модуль, а знак нужен только для поиска обратного хода.
  const dYsignedAll = new Float32Array(W * H);
  const edgeAll = new Float32Array(W * H); // dY+dC+0.5·dS, без текстуры
  for (let x = 0; x < W; x++) {
    for (let y = 1; y < H - 1; y++) {
      const i = y * W + x;
      const dYs = (lum[i + W] - lum[i - W]) / 2;
      dYsignedAll[i] = dYs;
      edgeAll[i] =
        Math.abs(dYs) +
        Math.abs(cbr[i + W] - cbr[i - W]) / 2 +
        (Math.abs(sat[i + W] - sat[i - W]) / 2) * 0.5;
    }
  }
  // Префиксный максимум edgeAll по колонке — «самая сильная граница выше» за O(1)
  const prefMaxEdge = new Float32Array(W * (H + 1));
  for (let x = 0; x < W; x++) {
    let m = 0;
    for (let y = 0; y < H; y++) {
      m = Math.max(m, edgeAll[y * W + x]);
      prefMaxEdge[(y + 1) * W + x] = m;
    }
  }

  // Карта силы кандидатов
  const Y_MIN = 3; // нужна окрестность для градиентов и текстурных полос
  const Y_MAX = H - TEX_WIN - 2;
  const strength = new Float32Array(W * H);
  for (let x = 0; x < W; x++) {
    for (let y = Y_MIN; y <= Y_MAX; y++) {
      const i = y * W + x;
      const dYsigned = dYsignedAll[i];
      const dY = Math.abs(dYsigned);
      // Импульс или ступенька: у фонаря и снежного поля яркость возвращается
      // обратным перепадом сопоставимой силы. Смотрим В ОБЕ стороны: нижнюю
      // кромку фонаря отдаёт верхняя и наоборот. Своя «тень» центральной
      // разности (соседние строки) исключена.
      if (dY > 0.02) {
        const s = Math.sign(dYsigned);
        const need = Math.max(PULSE_RATIO * dY, PULSE_ABS);
        const lo = Math.max(1, y - PULSE_WIN);
        const hi = Math.min(H - 2, y + PULSE_WIN);
        let pulsed = false;
        for (let y2 = lo; y2 <= hi; y2++) {
          if (Math.abs(y2 - y) < 2) continue;
          if (-s * dYsignedAll[y2 * W + x] > need) {
            pulsed = true;
            break;
          }
        }
        if (pulsed) continue;
      }
      // Граница неба — самая верхняя значимая граница колонки: выше неё
      // только небо. Кандидаты ниже сильного перепада (снежные поля, поляны,
      // нижние кромки огней) лежат на склоне. Максимум берём по [0, y−2]:
      // строка y−1 несёт «тень» самого кандидата (центральная разность
      // размазывает перепад на две строки).
      const above = prefMaxEdge[(y - 1) * W + x];
      if (above > Math.max(EDGE_ABOVE_MIN, EDGE_ABOVE_RATIO * edgeAll[i]))
        continue;
      // «Небо сверху»: от верха кадра до кандидата — гладко и однородно.
      // При y < 8 данных мало, чтобы карать, — проверку пропускаем.
      if (y >= 8) {
        const meanT = prefT[y * W + x] / y;
        if (meanT > SKY_TEX_MAX) continue;
        const meanY = prefY[y * W + x] / y;
        const varY = prefY2[y * W + x] / y - meanY * meanY;
        if (varY > SKY_STD_MAX * SKY_STD_MAX) continue;
      }
      // Скачок текстуры: ниже кандидата шершаво (лес/скалы), выше гладко
      // (небо). Ключ к «лес в тени vs небо в дымке»: яркости равны,
      // а текстура — нет.
      const tBelow =
        (prefT[(y + 1 + TEX_WIN) * W + x] - prefT[(y + 1) * W + x]) / TEX_WIN;
      const a0 = Math.max(0, y - TEX_WIN);
      const tAbove =
        (prefT[y * W + x] - prefT[a0 * W + x]) / Math.max(1, y - a0);
      const jump = Math.max(0, tBelow - tAbove - TEX_JUMP_MIN);
      strength[i] = edgeAll[i] + W_TEX * Math.min(jump, TEX_CAP);
    }
  }

  return dynamicProgrammingProfile(strength, Y_MIN, Y_MAX);
}

/**
 * Выбор линии динамическим программированием слева направо.
 *
 * Состояния колонки: строка кандидата y ∈ [yMin..yMax] или NONE («границы
 * нет»). NONE бесплатна; узел линии стоит (DP_NONE_COST − strength): граница
 * должна окупить «цену обнаружения», иначе колонке честно ставится NONE.
 * Переход y'→y штрафуется за излом λ·|Δy|^1.5 при |Δy| ≤ DP_MAX_STEP;
 * уход в NONE бесплатен, возобновление после разрыва стоит DP_ENTER_COST,
 * поэтому линия может «перескочить» через засвеченные или затянутые облаком
 * колонки, но не соскочить на одиночный выброс ниже гребня.
 */
function dynamicProgrammingProfile(
  strength: Float32Array,
  yMin: number,
  yMax: number,
): Float32Array {
  const W = GRID_W;
  const NY = yMax - yMin + 1;
  // Родитель для отката: y'−yMin или −1 = из NONE
  const parent = new Int16Array(W * NY);
  const parentNone = new Int16Array(W); // −1 = из NONE предыдущей колонки

  let dpPrev = new Float64Array(NY);
  let dpPrevNone = 0;
  for (let yi = 0; yi < NY; yi++) {
    dpPrev[yi] = DP_NONE_COST - strength[(yi + yMin) * W];
    parent[yi] = -1;
  }
  parentNone[0] = -1;

  for (let x = 1; x < W; x++) {
    const dp = new Float64Array(NY);
    let bestPrev = Infinity;
    let bestPrevIdx = -1;
    for (let yi = 0; yi < NY; yi++) {
      if (dpPrev[yi] < bestPrev) {
        bestPrev = dpPrev[yi];
        bestPrevIdx = yi;
      }
    }
    const dpNone = Math.min(dpPrevNone, bestPrev);
    parentNone[x] = dpPrevNone <= bestPrev ? -1 : bestPrevIdx;

    for (let yi = 0; yi < NY; yi++) {
      let best = dpPrevNone + DP_ENTER_COST; // возобновление после разрыва платно
      let par = -1;
      const lo = Math.max(0, yi - DP_MAX_STEP);
      const hi = Math.min(NY - 1, yi + DP_MAX_STEP);
      for (let yj = lo; yj <= hi; yj++) {
        const dy = Math.abs(yj - yi);
        const c = dpPrev[yj] + DP_LAMBDA * Math.pow(dy, 1.5);
        if (c < best) {
          best = c;
          par = yj;
        }
      }
      dp[yi] = best + DP_NONE_COST - strength[(yi + yMin) * W + x];
      parent[x * NY + yi] = par;
    }
    dpPrev = dp;
    dpPrevNone = dpNone;
  }

  // Откат от лучшего конечного состояния
  let bestFinal = dpPrevNone;
  let cur = -1; // −1 = NONE
  for (let yi = 0; yi < NY; yi++) {
    if (dpPrev[yi] < bestFinal) {
      bestFinal = dpPrev[yi];
      cur = yi;
    }
  }
  const profile = new Float32Array(W).fill(NaN);
  for (let x = W - 1; x >= 0; x--) {
    if (cur >= 0) {
      profile[x] = (cur + yMin) / GRID_H;
      cur = parent[x * NY + cur];
    } else {
      cur = parentNone[x];
    }
  }
  return profile;
}

/** Три канала признаков на ячейку сетки */
interface FeatureGrid {
  /** Яркость 0…1 */
  lum: Float32Array;
  /** Цветовой вектор (B−R)/255: небо и земля различаются даже при равной яркости */
  cbr: Float32Array;
  /** Насыщенность 0…1 */
  sat: Float32Array;
}

/** Кадр → сетка GRID_W×GRID_H трёх признаков (усреднение по ячейкам) */
function downsampleFeatures(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): FeatureGrid {
  const n = GRID_W * GRID_H;
  const lum = new Float32Array(n);
  const cbr = new Float32Array(n);
  const sat = new Float32Array(n);
  const counts = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(GRID_H - 1, ((y / height) * GRID_H) | 0);
    for (let x = 0; x < width; x++) {
      const gx = Math.min(GRID_W - 1, ((x / width) * GRID_W) | 0);
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const cell = gy * GRID_W + gx;
      lum[cell] += (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      cbr[cell] += (b - r) / 255;
      sat[cell] += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      counts[cell]++;
    }
  }
  for (let i = 0; i < n; i++) {
    if (counts[i]) {
      lum[i] /= counts[i];
      cbr[i] /= counts[i];
      sat[i] /= counts[i];
    }
  }
  return { lum, cbr, sat };
}

/** Бокс-фильтр 3×3 по яркости сетки (подавление белого шума перед текстурой) */
function box3x3(src: Float32Array): Float32Array {
  const W = GRID_W;
  const H = GRID_H;
  const out = Float32Array.from(src);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      out[i] =
        (src[i - W - 1] +
          src[i - W] +
          src[i - W + 1] +
          src[i - 1] +
          src[i] +
          src[i + 1] +
          src[i + W - 1] +
          src[i + W] +
          src[i + W + 1]) /
        9;
    }
  }
  return out;
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
  peaks?: import("./horizon").VisiblePeak[];
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
    const a =
      horizon[((i0 % horizon.length) + horizon.length) % horizon.length];
    const b =
      horizon[(((i0 + 1) % horizon.length) + horizon.length) % horizon.length];
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
    let azRange =
      seed.az === 0 && seed.tilt === 0 ? maxAzRad : (3 * Math.PI) / 180;
    let tiltRange =
      seed.az === 0 && seed.tilt === 0 ? maxTiltRad : (1.5 * Math.PI) / 180;
    let azCenter = seed.az;
    let tiltCenter = seed.tilt;

    for (let pass = 0; pass < 3; pass++) {
      for (
        let az = azCenter - azRange;
        az <= azCenter + azRange + 1e-9;
        az += azStep
      ) {
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
  if (
    coarseBest &&
    Math.abs(
      wrapAngle(best.az - wrapAngle(coarseBest.centerAzRad - centerAzRad)),
    ) <
      (1 * Math.PI) / 180
  ) {
    // Ответ совпал с гипотезой грубого поиска — учитываем её качество
    confidence *= Math.min(1, coarseBest.uniqueness / 1.5);
    if (coarseBest.anchorScore >= 0.6)
      confidence = Math.min(1, confidence + 0.2);
    else if (coarseBest.anchorScore === 0 && options.peaks?.length)
      confidence *= 0.5;
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
