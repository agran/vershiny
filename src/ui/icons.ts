/**
 * Иконки интерфейса — инлайновые SVG.
 *
 * Эмодзи выглядят по-разному на каждой платформе и путают: «📷» и «📸»
 * на панораме означали AR-режим и снимок, а различить их было нельзя.
 * Свои контуры рисуются одинаково везде и попадают в стиль панорамы —
 * тонкие светлые линии.
 */

/**
 * Обёртка: квадратный SVG со штриховыми контурами по currentColor.
 *
 * `pointer-events:none` обязателен: без него целью клика становится <path>
 * внутри иконки, а не сама кнопка. Обработчики, которые смотрят на
 * `event.target`, из-за этого промахиваются — так «Закрыть» на карте
 * переставала работать, потому что карта принимала нажатие за перетаскивание.
 */
function svg(paths: string, size = 24): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" style="pointer-events:none" ' +
    `>${paths}</svg>`
  );
}

/** AR: рамка видоискателя, внутри — гребень с вершиной */
export const ICON_AR = svg(
  '<path d="M3 8V5.5A1.5 1.5 0 0 1 4.5 4H7"/>' +
    '<path d="M17 4h2.5A1.5 1.5 0 0 1 21 5.5V8"/>' +
    '<path d="M21 16v2.5a1.5 1.5 0 0 1-1.5 1.5H17"/>' +
    '<path d="M7 20H4.5A1.5 1.5 0 0 1 3 18.5V16"/>' +
    '<path d="M6.5 15.5 10 11l2.5 3 2-2.5 3 4"/>' +
    '<circle cx="10" cy="11" r="1.1" fill="currentColor" stroke="none"/>',
);

/** Снимок: фотоаппарат */
export const ICON_PHOTO = svg(
  '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>' +
    '<circle cx="12" cy="13" r="3.4"/>',
);

/** Скачать регион: стрелка в память устройства */
export const ICON_DOWNLOAD = svg(
  '<path d="M12 4v9"/><path d="m8 10 4 4 4-4"/>' +
    '<path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
);

/** Регион уже на устройстве: та же «полка», но с галочкой вместо стрелки */
export const ICON_DOWNLOADED = svg(
  '<path d="m8 9 3 3 5-5"/>' +
    '<path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
);

/** Карта со сложенными листами */
export const ICON_MAP = svg(
  '<path d="m9 5-5.2 2.1a1 1 0 0 0-.8 1V19a.5.5 0 0 0 .7.5L9 17"/>' +
    '<path d="M9 5v12"/><path d="m15 7 6-2.5a.5.5 0 0 1 .7.5v11.4a1 1 0 0 1-.8 1L15 19"/>' +
    '<path d="M15 7v12"/><path d="m9 17 6 2"/><path d="M9 5l6 2"/>',
);

/** Поиск */
export const ICON_SEARCH = svg('<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.5 4.5"/>');

/**
 * Настройки: ползунки.
 * Шестерёнка из тонких штрихов на тёмном фоне читалась как солнце —
 * ползунки узнаваемы даже в 24 px.
 */
export const ICON_SETTINGS = svg(
  '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"/>' +
    '<circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="17" r="2"/>',
);

/** Моё положение: перекрестие с точкой */
export const ICON_LOCATE = svg(
  '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3.4M12 18.6V22M22 12h-3.4M5.4 12H2"/>',
);

/** Стрелка направления: rotate поворачивает её по азимуту */
export function iconArrow(rotateDeg: number): string {
  return (
    `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
    `style="pointer-events:none;transform:rotate(${rotateDeg}deg)">` +
    '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>'
  );
}

/** Подъём и спуск наблюдателя */
export const ICON_UP = svg('<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>', 20);
export const ICON_DOWN = svg('<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>', 20);

/** Закрыть */
export const ICON_CLOSE = svg('<path d="M6 6l12 12M18 6 6 18"/>');

/** Автокалибровка: гребень в перекрестии — «совместить контур с кадром» */
export const ICON_CALIBRATE = svg(
  '<circle cx="12" cy="12" r="7.5"/>' +
    '<path d="M12 2v2.5M12 19.5V22M22 12h-2.5M4.5 12H2"/>' +
    '<path d="m8 14 2.5-3 2 2.4L15 10"/>',
);
