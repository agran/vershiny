/**
 * AR-режим (ROADMAP 4.1): getUserMedia + оверлей панорамы поверх видео.
 * Та же проекция, что в panorama.ts — просто фон прозрачный, видео под низом.
 * Контуры и шкала рисуются полупрозрачными (сквозь них виден кадр камеры),
 * подписи — непрозрачными: полупрозрачный текст на пёстрой картинке камеры
 * выцветает и перестаёт читаться.
 *
 * Про совпадение с кадром: видео рисуется с заполнением экрана (cover), и
 * обрезанные края сужают видимый угол обзора; зум камеры сужает его ещё
 * сильнее. Оверлей поэтому рисуется не с экранными FOV, а с FOV видимой
 * части кадра камеры (core/camera-fov.ts) — иначе контуры сходились по
 * центру и расходились у краёв.
 */

import { DEFAULT_CAMERA_FOV_DEG, getCalibration } from "../core/calibration";
import {
  applyCoverCrop,
  applyZoom,
  fovForFrame,
  horizonFracInFrame,
  type FrameFov,
} from "../core/camera-fov";
import type { PanoramaState, ViewState } from "./panorama";
import { HORIZON_FRAC, drawOverlay } from "./panorama";

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
  grabFrame: () => {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
  } | null;
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
  return (
    ((getCalibration().cameraFovDeg ?? DEFAULT_CAMERA_FOV_DEG) * Math.PI) / 180
  );
}

/** Параметры запроса камеры — вынесены: понадобятся при перезапуске трека */
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: "environment", // задняя камера
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

async function attachStream(
  videoEl: HTMLVideoElement,
  stream: MediaStream,
): Promise<void> {
  videoEl.pause();
  videoEl.srcObject = null;
  videoEl.srcObject = stream;
  videoEl.playsInline = true;
  // Android Chrome иначе сворачивает играющую камеру в auto-PiP при уходе
  // с экрана приложения (домой/другое приложение) — нам PiP не нужен
  videoEl.disablePictureInPicture = true;
  await videoEl.play();
}

/** Сколько ждём новый кадр камеры, прежде чем считать его застывшим, мс */
const FREEZE_CHECK_MS = 300;

/**
 * Дождаться либо нового кадра видео, либо истечения таймаута.
 *
 * `requestVideoFrameCallback` смотрит именно на отрисованный кадр, а не на
 * производные состояния (`readyState`, `paused`) — поэтому ловит ровно тот
 * баг, который чинит этот файл: трек живой, `<video>` не на паузе, а кадр
 * не обновляется (Android Chrome после блокировки экрана). Там, где метода
 * нет (Safari < 15.4), сверяем `currentTime` — не так надёжно для
 * MediaStream (время может идти и без смены кадра), но лучше, чем ничего.
 */
function waitForFrame(
  videoEl: HTMLVideoElement,
  timeoutMs: number,
): Promise<boolean> {
  if (typeof videoEl.requestVideoFrameCallback === "function") {
    return new Promise((resolve) => {
      let settled = false;
      const id = videoEl.requestVideoFrameCallback(() => {
        if (settled) return;
        settled = true;
        resolve(true);
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        videoEl.cancelVideoFrameCallback(id);
        resolve(false);
      }, timeoutMs);
    });
  }
  const t0 = videoEl.currentTime;
  return new Promise((resolve) => {
    setTimeout(() => resolve(videoEl.currentTime !== t0), timeoutMs);
  });
}

/**
 * Жёсткое переприсоединение потока (attachStream) плюс диагностика:
 * если кадр не пошёл даже после него — залогировать. Само авто-восстановление
 * этот случай не покрывает (устройство и так в необычном состоянии), но в
 * логах будет видно, что баг не исчерпан текущим фиксом.
 */
