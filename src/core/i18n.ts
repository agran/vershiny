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
    return peak.name_ru ?? (isCyrillic(name) ? name : translitToRu(name)) ?? name;
  }
  return peak.name_en ?? (isCyrillic(name) ? translitToEn(name) : name);
}

// --- Транслитерация (fallback при отсутствии name_ru/name_en в OSM) ---

const RU_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const EN_TO_RU: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х',
  i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
  q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс',
  y: 'й', z: 'з',
};

const EN_DIGRAPHS: [string, string][] = [
  ['shch', 'щ'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['ch', 'ч'],
  ['sh', 'ш'], ['yu', 'ю'], ['ya', 'я'], ['yo', 'ё'], ['ye', 'е'],
];

function isCyrillic(s: string): boolean {
  return /[\u0400-\u04FF]/.test(s);
}

/** Транслитерация кириллицы → латиница (упрощённая, для подписей) */
export function translitToEn(s: string): string {
  return s
    .split('')
    .map((ch) => {
      const lower = ch.toLowerCase();
      const tr = RU_MAP[lower];
      if (tr === undefined) return ch;
      return ch === lower ? tr : tr.charAt(0).toUpperCase() + tr.slice(1);
    })
    .join('');
}

/** Транслитерация латиницы → кириллица (грубая, только как fallback) */
export function translitToRu(s: string): string {
  let result = s.toLowerCase();
  for (const [en, ru] of EN_DIGRAPHS) {
    result = result.replaceAll(en, ru);
  }
  return result
    .split('')
    .map((ch) => EN_TO_RU[ch] ?? ch)
    .join('')
    .replace(/(^|\s)(.)/g, (_, sp: string, c: string) => sp + c.toUpperCase());
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
