/**
 * DemSource — единая точка доступа к высотам (docs/DATA-PIPELINE.md):
 *   запрос → локальные слои по убыванию детализации (патч региона / hi-слой
 *   ~87 м / базовая пирамида ~217 м) → Terrarium (онлайн) → NaN.
 * Ray-marching знает только синхронный sample() после prefetch.
 */

import { DemSampler } from "./dem";
import { bboxContains, destination, type LatLon } from "./geo";
import type { SampleHint } from "./horizon";
import { sectorBoundsForTiles, type SectorTile } from "./sector-bounds";
import {
    TerrariumSampler,
    tileBbox as terrariumTileBbox,
    ZOOM_RULES,
    zoomForDistance,
} from "./terrarium";

export interface DemSourceOptions {
  /**
   * URL локальных источников в порядке убывания детализации
   * (tiles/{region}, tiles/hi, tiles/global); пустой — только Terrarium
   */
  patchBaseUrls?: string[];
  terrariumBaseUrl?: string;
  fetchFn?: typeof fetch;
  /**
   * Регион скачан: индексы источников читать из офлайн-хранилища, в сеть
   * не ходить (обновление детектит фоновая проверка в main)
   */
  offlineFirst?: boolean;
}

/** Ближняя зона: тут разница в разрешении источников видна на панораме */
const NEAR_M = 30_000;
/** Патч детальнее этого порога считаем «своим» и приоритетным (90-м патчи) */
const FINE_RES_M = 120;
/**
 * Таймаут ближних тайлов превью (см. prefetchNearZone). Короткий намеренно:
 * превью обязано выйти быстро, дыра в нём допустима, а финальный кадр по
 * полному вееру с обычным таймаутом её пересчитает
 */
const NEAR_FETCH_TIMEOUT_MS = 2_500;

/** Подключённый источник: сэмплер + классификация по разрешению */
interface Patch {
  sampler: DemSampler;
  bbox: [number, number, number, number];
  /**
   * Патч грубее онлайн-данных (глобальная пирамида ~217 м против Terrarium
   * ~90 м): в ближней зоне сначала спрашиваем сеть, патч — офлайн-запас.
   * Детальный слой (~87 м) и патчи регионов грубым не считаются.
   */
  coarse: boolean;
}

export class DemSource {
  private patches: Patch[] = [];
  readonly terrarium: TerrariumSampler;
  /** Регион скачан: индексы читаем из кеша, без сети (см. DemSourceOptions) */
  private readonly offlineFirst: boolean;

  constructor(options: DemSourceOptions) {
    this.offlineFirst = options.offlineFirst ?? false;
    // Регион скачан: тайлы только из офлайн-хранилища (loadTile не ходит в сеть)
    const samplerOpts = {
      fetchFn: options.fetchFn,
      offlineOnly: options.offlineFirst,
    };
    this.patchSamplers = (options.patchBaseUrls ?? []).map(
      (baseUrl) => new DemSampler({ baseUrl, ...samplerOpts }),
    );
    this.terrarium = new TerrariumSampler({
      baseUrl: options.terrariumBaseUrl,
      ...samplerOpts,
    });
  }

  /** Сэмплеры до init(): индексы им ещё не загружены */
  private readonly patchSamplers: DemSampler[];

  /**
   * Первый (самый детальный) подключённый сэмплер — для панели настроек и
   * прочих мест, которым нужен «патч» как таковой.
   */
  get patch(): DemSampler | null {
    return this.patches[0]?.sampler ?? null;
  }

  async init(): Promise<void> {
    // Источники независимы: один не открылся (обрыв сети, битый деплой) —
    // работаем на остальных, а не падаем целиком
    const loaded = await Promise.all(
      this.patchSamplers.map(async (sampler): Promise<Patch | null> => {
        try {
          const index = await sampler.loadIndex(this.offlineFirst);
          return {
            sampler,
            bbox: index.bbox,
            coarse: sampler.finestResM() > FINE_RES_M,
          };
        } catch (err) {
          console.warn("DEM-источник недоступен, пропускаем:", err);
          return null;
        }
      }),
    );
    this.patches = loaded.filter((p): p is Patch => p !== null);
  }

