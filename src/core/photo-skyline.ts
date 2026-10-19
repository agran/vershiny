/**
 * Линия неба на фото в пикселях кадра — вход калибровки по фото
 * (core/photo-fit.ts).
 *
 * Экстрактор skyline.ts отдаёт 160 колонок на сетке 160×120: для поиска
 * сдвига этого достаточно, а для подгонки фокусного и крена — нет (ячейка
 * сетки на кадре 1280×720 — 8×6 px, то есть ~0.3° угла). Поэтому грубая
 * линия экстрактора служит лишь затравкой: в полосе вокруг неё каждая
 * колонка полного разрешения ищет свой максимум вертикального перепада
 * (яркость + цвет + насыщенность) с параболической субпиксельной доводкой.
 * Дальше медианный фильтр по соседним колонкам убирает одиночные срывы.
 */

import { extractSkylineDetailed } from "./skyline";
import { extractTextureSkylineProfile } from "./photo-skyline-texture";

/** Колонок грубого профиля экстрактора (GRID_W в skyline.ts) */
const COARSE_COLUMNS = 160;
/** Строк грубой сетки экстрактора (GRID_H в skyline.ts) */
const COARSE_ROWS = 120;
/** Полуширина горизонтального усреднения перед градиентом, колонок кадра */
const SMOOTH_HALF = 2;
/** Срыв точки от медианы окна больше этой доли высоты кадра — выброс */
const OUTLIER_FRAC = 0.012;
/** Окно медианы по соседним точкам (нечётное) */
const MEDIAN_WINDOW = 5;
/**
 * Полоса поиска перепада вокруг затравки нейросети, доля высоты кадра:
 * граница по карте глубины ошибается на пару строк её сетки, а не на десятки
 */
const NN_SEED_BAND_FRAC = 0.008;

/** Линия неба: точки в пикселях ПОЛНОГО кадра, левый-верхний угол — (0, 0) */
export interface SkylinePoints {
  x: Float32Array;
  y: Float32Array;
  /** Вес точки 0…1 (доверие грубого экстрактора) */
  w: Float32Array;
  /** Чем получена линия: по перепаду яркости, по текстуре под кромкой или по затравке */
  source?: "classic" | "texture" | "seed";
}

export interface PhotoSkylineOptions {
  /** Сколько точек оставить (равномерно по ширине) */
  maxPoints?: number;
  /**
   * Готовая грубая линия (граница неба по нейросети) вместо классического
   * экстрактора: доли высоты кадра по колонкам равномерной сетки, NaN —
   * неба нет. Колонки полного разрешения всё равно доводятся по перепаду.
   */
  seed?: Float32Array;
  /**
   * Затравка по «текстуре под кромкой» (photo-skyline-texture.ts) вместо
   * экстрактора яркостного перепада: не принимает за горы кромку тучи.
   * Игнорируется, если задан seed или линию найти не удалось (тогда
   * работает обычный экстрактор).
   */
  texture?: boolean;
}

/** Сильнейший вертикальный перепад в полосе [lo, hi] колонки */
function bestEdgeRow(
  lum: Float32Array,
  cbr: Float32Array,
  sat: Float32Array,
  width: number,
  height: number,
  x: number,
  lo: number,
  hi: number,
  d: number,
): { y: number; strength: number } | null {
  const half = SMOOTH_HALF;
  const x0 = Math.max(0, x - half);
  const x1 = Math.min(width - 1, x + half);
  const n = x1 - x0 + 1;
  // Усреднённые по горизонтали признаки одной колонки: шум сенсора давится,
  // а перепад «небо / земля» горизонтален и остаётся
  const at = (arr: Float32Array, y: number): number => {
    let s = 0;
    for (let xx = x0; xx <= x1; xx++) s += arr[y * width + xx];
    return s / n;
  };
  const rowLo = Math.max(d, Math.floor(lo));
  const rowHi = Math.min(height - 1 - d, Math.ceil(hi));
  if (rowHi - rowLo < 2) return null;
  const g = new Float32Array(rowHi - rowLo + 1);
  for (let y = rowLo; y <= rowHi; y++) {
    g[y - rowLo] =
      Math.abs(at(lum, y + d) - at(lum, y - d)) +
      Math.abs(at(cbr, y + d) - at(cbr, y - d)) +
      0.5 * Math.abs(at(sat, y + d) - at(sat, y - d));
  }
  let best = 0;
  for (let i = 1; i < g.length; i++) if (g[i] > g[best]) best = i;
  if (g[best] <= 1e-4) return null;
  let y = rowLo + best;
  // Парабола по трём отсчётам вокруг максимума — доли пикселя
  if (best > 0 && best < g.length - 1) {
    const a = g[best - 1];
    const b = g[best];
    const c = g[best + 1];
    const den = a - 2 * b + c;
    if (den < -1e-9) y += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  }
  // Перепад в d строк вверх и вниз: центр ступеньки — на строке y + 0.5
  // относительно центров пикселей, т. е. на y + 0.5 в координатах кромок
  return { y: y + 0.5, strength: g[best] };
}

function medianOf(values: number[]): number {
  const s = [...values].sort((p, q) => p - q);
  return s[s.length >> 1];
}

