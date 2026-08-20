/**
 * Web Worker: ray-marching горизонта и видимость пиков (ARCHITECTURE.md).
 * Источник высот — DemSource (DATA-PIPELINE.md): локальный патч → Terrarium.
 *
 * Протокол сообщений:
 *   → { type: 'init', patchBaseUrls?, reqId? }
 *   → { type: 'compute', origin, peaks, reqId? }
 *   → { type: 'viewpoint', peak, reqId? }   — подобрать точку, откуда вершина видна
 *   ← { type: 'result', horizon, stepRad, peaks, observerH, computeMs, reqId? }
 *   ← { type: 'viewpoint', origin, azimuthRad, reqId? }
 *   ← { type: 'error', message, reqId? }
 *
 * `reqId` эхом возвращается в ответе. Compute-запросы, ещё не взятые в
 * работу, вытесняются свежим (latest-only, см. jobQueue): на вытесненный
 * запрос ответа не будет, и main узнаёт актуальный результат по reqId.
 */

import { DemSource } from "../core/dem-source";
import { azimuthRad, destination, type LatLon } from "../core/geo";
import {
    checkPeakVisibility,
    computeLayeredHorizon,
    filterVisiblePeaks,
    type SampleHint,
    type VisiblePeak,
} from "../core/horizon";
import type { Peak } from "../core/peaks";

export interface InitMessage {
  type: "init";
  /**
   * URL локальных источников рельефа по убыванию детализации
   * (tiles/{region} | tiles/hi + tiles/global); пустой — только Terrarium
   */
  patchBaseUrls?: string[];
  reqId?: number;
}

export interface ComputeMessage {
  type: "compute";
  origin: LatLon;
  /** Переопределение высоты наблюдателя (для навигации вверх/вниз) */
  observerHeightOverride?: number;
  /**
   * Показывать ли превью (грубый ближний кадр) перед полным расчётом.
   * Ставит main: превью уместно при первом расчёте и при прыжке на новое
   * место (холодные тайлы), не уместно при drag/малых шагах (тёплые тайлы —
   * превью лишь откатило бы картинку к грубому силуэту посреди жеста)
   */
  wantPreview?: boolean;
  reqId?: number;
}

/** Пики региона — отдельным сообщением, а не в каждом compute: у iberia 49 тыс.
 *  объектов, и их structuredClone в каждое сообщение при drag (каждый
 *  pointermove) — скрытый налог на main-потоке */
export interface SetPeaksMessage {
  type: "setPeaks";
  peaks: Peak[];
  reqId?: number;
}

/** Подобрать точку, с которой вершина действительно видна */
export interface ViewpointMessage {
  type: "viewpoint";
  peak: Peak;
  /** Желаемое удаление от вершины, м */
  distM?: number;
  reqId?: number;
}

export interface ViewpointResult {
  type: "viewpoint";
  origin: LatLon;
  /** Азимут с точки на вершину, рад */
  azimuthRad: number;
  reqId?: number;
}

/**
 * Превью: грубый ближний кадр (720 лучей, 0–12 км) — то, что человек видит
 * в первую секунду, пока полный веер тайлов не приехал. Без пиков: их
 * классификация зависит от полного горизонта по всем лучам, и на грубом
 * шаге дальние вершины были бы помечены неверно
 */
export interface PreviewMessage {
  type: "preview";
  /** Углы горизонта по лучам, рад (верхний слой) */
  horizon: Float32Array;
  /** Шаг между лучами, рад */
  stepRad: number;
  /** Слои горизонта по дистанционным корзинам */
  layers: Float32Array[];
  /** Дистанция до точки горизонта по лучам */
  distanceToHorizonM: Float32Array;
  /** Гребни силуэта по корзинам дистанций [корзина][луч] */
  crests: Float32Array[];
  /** Высота наблюдателя из DEM */
  observerH: number;
  /** Время превью-марша, мс */
  computeMs: number;
  reqId?: number;
}

