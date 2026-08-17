/**
 * Точка входа. MVP-цикл: загрузка региона → позиция → горизонт из worker →
 * рендер панорамы; поворот пальцем (fallback без сенсоров, ROADMAP 2.2).
 */

import { fovForFrame } from "./core/camera-fov";
import { normalizeAz, toRad, wrapAngle, type LatLon } from "./core/geo";
import { getLocale, t } from "./core/i18n";
import type { Peak, PeaksFile } from "./core/peaks";
import {
  awaitAccuratePosition,
  getFreshPosition,
  getPosition,
  rememberPosition,
  worthRefining,
} from "./core/position";
import type { SearchHit } from "./core/search";
import {
  downloadRegion,
  inBBox,
  suggestRegionForPosition,
  type DownloadProgress,
  type RegionInfo,
} from "./ui/download";
import {
  ICON_AR,
  ICON_CALIBRATE,
  ICON_CLOSE,
  ICON_COMPASS,
  ICON_DOWN,
  ICON_DOWNLOAD,
  ICON_DOWNLOADED,
  ICON_LOCATE,
  ICON_MAP,
  ICON_PHOTO,
  ICON_SETTINGS,
  ICON_UP,
  iconArrow,
} from "./ui/icons";
import { isTypingTarget } from "./ui/keys";
import {
  renderPanorama,
  silhouetteProfile,
  type PanoramaState,
  type ViewState,
} from "./ui/panorama";
import type {
  ResultMessage,
  ViewpointResult,
  WorkerOutMessage,
} from "./workers/horizon.worker";

/**
 * Активный регион переживает перезапуск: выбранный вручную в настройках
 * сбрасывался на Приэльбрусье при каждом открытии приложения, и в горах без
 * связи (где авто-выбор по GPS может не сработать) это лишало вершин.
 */
const REGION_KEY = "vershiny-region";

function storedRegion(): { region: string; manual: boolean } {
  try {
    const raw = localStorage.getItem(REGION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { region?: unknown; manual?: unknown };
      if (typeof parsed.region === "string" && parsed.region) {
        return { region: parsed.region, manual: parsed.manual === true };
      }
    }
  } catch {
    // Приватный режим или мусор в хранилище — начинаем с умолчания
  }
  return { region: "elbrus", manual: false };
}

function rememberRegion(): void {
  try {
    localStorage.setItem(
      REGION_KEY,
      JSON.stringify({ region: currentRegion, manual: manualRegion }),
    );
  } catch {
    // Без хранилища выбор живёт до перезагрузки — это лучше, чем ничего
  }
}

const restored = storedRegion();
let currentRegion = restored.region;
/** true = пользователь выбрал регион вручную, автоподбор по GPS его не трогает */
let manualRegion = restored.manual;
let currentPeaks: PeaksFile["peaks"] = []; // пики текущего региона (для навигации)

const statusEl = document.getElementById("status")!;
const appEl = document.getElementById("app")!;

// Регистрация Service Worker (PWA, офлайн-режим и обновления)
if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .then(async (registration) => {
      const { setupUpdates } = await import("./ui/update");
      setupUpdates(registration);
    })
    .catch(() => {
      // Офлайн-режим не критичен: приложение работает и без него
    });
}

// Счётчик посещений. Как и Service Worker — не в разработке: считать надо
// людей в горах, а не собственные перезагрузки страницы. Сам счётчик грузится
// в простое и только при живой сети (см. core/analytics.ts)
if (!import.meta.env.DEV) {
  void import("./core/analytics").then(({ setupAnalytics }) =>
    setupAnalytics(),
  );
}

function setStatus(text: string): void {
  statusEl.textContent = text;
  statusEl.style.display = text ? "block" : "none";
}

const canvas = document.createElement("canvas");
appEl.appendChild(canvas);
const ctx = canvas.getContext("2d")!;

/** Готовая панорама: null, пока worker не прислал первый результат */
let panorama: PanoramaState | null = null;

/** Нижние кнопки: их положение зависит от формы экрана (см. layoutControls) */
let navPad: HTMLElement | null = null;
let heightPadEl: HTMLElement | null = null;
let mapButton: HTMLElement | null = null;

/**
 * Сенсорный экран без мыши — то есть телефон в руках.
 *
 * Это не просто «другая раскладка кнопок»: у телефона и у компьютера разные
 * сценарии. На склоне человеку нужен вид отсюда, с текущей точки GPS, и
 * ходить по карте пальцем ему незачем — он идёт ногами. Дома за монитором,
 * наоборот, вся ценность в том, чтобы облазить будущий маршрут заранее.
 * Поэтому перемещение наблюдателя (навипад, двойной тап) живёт только на
 * компьютере, а на телефоне остаются возврат к своему положению и карта.
 */
const touchOnly =
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

function resize(): void {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  syncFov();
  layoutControls();
  // Смена размера очищает холст: без перерисовки панорама пропадала до
  // следующего пересчёта (поворот телефона — пустой экран)
  draw();
}
// ResizeObserver появился только в Safari 13.4 (iOS 13.4): на более старых
// айфонах `new ResizeObserver` бросал ReferenceError при загрузке модуля,
// и страница навсегда оставалась на «Загрузка…». Холст у нас во весь экран,
// поэтому window resize — полноценный запасной вариант.
if (typeof ResizeObserver === "function") {
  new ResizeObserver(resize).observe(canvas);
} else {
  window.addEventListener("resize", resize);
}
// Поворот телефона: ResizeObserver срабатывает не всегда до перерисовки,
// а на iOS размеры на момент события ещё старые — отсюда отдельный слушатель.
// На старом Android Chrome (до ~59) screen.orientation уже есть, но ещё не
// EventTarget: addEventListener там отсутствует, и вызов бросал TypeError при
// загрузке модуля — то же вечное «Загрузка…». Поэтому проверяем сам метод.
const screenOrientation = screen.orientation;
if (screenOrientation && typeof screenOrientation.addEventListener === "function") {
  screenOrientation.addEventListener("change", () => setTimeout(resize, 50));
} else {
  window.addEventListener("orientationchange", () => setTimeout(resize, 50));
}

const view: ViewState = {
  centerAzRad: 0,
  tiltRad: 0,
  fovRad: toRad(60),
  fovVRad: toRad(45),
};

/**
 * Углы обзора под текущую форму экрана.
 *
 * Формула — в core/camera-fov.ts (общая с AR): длинная сторона всегда
 * получает базовый угол, короткая — производный через тангенс, чтобы пиксель
 * «стоил» одинаково по обеим осям. Иначе поворот телефона менял бы масштаб:
 * при постоянных 60° по горизонтали портретный экран растягивал вертикаль
 * до сотни градусов, и те же горы становились вдвое мельче, чем в ландшафте.
 *
 * Если поле зрения задано в калибровке, берётся оно: у каждого телефона свой
 * объектив, и при расхождении углов контуры совпадают в центре кадра, но
 * разъезжаются к краям — азимутом это не лечится.
 */
function syncFov(): void {
  const { width, height } = canvas;
  if (!width || !height) return;
  const baseDeg = getCalibration().cameraFovDeg ?? DEFAULT_CAMERA_FOV_DEG;
  const fov = fovForFrame(toRad(baseDeg), width, height);
  view.fovRad = fov.h;
  view.fovVRad = fov.v;
}
syncFov();
resize();

/** Предел наклона камеры, рад */
const MAX_TILT = toRad(45);

/**
 * Отступы от краёв с учётом «безопасной зоны» — вырез камеры и полоса жестов
 * на телефоне съедают углы, а именно в углах у нас всё и лежит.
 *
 * Стоят в начале файла: кнопки создаются в том числе при инициализации модуля
 * (например, «Включить компас» на iOS), а обращение к ещё не вычисленной
 * константе ниже по файлу уронило бы запуск целиком.
 */
const EDGE = 16;
const edgeTop = (offset = 0): string =>
  `calc(${EDGE + offset}px + env(safe-area-inset-top))`;
const edgeBottom = (offset = 0): string =>
  `calc(${EDGE + offset}px + env(safe-area-inset-bottom))`;
const edgeLeft = (offset = 0): string =>
  `calc(${EDGE + offset}px + env(safe-area-inset-left))`;
const edgeRight = (offset = 0): string =>
  `calc(${EDGE + offset}px + env(safe-area-inset-right))`;

function draw(): void {
  if (!panorama) return;
  renderPanorama(ctx, panorama, view);
}

// --- Управление: поворот + перемещение ---
// Мышь/тач: поворот (drag), перемещение (shift+drag или двойной тап)
// Клавиатура: WASD/стрелки

let dragging = false;
let lastX = 0;
let lastY = 0;
let lastTap = 0; // для двойного тапа (перемещение вперёд)

/** Активные пальцы: по паре отслеживаем pinch — подгонку поля зрения в AR */
const activePointers = new Map<number, { x: number; y: number }>();
/** Расстояние между пальцами и поле зрения на момент начала pinch */
let pinchStartDist = 0;
let pinchStartFovDeg = DEFAULT_CAMERA_FOV_DEG;

