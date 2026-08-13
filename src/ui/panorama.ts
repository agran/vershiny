/**
 * Canvas-рендер панорамы (ROADMAP неделя 2):
 * силуэт горизонта, шкала азимутов, подписи пиков с кластеризацией.
 * Проекция: x = (azimuth − centerAz)/fov · width,
 *           y = horizonY − elevationAngle/fovV · height (ARCHITECTURE.md).
 */

import { toDeg, wrapAngle } from '../core/geo';
import type { VisiblePeak } from '../core/horizon';
import { getLocale, peakName, t } from '../core/i18n';

export interface PanoramaState {
  /** Углы горизонта по лучам, рад (0 = север) — верхний слой */
  horizon: Float32Array;
  /** Шаг между лучами, рад */
  stepRad: number;
  /** Видимые пики (уже отсортированы по приоритету) */
  peaks: VisiblePeak[];
  /** Слои горизонта по дистанционным корзинам (0 = ближний) */
  layers?: Float32Array[];
  /** Дистанция до точки горизонта по лучам (для классификации пиков) */
  distanceToHorizonM?: Float32Array;
  /** Фронты видимости по лучам (для точных маркеров) */
  fronts?: import('../core/horizon').VisibleFront[][];
  /** Гребни силуэта по корзинам дистанций [корзина][луч] */
  crests?: Float32Array[];
}

export interface ViewState {
  /** Центральный азимут взгляда, рад */
  centerAzRad: number;
  /** Наклон камеры: + вверх, − вниз, рад */
  tiltRad: number;
  /** Горизонтальный FOV, рад */
  fovRad: number;
  /** Вертикальный FOV, рад */
  fovVRad: number;
}

const SKY_TOP = '#0d1b2a';
const SKY_HORIZON = '#415a77';
const SKY_BOTTOM = '#16202c';
/** Контур гребня: чёрная линия сверху, белая снизу (для наложения на кадр камеры) */
const RIDGE_DARK = 'rgba(0,0,0,0.85)';
const RIDGE_LIGHT = 'rgba(255,255,255,0.95)';
/** Толщина/сдвиг контура в CSS-пикселях (масштабируются по devicePixelRatio) */
const RIDGE_WIDTH_CSS = 1.4;
const RIDGE_OFFSET_CSS = 1.1;
/** Подписи и выноски — тот же принцип: светлое с тёмной обводкой, без плашек */
const INK_DARK = 'rgba(0,0,0,0.85)';
const INK_LIGHT = 'rgba(255,255,255,0.98)';
const INK_LIGHT_DIM = 'rgba(255,255,255,0.55)';
/** Наклон подписей вершин: все под одним углом, вправо-вверх от вершины */
const LABEL_ANGLE_DEG = 60;
/**
 * Предельная «крутизна» силуэта: рад подъёма на рад азимута. Всё, что круче,
 * считается обрывом гребня, а не склоном — полилиния там рвётся. При шаге
 * 0.1° это 1.5° на луч: настоящий склон так не скачет, а вот край гребня,
 * за которым начинается другая поверхность, — сколько угодно.
 */
export const MAX_RIDGE_SLOPE = 15;
/**
 * Сколько подписей в кадре «стоят» скрытой вершины. Бюджет тратится сначала
 * на видимые: пустой кадр отдаёт скрытым все 6 мест, плотный — ни одного.
 */
const HIDDEN_LABEL_BUDGET = 6;

/**
 * Доля высоты кадра, на которой проходит линия горизонта — чуть ниже центра,
 * чтобы небо не занимало полкадра. Экспортируется: автокалибровка (skyline.ts)
 * переводит пиксели кадра в углы по этой же величине, и разойтись они не должны.
 */
export const HORIZON_FRAC = 0.62;