export interface ResultMessage {
  type: "result";
  /** Углы горизонта по лучам, рад (верхний слой) */
  horizon: Float32Array;
  /** Шаг между лучами, рад */
  stepRad: number;
  /** Слои горизонта по дистанционным корзинам */
  layers: Float32Array[];
  /** Дистанция до точки горизонта по лучам */
  distanceToHorizonM: Float32Array;
  /** Фронты в плоском виде (SoA): по 4 значения на фронт —
   * distM, distEndM, elevStartRad, elevMaxRad. Передаётся трансфером —
   * structuredClone тысяч объектов VisibleFront стоил заметных миллисекунд,
   * а ветка «старый воркер без flat» недостижима: воркер и страница — один бандл */
  frontsFlat: Float32Array;
  /** Оффсеты: у луча i фронты frontsFlat[frontsOffsets[i] .. frontsOffsets[i+1]] */
  frontsOffsets: Uint32Array;
  /** Гребни силуэта по корзинам дистанций [корзина][луч] */
  crests: Float32Array[];
  /** Видимые пики */
  peaks: VisiblePeak[];
  /** Высота наблюдателя из DEM */
  observerH: number;
  /** Разбивка времени расчёта, мс (для лога) */
  prefetchMs: number;
  marchMs: number;
  peaksMs: number;
  packMs: number;
  computeMs: number;
  reqId?: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
  reqId?: number;
}

export type WorkerInMessage =
  | InitMessage
  | ComputeMessage
  | SetPeaksMessage
  | ViewpointMessage;
export type WorkerOutMessage =
  | ResultMessage
  | PreviewMessage
  | ErrorMessage
  | ViewpointResult;

let dem: DemSource | null = null;
/** Пики текущего региона — живут в воркере (см. SetPeaksMessage) */
let workerPeaks: Peak[] = [];
/**
 * reqId последнего полученного compute. Если во время идущего расчёта пришёл
 * свежий compute, текущий устарел: он бросает работу на ближайшей границе
 * фаз, а не тратит сеть и CPU впустую (main всё равно отбросил бы его ответ
 * по reqId). Без этого двойной compute при старте — пустой список пиков,
 * затем с пиками — отрабатывал первый полностью (полный веер + марш) и
 * задерживал видимый кадр на секунды
 */
let latestComputeReqId = 0;

/**
 * Инициализация источника высот идёт асинхронно, а `self.onmessage = async`
 * обработчики в очередь не выстраивает: `compute`, пришедший следом за `init`,
 * стартовал параллельно с `dem.init()`. Пока индекс патча не прочитан,
 * `inPatch()` всегда ложен, и первая (самая заметная) панорама считалась по
 * грубому Terrarium вместо выбранного детального патча.
 *
 * Поэтому храним промис инициализации и ждём его в начале расчётов. Промис
 * никогда не отклоняется: недоступный патч — это работа по Terrarium, а не
 * отказ всему воркеру. Идущие расчёты держат свою ссылку на источник
 * (см. `compute`), поэтому подмена `dem` их не задевает.
 */
let initPromise: Promise<void> = Promise.resolve();

/** Максимальная дальность луча — синхронизирована с computeHorizon */
const MAX_DIST_M = 200_000;
/** Сектора секторных границ обрыва: 5° — в 50 раз грубее луча */
const SECTOR_COUNT = 72;

// Превью: грубый ближний кадр до полного расчёта. 720 лучей × ~93 шага до
// 12 км ≈ 67 тыс. выборок — в ~30 раз меньше полного марша (1.93 млн).
// Шаг 0.5° на дистанции 12 км — это ~105 м, уровень ячейки DEM: дальше мельчить
// превью незачем, финальный кадр всё равно пересчитает на 3600 лучей
const PREVIEW_MAX_DIST_M = 12_000;
const PREVIEW_STEP_RAD = (0.5 * Math.PI) / 180;
/** Веер волны 1: те же 5° по азимуту, шаг точек 4 км */
const PREVIEW_FAN_STEP_M = 4_000;
/**
 * Жёсткий предел ожидания волны 1 (ближних тайлов превью). Страховка от
 * медленной/мёртвой сети: превью обязано выйти быстро, дальше считаем по
 * тому, что успело загрузиться (дыры закроет полный кадр, который ждёт
 * полный веер с обычным таймаутом)
 */