canvas.addEventListener("pointerdown", (ev) => {
  activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  // Второй палец в AR: pinch — подгонка поля зрения под кадр камеры, прямо
  // на месте (альтернатива ползунку в настройках: результат виден сразу).
  // Поворот на время pinch отключаем: разъезд пальцев иначе крутил картинку
  if (activePointers.size === 2 && arSession) {
    const [a, b] = [...activePointers.values()];
    pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
    pinchStartFovDeg = getCalibration().cameraFovDeg ?? DEFAULT_CAMERA_FOV_DEG;
    dragging = false;
    return;
  }
  // Второй палец вне AR игнорируем: два пальца на одном «повороте» — это
  // дёрганье картинки туда-сюда между точками касания
  if (activePointers.size > 1) return;

  dragging = true;
  lastX = ev.clientX;
  lastY = ev.clientY;
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch {
    // Playwright/синтетические события не имеют pointerId — пропускаем
  }

  // Двойной клик = перемещение вперёд, в сторону клика. Только с мышью:
  // на телефоне это не нужно (вид строится из своего положения, а уйти в
  // другое место можно картой) и мешает — случайный второй тап по склону
  // уводил наблюдателя на полкилометра
  if (!touchOnly) {
    const now = Date.now();
    if (now - lastTap < 300) {
      moveForward(ev.clientX);
      lastTap = 0;
    } else {
      lastTap = now;
    }
  }
});

canvas.addEventListener("pointermove", (ev) => {
  const pointer = activePointers.get(ev.pointerId);
  if (pointer) {
    pointer.x = ev.clientX;
    pointer.y = ev.clientY;
  }

  // Pinch в AR: раздвинули пальцы — приближаем (поле зрения меньше).
  // Отсчёт от начала жеста, а не от прошлого кадра: поправка не накапливает
  // шум и возврат пальцев возвращает исходный угол
  if (arSession && pinchStartDist > 0 && activePointers.size === 2) {
    const [a, b] = [...activePointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (dist > 0) {
      // Границы (40–100°) зажмет сам setCalibration
      setCalibration({
        cameraFovDeg: pinchStartFovDeg / (dist / pinchStartDist),
      });
      syncFov();
      draw();
    }
    return;
  }
  if (activePointers.size > 1) return;

  if (!dragging) return;
  const dx = ev.clientX - lastX;
  const dy = ev.clientY - lastY;
  lastX = ev.clientX;
  lastY = ev.clientY;

  // Shift+drag или правый клик = перемещение; обычный drag = поворот
  if (ev.shiftKey || ev.buttons === 2) {
    // Перемещение: dx/dy → шаг в сторону взгляда
    const dist = Math.hypot(dx, dy) * 2; // масштаб: 1px = 2м
    if (dist > 5) {
      // Экранные оси: x вправо, y вниз; азимут 0 — вперёд (вверх экрана).
      // Поэтому вперёд — это −dy, вбок — dx: atan2(dy, dx) поворачивал шаг
      // на четверть оборота, и «тяну вперёд» уводило влево
      const az = view.centerAzRad + Math.atan2(dx, -dy);
      const newPos = destination(lastOrigin, az, dist);
      requestCompute(newPos);
    }
    return;
  }

  // С датчиками свайп не крутит камеру (её всё равно вернёт следующее событие
  // компаса), а подстраивает контуры под кадр: по горизонтали азимут, по
  // вертикали наклон. Обе поправки запоминаются (core/calibration.ts).
  // Раньше это делал второй слушатель на том же холсте — он получал dx = dy = 0,
  // потому что lastX/lastY были уже обновлены здесь, и подстройка не работала
  if (orientationTracker.current.source === "sensor") {
    if (dy) {
      const deltaDeg =
        ((dy / canvas.clientHeight) * view.fovVRad * 180) / Math.PI;
      setCalibration({ tiltDeg: getCalibration().tiltDeg + deltaDeg });
    }
    // Пересобирает состояние и дёргает обработчик — он и перерисует кадр
    orientationTracker.addManualOffset(
      -(dx / canvas.clientWidth) * view.fovRad,
    );
    return;
  }

  // Поворот камеры (без датчиков: десктоп, отказ в доступе к компасу).
  // Нормализуем: иначе после нескольких свайпов азимут уходит в минус, и
  // расчёт сектора для автонаклона/маркеров берёт не тот участок горизонта
  view.centerAzRad = normalizeAz(
    view.centerAzRad - (dx / canvas.clientWidth) * view.fovRad,
  );
  view.tiltRad = Math.max(
    -MAX_TILT,
    Math.min(
      MAX_TILT,
      view.tiltRad + (dy / canvas.clientHeight) * view.fovVRad,
    ),
  );
  draw();
});

const endPointer = (ev: PointerEvent): void => {
  activePointers.delete(ev.pointerId);
  if (activePointers.size < 2) pinchStartDist = 0;
  if (activePointers.size === 0) {
    dragging = false;
  } else if (activePointers.size === 1 && !dragging) {
    // После pinch остался один палец: продолжаем поворот им, но от текущей
    // точки — иначе картинка прыгала бы на разницу между пальцами
    const [p] = activePointers.values();
    lastX = p.x;
    lastY = p.y;
    dragging = true;
  }
};
// pointercancel обязателен: системный жест (свайп с края) отменяет касание
// без pointerup, и «застывший» второй палец ломал бы дальнейшие повороты
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault()); // правый клик = перемещение

/**
 * Перемещение вперёд (двойной клик мышью, только на компьютере).
 *
 * Азимут берётся из точки клика, а не из центра кадра: изучая маршрут дома,
 * человек тычет в тот склон, куда собирается идти.
 *
 * @param screenX точка клика в CSS-пикселях; без неё — прямо по взгляду
 */
function moveForward(screenX?: number): void {
  if (!panorama) return;
  const width = canvas.clientWidth;
  const offset =
    screenX !== undefined && width > 0
      ? ((screenX - width / 2) / width) * view.fovRad
      : 0;
  const newPos = destination(
    lastOrigin,
    view.centerAzRad + offset,
    MOVE_STEP_M,
  );
  requestCompute(newPos);
}

// --- Навигация: WASD/стрелки + PageUp/PageDown ---
const MOVE_STEP_M = 500; // шаг перемещения по земле
const HEIGHT_STEP_M = 100; // шаг по высоте

window.addEventListener("keydown", (ev) => {
  if (!panorama) return;
  // Набор текста — не навигация: в поиске по карте «Washington» и «Ushba»
  // теряли буквы w/a/s/d, а стрелки вместо курсора двигали наблюдателя.
  // Ползунки настроек (input[type=range]) подстраиваются теми же стрелками
  if (isTypingTarget(ev.target) || isTypingTarget(document.activeElement))
    return;
  const az = view.centerAzRad;
  let dAz = 0;
  let dDist = 0;
  let dHeight = 0;

  switch (ev.key) {
    case "ArrowUp":
    case "w":
    case "W":
      dDist = MOVE_STEP_M; // вперёд по азимуту взгляда
      break;
    case "ArrowDown":
    case "s":
    case "S":
      dDist = -MOVE_STEP_M; // назад
      break;
    case "ArrowLeft":
    case "a":
    case "A":
      dAz = -Math.PI / 2; // влево (перпендикулярно взгляду)
      dDist = MOVE_STEP_M;
      break;
    case "ArrowRight":
    case "d":
    case "D":
      dAz = Math.PI / 2; // вправо
      dDist = MOVE_STEP_M;
      break;
    case "PageUp":
      dHeight = HEIGHT_STEP_M;
      break;
    case "PageDown":
      dHeight = -HEIGHT_STEP_M;
      break;
    default:
      return;
  }

  ev.preventDefault();
  if (dHeight !== 0) {
    // Те же 100 м, что и у экранных кнопок ⬆⬇ — раньше здесь была заглушка
    adjustHeight(dHeight);
    return;
  }

  // Перемещение по земле
  const newAz = az + dAz;
  const newPos = destination(lastOrigin, newAz, Math.abs(dDist));
  if (dDist < 0) {
    // Назад: дистанция отрицательная — идём в противоположную сторону
    newPos.lat = lastOrigin.lat;
    newPos.lon = lastOrigin.lon;
    const backAz = az + Math.PI;
    const backPos = destination(lastOrigin, backAz, MOVE_STEP_M);
    newPos.lat = backPos.lat;
    newPos.lon = backPos.lon;
  }
  requestCompute(newPos);
});

// --- Ориентация устройства (сенсоры + ручная подстройка) ---
import { rememberArMode, shouldAutoStartAr } from "./core/ar-mode";
import {
  DEFAULT_CAMERA_FOV_DEG,
  getCalibration,
  setCalibration,
} from "./core/calibration";
import { destination } from "./core/geo";
import { orientationTracker } from "./core/orientation";

