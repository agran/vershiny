/**
 * DemSource — единая точка доступа к высотам (docs/DATA-PIPELINE.md):
 *   запрос → локальные слои по убыванию детализации (патч региона / hi-слой
 *   ~87 м / базовая пирамида ~217 м) → Terrarium (онлайн) → NaN.
 * Ray-marching знает только синхронный sample() после prefetch.
 */

import { DemSampler } from "./dem";
import { bboxContains, type LatLon } from "./geo";
import type { SampleHint } from "./horizon";
import { TerrariumSampler, ZOOM_RULES, zoomForDistance } from "./terrarium";

export interface DemSourceOptions {
  /**
   * URL локальных источников в порядке убывания детализации
   * (tiles/{region}, tiles/hi, tiles/global); пустой — только Terrarium
   */
  patchBaseUrls?: string[];
  terrariumBaseUrl?: string;
  fetchFn?: typeof fetch;
}

/** Ближняя зона: тут разница в разрешении источников видна на панораме */
const NEAR_M = 30_000;
/** Патч детальнее этого порога считаем «своим» и приоритетным (90-м патчи) */
const FINE_RES_M = 120;

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

  constructor(options: DemSourceOptions) {
    this.patchSamplers = (options.patchBaseUrls ?? []).map(
      (baseUrl) => new DemSampler({ baseUrl, fetchFn: options.fetchFn }),
    );
    this.terrarium = new TerrariumSampler({
      baseUrl: options.terrariumBaseUrl,
      fetchFn: options.fetchFn,
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
          const index = await sampler.loadIndex();
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
    // тот же первый подошедший источник прошлой выборки
    const last = this.lastHit;
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
        this.lastHit = src;
        return h;
      }
    }
    this.lastHit = null;
    return NaN;
  }

  /** lodForDistance самого детального источника — для таблицы марша (подсказки) */
  lodForDistance(distM: number): number {
    const fine = this.patches.find((p) => !p.coarse);
    const sampler = fine?.sampler ?? this.patches[0]?.sampler;
    return sampler ? sampler.lodForDistance(distM) : 0;
  }

  /** Последний источник, давший высоту (см. sample) */
  private lastHit: Patch | TerrariumSampler | null = null;

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
    // места — двойной трафик без выигрыша
    const fineAtOrigin = this.covering(origin, false).length > 0;
    for (const p of this.patches) {
      if (p.coarse && fineAtOrigin) continue;
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

  /** Высота наблюдателя: точнейший источник, с фолбэком на остальные */
  async observerHeight(pos: LatLon): Promise<number> {
    const fine = this.covering(pos, false)[0];
    if (fine) return fine.sampler.observerHeight(pos);
    try {
      return await this.terrarium.heightAt(pos);
    } catch (err) {
      const coarse = this.covering(pos, true)[0];
      if (!coarse) throw err;
      return coarse.sampler.observerHeight(pos); // офлайн: глобальная пирамида
    }
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
    const fine = this.covering(pos, false)[0];
    if (fine) return fine.sampler.observerHeightSafe(pos);
    try {
      return await this.terrarium.heightAt(pos);
    } catch (err) {
      const coarse = this.covering(pos, true)[0];
      if (!coarse) throw err;
      return coarse.sampler.observerHeightSafe(pos); // офлайн: только пирамида
    }
  }
}
