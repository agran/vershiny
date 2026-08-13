/**
 * DemSource — единая точка доступа к высотам (docs/new-geo-data.md):
 *   запрос → локальный патч (IndexedDB/int16) → Terrarium (онлайн) → NaN.
 * Ray-marching знает только синхронный sample() после prefetch.
 */

import type { LatLon } from './geo';
import { DemSampler } from './dem';
import { TerrariumSampler, zoomForDistance } from './terrarium';

export interface DemSourceOptions {
  /** URL локального патча (tiles/{region} или tiles/global); undefined — нет */
  patchBaseUrl?: string;
  terrariumBaseUrl?: string;
  fetchFn?: typeof fetch;
}

/** Ближняя зона: тут разница в разрешении источников видна на панораме */
const NEAR_M = 30_000;
/** Патч детальнее этого порога считаем «своим» и приоритетным (90-м патчи) */
const FINE_RES_M = 120;

export class DemSource {
  readonly patch: DemSampler | null = null;
  readonly terrarium: TerrariumSampler;
  /** Патч загружен и точка в его bbox — проверяется один раз на compute */
  private patchIndex = null as null | { bbox: [number, number, number, number] };
  /**
   * Патч грубее онлайн-данных (глобальная пирамида ~217 м против Terrarium
   * ~90 м): в ближней зоне сначала спрашиваем сеть, патч — офлайн-запас.
   */
  private patchIsCoarse = false;

  constructor(options: DemSourceOptions) {
    if (options.patchBaseUrl) {
      this.patch = new DemSampler({
        baseUrl: options.patchBaseUrl,
        fetchFn: options.fetchFn,
      });
    }
    this.terrarium = new TerrariumSampler({
      baseUrl: options.terrariumBaseUrl,
      fetchFn: options.fetchFn,
    });
  }

  async init(): Promise<void> {
    if (this.patch) {
      const index = await this.patch.loadIndex();
      this.patchIndex = { bbox: index.bbox };
      this.patchIsCoarse = this.patch.finestResM() > FINE_RES_M;
    }
  }

  /** Точка внутри bbox локального патча? */
  inPatch(pos: LatLon): boolean {
    if (!this.patchIndex) return false;
    const [minLon, minLat, maxLon, maxLat] = this.patchIndex.bbox;
    return (
      pos.lon >= minLon && pos.lon <= maxLon && pos.lat >= minLat && pos.lat <= maxLat
    );
  }

  /**
   * Синхронная выборка: берём точнейший из доступных источников.
   * Детальный патч (90 м) приоритетнее всегда; грубая глобальная пирамида —
   * только вдали или там, где Terrarium не загружен (офлайн).
   * NaN — нет данных нигде.
   */
  sample(pos: LatLon, distM: number): number {
    const patchAvailable = this.patch !== null && this.inPatch(pos);
    const patchFirst = patchAvailable && (!this.patchIsCoarse || distM >= NEAR_M);

    if (patchFirst) {
      const h = this.patch!.sample(pos, this.patch!.lodForDistance(distM));
      if (!Number.isNaN(h)) return h;
      return this.terrarium.sample(pos, zoomForDistance(distM));
    }

    const online = this.terrarium.sample(pos, zoomForDistance(distM));
    if (!Number.isNaN(online)) return online;
    return patchAvailable
      ? this.patch!.sample(pos, this.patch!.lodForDistance(distM))
      : NaN;
  }

  /** Предзагрузка вдоль луча обоими слоями */
  async prefetchAlongRay(
    origin: LatLon,
    azRad: number,
    maxDistM: number,
    stepM: number,
    destinationFn: (o: LatLon, az: number, d: number) => LatLon,
  ): Promise<void> {
    const tasks: Promise<void>[] = [
      this.terrarium.prefetchAlongRay(origin, azRad, maxDistM, stepM, destinationFn),
    ];
    if (this.patch) {
      tasks.push(
        this.patch.prefetchAlongRay(origin, azRad, maxDistM, stepM, destinationFn),
      );
    }
    await Promise.all(tasks);
  }

  /** Высота наблюдателя: точнейший источник, с фолбэком на второй */
  async observerHeight(pos: LatLon): Promise<number> {
    const patchAvailable = this.patch !== null && this.inPatch(pos);
    if (patchAvailable && !this.patchIsCoarse) {
      return this.patch!.observerHeight(pos);
    }
    try {
      return await this.terrarium.heightAt(pos);
    } catch (err) {
      if (!patchAvailable) throw err;
      return this.patch!.observerHeight(pos); // офлайн: глобальная пирамида
    }
  }

  /** Высота с защитой от занижения (max 3×3 + 2 м) — для ray-marching */
  async observerHeightSafe(pos: LatLon): Promise<number> {
    const patchAvailable = this.patch !== null && this.inPatch(pos);
    if (patchAvailable && !this.patchIsCoarse) {
      return this.patch!.observerHeightSafe(pos);
    }
    try {
      // Terrarium: упрощённо — обычная высота (там нет такой проблемы)
      return await this.terrarium.heightAt(pos);
    } catch (err) {
      if (!patchAvailable) throw err;
      return this.patch!.observerHeightSafe(pos);
    }
  }
}
