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
import {
  currentFrameRotationDeg,
  drawVideoAligned,
  rotatedFrameSize,
} from "../core/frame-orientation";
import { perfCount, perfEnabled, perfFrame, perfPhase } from "../core/perf";
import { softAngleDeg } from "../core/screen-orientation";
import type { PanoramaState, ViewState } from "./panorama";
import {
  HORIZON_FRAC,
  drawOverlay,
  rotateAroundCenter,
  type OverlayOptions,
} from "./panorama";

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
  // Кэш оверлея (см. ArOverlayCache ниже): линии и подписи перерендериваются
  // только при смене азимута/наклона/содержимого, а каждый rAF — это видео
  // плюс два blit готовых слоёв с доворотом на текущий крен
  const overlayCache = createArOverlayCache();

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
    // Размеры кадра — ПОСЛЕ доворота под программный поворот UI: они
    // описывают тот же кадр, что рисует drawArFrame, и только с ними
    // калибровка и снимок совпадут с картинкой на экране
    const { w, h } = rotatedFrameSize(
      videoEl.videoWidth,
      videoEl.videoHeight,
      currentFrameRotationDeg(),
    );
    return applyZoom(fovForFrame(baseFovRad(), w, h), zoomFactor);
  }

  let raf = 0;
  // Отладочный оверлей (?ardebug=1): живые цифры ориентации кадра, чтобы
  // скриншот с устройства отвечал на вопрос о ветке (browser-compensated vs
  // raw-sensor) без гипотез. Только локальная отладка, в проде выключен
  const debugEl = setupArDebug(canvas, videoEl);
  // rAF следует за частотой дисплея: на 120 Гц мониторах цикл AR рисовал
  // 120 кадров/с при 30 кадрах/с самой камеры — вдвое больше видео-дроу и
  // композитинга впустую. Держим не выше 60 кадров/с
  const MIN_AR_FRAME_MS = 1000 / 60;
  let lastFrameAt = 0;
  function frame(nowMs: number) {
    if (nowMs - lastFrameAt >= MIN_AR_FRAME_MS - 2) {
      lastFrameAt = nowMs;
      const t0 = perfEnabled ? performance.now() : 0;
      drawArFrame(
        ctx,
        videoEl,
        state,
        view,
        opacity,
        zoomFactor,
        overlayCache,
      );
      debugEl?.update();
      if (perfEnabled) {
        perfFrame(performance.now() - t0);
        perfCount("srcAr");
      }
    }
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
      debugEl?.remove();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
      endedTrack?.removeEventListener("ended", onTrackEnded);
      cancelAnimationFrame(raf);
      overlayCache.free();
      stream.getTracks().forEach((t) => t.stop());
      videoEl.srcObject = null;
    },
    fullFrameFov,
    frameHorizonFrac: () => {
      const { w, h } = rotatedFrameSize(
        videoEl.videoWidth,
        videoEl.videoHeight,
        currentFrameRotationDeg(),
      );
      return horizonFracInFrame(
        w,
        h,
        canvas.width,
        canvas.height,
        HORIZON_FRAC,
      );
    },
    grabFrame: () => {
      if (!probeCtx || videoEl.readyState < 2) return null;
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      // Кадр в пробу — в том же довороте, что на экране: профиль
      // «небо/земля» измеряется по колонкам пробы, и он обязан совпадать
      // с горизонталью отрисованного кадра (иначе в программном ландшафте
      // калибровка искала бы линию неба поперёк экрана)
      const rot = currentFrameRotationDeg();
      const { w: pw, h: ph } = rotatedFrameSize(vw, vh, rot);
      const width = 320;
      const height = Math.max(1, Math.round((width * ph) / pw));
      probe.width = width;
      probe.height = height;
      drawVideoAligned(probeCtx, videoEl, width, height, rot);
      return {
        rgba: probeCtx.getImageData(0, 0, width, height).data,
        width,
        height,
      };
    },
  };
}

/** Один кадр AR: видео + полупрозрачный силуэт и непрозрачные подписи */