const PREVIEW_WAVE1_DEADLINE_MS = 1_000;

async function compute(
  origin: LatLon,
  heightOverride: number | undefined,
  wantPreview: boolean,
  reqId: number,
): Promise<ResultMessage | null> {
  const source = dem;
  if (!source) throw new Error("Worker не инициализирован (init)");
  const t0 = performance.now();
  // Устарел ли расчёт: в очередь пришёл свежий compute с другим reqId.
  // Проверяем на границах фаз — волна 1 и волна 2 уже ограничены (дедлайн
  // и таймауты), а вот марш и пики бросаем, чтобы не жечь CPU впустую
  const superseded = (): boolean => reqId !== latestComputeReqId;

  // Высота наблюдателя: max по окрестности 3×3 (не ниже поверхности)
  const observerH = heightOverride ?? (await source.observerHeightSafe(origin));
  const tObserver = performance.now();

  // Именно `source`, а не живая переменная `dem`: смена региона могла прийти
  // прямо посреди расчёта, и тогда выборка пошла бы из нового источника с
  // пустым кешем тайлов — по уже предзагруженной панораме, но без данных.
  // Подсказки таблицы марша: LOD пирамиды и зум Terrarium предвычислены по
  // дальности шага — из горячего цикла уходит и логарифм lodForDistance, и
  // перебор ZOOM_RULES
  const sampleFn = (pos: LatLon, distM: number, hint?: SampleHint): number =>
    source.sample(pos, distM, hint);
  const marchDeps = {
    lodForDistance: (distM: number) => source.lodForDistance(distM),
  };

  // Волна 1: ближняя зона. При wantPreview — с коротким таймаутом и ближним
  // веером (превью обязано выйти быстро, дыра в нём допустима). Без превью
  // (drag, малые шаги) — только 3×3 Terrarium с обычным таймаутом: она нужна
  // и полному маршу (веер 0–2 км не покрывает), а дыры в финальном кадре
  // недопустимы
  let tNear = tObserver;
  let tPreviewEnd = tObserver;
  if (wantPreview) {
    await source.prefetchNearZone(
      origin,
      15_000,
      PREVIEW_FAN_STEP_M,
      PREVIEW_WAVE1_DEADLINE_MS,
    );
    if (superseded()) return null; // устаревший: не маршируем и не постим
    tNear = performance.now();

    // Превью-марш: грубый шаг по азимуту, только ближняя зона. Пиков не несёт —
    // классификация видимости зависит от полного горизонта по всем лучам
    const previewLayered = computeLayeredHorizon(origin, observerH, sampleFn, {
      azimuthStepRad: PREVIEW_STEP_RAD,
      maxDistM: PREVIEW_MAX_DIST_M,
      marchDeps,
    });
    tPreviewEnd = performance.now();
    if (superseded()) return null; // пока маршировали — пришёл свежий
    // Постим превью СРАЗУ, не дожидаясь волны 2 и полного марша: именно это
    // даёт быстрый первый кадр, пока дальние тайлы качаются
    const preview: PreviewMessage = {
      type: "preview",
      horizon: previewLayered.layers[0],
      stepRad: previewLayered.stepRad,
      layers: previewLayered.layers,
      distanceToHorizonM: previewLayered.distanceToHorizonM,
      crests: previewLayered.crests,
      observerH,
      computeMs: tPreviewEnd - tNear,
      reqId,
    };
    postTransfer(preview);
  } else {
    await source.prefetchNear(origin);
    if (superseded()) return null;
    tNear = performance.now();
    tPreviewEnd = tNear;
  }

  // Волна 2: полный веер — запускаем сразу после волны 1 (греет соединения,
  // пока мы считали превью), но ждём только сейчас
  const fanTasks: Promise<void>[] = [];
  for (let az = 0; az < 2 * Math.PI; az += (5 * Math.PI) / 180) {
    fanTasks.push(
      source.prefetchAlongRay(origin, az, MAX_DIST_M, 8_000, destination),
    );
  }
  await Promise.all(fanTasks);
  if (superseded()) return null; // волна 2 грузила дальние тайлы — пришёл свежий
  const tFull = performance.now();

  const layered = computeLayeredHorizon(origin, observerH, sampleFn, {
    marchDeps,
    // Секторные верхние границы по уже загруженным тайлам: консервативны,
    // поэтому обрыв луча не меняет видимый результат, а дальние шаги
    // (самая дорогая часть марша) в равнинных секторах выпадают
    sectorMax: source.sectorMaxHeights(origin, SECTOR_COUNT),
  });
  const tMarch = performance.now();
  const visible = filterVisiblePeaks(
    origin,
    observerH,
    workerPeaks,
    sampleFn,
    layered,
    marchDeps,
  );
  const tPeaks = performance.now();

  // Фронты — в плоский SoA для трансфера (объекты соберёт main-поток)
  const rayCount = layered.fronts.length;
  const frontsOffsets = new Uint32Array(rayCount + 1);
  for (let i = 0; i < rayCount; i++) {
    frontsOffsets[i + 1] = frontsOffsets[i] + layered.fronts[i].length * 4;
  }
  const frontsFlat = new Float32Array(frontsOffsets[rayCount]);
  for (let i = 0; i < rayCount; i++) {
    let o = frontsOffsets[i];
    for (const f of layered.fronts[i]) {
      frontsFlat[o++] = f.distM;
      frontsFlat[o++] = f.distEndM;
      frontsFlat[o++] = f.elevStartRad;
      frontsFlat[o++] = f.elevMaxRad;
    }
  }
  const tPack = performance.now();

  return {
    type: "result",
    horizon: layered.layers[0], // ближний слой = основной горизонт
    stepRad: layered.stepRad,
    layers: layered.layers,
    distanceToHorizonM: layered.distanceToHorizonM,
    frontsFlat,
    frontsOffsets,
    crests: layered.crests,
    peaks: visible,
    observerH,
    // Сеть: волна 1 (observer→near) + волна 2 (превью→full); превью-марш
    // вычтен, чтобы не смешивать сеть с CPU
    prefetchMs: (tNear - tObserver) + (tFull - tPreviewEnd),
    marchMs: tMarch - tFull,
    peaksMs: tPeaks - tMarch,
    packMs: tPack - tPeaks,
    computeMs: performance.now() - t0,
  };
}