/** Рендер одного кадра панорамы: небо + оверлей */
export function renderPanorama(
  ctx: CanvasRenderingContext2D,
  state: PanoramaState,
  view: ViewState,
): void {
  const { width, height } = ctx.canvas;
  const horizonY = height * HORIZON_FRAC; // линия горизонта чуть ниже центра

  // Фон — единый градиент на весь кадр (без горизонтальной «ступеньки»)
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, SKY_TOP);
  sky.addColorStop(horizonY / height, SKY_HORIZON);
  sky.addColorStop(1, SKY_BOTTOM);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  drawOverlay(ctx, state, view);
}

/**
 * Оверлей поверх любого фона: контуры гребней, шкала азимутов, подписи вершин.
 * Используется и панорамой, и AR-режимом поверх кадра камеры, поэтому ничего
 * не заливает — только контрастные линии и текст.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  state: PanoramaState,
  view: ViewState,
): void {
  const { width, height } = ctx.canvas;
  const horizonY = height * HORIZON_FRAC;

  const azToX = (az: number): number =>
    (wrapAngle(az - view.centerAzRad) / view.fovRad) * width + width / 2;
  const elevToY = (elev: number): number =>
    horizonY - ((elev - view.tiltRad) / view.fovVRad) * height;

  const { horizon, stepRad } = state;
  const layers = state.layers ?? [horizon];

  // Масштаб под плотность пикселей (canvas в devicePixelRatio раз крупнее CSS)
  const uiScale = ctx.canvas.clientWidth > 0 ? width / ctx.canvas.clientWidth : 1;

  // Профили силуэта: видимые гребни по возрастанию дистанции.
  // Гребень = локальный максимум угла вдоль луча (то, что реально видно как линия).
  const profiles: Float32Array[] = [];
  if (state.crests?.length) {
    profiles.push(...state.crests);
  } else {
    for (const layer of layers) if (layer) profiles.push(layer);
  }

  if (profiles.length) {
    const rayCount = profiles[0].length;
    const ridgeWidth = RIDGE_WIDTH_CSS * uiScale;
    const ridgeOffset = RIDGE_OFFSET_CSS * uiScale;
    // Окклюзия: гребень виден только там, где он выше всех более близких
    const runningMax = new Float32Array(rayCount).fill(-Infinity);
    const EPS = 5e-4; // ~0.03° — не рисуем «дрожание» на одном уровне

    for (const prof of profiles) {
      const segments = buildRidgeSegments(
        prof, runningMax, EPS, stepRad, azToX, elevToY, width, height,
      );
      if (segments.length) {
        strokeRidge(ctx, segments, -ridgeOffset, RIDGE_DARK, ridgeWidth);
        strokeRidge(ctx, segments, +ridgeOffset, RIDGE_LIGHT, ridgeWidth);
      }
      for (let i = 0; i < rayCount; i++) {
        if (prof[i] > runningMax[i]) runningMax[i] = prof[i];
      }
    }
  }

  // Шкала азимутов: каждые 15°, подписи сторон света
  ctx.font = `${12 * uiScale}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  const stepDeg = 15;
  for (let deg = 0; deg < 360; deg += stepDeg) {
    const az = (deg * Math.PI) / 180;
    const x = azToX(az);
    if (x < 0 || x > width) continue;
    const tickLen = (deg % 45 === 0 ? 14 : 7) * uiScale;
    ctx.beginPath();
    ctx.moveTo(x, horizonY);
    ctx.lineTo(x, horizonY + tickLen);
    ctx.strokeStyle = INK_DARK;
    ctx.lineWidth = 3 * uiScale;
    ctx.stroke();
    ctx.strokeStyle = INK_LIGHT_DIM;
    ctx.lineWidth = 1.2 * uiScale;
    ctx.stroke();
    if (deg % 45 === 0) {
      const ty = horizonY + 28 * uiScale;
      ctx.lineWidth = 3 * uiScale;
      ctx.strokeStyle = INK_DARK;
      ctx.strokeText(cardinal(deg), x, ty);
      ctx.fillStyle = INK_LIGHT;
      ctx.fillText(cardinal(deg), x, ty);
    }
  }

  // Подписи пиков с кластеризацией
  drawLabels(ctx, state.peaks, azToX, elevToY, view, state, uiScale);
}

/**
 * Разбивает профиль на непрерывные видимые сегменты.
 * Точка входит в сегмент, если: есть данные, она выше окклюдера (runningMax),
 * попадает на экран и не образует разрыв — ни по x, ни по углу возвышения.
 */
