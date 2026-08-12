/**
 * «Фото с подписями» (ROADMAP 4.4): снимок canvas + запечённый оверлей
 * (подписи, координаты, дата) → Web Share API или скачивание.
 */

import { renderPanorama, type PanoramaState, type ViewState } from './panorama';
import type { LatLon } from '../core/geo';
import { toDeg } from '../core/geo';
import { getLocale, t } from '../core/i18n';

export interface PhotoOptions {
  /** Позиция наблюдателя (для подписи на фото) */
  origin: LatLon;
  /** Высота наблюдателя из DEM */
  observerH: number;
  /** Имя региона (для подписи) */
  region?: string;
}

/**
 * Снимок текущего вида: рендер панорамы на offscreen canvas + метаданные.
 * Возвращает Blob PNG.
 */
export async function capturePhoto(
  state: PanoramaState,
  view: ViewState,
  options: PhotoOptions,
): Promise<Blob> {
  // Создаём canvas того же размера, что и экран (2x для чёткости)
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = 1920 * scale;
  canvas.height = 1080 * scale;
  const ctx = canvas.getContext('2d')!;

  // Рендерим панораму
  renderPanorama(ctx, state, view);

  // Запекаем метаданные внизу
  const pad = 24 * scale;
  const fontSize = 14 * scale;
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(13,27,42,0.75)';
  const meta = buildMetaLine(options);
  const metaW = ctx.measureText(meta).width + pad * 2;
  const metaH = fontSize * 2.2;
  ctx.fillRect(pad, canvas.height - metaH - pad, metaW, metaH);
  ctx.fillStyle = '#f1faee';
  ctx.fillText(meta, pad * 2, canvas.height - pad - metaH / 2 + fontSize / 2 - 2 * scale);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('toBlob failed'));
    }, 'image/png');
  });
}

function buildMetaLine(options: PhotoOptions): string {
  const { origin, observerH, region } = options;
  const lat = origin.lat.toFixed(5);
  const lon = origin.lon.toFixed(5);
  const h = Math.round(observerH);
  const date = new Date().toLocaleDateString(getLocale() === 'ru' ? 'ru-RU' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const time = new Date().toLocaleTimeString(getLocale() === 'ru' ? 'ru-RU' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = [
    `${Math.abs(Number(lat))}°${Number(lat) >= 0 ? 'N' : 'S'}`,
    `${Math.abs(Number(lon))}°${Number(lon) >= 0 ? 'E' : 'W'}`,
    `${h} ${getLocale() === 'ru' ? 'м' : 'm'}`,
    `${date} ${time}`,
  ];
  if (region) parts.unshift(region);
  return parts.join(' · ');
}

/** Шаринг через Web Share API (или скачивание, если не поддерживается) */
export async function sharePhoto(blob: Blob, filename = 'vershiny.png'): Promise<void> {
  const file = new File([blob], filename, { type: 'image/png' });

  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: t('appTitle'),
      text: t('shareText'),
    });
    return;
  }

  // Fallback: скачивание
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Для совместимости с i18n */
void toDeg;
