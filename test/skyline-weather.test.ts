/**
 * Погодная матрица для экстрактора линии неба (план docs/SKYLINE-EXTRACT-NEXT.md,
 * «Синтетические тесты»): 7 погодных режимов × 3 рельефа.
 *
 * Рендер — детерминированный (фиксированные зёрна PRNG): тесты ловят
 * регрессии, а не играют в рулетку. Метрики: медианная и 95-перцентильная
 * ошибка |y_est − y_true| в строках рабочей сетки 160×120, доля ложных NaN
 * (граница есть, а мы её не нашли) и ложных не-NaN (границы не видно,
 * а мы её «нашли» — хуже всего: мусор тянет совмещение).
 *
 * Пороги — приёмочные: сняты с реальных прогонов и ужаты с запасом ~×2.
 * Если экстрактор улучшается, пороги надо ужимать следом.
 */

import { describe, it, expect } from 'vitest';
import { extractSkyline } from '../src/core/skyline';
import { SkylineTracker } from '../src/core/skyline-track';

const GRID_W = 160;
const GRID_H = 120;
const deg = (d: number): number => (d * Math.PI) / 180;

// ---------------------------------------------------------------------------
// Рельефы
// ---------------------------------------------------------------------------

/** Тот же «штрихкод», что в skyline.test.ts, с масштабом амплитуды */
function makeHorizon(scale: number, rays = 3600): Float32Array {
  const horizon = new Float32Array(rays);
  for (let i = 0; i < rays; i++) {
    const az = (i / rays) * 2 * Math.PI;
    horizon[i] =
      scale *
      (deg(4) * Math.sin(az * 3) +
        deg(7) * Math.exp(-(((az - 1.0) / 0.12) ** 2)) +
        deg(5) * Math.exp(-(((az - 1.35) / 0.08) ** 2)));
  }
  return horizon;
}

const RELIEFS = {
  /** базовый: пики 5–7° над глазом */
  base: makeHorizon(1),
  /** крутой: пики до ~20° (Приют 11, стена напротив) */
  steep: makeHorizon(1.9),
  /** пологий: холмы ±2° */
  gentle: makeHorizon(0.35),
} as const;

const VIEW = { fovRad: deg(70), fovVRad: deg(40), horizonFrac: 0.62 };

// ---------------------------------------------------------------------------
// Погода
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

interface Weather {
  /** Цвет неба у верха кадра и у горизонта (вертикальный градиент) */
  skyTop: RGB;
  skyBottom: RGB;
  /** Цвет земли */
  ground: RGB;
  /** Замешивание земли в цвет неба у границы 0…1 (атмосферная перспектива) */
  haze?: number;
  /** Амплитуда пятнистой текстуры земли (лес/скалы), 0…255 */
  groundTex?: number;
  /** σ белого шума сенсора, 0…255 */
  noise?: number;
  /** Белые снежные поля на склоне ниже гребня (пасмурно) */
  snowFields?: boolean;
  /** Левая половина кадра засвечена в белое (против солнца) */
  flareLeft?: boolean;
  /** Яркие точечные фонари в нижней части кадра (сумерки) */
  lanterns?: boolean;
}

const WEATHER: Record<string, Weather> = {
  clear: {
    skyTop: [105, 145, 228],
    skyBottom: [175, 202, 242],
    ground: [70, 68, 62],
    haze: 0.1,
    groundTex: 22,
    noise: 3,
  },
  haze: {
    // Дымка: дальний гребень почти слит с небом, контраст границы ~0.08
    skyTop: [168, 178, 193],
    skyBottom: [203, 208, 214],
    ground: [128, 124, 116],
    haze: 0.55,
    groundTex: 12,
    noise: 4,
  },
  sunset: {
    // Закат: небо тёплое, «синева» отрицательна — старый экстрактор здесь слеп
    skyTop: [88, 82, 138],
    skyBottom: [238, 152, 82],
    ground: [86, 76, 70],
    haze: 0.3,
    groundTex: 16,
    noise: 4,
  },
  overcast: {
    // Пасмурно: всё серое, яркостный контраст слабый, на склоне снежные поля
    skyTop: [148, 153, 159],
    skyBottom: [182, 184, 187],
    ground: [96, 95, 90],
    haze: 0.2,
    groundTex: 14,
    noise: 3,
    snowFields: true,
  },
  twilight: {
    // Сумерки: всё тёмное, внизу фонари
    skyTop: [26, 30, 56],
    skyBottom: [72, 62, 78],
    ground: [24, 24, 28],
    haze: 0.15,
    groundTex: 7,
    noise: 7,
    lanterns: true,
  },
  againstSun: {
    skyTop: [120, 155, 225],
    skyBottom: [185, 205, 240],
    ground: [72, 70, 64],
    haze: 0.15,
    groundTex: 20,
    noise: 3,
    flareLeft: true,
  },
};

