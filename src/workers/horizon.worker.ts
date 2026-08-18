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
  peaks: Peak[];
  /** Переопределение высоты наблюдателя (для навигации вверх/вниз) */
  observerHeightOverride?: number;
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
  /** Фронты видимости по лучам (для точных маркеров) */
  fronts: import("../core/horizon").VisibleFront[][];
  /** Фронты в плоском виде (SoA): по 4 значения на фронт —
   * distM, distEndM, elevStartRad, elevMaxRad. Передаётся трансфером —
   * structuredClone тысяч объектов VisibleFront стоил заметных миллисекунд */
  frontsFlat: Float32Array;
  /** Оффсеты: у луча i фронты frontsFlat[frontsOffsets[i] .. frontsOffsets[i+1]] */
  frontsOffsets: Uint32Array;
  /** Гребни силуэта по корзинам дистанций [корзина][луч] */
  crests: Float32Array[];
  /** Видимые пики */
  peaks: VisiblePeak[];
  /** Высота наблюдателя из DEM */
  observerH: number;
  computeMs: number;
  reqId?: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
  reqId?: number;
}

export type WorkerInMessage = InitMessage | ComputeMessage | ViewpointMessage;
export type WorkerOutMessage = ResultMessage | ErrorMessage | ViewpointResult;

let dem: DemSource | null = null;

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

async function compute(
  origin: LatLon,
  peaks: Peak[],
  heightOverride?: number,
): Promise<ResultMessage> {
  const source = dem;
  if (!source) throw new Error("Worker не инициализирован (init)");
  const t0 = performance.now();

  // Высота наблюдателя: max по окрестности 3×3 (не ниже поверхности)
  const observerH = heightOverride ?? (await source.observerHeightSafe(origin));

  // Предзагрузка тайлов веером лучей (шаг 5° — достаточно для покрытия).
  // Ближняя зона веером не покрывается: на первых километрах все лучи лежат
  // в одном-двух тайлах, а сетка предзагрузки (5°, 8 км) туда просто не
  // попадает — до двух третей ближних выборок приходились на незагруженные
  // тайлы, и передний план молча считался по грубой пирамиде вместо Terrarium
  const prefetchTasks: Promise<void>[] = [source.prefetchNear(origin)];
  for (let az = 0; az < 2 * Math.PI; az += (5 * Math.PI) / 180) {
    prefetchTasks.push(
      source.prefetchAlongRay(origin, az, MAX_DIST_M, 8_000, destination),
    );
  }
  await Promise.all(prefetchTasks);

  // Именно `source`, а не живая переменная `dem`: смена региона могла прийти
  // прямо посреди расчёта, и тогда выборка пошла бы из нового источника с
  // пустым кешем тайлов — по уже предзагруженной панораме, но без данных.
  // Подсказки таблицы марша: LOD пирамиды и зум Terrarium предвычислены по
  // дальности шага — из горячего цикла уходит и логарифм lodForDistance, и
  // перебор ZOOM_RULES
  const sample = (pos: LatLon, distM: number, hint?: SampleHint): number =>
    source.sample(pos, distM, hint);
  const marchDeps = {
    lodForDistance: (distM: number) => source.lodForDistance(distM),
  };

  const layered = computeLayeredHorizon(origin, observerH, sample, {
    marchDeps,
  });
  const visible = filterVisiblePeaks(
    origin,
    observerH,
    peaks,
    sample,
    layered,
    marchDeps,
  );

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

  return {
    type: "result",
    horizon: layered.layers[0], // ближний слой = основной горизонт
    stepRad: layered.stepRad,
    layers: layered.layers,
    distanceToHorizonM: layered.distanceToHorizonM,
    fronts: layered.fronts,
    frontsFlat,
    frontsOffsets,
    crests: layered.crests,
    peaks: visible,
    observerH,
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
 * вытесняет ещё не начатые; текущий расчёт досчитывается.
 */
let jobQueue: WorkerInMessage[] = [];
let pumping = false;

self.onmessage = (ev: MessageEvent<WorkerInMessage>) => {
  const msg = ev.data;
  if (msg.type === "compute") {
    jobQueue = jobQueue.filter((j) => j.type !== "compute");
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
        msg.peaks,
        msg.observerHeightOverride,
      );
      result.reqId = reqId;
      // Все типизированные буферы уходят без копирования (transfer):
      // horizon + 5 слоёв + дистанции + гребни + плоские фронты
      (self as unknown as Worker).postMessage(result, [
        result.horizon.buffer,
        ...result.layers.map((a) => a.buffer),
        result.distanceToHorizonM.buffer,
        ...result.crests.map((a) => a.buffer),
        result.frontsFlat.buffer,
        result.frontsOffsets.buffer,
      ]);
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