/**
 * Кнопка «Включить компас» — только для iOS.
 *
 * Там доступ к датчикам даётся исключительно из обработчика жеста
 * пользователя: запрос при загрузке страницы Safari отклоняет молча, и
 * компас не включается уже никогда. Поэтому запрашиваем по нажатию, а сама
 * кнопка живёт ровно столько, сколько разрешения нет.
 *
 * Объявление стоит до `start()`: на iOS обработчик вызывается синхронно из
 * него же, и обращение к ещё не инициализированной переменной уронило бы
 * запуск целиком.
 */

/**
 * Кнопки, чьи подписи переводятся заново при смене языка.
 *
 * Стоит ДО `orientationTracker.start()` по той же причине, что и `compassBtn`:
 * на iOS `start()` синхронно зовёт callback, тот создаёт кнопку «Включить
 * компас», а `setTitle` делает `localizedTitles.push`. Константа ниже по
 * файлу попадала бы в temporal dead zone
 * (`ReferenceError: Cannot access uninitialized variable`) — и страница
 * навсегда оставалась бы на «Загрузка…» (только на iPhone).
 */
const localizedTitles: { el: HTMLElement; key: TitleKey }[] = [];
let compassBtn: HTMLButtonElement | null = null;
function updateCompassButton(): void {
  if (!orientationTracker.needsPermission) {
    compassBtn?.remove();
    compassBtn = null;
    return;
  }
  if (compassBtn) return;
  compassBtn = makeButton(
    ICON_COMPASS,
    "enableCompass",
    `right:${edgeRight()};top:${edgeTop(60)}`,
  );
  compassBtn.onclick = () => {
    void orientationTracker
      .requestPermission()
      .then(() => updateCompassButton());
  };
}

/**
 * Подсказка про раскалиброванный компас (iOS: точность −1 или событие
 * compassneedscalibration). Молча продолжать рисовать по таким показаниям
 * нельзя: азимут может врать на десятки градусов, а человек поверит
 * подписям. Но и центральной плашкой (#status) это не закрываем — она
 * перекрывает кадр и предназначена для расчётов/ошибок. Маленькая плашка у
 * верхнего края заметна, но не загораживает панораму; висит, пока точность
 * не вернётся в норму.
 */
let compassCalibrated = true;
let compassNote: HTMLElement | null = null;
function updateCompassCalibration(): void {
  const bad = orientationTracker.needsCalibration;
  if (bad === !compassCalibrated) return;
  compassCalibrated = !bad;
  if (bad) {
    if (!compassNote) {
      compassNote = document.createElement("div");
      compassNote.style.cssText =
        `position:fixed;left:50%;top:${edgeTop(56)};transform:translateX(-50%);` +
        "z-index:40;pointer-events:none;white-space:nowrap;" +
        "background:rgba(13,27,42,.85);border:1px solid #e0a458;border-radius:10px;" +
        "padding:6px 12px;color:#f1d7a8;font:13px system-ui,sans-serif";
      compassNote.textContent = t("compassUncalibrated");
      document.body.appendChild(compassNote);
    }
  } else {
    compassNote?.remove();
    compassNote = null;
  }
}

orientationTracker.start((state) => {
  if (state.source === "sensor") {
    const tiltOffset = (getCalibration().tiltDeg * Math.PI) / 180;
    view.centerAzRad = state.azimuthRad;
    view.tiltRad = Math.max(
      -MAX_TILT,
      Math.min(MAX_TILT, state.tiltRad + tiltOffset),
    );
    draw();
  }
  updateCompassButton();
  updateCompassCalibration();
});
updateCompassButton();

// --- Worker горизонта ---

/**
 * Заданная вручную высота (кнопки ⬆⬇), метры над уровнем моря.
 * null — идём по рельефу. Сохраняется при перемещении: набрав высоту,
 * пользователь «летит» над местностью, пока не нажмёт 📍 (возврат на землю).
 */
let heightOverride: number | null = null;

/** Кнопки ⚙/📷/📸 уже созданы (иначе плодятся на каждый пересчёт) */
let actionButtonsReady = false;

/**
 * Навести камеру по вертикали на рельеф при следующем результате.
 * Ставится при старте и при «телепорте» (поиск вершины), но не при шаге
 * навипадом — иначе сбрасывался бы наклон, выставленный пользователем.
 */
let autoTiltPending = true;

/**
 * Автонаклон: в долине рельеф стоит стеной выше кадра, и панорама выглядит
 * пустой (Аккемская долина под Белухой — гребни на 21–29°, а кадр по
 * умолчанию показывает ±17°). Наводим камеру на медиану силуэта в том
 * секторе, куда смотрим: медиана по всем 360° бесполезна — за спиной может
 * быть равнина, а перед лицом стена.
 *
 * Считается по уже посчитанному горизонту, поэтому годится и без нового
 * расчёта — например, когда направление взгляда сменили на карте.
 */
function applyAutoTilt(state: {
  stepRad: number;
  layers?: Float32Array[];
}): void {
  const layers = state.layers;
  const rays =
    state.stepRad > 0 ? Math.round((2 * Math.PI) / state.stepRad) : 0;
  if (!rays || !layers?.length) return;
  const half = view.fovRad / 2;
  const angles: number[] = [];

  for (let i = 0; i < rays; i++) {
    const az = i * state.stepRad;
    const delta = Math.abs(wrapAngle(az - view.centerAzRad));
    if (delta > half) continue;
    // Силуэт — максимум по слоям дистанций на этом азимуте
    let top = -Infinity;
    for (const layer of layers) {
      const value = layer[i];
      if (Number.isFinite(value) && value > top) top = value;
    }
    if (Number.isFinite(top)) angles.push(top);
  }

  if (angles.length < 10) return; // силуэта в секторе почти нет
  angles.sort((a, b) => a - b);
  const median = angles[Math.floor(angles.length / 2)];
  // Ниже линии горизонта не опускаемся: там и так всё видно
  view.tiltRad = Math.max(0, Math.min(MAX_TILT, median));
}

const worker = new Worker(
  new URL("./workers/horizon.worker.ts", import.meta.url),
  // Явный module: без него Vite в dev отдаёт воркер как classic, а импорты
  // внутри него в dev не бандлит — «Cannot use import statement outside
  // a module», и панорама висела на «Расчёт…» навсегда. Module workers —
  // Safari 15+; наш минимум iOS 13.4 уже выше по другим причинам (стрелочные
  // функции, ??), так что пола не снижаем. В проде формат всё равно iife
  // (worker.format в vite.config.ts) — там эта опция ни на что не влияет.
  { type: "module" },
);

/** Сквозной номер задания воркеру (см. протокол в horizon.worker.ts) */
let nextReqId = 1;
/** Номер последнего отправленного `compute`: ответы постарше — мусор */
let activeComputeId = 0;

worker.onmessage = (ev: MessageEvent<WorkerOutMessage>) => {
  const msg = ev.data;
  if (msg.type === "error") {
    // Ошибка чужого задания (перелёт к вершине) — не наша: её покажет тот,
    // кто это задание отправил. Иначе на экране два сообщения об одном сбое
    if (msg.reqId !== undefined && msg.reqId !== activeComputeId) return;
    // Без сети техническая формулировка («HTTP 503», «вне покрытия») ничего
    // не объясняет: человеку важно, что данных на это место нет на устройстве
    setStatus(
      navigator.onLine ? `${t("error")}: ${msg.message}` : t("errorOffline"),
    );
    return;
  }
  if (msg.type === "viewpoint") return; // ждёт свой одноразовый обработчик
  const r = msg as ResultMessage;
  // Расчёт старой точки, обогнавший свежий: применить его — значит показать
  // панораму не оттуда, где стоит наблюдатель
  if (r.reqId !== undefined && r.reqId !== activeComputeId) return;
  const next = {
    horizon: r.horizon,
    stepRad: r.stepRad,
    peaks: r.peaks,
    layers: r.layers,
    distanceToHorizonM: r.distanceToHorizonM,
    fronts: r.fronts,
    crests: r.crests,
  };
  // Мутируем существующий объект, а не подменяем ссылку: AR-оверлей захватил
  // его при запуске, и после каждого шага рисовал бы контуры прежней точки
  panorama = panorama ? Object.assign(panorama, next) : next;
  lastObserverH = r.observerH;
  // Обновляем индикатор высоты
  const heightEl = document.getElementById("height-indicator");
  if (heightEl) heightEl.textContent = `${Math.round(r.observerH)} м`;
  if (autoTiltPending) {
    autoTiltPending = false;
    applyAutoTilt(r);
  }
  setStatus("");
  draw();
  // Кнопки AR/фото — после первого результата
  setupActionButtons();
  console.info(
    `Горизонт: ${r.horizon.length} лучей, ${r.peaks.length} из ${currentPeaks.length} пиков, ` +
      `наблюдатель ${r.observerH.toFixed(0)} м, ${r.computeMs.toFixed(0)} мс`,
  );
};

let lastOrigin: LatLon = { lat: 43.318, lon: 42.458 };