/** Возвышение горизонта на азимуте (линейная интерполяция по лучам) */
function elevAt(horizon: Float32Array, az: number): number {
  const step = (2 * Math.PI) / horizon.length;
  const idx = az / step;
  const i0 = Math.floor(idx);
  const f = idx - i0;
  const n = horizon.length;
  const a = horizon[((i0 % n) + n) % n];
  const b = horizon[(((i0 + 1) % n) + n) % n];
  return a + (b - a) * f;
}

// ---------------------------------------------------------------------------
// Детерминированный шум
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Хеш ячейки — пятна текстуры земли масштаба нескольких пикселей */
function hash2(ix: number, iy: number): number {
  let h = (ix * 374761393 + iy * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Рендер кадра по погоде
// ---------------------------------------------------------------------------

const FRAME_W = 320;
const FRAME_H = 240;

interface RenderedFrame {
  rgba: Uint8ClampedArray;
  /** Истинный профиль на сетке GRID_W: доли высоты, NaN — границы не видно */
  truth: Float32Array;
}

function renderWeatherFrame(
  horizon: Float32Array,
  azTrue: number,
  tiltTrue: number,
  weather: Weather,
  seed = 42,
): RenderedFrame {
  const step = (2 * Math.PI) / horizon.length;
  const rgba = new Uint8ClampedArray(FRAME_W * FRAME_H * 4);
  const truth = new Float32Array(GRID_W);
  const rand = mulberry32(seed);
  const haze = weather.haze ?? 0;
  const groundTex = weather.groundTex ?? 0;
  const noise = weather.noise ?? 0;
  // Облако над гребнем задаётся отдельно (weather не хранит): здесь нет

  for (let x = 0; x < FRAME_W; x++) {
    const az = azTrue + ((x + 0.5) / FRAME_W - 0.5) * VIEW.fovRad;
    const idx = az / step;
    const i0 = Math.floor(idx);
    const f = idx - i0;
    const a = horizon[((i0 % horizon.length) + horizon.length) % horizon.length];
    const b = horizon[((i0 + 1) % horizon.length + horizon.length) % horizon.length];
    const elev = a + (b - a) * f;
    const yFrac = VIEW.horizonFrac - (elev - tiltTrue) / VIEW.fovVRad;
    const boundary = yFrac * FRAME_H;
    const gx = Math.min(GRID_W - 1, Math.floor((x / FRAME_W) * GRID_W));
    // Граница за краем кадра физически не видна — честный ответ там NaN
    truth[gx] = yFrac > 0.02 && yFrac < 0.98 ? yFrac : NaN;
    // Засветка: граница физически есть, но не видна — честный ответ NaN
    const flared = !!weather.flareLeft && x < FRAME_W / 2;
    if (flared) truth[gx] = NaN;

    // Снежное поле в этой колонке: интервал строк ниже гребня
    const snow =
      !!weather.snowFields && hash2(gx, 777) < 0.35
        ? { from: boundary + 6 + 30 * hash2(gx, 778), to: boundary + 26 + 40 * hash2(gx, 779) }
        : null;

    for (let y = 0; y < FRAME_H; y++) {
      const i = (y * FRAME_W + x) * 4;
      let r: number;
      let g: number;
      let b: number;
      if (y < boundary) {
        // Небо: вертикальный градиент
        const t = Math.min(1, y / Math.max(1, boundary));
        r = weather.skyTop[0] + (weather.skyBottom[0] - weather.skyTop[0]) * t;
        g = weather.skyTop[1] + (weather.skyBottom[1] - weather.skyTop[1]) * t;
        b = weather.skyTop[2] + (weather.skyBottom[2] - weather.skyTop[2]) * t;
      } else {
        // Земля, замешанная в цвет неба у горизонта (дымка)
        r = weather.ground[0] + (weather.skyBottom[0] - weather.ground[0]) * haze;
        g = weather.ground[1] + (weather.skyBottom[1] - weather.ground[1]) * haze;
        b = weather.ground[2] + (weather.skyBottom[2] - weather.ground[2]) * haze;
        // Пятнистая текстура леса/скал
        const tex = (hash2(x >> 2, y >> 2) - 0.5) * 2 * groundTex;
        r += tex;
        g += tex;
        b += tex;
        if (snow && y >= snow.from && y <= snow.to) {
          r = 212;
          g = 214;
          b = 217;
        }
      }
      if (flared) {
        // Выбеленная половина: всё уходит в насыщение, контраст ~2%
        r = 255 - (255 - r) * 0.04;
        g = 255 - (255 - g) * 0.04;
        b = 255 - (255 - b) * 0.04;
      }
      // Шум сенсора (псевдогаусс: сумма трёх равномерных)
      const n = (rand() + rand() + rand() - 1.5) * 2 * noise;
      rgba[i] = r + n;
      rgba[i + 1] = g + n;
      rgba[i + 2] = b + n;
      rgba[i + 3] = 255;
    }
  }

  // Фонари: дюжина ярких точек в нижней части кадра
  if (weather.lanterns) {
    for (let k = 0; k < 12; k++) {
      const lx = Math.floor(rand() * FRAME_W);
      const ly = Math.floor(FRAME_H * 0.7 + rand() * FRAME_H * 0.28);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = lx + dx;
          const y = ly + dy;
          if (x < 0 || x >= FRAME_W || y < 0 || y >= FRAME_H) continue;
          const i = (y * FRAME_W + x) * 4;
          rgba[i] = 235;
          rgba[i + 1] = 215;
          rgba[i + 2] = 160;
        }
      }
    }
  }
  return { rgba, truth };
}

