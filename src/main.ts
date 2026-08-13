/**
 * Точка входа. MVP-цикл: загрузка региона → позиция → горизонт из worker →
 * рендер панорамы; поворот пальцем (fallback без сенсоров, ROADMAP 2.2).
 */

import { renderPanorama, HORIZON_FRAC, type PanoramaState, type ViewState } from './ui/panorama';
import type { Peak, PeaksFile } from './core/peaks';
import { toRad, type LatLon } from './core/geo';
import { t, getLocale } from './core/i18n';
import {
  downloadRegion,
  inBBox,
  suggestRegionForPosition,
  type DownloadProgress,
  type RegionInfo,
} from './ui/download';
import type { ResultMessage, WorkerOutMessage, ViewpointResult } from './workers/horizon.worker';
import type { SearchHit } from './core/search';
import { isTypingTarget } from './ui/keys';
import {
  ICON_AR,
  ICON_CALIBRATE,
  ICON_CLOSE,
  ICON_COMPASS,
  ICON_DOWNLOAD,
  ICON_DOWNLOADED,
  ICON_DOWN,
  ICON_LOCATE,
  ICON_MAP,
  ICON_PHOTO,
  ICON_SETTINGS,
  ICON_UP,
  iconArrow,
} from './ui/icons';

/**
 * Активный регион переживает перезапуск: выбранный вручную в настройках
 * сбрасывался на Приэльбрусье при каждом открытии приложения, и в горах без
 * связи (где авто-выбор по GPS может не сработать) это лишало вершин.
 */
const REGION_KEY = 'vershiny-region';

function storedRegion(): { region: string; manual: boolean } {
  try {
    const raw = localStorage.getItem(REGION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { region?: unknown; manual?: unknown };
      if (typeof parsed.region === 'string' && parsed.region) {
        return { region: parsed.region, manual: parsed.manual === true };
      }
    }
  } catch {
    // Приватный режим или мусор в хранилище — начинаем с умолчания
  }
  return { region: 'elbrus', manual: false };
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
let currentPeaks: PeaksFile['peaks'] = []; // пики текущего региона (для навигации)

const statusEl = document.getElementById('status')!;
const appEl = document.getElementById('app')!;

// Регистрация Service Worker (PWA, офлайн-режим и обновления)
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .then(async (registration) => {
      const { setupUpdates } = await import('./ui/update');
      setupUpdates(registration);
    })
    .catch(() => {
      // Офлайн-режим не критичен: приложение работает и без него
    });
}

function setStatus(text: string): void {
  statusEl.textContent = text;
  statusEl.style.display = text ? 'block' : 'none';
}

const canvas = document.createElement('canvas');
appEl.appendChild(canvas);
const ctx = canvas.getContext('2d')!;

/** Готовая панорама: null, пока worker не прислал первый результат */
let panorama: PanoramaState | null = null;

/** Нижние кнопки: их положение зависит от формы экрана (см. layoutControls) */
let navPad: HTMLElement | null = null;
let heightPadEl: HTMLElement | null = null;
let mapButton: HTMLElement | null = null;

/** Сенсорный экран без мыши: раскладка кнопок там другая */
const touchOnly =
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function resize(): void {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  syncFov();
  layoutControls();
  // Смена размера очищает холст: без перерисовки панорама пропадала до
  // следующего пересчёта (поворот телефона — пустой экран)
  draw();
}
new ResizeObserver(resize).observe(canvas);
// Поворот телефона: ResizeObserver срабатывает не всегда до перерисовки,
// а на iOS размеры на момент события ещё старые — отсюда отдельный слушатель
screen.orientation?.addEventListener('change', () => setTimeout(resize, 50));

const view: ViewState = {
  centerAzRad: 0,
  tiltRad: 0,
  fovRad: toRad(60),
  fovVRad: toRad(45),
};