/**
 * Выбор точки обзора для «перелёта» к вершине.
 *
 * Раньше точка ставилась просто по обратному азимуту от прежнего места — при
 * прыжке через полпланеты направление случайное, и наблюдатель оказывался в
 * цирке под соседней стеной: искали Белуху, а видели Корону Алтая в километре.
 *
 * Пробуем 12 азимутов вокруг вершины и берём тот, откуда она действительно
 * видна, а из таких — самый низкий (открытая долина, гора возвышается целиком).
 */
async function pickViewpoint(
  peak: Peak,
  distM: number,
): Promise<ViewpointResult> {
  const source = dem;
  if (!source) throw new Error("Worker не инициализирован (init)");
  const summit: LatLon = { lat: peak.lat, lon: peak.lon };
  const candidates: { origin: LatLon; observerH: number; visible: boolean }[] =
    [];

  for (let i = 0; i < 12; i++) {
    const az = (i * 2 * Math.PI) / 12;
    const origin = destination(summit, az, distM);
    const toPeak = azimuthRad(origin, summit);
    try {
      await source.prefetchAlongRay(
        origin,
        toPeak,
        distM * 1.2,
        200,
        destination,
      );
      const observerH = await source.observerHeightSafe(origin);
      const sample = (pos: LatLon, d: number): number => source.sample(pos, d);
      const check = checkPeakVisibility(
        origin,
        observerH,
        peak,
        sample,
        Infinity,
      );
      candidates.push({
        origin,
        observerH,
        visible: check?.visibility === "visible",
      });
    } catch {
      /* нет данных в этой точке — пропускаем */
    }
  }

  const visible = candidates.filter((c) => c.visible);
  const pool = visible.length ? visible : candidates;
  if (!pool.length) {
    return { type: "viewpoint", origin: summit, azimuthRad: 0 };
  }
  // Из точек с видимой вершиной — самая низкая: оттуда гора видна целиком
  const best = pool.reduce((a, b) => (b.observerH < a.observerH ? b : a));
  return {
    type: "viewpoint",
    origin: best.origin,
    azimuthRad: azimuthRad(best.origin, summit),
  };
}