// ---------------------------------------------------------------------------
// Метрики
// ---------------------------------------------------------------------------

interface Metrics {
  /** Медиана ошибки по найденным колонкам, строк сетки */
  median: number;
  /** 95-й перцентиль ошибки, строк сетки */
  p95: number;
  /** Доля ложных NaN среди колонок, где граница видна */
  falseNaN: number;
  /** Доля ложных не-NaN среди колонок, где границы не видно */
  falsePos: number;
}

function evaluate(profile: Float32Array, truth: Float32Array): Metrics {
  const errs: number[] = [];
  let nTrue = 0;
  let falseNaN = 0;
  let nVoid = 0;
  let falsePos = 0;
  for (let x = 0; x < GRID_W; x++) {
    if (!Number.isNaN(truth[x])) {
      nTrue++;
      if (Number.isNaN(profile[x])) falseNaN++;
      else errs.push(Math.abs(profile[x] - truth[x]) * GRID_H);
    } else {
      nVoid++;
      if (!Number.isNaN(profile[x])) falsePos++;
    }
  }
  errs.sort((a, b) => a - b);
  return {
    median: errs.length ? errs[errs.length >> 1] : Infinity,
    p95: errs.length ? errs[Math.min(errs.length - 1, Math.floor(errs.length * 0.95))] : Infinity,
    falseNaN: nTrue ? falseNaN / nTrue : 0,
    falsePos: nVoid ? falsePos / nVoid : 0,
  };
}

// ---------------------------------------------------------------------------
// Матрица «погода × рельеф»
// ---------------------------------------------------------------------------

interface Expectation {
  median: number;
  p95: number;
  falseNaN: number;
}

// Пороги сняты с прогонов (фактические медианы 0.3–0.5 строки, p95 ≤ 2.5,
// кроме сумерек на крутом рельефе — p95 ≈ 10 из-за колонок на склонах пиков
// у края кадра) и ужаты с запасом ~×2. Улучшил экстрактор — ужми пороги.
const CASES: { name: string; weather: Weather; expect: Expectation }[] = [
  { name: 'ясно', weather: WEATHER.clear, expect: { median: 1.5, p95: 2.5, falseNaN: 0.05 } },
  { name: 'дымка', weather: WEATHER.haze, expect: { median: 1.5, p95: 2.5, falseNaN: 0.3 } },
  { name: 'закат', weather: WEATHER.sunset, expect: { median: 1.5, p95: 2.5, falseNaN: 0.1 } },
  { name: 'пасмурно со снежными полями', weather: WEATHER.overcast, expect: { median: 1.5, p95: 5, falseNaN: 0.4 } },
  { name: 'сумерки с фонарями', weather: WEATHER.twilight, expect: { median: 1.5, p95: 12, falseNaN: 0.2 } },
];

