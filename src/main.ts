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
  isRegionIncomplete,
  loadRegions,
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

function setStatus(
  text: string,
  timeoutMs?: number,
  action?: { label: string; onClick: () => void },
): void {
  statusEl.textContent = text;
  statusEl.style.display = text ? "block" : "none";
  // Кнопка действия внутри тоста: «Перекачать» рядом с текстом, а не где-то
  // в настройках — иначе человек не найдёт, что именно предлагается обновить
  if (action) {
    const btn = document.createElement("button");
    btn.textContent = action.label;
    btn.style.cssText =
      "margin-left:12px;padding:4px 12px;border:none;border-radius:6px;" +
      "background:#e63946;color:#fff;font-size:13px;cursor:pointer;" +
      "pointer-events:auto"; // statusEl сам pointer-events:none
    btn.onclick = (ev) => {
      ev.stopPropagation();
      action.onClick();
    };
    statusEl.appendChild(btn);
  }
  if (timeoutMs) {
    setTimeout(() => setStatus(""), timeoutMs);
  }
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

/**
 * Флаг «плашки подписей уже в очереди на раскладку».
 * Стоит ДО resize(): тот вызывается при вычислении модуля (строка ниже),
 * и обращение к `let` ниже по файлу — TDZ ReferenceError на iPhone.
 */
let captionLayoutQueued = false;

function resize(): void {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  syncFov();
  layoutControls();
  // Плашки подписей привязаны к кнопкам: кнопки переехали — плашки тоже
  if (!captionLayoutQueued) {
    captionLayoutQueued = true;
    requestAnimationFrame(() => {
      captionLayoutQueued = false;
      layoutCaptions();
    });
  }
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
if (
  screenOrientation &&
  typeof screenOrientation.addEventListener === "function"
) {
  screenOrientation.addEventListener("change", () => {
    setTimeout(resize, 50);
    // Окно перевернулось само (автоповорот ОС): переоценить, нужен ли ещё
    // наш поворот. До первого показания датчика syncOrientation молчит
    screenOrientationModule.syncOrientation();
  });
} else {
  window.addEventListener("orientationchange", () => setTimeout(resize, 50));
}

const view: ViewState = {
  centerAzRad: 0,
  tiltRad: 0,
  fovRad: toRad(60),
  fovVRad: toRad(45),
  rollRad: 0,
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
  // При активной AR-сессии кадр рисует её rAF-цикл (видео + оверлей):
  // полный рендер панорамы здесь затирался бы следующим AR-кадром через
  // миллисекунды — 10–60 лишних рендеров в секунду впустую
  if (arSession) return;
  renderPanorama(ctx, panorama, view);
}

/** Кадр уже запланирован — события датчика/мыши сливаются в один рендер */
let drawScheduled = false;

/**
 * Отложенная перерисовка: события ориентации приходят до 60 Гц (и раз
 * в 100 мс даже в покое), pointermove — чаще rAF. Без коалесцинга каждый
 * из них рисовал полный кадр; с ним — один рендер на кадр, финальное
 * состояние за кадр тождественно
 */
function scheduleDraw(): void {
  if (drawScheduled) return;
  drawScheduled = true;
  requestAnimationFrame(() => {
    drawScheduled = false;
    draw();
  });
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
      moveForward(ev.clientX, ev.clientY);
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
      scheduleDraw();
    }
    return;
  }
  if (activePointers.size > 1) return;

  if (!dragging) return;
  // clientX/clientY — физические координаты экрана; при программном повороте
  // (ландшафт через CSS, screen-orientation.ts) локальные оси UI не совпадают
  // с ними: физическое «вправо» — это локальное «вниз». Конвертируем раз,
  // дальше вся математика жеста идёт в локальных осях
  const dl = screenOrientationModule.toLocalDelta(
    ev.clientX - lastX,
    ev.clientY - lastY,
  );
  const dx = dl.x;
  const dy = dl.y;
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
  scheduleDraw();
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
 * @param screenX/screenY точка клика, ФИЗИЧЕСКИЕ CSS-пиксели; без них —
 *   прямо по взгляду. При программном повороте экрана конвертируются в
 *   локальные координаты UI: clientX физический, а canvas.clientWidth —
 *   локальный, смешивать их нельзя
 */
function moveForward(screenX?: number, screenY?: number): void {
  if (!panorama) return;
  const width = canvas.clientWidth;
  const localX =
    screenX !== undefined && screenY !== undefined
      ? screenOrientationModule.toLocalPoint(screenX, screenY).x
      : undefined;
  const offset =
    localX !== undefined && width > 0
      ? ((localX - width / 2) / width) * view.fovRad
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
import { overlayRollRad } from "./core/roll-compensation";
import * as screenOrientationModule from "./core/screen-orientation";

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
/**
 * Подписи-плашки к кнопкам и их структуры. Стоят здесь же по причине из
 * комментария выше: первая кнопка (компас на iOS) создаётся из
 * `orientationTracker.start()` синхронно, и `addCaption` →
 * `ensureCaptionLayer` читает captionEntries/captionLayer ещё до того, как
 * вычислена нижняя половина модуля.
 */
let captionsVisible = true;
interface CaptionEntry {
  btn: HTMLElement;
  root: HTMLElement;
  label: HTMLElement;
  key: TitleKey;
  side: "left" | "right" | "above" | "below";
}
const captionEntries: CaptionEntry[] = [];
let captionLayer: HTMLElement | null = null;
let captionArrowLayer: SVGSVGElement | null = null;
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
    // Крен идёт в AR-оверлей (и в снимок из AR): там горизонт доворачивается
    // под наклонённый кадр камеры. Включён всегда — настройки у него больше
    // нет. В обычной панораме rollRad не используется — горизонт держим ровным.
    // В программном ландшафте (CSS-поворот body на softAngle) кадр камеры
    // уже довёрнут на −softAngle при отрисовке (core/frame-orientation.ts),
    // а крен датчика отсчитывается от портретного окна — при ровном
    // ландшафтном хвате он показывает ±90°, хотя картинка стоит ровно.
    // Поэтому видимый крен = крен датчика − softAngle (overlayRollRad).
    view.rollRad = overlayRollRad(
      state.rollRad,
      screenOrientationModule.softAngleDeg(),
    );
    scheduleDraw();
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
 * Автозапуск камеры: назначается в setupActionButtons (кнопки создаются
 * при старте), вызывается по первому результату воркера — оверлею нужна
 * панорама
 */
let arAutoStart: (() => void) | null = null;

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
    // Загрузка всё равно закончилась (пусть и ошибкой) — подписи убираем
    hideButtonCaptions();
    return;
  }
  if (msg.type === "viewpoint") return; // ждёт свой одноразовый обработчик
  const r = msg as ResultMessage;
  // Расчёт старой точки, обогнавший свежий: применить его — значит показать
  // панораму не оттуда, где стоит наблюдатель
  if (r.reqId !== undefined && r.reqId !== activeComputeId) return;
  // Фронты приехали плоскими (трансфер без клонирования объектов) —
  // собираем обратно; если поля нет (старый воркер), берём как есть
  let fronts = r.fronts;
  if (r.frontsFlat && r.frontsOffsets) {
    fronts = [];
    for (let i = 0; i + 1 < r.frontsOffsets.length; i++) {
      const rayFronts = [];
      for (let o = r.frontsOffsets[i]; o < r.frontsOffsets[i + 1]; o += 4) {
        rayFronts.push({
          distM: r.frontsFlat[o],
          distEndM: r.frontsFlat[o + 1],
          elevStartRad: r.frontsFlat[o + 2],
          elevMaxRad: r.frontsFlat[o + 3],
        });
      }
      fronts.push(rayFronts);
    }
  }
  const next = {
    horizon: r.horizon,
    stepRad: r.stepRad,
    peaks: r.peaks,
    layers: r.layers,
    distanceToHorizonM: r.distanceToHorizonM,
    fronts,
    crests: r.crests,
  };
  // Мутируем существующий объект, а не подменяем ссылку: AR-оверлей захватил
  // его при запуске, и после каждого шага рисовал бы контуры прежней точки
  panorama = panorama ? Object.assign(panorama, next) : next;
  lastObserverH = r.observerH;
  // Обновляем индикатор высоты
  const heightEl = document.getElementById("height-indicator");
  if (heightEl)
    heightEl.textContent = `${Math.round(r.observerH)} ${t("unitM")}`;
  if (autoTiltPending) {
    autoTiltPending = false;
    applyAutoTilt(r);
  }
  setStatus("");
  hideButtonCaptions(); // первая панорама есть — загрузка кончилась
  // SW теперь может докачать чанки приложения: до этого момента они не
  // качались, чтобы не конкурировать с веером тайлов за соединения
  if (!precacheSignaled) {
    precacheSignaled = true;
    navigator.serviceWorker?.controller?.postMessage({
      type: "PRECACHE_READY",
    });
  }
  draw();
  // Камера — по первому результату: оверлею нужна панорама
  arAutoStart?.();
  console.info(
    `Горизонт: ${r.horizon.length} лучей, ${r.peaks.length} из ${currentPeaks.length} пиков, ` +
      `наблюдатель ${r.observerH.toFixed(0)} м, ${r.computeMs.toFixed(0)} мс`,
  );
};

