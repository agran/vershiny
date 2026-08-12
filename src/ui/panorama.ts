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
  /** Углы горизонта по лучам, рад (0 = север) */
  horizon: Float32Array;
  /** Шаг между лучами, рад */
  stepRad: number;
  /** Видимые пики (уже отсортированы по приоритету) */
  peaks: VisiblePeak[];
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
const RIDGE_NEAR = '#2b2d42';
const RIDGE_FAR = '#4a4e69';
const LABEL_COLOR = '#f1faee';
const LABEL_DIM = '#a8dadc';

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
  ctx.fillStyle = RIDGE_FAR;
  ctx.fillRect(0, horizonY, width, height - horizonY);

  const azToX = (az: number): number =>
    (wrapAngle(az - view.centerAzRad) / view.fovRad) * width + width / 2;
  const elevToY = (elev: number): number =>
    horizonY - ((elev - view.tiltRad) / view.fovVRad) * height;

  // Силуэт горизонта: ближние — светлый контур, дальние — без
  ctx.beginPath();
  ctx.moveTo(0, height);
  const { horizon, stepRad } = state;
  for (let i = 0; i < horizon.length; i++) {
    const az = i * stepRad;
    const x = azToX(az);
    if (x < -50 || x > width + 50) continue;
    const y = horizon[i] === -Infinity ? horizonY : elevToY(horizon[i]);
    ctx.lineTo(x, Math.max(-50, Math.min(height, y)));
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fillStyle = RIDGE_NEAR;
  ctx.fill();

  // Светлый контур ближнего силуэта (чтобы отличался от дальнего)
  ctx.strokeStyle = 'rgba(241,250,238,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

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
  drawLabels(ctx, state.peaks, azToX, elevToY, view);
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
): void {
  void view;
  const { width } = ctx.canvas;
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'left';

  const placed: LabelBox[] = [];
  for (const peak of peaks) {
    const x = azToX(peak.azimuthRad);
    if (x < 0 || x > width) continue;
    const peakY = elevToY(peak.elevationRad);
    // Подпись над вершиной: маркер от вершины вверх, текст над маркером
    const y = peakY - 30;
    const text = labelText(peak);
    const w = ctx.measureText(text).width + 10;
    const box: LabelBox = { x: x - w / 2, y: y - 16, w, h: 20, peak };

    const hit = placed.find((b) => overlaps(b, box));
    if (hit) {
      // Жадная кластеризация: проигравший уходит в кластер «+N»
      if (!hit.cluster) {
        hit.cluster = hit.peak ? [hit.peak] : [];
        hit.peak = undefined;
      }
      hit.cluster.push(peak);
    } else {
      placed.push(box);
    }
  }

  for (const box of placed) {
    if (box.cluster) {
      const sorted = [...box.cluster].sort(
        (a, b) => peakScore(b, b.distanceM) - peakScore(a, a.distanceM),
      );
      const best = sorted[0];
      const extra = sorted.length - 1;
      drawLabel(ctx, box, labelText(best) + (extra > 0 ? `  +${extra}` : ''));
      // Маркер: от подписи вниз к вершине
      const peakY = elevToY(best.elevationRad);
      const labelBottom = box.y + box.h;
      drawMarker(ctx, azToX(best.azimuthRad), labelBottom, peakY);
    } else if (box.peak) {
      drawLabel(ctx, box, labelText(box.peak));
      // Маркер: от подписи вниз к вершине
      const peakY = elevToY(box.peak.elevationRad);
      const labelBottom = box.y + box.h;
      drawMarker(ctx, azToX(box.peak.azimuthRad), labelBottom, peakY);
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

function drawLabel(ctx: CanvasRenderingContext2D, box: LabelBox, text: string): void {
  ctx.fillStyle = 'rgba(13,27,42,0.72)';
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, 4);
  ctx.fill();
  ctx.fillStyle = LABEL_COLOR;
  ctx.fillText(text, box.x + 5, box.y + 13.5);
}

function drawMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  fromY: number,
  toY: number,
): void {
  ctx.strokeStyle = 'rgba(241,250,238,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, fromY);
  ctx.lineTo(x, toY);
  ctx.stroke();
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
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
