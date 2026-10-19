/**
 * Линия неба по «текстуре под кромкой» — классическая замена нейросети,
 * устойчивая к облакам.
 *
 * Небо и облака гладкие (мало мелкой фактуры), а склоны, скалы, лес и луга
 * фактурны. Поэтому граница неба — это строка, над которой фактуры нет, а
 * под которой она есть. Кромка тёмной тучи (контрастная, но гладкая по обе
 * стороны) такой не получает, а дымчатый дальний хребет с едва заметным
 * перепадом яркости — получает. Фактура считается на кадре шириной ~640 px
 * (этого хватает: точное положение потом доводит photo-skyline.ts по
 * полному разрешению), поиск линии — динамическим программированием по
 * колонкам, ~20–40 мс на телефоне.
 */

/** Ширина рабочего кадра, px */
const WORK_WIDTH = 640;
/** Окно «над/под кромкой», доля высоты рабочего кадра */
const WINDOW_FRAC = 0.035;
/** Порог фактуры в шумах неба: фактурной считается строка выше этого */
const THETA_NOISE_K = 3.5;
/** Нижний предел порога фактуры, уровни яркости 0…255 */
const THETA_MIN = 0.8;
/** Небо оценивается по верхней доле кадра */
const NOISE_ROWS_FRAC = 0.25;
/** Верхняя полоса кадра, где линию не ищем, доля высоты */
const TOP_MARGIN_FRAC = 0.03;
/** Максимальный сдвиг линии между соседними колонками, строк */
const MAX_JUMP = 2;
/** Штраф за ступеньку в сумме оценок */
const JUMP_PENALTY = 0.002;
/** Вес перепада цвета в оценке (остальное — вклад самой фактуры) */
const STEP_BASE = 0.15;
/** Колонка с оценкой кромки ниже этой — «неба нет» (NaN) */
const MIN_COLUMN_SCORE = 0.35;

/** Среднее по окну (2k+1) вдоль строки с краевым повтором */
function boxRows(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  k: number,
): void {
  const n = 2 * k + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let i = -k; i <= k; i++) s += src[o + Math.min(w - 1, Math.max(0, i))];
    dst[o] = s / n;
    for (let x = 1; x < w; x++) {
      s += src[o + Math.min(w - 1, x + k)] - src[o + Math.max(0, x - k - 1)];
      dst[o + x] = s / n;
    }
  }
}

/** Среднее по окну (2k+1) вдоль столбца с краевым повтором */
function boxCols(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  k: number,
): void {
  const n = 2 * k + 1;
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -k; i <= k; i++)
      s += src[Math.min(h - 1, Math.max(0, i)) * w + x];
    dst[x] = s / n;
    for (let y = 1; y < h; y++) {
      s +=
        src[Math.min(h - 1, y + k) * w + x] -
        src[Math.max(0, y - k - 1) * w + x];
      dst[y * w + x] = s / n;
    }
  }
}

function blur(
  src: Float32Array,
  w: number,
  h: number,
  k: number,
  tmp: Float32Array,
): Float32Array {
  const out = new Float32Array(w * h);
  boxRows(src, tmp, w, h, k);
  boxCols(tmp, out, w, h, k);
  return out;
}

/**
 * Профиль линии неба по доле высоты кадра: колонки равномерной сетки
 * (первая строка «не неба»), NaN — в колонке неба нет. null — линию найти не
 * удалось (кадр слишком мал или сплошная земля).
 */
