/**
 * Временна́я стабилизация профиля неба (план docs/SKYLINE-EXTRACT-NEXT.md,
 * подход C): кольцевой буфер профилей последних кадров видео.
 *
 * Зачем: граница «небо / гора» стоит на месте, а граница «небо / облако»
 * ползёт (облака движутся), блики и фонари прыгают. Временна́я дисперсия
 * y(x) после выравнивания дрожания камеры — физически честный детектор
 * настоящего горизонта, недоступный ни одному покадровому признаку.
 * Побочный выигрыш: медиана по кадрам давит шум сенсора — ночью граница
 * проявляется там, где на одном кадре её нет.
 *
 * Выравнивание — кросс-корреляцией профилей (прямой перебор малого окна
 * сдвигов дешевле БПФ на 160 колонках), НЕ гироскопом: deviceorientation
 * шлёт события с нестабильной частотой и своим шумом.
 */

export interface StabilizedSkyline {
  /**
   * Помедианный по времени профиль: NaN там, где границы нет, наблюдений
   * мало или линия нестабильна (облако, блик).
   */
  profile: Float32Array;
  /**
   * Временна́я дисперсия по колонкам в долях высоты кадра (NaN — наблюдений
   * мало): метрика пригодности колонки для матчера.
   */
  variance: Float32Array;
  /** Сдвиг последнего кадра относительно опорного профиля, колонок сетки */
  shift: number;
}

export class SkylineTracker {
  private buffer: Float32Array[] = [];
  /** Последний выданный помедианный профиль — опора для выравнивания */
  private reference: Float32Array | null = null;

  constructor(
    /** Сколько последних кадров держать (~0.5 с видео) */
    private readonly maxFrames = 10,
    /**
     * Временно́й разброс больше этого (доли высоты кадра) — колонке не верим:
     * настоящий горизонт стоит, облако над гребнем ползёт
     */
    private readonly maxJitter = 0.03,
    /** Наибольший сдвиг между кадрами от дрожания рук, колонок сетки */
    private readonly maxShift = 6,
    /** Наименьшее число не-NaN наблюдений колонки для вывода */
    private readonly minObservations = 3,
  ) {}

  reset(): void {
    this.buffer.length = 0;
    this.reference = null;
  }

  /** Добавить профиль очередного кадра; вернуть стабилизированный */
  push(raw: Float32Array): StabilizedSkyline {
    const ref = this.reference;
    const shift = ref ? estimateShift(raw, ref, this.maxShift) : 0;
    const aligned = shiftProfile(raw, shift);
    this.buffer.push(aligned);
    if (this.buffer.length > this.maxFrames) this.buffer.shift();
    const out = this.aggregate(shift);
    // Опора следующего кадра — помедианный профиль: он чище одиночного кадра
    if (countDefined(out.profile) >= 8) this.reference = out.profile;
    return out;
  }

  /** Медиана и дисперсия по буферу для каждой колонки */
  private aggregate(shift: number): StabilizedSkyline {
    const w = this.buffer[0]?.length ?? 0;
    const profile = new Float32Array(w).fill(NaN);
    const variance = new Float32Array(w).fill(NaN);
    const single = this.buffer.length === 1;
    const values: number[] = [];
    for (let x = 0; x < w; x++) {
      values.length = 0;
      for (const frame of this.buffer) {
        const v = frame[x];
        if (!Number.isNaN(v)) values.push(v);
      }
      if (single) {
        // Один кадр: возвращаем как есть, дисперсия нулевая — режим
        // совместимости с покадровой калибровкой
        profile[x] = this.buffer[0][x];
        variance[x] = Number.isNaN(profile[x]) ? NaN : 0;
        continue;
      }
      if (values.length < this.minObservations) continue;
      values.sort((a, b) => a - b);
      const med = values[values.length >> 1];
      let varT = 0;
      for (const v of values) varT += (v - med) ** 2;
      varT /= values.length;
      variance[x] = varT;
      // Нестабильная колонка (облако, блик) — честный NaN, а не мусор
      profile[x] = Math.sqrt(varT) > this.maxJitter ? NaN : med;
    }
    return { profile, variance, shift };
  }
}

function countDefined(profile: Float32Array): number {
  let n = 0;
  for (const v of profile) if (!Number.isNaN(v)) n++;
  return n;
}

/**
 * Сдвиг профиля `raw` относительно `ref`: s минимизирует Σ(raw[x+s]−ref[x])²
 * по колонкам, где оба значения есть. Дрожание рук — единицы колонок,
 * поэтому прямой перебор малого окна вместо БПФ.
 */
function estimateShift(
  raw: Float32Array,
  ref: Float32Array,
  maxShift: number,
): number {
  let bestS = 0;
  let bestErr = Infinity;
  for (let s = -maxShift; s <= maxShift; s++) {
    let err = 0;
    let n = 0;
    for (let x = 0; x < ref.length; x++) {
      const xr = x + s;
      if (xr < 0 || xr >= raw.length) continue;
      const a = raw[xr];
      const b = ref[x];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      err += (a - b) ** 2;
      n++;
    }
    // Общих колонок мало — сравнение бессмысленно, такой сдвиг не берём
    if (n < 20) continue;
    err /= n;
    if (err < bestErr) {
      bestErr = err;
      bestS = s;
    }
  }
  return bestS;
}

/** Сдвиг профиля на s колонок (out[x] = raw[x+s]); края — NaN */
function shiftProfile(raw: Float32Array, s: number): Float32Array {
  const out = new Float32Array(raw.length);
  for (let x = 0; x < raw.length; x++) {
    const xr = x + s;
    out[x] = xr < 0 || xr >= raw.length ? NaN : raw[xr];
  }
  return out;
}