async function attachStreamAndVerify(
  videoEl: HTMLVideoElement,
  stream: MediaStream,
): Promise<void> {
  await attachStream(videoEl, stream);
  void waitForFrame(videoEl, FREEZE_CHECK_MS).then((ok) => {
    if (!ok)
      console.warn("Камера: кадр не пошёл даже после переприсоединения потока");
  });
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
  // Не даёт двум почти одновременным сигналам (visibilitychange + focus +
  // pageshow при одной и той же разблокировке) переприсоединять поток
  // параллельно: две гонки за srcObject друг друга ломали бы
  let resuming = false;

  /**
   * Возобновление после блокировки экрана / сворачивания вкладки.
   *
   * Пока страница была фоном, браузер приостанавливает камеру, а часть
   * платформ (Android Chrome) трек завершает совсем — тогда без вариантов
   * нужен новый `getUserMedia` (разрешение уже дано, диалога не будет).
   * Но есть и третий, самый частый исход: трек живой, `<video>` не на
   * паузе, а кадр просто не обновляется. Отличить его от нормального
   * состояния по `readyState`/`paused` нельзя — только подождать реальный
   * кадр (`waitForFrame`). Поэтому дорогое переприсоединение (`attachStream`:
   * pause + новый srcObject + play, с неизбежным пустым кадром на миг)
   * делаем только когда кадр действительно не пришёл, а не при каждом
   * возврате в приложение — иначе на десктопе даже безобидный alt-tab
   * между окнами моргал бы кадром камеры.
   */
  const resume = async (): Promise<void> => {
    if (stopped || resuming) return;
    resuming = true;
    try {
      const track = stream.getVideoTracks()[0];
      if (track && track.readyState === "ended") {
        stream.getTracks().forEach((t) => t.stop());
        try {
          stream =
            await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
          readZoom();
          rebindTrackEnded();
        } catch (err) {
          console.warn("Камера после сворачивания не перезапустилась:", err);
          return;
        }
        // Новый MediaStream кадра ещё не отдавал — переприсоединение неизбежно
        try {
          await attachStreamAndVerify(videoEl, stream);
        } catch {
          // Отказ — только в лог; следующий resume() (по одному из трёх
          // событий) попробует снова
        }
        return;
      }
      if (stopped || document.hidden) return; // страница успела снова свернуться
      if (videoEl.paused) {
        try {
          await videoEl.play();
        } catch {
          // Если кадр так и не пойдёт — сработает детектор ниже
        }
      }
      if (stopped || document.hidden) return;
      const gotFrame = await waitForFrame(videoEl, FREEZE_CHECK_MS);
      if (!gotFrame && !stopped && !document.hidden) {
        try {
          await attachStreamAndVerify(videoEl, stream);
        } catch {
          // Отказ — только в лог
        }
      }
    } finally {
      resuming = false;
    }
  };

  const onVisible = (): void => {
    if (!document.hidden) void resume();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  window.addEventListener("pageshow", onVisible);

  // Трек может завершиться и в видимой вкладке (камеру отобрало другое
  // приложение) — пытаемся перезапустить сразу, не дожидаясь сворачивания.
  // Слушатель переезжает на новый трек при каждой замене потока (rebindTrackEnded)
  // — иначе повторное завершение после перезапуска осталось бы незамеченным
  const onTrackEnded = (): void => void resume();
  let endedTrack: MediaStreamTrack | undefined;
  function rebindTrackEnded(): void {
    endedTrack?.removeEventListener("ended", onTrackEnded);
    endedTrack = stream.getVideoTracks()[0];
    endedTrack?.addEventListener("ended", onTrackEnded);
  }
  rebindTrackEnded();

  const ctx = canvas.getContext("2d")!;
  const opacity = options.opacity ?? 0.55;

  // Зум камеры, если браузер его сообщает (Android Chrome; на iOS поля нет).
  // События смены зума в спецификации нет — читаем при старте и перезапуске.
  let zoomFactor = 1;
  function readZoom(): void {
    try {
      const settings = stream.getVideoTracks()[0]?.getSettings() as
        { zoom?: number } | undefined;
      if (
        settings &&
        Number.isFinite(settings.zoom) &&
        (settings.zoom as number) > 0
      ) {
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
  const probe = document.createElement("canvas");
  const probeCtx = probe.getContext("2d", { willReadFrequently: true });

  return {
    stop: () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
      endedTrack?.removeEventListener("ended", onTrackEnded);
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
      return {
        rgba: probeCtx.getImageData(0, 0, width, height).data,
        width,
        height,
      };
    },
  };
}

/** Один кадр AR: видео + полупрозрачный силуэт и непрозрачные подписи */
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
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
  }

  // Оверлей в два прохода. Линии (контуры и шкала) — полупрозрачно: важно
  // видеть кадр камеры под ними. Подписи — полной непрозрачности: текст с
  // обводкой читается сам по себе, а полупрозрачный он на пёстром видео
  // просто выцветает
  ctx.save();
  ctx.globalAlpha = opacity;
  drawOverlay(ctx, state, overlayView, undefined, { labels: false });
  ctx.restore();
  drawOverlay(ctx, state, overlayView, undefined, { ridges: false });
}
