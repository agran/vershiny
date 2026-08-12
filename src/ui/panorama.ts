/**
 * Canvas-рендер панорамы (ROADMAP неделя 2):
 * силуэт горизонта, шкала азимутов, подписи пиков с кластеризацией.
 * Проекция: x = (azimuth − centerAz)/fov · width,
 *           y = horizonY − elevationAngle/fovV · height (ARCHITECTURE.md).
 */

import { toDeg, wrapAngle } from '../core/geo';
import type { VisiblePeak } from '../core/horizon';
import { peakScore } from '../core/peaks';
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
const LABEL_COLOR = '#f1faee';
const LABEL_DIM = '#a8dadc';
const LABEL_HIDDEN = 'rgba(168,218,220,0.5)';

/** Рендер одного кадра панорамы */
export function renderPanorama(
  ctx: CanvasRenderingContext2D,
  state: PanoramaState,
  view: ViewState,
): void {
  const { width, height } = ctx.canvas;
  const horizonY = height * 0.62; // линия горизонта чуть ниже центра

  // Фон — единый градиент на весь кадр (без горизонтальной «ступеньки»)
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, SKY_TOP);
  sky.addColorStop(horizonY / height, SKY_HORIZON);
  sky.addColorStop(1, SKY_BOTTOM);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const azToX = (az: number): number =>
    (wrapAngle(az - view.centerAzRad) / view.fovRad) * width + width / 2;
  const elevToY = (elev: number): number =>
    horizonY - ((elev - view.tiltRad) / view.fovVRad) * height;

  const { horizon, stepRad } = state;
  const layers = state.layers ?? [horizon];

  // Отладка: доступ к данным из консоли
  (window as unknown as Record<string, unknown>).__pano = state;

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
    // Масштаб линий под плотность пикселей (canvas.width может быть в 2–3× больше CSS)
    const dpr = ctx.canvas.clientWidth > 0 ? width / ctx.canvas.clientWidth : 1;
    const ridgeWidth = RIDGE_WIDTH_CSS * dpr;
    const ridgeOffset = RIDGE_OFFSET_CSS * dpr;
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
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const stepDeg = 15;
  for (let deg = 0; deg < 360; deg += stepDeg) {
    const az = (deg * Math.PI) / 180;
    const x = azToX(az);
    if (x < 0 || x > width) continue;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(x, horizonY);
    ctx.lineTo(x, horizonY + (deg % 45 === 0 ? 14 : 7));
    ctx.stroke();
    if (deg % 45 === 0) {
      ctx.fillStyle = LABEL_DIM;
      ctx.fillText(cardinal(deg), x, horizonY + 28);
    }
  }

  // Подписи пиков с кластеризацией
  drawLabels(ctx, state.peaks, azToX, elevToY, view, state);
}

/**
 * Разбивает профиль на непрерывные видимые сегменты.
 * Точка входит в сегмент, если: есть данные, она выше окклюдера (runningMax),
 * попадает на экран и не образует разрыв по x.
 */
