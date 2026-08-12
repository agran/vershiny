/**
 * Локализация: ru (по умолчанию) и en.
 * Источник: localStorage > navigator.language. Переключение — setLocale().
 */

export type Locale = 'ru' | 'en';

const STORAGE_KEY = 'vershiny-locale';

let current: Locale = detectLocale();

function detectLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'ru' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
  localStorage.setItem(STORAGE_KEY, locale);
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

/** Название вершины с учётом локали: ru-имя → name → en-имя */
export function peakName(peak: {
  name?: string;
  name_ru?: string;
  name_en?: string;
}): string {
  if (current === 'ru') {
    return peak.name_ru ?? peak.name ?? peak.name_en ?? '—';
  }
  return peak.name_en ?? peak.name ?? peak.name_ru ?? '—';
}

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