describe('экстрактор линии неба: погодная матрица', () => {
  for (const c of CASES) {
    for (const [reliefName, horizon] of Object.entries(RELIEFS)) {
      it(`${c.name} / ${reliefName}`, () => {
        const { rgba, truth } = renderWeatherFrame(horizon, deg(60), 0, c.weather);
        const profile = extractSkyline(rgba, FRAME_W, FRAME_H);
        const m = evaluate(profile, truth);
        expect(m.median).toBeLessThanOrEqual(c.expect.median);
        expect(m.p95).toBeLessThanOrEqual(c.expect.p95);
        expect(m.falseNaN).toBeLessThanOrEqual(c.expect.falseNaN);
      });
    }
  }

  it('против солнца: засвеченная половина — NaN, теневая — точная', () => {
    const { rgba, truth } = renderWeatherFrame(RELIEFS.base, deg(60), 0, WEATHER.againstSun);
    const profile = extractSkyline(rgba, FRAME_W, FRAME_H);
    const m = evaluate(profile, truth);
    // Засвеченная половина: мусора (ложных не-NaN) почти нет
    expect(m.falsePos).toBeLessThanOrEqual(0.3);
    // Теневая половина работает
    expect(m.median).toBeLessThanOrEqual(2.5);
    expect(m.falseNaN).toBeLessThanOrEqual(0.2);
  });
});

describe('облако над гребнем: временна́я стабилизация', () => {
  it('ползущее облако уходит в NaN, гребень сходится за 8 кадров', () => {
    const horizon = RELIEFS.base;
    const step = (2 * Math.PI) / horizon.length;
    const azTrue = deg(60);
    const tracker = new SkylineTracker(8);
    const truth = new Float32Array(GRID_W);

    // Истина на сетке (без облака — оно закрывает гребень в левой трети)
    for (let gx = 0; gx < GRID_W; gx++) {
      const x = ((gx + 0.5) / GRID_W) * FRAME_W;
      const az = azTrue + (x / FRAME_W - 0.5) * VIEW.fovRad;
      const idx = az / step;
      const i0 = Math.floor(idx);
      const f = idx - i0;
      const a = horizon[((i0 % horizon.length) + horizon.length) % horizon.length];
      const b = horizon[((i0 + 1) % horizon.length + horizon.length) % horizon.length];
      truth[gx] = VIEW.horizonFrac - (a + (b - a) * f) / VIEW.fovVRad;
      if (gx < GRID_W * 0.4) truth[gx] = NaN; // гребень закрыт облаком
    }

    let out: ReturnType<SkylineTracker['push']> | null = null;
    for (let k = 0; k < 8; k++) {
      // Кадр: как clear, но в левой трети гребень закрыт облаком; нижний край
      // облака ползёт по высоте от кадра к кадру — его и ловит покадровый
      // экстрактор, и только временна́я дисперсия его отбрасывает
      const { rgba } = renderWeatherFrame(horizon, azTrue, 0, WEATHER.clear, 100 + k);
      // Облачный слой: выше истинного гребня, край ползёт
      const cloudShift = 0.05 * Math.sin((2 * Math.PI * k) / 8);
      for (let gx = 0; gx < GRID_W * 0.4; gx++) {
        for (let px = gx * 2; px < gx * 2 + 2; px++) {
          // нижний край облака: на 0.1 доли кадра выше истинного гребня + ползание
          const elev = elevAt(horizon, azTrue + ((px + 0.5) / FRAME_W - 0.5) * VIEW.fovRad);
          const trueY = (VIEW.horizonFrac - elev / VIEW.fovVRad) * FRAME_H;
          const edge = trueY - (0.1 - cloudShift) * FRAME_H;
          for (let y = 0; y < FRAME_H; y++) {
            const i = (y * FRAME_W + px) * 4;
            if (y >= edge) {
              // облако: светлое, почти без текстуры
              rgba[i] = 232 + (hash2(px, y) - 0.5) * 4;
              rgba[i + 1] = 234 + (hash2(px, y) - 0.5) * 4;
              rgba[i + 2] = 238;
            }
          }
        }
      }
      const profile = extractSkyline(rgba, FRAME_W, FRAME_H);
      out = tracker.push(profile);
    }

    // Необлачная часть: гребень найден и точен
    const m = evaluate(out!.profile, truth);
    expect(m.median).toBeLessThanOrEqual(2.5);
    // Облачная треть: стабилизатор обязан выбросить ползущую линию
    expect(m.falsePos).toBeLessThanOrEqual(0.25);
  });
});
