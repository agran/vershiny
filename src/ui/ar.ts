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
  createLinearProjection,
  createPinholeProjection,
  PINHOLE_ENABLED,
  type CameraProjection,
} from "../core/camera-projection";
import {
  currentFrameRotationDeg,
  drawVideoAligned,
  rotatedFrameSize,
  videoCoverRect,
} from "../core/frame-orientation";
import { perfCount, perfEnabled, perfFrame, perfPhase } from "../core/perf";
import { softAngleDeg } from "../core/screen-orientation";
import type { PanoramaState, ViewState } from "./panorama";
import {
  AR_HORIZON_FRAC,
  drawOverlay,
  rotateAroundCenter,
  type OverlayOptions,
} from "./panorama";

export interface ArOptions {
  /** Прозрачность оверлея 0–1 */
  opacity?: number;
  /**
   * Фото вместо камеры (режим «загруженное фото»): готовый поток с
   * canvas.captureStream. Камеру не запрашиваем вовсе — getUserMedia не
   * вызывается, и ветки перезапуска камеры в resume() не работают.
   */
  photoStream?: MediaStream;
  /** Остановить рисующий цикл фото-потока при stop() сессии */
  stopPhotoDraw?: () => void;
}

/**
 * Отладочные контуры поверх кадра камеры (только десктоп): результат
 * экстрактора «небо/земля» или нейросети, чтобы сравнить их работу на
 * одном снимке. Профили — доли высоты ПОЛНОГО кадра (0 — верх) по
 * колонкам СОБСТВЕННОЙ сетки экстрактора (классика — GRID_W, NN — сетка
 * препроцессинга 518): ширина кадра делится на длину профиля.
 */
export interface DebugContours {
  kind: "classic" | "nn";
  profiles: Float32Array[];
  /**
   * Граница неба от NN (кандидат линии горизонта) — рисуется белым контуром
   * ПЕРВЫМ, поверх остальных: её и сравнивают с пурпурной классикой
   */
  skyline?: Float32Array;
}

export interface ArSession {
  /** Остановить камеру и вернуть панораму */
  stop: () => void;
  /**
   * Кадр камеры как пиксели — для автокалибровки (core/skyline.ts).
   * null, пока камера не отдала первый кадр.
   *
   * @param width ширина пробы: 320 достаточно экстрактору линии неба, а
   *   NN-глубине (ступень 4) на таком мелком кадре не хватает контраста
   *   «небо/горы» — она просит 768
   */
  grabFrame: (width?: number) => {
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
   * Текущий зум трека (1 = без зума). Оценённый по кадру FOV включает зум,
   * и его обратный пересчёт в базовый угол калибровки без этой величины
   * невозможен
   */
  zoom: () => number;
  /**
   * Доля высоты полного кадра, где рисуется линия горизонта оверлея, —
   * вторая половина привязки автокалибровки к кадру.
   */
  frameHorizonFrac: () => number;
  /**
   * Проекция видимой части кадра в CSS-пикселях. Ручная подстройка берёт
   * из неё обе точки drag, чтобы pinhole не подменял геометрию линейной.
   */
  overlayProjection: () => CameraProjection;
  /**
   * Немедленная перерисовка обоих слоёв. Нужна после внешнего resize:
   * смена размеров холста очищает его, и до ближайшего rAF оверлей
   * мигал бы прозрачностью поверх видео (моргание контуров при повороте)
   */
  redraw: () => void;
  /**
   * Отладочные контуры поверх кадра (null — убрать). Рисуются в геометрии
   * cover-кропа видео (videoCoverRect) — поверх контуров панорамы.
   */
  setDebugContours: (contours: DebugContours | null) => void;
}

/** Базовый угол обзора по длинной стороне кадра камеры (калибровка), рад */
function baseFovRad(): number {
  return (
    ((getCalibration().cameraFovDeg ?? DEFAULT_CAMERA_FOV_DEG) * Math.PI) / 180
  );
}

/** Видимый FOV кадра после зума, доворота и центрального cover-кропа. */
function visibleOverlayFov(
  video: HTMLVideoElement,
  viewWidth: number,
  viewHeight: number,
  zoomFactor: number,
): FrameFov | null {
  if (
    video.readyState < 2 ||
    video.videoWidth <= 0 ||
    video.videoHeight <= 0 ||
    viewWidth <= 0 ||
    viewHeight <= 0
  ) {
    return null;
  }
  const rot = currentFrameRotationDeg();
  const { w: frameWidth, h: frameHeight } = rotatedFrameSize(
    video.videoWidth,
    video.videoHeight,
    rot,
  );
  const full = applyZoom(
    fovForFrame(baseFovRad(), frameWidth, frameHeight),
    zoomFactor,
  );
  return applyCoverCrop(full, frameWidth, frameHeight, viewWidth, viewHeight);
}

/** Параметры запроса камеры — вынесены: понадобятся при перезапуске трека */
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: "environment", // задняя камера
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    // Без этого UA может кропнуть/растянуть кадр сенсора под EIS — 5–12% FOV
    // молча (docs/AR-OPTICS-AUDIT.md, №8). С "none" кадр приходит в нативной
    // геометрии сенсора, и getSettings() описывает ровно тот кадр, что рисует
    // видео. Не поддерживающие UA ограничение просто игнорируют. Свойства нет
    // в lib.dom (констрейнт выпал из спецификации, но Chromium его исполняет) —
    // точечный каст, чтобы лишняя проверка свойств не мешала
    resizeMode: "none",
  } as MediaTrackConstraints,
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