export function buildRidgeSegments(
  prof: Float32Array,
  runningMax: Float32Array,
  eps: number,
  stepRad: number,
  azToX: (az: number) => number,
  elevToY: (elev: number) => number,
  width: number,
  height: number,
): { x: number; y: number }[][] {
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  let prevX = NaN;
  let prevV = NaN;
  const maxGap = width * 0.25; // разрыв при заходе за край панорамы
  // Скачок угла между соседними лучами круче 30:1 — это не склон, а обрыв
  // силуэта: за краем гребня начинается совсем другая поверхность. Соединять
  // их линией нельзя, иначе через кадр протягивается ложная «вертикаль».
  const maxStepRad = MAX_RIDGE_SLOPE * stepRad;

  const flush = (): void => {
    if (current.length > 1) segments.push(current);
    current = [];
    prevX = NaN;
    prevV = NaN;
  };

  for (let i = 0; i < prof.length; i++) {
    const v = prof[i];
    if (v === -Infinity || v <= runningMax[i] + eps) {
      flush();
      continue;
    }
    const x = azToX(i * stepRad);
    if (x < -20 || x > width + 20) {
      flush();
      continue;
    }
    const y = elevToY(v);
    if (y < -height || y > height * 2) {
      flush();
      continue;
    }
    if (!Number.isNaN(prevX) && Math.abs(x - prevX) > maxGap) flush();
    if (!Number.isNaN(prevV) && Math.abs(v - prevV) > maxStepRad) flush();
    current.push({ x, y });
    prevX = x;
    prevV = v;
  }
  flush();
  return segments;
}

