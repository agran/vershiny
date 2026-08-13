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

export interface ArSession {
  /** Остановить камеру и вернуть панораму */
  stop: () => void;
  /**
   * Кадр камеры как пиксели — для автокалибровки (core/skyline.ts).
   * null, пока камера не отдала первый кадр.
   */
  grabFrame: () => { rgba: Uint8ClampedArray; width: number; height: number } | null;
}

/** Запуск камеры и привязка к canvas */
export async function startAr(
  videoEl: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  state: PanoramaState,
  view: ViewState,
  options: ArOptions = {},
): Promise<ArSession> {
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

  // Отдельный маленький холст для анализа: снимать пиксели с экранного
  // дорого и бессмысленно — на нём поверх кадра уже нарисованы наши контуры
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });

  return {
    stop: () => {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      videoEl.srcObject = null;
    },
    grabFrame: () => {
      if (!probeCtx || videoEl.readyState < 2) return null;
      const width = 320;
      const height = Math.max(
        1,
        Math.round((width * videoEl.videoHeight) / videoEl.videoWidth),
      );
      probe.width = width;
      probe.height = height;
      probeCtx.drawImage(videoEl, 0, 0, width, height);
      return { rgba: probeCtx.getImageData(0, 0, width, height).data, width, height };
    },
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