/**
 * Запуск камеры и привязка к canvas.
 *
 * `getState` — геттер панорамы, а не сам объект: камера стартует до первого
 * расчёта (человек целится на вершину, пока грузится рельеф), и оверлей
 * обязан видеть панораму, когда она появится. Пока её нет — чистый кадр
 * камеры без контуров.
 */
export async function startAr(
  videoEl: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  getState: () => PanoramaState | null,
  view: ViewState,
  options: ArOptions = {},
): Promise<ArSession> {
  // Фото-режим: поток уже готов (canvas.captureStream), камеру не трогаем
  let stream =
    options.photoStream ??
    (await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS));

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
    readZoom(); // зум могли изменить, пока приложение было в фоне
    if (options.photoStream) {
      // Фото: canvas-трек не «умирает», как камера. Единственное, что может
      // случиться при сворачивании, — браузер поставил видео на паузу;
      // возобновить воспроизведение и всё
      if (!document.hidden && videoEl.paused) {
        try {
          await videoEl.play();
        } catch {
          // Следующий resume (по одному из трёх событий) попробует снова
        }
      }
      return;
    }
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
  // Отладочные контуры поверх кадра (setDebugContours): включены только
  // кнопками на десктопе, рисуются поверх оверлея в геометрии видео
  let debugContours: DebugContours | null = null;
  /** Цвета NN-контуров по индексу; классика — пурпурный, граница неба — белая */
  const NN_CONTOUR_COLORS = ["#ffaa00", "#00ffcc", "#ff5588"];
  const CLASSIC_CONTOUR_COLOR = "#ff00ff";
  const SKYLINE_CONTOUR_COLOR = "#ffffff";

  /** Один кадр отладочных контуров поверх всего (оверлей уже нарисован) */
  function drawDebugContours(): void {
    if (!debugContours) return;
    const rect = videoCoverRect(
      videoEl.videoWidth,
      videoEl.videoHeight,
      currentFrameRotationDeg(),
      canvas.width,
      canvas.height,
    );
    if (!rect) return;
    // yFrac — доля ВЫСОТЫ ПОЛНОГО кадра, и rect.h — та же высота в пикселях
    // холста: контур ложится на кадр при любом cover-кропе
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // Порядок линий: белая граница неба NN — первой (под цветными слоями),
    // затем профили палитрой
    const lines: { p: Float32Array; color: string }[] = [];
    if (debugContours.kind === "nn" && debugContours.skyline) {
      lines.push({ p: debugContours.skyline, color: SKYLINE_CONTOUR_COLOR });
    }
    debugContours.profiles.forEach((p, i) => {
      lines.push({
        p,
        color:
          debugContours!.kind === "classic"
            ? CLASSIC_CONTOUR_COLOR
            : NN_CONTOUR_COLORS[i % NN_CONTOUR_COLORS.length],
      });
    });
    for (const { p, color } of lines) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      let started = false;
      // Ширина кадра делится на ДЛИНУ профиля: у NN сетка препроцессинга
      // (518 колонок) шире пробы (320), и общий масштаб растягивал бы
      // контур на 62% по горизонтали — «совсем не похоже»
      const sx = rect.w / Math.max(1, p.length);
      for (let x = 0; x < p.length; x++) {
        const f = p[x];
        if (!Number.isFinite(f)) {
          started = false; // разрыв линии (облако, отказ колонки)
          continue;
        }
        const px = rect.x + (x + 0.5) * sx;
        const py = rect.y + f * rect.h;
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  // Кэш оверлея (см. ArOverlayCache ниже): линии и подписи перерендериваются
  // только при смене азимута/наклона/содержимого, а каждый rAF — это
  // clearRect + два blit готовых слоёв с доворотом на текущий крен
  const overlayCache = createArOverlayCache();

  // Слой видео отделён от слоя оверлея (GPU-аудит, п. 5.2): камера даёт
  // 30–50 кадров/с, и рисовать видео 60 раз/с — лишний decode→upload на
  // каждый rAF. Видео перерисовывается ТОЛЬКО на реальный кадр камеры
  // (requestVideoFrameCallback), оверлей — на каждый rAF поверх; два холста
  // композитятся браузером. Основной холст в AR теперь прозрачен, поэтому
  // каждый кадр оверлея начинается с clearRect. Без rVFC (ниже нашего
  // минимума Safari 16.4) видео рисуется в rAF, как раньше
  const videoLayer = document.createElement("canvas");
  // В #app перед основным холстом. Оба холста в #app — статичные блоки в
  // нормальном потоке: без абсолютного позиционирования видео-слой занял бы
  // верхние 100% высоты, а холст с оверлеем уехал вниз за кадр (та же сетка
  // CSS `#app canvas` даёт слою тот же размер, что холсту). z-index:-1 —
  // под холстом, над <video> в body. Вне DOM (тесты) вставка — no-op
  videoLayer.style.cssText =
    "position:absolute;inset:0;z-index:-1;pointer-events:none";
  canvas.insertAdjacentElement("beforebegin", videoLayer);
  const vctx = videoLayer.getContext("2d")!;
  const hasRvfc = typeof videoEl.requestVideoFrameCallback === "function";
  /** Подогнать видео-слой под размер основного холста */
  function syncVideoLayer(): boolean {
    if (
      videoLayer.width === canvas.width &&
      videoLayer.height === canvas.height
    )
      return false;
    videoLayer.width = canvas.width;
    videoLayer.height = canvas.height;
    return true;
  }
  /** Ключ геометрии последнего нарисованного кадра видео */
  let lastVideoKey = "";
  /**
   * Один кадр видео в слой: тот же доворот/cover, что раньше рисовался на
   * основной холст (drawVideoAligned). Чёрная заливка — до первого кадра
   */
  function drawVideoLayer(): void {
    syncVideoLayer();
    const { width, height } = videoLayer;
    lastVideoKey =
      `${currentFrameRotationDeg()}|${videoEl.videoWidth}|` +
      `${videoEl.videoHeight}|${width}|${height}`;
    if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
      const tVideo = perfEnabled ? performance.now() : 0;
      drawVideoAligned(
        vctx,
        videoEl,
        width,
        height,
        currentFrameRotationDeg(),
      );
      if (perfEnabled) perfPhase("video", performance.now() - tVideo);
    } else {
      vctx.fillStyle = "#000";
      vctx.fillRect(0, 0, width, height);
    }
    if (perfEnabled) perfCount("videoDraw");
  }
  /** Геометрия/доворот сменились без нового кадра камеры */
  function videoLayoutChanged(): boolean {
    return (
      lastVideoKey !==
      `${currentFrameRotationDeg()}|${videoEl.videoWidth}|` +
        `${videoEl.videoHeight}|${canvas.width}|${canvas.height}`
    );
  }
  // Цепочка rVFC: callback одноразовый, перерегистрируемся на каждый кадр.
  // Видео-слой — отдельный элемент: обновление не трогает оверлей вообще
  let rvfcArmed = false;
  let lastVideoFrameAt = performance.now();
  function armRvfc(): void {
    if (rvfcArmed || !hasRvfc) return;
    rvfcArmed = true;
    videoEl.requestVideoFrameCallback(onVideoFrame);
  }
  function onVideoFrame(): void {
    rvfcArmed = false;
    lastVideoFrameAt = performance.now();
    if (stopped) return;
    drawVideoLayer();
    armRvfc();
  }

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
  // События смены зума в спецификации нет; <video> шлёт resize, когда трек
  // начинает доставлять кадр другой геометрии (в т.ч. после цифрового зума) —
  // единственная зацепка перечитать settings, не дожидаясь перезапуска трека
  videoEl.addEventListener("resize", readZoom);

  /**
   * Геометрия доставляемого кадра — из настроек трека, а не из <video>:
   * с resizeMode:"none" они совпадают, а до первого кадра (videoWidth=0) и
   * на UA с пересэмплингом settings описывают нативный кадр сенсора, под
   * который и считается FOV (docs/AR-OPTICS-AUDIT.md, №8)
   */
  function trackFrameSize(): { w: number; h: number } {
    try {
      const settings = stream.getVideoTracks()[0]?.getSettings() as
        | { width?: number; height?: number }
        | undefined;
      if (settings && settings.width && settings.height) {
        return { w: settings.width, h: settings.height };
      }
    } catch {
      // getSettings не обязателен — смотрим <video>
    }
    return { w: videoEl.videoWidth, h: videoEl.videoHeight };
  }

  /** FOV полного кадра камеры: базовый угол → пропорции кадра → зум */
  function fullFrameFov(): FrameFov {
    // Размеры кадра — ПОСЛЕ доворота под программный поворот UI: они
    // описывают тот же кадр, что рисует видео-слой (под который drawArFrame
    // подгоняет оверлей), и только с ними калибровка и снимок совпадут
    // с картинкой на экране
    const { w, h } = rotatedFrameSize(
      trackFrameSize().w,
      trackFrameSize().h,
      currentFrameRotationDeg(),
    );
    return applyZoom(fovForFrame(baseFovRad(), w, h), zoomFactor);
  }

  /** Та же проекция, что у оверлея, но в CSS-пикселях указателя. */
  function overlayProjection(): CameraProjection {
    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;
    const visible = visibleOverlayFov(
      videoEl,
      canvas.width || width,
      canvas.height || height,
      zoomFactor,
    );
    const params = {
      width,
      height,
      centerAzRad: view.centerAzRad,
      tiltRad: view.tiltRad,
      fovRad: visible?.h ?? view.fovRad,
      fovVRad: visible?.v ?? view.fovVRad,
      horizonFrac: AR_HORIZON_FRAC,
    };
    return PINHOLE_ENABLED
      ? createPinholeProjection(params)
      : createLinearProjection(params);
  }

  let raf = 0;
  // Отладочный оверлей (?ardebug=1): живые цифры ориентации кадра, чтобы
  // скриншот с устройства отвечал на вопрос о ветке (browser-compensated vs
  // raw-sensor) без гипотез. Только локальная отладка, в проде выключен
  const debugEl = setupArDebug(canvas, videoEl);
  // rAF следует за частотой дисплея: на 120 Гц мониторах цикл рисовал
  // 120 кадров/с при 30 кадрах/с самой камеры — вдвое больше видео-дроу и
  // композитинга впустую. Оверлей держим не выше 60 кадров/с, видео идёт
  // по rVFC — по реальным кадрам камеры (GPU-аудит, п. 5.2)
  const MIN_AR_FRAME_MS = 1000 / 60;
  let lastFrameAt = 0;
  function frame(nowMs: number) {
    if (nowMs - lastFrameAt >= MIN_AR_FRAME_MS - 2) {
      lastFrameAt = nowMs;
      const t0 = perfEnabled ? performance.now() : 0;
      // Видео — только без rVFC, при смене геометрии без нового кадра
      // (поворот окна, resize, новый поток) или когда кадры камеры давно
      // не шли (цепочка rVFC могла умереть на паузе видео — перевзвести)
      if (
        !hasRvfc ||
        videoLayoutChanged() ||
        nowMs - lastVideoFrameAt > 200
      ) {
        armRvfc();
        drawVideoLayer();
      }
      drawArFrame(
        ctx,
        videoEl,
        getState(),
        view,
        opacity,
        zoomFactor,
        overlayCache,
      );
      drawDebugContours();
      debugEl?.update();
      if (perfEnabled) {
        perfFrame(performance.now() - t0);
        perfCount("srcAr");
      }
    }
    raf = requestAnimationFrame(frame);
  }
  armRvfc();
  raf = requestAnimationFrame(frame);

  // Отдельный маленький холст для анализа: снимать пиксели с экранного
  // дорого и бессмысленно — на нём поверх кадра уже нарисованы наши контуры
  const probe = document.createElement("canvas");
  const probeCtx = probe.getContext("2d", { willReadFrequently: true });

  // Именованная перерисовка: нужна и redraw(), и setDebugContours (методы
  // объектного литерала друг друга по имени не видят)
  const redrawAr = (): void => {
    if (stopped) return;
    syncVideoLayer();
    drawVideoLayer();
    drawArFrame(
      ctx,
      videoEl,
      getState(),
      view,
      opacity,
      zoomFactor,
      overlayCache,
    );
    drawDebugContours();
  };

  return {
    stop: () => {
      stopped = true;
      videoLayer.remove();
      debugEl?.remove();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
      videoEl.removeEventListener("resize", readZoom);
      endedTrack?.removeEventListener("ended", onTrackEnded);
      cancelAnimationFrame(raf);
      overlayCache.free();
      // Фото-режим: остановить рисующий цикл до остановки его трека
      options.stopPhotoDraw?.();
      stream.getTracks().forEach((t) => t.stop());
      videoEl.srcObject = null;
    },
    fullFrameFov,
    overlayProjection,
    zoom: () => zoomFactor,
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
        AR_HORIZON_FRAC,
      );
    },
    redraw: redrawAr,
    setDebugContours: (contours) => {
      if (stopped) return;
      debugContours = contours;
      redrawAr();
    },
    grabFrame: (width = 320) => {
      if (!probeCtx || videoEl.readyState < 2) return null;
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      // Кадр в пробу — в том же довороте, что на экране: профиль
      // «небо/земля» измеряется по колонкам пробы, и он обязан совпадать
      // с горизонталью отрисованного кадра (иначе в программном ландшафте
      // калибровка искала бы линию неба поперёк экрана)
      const rot = currentFrameRotationDeg();
      const { w: pw, h: ph } = rotatedFrameSize(vw, vh, rot);
      const probeWidth = Math.max(1, Math.min(width, pw));
      const probeHeight = Math.max(1, Math.round((probeWidth * ph) / pw));
      probe.width = probeWidth;
      probe.height = probeHeight;
      drawVideoAligned(probeCtx, videoEl, probeWidth, probeHeight, rot);
      return {
        rgba: probeCtx.getImageData(0, 0, probeWidth, probeHeight).data,
        width: probeWidth,
        height: probeHeight,
      };
    },
  };
}

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