async function main(): Promise<void> {
  setStatus(t("waitingGps"));

  const base = import.meta.env.BASE_URL;

  // Позиция: ссылка → GPS → запасная точка (Приют 11, контрольная по ROADMAP)
  const fix = await getPosition();
  const origin = fix.pos;
  lastOrigin = origin;
  // Физическое положение — для магнитного склонения компаса (WMM). Только
  // настоящий фикс: запасная точка выдумана, и склонение Приюта 11 человеку
  // в Антарктиде добавило бы к азимуту лишние −7°
  if (fix.trusted) orientationTracker.setLocation(origin.lat, origin.lon);

  setStatus(t("loadingRegion"));

  // Авто-выбор региона по GPS (если пользователь не выбрал вручную).
  // Только по настоящему положению: запасная точка выдумана, и менять по ней
  // район — значит подсунуть человеку чужие вершины за его же выбор.
  // Реестр читаем в любом случае: он же копится в офлайн-кеш, а без него
  // потом не открыть список регионов без сети.
  {
    const { loadRegions, regionForPosition } = await import("./ui/download");
    const regions = await loadRegions();
    if (!manualRegion && fix.trusted) {
      const autoRegion = regionForPosition(origin, regions);
      if (autoRegion && autoRegion !== currentRegion) {
        currentRegion = autoRegion;
        rememberRegion();
        console.info(`Авто-регион: ${autoRegion}`);
      }
    }
  }

  // Пики: сеть → офлайн-кеш (IndexedDB). Без них панорама всё равно строится.
  // Vite на 404 отдаёт index.html (SPA-fallback) — проверяем Content-Type.
  let peaks: PeaksFile["peaks"] = [];
  const peaksRes = await fetch(`${base}peaks/${currentRegion}.json`).catch(
    () => null,
  );
  if (peaksRes && isJson(peaksRes)) {
    peaks = ((await peaksRes.json()) as PeaksFile).peaks;
  } else {
    const { getPeaks } = await import("./core/db");
    peaks = ((await getPeaks(currentRegion)) ?? []) as PeaksFile["peaks"];
  }
  // Изоляция вершин (расстояние до ближайшей более высокой) — основа
  // приоритета подписей. Считается один раз на регион, не на кадр.
  const { annotateIsolation } = await import("./core/peaks");
  const isoT0 = performance.now();
  annotateIsolation(peaks);
  console.info(
    `Изоляция: ${peaks.length} вершин за ${(performance.now() - isoT0).toFixed(0)} мс`,
  );
  currentPeaks = peaks; // сохраняем для навигации

  // DEM: детальный патч региона → локальная пирамида → внешняя пирамида
  // (agran/vershiny-dem). Промах всех — только Terrarium; офлайн — кеш.
  await initDemForRegion(currentRegion);

  setStatus(t("computing"));
  // Через requestCompute, а не прямым postMessage: иначе стартовая точка —
  // единственная, для которой не проверялось соответствие региона, и плашка
  // «вы в другом районе» появлялась только после первого перемещения.
  // По ненадёжной точке район не предлагаем: сказать «Вы в районе X»
  // человеку, которому не дали геолокацию, — это выдумка, а не подсказка
  requestCompute(origin, fix.trusted);

  if (fix.trusted) {
    rememberPosition(origin);
  } else {
    // Показали, что было под рукой, — теперь дослушиваем спутники. Без сети
    // недоступен A-GPS, и холодный фикс занимает минуты: ждать его до первого
    // кадра значит держать человека на заставке всё это время
    void refineStartPosition();
  }

  // Кнопки действий; main() повторяется при смене региона — создаём один раз
  if (!navUiReady) {
    navUiReady = true;
    setupDownloadButton();
    setupMapButton();
    setupNavPad();
  } else {
    // Регион мог смениться по GPS — состояние кнопки перечитываем
    void refreshDownloadState();
  }
}

/**
 * Уточнение стартовой точки, когда спутники наконец ответили.
 *
 * Панорама к этому моменту уже нарисована — по готовому фиксу системы или по
 * точке прошлого запуска. Здесь только поправка: если человек оказался не
 * там, где показали, район и панорама пересчитываются, а плашка «вы в другом
 * районе» появляется уже по настоящему положению.
 */
async function refineStartPosition(): Promise<void> {
  const precise = await awaitAccuratePosition();
  if (!precise) return; // спутники не ответили — остаёмся на том, что показали
  rememberPosition(precise);
  // Склонению достаточно знать, где человек, — даже если панораму не двигаем
  orientationTracker.setLocation(precise.lat, precise.lon);
  if (!worthRefining(lastOrigin, precise)) return;

  console.info(
    `Уточнение по спутникам: ${precise.lat.toFixed(4)}, ${precise.lon.toFixed(4)}`,
  );
  // Район подбираем сами, только если человек не выбирал его в настройках
  if (!manualRegion) {
    const { loadRegions, regionForPosition } = await import("./ui/download");
    const region = regionForPosition(precise, await loadRegions());
    if (region && region !== currentRegion) await switchRegion(region);
  }
  heightOverride = null; // мы на земле в своей точке
  autoTiltPending = true;
  requestCompute(precise);
}

/**
 * Кнопка карты: где я, куда смотрю, куда перенестись и поиск вершины.
 * Поиск живёт здесь, а не отдельной кнопкой на панораме: и то и другое —
 * «переместиться в другое место», незачем занимать два угла экрана.
 */
function setupMapButton(): void {
  const btn = makeButton(
    ICON_MAP,
    "map",
    `left:${edgeLeft()};bottom:${edgeBottom()}`,
  );
  mapButton = btn;
  layoutControls();
  let closeMap: (() => void) | null = null;
  btn.onclick = async () => {
    if (closeMap) {
      closeMap();
      closeMap = null;
      return;
    }
    const [{ openMap }, { loadRegions, regionLabel }] = await Promise.all([
      import("./ui/map"),
      import("./ui/download"),
    ]);
    const regions = await loadRegions();
    const mapOptions: import("./ui/map").MapOptions = {
      origin: lastOrigin,
      headingRad: view.centerAzRad,
      // Базовый слой карты: вершины текущего региона уже в памяти, скачанные
      // догружаем фоном из IndexedDB. Без сети это единственное содержимое
      // карты — тайлы OpenTopoMap тогда не приходят вовсе
      peaks: currentPeaks,
      onPick: (pos) => {
        closeMap = null;
        void goToLocation(pos);
      },
      search: findPeaks,
      // Карта остаётся открытой: она покажет подобранную точку обзора и
      // саму вершину, а уходить к контурам — по «Перенестись сюда»
      onPickPeak: (hit) => goToHit(hit),
      // Направление, выставленное на карте, — это и есть направление взгляда.
      // Применяем сразу: карту закрывают по-разному, и собирать выбор в
      // каждом из выходов — верный способ его где-нибудь потерять
      onHeading: (rad) => {
        view.centerAzRad = rad;
        // Заодно наводим кадр по вертикали: в новом секторе рельеф стоит на
        // другой высоте, и без этого поворот на юг с Приюта 11 показывал
        // пустое небо — склон уходил вниз за нижний край кадра.
        // Компас на телефоне вернёт своё на следующем же событии: там куда
        // смотрит человек, туда и панорама. Карта задаёт взгляд там, где
        // датчиков нет или в них отказано
        if (panorama) applyAutoTilt(panorama);
        draw();
      },
      // Карта закрылась сама (крестик, Escape): без этого кнопка думала, что
      // карта ещё открыта, и следующее нажатие уходило на её «закрытие»
      onClose: () => {
        closeMap = null;
      },
      regionTitle: (region) => {
        const info = regions[region];
        return info ? regionLabel(info) : region;
      },
    };
    closeMap = openMap(mapOptions);

    // Вершины скачанных регионов — фоном: карта уже открыта и рисует то,
    // что есть. Запрет хранилища или обрыв не должны ронять открытие карты
    void (async () => {
      const { getDownloadedRegions, getPeaks } = await import("./core/db");
      const { annotateIsolation } = await import("./core/peaks");
      const others = (await getDownloadedRegions().catch(() => [])).filter(
        (r) => r !== currentRegion,
      );
      for (const region of others) {
        const listener = mapOptions.onPeaksAdded;
        if (!listener) return; // карта уже закрыта — докладывать некому
        const peaks = (await getPeaks(region).catch(() => undefined)) as
          | PeaksFile["peaks"]
          | undefined;
        if (peaks?.length) {
          annotateIsolation(peaks); // значимость вершин нужна отбору слоя
          listener(peaks);
        }
      }
    })();
  };
}

/** Кнопки навигации/карты/скачивания уже созданы */
let navUiReady = false;

/**
 * Переход к найденной вершине: при необходимости меняем регион и подтягиваем
 * его вершины (сеть → офлайн-кеш), затем сам перелёт.
 *
 * Возвращает точку обзора, чтобы карта могла показать её и дать поправить.
 */
async function goToHit(
  hit: SearchHit,
): Promise<{ origin: LatLon; headingRad: number } | null> {
  await switchRegion(hit.region);
  return jumpToPeak(hit.peak);
}

