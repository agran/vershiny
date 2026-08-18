/**
 * Что рисовать на сохраняемом снимке (ROADMAP 4.4).
 *
 * Подписи места и времени по умолчанию выключены: снимком делятся, а
 * координаты с точностью до метра и время съёмки — это данные о человеке, а
 * не о горах. Снимок из дома, отправленный в чат, не должен рассказывать,
 * где этот дом. Кому подпись нужна (маршрутный отчёт, привязка кадра к
 * месту), включает её в настройках. Две независимые галочки, а не одна:
 * место и время утекают по-разному — в отчёте о восхождении дата уместна,
 * а точка стоянки не всегда.
 *
 * Контуры склонов по умолчанию НЕ рисуются: в AR человек фотографирует
 * реальные горы, и нарисованный силуэт конфликтует с настоящим — расходится
 * на величину неточности DEM и калибровки. На фото остаются только подписи
 * вершин. Кому нужен снимок чистой панорамы (дома, без камеры), включает
 * контуры обратно.
 */

const STORAGE_KEY = "vershiny-photo";

export interface PhotoCaption {
  /** Район, координаты и высота наблюдателя */
  place: boolean;
  /** Дата и время съёмки */
  time: boolean;
  /** Контуры склонов (силуэт) на снимке */
  ridges: boolean;
}

export const DEFAULT_PHOTO_CAPTION: PhotoCaption = {
  place: false,
  time: false,
  ridges: false,
};

/** Приведение к булевым: в хранилище мог остаться мусор из другой версии */
export function normalizePhotoCaption(
  raw: Partial<PhotoCaption> | null,
): PhotoCaption {
  if (!raw) return { ...DEFAULT_PHOTO_CAPTION };
  return {
    place: raw.place === true,
    time: raw.time === true,
    ridges: raw.ridges === true,
  };
}

let current: PhotoCaption | null = null;

export function getPhotoCaption(): PhotoCaption {
  if (current) return current;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    current = normalizePhotoCaption(stored ? JSON.parse(stored) : null);
  } catch {
    current = { ...DEFAULT_PHOTO_CAPTION }; // приватный режим или битый JSON
  }
  return current;
}

/** Изменить состав подписи. Возвращает применённые значения */
export function setPhotoCaption(patch: Partial<PhotoCaption>): PhotoCaption {
  current = normalizePhotoCaption({ ...getPhotoCaption(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Без хранилища выбор живёт до перезагрузки — это лучше, чем ничего
  }
  return current;
}