let lastOrigin: LatLon = { lat: 43.318, lon: 42.458 };

/** SW уже получил сигнал «первая панорама готова» (чанки можно докачивать) */
let precacheSignaled = false;

async function main(): Promise<void> {
  setStatus(t("waitingGps"));

  // Ориентация, запертая в прошлый раз, применится при первом же жесте
  // (lock без пользовательского жеста браузер не даёт) — кнопка уже
  // показывает запомненный режим, так что сюрприза не будет.

  // Кнопки — сразу, до GPS и загрузки региона: всё время загрузки они видны
  // и подписаны (addCaption), незачем человеку смотреть на пустой экран.
  // main() повторяется при смене региона — создаём один раз
  if (!navUiReady) {
    navUiReady = true;
    setupDownloadButton();
    setupMapButton();
    setupNavPad();
    setupActionButtons();
  } else {
    // Регион мог смениться по GPS — состояние кнопки перечитываем
    void refreshDownloadState();
  }

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

  // Пики: сеть → офлайн-кеш (IndexedDB). Панорама их не ждёт: compute
  // уходит сразу с пустым списком, вершины докидываются вторым compute,
  // когда загружены (и изоляция посчитана/восстановлена из кеша). На
  // больших регионах (iberia: 4.8 МБ, 49 тыс. вершин) JSON.parse + изоляция
  // блокировали первый кадр на ~0.6–1 с на телефоне
  const { fetchWithTimeout } = await import("./core/fetch-timeout");
  const peaksPromise = (async (): Promise<PeaksFile["peaks"]> => {
    const peaksRes = await fetchWithTimeout(
      `${base}peaks/${currentRegion}.json`,
    ).catch(() => null);
    if (peaksRes && isJson(peaksRes)) {
      return ((await peaksRes.json()) as PeaksFile).peaks;
    }
    const { getPeaks } = await import("./core/db");
    return ((await getPeaks(currentRegion)) ?? []) as PeaksFile["peaks"];
  })();
  // Изоляция вершин (расстояние до ближайшей более высокой) — основа
  // приоритета подписей. Считается один раз на регион, не на кадр.
  // Порядок: сначала кеш из IndexedDB (saveIsolation при прошлом заходе),
  // потом расчёт. На больших регионах (iberia, 49 тыс.) это разница между
  // ~5 мс чтением и ~300–400 мс вычисления, блокирующего главный поток
  const annotatePeaks = async (list: PeaksFile["peaks"]): Promise<void> => {
    if (!list.length) return;
    const { ensureIsolation, restoreIsolation } = await import(
      "./core/peaks"
    );
    const { getIsolation, saveIsolation } = await import("./core/db");
    const isoT0 = performance.now();
    const cachedIso = await getIsolation(currentRegion).catch(() => undefined);
    const fromCache = cachedIso ? restoreIsolation(list, cachedIso) : false;
    if (!fromCache) {
      ensureIsolation(list);
      // Запоминаем для следующего запуска: изоляция — функция набора вершин,
      // к точке наблюдателя не привязана
      const isoSnapshot = list.map((p) => p.isoM ?? 0);
      void saveIsolation(currentRegion, isoSnapshot).catch(() => {});
    }
    console.info(
      `Изоляция: ${list.length} вершин за ${(performance.now() - isoT0).toFixed(0)} мс` +
        (fromCache ? " (кеш)" : ""),
    );
  };

  // DEM: детальный патч региона → локальная пирамида → внешняя пирамида
  // (agran/vershiny-dem). Промах всех — только Terrarium; офлайн — кеш.
  // Идёт параллельно с загрузкой вершин: им обоим нужен только origin
  await initDemForRegion(currentRegion);

  setStatus(t("computing"));
  // Первая фаза: панорама без вершин — она появляется на ~0.5–1 с раньше
  // на больших регионах. Через requestCompute, а не прямым postMessage:
  // иначе стартовая точка — единственная, для которой не проверялось
  // соответствие региона, и плашка «вы в другом районе» появлялась только
  // после первого перемещения
  currentPeaks = [];
  requestCompute(origin, fix.trusted);
  const startOrigin = origin;
  const startRegion = currentRegion;

  // Вторая фаза: вершины докидываются, когда готовы, но только если за это
  // время не сменились ни регион, ни точка (чужой результат не применяем)
  void peaksPromise
    .then(async (loaded) => {
      if (currentRegion !== startRegion) return;
      await annotatePeaks(loaded);
      if (currentRegion !== startRegion) return;
      currentPeaks = loaded;
      if (
        lastOrigin.lat === startOrigin.lat &&
        lastOrigin.lon === startOrigin.lon &&
        loaded.length
      ) {
        // Та же точка — досчитываем только подписи, рельеф уже есть
        requestCompute(startOrigin, false);
      }
    })
    .catch(() => {});

  if (fix.trusted) {
    rememberPosition(origin);
  } else {
    // Показали, что было под рукой, — теперь дослушиваем спутники. Без сети
    // недоступен A-GPS, и холодный фикс занимает минуты: ждать его до первого
    // кадра значит держать человека на заставке всё это время
    void refineStartPosition();
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
    // Справа вплотную стоит навипад — подпись над кнопкой, а не сбоку
    "above",
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
        scheduleDraw();
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
          PeaksFile["peaks"] | undefined;
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
 * Подключение источников высот для региона: детальный патч → детальный слой
 * p1–p2 (vershiny-dem-hi) + базовая пирамида (agran/vershiny-dem). Промах
 * всех — только Terrarium.
 *
 * Патч региона исключает пирамиды: его LOD-кольца сами покрывают дальнюю
 * зону. А hi-слой и базовая пирамида работают вместе: первый разрежён
 * (только p1–p2), вторая добирает остальное.
 *
 * Вызывается и при смене региона: раньше `init` уходил воркеру исключительно
 * из `main()`, и после переключения с карты, из поиска или по плашке рельеф
 * продолжал считаться по патчу прежнего региона.
 */
async function initDemForRegion(region: string): Promise<void> {
  const base = import.meta.env.BASE_URL;
  const { hiDemCandidates, globalDemCandidates, pickDemBase } =
    await import("./core/dem-config");
  const { getDemIndex } = await import("./core/db");
  const { fetchWithTimeout, PROBE_TIMEOUT_MS } = await import(
    "./core/fetch-timeout"
  );
  const probes = {
    online: async (url: string) => {
      // Мёртвая сеть: проба index.json без таймаута ждёт до минуты,
      // а дальше всё равно идёт кеш — лучше уйти туда за секунды.
      // Пробе хватает короткого таймаута: она отличает «нет файла» (быстрый
      // 404) от «сеть не отвечает», ложный промах на очень медленной сети
      // ловит следующая строка — cached-индекс
      const probe = await fetchWithTimeout(
        `${url}/index.json`,
        {},
        PROBE_TIMEOUT_MS,
      ).catch(() => null);
      return !!probe && isJson(probe);
    },
    cached: async (url: string) =>
      !!(await getDemIndex(url).catch(() => undefined)),
  };
  const patchBaseUrls = (
    await Promise.all([
      pickDemBase([`${base}tiles/${region}`], probes),
      pickDemBase(hiDemCandidates(base), probes),
      pickDemBase(globalDemCandidates(base), probes),
    ])
  ).filter((url): url is string => !!url);
  worker.postMessage({ type: "init", patchBaseUrls, reqId: nextReqId++ });
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
/**
 * Токен актуальности смены региона. Загрузка вершин и DEM — асинхронная,
 * и быстрая последовательность switchRegion(A) → switchRegion(B) могла
 * завершиться в обратном порядке: поздний ответ A перетирал currentPeaks
 * уже выбранного B, а его initDemForRegion переключал worker обратно на
 * патч A. Ответ применяется, только если токен всё ещё последний.
 */
let regionSwitchSeq = 0;

async function switchRegion(region: string, manual = false): Promise<void> {
  // Флаг ставим до раннего выхода: ткнуть в уже активный регион — это
  // законный способ закрепить его за собой, и раньше он работал (обработчик
  // настроек выставлял флаг сам, до вызова)
  if (manual) {
    manualRegion = true;
    rememberRegion();
  }
  if (region === currentRegion && currentPeaks.length) return;
  const switchSeq = ++regionSwitchSeq;
  if (region !== currentRegion) {
    currentPeaks = [];
    if (panorama) {
      // Мутируем на месте, не подменяя ссылку — тот же контракт, что в
      // worker.onmessage: AR-сессия захватывает объект панорамы при входе
      // в режим камеры и рисует его каждый кадр. Подмена объекта здесь
      // оставляла оверлей навсегда на вершинах прежнего региона
      panorama.peaks = [];
      draw();
    }
  }
  currentRegion = region;
  rememberRegion();
  setStatus(t("loadingRegion"));
  void refreshDownloadState();

  const base = import.meta.env.BASE_URL;
  let peaks: PeaksFile["peaks"] | null = null;
  const { fetchWithTimeout } = await import("./core/fetch-timeout");
  const res = await fetchWithTimeout(`${base}peaks/${region}.json`).catch(
    () => null,
  );
  if (res && isJson(res)) {
    peaks = ((await res.json()) as PeaksFile).peaks;
  } else {
    const { getPeaks } = await import("./core/db");
    peaks = ((await getPeaks(region)) ?? null) as PeaksFile["peaks"] | null;
  }
  // Пока грузили, регион могли сменить повторно: чужой результат не применяем
  if (switchSeq !== regionSwitchSeq) return;
  if (peaks) {
    // Изоляция: сначала кеш (см. main), потом расчёт — и запомнить
    const { ensureIsolation, restoreIsolation } = await import(
      "./core/peaks"
    );
    const { getIsolation, saveIsolation } = await import("./core/db");
    const cachedIso = await getIsolation(region).catch(() => undefined);
    const fromCache = cachedIso ? restoreIsolation(peaks, cachedIso) : false;
    if (!fromCache) {
      ensureIsolation(peaks);
      const isoSnapshot = peaks.map((p) => p.isoM ?? 0);
      void saveIsolation(region, isoSnapshot).catch(() => {});
    }
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
        PeaksFile["peaks"] | undefined;
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
      PeaksFile["peaks"] | undefined;
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
      // Всё уже на устройстве: прогонять тысячи ключей загрузки незачем —
      // человек видит секундный прогресс при нуле трафика. Проверка полноты
      // тоже недешёвая (по одному чтению IndexedDB на тайл), но в разы
      // быстрее сетевой загрузки и не зависит от связи.
      const regions = await loadRegions();
      const info = regions[currentRegion];
      if (
        regionDownloaded &&
        !regionOutdated &&
        info &&
        !(await isRegionIncomplete(info, lastOrigin))
      ) {
        setStatus(t("downloadUpToDate"));
        setTimeout(() => setStatus(""), 2500);
        return;
      }
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
      regionOutdated = false;
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
/** Рельеф региона устарел: пирамида пересобрана после скачивания */
let regionOutdated = false;
/** Тост об устаревшем рельефе показываем один раз за сессию */
let outdatedToastShown = false;
/** localStorage-ключ: когда последний раз показывали тост об устаревании */
const OUTDATED_TOAST_AT_KEY = "vershiny-outdated-toast-at";
/** Не чаще раза в сутки: привыкание к ежедневному предупреждению = его игнор */
const OUTDATED_TOAST_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Перечитать из хранилища, лежит ли текущий регион офлайн */
async function refreshDownloadState(): Promise<void> {
  if (!downloadButton) return;
  try {
    const { getDownloadedRegions } = await import("./core/db");
    const { isRegionOutdated } = await import("./ui/download");
    regionDownloaded = (await getDownloadedRegions()).includes(currentRegion);
    regionOutdated =
      regionDownloaded && (await isRegionOutdated(currentRegion));
    // Человек не должен узнать в горах без связи, что его офлайн-рельеф
    // давно вычищен при пересборке пирамиды — предупреждаем заранее.
    // Но не в офлайне: перекачать всё равно нельзя, а панорама нужнее.
    // И не чаще раза в сутки: привыкание к ежедневному тосту = его игнор.
    if (regionOutdated && !outdatedToastShown && navigator.onLine) {
      const lastAt = Number(localStorage.getItem(OUTDATED_TOAST_AT_KEY) ?? 0);
      if (Date.now() - lastAt > OUTDATED_TOAST_MIN_INTERVAL_MS) {
        outdatedToastShown = true;
        localStorage.setItem(OUTDATED_TOAST_AT_KEY, String(Date.now()));
        setStatus(t("demOutdatedToast"), 20_000, {
          label: t("settings"),
          onClick: () => {
            // Открываем настройки — там кнопка «Обновить» у каждого региона
            void import("./ui/settings").then(({ openSettings }) =>
              openSettings(currentRegion, lastOrigin, {
                onRegionChange: (region) => void switchRegion(region, true),
                onLocaleChange: () => {},
                onClose: () => {},
                onCalibrationChange: () => {},
              }),
            );
          },
        });
      }
    }
  } catch {
    regionDownloaded = false; // приватный режим: считаем, что не скачано
    regionOutdated = false;
  }
  applyDownloadState();
}

function applyDownloadState(): void {
  const btn = downloadButton;
  if (!btn) return;
  // Плашка-подпись живёт в общем слое (не внутри кнопки) — innerHTML ей
  // не страшен
  btn.innerHTML = regionDownloaded ? ICON_DOWNLOADED : ICON_DOWNLOAD;
  btn.style.background = regionDownloaded
    ? regionOutdated
      ? "#8c2d18"
      : "#2d6a4f"
    : "#415a77";
  const title = regionOutdated
    ? t("demOutdated")
    : regionDownloaded
      ? t("regionDownloaded")
      : t("downloadRegion");
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
  captionPlace?: CaptionEntry["side"],
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
  // Подпись на время загрузки: приоритет — сбоку (у кнопок правого края
  // слева, у левого — справа): так текст читается на одной строке с кнопкой
  // и не уходит за экран. Сверху/снизу — только где сбоку занято (карте
  // справа мешает навипад — её подпись явно "above").
  const place =
    captionPlace ??
    (pos.includes("right:")
      ? "left"
      : pos.includes("left:")
        ? "right"
        : "below");
  addCaption(btn, titleKey, place);
  document.body.appendChild(btn);
  // Раскладка плашек — после вставки кнопки в DOM, когда у неё есть размеры
  requestAnimationFrame(layoutCaptions);
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

/**
 * Подписи к кнопкам главного экрана: выносные плашки со стрелкой.
 *
 * На старте (пока идут «Загрузка…» → «Загрузка региона…» → «Расчёт
 * панорамы…») иконки без слов не говорят новичку ничего, поэтому на время
 * начальной загрузки каждая кнопка подписывается. Плашка кладётся В СТОРОНЕ
 * от кнопки и указывает на неё стрелкой — прижатый к кнопке текст налезал и
 * на соседние кнопки, и на соседние плашки (левый верхний угол, навипад).
 * Разводка — layoutCaptions(): сдвигает плашки, пока не исчезнут
 * пересечения друг с другом и с кнопками; гарантию проверяет тест
 * (test/captions-layout.test.ts). Реестр (captionEntries, слои) объявлен
 * рядом с localizedTitles — см. комментарий там (TDZ на iOS).
 */

function ensureCaptionLayer(): { layer: HTMLElement; arrows: SVGSVGElement } {
  if (!captionLayer) {
    captionLayer = document.createElement("div");
    captionLayer.style.cssText =
      "position:fixed;inset:0;z-index:11;pointer-events:none;overflow:hidden";
    captionArrowLayer = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    captionArrowLayer.setAttribute(
      "style",
      "position:absolute;inset:0;width:100%;height:100%",
    );
    captionLayer.appendChild(captionArrowLayer);
    document.body.appendChild(captionLayer);
  }
  return { layer: captionLayer, arrows: captionArrowLayer! };
}

function addCaption(
  btn: HTMLElement,
  key: TitleKey,
  side: CaptionEntry["side"],
): void {
  const { layer } = ensureCaptionLayer();
  const root = document.createElement("div");
  root.style.cssText = "position:absolute;visibility:hidden";
  const label = document.createElement("div");
  label.textContent = t(key);
  label.style.cssText =
    "white-space:nowrap;font-size:11px;line-height:1.3;padding:2px 8px;" +
    "border-radius:6px;background:rgba(13,27,42,0.85);color:#f1faee;" +
    "font-family:system-ui;box-shadow:0 1px 4px rgba(0,0,0,.4)";
  root.appendChild(label);
  root.style.display = captionsVisible ? "" : "none";
  layer.appendChild(root);
  captionEntries.push({ btn, root, label, key, side });
}

/**
 * Положение кнопки в системе координат UI. getBoundingClientRect отдаёт
 * ФИЗИЧЕСКИЕ координаты экрана; при программном повороте (body повёрнут
 * на 90°) конвертируем в локальные — иначе плашки разъехались бы с
 * кнопками на четверть оборота.
 */
function btnRect(btn: HTMLElement): DOMRect {
  const r = btn.getBoundingClientRect();
  const angle = screenOrientationModule.softAngleDeg();
  if (angle === 0 || !r.width) return r;
  const b = document.body;
  const br = b.getBoundingClientRect(); // физический бокс повёрнутого body
  const cx = br.left + br.width / 2;
  const cy = br.top + br.height / 2;
  const bw = b.offsetWidth; // offset* игнорируют трансформ — это локальные
  const bh = b.offsetHeight;
  // Обратный поворот вокруг центра body; у повёрнутого прямоугольника
  // ширина и высота меняются местами. Знаки — по направлению поворота
  if (angle === -90)
    return new DOMRect(
      bw / 2 - (r.bottom - cy),
      bh / 2 + (r.left - cx),
      r.height,
      r.width,
    );
  return new DOMRect(
    bw / 2 + (r.top - cy),
    bh / 2 - (r.right - cx),
    r.height,
    r.width,
  );
}

/**
 * Точка на рамке прямоугольника, куда упирается луч из его центра к цели.
 * Так стрелка плашки начинается с той стороны (бок, верх, низ), которая
 * реально ближе к кнопке, а не с той, что «положена» по стороне размещения.
 */
function rectBorderPoint(
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  targetX: number,
  targetY: number,
): { x: number; y: number } {
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  const dx = targetX - cx;
  const dy = targetY - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const scaleX = dx !== 0 ? rw / 2 / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? rh / 2 / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** Точка на окружности кнопки, ближайшая к цели (кнопки у нас круглые) */
function circleBorderPoint(
  cx: number,
  cy: number,
  radius: number,
  targetX: number,
  targetY: number,
): { x: number; y: number } {
  const dx = targetX - cx;
  const dy = targetY - cy;
  const dist = Math.hypot(dx, dy);
  if (!dist) return { x: cx, y: cy };
  return { x: cx + (dx / dist) * radius, y: cy + (dy / dist) * radius };
}

// --- Геометрия отрезков для коллизий стрелок ---

interface Pt {
  x: number;
  y: number;
}

/** Отрезок пересекает прямоугольник (включая касание) */
function segIntersectsRect(
  a: Pt,
  b: Pt,
  r: { left: number; top: number; right: number; bottom: number },
): boolean {
  // Оба конца по одну сторону — точно мимо
  if (
    (a.x < r.left && b.x < r.left) ||
    (a.x > r.right && b.x > r.right) ||
    (a.y < r.top && b.y < r.top) ||
    (a.y > r.bottom && b.y > r.bottom)
  )
    return false;
  // Конец внутри
  const inside = (p: Pt) =>
    p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  if (inside(a) || inside(b)) return true;
  // Пересечение с любой из четырёх сторон
  const tl = { x: r.left, y: r.top };
  const tr = { x: r.right, y: r.top };
  const bl = { x: r.left, y: r.bottom };
  const br = { x: r.right, y: r.bottom };
  return (
    segSeg(a, b, tl, tr) ||
    segSeg(a, b, tr, br) ||
    segSeg(a, b, br, bl) ||
    segSeg(a, b, bl, tl)
  );
}

/** Допуск «касания» отрезков, px — см. segSeg */
const TOUCH_EPS_PX = 0.75;

/** Пересечение двух отрезков (включая касание) */
function segSeg(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (a: Pt, b: Pt, c: Pt) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  // Строгое пересечение: концы каждого отрезка по разные стороны другого
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  )
    return true;
  // Касание: конец одного отрезка коллинеарен другому и лежит в его спане.
  // Раньше неравенства были строгими при комментарии «включая касание», и
  // точно касающиеся стрелки/плашки не считались коллизией
  const on = (a: Pt, b: Pt, c: Pt): boolean =>
    // Коллинеарность — с допуском, а не точным === 0: координаты из
    // getBoundingClientRect дробные, и касание в долях пикселя — тоже
    // касание. |d| = |ab| × дистанция до прямой, поэтому порог масштабируем
    // длиной отрезка
    Math.abs(d(a, b, c)) <= TOUCH_EPS_PX * Math.hypot(b.x - a.x, b.y - a.y) &&
    c.x >= Math.min(a.x, b.x) &&
    c.x <= Math.max(a.x, b.x) &&
    c.y >= Math.min(a.y, b.y) &&
    c.y <= Math.max(a.y, b.y);
  return on(p3, p4, p1) || on(p3, p4, p2) || on(p1, p2, p3) || on(p1, p2, p4);
}

/**
 * Раскладка плашек: базовая точка в стороне от кнопки, затем раздвижка
 * вдоль оси, пока плашка не перестанет пересекаться с кнопками и другими
 * плашками. Ось: left/right — по вертикали, above/below — по горизонтали.
 */
function layoutCaptions(): void {
  // Ранний вызов из resize() при вычислении модуля (requestAnimationFrame в
  // jsdom срабатывает синхронно): captionEntries/captionLayer ещё в TDZ —
  // откладываем: настоящая раскладка случится при первом показе кнопок.
  try {
    if (!captionsVisible || !captionEntries.length || !captionLayer) return;
  } catch {
    return; // TDZ на этапе инициализации модуля
  }
  const arrows = captionArrowLayer!;
  arrows.replaceChildren();
  const buttons = captionEntries.map((c) => c.btn);
  const placed: DOMRect[] = [];
  // Концы стрелок на окружностях кнопок — нужны для проверки стрелка↔кнопка
  const btnCenters = new Map<
    HTMLElement,
    { cx: number; cy: number; r: number }
  >();
  for (const b of buttons) {
    const r = btnRect(b);
    if (r.width)
      btnCenters.set(b, {
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        r: r.width / 2,
      });
  }
  const placedArrows: [Pt, Pt][] = [];

  for (const c of captionEntries) {
    const br = btnRect(c.btn);
    if (!br.width) continue;
    const label = c.label;
    const lw = label.offsetWidth || 80;
    const lh = label.offsetHeight || 18;
    const gap = 6; // зазор между плашкой и кнопкой
    const cx = br.left + br.width / 2;
    const cy = br.top + br.height / 2;

    let x = 0;
    let y = 0;
    if (c.side === "left") {
      x = br.left - gap - lw;
      y = cy - lh / 2;
    } else if (c.side === "right") {
      x = br.right + gap;
      y = cy - lh / 2;
    } else if (c.side === "above") {
      x = cx - lw / 2;
      y = br.top - gap - lh;
    } else {
      x = cx - lw / 2;
      y = br.bottom + gap;
    }
    // В пределы экрана; для above/below — ещё и выше/ниже чужих кнопок
    // того же ряда (плашка шире кнопки и по центру задевает соседей).
    // Рамки — в системе координат UI: при программном повороте это
    // локальные размеры body, а не физические window.innerWidth/Height
    const { w: W, h: H } = screenOrientationModule.virtualViewport();
    x = Math.max(4, Math.min(x, W - lw - 4));
    y = Math.max(4, Math.min(y, H - lh - 4));
    // Раздвижка, пока есть пересечения. Своя кнопка не считается
    // препятствием: плашка отстоит от неё на gap, но не пересекает.
    const vertical = c.side === "left" || c.side === "right";
    const obstacles = buttons
      .filter((b) => b !== c.btn)
      .map((b) => btnRect(b))
      .filter((r) => r.width)
      .map((r) => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      }));
    const rectHits = (rx: number, ry: number): boolean => {
      const self = { left: rx, right: rx + lw, top: ry, bottom: ry + lh };
      const hits = (r: {
        left: number;
        right: number;
        top: number;
        bottom: number;
      }) =>
        self.left < r.right &&
        self.right > r.left &&
        self.top < r.bottom &&
        self.bottom > r.top;
      return obstacles.some(hits) || placed.some(hits);
    };
    /** Пересекает ли СТРЕЛКА этой плашки чужие плашки, кнопки или стрелки */
    const arrowHits = (rx: number, ry: number): boolean => {
      const from = rectBorderPoint(rx, ry, lw, lh, cx, cy);
      const bc = btnCenters.get(c.btn);
      if (!bc) return false;
      const to = circleBorderPoint(
        bc.cx,
        bc.cy,
        bc.r,
        rx + lw / 2,
        ry + lh / 2,
      );
      for (const p of placed)
        if (
          segIntersectsRect(from, to, {
            left: p.x,
            top: p.y,
            right: p.x + p.width,
            bottom: p.y + p.height,
          })
        )
          return true;
      for (const [b, o] of btnCenters) {
        if (b === c.btn) continue;
        // Отрезок до окружности чужой кнопки: дальше её центра не идём
        const len = Math.hypot(to.x - from.x, to.y - from.y);
        const distTo = Math.hypot(o.cx - from.x, o.cy - from.y);
        if (
          distTo - o.r < len &&
          segIntersectsRect(from, to, {
            left: o.cx - o.r,
            top: o.cy - o.r,
            right: o.cx + o.r,
            bottom: o.cy + o.r,
          })
        )
          return true;
      }
      for (const [a2, b2] of placedArrows)
        if (segSeg(from, to, a2, b2)) return true;
      return false;
    };
    const collides = (rx: number, ry: number): boolean =>
      rectHits(rx, ry) || arrowHits(rx, ry);
    if (c.side === "above" || c.side === "below") {
      // Поднять/опустить, пока плашка в своём ряду не перестанет задевать
      // кнопки по вертикали (навипад: центр на строке с «Вперёд»)
      let guard = 0;
      const vertHits = (ry: number): boolean => {
        const self = { top: ry, bottom: ry + lh };
        for (const r of obstacles) {
          const horiz = x < r.right && x + lw > r.left;
          if (horiz && self.top < r.bottom && self.bottom > r.top) return true;
        }
        return false;
      };
      while (vertHits(y) && guard++ < 100) {
        y = c.side === "above" ? y - 14 : y + 14;
        if (y < 4 || y + lh > H - 4) break;
      }
    }

    // Ищем ближайший к базовой точке сдвиг без коллизий: для боковых
    // плашек — по вертикали, для верхних/нижних — по обеим осям сразу
    // (крест навипада: сдвинуть вбок — заденет боковую стрелку; только
    // комбинация «выше и в сторону» выводит из креста).
    // Если чистой позиции нет (узкий экран в портрете: четыре плашки правого
    // края не помещаются в одну колонку) — берём позицию с наименьшим
    // пересечением ПЛАШКИ, но среди равных предпочитаем ту, где стрелка не
    // режет чужие подписи/кнопки: плашка, задетая с краю, читается, а стрелка,
    // проходящая через чужой текст, — нет.
    let placed_ok = false;
    let bestScore = Infinity;
    let bestPos: { x: number; y: number } | null = null;
    const overlapArea = (rx: number, ry: number): number => {
      const self = { left: rx, right: rx + lw, top: ry, bottom: ry + lh };
      let area = 0;
      const add = (r: {
        left: number;
        right: number;
        top: number;
        bottom: number;
      }) => {
        const w = Math.min(self.right, r.right) - Math.max(self.left, r.left);
        const h = Math.min(self.bottom, r.bottom) - Math.max(self.top, r.top);
        if (w > 0 && h > 0) area += w * h;
      };
      for (const r of obstacles) add(r);
      for (const p of placed)
        add({
          left: p.x,
          right: p.x + p.width,
          top: p.y,
          bottom: p.y + p.height,
        });
      return area;
    };
    const consider = (tx: number, ty: number): boolean => {
      if (!collides(tx, ty)) {
        x = tx;
        y = ty;
        placed_ok = true;
        return true;
      }
      // Грязная стрелка штрафуется сильнее любого пересечения плашки
      const score = overlapArea(tx, ty) + (arrowHits(tx, ty) ? 1e6 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestPos = { x: tx, y: ty };
      }
      return false;
    };
    if (vertical) {
      for (let step = 0; step <= 40 && !placed_ok; step++) {
        for (const dir of step === 0 ? [1] : [1, -1]) {
          const v = y + dir * step * 14;
          if (v < 4 || v > H - lh - 4) continue;
          if (consider(x, v)) break;
        }
      }
    } else {
      outer: for (let radius = 0; radius <= 60 && !placed_ok; radius++) {
        for (let dx = -radius; dx <= radius && !placed_ok; dx++) {
          for (const dy of [-radius, radius]) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const tx = x + dx * 14;
            const ty = y + dy * 14;
            if (tx < 4 || tx > W - lw - 4 || ty < 4 || ty > H - lh - 4)
              continue;
            if (consider(tx, ty)) break outer;
          }
        }
      }
    }
    if (!placed_ok && bestPos) {
      x = (bestPos as { x: number; y: number }).x;
      y = (bestPos as { x: number; y: number }).y;
    }

    c.root.style.left = `${x}px`;
    c.root.style.top = `${y}px`;
    c.root.style.visibility = "visible";
    placed.push(new DOMRect(x, y, lw, lh));

    // Стрелка от плашки к кнопке. Концы выбираем по геометрии, а не по
    // стороне размещения: после раздвижки плашка может стоять ниже или выше
    // своей кнопки, и линия из «условной середины бока» шла наискосок через
    // пустоту. Вместо этого — луч из центра плашки в центр кнопки: начало
    // там, где луч пересекает рамку плашки (бок, верх или низ — что ближе),
    // конец — на окружности кнопки. Так линия всегда кратчайшая и выглядит
    // указателем, а не кривой через экран.
    const from = rectBorderPoint(x, y, lw, lh, cx, cy);
    const to = circleBorderPoint(cx, cy, br.width / 2, x + lw / 2, y + lh / 2);
    placedArrows.push([from, to]);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(from.x));
    line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x));
    line.setAttribute("y2", String(to.y));
    line.setAttribute("stroke", "rgba(241,250,238,0.55)");
    line.setAttribute("stroke-width", "1.2");
    line.setAttribute("stroke-dasharray", "3 3");
    arrows.appendChild(line);
  }
}

