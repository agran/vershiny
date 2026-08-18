/**
 * Быстрое преобразование Фурье по основанию 2 (Кули—Тьюки, итеративное).
 *
 * Своя реализация вместо зависимости: нужен ровно один размер (4096) и
 * ничего больше. Используется круговой корреляцией профилей в
 * core/skyline-match.ts.
 */

/** Бит-реверсная перестановка индексов */
function bitReverse(n: number): Uint32Array {
  const bits = Math.log2(n);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
    out[i] = r;
  }
  return out;
}

const revCache = new Map<number, Uint32Array>();

/**
 * Комплексное БПФ. re/im — действительная и мнимая части, длина — степень 2.
 * inverse=true — обратное преобразование (без деления на n: вызывающий делит).
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  let rev = revCache.get(n);
  if (!rev) {
    rev = bitReverse(n);
    revCache.set(n, rev);
  }
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = ((inverse ? 1 : -1) * 2 * Math.PI) / size;
    const wRe = Math.cos(step);
    const wIm = Math.sin(step);
    for (let start = 0; start < n; start += size) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}
