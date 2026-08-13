/**
 * «Фото с подписями» (ROADMAP 4.4): снимок canvas + запечённый оверлей
 * (подписи, координаты, дата) → Web Share API или скачивание.
 */

import { renderPanorama, type PanoramaState, type ViewState } from './panorama';
import type { LatLon } from '../core/geo';
import { toDeg } from '../core/geo';
import { getLocale } from '../core/i18n';
import { translitToLatin } from '../core/transliterate';

export interface PhotoOptions {
  /** Позиция наблюдателя (для подписи на фото) */
  origin: LatLon;
  /** Высота наблюдателя из DEM */
  observerH: number;
  /** Имя региона (для подписи) */
  region?: string;
  /** Главная вершина в кадре: попадает в имя файла */
  peakName?: string;
  /**
   * Экранный холст: снимок повторяет его пропорции и плотность подписей.
   * Без него кадр берётся 16:9 — это годится только для тестов.
   */
  source?: HTMLCanvasElement;
}

/** Длинная сторона снимка, px: 4K хватает и для печати, и для мессенджера */
const LONG_SIDE = 3840;

/**
 * Снимок текущего вида: рендер панорамы на offscreen canvas + метаданные.
 * Возвращает Blob PNG.
 *
 * Кадр повторяет форму экрана, а не фиксированные 16:9: углы обзора в `view`
 * посчитаны под текущую форму холста (`syncFov`), и на портретном телефоне
 * снимок 16:9 показывал не то, что видел человек, — по вертикали обрезал, по
 * горизонтали добавлял.
 */
export async function capturePhoto(
  state: PanoramaState,
  view: ViewState,
  options: PhotoOptions,
): Promise<Blob> {
  const cssWidth = options.source?.clientWidth ?? 0;
  const cssHeight = options.source?.clientHeight ?? 0;
  const aspect = cssWidth > 0 && cssHeight > 0 ? cssWidth / cssHeight : 16 / 9;

  const canvas = document.createElement('canvas');
  canvas.width = aspect >= 1 ? LONG_SIDE : Math.round(LONG_SIDE * aspect);
  canvas.height = aspect >= 1 ? Math.round(LONG_SIDE / aspect) : LONG_SIDE;
  const ctx = canvas.getContext('2d')!;

  // Во сколько раз снимок крупнее экрана: подписи и контуры занимают на нём ту
  // же долю кадра, что человек видел. Вывести это из DOM нельзя — холст в
  // страницу не вставлен, и его clientWidth равен нулю
  const uiScale = cssWidth > 0 ? canvas.width / cssWidth : canvas.width / 1920;

  renderPanorama(ctx, state, view, uiScale);

  // Запекаем метаданные внизу
  const pad = 12 * uiScale;
  const fontSize = 7 * uiScale;
  ctx.textAlign = 'left';
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(13,27,42,0.75)';
  const meta = buildMetaLine(options);
  const metaW = ctx.measureText(meta).width + pad * 2;
  const metaH = fontSize * 2.2;
  ctx.fillRect(pad, canvas.height - metaH - pad, metaW, metaH);
  ctx.fillStyle = '#f1faee';
  ctx.fillText(meta, pad * 2, canvas.height - pad - metaH / 2 + fontSize / 2 - uiScale);

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

/**
 * Сохранение снимка файлом.
 *
 * Web Share API отсюда убран сознательно: он открывает системное меню
 * «Поделиться», из которого до файла ещё нужно добраться, — а от кнопки
 * «Фото с подписями» ждут ровно одного, готовой картинки на диске.
 */
export function savePhoto(blob: Blob, filename = 'vershiny.png'): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Ссылка должна быть в документе: иначе часть браузеров игнорирует click()
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Отзывать ссылку сразу нельзя: часть браузеров не успевает начать
  // скачивание, и файл не сохраняется вовсе
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Имя файла снимка: что на снимке и когда снято.
 *
 * Смысл — чтобы снимок находился в папке «Загрузки» через полгода: одно
 * «vershiny.png» перезаписывалось бы браузером в «vershiny (7).png», и что
 * это за гора, не сказал бы никто. Дата в конце сортирует снимки по порядку.
 *
 * Вершина вытесняет регион, а не дописывается к нему: «Эльбрус Западный» в
 * Приэльбрусье дал бы «vershiny-elbrus-elbrus-zapadnyy» — регион здесь ничего
 * не добавляет. Он нужен, только когда подписывать нечем.
 */
export function photoFilename(options: PhotoOptions, at = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`;

  const peak = options.peakName ? slug(translitToLatin(options.peakName)) : '';
  const place = peak || (options.region ? slug(options.region) : '');
  return ['vershiny', place, stamp].filter(Boolean).join('-') + '.png';
}

/**
 * Кусок имени файла: латиница, цифры и дефисы.
 *
 * Кириллица и пробелы в именах переживают не все файловые системы и облака,
 * поэтому имя вершины проходит через транслитерацию (core/transliterate.ts),
 * а всё остальное здесь отсекается.
 */
function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Для совместимости с i18n */
void toDeg;