  /** Точка внутри bbox хотя бы одного локального источника? */
  inPatch(pos: LatLon): boolean {
    return this.patches.some((p) => bboxContains(pos, p.bbox));
  }

  /** Регион скачан и источники работают без сети (см. DemSourceOptions) */
  get isOffline(): boolean {
    return this.offlineFirst;
  }

  /**
   * Зонд обрезки хвоста офлайн-лучей (core/horizon.ts, computeNeverAgain):
   * есть ли ДАННЫЕ в точке по уже загруженным тайлам. Онлайн — всегда true,
   * обрезка отключена. Вызывается после prefetch, когда тайлы веера
   * загружены, поэтому отсутствие ключа в кеше и означает «нет данных».
   */
  mayHaveOfflineData(pos: LatLon): boolean {
    if (!this.offlineFirst) return true;
    for (const p of this.patches) {
      if (p.sampler.hasLoadedTileAt(pos)) return true;
    }
    return this.terrarium.hasLoadedTileAt(pos);
  }

  /** Источники, чей bbox покрывает точку, по классу детализации */
  private covering(pos: LatLon, coarse: boolean): Patch[] {
    return this.patches.filter(
      (p) => p.coarse === coarse && bboxContains(pos, p.bbox),
    );
  }

  /**
   * Синхронная выборка: берём точнейший из доступных источников.
   * Детальные слои (патч региона, hi-слой ~87 м) приоритетнее всегда;
   * грубая глобальная пирамида — только вдали или там, где Terrarium не
   * загружен (офлайн). NaN — нет данных нигде.
   */
  sample(pos: LatLon, distM: number, hint?: SampleHint): number {
    // Кеш последнего успешного источника: луч идёт внутри одного патча
    // тысячи шагов, а covering() (filter по bbox всех источников) звучал
    // на каждую выборку. Порядок опроса источников не меняется: кеш — это
    // тот же первый подошедший источник прошлой выборки.
    //
    // Кеш разделён по зонам (ближняя/дальняя): вдали грубый патч —
    // законный фолбэк (сеть могла не загрузиться), но если он «прилип»
    // к концу луча, следующий луч начал бы читать ближнюю зону из грубой
    // пирамиды, хотя Terrarium рядом загружен — скачок детализации на
    // стыке лучей и разрыв контура.
    const near = distM < NEAR_M;
    const last = near ? this.lastHitNear : this.lastHitFar;
    if (last) {
      let h: number;
      if (last === this.terrarium) {
        h = this.terrarium.sample(pos, zoomForDistance(distM), hint?.zoom);
      } else {
        h = (last as Patch).sampler.sample(pos, 0, hint);
      }
      if (h === h) return h;
    }
    const fine = this.covering(pos, false);
    const coarse = this.covering(pos, true);
    // Вдали патч важнее сети (офлайн-запас), вблизи грубый — после неё
    const order: (Patch | TerrariumSampler)[] =
      distM >= NEAR_M
        ? [...fine, ...coarse, this.terrarium]
        : [...fine, this.terrarium, ...coarse];
    for (const src of order) {
      // Луч идёт на детальном LOD, но в разреженной пирамиде тайл может
      // отсутствовать (выбыл из бюджета) — тогда уходим глубже, до LOD 2
      // «вся суша», а уже потом к следующему источнику
      const h =
        src instanceof TerrariumSampler
          ? src.sample(pos, zoomForDistance(distM), hint?.zoom)
          : src.sampler.sample(pos, 0, hint);
      if (h === h) {
        if (near) this.lastHitNear = src;
        else this.lastHitFar = src;
        return h;
      }
    }
    if (near) this.lastHitNear = null;
    else this.lastHitFar = null;
    return NaN;
  }

