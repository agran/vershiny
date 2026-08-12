/**
 * Локализация: ru (по умолчанию) и en.
 * Источник: localStorage > navigator.language. Переключение — setLocale().
 */

export type Locale = 'ru' | 'en';

const STORAGE_KEY = 'vershiny-locale';

let current: Locale = detectLocale();

function detectLocale(): Locale {
  // localStorage/navigator могут отсутствовать в тестовом окружении
  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  const saved = storage?.getItem(STORAGE_KEY);
  if (saved === 'ru' || saved === 'en') return saved;
  if (typeof navigator === 'undefined') return 'ru';
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, locale);
  }
}

const STRINGS: Record<string, Record<Locale, string>> = {
  loading: { ru: 'Загрузка…', en: 'Loading…' },
  loadingRegion: { ru: 'Загрузка региона…', en: 'Loading region…' },
  computing: { ru: 'Расчёт панорамы…', en: 'Computing panorama…' },
  noRegionData: {
    ru: 'Нет данных региона.\nЗапустите tools/dem-to-tiles и tools/peaks-to-json.',
    en: 'No region data.\nRun tools/dem-to-tiles and tools/peaks-to-json.',
  },
  error: { ru: 'Ошибка', en: 'Error' },
  peaks: { ru: 'вершин', en: 'peaks' },
  observer: { ru: 'наблюдатель', en: 'observer' },
  downloadRegion: {
    ru: 'Скачать регион для офлайна',
    en: 'Download region for offline use',
  },
  downloadPeaks: { ru: 'Загрузка вершин…', en: 'Downloading peaks…' },
  downloadTiles: { ru: 'Загрузка тайлов', en: 'Downloading tiles' },
  appTitle: { ru: 'Вершины — панорама гор', en: 'Vershiny — Mountain Panorama' },
  shareText: {
    ru: 'Панорама гор из приложения «Вершины»',
    en: 'Mountain panorama from Vershiny app',
  },
  arMode: { ru: 'AR-режим', en: 'AR mode' },
  photo: { ru: 'Фото с подписями', en: 'Photo with labels' },
  settings: { ru: 'Настройки', en: 'Settings' },
  region: { ru: 'Регион', en: 'Region' },
  language: { ru: 'Язык', en: 'Language' },
  compassAccuracy: { ru: 'Точность компаса', en: 'Compass accuracy' },
  resetOffset: { ru: 'Сбросить подстройку', en: 'Reset offset' },
  // Стороны света
  N: { ru: 'С', en: 'N' },
  NE: { ru: 'СВ', en: 'NE' },
  E: { ru: 'В', en: 'E' },
  SE: { ru: 'ЮВ', en: 'SE' },
  S: { ru: 'Ю', en: 'S' },
  SW: { ru: 'ЮЗ', en: 'SW' },
  W: { ru: 'З', en: 'W' },
  NW: { ru: 'СЗ', en: 'NW' },
};

export function t(key: keyof typeof STRINGS): string {
  return STRINGS[key]?.[current] ?? key;
}

/** Название вершины с учётом локали: нужный язык → name → транслитерация */
export function peakName(peak: {
  name?: string;
  name_ru?: string;
  name_en?: string;
}): string {
  const name = peak.name ?? '—';
  if (current === 'ru') {
    return peak.name_ru ?? (isCyrillic(name) ? name : translitToRu(name));
  }
  return peak.name_en ?? (isCyrillic(name) ? translitToEn(name) : name);
}

// Реэкспорт для обратной совместимости (старые импорты из i18n)
export { isCyrillic, translitToEn, translitToRu } from './transliterate';
import { isCyrillic, translitToEn, translitToRu } from './transliterate';

/** Название региона с учётом локали */
export function regionTitle(region: {
  title?: string;
  title_ru?: string;
  title_en?: string;
}): string {
  if (current === 'ru') {
    return region.title_ru ?? region.title ?? region.title_en ?? '';
  }
  return region.title_en ?? region.title ?? region.title_ru ?? '';
}