/** Скрыть подписи кнопок: начальная загрузка завершена (результат или ошибка) */
function hideButtonCaptions(): void {
  if (!captionsVisible) return;
  captionsVisible = false;
  if (captionLayer) captionLayer.style.display = "none";
  // Кнопки, чья видимость зависит от фазы загрузки (автокалибровка: при
  // загрузке — неактивная с подписью, после — скрыта до входа в AR)
  updateCalibrateBtnRef?.();
}

/** Позднее связывание: updateCalibrateBtn объявлен в setupControls() ниже,
 *  а hideButtonCaptions() может вызваться до него (ошибка раннего compute) */
let updateCalibrateBtnRef: (() => void) | null = null;

/** Перевести подписи интерфейса после смены языка */
function relabelUi(): void {
  for (const { el, key } of localizedTitles) {
    const title = t(key);
    el.title = title;
    el.setAttribute("aria-label", title);
  }
  for (const c of captionEntries) {
    c.label.textContent = t(c.key);
    c.root.style.visibility = "hidden"; // ширина изменилась — раскладка заново
  }
  layoutCaptions();
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
      `grid-row:${row};grid-column:${col};position:relative;` +
      `border:none;border-radius:${touchOnly ? "50%" : "10px"};background:#415a77;color:#f1faee;` +
      "cursor:pointer;min-width:0;min-height:0;display:flex;" +
      "align-items:center;justify-content:center";
    // Подпись на время загрузки — только GPS-кнопке: навипад у нижнего края,
    // а стрелки креста подписывать нечего — направление видно по самой иконке.
    // Сторона "left": кнопка — центр креста, окружённого стрелками со всех
    // сторон; сдвигом по одной оси плашку из креста не вывести, а влево от
    // навипада — свободно
    if (d.gps) addCaption(btn, d.label, "left");
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
      "position:relative;border:none;border-radius:10px;background:#415a77;color:#f1faee;" +
      "width:44px;height:34px;cursor:pointer;display:flex;align-items:center;justify-content:center";
    // Подпись на время загрузки — справа: справа от высотного блока пусто,
    // а сверху/снизу — соседние кнопки и край экрана
    addCaption(b, titleKey, "right");
    b.onclick = () => adjustHeight(delta);
    heightPad.appendChild(b);
    return b;
  };

  heightBtn(ICON_UP, "heightUp", 100);

  const heightLabel = document.createElement("div");
  heightLabel.id = "height-indicator";
  heightLabel.style.cssText =
    "background:rgba(13,27,42,0.8);color:#f1faee;border-radius:6px;padding:2px 8px;font-size:12px;font-family:system-ui";
  heightLabel.textContent = `${Math.round(lastObserverH)} ${t("unitM")}`;
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
  // «Низкий экран» смотрим по ВИРТУАЛЬНОЙ высоте: при программном повороте
  // (ландшафт через CSS, screen-orientation.ts) window.innerHeight остаётся
  // портретной и эвристика компактного навипада промахивалась бы
  const padSize = touchOnly
    ? 48
    : screenOrientationModule.virtualViewport().h < 420
      ? 108
      : 132;
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
  let stab = tracker.push(
    extractSkyline(frame.rgba, frame.width, frame.height),
  );
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
  if (el) el.textContent = `${Math.round(heightOverride)} ${t("unitM")}`;
  requestCompute(lastOrigin);
}

