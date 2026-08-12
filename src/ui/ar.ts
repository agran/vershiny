/**
 * AR-режим (ROADMAP 4.1): getUserMedia + полупрозрачный оверлей панорамы.
 * Та же проекция, что в panorama.ts — просто фон прозрачный, видео под низом.
 */

import type { PanoramaState, ViewState } from './panorama';
import { drawOverlay } from './panorama';

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

  // Оверлей: те же контуры и подписи, что в панораме (без заливок —
  // важно видеть кадр камеры под линиями)
  ctx.save();
  ctx.globalAlpha = opacity;
  drawOverlay(ctx, state, view);
  ctx.restore();
}