  /** lodForDistance самого детального источника — для таблицы марша (подсказки) */
  lodForDistance(distM: number): number {
    const fine = this.patches.find((p) => !p.coarse);
    const sampler = fine?.sampler ?? this.patches[0]?.sampler;
    return sampler ? sampler.lodForDistance(distM) : 0;
  }

  /**
   * Глобальная верхняя граница высоты среди всех источников с загруженными
   * тайлами. Задел без потребителя: обрыв луча использует СЕКТОРНЫЕ границы
   * (sectorMaxHeights ниже) — у горного наблюдателя глобальная бесполезна
   * (H > hO: весь рельеф выше головы, хвост луча не отсечь).
   */
  loadedMaxHeight(): number {
    let max = this.terrarium.loadedMaxHeight;
    for (const p of this.patches) {
      const m = p.sampler.loadedMaxHeight;
      if (m > max) max = m;
    }
    return max;
  }

  /** Последний источник, давший высоту (см. sample) */
  /** Кеш источника по зонам (см. sample): фолбэк одной зоны не портит другую */
  private lastHitNear: Patch | TerrariumSampler | null = null;
  private lastHitFar: Patch | TerrariumSampler | null = null;

  /**
   * Верхние границы высот по секторам азимута — для обрыва лучей (P4).
   *
   * Каждый загруженный тайл всех источников приписывается секторам,
   * пересекающим его описанную окружность (см. core/sector-bounds.ts);
   * тайлы целиком ближе порога отсечения не учитываются — луч дальше порога
   * их не читает. Граница консервативна: занизить её нельзя, поэтому обрыв
   * не теряет видимый рельеф.
   */
  sectorMaxHeights(origin: LatLon, sectorCount: number): Float32Array {
    const tiles: SectorTile[] = [];
    for (const p of this.patches) {
      for (const [key, h] of p.sampler.tileMax) {
        const [lod, tx, ty] = key.split("/").map(Number);
        const bbox = p.sampler.tileBbox(lod, tx, ty);
        if (!bbox) continue;
        tiles.push({
          minLon: bbox[0],
          minLat: bbox[1],
          maxLon: bbox[2],
          maxLat: bbox[3],
          h,
        });
      }
    }
    for (const [key, h] of this.terrarium.loadedTileMaxes) {
      const [z, x, y] = key.split("/").map(Number);
      const bbox = terrariumTileBbox(z, x, y);
      tiles.push({
        minLon: bbox[0],
        minLat: bbox[1],
        maxLon: bbox[2],
        maxLat: bbox[3],
        h,
      });
    }
    return sectorBoundsForTiles(origin, tiles, sectorCount);
  }

  /** Предзагрузка вдоль луча всеми слоями */
  async prefetchAlongRay(
    origin: LatLon,
    azRad: number,
    maxDistM: number,
    stepM: number,
    destinationFn: (o: LatLon, az: number, d: number) => LatLon,
  ): Promise<void> {
    const tasks: Promise<void>[] = [
      this.terrarium.prefetchAlongRay(
        origin,
        azRad,
        maxDistM,
        stepM,
        destinationFn,
      ),
    ];
    // Грубую пирамиду не тянем там, где точку наблюдателя уже покрывает
    // детальный слой: лучи отсюда прочитают hi-тайлы, а global-тайлы того же
    // места — двойной трафик без выигрыша. Но «покрывает точку» ≠ «покрывает
    // весь луч»: у детального слоя бывают лакуны (берег, дыры в данных), и
    // там офлайн раньше получал дыру — скачанные базовые тайлы лежали в
    // IndexedDB, а в память сэмплера (синхронный sample) не читались. Поэтому
    // coarse пропускается не целиком, а только в точках, где детальный слой
    // ответит хотя бы на одном LOD (тем же фолбэком, что sample())
    const fineAtOrigin = this.covering(origin, false);
    for (const p of this.patches) {
      if (p.coarse && fineAtOrigin.length > 0) {
        const fine = fineAtOrigin;
        tasks.push(
          p.sampler.prefetchAlongRay(
            origin,
            azRad,
            maxDistM,
            stepM,
            destinationFn,
            (pos, distM) =>
              !fine.some((f) =>
                f.sampler.hasAnyCoverageAt(pos, this.lodForDistance(distM)),
              ),
          ),
        );
        continue;
      }
      tasks.push(
        p.sampler.prefetchAlongRay(
          origin,
          azRad,
          maxDistM,
          stepM,
          destinationFn,
        ),
      );
    }
    await Promise.all(tasks);
  }

