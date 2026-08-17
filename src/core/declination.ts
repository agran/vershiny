/**
 * Магнитное склонение по World Magnetic Model (WMM-2025).
 *
 * Зачем: компас телефона отсчитывает азимут от **магнитного** севера, а
 * панорама строится от истинного. Разница — склонение — на Кавказе +7°,
 * на Камчатке −9°, в Исландии −11°: без поправки подписи гор съезжают
 * на десяток градусов, и ручная подстройка нужна при каждом запуске.
 *
 * Реализация — порт эталонного алгоритма NOAA (GeomagnetismLibrary.c,
 * общественное достояние): геодезические координаты WGS-84 → геоцентрические,
 * суммирование сферических гармоник 12-го порядка, склонение = atan2(Y, X).
 * Коэффициенты — wmm-coefficients.ts (генерируется из WMM.COF).
 * Численно сверено с pygeomag — см. test/declination.test.ts.
 *
 * Высота не учитывается (считаем на эллипсоиде): склонение меняется с ней
 * на тысячные градуса, а нам важны десятые.
 */

import { WMM_EPOCH, WMM_MAXORD, WMM_ROWS } from "./wmm-coefficients";

const SIZE = WMM_MAXORD + 1;

/** WGS-84, км */
const A = 6378.137;
const B = 6356.7523142;
/** Референс-радиус модели, км */
const RE = 6371.2;

const A2 = A * A;
const B2 = B * B;
const C2 = A2 - B2;
const A4 = A2 * A2;
const B4 = B2 * B2;
const C4 = A4 - B4;

interface Model {
  /** Ненормированные коэффициенты Гаусса: c[m][n] для g, c[n][m−1] для h */
  c: number[][];
  /** Годовой дрейф (секулярная вариация) в том же раскладе */
  cd: number[][];
  /** Коэффициенты рекурсии Лежандра и нормировки Шмидта */
  snorm: number[];
  k: number[][];
  fn: number[];
  fm: number[];
}

let model: Model | null = null;

/**
 * Раскладка коэффициентов из строк COF и снятие нормировки Шмидта.
 * Считается один раз лениво: ~200 умножений, держать их в загрузке незачем.
 */
function loadModel(): Model {
  if (model) return model;

  const c: number[][] = [];
  const cd: number[][] = [];
  const k: number[][] = [];
  for (let i = 0; i < SIZE; i++) {
    c.push(new Array<number>(SIZE).fill(0));
    cd.push(new Array<number>(SIZE).fill(0));
    k.push(new Array<number>(SIZE).fill(0));
  }
  const snorm = new Array<number>(SIZE * SIZE).fill(0);
  const fn = new Array<number>(SIZE).fill(0);
  const fm = new Array<number>(SIZE).fill(0);

  for (const [n, m, g, h, gt, ht] of WMM_ROWS) {
    c[m][n] = g;
    cd[m][n] = gt;
    if (m !== 0) {
      c[n][m - 1] = h;
      cd[n][m - 1] = ht;
    }
  }

  // Шмидтова нормировка → ненормированные коэффициенты (как в коде NOAA)
  snorm[0] = 1;
  fm[0] = 0;
  for (let n = 1; n <= WMM_MAXORD; n++) {
    snorm[n] = (snorm[n - 1] * (2 * n - 1)) / n;
    let j = 2;
    for (let m = 0; m <= n; m++) {
      k[m][n] = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
      if (m > 0) {
        const flnmj = ((n - m + 1) * j) / (n + m);
        snorm[n + m * SIZE] = snorm[n + (m - 1) * SIZE] * Math.sqrt(flnmj);
        j = 1;
        c[n][m - 1] *= snorm[n + m * SIZE];
        cd[n][m - 1] *= snorm[n + m * SIZE];
      }
      c[m][n] *= snorm[n + m * SIZE];
      cd[m][n] *= snorm[n + m * SIZE];
    }
    fn[n] = n + 1;
    fm[n] = n;
  }
  k[1][1] = 0;

  model = { c, cd, snorm, k, fn, fm };
  return model;
}

/** Десятичный год: 2026.0 + доля от начала года */
export function decimalYear(date: Date = new Date()): number {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (date.getTime() - start) / (end - start);
}

/**
 * Склонение в градусах: сколько прибавить к магнитному азимуту компаса,
 * чтобы получить истинный. Положительное — магнитный север восточнее.
 *
 * @param latDeg широта WGS-84, градусы
 * @param lonDeg долгота, градусы (восток положителен)
 * @param timeYear десятичный год; по умолчанию — сейчас. За пределами
 *   срока модели (эпоха ±5 лет) время прижимается к границе: лучше чуть
 *   устаревшее поле, чем экстраполяция дрейфа в никуда.
 */