/**
 * Линия неба кадра: колонки полного разрешения с субпиксельной высотой.
 * Пустой результат — небо не нашлось (сплошная земля, туман, ночь).
 */
export function extractPhotoSkylinePoints(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: PhotoSkylineOptions = {},
): SkylinePoints {
  const empty: SkylinePoints = {
    x: new Float32Array(0),
    y: new Float32Array(0),
    w: new Float32Array(0),
  };
  if (width < COARSE_COLUMNS || height < COARSE_ROWS) return empty;
  const maxPoints = options.maxPoints ?? 400;
  let profile: Float32Array;
  let quality: ArrayLike<number>;
  let columns = COARSE_COLUMNS;
  // Строка затравки — центр ячейки грубой сетки; у нейросети граница уже
  // «первая строка не-неба», сдвига нет
  let cellH = height / COARSE_ROWS;
  let seedShift = 0.5 * cellH;
  const textureSeed =
    !options.seed && options.texture
      ? extractTextureSkylineProfile(rgba, width, height)
      : null;
  const seed = options.seed ?? textureSeed;
  let source: NonNullable<SkylinePoints["source"]> = "classic";
  if (seed && seed.length >= COARSE_COLUMNS) {
    source = textureSeed ? "texture" : "seed";
    profile = seed;
    quality = new Float32Array(profile.length).fill(1);
    columns = profile.length;
    cellH = NN_SEED_BAND_FRAC * height;
    seedShift = 0;
  } else {
    ({ profile, quality } = extractSkylineDetailed(rgba, width, height));
  }

  // Центры колонок грубой сетки и их строки в пикселях кадра
  const cellW = width / columns;
  const seedX: number[] = [];
  const seedY: number[] = [];
  const seedQ: number[] = [];
  for (let c = 0; c < columns; c++) {
    if (!Number.isFinite(profile[c])) continue;
    seedX.push((c + 0.5) * cellW);
    // Профиль хранит y / высота кадра
    seedY.push(profile[c] * height + seedShift);
    seedQ.push(Number.isFinite(quality[c]) ? quality[c] : 0.5);
  }
  if (seedX.length < columns * 0.2) return empty;

  // Признаки полного разрешения: яркость, B−R, насыщенность
  const n = width * height;
  const lum = new Float32Array(n);
  const cbr = new Float32Array(n);
  const sat = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    lum[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    cbr[i] = (b - r) / 255;
    sat[i] = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  }

  const step = Math.max(1, Math.floor(width / maxPoints));
  const d = Math.max(1, Math.round(height / 360));
  const band = 1.5 * cellH + 2;
  const px: number[] = [];
  const py: number[] = [];
  const pw: number[] = [];
  let s = 0; // индекс правого соседа в seed*, растёт вместе с x
  for (let x = Math.floor(step / 2); x < width; x += step) {
    while (s < seedX.length && seedX[s] < x) s++;
    // Затравка — линейная между соседними валидными колонками грубой
    // сетки; за пределами крайних центров — крайняя; разрыв между
    // колонками (NaN между ними) шире двух ячеек — не интерполируем
    let y0: number;
    let q: number;
    const left = s - 1;
    const right = s;
    if (left >= 0 && right < seedX.length) {
      const span = seedX[right] - seedX[left];
      if (span > 2.5 * cellW) {
        const nearLeft = x - seedX[left] < seedX[right] - x;
        const idx = nearLeft ? left : right;
        if (Math.abs(x - seedX[idx]) > 0.75 * cellW) continue;
        y0 = seedY[idx];
        q = seedQ[idx];
      } else {
        const t = (x - seedX[left]) / span;
        y0 = seedY[left] + t * (seedY[right] - seedY[left]);
        q = seedQ[left] + t * (seedQ[right] - seedQ[left]);
      }
    } else if (left >= 0 && x - seedX[left] <= 0.75 * cellW) {
      y0 = seedY[left];
      q = seedQ[left];
    } else if (right < seedX.length && seedX[right] - x <= 0.75 * cellW) {
      y0 = seedY[right];
      q = seedQ[right];
    } else {
      continue;
    }
    const edge = bestEdgeRow(
      lum,
      cbr,
      sat,
      width,
      height,
      x,
      y0 - band,
      y0 + band,
      d,
    );
    if (!edge) continue;
    px.push(x + 0.5);
    py.push(edge.y);
    pw.push(Math.max(0.1, Math.min(1, q)));
  }
  if (px.length < 8) return empty;

  // Выбросы: срыв от медианы соседних точек
  const keep: number[] = [];
  const half = MEDIAN_WINDOW >> 1;
  for (let i = 0; i < px.length; i++) {
    const win = py.slice(
      Math.max(0, i - half),
      Math.min(py.length, i + half + 1),
    );
    if (Math.abs(py[i] - medianOf(win)) <= OUTLIER_FRAC * height) keep.push(i);
  }
  const out: SkylinePoints = {
    x: new Float32Array(keep.length),
    y: new Float32Array(keep.length),
    w: new Float32Array(keep.length),
    source,
  };
  keep.forEach((i, k) => {
    out.x[k] = px[i];
    out.y[k] = py[i];
    out.w[k] = pw[i];
  });
  return out;
}