/**
 * Допустимая ошибка blit'а на КРАЮ кадра под пинхолом, px устройства:
 * перерендер раньше, чем краевой контур уйдёт дальше этого (см. №6)
 */
const PINHOLE_EDGE_EPS_PX = 2;

/** Порог «взгляд движется»: дельта за кадр, экранные px */
const MOTION_DELTA_PX = 1.5;
/** Столько кадров подряд — непрерывное движение (защита от одиночных скачков) */
const MOTION_FRAMES = 3;
/** Во время движения грубые пороги дрейфа: внутри запаса — только blit */
const MOVE_AZ_FRAC = 0.85;
const MOVE_TILT_FRAC = 0.5;

/**
 * Кэш AR-оверлея. Два offscreen-холста: линии (полупрозрачный слой) и
 * подписи (непрозрачные). Каждый живой кадр — clearRect плюс два blit с
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
 * Один кадр оверлея AR: clearRect + blit из кэша; полный рендер слоёв — по
 * порогам дрейфа/смене содержимого. Крен применяется поворотом blit'а вокруг
 * центра экрана, а не перерендером: это ~0.2 мс вместо 10–20 мс и не
 * «плывёт» от фильтра. Видео — на отдельном слое под холстом, обновляется
 * по реальным кадрам камеры (rVFC), а не в этом цикле.
 */
