/**
 * Предзагрузка региона для офлайна (ROADMAP 4.2, MVP-ACCEPTANCE).
 * Одна кнопка: пики + Terrarium-тайлы веером лучей вокруг текущей позиции
 * (тайлы патч-формата появятся позже из tools/dem-to-tiles).
 */

import { TerrariumSampler, lonLatToTile, zoomForDistance } from '../core/terrarium';
import { destination, type LatLon } from '../core/geo';
import { savePeaks } from '../core/db';
import { getLocale } from '../core/i18n';

export interface DownloadProgress {
  /** Загружено тайлов */
  done: number;
  /** Всего тайлов */
  total: number;
  /** Текущая фаза */
  phase: 'peaks' | 'tiles' | 'done' | 'error';
  /** Текст ошибки */
  error?: string;
}

export interface RegionInfo {
  title_ru?: string;
  title_en?: string;
  bbox: [number, number, number, number];
}

/**
 * Загрузка региона для офлайна:
 * 1. peaks/{region}.json → IndexedDB
 * 2. Terrarium-тайлы веером 360° × 200 км вокруг origin → IndexedDB
 *
 * Возвращает итоговое число загруженных тайлов.
 */
export async function downloadRegion(
  region: string,
  origin: LatLon,
  onProgress: (p: DownloadProgress) => void,
): Promise<number> {
  const base = import.meta.env.BASE_URL;

  // 1. Пики
  onProgress({ done: 0, total: 0, phase: 'peaks' });
  const peaksRes = await fetch(`${base}peaks/${region}.json`);
  if (
    peaksRes.ok &&
    (peaksRes.headers.get('content-type') ?? '').includes('application/json')
  ) {
    const data = await peaksRes.json();
    await savePeaks(region, data.peaks ?? []);
  }

  // 2. Тайлы Terrarium веером лучей (та же логика, что у worker'а)
  const sampler = new TerrariumSampler();
  const MAX_DIST_M = 200_000;
  const tileKeys = new Set<string>();
  for (let az = 0; az < 2 * Math.PI; az += (5 * Math.PI) / 180) {
    for (let d = 0; d <= MAX_DIST_M; d += 8_000) {
      const p = destination(origin, az, d);
      const z = zoomForDistance(d);
      const { x, y } = lonLatToTile(p, z);
      tileKeys.add(`${z}/${x}/${y}`);
    }
  }

  const keys = [...tileKeys];
  let done = 0;
  onProgress({ done, total: keys.length, phase: 'tiles' });

  // Параллельность: по 6 запросов (вежливо к S3)
  const CONCURRENCY = 6;
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    const batch = keys.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((key) => {
        const [z, x, y] = key.split('/').map(Number);
        return sampler.loadTile(z, x, y);
      }),
    );
    done += batch.length;
    onProgress({ done, total: keys.length, phase: 'tiles' });
  }

  onProgress({ done: keys.length, total: keys.length, phase: 'done' });
  return keys.length;
}

/** Чтение реестра регионов (public/regions.json, копия tools/regions.json) */
export async function loadRegions(): Promise<Record<string, RegionInfo>> {
  const base = import.meta.env.BASE_URL;
  const res = await fetch(`${base}regions.json`);
  if (!res.ok) return {};
  return (await res.json()) as Record<string, RegionInfo>;
}

/** Имя региона для UI с учётом локали */
export function regionLabel(info: RegionInfo): string {
  return getLocale() === 'ru'
    ? (info.title_ru ?? info.title_en ?? '')
    : (info.title_en ?? info.title_ru ?? '');
}
