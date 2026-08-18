/**
 * «Фото с подписями» (ROADMAP 4.4): снимок canvas + запечённый оверлей
 * (подписи, координаты, дата) → Web Share API или скачивание.
 */

import { applyCoverCrop, type FrameFov } from "../core/camera-fov";
import type { LatLon } from "../core/geo";
import { getLocale } from "../core/i18n";
import { getPhotoCaption } from "../core/photo-caption";
import { translitToLatin } from "../core/transliterate";
import {
    drawOverlay,
    INK_DARK,
    INK_LIGHT,
    renderPanorama,
    type PanoramaState,
    type ViewState,
} from "./panorama";

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
  /**
   * Снимаем из AR (в кадре камера): настройка «Контуры склонов» действует.
   * Без камеры конфликтовать не с чем — контуры рисуются всегда.
   */
  fromCamera?: boolean;
  /**
   * Видео камеры AR-режима: его текущий кадр — фон снимка.
   * Без него снимок «из камеры» содержал только контуры и подписи:
   * видео рисуется лишь на экранный холст (drawArFrame в ui/ar.ts),
   * и в offscreen-кадр попадало небо-градиент вместо настоящих гор.
   */
  cameraVideo?: HTMLVideoElement | null;
  /**
   * Углы обзора полного кадра камеры с учётом зума (ArSession.fullFrameFov).
   * Нужны, чтобы подогнать оверлей под видимую часть кадра после
   * cover-кропа — иначе контуры совпали бы с горами в центре и разошлись
   * к краям (та же геометрия, что в drawArFrame).
   */
  cameraFov?: () => FrameFov;
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

  const canvas = document.createElement("canvas");
  canvas.width = aspect >= 1 ? LONG_SIDE : Math.round(LONG_SIDE * aspect);
  canvas.height = aspect >= 1 ? Math.round(LONG_SIDE / aspect) : LONG_SIDE;
  const ctx = canvas.getContext("2d")!;

  // Во сколько раз снимок крупнее экрана: подписи и контуры занимают на нём ту
  // же долю кадра, что человек видел. Вывести это из DOM нельзя — холст в
  // страницу не вставлен, и его clientWidth равен нулю
  const uiScale = cssWidth > 0 ? canvas.width / cssWidth : canvas.width / 1920;

  // Контуры склонов на снимке из AR — по настройке (по умолчанию нет: кадр
  // содержит настоящие горы, и нарисованный силуэт конфликтует с ними,
  // расходясь на величину неточности DEM и калибровки). Без камеры конфликта
  // нет — контуры рисуются при любом положении переключателя
  const ridges = !options.fromCamera || getPhotoCaption().ridges;

  // Фон кадра. Из AR — живой кадр камеры с тем же cover-кропом, что на
  // экране (drawArFrame): раньше сюда видео вообще не передавалось, и
  // «фото с камеры» сохраняло градиент неба с контурами вместо снимка гор.
  // Оверлей пересчитывается под видимую часть кадра, чтобы подписи вершин
  // легли на те же горы, что человек видел на экране.
  const video = options.cameraVideo;
  if (video && video.readyState >= 2 && video.videoWidth > 0) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.max(canvas.width / vw, canvas.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);

    const full =
      options.cameraFov?.() ?? { h: view.fovRad, v: view.fovVRad };
    const visible = applyCoverCrop(full, vw, vh, canvas.width, canvas.height);
    const overlayView: ViewState = {
      ...view,
      fovRad: visible.h,
      fovVRad: visible.v,
    };
    // Полная непрозрачность: на ЭКРАНЕ в AR оверлей полупрозрачный (дефолт
    // opacity в startAr), чтобы сквозь линии было видно живую камеру, но на
    // запечённом фото полупрозрачный текст выглядит выцветшим и плохо
    // читается — снимок не интерактивен, просвечивать там нечему
    drawOverlay(ctx, state, overlayView, uiScale, { ridges });
  } else {
    renderPanorama(ctx, state, view, uiScale, { ridges });
  }

  // Подпись снимка — тем же приёмом, что подписи вершин: светлый текст с
  // тёмной обводкой, без плашек. Прямоугольная подложка выглядела наклейкой
  // поверх кадра и на светлом небе рвала его тёмным квадратом, а обводка
  // читается на любом фоне и ничего не закрывает (тот же принцип, что у
  // всего оверлея — см. drawOverlay).
  const pad = 14 * uiScale;
  const fontSize = 13 * uiScale;
  const lineH = fontSize * 1.35;
  const gap = 16 * uiScale;
  const parts = buildMetaParts(options);
  // Адрес без схемы и хвостового слэша: на снимке это подпись авторства, а не
  // ссылка для копирования, а ширина в портретном кадре на счету
  const site = "agran.github.io/vershiny";

  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = 3.5 * uiScale;

  /** Строка с обводкой: тёмный контур снизу, светлая заливка сверху */
  const inkText = (text: string, x: number, y: number): void => {
    ctx.strokeStyle = INK_DARK;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = INK_LIGHT;
    ctx.fillText(text, x, y);
  };

  // Место под координаты — всё, что осталось слева от адреса. В портретной
  // ориентации кадр вдвое уже, и строка целиком туда не влезала: она уходила
  // за правый край вместе с датой съёмки
  const siteWidth = ctx.measureText(site).width;
  const lines = wrapParts(ctx, parts, canvas.width - 2 * pad - siteWidth - gap);

  // Обе подписи на одной нижней строке. Раньше адрес был отдельным блоком
  // НАД координатами, поэтому и оказывался заметно дальше от нижнего края —
  // тем дальше, чем выше плашка координат
  const baseline = canvas.height - pad;
  ctx.textAlign = "left";
  lines.forEach((line, i) => {
    inkText(line, pad, baseline - (lines.length - 1 - i) * lineH);
  });
  ctx.textAlign = "right";
  inkText(site, canvas.width - pad, baseline);
  ctx.textAlign = "left";

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("toBlob failed"));
    }, "image/png");
  });
}

