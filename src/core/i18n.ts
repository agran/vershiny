/**
 * Локализация: ru (по умолчанию) и en.
 * Источник: localStorage > navigator.language. Переключение — setLocale().
 */

export type Locale = 'ru' | 'en';

const STORAGE_KEY = 'vershiny-locale';

let current: Locale = detectLocale();

function detectLocale(): Locale {
  // localStorage/navigator могут отсутствовать в тестовом окружении,
  // а в приватном режиме обращение к хранилищу способно и бросить
  try {
    const storage = typeof localStorage === 'undefined' ? null : localStorage;
    const saved = storage?.getItem(STORAGE_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    // Хранилище закрыто — определяем язык по браузеру
  }
  if (typeof navigator === 'undefined') return 'ru';
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, locale);
    }
  } catch {
    // Приватный режим или запрет хранилища: язык живёт до перезагрузки —
    // это лучше, чем уронить переключение исключением
  }
}

const STRINGS: Record<string, Record<Locale, string>> = {
  loading: { ru: 'Загрузка…', en: 'Loading…' },
  loadingRegion: { ru: 'Загрузка региона…', en: 'Loading region…' },
  waitingGps: {
    ru: 'Определяем положение по спутникам…',
    en: 'Getting your position from satellites…',
  },
  gpsFailed: {
    ru: 'Не удалось определить положение',
    en: 'Could not determine your position',
  },
  computing: { ru: 'Расчёт панорамы…', en: 'Computing panorama…' },
  noRegionData: {
    ru: 'Нет данных региона.\nЗапустите tools/dem-to-tiles и tools/peaks-to-json.',
    en: 'No region data.\nRun tools/dem-to-tiles and tools/peaks-to-json.',
  },
  error: { ru: 'Ошибка', en: 'Error' },
  errorOffline: {
    ru: 'Нет сети, а данных об этом месте на устройстве нет',
    en: 'Offline and no stored data for this place',
  },
  peaks: { ru: 'вершин', en: 'peaks' },
  observer: { ru: 'наблюдатель', en: 'observer' },
  downloadRegion: {
    ru: 'Скачать регион для офлайна',
    en: 'Download region for offline use',
  },
  regionDownloaded: {
    ru: 'Регион скачан — нажмите, чтобы обновить',
    en: 'Region downloaded — tap to refresh',
  },
  regionSuggest: { ru: 'Вы в районе:', en: 'You are in:' },
  regionSwitch: { ru: 'Переключить', en: 'Switch' },
  downloadPeaks: { ru: 'Загрузка вершин…', en: 'Downloading peaks…' },
  downloadTiles: { ru: 'Загрузка тайлов', en: 'Downloading tiles' },
  appTitle: { ru: 'Вершины — панорама гор', en: 'Vershiny — Mountain Panorama' },
  arMode: { ru: 'AR-режим', en: 'AR mode' },
  photo: { ru: 'Фото с подписями', en: 'Photo with labels' },
  photoSaved: { ru: 'Снимок сохранён', en: 'Photo saved' },
  photoCaption: { ru: 'Подпись на снимке', en: 'Photo caption' },
  photoCaptionHint: {
    ru:
      'По умолчанию снимок не подписывается: координатами и временем съёмки ' +
      'делятся вместе с картинкой, а это данные о вас, а не о горах.',
    en:
      'By default the photo carries no caption: coordinates and the time of ' +
      'the shot travel with the picture, and that says more about you than ' +
      'about the mountains.',
  },
  photoCaptionPlace: { ru: 'Место съёмки', en: 'Shooting location' },
  photoCaptionTime: { ru: 'Дата и время', en: 'Date and time' },
  settings: { ru: 'Настройки', en: 'Settings' },
  region: { ru: 'Регион', en: 'Region' },
  language: { ru: 'Язык / Language', en: 'Language / Язык' },
  compassAccuracy: { ru: 'Точность компаса', en: 'Compass accuracy' },
  compassUnknown: { ru: 'нет данных', en: 'no data' },
  enableCompass: { ru: 'Включить компас', en: 'Enable compass' },
  resetOffset: { ru: 'Сбросить подстройку', en: 'Reset offset' },
  calibration: { ru: 'Калибровка', en: 'Calibration' },
  calibrationHint: {
    ru:
      'Если контуры не совпадают с камерой: поле зрения растягивает картинку ' +
      '(контуры сходятся в центре, но разъезжаются к краям), азимут двигает ' +
      'её вбок, наклон — вверх и вниз. То же можно делать свайпом по кадру.',
    en:
      'If the outlines miss the camera view: field of view stretches the ' +
      'picture (outlines match in the centre but drift at the edges), azimuth ' +
      'shifts it sideways, tilt moves it up and down. Swiping over the frame ' +
      'does the same.',
  },
  calibrationFov: { ru: 'Поле зрения камеры', en: 'Camera field of view' },
  calibrationAzimuth: { ru: 'Поправка азимута', en: 'Azimuth offset' },
  calibrationTilt: { ru: 'Поправка наклона', en: 'Tilt offset' },
  autoCalibrate: { ru: 'Совместить с камерой', en: 'Match to camera' },
  autoCalibrateOnStart: {
    ru: 'Совмещать автоматически в AR',
    en: 'Match automatically in AR',
  },
  calibrating: { ru: 'Сопоставление с камерой…', en: 'Matching the camera view…' },
  calibrateDone: { ru: 'Совмещено, поправка', en: 'Matched, offset' },
  calibrateFailed: {
    ru: 'Не удалось совместить: наведите на горизонт с горами',
    en: 'No match: point the camera at a skyline with mountains',
  },
  calibrateNoFrame: { ru: 'Камера ещё не готова', en: 'Camera is not ready yet' },
  downloadedRegions: { ru: 'Скачанные регионы', en: 'Downloaded regions' },
  noDownloadedRegions: { ru: 'пока нет', en: 'none yet' },
  regions: { ru: 'Регионы', en: 'Regions' },
  regionsUnavailable: {
    ru: 'Список регионов недоступен: подключитесь к сети хотя бы раз',
    en: 'Region list unavailable: go online at least once',
  },
  download: { ru: 'Скачать', en: 'Download' },
  downloaded: { ru: 'Скачан', en: 'Downloaded' },
  close: { ru: 'Закрыть', en: 'Close' },
  searchPeak: { ru: 'Поиск вершины', en: 'Search peak' },
  searchPrompt: { ru: 'Название вершины', en: 'Peak name' },
  peakNotFound: { ru: 'Вершина не найдена', en: 'Peak not found' },
  searchCorrected: { ru: 'с исправлением опечатки', en: 'spelling corrected' },
  updateAvailable: { ru: 'Доступно обновление', en: 'Update available' },
  updateApply: { ru: 'Обновить', en: 'Update' },
  map: { ru: 'Карта', en: 'Map' },
  mapApply: { ru: 'Применить', en: 'Apply' },
  mapGoHere: { ru: 'Перенестись сюда', en: 'Go here' },
  mapMyPosition: { ru: 'Моё положение', en: 'My position' },
  mapHeading: { ru: 'Куда смотрим — потяните', en: 'Drag to aim the view' },
  about: { ru: 'О проекте', en: 'About' },
  aboutSource: {
    ru: 'Открытый исходный код, лицензия MIT',
    en: 'Open source, MIT licence',
  },
  aboutData: {
    ru: 'Рельеф — Copernicus DEM GLO-90 (© DLR/ESA) и AWS Terrain Tiles, вершины — © участники OpenStreetMap (ODbL)',
    en: 'Terrain — Copernicus DEM GLO-90 (© DLR/ESA) and AWS Terrain Tiles, peaks — © OpenStreetMap contributors (ODbL)',
  },
  aboutCounter: {
    ru:
      'Посещения считает Яндекс.Метрика. Без сети счётчик не работает, ' +
      'координаты из ссылки в статистику не попадают.',
    en:
      'Visits are counted by Yandex Metrica. The counter stays off without a ' +
      'connection, and coordinates from the link never reach the statistics.',
  },
  navForward: { ru: 'Вперёд', en: 'Forward' },
  navBack: { ru: 'Назад', en: 'Back' },
  navLeft: { ru: 'Влево', en: 'Left' },
  navRight: { ru: 'Вправо', en: 'Right' },
  navGps: { ru: 'К моему положению', en: 'To my position' },
  heightUp: { ru: 'Выше на 100 м', en: '100 m higher' },
  heightDown: { ru: 'Ниже на 100 м', en: '100 m lower' },
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
  // Латиницу транслитерировать незачем, всё остальное — обязательно: раньше
  // проверялась только кириллица, и чисто грузинское или арабское название
  // англоязычный пользователь видел в исходном письме
  const latin = detectScript(name) === 'latin' ? name : translitToLatin(name);
  if (current === 'ru') {
    if (peak.name_ru) return peak.name_ru;
    return isCyrillic(name) ? name : translitToRu(latin);
  }
  return peak.name_en ?? latin;
}

// Реэкспорт для обратной совместимости (старые импорты из i18n)
export { isCyrillic, translitToEn, translitToRu } from './transliterate';
import {
  detectScript,
  isCyrillic,
  translitToLatin,
  translitToRu,
} from './transliterate';

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
