/**
 * AR-режим (ROADMAP 4.1): getUserMedia + полупрозрачный оверлей панорамы.
 * Та же проекция, что в panorama.ts — просто фон прозрачный, видео под низом.
 */

import type { PanoramaState, ViewState } from './panorama';
import { wrapAngle, toDeg } from '../core/geo';
import { peakScore } from '../core/peaks';
import { getLocale, peakName } from '../core/i18n';

export interface ArOptions {
  /** Прозрачность оверлея 0–1 */
  opacity?: number;
}

/** Запуск камеры и привязка к canvas */
export async function startAr(
  videoEl: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  state: PanoramaState,
  view: ViewState,
  options: ArOptions = {},
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'environment', // задняя камера
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });

  videoEl.srcObject = stream;
  videoEl.playsInline = true;
  await videoEl.play();

  const ctx = canvas.getContext('2d')!;
  const opacity = options.opacity ?? 0.55;

  let raf = 0;
  function frame() {
    drawArFrame(ctx, videoEl, state, view, opacity);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // Остановка: остановка треков + отмена анимации
  return () => {
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  };
}

/** Один кадр AR: видео + полупрозрачный силуэт и подписи */
function drawArFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  state: PanoramaState,
  view: ViewState,
  opacity: number,
): void {
  const { width, height } = ctx.canvas;

  // Видео-фон
  if (video.readyState >= 2) {
    // Cover: сохраняем пропорции
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.max(width / vw, height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }

  // Оверлей
  ctx.save();
  ctx.globalAlpha = opacity;

  const horizonY = height * 0.62;
  const azToX = (az: number): number =>
    (wrapAngle(az - view.centerAzRad) / view.fovRad) * width + width / 2;
  const elevToY = (elev: number): number =>
    horizonY - ((elev - view.tiltRad) / view.fovVRad) * height;

  // Силуэт горизонта
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
  ctx.fillStyle = 'rgba(13,27,42,0.5)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(241,250,238,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Подписи пиков (только видимые, без кластеров — в AR важна скорость)
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const peak of state.peaks) {
    const x = azToX(peak.azimuthRad);
    if (x < 0 || x > width) continue;
    const y = elevToY(peak.elevationRad) - 16;

    // Метка
    ctx.strokeStyle = 'rgba(241,250,238,0.8)';
    ctx.beginPath();
    ctx.moveTo(x, y + 16);
    ctx.lineTo(x, y + 6);
    ctx.stroke();

    // Подпись
    const km = (peak.distanceM / 1000).toFixed(peak.distanceM < 10_000 ? 1 : 0);
    const unit = getLocale() === 'ru' ? 'км' : 'km';
    const ele = peak.ele !== undefined ? `${Math.round(peak.ele)}${getLocale() === 'ru' ? 'м' : 'm'}` : '';
    const text = `${peakName(peak)}${ele ? ' ' + ele : ''} · ${km}${unit}`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(13,27,42,0.7)';
    ctx.fillRect(x - tw / 2 - 4, y - 12, tw + 8, 16);
    ctx.fillStyle = '#f1faee';
    ctx.fillText(text, x, y);
  }

  // Шкала азимутов (только стороны света)
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(168,218,220,0.9)';
  for (let deg = 0; deg < 360; deg += 45) {
    const az = (deg * Math.PI) / 180;
    const x = azToX(az);
    if (x < 0 || x > width) continue;
    ctx.fillText(`${cardinalShort(deg)}`, x, height - 12);
  }

  ctx.restore();
}

function cardinalShort(deg: number): string {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[deg / 45];
}

/** Для будущей кластеризации в AR (пока не используется) */
void peakScore;
void toDeg;