  /**
   * Ближняя зона вокруг наблюдателя: окрестность тайлов на каждом зуме, где
   * они мельче шага предзагрузки по лучу.
   *
   * Только Terrarium: у пирамиды тайл 0.5° (десятки километров), и ближняя
   * зона попадает в него целиком — замер промахов дал ровный ноль.
   */
  async prefetchNear(origin: LatLon): Promise<void> {
    const zooms = new Set(
      ZOOM_RULES.filter((rule) => Number.isFinite(rule.upToDistM)).map(
        (r) => r.zoom,
      ),
    );
    await Promise.all(
      [...zooms].map((zoom) => this.terrarium.prefetchAround(origin, zoom)),
    );
  }

  /**
   * «Региональный» ли патч — в отличие от глобальных слоёв (hi-слой ~87 м,
   * глобальная пирамида ~217 м), чей bbox покрывает почти весь мир.
   * Превью (волна 1) качает только региональные патчи: ближний план и так
   * есть из Terrarium (~90 м) и патча региона, а глобальные слои грузятся
   * во второй волне для полного кадра — ждать их внешний origin ради превью
   * незачем (замер: подвешенный тайл hi-слоя держал волну 1 на таймауте 2.5 с)
   */
  private isRegionalPatch(p: Patch): boolean {
    const [minLon, minLat, maxLon, maxLat] = p.bbox;
    const lonSpan =
      minLon <= maxLon ? maxLon - minLon : 360 + maxLon - minLon;
    return lonSpan < 180 || maxLat - minLat < 120;
  }

  /** Ближний веер для превью-марша (0–15 км): Terrarium + региональные патчи */
  private async prefetchNearFan(
    origin: LatLon,
    maxDistM: number,
    stepM: number,
  ): Promise<void> {
    const regional = this.patches.filter(
      (p) => !p.coarse && this.isRegionalPatch(p),
    );
    const tasks: Promise<void>[] = [];
    for (let az = 0; az < 2 * Math.PI; az += (5 * Math.PI) / 180) {
      tasks.push(
        this.terrarium.prefetchAlongRay(
          origin,
          az,
          maxDistM,
          stepM,
          destination,
        ),
      );
      for (const p of regional) {
        tasks.push(
          p.sampler.prefetchAlongRay(origin, az, maxDistM, stepM, destination),
        );
      }
    }
    await Promise.all(tasks);
  }