/**
 * Углы обзора под текущую форму экрана.
 *
 * Длинная сторона всегда получает BASE_FOV, короткая — производный угол, как
 * у объектива камеры. Иначе поворот телефона менял бы масштаб: при постоянных
 * 60° по горизонтали портретный экран растягивал вертикаль до сотни градусов,
 * и те же горы становились вдвое мельче, чем в ландшафте.
 *
 * Второй угол выводится через тангенс, а не пропорцией: только так пиксель
 * стоит одинаково по обеим осям и картинка не сплющена — это же требование
 * приходит от AR, где панорама совмещается с кадром камеры.
 *
 * Если поле зрения задано в калибровке, берётся оно: у каждого телефона свой
 * объектив, и при расхождении углов контуры совпадают в центре кадра, но
 * разъезжаются к краям — азимутом это не лечится. Панорама и AR рисуют одни и
 * те же контуры, поэтому угол у них общий: подстроив его по кадру камеры,
 * пользователь сразу видит результат и без AR.
 */
function syncFov(): void {
  const { width, height } = canvas;
  if (!width || !height) return;
  const baseDeg = getCalibration().cameraFovDeg ?? DEFAULT_CAMERA_FOV_DEG;
  const baseRad = toRad(baseDeg);
  const half = Math.tan(baseRad / 2);
  if (width >= height) {
    view.fovRad = baseRad;
    view.fovVRad = 2 * Math.atan(half * (height / width));
  } else {
    view.fovVRad = baseRad;
    view.fovRad = 2 * Math.atan(half * (width / height));
  }
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
const edgeTop = (offset = 0): string => `calc(${EDGE + offset}px + env(safe-area-inset-top))`;
const edgeBottom = (offset = 0): string =>
  `calc(${EDGE + offset}px + env(safe-area-inset-bottom))`;
const edgeLeft = (offset = 0): string => `calc(${EDGE + offset}px + env(safe-area-inset-left))`;
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

canvas.addEventListener('pointerdown', (ev) => {
  dragging = true;
  lastX = ev.clientX;
  lastY = ev.clientY;
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch {
    // Playwright/синтетические события не имеют pointerId — пропускаем
  }

  // Двойной тап = перемещение вперёд
  const now = Date.now();
  if (now - lastTap < 300) {
    moveForward();
    lastTap = 0;
  } else {
    lastTap = now;
  }
});

canvas.addEventListener('pointermove', (ev) => {
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
      const az = view.centerAzRad + Math.atan2(dy, dx); // направление движения
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
  if (orientationTracker.current.source === 'sensor') {
    if (dy) {
      const deltaDeg = ((dy / canvas.clientHeight) * view.fovVRad * 180) / Math.PI;
      setCalibration({ tiltDeg: getCalibration().tiltDeg + deltaDeg });
    }
    // Пересобирает состояние и дёргает обработчик — он и перерисует кадр
    orientationTracker.addManualOffset(-(dx / canvas.clientWidth) * view.fovRad);
    return;
  }

  // Поворот камеры (без датчиков: десктоп, отказ в доступе к компасу)
  view.centerAzRad -= (dx / canvas.clientWidth) * view.fovRad;
  view.tiltRad = Math.max(
    -MAX_TILT,
    Math.min(MAX_TILT, view.tiltRad + (dy / canvas.clientHeight) * view.fovVRad),
  );
  draw();
});

canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault()); // правый клик = перемещение

/** Перемещение вперёд по азимуту взгляда (двойной тап) */
function moveForward(): void {
  if (!panorama) return;
  const newPos = destination(lastOrigin, view.centerAzRad, MOVE_STEP_M);
  requestCompute(newPos);
}

// --- Навигация: WASD/стрелки + PageUp/PageDown ---
const MOVE_STEP_M = 500; // шаг перемещения по земле
const HEIGHT_STEP_M = 100; // шаг по высоте