export function drawArFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  state: PanoramaState | null,
  view: ViewState,
  opacity: number,
  zoomFactor: number,
  cache?: ArOverlayCache,
): void {
  const { width, height } = ctx.canvas;
  // Видео живёт на собственном слое под этим холстом (см. startAr): здесь
  // только оверлей, поэтому каждый кадр начинается с очистки — иначе blit
  // оставлял бы следы прежних позиций линий и подписей
  ctx.clearRect(0, 0, width, height);
  // Панорамы ещё нет (камера стартует до первого расчёта): рисовать нечего —
  // остаётся чистый кадр камеры, человек целится на вершину во время загрузки.
  // Кеш оверлея не трогаем: с первым кадром панорамы refs сменятся, и он
  // перерендерится сам
  if (!state) return;

  let overlayView = view;
  const visible = visibleOverlayFov(video, width, height, zoomFactor);
  if (visible) {
    // Полный FOV камеры сужается на обрезанные cover'ом края и зум. Без этого
    // контуры сходились по центру кадра и расходились у краёв экрана.
    overlayView = { ...view, fovRad: visible.h, fovVRad: visible.v };
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
  const arOverlay: OverlayOptions = {
    labels: false,
    horizonFrac: AR_HORIZON_FRAC,
    projection: PINHOLE_ENABLED ? "pinhole" : "linear",
  };
  ctx.save();
  rotateAroundCenter(ctx, roll);
  ctx.globalAlpha = opacity;
  drawOverlay(ctx, state, overlayView, undefined, arOverlay);
  ctx.restore();
  ctx.save();
  rotateAroundCenter(ctx, roll);
  drawOverlay(ctx, state, overlayView, undefined, {
    ...arOverlay,
    labels: true,
    ridges: false,
  });
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
  // Холст может быть сжат до нуля (скрыт, мгновенный спад размеров при
  // повороте): буфер кэша тогда тоже нулевой, и drawImage бросил бы
  // InvalidStateError — а он гасит rAF-цикл AR до следующего перезапуска
  if (!width || !height) return;
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

  // Смещения — через проекцию кадра (core/camera-projection.ts): та же,
  // по которой drawOverlay нарисовал кеш. До первого рендера anchor = null,
  // и углы дают NaN — те же ветки, что у прежнего масштаба px/рад
  const driftProj = createLinearProjection({
    width,
    height,
    centerAzRad: cache.anchor?.azRad ?? az,
    tiltRad: cache.anchor?.tiltRad ?? tilt,
    fovRad: fovH || 1,
    fovVRad: fovV || 1,
    horizonFrac: AR_HORIZON_FRAC,
  });
  const driftAzPx = Math.abs(driftProj.angleToView(az, tilt)!.x - width / 2);
  const driftTiltPx = Math.abs(
    driftProj.angleToView(az, tilt)!.y -
      driftProj.angleToView(az, cache.anchor?.tiltRad ?? NaN)!.y,
  );

  // Детектор непрерывного движения: пока взгляд меняется кадр за кадром
  // (свайп подстройки контуров, поворот по датчику), перерендериваем редко —
  // blit и так двигает оверлей точно, а перерендер нужен только чтобы не
  // выйти за поля запаса. Иначе порог наклона 4 px перерендеривал кэш на
  // каждый кадр жеста, и полный рендер горел всё время движения
  const azDeltaPx = Number.isFinite(cache.lastAz)
    ? Math.abs(
        driftProj.angleToView(az, tilt)!.x -
          driftProj.angleToView(cache.lastAz, tilt)!.x,
      )
    : Infinity;
  const tiltDeltaPx = Number.isFinite(cache.lastTilt)
    ? Math.abs(
        driftProj.angleToView(az, tilt)!.y -
          driftProj.angleToView(az, cache.lastTilt)!.y,
      )
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

  // Пороги дрейфа: в линейном режиме в покое — точные (наклон дальше 4 px
  // перерендеривает), в движении — грубые (только край запаса) плюс чёткий
  // кадр на остановке. Под пинхолом blit — не точная трансляция (край
  // сжимается/растягивается), поэтому его точный порог действует и во время
  // движения; иначе после трёх pointer-кадров контур прыгал при перерендере.
  // Порог азимута — в ПИКСЕЛЯХ края, а не в долях запаса:
  // ошибка на краю = дрейф · tan²(fovH/2) (docs/AR-OPTICS-AUDIT.md, №6)
  const driftLimit = PINHOLE_ENABLED
    ? driftAzPx >
        Math.max(
          1,
          (PINHOLE_EDGE_EPS_PX * uiScale) / Math.tan(fovH / 2) ** 2,
        ) ||
      driftTiltPx > TILT_DRIFT_PX
    : moving
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
    const cacheOpts: OverlayOptions = {
      anchorAzRad: anchorAz,
      horizonFrac: AR_HORIZON_FRAC,
      projection: PINHOLE_ENABLED ? "pinhole" : "linear",
    };
    const rctx = cache.ridges.getContext("2d")!;
    const lctx = cache.labels.getContext("2d")!;
    rctx.save();
    lctx.save();
    // Сдвигаем систему кэша: точка (0,0) кэша — это (−marginX, −marginY)
    // экрана. drawOverlay рисует кадр шириной bufW/bufH с центром по кэшу —
    // чтобы совместить, переносим начало координат
    rctx.translate(marginX, marginY);
    lctx.translate(marginX, marginY);
    drawOverlay(rctx, state, cacheView, uiScale, {
      ...cacheOpts,
      labels: false,
      viewWidth: width,
      viewHeight: height,
    });
    drawOverlay(lctx, state, cacheView, uiScale, {
      ...cacheOpts,
      ridges: false,
      viewWidth: width,
      viewHeight: height,
    });
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
  // Проекция строится по СВЕЖЕМУ якорю (он мог появиться только что — на
  // первом кадре driftProj выше был с центром по текущему взгляду)
  const anchorProj = createLinearProjection({
    width,
    height,
    centerAzRad: cache.anchor!.azRad,
    tiltRad: cache.anchor!.tiltRad,
    fovRad: fovH || 1,
    fovVRad: fovV || 1,
    horizonFrac: AR_HORIZON_FRAC,
  });
  const ox =
    (width - bufW) / 2 +
    anchorProj.angleToView(cache.anchor!.azRad, tilt)!.x -
    anchorProj.angleToView(az, tilt)!.x;
  const oy =
    (height - bufH) / 2 +
    anchorProj.angleToView(az, cache.anchor!.tiltRad)!.y -
    anchorProj.angleToView(az, tilt)!.y;

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
  // Частота реальных кадров камеры: requestVideoFrameCallback срабатывает
  // на каждый отрисованный в видео кадр (камера обычно 30/с, цикл AR — до
  // 60/с). Callback одноразовый — перерегистрируемся в каждом, иначе счёт
  // остановится после первого кадра
  let camFrames = 0;
  let camWinStart = 0;
  let camLastAt = 0;
  let camFps = NaN;
  const onCamFrame = () => {
    const now = performance.now();
    camLastAt = now;
    if (!camWinStart) camWinStart = now;
    camFrames++;
    if (now - camWinStart >= 1000) {
      camFps = (camFrames * 1000) / (now - camWinStart);
      camFrames = 0;
      camWinStart = now;
    }
    videoEl.requestVideoFrameCallback?.(onCamFrame);
  };
  videoEl.requestVideoFrameCallback?.(onCamFrame);
  const f = (v: number): string => (Number.isFinite(v) ? v.toFixed(0) : "—");
  return {
    update: () => {
      const so = screen.orientation;
      // Больше секунды без кадров камеры — видео стоит (пауза/конец потока)
      const camStalled =
        camLastAt > 0 && performance.now() - camLastAt > 1500;
      el.textContent =
        `β=${f(beta)} γ=${f(gamma)}\n` +
        `win: ${so?.type ?? "?"} ${so?.angle ?? "?"}°\n` +
        `css: ${softAngleDeg()}°\n` +
        `frame: ${videoEl.videoWidth}×${videoEl.videoHeight}\n` +
        `cam: ${Number.isFinite(camFps) ? `${camFps.toFixed(1)} fps` : "—"}${camStalled ? " ⏸" : ""}\n` +
        `canvas: ${canvas.width}×${canvas.height}`;
    },
    remove: () => {
      window.removeEventListener("deviceorientation", onOrient);
      el.remove();
    },
  };
}