/**
 * Очередь заданий. `onmessage = async` обработчики в очередь не выстраивает,
 * поэтому её ведём сами: сообщения обрабатываются строго по порядку прихода
 * (в частности, расчёты ждут завершения `init`).
 *
 * Compute-запросы схлопываются до последнего необработанного: при drag'е
 * main шлёт пересчёт почти на каждый pointermove, и очередь устаревших
 * задач росла быстрее, чем считалась, — каждая тратила CPU и prefetch-
 * запросы, а main всё равно отбрасывал их ответы по reqId. Свежий compute
 * вытесняет ещё не начатые; ИДУЩИЙ расчёт вытесняется на границе фаз
 * (см. latestComputeReqId и superseded в compute).
 */
let jobQueue: WorkerInMessage[] = [];
let pumping = false;

self.onmessage = (ev: MessageEvent<WorkerInMessage>) => {
  const msg = ev.data;
  if (msg.type === "compute") {
    jobQueue = jobQueue.filter((j) => j.type !== "compute");
    latestComputeReqId = msg.reqId ?? latestComputeReqId;
  }
  jobQueue.push(msg);
  void pump();
};

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    let msg: WorkerInMessage | undefined;
    while ((msg = jobQueue.shift()) !== undefined) {
      await handle(msg);
    }
  } finally {
    pumping = false;
  }
}

/** Пост превью/результата с трансфером типизированных буферов (без копирования).
 *  horizon — тот же буфер, что layers[0], поэтому в списке трансферов его нет
 *  (дубль ArrayBuffer запрещён); фронты — только у полного result */
function postTransfer(
  msg: PreviewMessage | ResultMessage,
): void {
  const transfers: ArrayBuffer[] = [
    ...msg.layers.map((a) => a.buffer),
    msg.distanceToHorizonM.buffer,
    ...msg.crests.map((a) => a.buffer),
  ];
  if (msg.type === "result") {
    transfers.push(msg.frontsFlat.buffer, msg.frontsOffsets.buffer);
  }
  (self as unknown as Worker).postMessage(msg, transfers);
}

async function handle(msg: WorkerInMessage): Promise<void> {
  const reqId = msg.reqId;
  try {
    if (msg.type === "init") {
      initPromise = (async () => {
        const next = new DemSource({ patchBaseUrls: msg.patchBaseUrls });
        try {
          await next.init();
        } catch (err) {
          // Индекс патча не открылся (обрыв сети, битый деплой Pages). Это не
          // повод отказывать в панораме: DemSource без патча считает по
          // Terrarium. Раньше отклонённый промис оставался в переменной, и
          // каждый следующий расчёт падал на нём же — до перезагрузки
          // страницы, даже когда сеть возвращалась
          console.warn("DEM-патч недоступен, работаем по Terrarium:", err);
        }
        dem = next;
      })();
      await initPromise;
      return;
    }
    // Пики региона: живут в воркере, чтобы не клонировать их в каждый compute
    if (msg.type === "setPeaks") {
      workerPeaks = msg.peaks;
      return;
    }
    // Расчёты ждут инициализацию: иначе патч рельефа подключится уже после
    // того, как панорама посчитана по грубым данным
    await initPromise;
    if (msg.type === "viewpoint") {
      const out = await pickViewpoint(msg.peak, msg.distM ?? 6_000);
      self.postMessage({ ...out, reqId });
      return;
    }
    if (msg.type === "compute") {
      const result = await compute(
        msg.origin,
        msg.observerHeightOverride,
        msg.wantPreview ?? false,
        reqId ?? 0,
      );
      // Устаревший compute (в очередь пришёл свежий): ответ не нужен —
      // main его отбросил бы по reqId, а мы уже не тратили на него марш
      if (!result) return;
      result.reqId = reqId;
      postTransfer(result);
    }
  } catch (err) {
    const out: ErrorMessage = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      reqId,
    };
    self.postMessage(out);
  }
}