window.addEventListener('keydown', (ev) => {
  if (!panorama) return;
  // Набор текста — не навигация: в поиске по карте «Washington» и «Ushba»
  // теряли буквы w/a/s/d, а стрелки вместо курсора двигали наблюдателя.
  // Ползунки настроек (input[type=range]) подстраиваются теми же стрелками
  if (isTypingTarget(ev.target) || isTypingTarget(document.activeElement)) return;
  const az = view.centerAzRad;
  let dAz = 0;
  let dDist = 0;
  let dHeight = 0;

  switch (ev.key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      dDist = MOVE_STEP_M; // вперёд по азимуту взгляда
      break;
    case 'ArrowDown':
    case 's':
    case 'S':
      dDist = -MOVE_STEP_M; // назад
      break;
    case 'ArrowLeft':
    case 'a':
    case 'A':
      dAz = -Math.PI / 2; // влево (перпендикулярно взгляду)
      dDist = MOVE_STEP_M;
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      dAz = Math.PI / 2; // вправо
      dDist = MOVE_STEP_M;
      break;
    case 'PageUp':
      dHeight = HEIGHT_STEP_M;
      break;
    case 'PageDown':
      dHeight = -HEIGHT_STEP_M;
      break;
    default:
      return;
  }

  ev.preventDefault();
  if (dHeight !== 0) {
    // Высота: пока просто логируем (нужен пересчёт с новой высотой наблюдателя)
    console.info(`Высота наблюдателя: ${dHeight > 0 ? '+' : ''}${dHeight} м (не реализовано)`);
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
import { orientationTracker } from './core/orientation';
import { getCalibration, setCalibration, DEFAULT_CAMERA_FOV_DEG } from './core/calibration';
import { destination } from './core/geo';

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
    t('enableCompass'),
    `right:${edgeRight()};top:${edgeTop(60)}`,
  );
  compassBtn.onclick = () => {
    void orientationTracker.requestPermission().then(() => updateCompassButton());
  };
}

orientationTracker.start((state) => {
  if (state.source === 'sensor') {
    const tiltOffset = (getCalibration().tiltDeg * Math.PI) / 180;
    view.centerAzRad = state.azimuthRad;
    view.tiltRad = Math.max(-MAX_TILT, Math.min(MAX_TILT, state.tiltRad + tiltOffset));
    draw();
  }
  updateCompassButton();
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
 */
function applyAutoTilt(r: ResultMessage): void {
  const rays = r.stepRad > 0 ? Math.round((2 * Math.PI) / r.stepRad) : 0;
  if (!rays) return;
  const half = view.fovRad / 2;
  const angles: number[] = [];

  for (let i = 0; i < rays; i++) {
    const az = i * r.stepRad;
    const delta = Math.abs(((az - view.centerAzRad + Math.PI) % (2 * Math.PI)) - Math.PI);
    if (delta > half) continue;
    // Силуэт — максимум по слоям дистанций на этом азимуте
    let top = -Infinity;
    for (const layer of r.layers) {
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

const worker = new Worker(new URL('./workers/horizon.worker.ts', import.meta.url), {
  type: 'module',
});

worker.onmessage = (ev: MessageEvent<WorkerOutMessage>) => {
  const msg = ev.data;
  if (msg.type === 'error') {
    // Без сети техническая формулировка («HTTP 503», «вне покрытия») ничего
    // не объясняет: человеку важно, что данных на это место нет на устройстве
    setStatus(navigator.onLine ? `${t('error')}: ${msg.message}` : t('errorOffline'));
    return;
  }
  if (msg.type === 'viewpoint') return; // ждёт свой одноразовый обработчик
  const r = msg as ResultMessage;
  panorama = {
    horizon: r.horizon,
    stepRad: r.stepRad,
    peaks: r.peaks,
    layers: r.layers,
    distanceToHorizonM: r.distanceToHorizonM,
    fronts: r.fronts,
    crests: r.crests,
  };
  lastObserverH = r.observerH;
  // Обновляем индикатор высоты
  const heightEl = document.getElementById('height-indicator');
  if (heightEl) heightEl.textContent = `${Math.round(r.observerH)} м`;
  if (autoTiltPending) {
    autoTiltPending = false;
    applyAutoTilt(r);
  }
  setStatus('');
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
  setStatus(t('loadingRegion'));

  const base = import.meta.env.BASE_URL;

  // Позиция: GPS, fallback — Приют 11 (контрольная точка MVP-ACCEPTANCE)
  const origin = await getPosition();
  lastOrigin = origin;

  // Авто-выбор региона по GPS (если пользователь не выбрал вручную).
  // Реестр читаем в любом случае: он же копится в офлайн-кеш, а без него
  // потом не открыть список регионов без сети.
  {
    const { loadRegions, findRegionForPosition } = await import('./ui/download');
    const regions = await loadRegions();
    if (!manualRegion) {
      const autoRegion = findRegionForPosition(origin, regions);
      if (autoRegion && autoRegion !== currentRegion) {
        currentRegion = autoRegion;
        rememberRegion();
        console.info(`Авто-регион: ${autoRegion}`);
      }
    }
  }

  // Пики: сеть → офлайн-кеш (IndexedDB). Без них панорама всё равно строится.
  // Vite на 404 отдаёт index.html (SPA-fallback) — проверяем Content-Type.
  let peaks: PeaksFile['peaks'] = [];
  const peaksRes = await fetch(`${base}peaks/${currentRegion}.json`).catch(() => null);
  if (peaksRes && isJson(peaksRes)) {
    peaks = ((await peaksRes.json()) as PeaksFile).peaks;
  } else {
    const { getPeaks } = await import('./core/db');
    peaks = ((await getPeaks(currentRegion)) ?? []) as PeaksFile['peaks'];
  }
  // Изоляция вершин (расстояние до ближайшей более высокой) — основа
  // приоритета подписей. Считается один раз на регион, не на кадр.
  const { annotateIsolation } = await import('./core/peaks');
  const isoT0 = performance.now();
  annotateIsolation(peaks);
  console.info(
    `Изоляция: ${peaks.length} вершин за ${(performance.now() - isoT0).toFixed(0)} мс`,
  );
  currentPeaks = peaks; // сохраняем для навигации

  // DEM: детальный патч региона → локальная пирамида → внешняя пирамида
  // (agran/vershiny-dem). Промах всех — только Terrarium; офлайн — кеш.
  const { demCandidates, pickDemBase } = await import('./core/dem-config');
  const { getDemIndex } = await import('./core/db');
  const patchBaseUrl = await pickDemBase(demCandidates(base, currentRegion), {
    online: async (url) => {
      const probe = await fetch(`${url}/index.json`).catch(() => null);
      return !!probe && isJson(probe);
    },
    cached: async (url) => !!(await getDemIndex(url).catch(() => undefined)),
  });

  worker.postMessage({ type: 'init', patchBaseUrl });

  setStatus(t('computing'));
  worker.postMessage({ type: 'compute', origin, peaks });

  // Кнопки действий; main() повторяется при смене региона — создаём один раз
  if (!navUiReady) {
    navUiReady = true;
    setupDownloadButton();
    setupMapButton(origin);
    setupNavPad();
  } else {
    // Регион мог смениться по GPS — состояние кнопки перечитываем
    void refreshDownloadState();
  }
}

/**
 * Кнопка карты: где я, куда смотрю, куда перенестись и поиск вершины.
 * Поиск живёт здесь, а не отдельной кнопкой на панораме: и то и другое —
 * «переместиться в другое место», незачем занимать два угла экрана.
 */
function setupMapButton(origin: LatLon): void {
  const btn = makeButton(ICON_MAP, t('map'), `left:${edgeLeft()};bottom:${edgeBottom()}`);
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
      import('./ui/map'),
      import('./ui/download'),
    ]);
    const regions = await loadRegions();
    closeMap = openMap({
      origin: lastOrigin,
      headingRad: view.centerAzRad,
      onPick: (pos) => {
        closeMap = null;
        void goToLocation(pos);
      },
      search: findPeaks,
      onPickPeak: (hit) => {
        closeMap = null;
        void goToHit(hit, origin);
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
    });
  };
}

/** Кнопки навигации/карты/скачивания уже созданы */
let navUiReady = false;

/**
 * Переход к найденной вершине: при необходимости меняем регион и подтягиваем
 * его вершины (сеть → офлайн-кеш), затем сам перелёт.
 */
async function goToHit(hit: SearchHit, origin: LatLon): Promise<void> {
  await switchRegion(hit.region);
  jumpToPeak(hit.peak, origin);
}

/**
 * Смена региона: вершины из сети, при промахе — из офлайн-кеша.
 * Если не вышло ни то, ни другое (офлайн и регион не скачан), остаёмся без
 * подписей: панорама строится по DEM, а вершины прежнего региона к этому
 * месту отношения не имеют.
 */
async function switchRegion(region: string): Promise<void> {
  if (region === currentRegion) return;
  currentRegion = region;
  manualRegion = true;
  rememberRegion();
  setStatus(t('loadingRegion'));
  void refreshDownloadState();

  const base = import.meta.env.BASE_URL;
  let peaks: PeaksFile['peaks'] | null = null;
  const res = await fetch(`${base}peaks/${region}.json`).catch(() => null);
  if (res && isJson(res)) {
    peaks = ((await res.json()) as PeaksFile).peaks;
  } else {
    const { getPeaks } = await import('./core/db');
    peaks = ((await getPeaks(region)) ?? null) as PeaksFile['peaks'] | null;
  }
  if (peaks) {
    const { annotateIsolation } = await import('./core/peaks');
    annotateIsolation(peaks);
    currentPeaks = peaks;
  } else {
    // Офлайн и регион не скачан: вершины прежнего региона оставлять нельзя —
    // они за сотни километров отсюда. Рельеф при этом есть из пирамиды
    currentPeaks = [];
  }
}

/**
 * Перенос в произвольную точку планеты (с карты): регион выбираем по bbox,
 * как при старте по GPS. Вне всех регионов вершин не будет, но рельеф есть
 * везде — глобальная пирамида покрывает всю сушу.
 */
async function goToLocation(pos: LatLon): Promise<void> {
  setStatus(t('computing'));
  const { loadRegions, findRegionForPosition } = await import('./ui/download');
  const region = findRegionForPosition(pos, await loadRegions());
  if (region) {
    await switchRegion(region);
  } else {
    // Реестр покрывает не всю сушу. Оставлять вершины прежнего региона нельзя:
    // они за тысячи километров и к этому месту отношения не имеют
    currentPeaks = [];
  }
  heightOverride = null; // на землю: набранная высота к новой точке не относится
  autoTiltPending = true;
  requestCompute(pos);
}

/** Переход к вершине: точка, откуда она видна, и взгляд на неё */
async function jumpToPeak(peak: Peak, from: LatLon): Promise<void> {
  void from;
  setStatus(t('computing'));
  // Точку обзора подбирает worker: у него DEM, а «просто отойти на 5 км
  // назад по азимуту» приводит в цирк под соседней стеной
  const spot = await requestViewpoint(peak);
  heightOverride = null; // «телепорт» на землю: набранная высота не имеет смысла
  autoTiltPending = true; // наводимся на рельеф в новой точке
  view.centerAzRad = spot.azimuthRad;
  requestCompute(spot.origin);
  draw();
}

/** Запрос точки обзора у worker'а (одноразовый обработчик) */
function requestViewpoint(peak: Peak): Promise<ViewpointResult> {
  return new Promise((resolve) => {
    const onMessage = (ev: MessageEvent<WorkerOutMessage>): void => {
      if (ev.data.type !== 'viewpoint') return;
      worker.removeEventListener('message', onMessage);
      resolve(ev.data);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'viewpoint', peak });
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
  const { searchPeaks, searchIndex, searchFuzzy, mergeHits, loadSearchIndex } = await import(
    './core/search'
  );
  const groups: SearchHit[][] = [searchPeaks(query, currentPeaks, currentRegion)];

  // Скачанные регионы — работают офлайн; читаются параллельно
  const { getDownloadedRegions, getPeaks } = await import('./core/db');
  const downloaded = (await getDownloadedRegions()).filter((r) => r !== currentRegion);
  const offline = await Promise.all(
    downloaded.map(async (region) => {
      const peaks = (await getPeaks(region)) as PeaksFile['peaks'] | undefined;
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

  const fuzzy: SearchHit[][] = [searchFuzzy(query, currentPeaks, currentRegion)];
  for (let i = 0; i < downloaded.length; i++) {
    const peaks = (await getPeaks(downloaded[i])) as PeaksFile['peaks'] | undefined;
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
    t('downloadRegion'),
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
        if (p.phase === 'peaks') {
          setStatus(t('downloadPeaks'));
        } else if (p.phase === 'tiles') {
          setStatus(`${t('downloadTiles')}: ${p.done}/${p.total}`);
        } else if (p.phase === 'done') {
          setStatus('');
        }
      });
      regionDownloaded = true;
      applyDownloadState();
    } catch (err) {
      setStatus(`${t('error')}: ${err instanceof Error ? err.message : err}`);
      btn.textContent = '✗';
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
    const { getDownloadedRegions } = await import('./core/db');
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
  btn.style.background = regionDownloaded ? '#2d6a4f' : '#415a77';
  const title = regionDownloaded ? t('regionDownloaded') : t('downloadRegion');
  btn.title = title;
  btn.setAttribute('aria-label', title);
}

/**
 * Фабрика круглых кнопок действий.
 * icon — инлайновый SVG (см. ui/icons.ts) или текст; SVG рисуется одинаково
 * на всех платформах, в отличие от эмодзи.
 */
function makeButton(icon: string, title: string, pos: string): HTMLButtonElement {
  const btn = document.createElement('button');
  if (icon.startsWith('<svg')) btn.innerHTML = icon;
  else btn.textContent = icon;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.style.cssText =
    `position:fixed;${pos};width:48px;height:48px;` +
    'border-radius:50%;border:none;background:#415a77;color:#f1faee;' +
    'font-size:20px;cursor:pointer;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.4);' +
    'display:flex;align-items:center;justify-content:center';
  document.body.appendChild(btn);
  return btn;
}

/**
 * Экранный джойстик: перемещение по земле + возврат на GPS.
 *
 * Крест без диагоналей: диагональ — это два нажатия соседних стрелок, а
 * восемь кнопок в углу экрана занимали место и путали. Стрелки показывают
 * направление относительно взгляда и поворачиваются вместе с камерой.
 *
 * На сенсорном экране стрелок нет вовсе: там перемещение делается двойным
 * тапом по нужному месту склона, а место на экране телефона дороже. Остаётся
 * одна кнопка — возврат к своему положению.
 */
function setupNavPad(): void {
  const pad = document.createElement('div');
  pad.style.cssText =
    'position:fixed;z-index:10;display:grid;gap:4px;' +
    (touchOnly
      ? 'grid-template-columns:1fr;grid-template-rows:1fr'
      : 'grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr)');
  document.body.appendChild(pad);
  navPad = pad;

  const arrows: { cell: string; az?: number; label: string; gps?: boolean }[] = [
    { cell: '1 / 2', az: 0, label: t('navForward') },
    { cell: '2 / 1', az: -Math.PI / 2, label: t('navLeft') },
    { cell: '2 / 3', az: Math.PI / 2, label: t('navRight') },
    { cell: '3 / 2', az: Math.PI, label: t('navBack') },
  ];
  const dirs = touchOnly
    ? [{ cell: '1 / 1', label: t('navGps'), gps: true }]
    : [...arrows, { cell: '2 / 2', label: t('navGps'), gps: true }];

  for (const d of dirs) {
    const btn = document.createElement('button');
    btn.innerHTML = d.gps ? ICON_LOCATE : iconArrow(((d.az ?? 0) * 180) / Math.PI);
    btn.title = d.label;
    btn.setAttribute('aria-label', d.label);
    const [row, col] = d.cell.split(' / ');
    btn.style.cssText =
      `grid-row:${row};grid-column:${col};` +
      `border:none;border-radius:${touchOnly ? '50%' : '10px'};background:#415a77;color:#f1faee;` +
      'cursor:pointer;min-width:0;min-height:0;display:flex;' +
      'align-items:center;justify-content:center';
    if (d.gps) {
      btn.onclick = () => {
        getPosition().then((pos) => {
          heightOverride = null; // возврат на землю в точке GPS
          autoTiltPending = true;
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
  const heightPad = document.createElement('div');
  heightPad.style.cssText =
    'position:fixed;z-index:10;display:flex;flex-direction:column;gap:4px;align-items:center';
  document.body.appendChild(heightPad);
  heightPadEl = heightPad;
  layoutControls();

  const heightBtn = (icon: string, title: string, delta: number): HTMLButtonElement => {
    const b = document.createElement('button');
    b.innerHTML = icon;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.style.cssText =
      'border:none;border-radius:10px;background:#415a77;color:#f1faee;' +
      'width:44px;height:34px;cursor:pointer;display:flex;align-items:center;justify-content:center';
    b.onclick = () => adjustHeight(delta);
    heightPad.appendChild(b);
    return b;
  };

  heightBtn(ICON_UP, t('heightUp'), 100);

  const heightLabel = document.createElement('div');
  heightLabel.id = 'height-indicator';
  heightLabel.style.cssText =
    'background:rgba(13,27,42,0.8);color:#f1faee;border-radius:6px;padding:2px 8px;font-size:12px;font-family:system-ui';
  heightLabel.textContent = `${Math.round(lastObserverH)} м`;
  heightPad.appendChild(heightLabel);

  heightBtn(ICON_DOWN, t('heightDown'), -100);
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
let arSession: import('./ui/ar').ArSession | null = null;

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
    if (!silent) setStatus(t('calibrateNoFrame'));
    return;
  }

  if (!silent) setStatus(t('calibrating'));
  const { extractSkyline, matchSkyline, horizonEnvelope, MIN_CONFIDENCE } = await import(
    './core/skyline'
  );
  const profile = extractSkyline(frame.rgba, frame.width, frame.height);
  const match = matchSkyline(profile, {
    centerAzRad: view.centerAzRad,
    tiltRad: view.tiltRad,
    fovRad: view.fovRad,
    fovVRad: view.fovVRad,
    horizonFrac: HORIZON_FRAC,
    // Совмещаем кадр с силуэтом, а не с ближней корзиной 0–5 км: за неё в
    // горах отвечает трава под ногами, а видно человеку дальний хребет
    horizon: horizonEnvelope([
      ...(panorama.crests ?? []),
      ...(panorama.layers ?? []),
      panorama.horizon,
    ]),
    stepRad: panorama.stepRad,
  });

  if (match.confidence < MIN_CONFIDENCE) {
    setStatus(silent ? '' : t('calibrateFailed'));
    if (!silent) setTimeout(() => setStatus(''), 4000);
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
  setStatus(`${t('calibrateDone')} ${azDeg > 0 ? '+' : ''}${azDeg.toFixed(1)}°`);
  setTimeout(() => setStatus(''), 3000);
}

/** Пересчёт панорамы: единственная точка отправки задания воркеру */
function requestCompute(origin: LatLon): void {
  lastOrigin = origin;
  worker.postMessage({
    type: 'compute',
    origin,
    peaks: currentPeaks,
    observerHeightOverride: heightOverride ?? undefined,
  });
  setStatus(t('computing'));
  // Единая точка пересчёта — единственное место, где видно любое перемещение:
  // GPS, шаг навипадом, перелёт, перенос с карты
  void checkRegionForPosition(origin);
}

/** Реестр регионов: читается один раз, дальше из памяти (см. loadRegions) */
async function allRegions(): Promise<Record<string, RegionInfo>> {
  const { loadRegions } = await import('./ui/download');
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

  const box = document.createElement('div');
  box.dataset.region = region;
  // Ниже верхних кнопок и во всю ширину: между «настройками» и «скачать» на
  // телефоне остаётся 246 px — текст ломался в столбик, а кнопка вылезала
  // за плашку и наезжала на соседний угол
  box.style.cssText =
    `position:fixed;left:${edgeLeft()};right:${edgeRight()};top:${edgeTop(56)};z-index:50;` +
    'display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 10px;' +
    'background:rgba(26,26,46,.95);border:1px solid #415a77;border-radius:12px;' +
    'padding:10px 12px;font:13px/1.4 system-ui,sans-serif;color:#f1faee;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.45)';

  const text = document.createElement('span');
  text.textContent = `${t('regionSuggest')} ${regionLabelSync(info)}`;
  text.style.cssText = 'flex:1 1 auto;min-width:0';
  box.appendChild(text);

  const accept = document.createElement('button');
  accept.textContent = t('regionSwitch');
  accept.style.cssText =
    'flex-shrink:0;border:none;border-radius:8px;padding:7px 12px;font-size:13px;' +
    'font-weight:600;background:#4cc9f0;color:#1a1a2e;cursor:pointer';
  accept.onclick = async () => {
    hideRegionSuggestion();
    await switchRegion(region);
    requestCompute(lastOrigin);
  };

  const dismiss = document.createElement('button');
  dismiss.innerHTML = ICON_CLOSE;
  dismiss.title = t('close');
  dismiss.style.cssText =
    'flex-shrink:0;border:none;border-radius:8px;width:32px;height:32px;' +
    'background:transparent;color:#cfd8dc;cursor:pointer;display:flex;' +
    'align-items:center;justify-content:center';
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
  return getLocale() === 'ru'
    ? (info.title_ru ?? info.title_en ?? '')
    : (info.title_en ?? info.title_ru ?? '');
}

/** Изменение высоты наблюдателя (пересчёт панорамы) */
function adjustHeight(deltaM: number): void {
  heightOverride = (heightOverride ?? lastObserverH) + deltaM;
  const el = document.getElementById('height-indicator');
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
    t('settings'),
    `left:${edgeLeft()};top:${edgeTop()}`,
  );
  let settingsClose: (() => void) | null = null;
  settingsBtn.onclick = async () => {
    if (settingsClose) {
      settingsClose();
      settingsClose = null;
      return;
    }
    const { openSettings } = await import('./ui/settings');
    settingsClose = openSettings(currentRegion, lastOrigin, {
      onRegionChange: (region) => {
        currentRegion = region;
        manualRegion = true; // больше не переключаем автоматически
        rememberRegion();
        // Перезагружаем панораму с новым регионом
        main();
      },
      onLocaleChange: () => {
        // Перерисовываем интерфейс
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

  // AR-режим
  const arBtn = makeButton(ICON_AR, t('arMode'), `right:${edgeRight()};bottom:${edgeBottom()}`);
  arBtn.onclick = async () => {
    if (arSession) {
      arSession.stop();
      arSession = null;
      arBtn.style.background = '#415a77';
      calibrateBtn.style.display = 'none';
      return;
    }
    if (!panorama) return;
    try {
      const { startAr } = await import('./ui/ar');
      const video = document.createElement('video');
      video.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1';
      document.body.prepend(video);
      arSession = await startAr(video, canvas, panorama, view);
      arBtn.style.background = '#e63946';
      calibrateBtn.style.display = 'flex';
      // Автоматическая попытка при входе в AR (включена по умолчанию):
      // камере нужно пару кадров на экспозицию, иначе анализируем черноту
      if (getCalibration().autoCalibrate) {
        setTimeout(() => void runAutoCalibration(true), 1200);
      }
    } catch (err) {
      setStatus(`${t('error')}: ${err instanceof Error ? err.message : err}`);
    }
  };

  // Автокалибровка: видна только в AR — сопоставлять нечего, пока нет кадра
  const calibrateBtn = makeButton(
    ICON_CALIBRATE,
    t('autoCalibrate'),
    `right:${edgeRight()};bottom:${edgeBottom(120)}`,
  );
  calibrateBtn.style.display = 'none';
  calibrateBtn.onclick = () => void runAutoCalibration(false);

  // Фото с подписями
  const photoBtn = makeButton(
    ICON_PHOTO,
    t('photo'),
    `right:${edgeRight()};bottom:${edgeBottom(60)}`,
  );
  photoBtn.onclick = async () => {
    if (!panorama) return;
    const { capturePhoto, sharePhoto } = await import('./ui/photo');
    const blob = await capturePhoto(panorama, view, {
      // Именно актуальные, а не аргументы функции: кнопки создаются один раз,
      // и замыкание держало бы точку первого расчёта — после перелёта к
      // вершине подпись врала бы координатами и высотой старта
      origin: lastOrigin,
      observerH: lastObserverH,
      region: currentRegion,
      source: canvas,
    });
    try {
      await sharePhoto(blob);
    } catch (err) {
      // Отмена шаринга пользователем — это AbortError, а не сбой
      if (!(err instanceof DOMException && err.name === 'AbortError')) throw err;
    }
  };
}

/** Ответ — JSON, а не SPA-fallback index.html? */
function isJson(res: Response): boolean {
  return (
    res.ok && (res.headers.get('content-type') ?? '').includes('application/json')
  );
}

function getPosition(): Promise<LatLon> {
  return new Promise((resolve) => {
    // Отладка/шаринг: ?lat=43.318&lon=42.458 (Приют 11)
    const q = new URLSearchParams(location.search);
    const qLat = Number(q.get('lat'));
    const qLon = Number(q.get('lon'));
    if (q.get('lat') && q.get('lon') && !Number.isNaN(qLat) && !Number.isNaN(qLon)) {
      resolve({ lat: qLat, lon: qLon });
      return;
    }
    // Приют 11 (4130 м) — сверено с Terrarium: отметка ~4134 м
    const fallback: LatLon = { lat: 43.318, lon: 42.458 };
    if (!('geolocation' in navigator)) {
      resolve(fallback);
      return;
    }
    const timer = setTimeout(() => resolve(fallback), 8_000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
      { enableHighAccuracy: true, timeout: 7_000 },
    );
  });
}

main();
