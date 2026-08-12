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
// Слои дальности: светлее = ближе (воздушная перспектива)
const LAYER_COLORS = ['#1a1a2e', '#22223b', '#2b2d42', '#4a4e69', '#6c757d'];
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

  // Небо — градиент
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, SKY_TOP);
  sky.addColorStop(1, SKY_HORIZON);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = LAYER_COLORS[LAYER_COLORS.length - 1];
  ctx.fillRect(0, horizonY, width, height - horizonY);

  const azToX = (az: number): number =>
    (wrapAngle(az - view.centerAzRad) / view.fovRad) * width + width / 2;
  const elevToY = (elev: number): number =>
    horizonY - ((elev - view.tiltRad) / view.fovVRad) * height;

  // Силуэт горизонта: слои сзади-вперёд (дальние → ближние)
  const { horizon, stepRad } = state;
  const layers = state.layers ?? [horizon];

  for (let layerIdx = layers.length - 1; layerIdx >= 0; layerIdx--) {
    const layer = layers[layerIdx];
    if (!layer) continue;

    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 0; i < layer.length; i++) {
      const az = i * stepRad;
      const x = azToX(az);
      if (x < -50 || x > width + 50) continue;
      const y = layer[i] === -Infinity ? horizonY : elevToY(layer[i]);
      ctx.lineTo(x, Math.max(-50, Math.min(height, y)));
    }
    ctx.lineTo(width, height);
    ctx.closePath();

    // Цвет слоя: ближний = темнее и контрастнее
    ctx.fillStyle = LAYER_COLORS[Math.min(layerIdx, LAYER_COLORS.length - 1)];
    ctx.fill();

    // Светлый контур для ВСЕХ слоёв (различимость гор друг за другом)
    ctx.strokeStyle = `rgba(241,250,238,${0.3 + (layers.length - 1 - layerIdx) * 0.15})`;
    ctx.lineWidth = layerIdx === 0 ? 1.5 : 1;
    ctx.stroke();
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
      // Маркер: к точке пика (visible) или к силуэту на его дистанции (onSlope/hidden)
      const markerY = markerYForPeak(best, state, elevToY);
      drawMarker(ctx, azToX(best.azimuthRad), box.y + box.h, markerY, best.visibility);
    } else if (box.peak) {
      drawLabel(ctx, box, labelText(box.peak), box.peak.visibility);
      const markerY = markerYForPeak(box.peak, state, elevToY);
      drawMarker(ctx, azToX(box.peak.azimuthRad), box.y + box.h, markerY, box.peak.visibility);
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
 * Y маркера для пика:
 * - visible: точка пика (расчётная высота, может немного отличаться от DEM)
 * - onSlope: силуэт на азимуте (пик на видимом склоне)
 * - hidden: силуэт на азимуте (пунктир, полупрозрачный)
 */
function markerYForPeak(
  peak: VisiblePeak,
  state: PanoramaState,
  elevToY: (elev: number) => number,
): number {
  if (peak.visibility === 'visible') {
    return elevToY(peak.elevationRad);
  }
  // onSlope и hidden: силуэт на азимуте пика
  return horizonAtAzimuth(state, peak.azimuthRad, elevToY);
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