  /**
   * Волна 1 для превью: ближняя зона (3×3 Terrarium + веер до maxDistM) с
   * КОРОТКИМ таймаутом сети. Превью — это быстрый грубый кадр: если ближний
   * тайл не приехал за 2.5 с, дальше ничего не приедет, и рисовать с дырой
   * лучше, чем ждать 8 секунд. Финальный кадр считается по полному вееру с
   * обычным таймаутом и пересчитывает дыры.
   *
   * `deadlineMs` — жёсткий предел ожидания (страховка от медленной сети):
   * по истечении возвращаемся, не дожидаясь остатка загрузок. Таймауты
   * сэмплеров восстанавливаются сразу (в finally), а фоновые загрузки
   * продолжаются и переиспользуются второй волной (loadTile дедуплицирует
   * по `pending`), так что полный кадр данные не теряет.
   */
  async prefetchNearZone(
    origin: LatLon,
    maxDistM: number,
    stepM: number,
    deadlineMs?: number,
  ): Promise<void> {
    const saved: number[] = [this.terrarium.fetchTimeoutMs];
    this.terrarium.fetchTimeoutMs = NEAR_FETCH_TIMEOUT_MS;
    for (const p of this.patches) {
      saved.push(p.sampler.fetchTimeoutMs);
      p.sampler.fetchTimeoutMs = NEAR_FETCH_TIMEOUT_MS;
    }
    try {
      const work = Promise.all([
        this.prefetchNear(origin),
        this.prefetchNearFan(origin, maxDistM, stepM),
      ]);
      if (deadlineMs) {
        await Promise.race([
          work,
          new Promise<void>((resolve) => setTimeout(resolve, deadlineMs)),
        ]);
      } else {
        await work;
      }
    } finally {
      this.terrarium.fetchTimeoutMs = saved[0];
      this.patches.forEach((p, i) => (p.sampler.fetchTimeoutMs = saved[i + 1]));
    }
  }

  /** Высота наблюдателя: точнейший источник, с фолбэком на остальные.
   *  Порядок и фолбэк — как в sample(): bbox ≠ покрытие, и разреженный
   *  детальный слой (hi: bbox глобальный, тайлы — только p-регионы) может
   *  содержать точку, но не иметь в ней данных — тогда уходим дальше,
   *  а не бросаем (Краснодар на ровном месте давал «Точка вне покрытия DEM»
   *  при живом Terrarium) */
  async observerHeight(pos: LatLon): Promise<number> {
    for (const p of this.covering(pos, false)) {
      try {
        return await p.sampler.observerHeight(pos);
      } catch {
        // нет данных в этой точке — следующий источник
      }
    }
    try {
      return await this.terrarium.heightAt(pos);
    } catch {
      // нет данных в Terrarium — остаются грубые слои
    }
    for (const p of this.covering(pos, true)) {
      try {
        return await p.sampler.observerHeight(pos);
      } catch {
        // нет данных в этой точке — следующий источник
      }
    }
    throw new Error("Точка вне покрытия DEM");
  }

  /**
   * Высота наблюдателя для ray-marching.
   *
   * Источник должен совпадать с тем, по которому считаются лучи, иначе
   * наблюдатель проваливается под собственный рельеф. В ближней зоне лучи
   * идут по Terrarium (90 м), поэтому и высоту берём оттуда; защита max 3×3
   * применяется только к своим детальным патчам — на пирамиде с ячейкой
   * 217 м окрестность 3×3 охватывает 650 м и в узкой долине завышает высоту
   * на сотни метров (Алтай: 2976 м вместо 2660 м).
   *
   * Возвращается высота земли: рост глаз добавляет ray-marching
   * (`observerElevationM`), и делать это дважды незачем.
   */
  async observerHeightSafe(pos: LatLon): Promise<number> {
    // Порядок — как в sample(): детальные слои → Terrarium → грубые. Тот же
    // фолбэк по данным, а не по bbox: у разреженного hi bbox глобальный, и
    // без него точка в Краснодаре (равнина, покрытия нет) роняла расчёт,
    // хотя Terrarium и пирамида оба готовы отдать высоту
    for (const p of this.covering(pos, false)) {
      try {
        return await p.sampler.observerHeightSafe(pos);
      } catch {
        // нет данных в этой точке — следующий источник
      }
    }
    try {
      return await this.terrarium.heightAt(pos);
    } catch {
      // нет данных в Terrarium — остаются грубые слои
    }
    for (const p of this.covering(pos, true)) {
      try {
        return await p.sampler.observerHeightSafe(pos);
      } catch {
        // нет данных в этой точке — следующий источник
      }
    }
    throw new Error("Точка вне покрытия DEM");
  }
}