/**
 * Подключение источника высот для региона: детальный патч → локальная
 * пирамида → внешняя (agran/vershiny-dem). Промах всех — только Terrarium.
 *
 * Вызывается и при смене региона: раньше `init` уходил воркеру исключительно
 * из `main()`, и после переключения с карты, из поиска или по плашке рельеф
 * продолжал считаться по патчу прежнего региона.
 */
async function initDemForRegion(region: string): Promise<void> {
  const base = import.meta.env.BASE_URL;
  const { demCandidates, pickDemBase } = await import("./core/dem-config");
  const { getDemIndex } = await import("./core/db");
  const patchBaseUrl = await pickDemBase(demCandidates(base, region), {
    online: async (url) => {
      const probe = await fetch(`${url}/index.json`).catch(() => null);
      return !!probe && isJson(probe);
    },
    cached: async (url) => !!(await getDemIndex(url).catch(() => undefined)),
  });
  worker.postMessage({ type: "init", patchBaseUrl, reqId: nextReqId++ });
}

/**
 * Смена региона: вершины из сети, при промахе — из офлайн-кеша.
 * Если не вышло ни то, ни другое (офлайн и регион не скачан), остаёмся без
 * подписей: панорама строится по DEM, а вершины прежнего региона к этому
 * месту отношения не имеют.
 *
 * @param manual выбор человека из списка в настройках. Только он отключает
 *   автоподбор по GPS: переход по карте, перелёт к найденной вершине и
 *   согласие с плашкой «вы в другом районе» — это следствие положения, а не
 *   решение «всегда показывай мне этот регион». Раньше любой из них навсегда
 *   гасил автоподбор, и в следующий выход в горы приложение открывалось
 *   с регионом, выбранным когда-то на диване
 */
async function switchRegion(region: string, manual = false): Promise<void> {
  // Флаг ставим до раннего выхода: ткнуть в уже активный регион — это
  // законный способ закрепить его за собой, и раньше он работал (обработчик
  // настроек выставлял флаг сам, до вызова)
  if (manual) {
    manualRegion = true;
    rememberRegion();
  }
  if (region === currentRegion && currentPeaks.length) return;
  if (region !== currentRegion) {
    currentPeaks = [];
    if (panorama) {
      panorama = { ...panorama, peaks: [] };
      draw();
    }
  }
  currentRegion = region;
  rememberRegion();
  setStatus(t("loadingRegion"));
  void refreshDownloadState();

  const base = import.meta.env.BASE_URL;
  let peaks: PeaksFile["peaks"] | null = null;
  const res = await fetch(`${base}peaks/${region}.json`).catch(() => null);
  if (res && isJson(res)) {
    peaks = ((await res.json()) as PeaksFile).peaks;
  } else {
    const { getPeaks } = await import("./core/db");
    peaks = ((await getPeaks(region)) ?? null) as PeaksFile["peaks"] | null;
  }
  if (peaks) {
    const { annotateIsolation } = await import("./core/peaks");
    annotateIsolation(peaks);
    currentPeaks = peaks;
  } else {
    // Офлайн и регион не скачан: вершины прежнего региона оставлять нельзя —
    // они за сотни километров отсюда. Рельеф при этом есть из пирамиды
    currentPeaks = [];
  }

  // Детальный патч рельефа у каждого региона свой
  await initDemForRegion(region);
}

/**
 * Перенос в произвольную точку планеты (с карты): регион выбираем по bbox,
 * как при старте по GPS. Вне всех регионов вершин не будет, но рельеф есть
 * везде — глобальная пирамида покрывает всю сушу.
 */
async function goToLocation(pos: LatLon): Promise<void> {
  setStatus(t("computing"));
  const { loadRegions, regionForPosition } = await import("./ui/download");
  const region = regionForPosition(pos, await loadRegions());
  if (region) {
    await switchRegion(region);
  } else {
    // Реестр покрывает не всю сушу, и ближайший район может быть за сотни
    // километров. Оставлять вершины прежнего нельзя: они к этому месту
    // отношения не имеют
    currentPeaks = [];
  }
  heightOverride = null; // на землю: набранная высота к новой точке не относится
  autoTiltPending = true;
  requestCompute(pos);
}

/**
 * Переход к вершине: точка, откуда она видна, и взгляд на неё.
 *
 * @returns подобранная точка обзора (её показывает карта) или `null`, если
 *   подобрать не удалось
 */
async function jumpToPeak(
  peak: Peak,
): Promise<{ origin: LatLon; headingRad: number } | null> {
  setStatus(t("computing"));
  // Точку обзора подбирает worker: у него DEM, а «просто отойти на 5 км
  // назад по азимуту» приводит в цирк под соседней стеной
  let spot: ViewpointResult;
  try {
    spot = await requestViewpoint(peak);
  } catch (err) {
    // Раньше отказ воркера («нет данных», «вне покрытия») не отклонял промис:
    // перелёт молча замирал на «Расчёт панорамы…» до перезагрузки страницы
    setStatus(
      navigator.onLine
        ? `${t("error")}: ${err instanceof Error ? err.message : String(err)}`
        : t("errorOffline"),
    );
    return null;
  }
  heightOverride = null; // «телепорт» на землю: набранная высота не имеет смысла
  autoTiltPending = true; // наводимся на рельеф в новой точке
  view.centerAzRad = normalizeAz(spot.azimuthRad);
  requestCompute(spot.origin);
  draw();
  return { origin: spot.origin, headingRad: view.centerAzRad };
}

/**
 * Запрос точки обзора у worker'а.
 *
 * Слушатель одноразовый и сверяет `reqId`: два быстрых перелёта подряд иначе
 * оба резолвились первым же ответом, а ответ на ошибку не приходил никогда —
 * промис висел вечно вместе со своим слушателем.
 */
function requestViewpoint(peak: Peak): Promise<ViewpointResult> {
  const reqId = nextReqId++;
  return new Promise((resolve, reject) => {
    const onMessage = (ev: MessageEvent<WorkerOutMessage>): void => {
      const msg = ev.data;
      if (msg.reqId !== reqId) return;
      if (msg.type !== "viewpoint" && msg.type !== "error") return;
      worker.removeEventListener("message", onMessage);
      if (msg.type === "error") reject(new Error(msg.message));
      else resolve(msg);
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ type: "viewpoint", peak, reqId });
  });
}

/**
 * Поиск вершины: текущий регион → скачанные регионы → глобальный индекс.
 *
 * Скачанный регион ищется по полному списку (тысячи вершин), а не по индексу:
 * в индекс попадает по 400 значимых вершин на регион, и «Каменный замок»
 * или «Динозавр» там не появятся никогда — а на устройстве они уже лежат.
 * Индекс (peaks/_index.json) идёт последним и покрывает всю планету, поэтому
 * Казбек или Эверест находятся, даже если их регион никогда не открывали.
 */
async function findPeaks(query: string): Promise<SearchHit[]> {
  const { searchPeaks, searchIndex, searchFuzzy, mergeHits, loadSearchIndex } =
    await import("./core/search");
  const groups: SearchHit[][] = [
    searchPeaks(query, currentPeaks, currentRegion),
  ];

  // Скачанные регионы — работают офлайн; читаются параллельно.
  // Запрет хранилища (приватный режим) не должен ронять поиск: без списка
  // скачанного остаются свой регион и глобальный индекс, а падение здесь
  // оставляло список результатов на «…» навсегда
  const { getDownloadedRegions, getPeaks } = await import("./core/db");
  const downloaded = (await getDownloadedRegions().catch(() => [])).filter(
    (r) => r !== currentRegion,
  );
  const offline = await Promise.all(
    downloaded.map(async (region) => {
      const peaks = (await getPeaks(region).catch(() => undefined)) as
        | PeaksFile["peaks"]
        | undefined;
      return peaks ? searchPeaks(query, peaks, region) : [];
    }),
  );
  groups.push(...offline);

  // Глобальный индекс — последним: свои данные полнее и приоритетнее
  const index = await loadSearchIndex(import.meta.env.BASE_URL);
  if (index.length) groups.push(searchIndex(query, index));

  const hits = mergeHits(groups, lastOrigin);
  // Опечатки разбираем, только если по точному написанию ничего нет:
  // «Эльбрус» не должен тонуть среди «Эльбурс», «Эльбруз» и прочих соседей
  if (hits.length) return hits;

  const fuzzy: SearchHit[][] = [
    searchFuzzy(query, currentPeaks, currentRegion),
  ];
  for (let i = 0; i < downloaded.length; i++) {
    const peaks = (await getPeaks(downloaded[i]).catch(() => undefined)) as
      | PeaksFile["peaks"]
      | undefined;
    if (peaks) fuzzy.push(searchFuzzy(query, peaks, downloaded[i]));
  }
  if (index.length) fuzzy.push(searchFuzzy(query, index, null));
  return mergeHits(fuzzy, lastOrigin);
}

/**
 * Кнопка «Скачать для офлайна» в углу экрана.
 *
 * По ней видно состояние текущего региона: пока он не на устройстве — стрелка
 * на синем, после загрузки — галочка на зелёном. Иначе не понять, скачано ли
 * уже: панорама-то рисуется в обоих случаях, разница вылезает только в горах
 * без связи. Нажатие на скачанный регион перекачивает его — данные вершин
 * обновляются, а тайлы, что уже лежат, повторно не тянутся.
 */