function buildRidgeSegments(
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
  const maxGap = width * 0.25; // разрыв при заходе за край панорамы

  const flush = (): void => {
    if (current.length > 1) segments.push(current);
    current = [];
    prevX = NaN;
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
    current.push({ x, y });
    prevX = x;
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

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  peak?: VisiblePeak;
  cluster?: VisiblePeak[];
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  peaks: VisiblePeak[],
  azToX: (az: number) => number,
  elevToY: (elev: number) => number,
  view: ViewState,
  state: PanoramaState,
): void {
  void view;
  const { width, height } = ctx.canvas;
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'left';

  // Полки: 3 ряда подписей над горизонтом
  const horizonY = height * 0.62;
  const ROW_H = 24;
  const GAP = 12;
  const shelves = [horizonY - GAP, horizonY - GAP - ROW_H, horizonY - GAP - ROW_H * 2];

  // Сортировка по score (уже отсортированы в filterVisiblePeaks)
  const placed: LabelBox[] = [];
  const clusters = new Map<LabelBox, VisiblePeak[]>();

  for (const peak of peaks) {
    const x = azToX(peak.azimuthRad);
    if (x < 0 || x > width) continue;

    const text = labelText(peak);
    const w = ctx.measureText(text).width + 10;

    // Пробуем полки сверху вниз: ищем свободное место по x на этой полке
    let placedBox: LabelBox | null = null;
    for (let s = 0; s < shelves.length; s++) {
      const shelfY = shelves[s];
      // Проверяем перекрытие только с подписями на ТОЙ ЖЕ полке
      const conflict = placed.some(
        (b) => Math.abs(b.y - (shelfY - 16)) < 2 && // та же полка
               x - w / 2 < b.x + b.w + 4 && // левый край левее правого края существующего + зазор
               x + w / 2 > b.x - 4,          // правый край правее левого края
      );
      if (!conflict) {
        placedBox = { x: x - w / 2, y: shelfY - 16, w, h: 20, peak };
        placed.push(placedBox);
        break;
      }
    }

    if (!placedBox) {
      // Все полки заняты — в кластер ближайшего по x
      if (placed.length === 0) continue;
      const nearest = placed.reduce((best, b) => {
        const distBest = Math.abs(b.x + b.w / 2 - x);
        const distB = Math.abs(b.x + b.w / 2 - x);
        return distB < distBest ? b : best;
      });
      if (!clusters.has(nearest)) clusters.set(nearest, []);
      clusters.get(nearest)!.push(peak);
      if (!nearest.cluster) nearest.cluster = [];
      nearest.cluster.push(peak);
    }
  }

  // Рендер: сначала кластеры, потом одиночные
  for (const box of placed) {
    const cluster = clusters.get(box);
    if (cluster) {
      const sorted = [...cluster].sort(
        (a, b) => peakScore(b, b.distanceM) - peakScore(a, a.distanceM),
      );
      const best = sorted[0];
      const extra = sorted.length - 1;
      drawLabel(ctx, box, labelText(best) + (extra > 0 ? `  +${extra}` : ''), best.visibility);
      // Маркер: точная позиция вершины на силуэте
      const marker = findPeakMarkerPosition(best, state, azToX, elevToY);
      if (marker) {
        drawMarker(ctx, marker.x, box.y + box.h, marker.y, best.visibility);
      }
    } else if (box.peak) {
      drawLabel(ctx, box, labelText(box.peak), box.peak.visibility);
      const marker = findPeakMarkerPosition(box.peak, state, azToX, elevToY);
      if (marker) {
        drawMarker(ctx, marker.x, box.y + box.h, marker.y, box.peak.visibility);
      }
    }
  }
}

function labelText(peak: VisiblePeak): string {
  const km = (peak.distanceM / 1000).toFixed(peak.distanceM < 10_000 ? 1 : 0);
  const unit = getLocale() === 'ru' ? 'м' : 'm';
  const kmUnit = getLocale() === 'ru' ? 'км' : 'km';
  const ele = peak.ele !== undefined ? `${Math.round(peak.ele)} ${unit}` : '';
  return `${peakName(peak)}${ele ? ' · ' + ele : ''} · ${km} ${kmUnit}`;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  box: LabelBox,
  text: string,
  visibility: 'visible' | 'onSlope' | 'hidden' = 'visible',
): void {
  ctx.fillStyle = 'rgba(13,27,42,0.72)';
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, 4);
  ctx.fill();
  ctx.fillStyle = visibility === 'hidden' ? LABEL_HIDDEN : LABEL_COLOR;
  ctx.fillText(text, box.x + 5, box.y + 13.5);
}

function drawMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  fromY: number,
  toY: number,
  visibility: 'visible' | 'onSlope' | 'hidden' = 'visible',
): void {
  if (visibility === 'hidden') {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(168,218,220,0.4)';
  } else {
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(241,250,238,0.8)';
  }
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, fromY);
  ctx.lineTo(x, toY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Точка-якорь на вершине (только для видимых)
  if (visibility === 'visible') {
    ctx.fillStyle = 'rgba(241,250,238,0.9)';
    ctx.beginPath();
    ctx.arc(x, toY, 3, 0, Math.PI * 2);
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
  const idx = azRad / stepRad;
  const i0 = Math.floor(idx) % horizon.length;
  const i1 = (i0 + 1) % horizon.length;
  const frac = idx - Math.floor(idx);
  const a0 = horizon[i0] === -Infinity ? 0 : horizon[i0];
  const a1 = horizon[i1] === -Infinity ? 0 : horizon[i1];
  return elevToY(a0 + (a1 - a0) * frac);
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