/** Обводка гребня со сдвигом по вертикали (для двойной линии чёрная/белая) */
function strokeRidge(
  ctx: CanvasRenderingContext2D,
  segments: { x: number; y: number }[][],
  offsetY: number,
  style: string,
  lineWidth: number,
): void {
  ctx.beginPath();
  for (const pts of segments) {
    ctx.moveTo(pts[0].x, pts[0].y + offsetY);
    for (let k = 1; k < pts.length - 1; k++) {
      const mx = (pts[k].x + pts[k + 1].x) / 2;
      const my = (pts[k].y + pts[k + 1].y) / 2 + offsetY;
      ctx.quadraticCurveTo(pts[k].x, pts[k].y + offsetY, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y + offsetY);
  }
  ctx.strokeStyle = style;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** Размещённая подпись в повёрнутой системе координат (все подписи параллельны) */
interface PlacedLabel {
  peak: VisiblePeak;
  /** Точка вершины на силуэте */
  mx: number;
  my: number;
  /** Якорь первой буквы (чуть выше вершины по направлению текста) */
  ax: number;
  ay: number;
  /** Проекции на ось текста (u) и поперечную (v) — для проверки пересечений */
  u0: number;
  u1: number;
  v: number;
  extra: number;
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  peaks: VisiblePeak[],
  azToX: (az: number) => number,
  elevToY: (elev: number) => number,
  view: ViewState,
  state: PanoramaState,
  uiScale: number,
): void {
  const { width, height } = ctx.canvas;
  ctx.font = `${13 * uiScale}px system-ui, sans-serif`;
  // Обратная проекция экрана в азимут — для обрыва выносок о силуэт
  const xToAz = (x: number): number =>
    view.centerAzRad + ((x - width / 2) / width) * view.fovRad;

  // Все подписи под одним углом: так они не пересекают друг друга,
  // их помещается больше, а выноска не режет соседние надписи.
  const theta = (LABEL_ANGLE_DEG * Math.PI) / 180;
  const ux = Math.cos(theta);   // ось вдоль текста (вправо-вверх)
  const uy = -Math.sin(theta);
  const vx = Math.sin(theta);   // ось поперёк текста
  const vy = Math.cos(theta);

  const LINE_H = 15 * uiScale;  // зазор между параллельными «дорожками»
  const LEAD = 7 * uiScale;     // отступ от вершины до первой буквы
  const PAD_U = 8 * uiScale;    // зазор между подписями вдоль строки

  // Список отсортирован по приоритету (высота + бонус за близость), поэтому
  // при нехватке места остаётся более высокая (и более близкая) вершина.
  const placed: PlacedLabel[] = [];

  /**
   * Отступ от точки скрытой вершины до первой буквы: поднимаемся вдоль строки,
   * пока вся подпись не выйдет из-за загораживающего склона. Её место — сразу
   * над силуэтом: текст поверх склона читался бы как «вершина вот здесь».
   */
  const liftAboveSilhouette = (mx: number, my: number, w: number): number => {
    const STEP = 5 * uiScale;
    const CLEAR = 5 * uiScale; // запас над линией силуэта
    const MAX_LEAD = 260 * uiScale;
    for (let lead = LEAD; lead <= MAX_LEAD; lead += STEP) {
      const ax = mx + ux * lead;
      const ay = my + uy * lead;
      if (ay < LINE_H) break;
      // Проверяем всю строку: склон правее может подниматься круче текста
      let clear = true;
      for (let s = 0; s <= 1; s += 0.25) {
        const x = ax + ux * w * s;
        const y = ay + uy * w * s;
        if (x < 0 || x > width) continue;
        if (y > horizonAtAzimuth(state, xToAz(x), elevToY) - CLEAR) {
          clear = false;
          break;
        }
      }
      if (clear) return lead;
    }
    return MAX_LEAD;
  };

  /** Попытка занять место под подпись. false — не поместилась */
  const tryPlace = (peak: VisiblePeak): boolean => {
    const marker = findPeakMarkerPosition(peak, state, azToX, elevToY);
    if (!marker) return false;
    const { x: mx, y: my } = marker;
    const hidden = peak.visibility === 'hidden';
    // Точка скрытой вершины лежит ниже силуэта — она и должна уходить
    // за нижний край, важно лишь чтобы сама подпись попала в кадр
    if (mx < 0 || mx > width || my < 0 || (!hidden && my > height)) return false;

    const text = labelText(peak);
    const w = ctx.measureText(text).width;

    // Якорь первой буквы. Обычно — сразу над вершиной по направлению текста;
    // для скрытой вершины поднимаемся вдоль строки, пока подпись целиком
    // не выйдет из-за загораживающего склона (её место — над силуэтом).
    const lead = hidden ? liftAboveSilhouette(mx, my, w) : LEAD;
    const ax = mx + ux * lead;
    const ay = my + uy * lead;
    if (ay < LINE_H) return false; // подпись ушла бы за верх кадра

    const u0 = ax * ux + ay * uy;
    const v = ax * vx + ay * vy;
    const u1 = u0 + w;

    // Пересечение параллельных прямоугольников — это пересечение интервалов
    // по обеим осям повёрнутой системы координат
    const conflict = placed.find(
      (p) => Math.abs(p.v - v) < LINE_H && u0 < p.u1 + PAD_U && u1 > p.u0 - PAD_U,
    );
    if (conflict) {
      // «+N» считает только реально видимые вершины: скрытая за гребнем
      // не должна раздувать счётчик — её там всё равно не разглядеть
      if (peak.visibility !== 'hidden') conflict.extra++;
      return false;
    }

    placed.push({ peak, mx, my, ax, ay, u0, u1, v, extra: 0 });
    return true;
  };

  // Проход 1: видимые вершины разбирают места первыми — подпись того, что
  // реально видно, всегда важнее подписи того, что за склоном
  for (const peak of peaks) {
    if (peak.visibility !== 'hidden') tryPlace(peak);
  }

  // Проход 2: скрытые добираются по остаточному бюджету. Чем пустее кадр, тем
  // их больше: на голом склоне подпись «за этим гребнем Эльбрус» — единственная
  // полезная информация, а в плотной панораме она только мешала бы.
  let budget = Math.max(0, HIDDEN_LABEL_BUDGET - placed.length);
  for (const peak of peaks) {
    if (budget <= 0) break;
    if (peak.visibility === 'hidden' && tryPlace(peak)) budget--;
  }

  // Рендер: подпись приоритетной вершины, вытесненные соседи — как «+N»
  for (const p of placed) {
    const text = labelText(p.peak) + (p.extra > 0 ? `  +${p.extra}` : '');
    // Скрытая вершина: выноска обрывается о склон, маркера вершины нет
    const end =
      p.peak.visibility === 'hidden'
        ? clipToSilhouette(p.ax, p.ay, p.mx, p.my, state, xToAz, elevToY)
        : { x: p.mx, y: p.my };
    drawPeakAnchor(ctx, end.x, end.y, p.ax, p.ay, p.peak.visibility, uiScale);
    drawRotatedLabel(ctx, p.ax, p.ay, theta, text, p.peak.visibility, uiScale);
  }
}

function labelText(peak: VisiblePeak): string {
  const km = (peak.distanceM / 1000).toFixed(peak.distanceM < 10_000 ? 1 : 0);
  const unit = getLocale() === 'ru' ? 'м' : 'm';
  const kmUnit = getLocale() === 'ru' ? 'км' : 'km';
  const ele = peak.ele !== undefined ? `${Math.round(peak.ele)} ${unit}` : '';
  return `${peakName(peak)}${ele ? ' · ' + ele : ''} · ${km} ${kmUnit}`;
}

/**
 * Подпись под фиксированным углом: без плашки, светлый текст с тёмной обводкой.
 * Начало строки — в якоре (первая буква над вершиной), текст уходит вправо-вверх.
 */
function drawRotatedLabel(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  theta: number,
  text: string,
  visibility: 'visible' | 'onSlope' | 'hidden',
  uiScale: number,
): void {
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(-theta);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = 3.5 * uiScale;
  ctx.strokeStyle = INK_DARK;
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = visibility === 'hidden' ? INK_LIGHT_DIM : INK_LIGHT;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** Точка на вершине и короткая связка до первой буквы подписи */
function drawPeakAnchor(
  ctx: CanvasRenderingContext2D,
  mx: number,
  my: number,
  ax: number,
  ay: number,
  visibility: 'visible' | 'onSlope' | 'hidden',
  uiScale: number,
): void {
  const hidden = visibility === 'hidden';
  ctx.lineCap = 'round';
  ctx.setLineDash(hidden ? [3 * uiScale, 3 * uiScale] : []);
  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(ax, ay);
  ctx.strokeStyle = INK_DARK;
  ctx.lineWidth = 3 * uiScale;
  ctx.stroke();
  ctx.strokeStyle = hidden ? INK_LIGHT_DIM : INK_LIGHT;
  ctx.lineWidth = 1.2 * uiScale;
  ctx.stroke();
  ctx.setLineDash([]);

  // Точка-якорь на вершине (только для видимых)
  if (visibility === 'visible') {
    ctx.beginPath();
    ctx.arc(mx, my, 3.4 * uiScale, 0, Math.PI * 2);
    ctx.fillStyle = INK_DARK;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(mx, my, 2 * uiScale, 0, Math.PI * 2);
    ctx.fillStyle = INK_LIGHT;
    ctx.fill();
  }
}

/** Высота силуэта на заданном азимуте (интерполяция между лучами) */
function horizonAtAzimuth(
  state: PanoramaState,
  azRad: number,
  elevToY: (elev: number) => number,
): number {
  const { horizon, stepRad } = state;
  // Азимут приходит и отрицательным (обратная проекция экрана) — нормализуем,
  // иначе индекс уходит в минус и высота силуэта становится NaN
  const idx = azRad / stepRad;
  const i0 = ((Math.floor(idx) % horizon.length) + horizon.length) % horizon.length;
  const i1 = (i0 + 1) % horizon.length;
  const frac = idx - Math.floor(idx);
  const a0 = horizon[i0] === -Infinity ? 0 : horizon[i0];
  const a1 = horizon[i1] === -Infinity ? 0 : horizon[i1];
  return elevToY(a0 + (a1 - a0) * frac);
}

/**
 * Обрыв выноски о силуэт: идём от подписи к вершине и останавливаемся там,
 * где линия уходит за гребень. Так подпись «привязана» к месту за склоном,
 * а линия не рисует несуществующую вершину поверх рельефа.
 */
function clipToSilhouette(
  ax: number,
  ay: number,
  mx: number,
  my: number,
  state: PanoramaState,
  xToAz: (x: number) => number,
  elevToY: (elev: number) => number,
): { x: number; y: number } {
  const STEPS = 24;
  let last = { x: ax, y: ay };
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const x = ax + (mx - ax) * t;
    const y = ay + (my - ay) * t;
    // y растёт вниз: точка ниже линии силуэта — уже за склоном
    if (y > horizonAtAzimuth(state, xToAz(x), elevToY)) break;
    last = { x, y };
  }
  return last;
}

/**
 * Точная позиция маркера вершины на силуэте.
 * Алгоритм из промта: матчинг по дистанции фронта, не по углу.
 */
function findPeakMarkerPosition(
  peak: VisiblePeak,
  state: PanoramaState,
  azToX: (az: number) => number,
  elevToY: (elev: number) => number,
): { x: number; y: number } | null {
  // Скрытая вершина: ставим точку в её истинное положение — оно ниже силуэта,
  // а выноска обрежется о склон (clipToSilhouette). Матчинг по фронтам тут
  // не годится: фронта на этой дистанции нет, он и перекрыл вершину.
  if (peak.visibility === 'hidden') {
    return { x: azToX(peak.azimuthRad), y: elevToY(peak.elevationRad) };
  }

  if (!state.layers || !state.fronts) {
    // Fallback: силуэт на азимуте
    return { x: azToX(peak.azimuthRad), y: horizonAtAzimuth(state, peak.azimuthRad, elevToY) };
  }

  // Окно азимутов: ширина зависит от дистанции (ближние горы шире)
  const windowRad = Math.max(0.009, Math.min(0.052, Math.atan2(1500, peak.distanceM)));
  const stepRad = state.stepRad;
  const centerIdx = Math.round(peak.azimuthRad / stepRad);
  const windowRays = Math.ceil(windowRad / stepRad);

  // Ищем фронт, соответствующий дистанции пика
  const distTolerance = Math.max(2000, peak.distanceM * 0.15);
  let best: { az: number; elev: number; score: number } | null = null;

  for (let i = Math.max(0, centerIdx - windowRays); i <= Math.min(state.fronts.length - 1, centerIdx + windowRays); i++) {
    const az = i * stepRad;
    const rayFronts = state.fronts[i];
    if (!rayFronts) continue;

    for (const front of rayFronts) {
      const dDist = peak.distanceM < front.distM
        ? front.distM - peak.distanceM
        : peak.distanceM > front.distEndM
          ? peak.distanceM - front.distEndM
          : 0;
      if (dDist > distTolerance) continue;

      const dAz = Math.abs(((az - peak.azimuthRad + Math.PI) % (2 * Math.PI)) - Math.PI);
      const score =
        -(dDist / distTolerance) * 0.4
        - (dAz / windowRad) * 0.3
        + (front.elevMaxRad / 0.3) * 0.3;

      if (!best || score > best.score) {
        best = { az, elev: front.elevMaxRad, score };
      }
    }
  }

  if (best) {
    return { x: azToX(best.az), y: elevToY(best.elev) };
  }

  // Не нашли фронт — fallback: силуэт на азимуте
  return { x: azToX(peak.azimuthRad), y: horizonAtAzimuth(state, peak.azimuthRad, elevToY) };
}

function cardinal(deg: number): string {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
  return `${t(names[deg / 45])} ${deg}°`;
}

/** Форматирование азимута для HUD */
export function formatAzimuth(rad: number): string {
  const deg = ((toDeg(rad) % 360) + 360) % 360;
  return `${deg.toFixed(0)}°`;
}
