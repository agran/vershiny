/**
 * Предзагрузка региона для офлайна (ROADMAP 4.2, MVP-ACCEPTANCE).
 * Одна кнопка: пики + Terrarium-тайлы веером лучей вокруг текущей позиции
 * (тайлы патч-формата появятся позже из tools/dem-to-tiles).
 */

import { TerrariumSampler } from '../core/terrarium';
import type { LatLon } from '../core/geo';
import { savePeaks, markRegionDownloaded } from '../core/db';
import { getLocale } from '../core/i18n';

export interface RegionInfo {
  title_ru?: string;
  title_en?: string;
  bbox: [number, number, number, number];
  priority?: number;
  group?: string;
  core_ru?: string;
  core_en?: string;
}

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
 * 2. Terrarium-тайлы по всему bbox региона (не веер от точки) → IndexedDB
 *
 * Возвращает итоговое число загруженных тайлов.
 */
export async function downloadRegion(
  region: string,
  origin: LatLon,
  onProgress: (p: DownloadProgress) => void,
): Promise<number> {
  void origin; // больше не используем — скачиваем весь bbox
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

  // 2. Terrarium-тайлы по bbox региона (все зумы для покрытия)
  const regions = await loadRegions();
  const info = regions[region];
  if (!info?.bbox) {
    throw new Error(`Регион ${region} не найден в реестре`);
  }

  const [minLon, minLat, maxLon, maxLat] = info.bbox;
  const sampler = new TerrariumSampler();
  const tileKeys = new Set<string>();

  // Для каждого зума: сетка тайлов, покрывающая bbox
  // z12 для деталей, z9 для покрытия (компромисс размер/скорость)
  for (const zoom of [12, 11, 10, 9]) {
    const n = 2 ** zoom;
    const x0 = Math.floor(((minLon + 180) / 360) * n);
    const x1 = Math.ceil(((maxLon + 180) / 360) * n);
    const y0 = Math.floor(
      ((1 - Math.log(Math.tan((maxLat * Math.PI) / 180) + 1 / Math.cos((maxLat * Math.PI) / 180)) / Math.PI) / 2) * n,
    );
    const y1 = Math.ceil(
      ((1 - Math.log(Math.tan((minLat * Math.PI) / 180) + 1 / Math.cos((minLat * Math.PI) / 180)) / Math.PI) / 2) * n,
    );
    for (let x = x0; x < x1; x++) {
      for (let y = y0; y < y1; y++) {
        tileKeys.add(`${zoom}/${x}/${y}`);
      }
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
  // Отмечаем регион как скачанный (для списка в настройках)
  await markRegionDownloaded(region);
  return keys.length;
}

/** Чтение реестра регионов (public/regions.json, копия tools/regions.json) */
export async function loadRegions(): Promise<Record<string, RegionInfo>> {
  const base = import.meta.env.BASE_URL;
  const res = await fetch(`${base}regions.json`);
  if (!res.ok) return {};
  return (await res.json()) as Record<string, RegionInfo>;
}

/** Авто-выбор региона по позиции: первый, чей bbox содержит точку.
 *  При пересечении — приоритет меньше = конкретнее. */
export function findRegionForPosition(
  pos: LatLon,
  regions: Record<string, RegionInfo>,
): string | null {
  let best: string | null = null;
  let bestPriority = Infinity;
  for (const [key, info] of Object.entries(regions)) {
    if (key.startsWith('$') || typeof info !== 'object' || !info.bbox) continue;
    const [minLon, minLat, maxLon, maxLat] = info.bbox;
    if (pos.lon >= minLon && pos.lon <= maxLon && pos.lat >= minLat && pos.lat <= maxLat) {
      const priority = (info as RegionInfo & { priority?: number }).priority ?? 9;
      if (priority < bestPriority) {
        best = key;
        bestPriority = priority;
      }
    }
  }
  return best;
}

/** Имя региона для UI с учётом локали */
export function regionLabel(info: RegionInfo): string {
  return getLocale() === 'ru'
    ? (info.title_ru ?? info.title_en ?? '')
    : (info.title_en ?? info.title_ru ?? '');
}

/** Ключевые вершины региона для UI с учётом локали */
export function regionCore(info: RegionInfo): string {
  return getLocale() === 'ru'
    ? (info.core_ru ?? info.core_en ?? '')
    : (info.core_en ?? info.core_ru ?? '');
}