/**
 * Запас кэша оверлея вокруг кадра: крен до ±40° (больше обычно не держат) +
 * поле под дрейф азимута/наклона между перерендерами. Кадр строит drawOverlay
 * в системе с НУЛЁВЫМ креном внутри этого запаса — края запаса позволяют
 * выйти линиям за x = 0/width (rollEdgeMarginX их туда и пускает)
 */
const OVERLAY_MARGIN_FACTOR = 0.45;

/**
 * Пороги перерендера кэша оверлея. Подписи размещаются по снимку кадра на
 * момент перерендера, поэтому дрейф внутри порога — не погрешность рисунка
 * (кэш точен под свой view), а лишь то, что подписи видны не у самого края
 * кадра. Смена содержимого (peaks/layers — ссылки меняет воркер), калибровки
 * (fov) и формы кадра (zoom) перерендеривает немедленно.
 */
const AZ_DRIFT_TRIGGER_FRAC = 0.5; // от запаса: ушли дальше — перерендер
const AZ_CENTER_STEP_FRAC = 0.25; // шаг перецентровки центра запаса
const TILT_DRIFT_PX = 4; // наклон: субпиксельный дрейф — только blit
/** Полный перерендер раз в N кадров, даже если взгляд стоит: освежить выбор подписей */
const OVERLAY_REFRESH_FRAMES = 30;

/** Порог «взгляд движется»: дельта за кадр, экранные px */
const MOTION_DELTA_PX = 1.5;
/** Столько кадров подряд — непрерывное движение (защита от одиночных скачков) */
const MOTION_FRAMES = 3;
/** Во время движения грубые пороги дрейфа: внутри запаса — только blit */
const MOVE_AZ_FRAC = 0.85;
const MOVE_TILT_FRAC = 0.5;

/**
 * Кэш AR-оверлея. Два offscreen-холста: линии (полупрозрачный слой) и
 * подписи (непрозрачные). Каждый живой кадр — видео плюс два blit с
 * доворотом на текущий крен; полный drawOverlay — только по порогам выше.
 */
interface ArOverlayCache {
  /** Линии (контуры+шкала) без альфы, в системе нулевого крена */
  ridges: HTMLCanvasElement | null;
  /** Подписи, полная непрозрачность */
  labels: HTMLCanvasElement | null;
  /** Снимок вида, под который построен кадр (азимут — центр запаса) */
  anchor: { azRad: number; tiltRad: number; fovRad: number; fovVRad: number } | null;
  /** Поля запаса, px устройства */
  marginX: number;
  marginY: number;
  /** Размер буфера = холст + запас */
  width: number;
  height: number;
  /** Контентные ссылки на момент построения */
  peaksRef: unknown;
  layersRef: unknown;
  /** Параметры кадра камеры (зум, углы) */
  zoom: number;
  fovH: number;
  fovV: number;
  /** Номер кадра последнего полного рендера */
  renderedAt: number;
  /** Текущий номер кадра сессии (инкрементируется при blit/рендере) */
  frameNo: number;
  /** Последние az/tilt и счётчик движущихся кадров (грубые пороги в движении) */
  lastAz: number;
  lastTilt: number;
  movingFrames: number;
  /** Освободить память при stop() */
  free: () => void;
}

export type { ArOverlayCache };

export const AR_OVERLAY_MARGIN_FACTOR = OVERLAY_MARGIN_FACTOR;
export const AR_OVERLAY_REFRESH_FRAMES = OVERLAY_REFRESH_FRAMES;

export function createArOverlayCache(): ArOverlayCache {
  return {
    ridges: null,
    labels: null,
    anchor: null,
    marginX: 0,
    marginY: 0,
    width: 0,
    height: 0,
    peaksRef: null,
    layersRef: null,
    zoom: NaN,
    fovH: NaN,
    fovV: NaN,
    renderedAt: -1,
    frameNo: 0,
    lastAz: NaN,
    lastTilt: NaN,
    movingFrames: 0,
    free() {
      // Сбрасываем ссылки: буферы соберёт GC, без повторной аллокации
      this.ridges = null;
      this.labels = null;
    },
  };
}

/**
 * Один кадр AR: видео + оверлей. Видео — каждый кадр (содержимое камеры),
 * оверлей — blit из кэша; полный рендер слоёв — по порогам дрейфа/смене
 * содержимого. Крен применяется поворотом blit'а вокруг центра экрана, а не
 * перерендером: это ~0.2 мс вместо 10–20 мс и не «плывёт» от фильтра.
 */
function drawArFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  state: PanoramaState,
  view: ViewState,
  opacity: number,
  zoomFactor: number,
  cache?: ArOverlayCache,
): void {
  const { width, height } = ctx.canvas;

  let overlayView = view;
  if (video.readyState >= 2 && video.videoWidth > 0) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    // Кадр ориентацией «ровно под окно» (Samsung компенсирует сенсор под
    // системную ориентацию окна), а интерфейс может быть довёрнут CSS-ом на
    // ±90° (программный ландшафт). drawImage CSS-трансформ не применяет —
    // поэтому доворачиваем кадр сами на −softAngle, иначе в ландшафтном
    // режиме картинка лежит на боку. Cover-кроп по центру.
    const rot = currentFrameRotationDeg();
    const tVideo = perfEnabled ? performance.now() : 0;
    drawVideoAligned(ctx, video, width, height, rot);
    if (perfEnabled) perfPhase("video", performance.now() - tVideo);

    // Оверлей подгоняем под ВИДИМУЮ часть кадра: полный FOV камеры минус
    // обрезанные cover'ом края и зум. Без этого контуры сходились по центру
    // кадра и расходились к краям, когда пропорции экрана и видео различались.
    // Размеры кадра — после доворота: FOV считается от повёрнутого кадра
    const { w: pw, h: ph } = rotatedFrameSize(vw, vh, rot);
    const full = applyZoom(fovForFrame(baseFovRad(), pw, ph), zoomFactor);
    const visible = applyCoverCrop(full, pw, ph, width, height);
    overlayView = { ...view, fovRad: visible.h, fovVRad: visible.v };
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
  }

  const roll = overlayView.rollRad ?? 0;

  if (cache && video.readyState >= 2 && video.videoWidth > 0) {
    drawArOverlayCached(
      ctx,
      state,
      overlayView,
      roll,
      opacity,
      zoomFactor,
      cache,
    );
    return;
  }

  // Без кэша (старый путь: тесты без готового видео, первый кадр до него)
  ctx.save();
  rotateAroundCenter(ctx, roll);
  ctx.globalAlpha = opacity;
  drawOverlay(ctx, state, overlayView, undefined, { labels: false });
  ctx.restore();
  ctx.save();
  rotateAroundCenter(ctx, roll);
  drawOverlay(ctx, state, overlayView, undefined, { ridges: false });
  ctx.restore();
}

/**
 * Оверлей из кэша: два blit (линии полупрозрачно, подписи непрозрачно) с
 * доворотом на крен. Полный перерендер — по порогам: дрейф азимута за
 * половину запаса, наклон дальше 4 px, смена peaks/layers/fov/зума, либо
 * регламентное обновление раз в OVERLAY_REFRESH_FRAMES кадров. При
 * НЕПРЕРЫВНОМ движении (свайп, поворот по датчику) пороги грубеют до края
 * запаса — blit и так сдвигает оверлей точно, — а на остановке рендерится
 * один чёткий кадр с актуальными подписями.
 */