export function magneticDeclinationDeg(
  latDeg: number,
  lonDeg: number,
  timeYear: number = decimalYear(),
): number {
  const { c, cd, snorm, k, fn, fm } = loadModel();

  // Экстраполяция дрейфа за срок жизни модели быстро расходится с реальностью
  const dt = Math.min(Math.max(timeYear - WMM_EPOCH, -1), 6);

  const rlat = (latDeg * Math.PI) / 180;
  const rlon = (lonDeg * Math.PI) / 180;
  const srlat = Math.sin(rlat);
  const crlat = Math.cos(rlat);
  const srlat2 = srlat * srlat;
  const crlat2 = crlat * crlat;

  // sp[m] = sin(m·λ), cp[m] = cos(m·λ) — по формуле сложения
  const sp = new Array<number>(SIZE).fill(0);
  const cp = new Array<number>(SIZE).fill(0);
  const pp = new Array<number>(SIZE).fill(0);
  sp[0] = 0;
  cp[0] = pp[0] = 1;
  sp[1] = Math.sin(rlon);
  cp[1] = Math.cos(rlon);
  for (let m = 2; m <= WMM_MAXORD; m++) {
    sp[m] = sp[1] * cp[m - 1] + cp[1] * sp[m - 1];
    cp[m] = cp[1] * cp[m - 1] - sp[1] * sp[m - 1];
  }

  // Геодезическая широта → геоцентрическая (считаем на эллипсоиде, h = 0)
  const q = Math.sqrt(A2 - C2 * srlat2);
  const q2 = (A2 / B2) * (A2 / B2);
  const ct = srlat / Math.sqrt(q2 * crlat2 + srlat2);
  const st = Math.sqrt(1 - ct * ct);
  const r2 = (A4 - C4 * srlat2) / (q * q);
  const r = Math.sqrt(r2);
  const d = Math.sqrt(A2 * crlat2 + B2 * srlat2);
  const ca = d / r;
  const sa = (C2 * crlat * srlat) / (r * d);

  // dp[m][n] — производные Лежандра; p — сами полиномы (плоский массив snorm
  // переиспользуется под них, как в коде NOAA: там это один буфер)
  const dp: number[][] = [];
  for (let i = 0; i < SIZE; i++) dp.push(new Array<number>(SIZE).fill(0));
  dp[0][0] = 0;
  const p = snorm;

  const tc: number[][] = [];
  for (let i = 0; i < SIZE; i++) tc.push(new Array<number>(SIZE).fill(0));

  const aor = RE / r;
  let ar = aor * aor;
  let br = 0;
  let bt = 0;
  let bp = 0;
  let bpp = 0;

  for (let n = 1; n <= WMM_MAXORD; n++) {
    ar *= aor;
    for (let m = 0; m <= n; m++) {
      // Присоединённые полиномы Лежандра и их производные — рекурсией
      if (n === m) {
        p[n + m * SIZE] = st * p[n - 1 + (m - 1) * SIZE];
        dp[m][n] = st * dp[m - 1][n - 1] + ct * p[n - 1 + (m - 1) * SIZE];
      } else if (n === 1 && m === 0) {
        p[n + m * SIZE] = ct * p[n - 1 + m * SIZE];
        dp[m][n] = ct * dp[m][n - 1] - st * p[n - 1 + m * SIZE];
      } else if (n > 1 && n !== m) {
        if (m > n - 2) {
          p[n - 2 + m * SIZE] = 0;
          dp[m][n - 2] = 0;
        }
        p[n + m * SIZE] =
          ct * p[n - 1 + m * SIZE] - k[m][n] * p[n - 2 + m * SIZE];
        dp[m][n] =
          ct * dp[m][n - 1] - st * p[n - 1 + m * SIZE] - k[m][n] * dp[m][n - 2];
      }

      // Коэффициенты на запрошенную дату
      tc[m][n] = c[m][n] + dt * cd[m][n];
      if (m !== 0) tc[n][m - 1] = c[n][m - 1] + dt * cd[n][m - 1];

      // Накопление гармоник
      const par = ar * p[n + m * SIZE];
      let temp1: number;
      let temp2: number;
      if (m === 0) {
        temp1 = tc[m][n] * cp[m];
        temp2 = tc[m][n] * sp[m];
      } else {
        temp1 = tc[m][n] * cp[m] + tc[n][m - 1] * sp[m];
        temp2 = tc[m][n] * sp[m] - tc[n][m - 1] * cp[m];
      }
      bt -= ar * temp1 * dp[m][n];
      bp += fm[m] * temp2 * par;
      br += fn[n] * temp1 * par;

      // Особый случай полюсов: st = 0, обычная ветка вырождается
      if (st === 0 && m === 1) {
        if (n === 1) pp[n] = pp[n - 1];
        else pp[n] = ct * pp[n - 1] - k[m][n] * pp[n - 2];
        bpp += fm[m] * temp2 * ar * pp[n];
      }
    }
  }

  bp = st === 0 ? bpp : bp / st;

  // Геоцентрические компоненты → геодезические: X — на север, Y — на восток
  const bx = -bt * ca - br * sa;
  const by = bp;

  return (Math.atan2(by, bx) * 180) / Math.PI;
}