function setupDownloadButton(): void {
  const btn = makeButton(
    ICON_DOWNLOAD,
    "downloadRegion",
    `right:${edgeRight()};top:${edgeTop()}`,
  );
  downloadButton = btn;
  void refreshDownloadState();

  let busy = false;
  btn.onclick = async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    try {
      await downloadRegion(currentRegion, lastOrigin, (p: DownloadProgress) => {
        if (p.phase === "peaks") {
          setStatus(t("downloadPeaks"));
        } else if (p.phase === "tiles") {
          setStatus(`${t("downloadTiles")}: ${p.done}/${p.total}`);
        } else if (p.phase === "done") {
          setStatus("");
        }
      });
      regionDownloaded = true;
      applyDownloadState();
    } catch (err) {
      setStatus(`${t("error")}: ${err instanceof Error ? err.message : err}`);
      btn.textContent = "✗";
      setTimeout(applyDownloadState, 3000);
    } finally {
      busy = false;
      btn.disabled = false;
    }
  };
}

/** Кнопка скачивания и состояние текущего региона на устройстве */
let downloadButton: HTMLButtonElement | null = null;
let regionDownloaded = false;

/** Перечитать из хранилища, лежит ли текущий регион офлайн */
async function refreshDownloadState(): Promise<void> {
  if (!downloadButton) return;
  try {
    const { getDownloadedRegions } = await import("./core/db");
    regionDownloaded = (await getDownloadedRegions()).includes(currentRegion);
  } catch {
    regionDownloaded = false; // приватный режим: считаем, что не скачано
  }
  applyDownloadState();
}

function applyDownloadState(): void {
  const btn = downloadButton;
  if (!btn) return;
  btn.innerHTML = regionDownloaded ? ICON_DOWNLOADED : ICON_DOWNLOAD;
  btn.style.background = regionDownloaded ? "#2d6a4f" : "#415a77";
  const title = regionDownloaded ? t("regionDownloaded") : t("downloadRegion");
  btn.title = title;
  btn.setAttribute("aria-label", title);
}

/**
 * Фабрика круглых кнопок действий.
 * icon — инлайновый SVG (см. ui/icons.ts) или текст; SVG рисуется одинаково
 * на всех платформах, в отличие от эмодзи.
 *
 * Подпись задаётся ключом словаря, а не готовой строкой: кнопки создаются
 * один раз за сессию, и при смене языка в настройках их всплывающие подписи
 * и `aria-label` оставались на прежнем — интерфейс получался наполовину
 * переведённым (см. relabelUi).
 */
function makeButton(
  icon: string,
  titleKey: TitleKey,
  pos: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  if (icon.startsWith("<svg")) btn.innerHTML = icon;
  else btn.textContent = icon;
  setTitle(btn, titleKey);
  btn.style.cssText =
    `position:fixed;${pos};width:48px;height:48px;` +
    "border-radius:50%;border:none;background:#415a77;color:#f1faee;" +
    "font-size:20px;cursor:pointer;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.4);" +
    "display:flex;align-items:center;justify-content:center";
  document.body.appendChild(btn);
  return btn;
}

/** Ключ словаря переводов (i18n.t) */
type TitleKey = Parameters<typeof t>[0];

function setTitle(el: HTMLElement, key: TitleKey): void {
  const title = t(key);
  el.title = title;
  el.setAttribute("aria-label", title);
  localizedTitles.push({ el, key });
}

/** Перевести подписи интерфейса после смены языка */
function relabelUi(): void {
  for (const { el, key } of localizedTitles) {
    const title = t(key);
    el.title = title;
    el.setAttribute("aria-label", title);
  }
  // У кнопки офлайна подпись зависит ещё и от состояния региона
  applyDownloadState();
}

/**
 * Экранный джойстик: перемещение по земле + возврат на GPS.
 *
 * Крест без диагоналей: диагональ — это два нажатия соседних стрелок, а
 * восемь кнопок в углу экрана занимали место и путали. Стрелки показывают
 * направление относительно взгляда и поворачиваются вместе с камерой.
 *
 * На телефоне стрелок нет вовсе. Дело не в тесноте экрана: стоя на склоне,
 * человек перемещается ногами, а панорама должна отвечать на вопрос «что я
 * вижу отсюда». Уйти в другое место можно картой — это осознанный шаг, а не
 * случайное нажатие. Остаётся одна кнопка — возврат к своему положению.
 */
function setupNavPad(): void {
  const pad = document.createElement("div");
  pad.style.cssText =
    "position:fixed;z-index:10;display:grid;gap:4px;" +
    (touchOnly
      ? "grid-template-columns:1fr;grid-template-rows:1fr"
      : "grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr)");
  document.body.appendChild(pad);
  navPad = pad;

  const arrows: {
    cell: string;
    az?: number;
    label: TitleKey;
    gps?: boolean;
  }[] = [
    { cell: "1 / 2", az: 0, label: "navForward" },
    { cell: "2 / 1", az: -Math.PI / 2, label: "navLeft" },
    { cell: "2 / 3", az: Math.PI / 2, label: "navRight" },
    { cell: "3 / 2", az: Math.PI, label: "navBack" },
  ];
  const dirs = touchOnly
    ? [{ cell: "1 / 1", label: "navGps" as TitleKey, gps: true }]
    : [...arrows, { cell: "2 / 2", label: "navGps" as TitleKey, gps: true }];

  for (const d of dirs) {
    const btn = document.createElement("button");
    btn.innerHTML = d.gps
      ? ICON_LOCATE
      : iconArrow(((d.az ?? 0) * 180) / Math.PI);
    setTitle(btn, d.label);
    const [row, col] = d.cell.split(" / ");
    btn.style.cssText =
      `grid-row:${row};grid-column:${col};` +
      `border:none;border-radius:${touchOnly ? "50%" : "10px"};background:#415a77;color:#f1faee;` +
      "cursor:pointer;min-width:0;min-height:0;display:flex;" +
      "align-items:center;justify-content:center";
    if (d.gps) {
      btn.onclick = () => {
        // «К моему положению» — явная просьба о СВЕЖЕМ фиксе. getPosition()
        // для старта отдавал бы точку прошлого запуска как недостоверную,
        // не спросив GPS, и кнопка кричала об ошибке при рабочей геолокации
        setStatus(t("waitingGps"));
        void getFreshPosition().then((pos) => {
          if (!pos) {
            setStatus(t("gpsFailed"));
            setTimeout(() => setStatus(""), 4000);
            return;
          }
          heightOverride = null; // возврат на землю в точке GPS
          autoTiltPending = true;
          rememberPosition(pos); // следующий запуск начнётся отсюда
          orientationTracker.setLocation(pos.lat, pos.lon);
          requestCompute(pos);
        });
      };
    } else {
      btn.onclick = () => {
        const az = view.centerAzRad + (d.az ?? 0);
        requestCompute(destination(lastOrigin, az, MOVE_STEP_M));
      };
    }
    pad.appendChild(btn);
  }

  // Высота: вверх/вниз + индикатор
  const heightPad = document.createElement("div");
  heightPad.style.cssText =
    "position:fixed;z-index:10;display:flex;flex-direction:column;gap:4px;align-items:center";
  document.body.appendChild(heightPad);
  heightPadEl = heightPad;
  layoutControls();

  const heightBtn = (
    icon: string,
    titleKey: TitleKey,
    delta: number,
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.innerHTML = icon;
    setTitle(b, titleKey);
    b.style.cssText =
      "border:none;border-radius:10px;background:#415a77;color:#f1faee;" +
      "width:44px;height:34px;cursor:pointer;display:flex;align-items:center;justify-content:center";
    b.onclick = () => adjustHeight(delta);
    heightPad.appendChild(b);
    return b;
  };

  heightBtn(ICON_UP, "heightUp", 100);

  const heightLabel = document.createElement("div");
  heightLabel.id = "height-indicator";
  heightLabel.style.cssText =
    "background:rgba(13,27,42,0.8);color:#f1faee;border-radius:6px;padding:2px 8px;font-size:12px;font-family:system-ui";
  heightLabel.textContent = `${Math.round(lastObserverH)} м`;
  heightPad.appendChild(heightLabel);

  heightBtn(ICON_DOWN, "heightDown", -100);
}

/**
 * Раскладка левого нижнего угла — там собрано всё про «где я и куда иду»:
 * карта, возврат к своему положению (на десктопе — крест перемещения) и высота.
 * Настройки живут в левом верхнем углу, офлайн-данные — в правом верхнем,
 * камера — в правом нижнем: каждый угол об одном.
 *
 * Кнопки идут рядом вдоль нижнего края, а не стопкой вверх: стопка из карты,
 * креста и высоты вытягивалась на 300 px — треть экрана телефона и больше, чем
 * его высота в ландшафте. В ряд то же самое занимает 256 px по горизонтали,
 * что влезает даже в самый узкий телефон.
 */