export function drawArOverlayCached(
  ctx: CanvasRenderingContext2D,
  state: PanoramaState,
  overlayView: ViewState,
  roll: number,
  opacity: number,
  zoomFactor: number,
  cache: ArOverlayCache,
): void {
  const { width, height } = ctx.canvas;
  const uiScale = ctx.canvas.clientWidth > 0 ? width / ctx.canvas.clientWidth : 1;

  // Запас кэша вокруг кадра: поле под крен + дрейф. Проекция оверлея считает
  // по углам видимого кадра, поэтому масштаб px/рад берём из overlayView
  const marginX = Math.round(width * OVERLAY_MARGIN_FACTOR);
  const marginY = Math.round(height * OVERLAY_MARGIN_FACTOR);
  const bufW = width + 2 * marginX;
  const bufH = height + 2 * marginY;

  const az = overlayView.centerAzRad;
  const tilt = overlayView.tiltRad;
  const fovH = overlayView.fovRad;
  const fovV = overlayView.fovVRad;

  // Центр запаса квантуется: не «текущий азимут», а ближайший шаг — иначе
  // опора прыгала бы при каждом перерендере, и подписи «плыли» бы по кадру
  const anchorStep = (fovH / (width || 1)) * marginX * AZ_CENTER_STEP_FRAC;
  const anchorAz =
    cache.anchor === null
      ? az
      : cache.anchor.azRad +
        Math.round(shortestAngle(az - cache.anchor.azRad) / anchorStep) *
          anchorStep;

  const driftAzPx =
    Math.abs(shortestAngle(az - (cache.anchor?.azRad ?? NaN))) *
    (width / (fovH || 1));
  const driftTiltPx =
    Math.abs(tilt - (cache.anchor?.tiltRad ?? NaN)) * (height / (fovV || 1));

  // Детектор непрерывного движения: пока взгляд меняется кадр за кадром
  // (свайп подстройки контуров, поворот по датчику), перерендериваем редко —
  // blit и так двигает оверлей точно, а перерендер нужен только чтобы не
  // выйти за поля запаса. Иначе порог наклона 4 px перерендеривал кэш на
  // каждый кадр жеста, и полный рендер горел всё время движения
  const azDeltaPx = Number.isFinite(cache.lastAz)
    ? Math.abs(shortestAngle(az - cache.lastAz)) * (width / (fovH || 1))
    : Infinity;
  const tiltDeltaPx = Number.isFinite(cache.lastTilt)
    ? Math.abs(tilt - cache.lastTilt) * (height / (fovV || 1))
    : Infinity;
  const wasMoving = cache.movingFrames >= MOTION_FRAMES;
  // Первый кадр (lastAz/lastTilt ещё NaN) движением не считается
  const hasPrev =
    Number.isFinite(cache.lastAz) && Number.isFinite(cache.lastTilt);
  cache.movingFrames =
    hasPrev &&
    (azDeltaPx > MOTION_DELTA_PX || tiltDeltaPx > MOTION_DELTA_PX)
      ? cache.movingFrames + 1
      : 0;
  const moving = cache.movingFrames >= MOTION_FRAMES;
  const stoppedMoving = wasMoving && !moving;
  cache.lastAz = az;
  cache.lastTilt = tilt;

  // Пороги дрейфа: в покое — точные (наклон дальше 4 px перерендеривает),
  // в движении — грубые (только край запаса) плюс чёткий кадр на остановке
  const driftLimit = moving
    ? driftAzPx > marginX * MOVE_AZ_FRAC ||
      driftTiltPx > marginY * MOVE_TILT_FRAC
    : driftAzPx > marginX * AZ_DRIFT_TRIGGER_FRAC ||
      driftTiltPx > TILT_DRIFT_PX;

  // Счётчик кадров сессии: регламентное обновление кэша раз в N кадров
  cache.frameNo++;
  const needRender =
    cache.ridges === null ||
    cache.labels === null ||
    cache.anchor === null ||
    cache.width !== bufW ||
    cache.height !== bufH ||
    cache.peaksRef !== state.peaks ||
    cache.layersRef !== state.layers ||
    cache.fovH !== fovH ||
    cache.fovV !== fovV ||
    cache.zoom !== zoomFactor ||
    driftLimit ||
    stoppedMoving ||
    cache.frameNo - cache.renderedAt >= OVERLAY_REFRESH_FRAMES;

  if (needRender) {
    if (!cache.ridges) cache.ridges = document.createElement("canvas");
    if (!cache.labels) cache.labels = document.createElement("canvas");
    cache.ridges.width = bufW;
    cache.ridges.height = bufH;
    cache.labels.width = bufW;
    cache.labels.height = bufH;

    // Кадр кэша — оверлей той же проекции, но в системе нулевого крена и с
    // центром запаса: экранные координаты = кэш + смещение полей
    const cacheView: ViewState = {
      centerAzRad: anchorAz,
      tiltRad: tilt,
      fovRad: fovH,
      fovVRad: fovV,
      rollRad: 0,
    };
    const cacheOpts: OverlayOptions = { anchorAzRad: anchorAz };
    const rctx = cache.ridges.getContext("2d")!;
    const lctx = cache.labels.getContext("2d")!;
    rctx.save();
    lctx.save();
    // Сдвигаем систему кэша: точка (0,0) кэша — это (−marginX, −marginY)
    // экрана. drawOverlay рисует кадр шириной bufW/bufH с центром по кэшу —
    // чтобы совместить, переносим начало координат
    rctx.translate(marginX, marginY);
    lctx.translate(marginX, marginY);
    drawOverlay(rctx, state, cacheView, uiScale, { ...cacheOpts, labels: false });
    drawOverlay(lctx, state, cacheView, uiScale, { ...cacheOpts, ridges: false });
    rctx.restore();
    lctx.restore();

    cache.anchor = { azRad: anchorAz, tiltRad: tilt, fovRad: fovH, fovVRad: fovV };
    cache.marginX = marginX;
    cache.marginY = marginY;
    cache.width = bufW;
    cache.height = bufH;
    cache.peaksRef = state.peaks;
    cache.layersRef = state.layers;
    cache.zoom = zoomFactor;
    cache.fovH = fovH;
    cache.fovV = fovV;
    cache.renderedAt = cache.frameNo;
    perfCount("arOverlayRender");
  } else {
    perfCount("arOverlayBlit");
  }

  // Blit: положение кэша на экране — центр кэша на центр запаса + дрейф по
  // азимуту/наклону; поворот на крен — вокруг центра экрана (drawImage уже
  // сдвинут, а поворачиваем мы экранную систему)
  const pxPerRadH = width / (fovH || 1);
  const pxPerRadV = height / (fovV || 1);
  const ox =
    (width - bufW) / 2 -
    pxPerRadH * shortestAngle(az - cache.anchor!.azRad);
  const oy =
    (height - bufH) / 2 +
    pxPerRadV * (tilt - cache.anchor!.tiltRad);

  ctx.save();
  rotateAroundCenter(ctx, roll);
  ctx.globalAlpha = opacity;
  ctx.drawImage(cache.ridges!, ox, oy);
  ctx.restore();
  ctx.save();
  rotateAroundCenter(ctx, roll);
  ctx.globalAlpha = 1;
  ctx.drawImage(cache.labels!, ox, oy);
  ctx.restore();
}

