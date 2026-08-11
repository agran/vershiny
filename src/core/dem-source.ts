/**
 * DemSource — единая точка доступа к высотам (docs/new-geo-data.md):
 *   запрос → локальный патч (IndexedDB/int16) → Terrarium (онлайн) → NaN.
 * Ray-marching знает только синхронный sample() после prefetch.
 */

import type { LatLon } from './geo';
import { DemSampler } from './dem';
import { TerrariumSampler, zoomForDistance } from './terrarium';

export interface DemSourceOptions {
  /** URL локального патча (tiles/{region}); undefined — региона нет */
  patchBaseUrl?: string;
  terrariumBaseUrl?: string;
  fetchFn?: typeof fetch;
}

export class DemSource {
  readonly patch: DemSampler | null = null;
  readonly terrarium: TerrariumSampler;
  /** Патч загружен и точка в его bbox — проверяется один раз на compute */
  private patchIndex = null as null | { bbox: [number, number, number, number] };

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
   * Синхронная выборка: патч приоритетнее (точнее, void-filled),
   * иначе Terrarium. NaN — нет данных нигде.
   */
  sample(pos: LatLon, distM: number): number {
    if (this.patch && this.inPatch(pos)) {
      const h = this.patch.sample(pos, this.patch.lodForDistance(distM));
      if (!Number.isNaN(h)) return h;
    }
    return this.terrarium.sample(pos, zoomForDistance(distM));
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

  /** Высота наблюдателя: патч → Terrarium */
  async observerHeight(pos: LatLon): Promise<number> {
    if (this.patch && this.inPatch(pos)) {
      return this.patch.observerHeight(pos);
    }
    return this.terrarium.heightAt(pos);
  }
}