function layoutControls(): void {
  const padSize = touchOnly ? 48 : window.innerHeight < 420 ? 108 : 132;
  const mapWidth = 48 + 8;
  if (navPad) {
    navPad.style.width = `${padSize}px`;
    navPad.style.height = `${padSize}px`;
    navPad.style.left = edgeLeft(mapWidth);
    navPad.style.bottom = edgeBottom();
  }
  if (heightPadEl) {
    heightPadEl.style.left = edgeLeft(mapWidth + padSize + 8);
    heightPadEl.style.bottom = edgeBottom();
  }
  if (mapButton) {
    mapButton.style.left = edgeLeft();
    mapButton.style.bottom = edgeBottom();
  }
}

/** Текущая высота наблюдателя (из DEM) */
let lastObserverH = 0;

/** Сессия AR: нужна автокалибровке, чтобы взять кадр камеры */
let arSession: import("./ui/ar").ArSession | null = null;

/**
 * Автокалибровка по кадру: линия «небо / земля» из камеры совмещается с
 * горизонтом по рельефу (core/skyline.ts).
 *
 * Результат применяется только при достаточном доверии. Молчаливо увести
 * панораму на 20° в сторону хуже, чем ничего не сделать: человек поверит
 * подписям и уйдёт не на ту гору. Поэтому при неудаче — честное сообщение,
 * а ручные ползунки остаются на месте.
 *
 * @param silent автозапуск при входе в AR: о неудаче не сообщаем, пользователь
 *   её не заказывал и разбираться не просил
 */
async function runAutoCalibration(silent: boolean): Promise<void> {
  if (!arSession || !panorama) return;
  const frame = arSession.grabFrame();
  if (!frame) {
    if (!silent) setStatus(t("calibrateNoFrame"));
    return;
  }

  if (!silent) setStatus(t("calibrating"));
  const { extractSkyline, matchSkyline, MIN_CONFIDENCE } =
    await import("./core/skyline");
  const { SkylineTracker } = await import("./core/skyline-track");
  // Временна́я стабилизация (core/skyline-track.ts): ~0.8 с видео давят шум
  // сенсора и отбрасывают колонки, где линия ползёт (облака над гребнем,
  // блики) — они уходят в NaN и не тянут совмещение
  const tracker = new SkylineTracker(8);
  let stab = tracker.push(extractSkyline(frame.rgba, frame.width, frame.height));
  for (let k = 1; k < 8; k++) {
    await new Promise((resolve) => setTimeout(resolve, 110));
    const next = arSession.grabFrame();
    if (!next) break;
    stab = tracker.push(extractSkyline(next.rgba, next.width, next.height));
  }
  const profile = stab.profile;
  // Профиль измерен в долях ПОЛНОГО кадра камеры, поэтому и геометрия нужна
  // кадра, а не экрана: view.fovRad/HORIZON_FRAC описывают картинку после
  // cover-кропа (ui/ar.ts), и с ними совмещение ехало бы на величину обрезки
  const frameFov = arSession.fullFrameFov();
  const match = matchSkyline(profile, {
    centerAzRad: view.centerAzRad,
    tiltRad: view.tiltRad,
    fovRad: frameFov.h,
    fovVRad: frameFov.v,
    horizonFrac: arSession.frameHorizonFrac(),
    // Ровно та линия, что нарисована на экране: совмещать кадр с ближней
    // корзиной 0–5 км нельзя (за неё в горах отвечает трава под ногами), а
    // считать её здесь по-своему — значит рано или поздно разойтись с
    // отрисовкой и подгонять контуры не туда, куда человек смотрит
    horizon: silhouetteProfile(panorama),
    stepRad: panorama.stepRad,
    // Видимые вершины — якоря для грубого поиска по полному кругу: без них
    // периодичные гребни неотличимы, с ними ложный максимум ZNCC почти
    // никогда не угадает ещё и позицию Эльбруса
    peaks: panorama.peaks,
  });

  if (match.confidence < MIN_CONFIDENCE) {
    setStatus(silent ? "" : t("calibrateFailed"));
    if (!silent) setTimeout(() => setStatus(""), 4000);
    return;
  }

  const cal = getCalibration();
  setCalibration({
    azimuthDeg: cal.azimuthDeg + (match.azimuthRad * 180) / Math.PI,
    tiltDeg: cal.tiltDeg + (match.tiltRad * 180) / Math.PI,
  });
  orientationTracker.applyCalibration();
  view.centerAzRad += match.azimuthRad;
  view.tiltRad += match.tiltRad;
  draw();

  const azDeg = (match.azimuthRad * 180) / Math.PI;
  setStatus(
    `${t("calibrateDone")} ${azDeg > 0 ? "+" : ""}${azDeg.toFixed(1)}°`,
  );
  setTimeout(() => setStatus(""), 3000);
}

/**
 * Пересчёт панорамы: единственная точка отправки задания воркеру.
 *
 * @param checkRegion сверять ли район с положением. Ложь — только для
 *   запасной точки при отказе в геолокации: предлагать по ней смену региона
 *   значит выдавать выдумку за положение человека
 */
function requestCompute(origin: LatLon, checkRegion = true): void {
  lastOrigin = origin;
  activeComputeId = nextReqId++;
  worker.postMessage({
    type: "compute",
    origin,
    peaks: currentPeaks,
    observerHeightOverride: heightOverride ?? undefined,
    reqId: activeComputeId,
  });
  setStatus(t("computing"));
  // Единая точка пересчёта — единственное место, где видно любое перемещение:
  // GPS, шаг навипадом, перелёт, перенос с карты
  if (checkRegion) void checkRegionForPosition(origin);
}

/** Реестр регионов: читается один раз, дальше из памяти (см. loadRegions) */
async function allRegions(): Promise<Record<string, RegionInfo>> {
  const { loadRegions } = await import("./ui/download");
  return loadRegions();
}

/** Регион, от перехода на который пользователь отказался */
let dismissedRegion: string | null = null;
let suggestionEl: HTMLElement | null = null;

/**
 * Соответствует ли активный регион тому месту, где мы оказались.
 *
 * Регион задаёт список вершин: уйдя за его границы (пешком, по GPS или
 * перелётом), человек получил бы панораму с подписями за сотни километров
 * отсюда и без единой ближней горы. Регион при этом не меняется сам:
 * границы реестра перекрываются и условны, а молча подменить данные под
 * ногами хуже, чем спросить.
 *
 * Пока текущий регион содержит точку, молчим — даже если у соседнего
 * приоритет выше: работающий регион менять незачем.
 */
async function checkRegionForPosition(pos: LatLon): Promise<void> {
  const all = await allRegions();
  const suggestion = suggestRegionForPosition(pos, currentRegion, all);
  if (!suggestion) {
    // Активный регион точку содержит (или предлагать нечего): если человек
    // вернулся к себе, прошлый отказ забываем — уйдёт снова, спросим снова
    const current = all[currentRegion];
    if (current?.bbox && inBBox(pos, current.bbox)) {
      dismissedRegion = null;
      hideRegionSuggestion();
    }
    return;
  }
  if (suggestion === dismissedRegion) return;
  showRegionSuggestion(suggestion, all[suggestion]);
}

function hideRegionSuggestion(): void {
  suggestionEl?.remove();
  suggestionEl = null;
}

/** Плашка «вы в другом районе» с предложением переключиться */
function showRegionSuggestion(region: string, info: RegionInfo): void {
  if (suggestionEl?.dataset.region === region) return; // уже предложено
  hideRegionSuggestion();

  const box = document.createElement("div");
  box.dataset.region = region;
  // Ниже верхних кнопок и во всю ширину: между «настройками» и «скачать» на
  // телефоне остаётся 246 px — текст ломался в столбик, а кнопка вылезала
  // за плашку и наезжала на соседний угол
  box.style.cssText =
    `position:fixed;left:${edgeLeft()};right:${edgeRight()};top:${edgeTop(56)};z-index:50;` +
    "display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 10px;" +
    "background:rgba(26,26,46,.95);border:1px solid #415a77;border-radius:12px;" +
    "padding:10px 12px;font:13px/1.4 system-ui,sans-serif;color:#f1faee;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.45)";

  const text = document.createElement("span");
  text.textContent = `${t("regionSuggest")} ${regionLabelSync(info)}`;
  text.style.cssText = "flex:1 1 auto;min-width:0";
  box.appendChild(text);

  const accept = document.createElement("button");
  accept.textContent = t("regionSwitch");
  accept.style.cssText =
    "flex-shrink:0;border:none;border-radius:8px;padding:7px 12px;font-size:13px;" +
    "font-weight:600;background:#4cc9f0;color:#1a1a2e;cursor:pointer";
  accept.onclick = async () => {
    hideRegionSuggestion();
    await switchRegion(region);
    requestCompute(lastOrigin);
  };

  const dismiss = document.createElement("button");
  dismiss.innerHTML = ICON_CLOSE;
  dismiss.title = t("close");
  dismiss.style.cssText =
    "flex-shrink:0;border:none;border-radius:8px;width:32px;height:32px;" +
    "background:transparent;color:#cfd8dc;cursor:pointer;display:flex;" +
    "align-items:center;justify-content:center";
  dismiss.onclick = () => {
    dismissedRegion = region;
    hideRegionSuggestion();
  };

  box.append(accept, dismiss);
  document.body.appendChild(box);
  suggestionEl = box;
}

