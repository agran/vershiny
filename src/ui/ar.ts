/**
 * AR-режим (ROADMAP 4.1): getUserMedia + полупрозрачный оверлей панорамы.
 * Та же проекция, что в panorama.ts — просто фон прозрачный, видео под низом.
 *
 * Про совпадение с кадром: видео рисуется с заполнением экрана (cover), и
 * обрезанные края сужают видимый угол обзора; зум камеры сужает его ещё
 * сильнее. Оверлей поэтому рисуется не с экранными FOV, а с FOV видимой
 * части кадра камеры (core/camera-fov.ts) — иначе контуры сходились по
 * центру и расходились у краёв.
 */

import {
  applyCoverCrop,
  applyZoom,
  fovForFrame,
  horizonFracInFrame,
  type FrameFov,
} from '../core/camera-fov';
import { DEFAULT_CAMERA_FOV_DEG, getCalibration } from '../core/calibration';
import type { PanoramaState, ViewState } from './panorama';
import { HORIZON_FRAC, drawOverlay } from './panorama';

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
  /**
   * Углы обзора ПОЛНОГО кадра камеры (с учётом зума, без cover-кропа), рад.
   * Именно они нужны автокалибровке: grabFrame отдаёт кадр целиком.
   */
  fullFrameFov: () => FrameFov;
  /**
   * Доля высоты полного кадра, где рисуется линия горизонта оверлея, —
   * вторая половина привязки автокалибровки к кадру.
   */
  frameHorizonFrac: () => number;
}

/** Базовый угол обзора по длинной стороне кадра камеры (калибровка), рад */
function baseFovRad(): number {
  return ((getCalibration().cameraFovDeg ?? DEFAULT_CAMERA_FOV_DEG) * Math.PI) / 180;
}

/** Параметры запроса камеры — вынесены: понадобятся при перезапуске трека */
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: 'environment', // задняя камера
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

async function attachStream(videoEl: HTMLVideoElement, stream: MediaStream): Promise<void> {
  videoEl.pause();
  videoEl.srcObject = null;
  videoEl.srcObject = stream;
  videoEl.playsInline = true;
  await videoEl.play();
}

/** Запуск камеры и привязка к canvas */
export async function startAr(
  videoEl: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  state: PanoramaState,
  view: ViewState,
  options: ArOptions = {},
): Promise<ArSession> {
  let stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);

  // Дальше всё может отказать (часть WebView отклоняет play()), а поток уже
  // запущен: без явной остановки камера продолжала гореть, вызывающий видел
  // только исключение и убирал <video> — из которого поток и не выключается
  try {
    await attachStream(videoEl, stream);
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop());
    videoEl.srcObject = null;
    throw err;
  }

  let stopped = false;

  /**
   * Возобновление после блокировки экрана / сворачивания вкладки.
   *
   * Пока страница была фоном, браузер приостанавливает камеру, а часть
   * платформ (Android Chrome) трек завершает совсем: после разблокировки
   * <video> показывает последний кадр, хотя requestAnimationFrame рисует
   * исправно. Живой трек тоже полезно заново присоединить к <video>, чтобы
   * браузер перезапустил поток вместо показа последнего кадра; завершённый
   * приходится запрашивать заново — разрешение на камеру уже дано, диалога
   * не будет.
   */
  const resume = async (): Promise<void> => {
    if (stopped) return;
    const track = stream.getVideoTracks()[0];
    if (track && track.readyState === 'ended') {
      stream.getTracks().forEach((t) => t.stop());
      try {
        stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        readZoom();
      } catch (err) {
        console.warn('Камера после сворачивания не перезапустилась:', err);
        return;
      }
    }
    try {
      await attachStream(videoEl, stream);
      readZoom();
    } catch {
      // Повторный play при живом воспроизведении безвреден; отказ — только в лог
    }
  };

  const onVisible = (): void => {
    if (!document.hidden) void resume();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('pageshow', onVisible);
  // Трек может завершиться и в видимой вкладке (камеру отобрало другое
  // приложение) — пытаемся перезапустить сразу, не дожидаясь сворачивания
  const onTrackEnded = (): void => void resume();
  stream.getVideoTracks()[0]?.addEventListener('ended', onTrackEnded);

  const ctx = canvas.getContext('2d')!;
  const opacity = options.opacity ?? 0.55;

  // Зум камеры, если браузер его сообщает (Android Chrome; на iOS поля нет).
  // События смены зума в спецификации нет — читаем при старте и перезапуске.
  let zoomFactor = 1;
  function readZoom(): void {
    try {
      const settings = stream.getVideoTracks()[0]?.getSettings() as
        | { zoom?: number }
        | undefined;
      if (settings && Number.isFinite(settings.zoom) && (settings.zoom as number) > 0) {
        zoomFactor = settings.zoom as number;
      }
    } catch {
      // getSettings не обязателен — остаёмся на зуме 1
    }
  }
  readZoom();

  /** FOV полного кадра камеры: базовый угол → пропорции кадра → зум */
  function fullFrameFov(): FrameFov {
    return applyZoom(
      fovForFrame(baseFovRad(), videoEl.videoWidth, videoEl.videoHeight),
      zoomFactor,
    );
  }

  let raf = 0;
  function frame() {
    drawArFrame(ctx, videoEl, state, view, opacity, zoomFactor);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // Отдельный маленький холст для анализа: снимать пиксели с экранного
  // дорого и бессмысленно — на нём поверх кадра уже нарисованы наши контуры
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });

  return {
     stop: () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
       window.removeEventListener('focus', onVisible);
       window.removeEventListener('pageshow', onVisible);
       stream.getVideoTracks()[0]?.removeEventListener('ended', onTrackEnded);
       cancelAnimationFrame(raf);
       stream.getTracks().forEach((t) => t.stop());
       videoEl.srcObject = null;
     },
    fullFrameFov,
    frameHorizonFrac: () =>
      horizonFracInFrame(
        videoEl.videoWidth,
        videoEl.videoHeight,
        canvas.width,
        canvas.height,
        HORIZON_FRAC,
      ),
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
  zoomFactor: number,
): void {
  const { width, height } = ctx.canvas;

  let overlayView = view;
  if (video.readyState >= 2 && video.videoWidth > 0) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.max(width / vw, height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);

    // Оверлей подгоняем под ВИДИМУЮ часть кадра: полный FOV камеры минус
    // обрезанные cover'ом края и зум. Без этого контуры сходились по центру
    // кадра и расходились к краям, когда пропорции экрана и видео различались
    const full = applyZoom(fovForFrame(baseFovRad(), vw, vh), zoomFactor);
    const visible = applyCoverCrop(full, vw, vh, width, height);
    overlayView = { ...view, fovRad: visible.h, fovVRad: visible.v };
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }

  // Оверлей: те же контуры и подписи, что в панораме (без заливок —
  // важно видеть кадр камеры под линиями)
  ctx.save();
  ctx.globalAlpha = opacity;
  drawOverlay(ctx, state, overlayView);
  ctx.restore();
}