/**
 * Разбиение подписи на строки по разделителям между частями.
 *
 * Рвём только по «·», а не по словам: «14 авг. 2026 г. 10:53» разорванное
 * посередине читается как две разные величины.
 */
function wrapParts(
  ctx: CanvasRenderingContext2D,
  parts: string[],
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let current = "";
  for (const part of parts) {
    const candidate = current ? `${current} · ${part}` : part;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Части подписи снимка. Пустой список — подпись не рисуется вовсе.
 *
 * Состав задаётся в настройках и по умолчанию пуст: координаты и время
 * съёмки — данные о человеке, а не о горах (см. core/photo-caption.ts).
 */
function buildMetaParts(options: PhotoOptions): string[] {
  const caption = getPhotoCaption();
  const { origin, observerH, region } = options;
  const parts: string[] = [];

  if (caption.place) {
    const lat = origin.lat.toFixed(5);
    const lon = origin.lon.toFixed(5);
    if (region) parts.push(region);
    parts.push(
      `${Math.abs(Number(lat))}°${Number(lat) >= 0 ? "N" : "S"}`,
      `${Math.abs(Number(lon))}°${Number(lon) >= 0 ? "E" : "W"}`,
      `${Math.round(observerH)} ${getLocale() === "ru" ? "м" : "m"}`,
    );
  }

  if (caption.time) {
    const now = new Date();
    const locale = getLocale() === "ru" ? "ru-RU" : "en-US";
    const date = now.toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const time = now.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
    parts.push(`${date} ${time}`);
  }

  return parts;
}

/**
 * Сохранение снимка файлом.
 *
 * Web Share API отсюда убран сознательно: он открывает системное меню
 * «Поделиться», из которого до файла ещё нужно добраться, — а от кнопки
 * «Фото с подписями» ждут ровно одного, готовой картинки на диске.
 */
export function savePhoto(blob: Blob, filename = "vershiny.png"): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Ссылка должна быть в документе: иначе часть браузеров игнорирует click()
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // И отзывать ссылку, и удалять anchor сразу нельзя: Android Chrome начинает
  // скачивание асинхронно, и к моменту старта элемент уже вне DOM — файл
  // терялся молча, при этом «Снимок сохранён» показывался (Samsung S25).
  // Невидимый anchor никому не мешает — убираем его вместе с revokeObjectURL
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
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
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`;

  const peak = options.peakName ? slug(translitToLatin(options.peakName)) : "";
  const place = peak || (options.region ? slug(options.region) : "");
  return ["vershiny", place, stamp].filter(Boolean).join("-") + ".png";
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
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