/** Название региона без обращения к download.ts (он уже загружен реестром) */
function regionLabelSync(info: RegionInfo): string {
  return getLocale() === "ru"
    ? (info.title_ru ?? info.title_en ?? "")
    : (info.title_en ?? info.title_ru ?? "");
}

/** Изменение высоты наблюдателя (пересчёт панорамы) */
function adjustHeight(deltaM: number): void {
  heightOverride = (heightOverride ?? lastObserverH) + deltaM;
  const el = document.getElementById("height-indicator");
  if (el) el.textContent = `${Math.round(heightOverride)} м`;
  requestCompute(lastOrigin);
}

/** Кнопки AR и фото (появляются после первого расчёта панорамы) */
function setupActionButtons(): void {
  // Вызывается на каждый результат воркера — но кнопки нужны одни
  if (actionButtonsReady) return;
  actionButtonsReady = true;
  // Настройки (⚙) — выбор региона, язык, сброс оффсета
  const settingsBtn = makeButton(
    ICON_SETTINGS,
    "settings",
    `left:${edgeLeft()};top:${edgeTop()}`,
  );
  let settingsClose: (() => void) | null = null;
  settingsBtn.onclick = async () => {
    if (settingsClose) {
      settingsClose();
      settingsClose = null;
      return;
    }
    const { openSettings } = await import("./ui/settings");
    settingsClose = openSettings(currentRegion, lastOrigin, {
      onRegionChange: (region) => {
        // Не через main(): тот начинается с getPosition() и возвращал бы
        // человека, прилетевшего в Альпы с карты, обратно к своей GPS-точке
        // (а при отказе геолокации — к Приюту 11, подождав до 8 секунд)
        void (async () => {
          // Единственный по-настоящему ручной выбор: человек открыл список и
          // ткнул в регион. Дальше автоподбор по GPS его не трогает
          await switchRegion(region, true);
          void refreshDownloadState();
          requestCompute(lastOrigin);
        })();
      },
      onLocaleChange: () => {
        // Кнопки создаются один раз за сессию: без явного перевода их
        // всплывающие подписи оставались на прежнем языке
        relabelUi();
        draw();
      },
      onCalibrationChange: () => {
        syncFov(); // поле зрения могли подстроить ползунком
        draw();
      },
      onClose: () => {
        settingsClose = null;
        // В настройках можно было скачать регион — сверяем состояние кнопки
        void refreshDownloadState();
      },
    });
  };

  // AR-режим — основной: камера включается сама, см. maybeAutoStartAr()
  const arBtn = makeButton(
    ICON_AR,
    "arMode",
    `right:${edgeRight()};bottom:${edgeBottom()}`,
  );
  let arVideo: HTMLVideoElement | null = null;
  /** Камера запрашивается прямо сейчас: второй вход открыл бы второй поток */
  let arStarting = false;

  function exitAr(): void {
    arSession?.stop();
    arSession = null;
    arVideo?.remove(); // иначе десять входов в AR — десять <video> под холстом
    arVideo = null;
    arBtn.style.background = "#415a77";
    calibrateBtn.style.display = "none";
    draw(); // под видео холст не перерисовывался — вернём панораму
  }

  /**
   * Вход в режим камеры.
   *
   * @param auto запуск при загрузке, а не по нажатию: об отказе в доступе
   *   человека извещать нечем — он его сам и дал, а красная плашка поверх
   *   панорамы выглядела бы поломкой
   * @returns `on` — камера включена, `off` — отказ, `busy` — вход уже идёт.
   *   Третий случай отделён не для красоты: результат попадает в память
   *   предпочтений, а «занято» — это не ответ человека. Нажатие кнопки во
   *   время автозапуска (диалог о доступе висит секунды) иначе запоминало бы
   *   «AR не нужен» ровно в тот момент, когда камера успешно включается
   */
  async function enterAr(auto = false): Promise<"on" | "off" | "busy"> {
    // Флаг снимается только вместе с выходом: между проверкой и присвоением
    // `arSession` стоит await, и нажатие кнопки поверх автозапуска открывало
    // вторую камеру — первый поток оставался гореть без ссылки на него
    if (!panorama || arSession || arStarting) return "busy";
    arStarting = true;
    const video = document.createElement("video");
    try {
      const { startAr } = await import("./ui/ar");
      video.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1";
      document.body.prepend(video);
      arVideo = video;
      arSession = await startAr(video, canvas, panorama, view);
      arBtn.style.background = "#e63946";
      calibrateBtn.style.display = "flex";
      // Автоматическая попытка при входе в AR (включена по умолчанию):
      // камере нужно пару кадров на экспозицию, иначе анализируем черноту
      if (getCalibration().autoCalibrate) {
        setTimeout(() => void runAutoCalibration(true), 1200);
      }
      return "on";
    } catch (err) {
      // Отказ в доступе к камере: элемент вставлен до вызова startAr,
      // и без уборки он остался бы в DOM насовсем
      video.remove();
      arVideo = null;
      if (auto) console.info("Камера при запуске не открылась:", err);
      else
        setStatus(`${t("error")}: ${err instanceof Error ? err.message : err}`);
      return "off";
    } finally {
      arStarting = false;
    }
  }

  arBtn.onclick = async () => {
    if (arSession) {
      exitAr();
      rememberArMode(false);
      return;
    }
    // Запоминаем результат, а не намерение: отказ в доступе — это «нет».
    // «Занято» не запоминаем вовсе: камеру в этот момент открывает автозапуск
    const result = await enterAr();
    if (result !== "busy") rememberArMode(result === "on");
  };

  /**
   * Камера при запуске: главный режим приложения не должен требовать
   * нажатия. Ждём первого расчёта — оверлей без панорамы рисовать нечем.
   */
  async function maybeAutoStartAr(): Promise<void> {
    if (!shouldAutoStartAr()) return;
    const result = await enterAr(true);
    // Отказ запоминаем: иначе диалог о камере всплывал бы при каждой загрузке.
    // А вот «занято» означает, что человек успел нажать кнопку сам
    if (result === "off") rememberArMode(false);
  }

  // Автокалибровка: видна только в AR — сопоставлять нечего, пока нет кадра
  const calibrateBtn = makeButton(
    ICON_CALIBRATE,
    "autoCalibrate",
    `right:${edgeRight()};bottom:${edgeBottom(120)}`,
  );
  calibrateBtn.style.display = "none";
  calibrateBtn.onclick = () => void runAutoCalibration(false);

  // Фото с подписями
  const photoBtn = makeButton(
    ICON_PHOTO,
    "photo",
    `right:${edgeRight()};bottom:${edgeBottom(60)}`,
  );
  photoBtn.onclick = async () => {
    if (!panorama) return;
    const { capturePhoto, savePhoto, photoFilename } =
      await import("./ui/photo");
    const options = {
      // Именно актуальные, а не аргументы функции: кнопки создаются один раз,
      // и замыкание держало бы точку первого расчёта — после перелёта к
      // вершине подпись врала бы координатами и высотой старта
      origin: lastOrigin,
      observerH: lastObserverH,
      region: currentRegion,
      peakName: mainPeakInView(),
      source: canvas,
      // В AR кадр содержит настоящие горы — там действует галочка «Контуры
      // склонов». Без камеры силуэту не с чем конфликтовать: рисуем всегда
      fromCamera: arSession !== null,
    };
    const blob = await capturePhoto(panorama, view, options);
    savePhoto(blob, photoFilename(options));
    setStatus(t("photoSaved"));
    setTimeout(() => setStatus(""), 3000);
  };

  // Камера — последним шагом: к этому моменту вся раскладка на месте, и
  // человек видит панораму, даже если разрешение он даст не сразу
  void maybeAutoStartAr();
}

/**
 * Самая заметная вершина в кадре — та, что попала в имя файла.
 *
 * «Заметная» здесь — высшая из видимых, а не ближайшая к центру: снимок
 * называют по горе, ради которой его сделали, а она обычно и есть главная в
 * кадре. Скрытые за хребтом не считаются: на картинке их не видно.
 */
function mainPeakInView(): string | undefined {
  if (!panorama) return undefined;
  const half = view.fovRad / 2;
  let best: { name: string; ele: number } | undefined;
  for (const peak of panorama.peaks) {
    if (peak.visibility === "hidden") continue;
    if (Math.abs(wrapAngle(peak.azimuthRad - view.centerAzRad)) > half)
      continue;
    const ele = peak.ele ?? 0;
    if (!best || ele > best.ele) best = { name: peak.name, ele };
  }
  return best?.name;
}

/** Ответ — JSON, а не SPA-fallback index.html? */
function isJson(res: Response): boolean {
  return (
    res.ok &&
    (res.headers.get("content-type") ?? "").includes("application/json")
  );
}

main();