/** Кратчайшее угловое расстояние с знаком (для дрейфа по кругу) */
function shortestAngle(d: number): number {
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * Отладочный оверлей ориентации кадра (?ardebug=1).
 *
 * Показывает живые цифры, по которым на устройстве определяется ветка
 * ориентации getUserMedia (browser-compensated vs raw-sensor): сырые β/γ
 * датчика, угол окна и наш CSS-поворот, размеры кадра и выбранный доворот.
 * Обновляется каждый кадр; pointer-events: none — касаниям не мешает.
 * Возвращает null вне отладки — в проде узла нет вовсе.
 */
function setupArDebug(
  canvas: HTMLCanvasElement,
  videoEl: HTMLVideoElement,
): { update: () => void; remove: () => void } | null {
  if (!new URLSearchParams(location.search).has("ardebug")) return null;
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:200;pointer-events:none;" +
    "background:rgba(0,0,0,.7);color:#7fff9f;font:11px/1.5 monospace;" +
    "padding:6px 8px;border-radius:6px;white-space:pre";
  document.body.appendChild(el);
  let beta = NaN;
  let gamma = NaN;
  const onOrient = (ev: DeviceOrientationEvent): void => {
    beta = ev.beta ?? NaN;
    gamma = ev.gamma ?? NaN;
  };
  window.addEventListener("deviceorientation", onOrient);
  const f = (v: number): string => (Number.isFinite(v) ? v.toFixed(0) : "—");
  return {
    update: () => {
      const so = screen.orientation;
      el.textContent =
        `β=${f(beta)} γ=${f(gamma)}\n` +
        `win: ${so?.type ?? "?"} ${so?.angle ?? "?"}°\n` +
        `css: ${softAngleDeg()}°\n` +
        `frame: ${videoEl.videoWidth}×${videoEl.videoHeight}\n` +
        `canvas: ${canvas.width}×${canvas.height}`;
    },
    remove: () => {
      window.removeEventListener("deviceorientation", onOrient);
      el.remove();
    },
  };
}