export function extractTextureSkylineProfile(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array | null {
  if (width < 160 || height < 90) return null;
  const f = Math.max(1, Math.round(width / WORK_WIDTH));
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const n = w * h;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const area = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let dy = 0; dy < f; dy++) {
        let p = ((y * f + dy) * width + x * f) * 4;
        for (let dx = 0; dx < f; dx++, p += 4) {
          sr += rgba[p];
          sg += rgba[p + 1];
          sb += rgba[p + 2];
        }
      }
      const i = y * w + x;
      r[i] = sr / area;
      g[i] = sg / area;
      b[i] = sb / area;
    }
  }

  const tmp = new Float32Array(n);
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++)
    lum[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
  // Мелкая фактура: отклонение от среднего 3×3, усреднённое по 5×5
  const lumBlur = blur(lum, w, h, 1, tmp);
  for (let i = 0; i < n; i++) lumBlur[i] = Math.abs(lum[i] - lumBlur[i]);
  const tex = blur(lumBlur, w, h, 2, tmp);

  const noiseRows = Math.max(1, Math.floor(h * NOISE_ROWS_FRAC));
  const noiseSample = tex.slice(0, noiseRows * w).sort();
  const noise = noiseSample[noiseSample.length >> 1];
  const theta = Math.max(THETA_MIN, THETA_NOISE_K * noise);

  // Доля фактурных строк (сглаженная по x) над и под кромкой, окно L
  const smoothed = new Float32Array(n);
  for (let i = 0; i < n; i++) smoothed[i] = tex[i] > theta ? 1 : 0;
  boxRows(smoothed, tmp, w, h, 2);
  const cs = new Float32Array((h + 1) * w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++)
      cs[(y + 1) * w + x] = cs[y * w + x] + tmp[y * w + x];
  }
  const L = Math.max(3, Math.round(WINDOW_FRAC * h));

  // Перепад цвета (яркость по каналам) — вторичный признак
  const d = Math.max(1, Math.floor(h / 240));
  const rb = blur(r, w, h, 1, tmp);
  const gb = blur(g, w, h, 1, tmp);
  const bb = blur(b, w, h, 1, tmp);
  const step = new Float32Array(n);
  let stepMax = 1e-6;
  for (let y = d; y < h - d; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = (y + d) * w + x;
      const c = (y - d) * w + x;
      const v =
        Math.abs(rb[a] - rb[c]) +
        Math.abs(gb[a] - gb[c]) +
        Math.abs(bb[a] - bb[c]);
      step[i] = v;
      if (v > stepMax) stepMax = v;
    }
  }

  // Оценки в порядке «колонка за колонкой»: P[x * h + y]
  const P = new Float32Array(n);
  const edge = new Float32Array(n);
  const topRow = Math.floor(TOP_MARGIN_FRAC * h);
  for (let x = 0; x < w; x++) {
    for (let y = topRow; y < h; y++) {
      const a0 = Math.max(0, y - L);
      const b1 = Math.min(h, y + L);
      const above = y > a0 ? (cs[y * w + x] - cs[a0 * w + x]) / (y - a0) : 0;
      const below = b1 > y ? (cs[b1 * w + x] - cs[y * w + x]) / (b1 - y) : 0;
      const score = below * (1 - above);
      edge[x * h + y] = score;
      P[x * h + y] = score * (STEP_BASE + step[y * w + x] / stepMax);
    }
  }

  // Динамическое программирование по колонкам
  const back = new Int8Array(n);
  let prev = new Float32Array(h);
  let cur = new Float32Array(h);
  for (let y = 0; y < h; y++) prev[y] = P[y];
  for (let x = 1; x < w; x++) {
    const o = x * h;
    for (let y = 0; y < h; y++) {
      let best = -1e9;
      let arg = 0;
      for (let dy = -MAX_JUMP; dy <= MAX_JUMP; dy++) {
        const py = y - dy;
        if (py < 0 || py >= h) continue;
        const v = prev[py] - JUMP_PENALTY * Math.abs(dy);
        if (v > best) {
          best = v;
          arg = dy;
        }
      }
      cur[y] = best + P[o + y];
      back[o + y] = arg;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  let y = 0;
  for (let i = 1; i < h; i++) if (prev[i] > prev[y]) y = i;
  const profile = new Float32Array(w);
  let valid = 0;
  for (let x = w - 1; x >= 0; x--) {
    // Нет перехода «гладко → фактурно» (сплошная земля, туман, небо без
    // горизонта) — в колонке линии нет
    const ok = edge[x * h + y] >= MIN_COLUMN_SCORE && y > topRow && y < h - L;
    profile[x] = ok ? y / h : NaN;
    if (ok) valid++;
    y -= back[x * h + y];
  }
  return valid >= w * 0.2 ? profile : null;
}