/**
 * Автоориентация: интерфейс следует за хватом телефона.
 *
 * Форму и сторону хвата следит сам модуль (гистерезис по углу крена,
 * core/screen-orientation.ts) — на каждое изменение он зовёт нас, и мы
 * пере-применяем поворот. То же при возврате в приложение (окно могло
 * перевернуться под нами) и при старте — сразу после первого показания
 * датчика, чтобы манифестный ландшафт Android PWA успел сработать первым.
 */
function setupAutoOrientation(): void {
  if (typeof document === "undefined" || !document.body) return;
  const sync = (): void => {
    if (!document.hidden) screenOrientationModule.syncOrientation();
  };
  screenOrientationModule.onVisibleFormChange(sync);
  document.addEventListener("visibilitychange", sync); // вернулись в приложение
  window.addEventListener("pageshow", sync); // bfcache-восстановление
}

/** Кнопки ⚙/AR/фото: создаются при старте, видны уже во время загрузки */
function setupActionButtons(): void {
  if (actionButtonsReady) return;
  actionButtonsReady = true;
  setupAutoOrientation();
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
    updateCalibrateBtn();
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
      updateCalibrateBtn();
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

  // Автокалибровка. На старте — видна с подписью, но неактивна (нет кадра
  // камеры — сопоставлять нечего): так у неё есть пояснение, а нажать нельзя.
  // После загрузки скрывается; появляется активной только в AR.
  const calibrateBtn = makeButton(
    ICON_CALIBRATE,
    "autoCalibrate",
    `right:${edgeRight()};bottom:${edgeBottom(120)}`,
  );
  /** Видимость/активность кнопки по фазе: загрузка (подпись, disabled) /
   *  готово (скрыта) / AR (активна) */
  function updateCalibrateBtn(): void {
    if (arSession) {
      calibrateBtn.style.display = "flex";
      calibrateBtn.disabled = false;
      calibrateBtn.style.opacity = "1";
    } else if (captionsVisible) {
      calibrateBtn.style.display = "flex";
      calibrateBtn.disabled = true;
      calibrateBtn.style.opacity = "0.45";
    } else {
      calibrateBtn.style.display = "none";
    }
  }
  calibrateBtn.onclick = () => {
    if (!calibrateBtn.disabled) void runAutoCalibration(false);
  };
  updateCalibrateBtnRef = updateCalibrateBtn;
  updateCalibrateBtn(); // старт: видна, но неактивна (подпись есть, нажать нельзя)

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
    // Регион — запасной вариант подписи на случай кадра без видимых вершин
    // (ui/photo.ts): туда идёт название на языке интерфейса
    // («Приэльбрусье»), а не ключ реестра («elbrus») — ID людям ни о чём
    // не говорит. Реестр к этому моменту уже в памяти (allRegions кеширует),
    // обращения к сети здесь нет
    const regionInfo = (await allRegions())[currentRegion];
    const options = {
      // Именно актуальные, а не аргументы функции: кнопки создаются один раз,
      // и замыкание держало бы точку первого расчёта — после перелёта к
      // вершине подпись врала бы координатами и высотой старта
      origin: lastOrigin,
      observerH: lastObserverH,
      region: regionInfo ? regionLabelSync(regionInfo) : currentRegion,
      peakName: mainPeakInView(),
      source: canvas,
      // В AR кадр содержит настоящие горы — там действует галочка «Контуры
      // склонов». Без камеры силуэту не с чем конфликтовать: рисуем всегда
      fromCamera: arSession !== null,
      // Живой кадр камеры — фон снимка; без него «фото» содержало только
      // контуры поверх градиента неба. FOV полного кадра нужен, чтобы оверлей
      // подогнать под видимую часть после cover-кропа, как в drawArFrame
      cameraVideo: arVideo,
      cameraFov: arSession?.fullFrameFov,
    };
    const blob = await capturePhoto(panorama, view, options);
    savePhoto(blob, photoFilename(options));
    setStatus(t("photoSaved"));
    setTimeout(() => setStatus(""), 3000);
  };

  // Камера стартует не отсюда, а по первому результату воркера
  // (arAutoStart в обработчике ответа): оверлей без панорамы рисовать нечем
  arAutoStart = () => void maybeAutoStartAr();
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
