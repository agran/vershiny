/**
 * Точка входа. MVP-цикл: загрузка региона → позиция → горизонт из worker →
 * рендер панорамы; поворот пальцем (fallback без сенсоров, ROADMAP 2.2).
 */

import { renderPanorama, type PanoramaState, type ViewState } from './ui/panorama';
import type { Peak, PeaksFile } from './core/peaks';
import { toRad, type LatLon } from './core/geo';
import { t, peakName, getLocale } from './core/i18n';
import { downloadRegion, type DownloadProgress } from './ui/download';
import type { ResultMessage, WorkerOutMessage, ViewpointResult } from './workers/horizon.worker';
import type { SearchHit } from './core/search';

let currentRegion = 'elbrus';
let manualRegion = false; // true = пользователь выбрал вручную в настройках
let currentPeaks: PeaksFile['peaks'] = []; // пики текущего региона (для навигации)

const statusEl = document.getElementById('status')!;
const appEl = document.getElementById('app')!;

// Регистрация Service Worker (PWA, офлайн-режим)
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
    // Офлайн-режим не критичен в dev
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

function resize(): void {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  syncVerticalFov();
  // Смена размера очищает холст: без перерисовки панорама пропадала до
  // следующего пересчёта (поворот телефона — пустой экран)
  draw();
}
new ResizeObserver(resize).observe(canvas);

const view: ViewState = {
  centerAzRad: 0,
  tiltRad: 0,
  fovRad: toRad(60),
  fovVRad: toRad(45),
};

/**
 * Вертикальный FOV выводим из горизонтального и пропорций холста —
 * иначе картинка растянута/сжата по вертикали и не совместится с кадром камеры.
 */
function syncVerticalFov(): void {
  if (!canvas.width || !canvas.height) return;
  view.fovVRad = 2 * Math.atan(Math.tan(view.fovRad / 2) * (canvas.height / canvas.width));
}
resize();

/** Предел наклона камеры, рад */
const MAX_TILT = toRad(45);

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
  } else {
    // Поворот камеры
    view.centerAzRad -= (dx / canvas.clientWidth) * view.fovRad;
    view.tiltRad = Math.max(
      -MAX_TILT,
      Math.min(MAX_TILT, view.tiltRad + (dy / canvas.clientHeight) * view.fovVRad),
    );
    draw();
  }
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
import { destination } from './core/geo';

orientationTracker.start((state) => {
  if (state.source === 'sensor') {
    view.centerAzRad = state.azimuthRad;
    view.tiltRad = Math.max(-MAX_TILT, Math.min(MAX_TILT, state.tiltRad));
    draw();
  }
});

// При ручном свайпе — добавляем оффсет к сенсорному азимуту
canvas.addEventListener('pointermove', (ev) => {
  if (!dragging || orientationTracker.current.source !== 'sensor') return;
  const dx = ev.clientX - lastX;
  orientationTracker.addManualOffset(-(dx / canvas.clientWidth) * view.fovRad);
});

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
    setStatus(`${t('error')}: ${msg.message}`);
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
  setupActionButtons(lastOrigin, r.observerH);
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

  // Авто-выбор региона по GPS (если пользователь не выбрал вручную)
  if (!manualRegion) {
    const { loadRegions, findRegionForPosition } = await import('./ui/download');
    const regions = await loadRegions();
    const autoRegion = findRegionForPosition(origin, regions);
    if (autoRegion && autoRegion !== currentRegion) {
      currentRegion = autoRegion;
      console.info(`Авто-регион: ${autoRegion}`);
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
  const { demCandidates } = await import('./core/dem-config');
  let patchBaseUrl: string | undefined;
  for (const candidate of demCandidates(base, currentRegion)) {
    const probe = await fetch(`${candidate}/index.json`).catch(() => null);
    if (probe && isJson(probe)) {
      patchBaseUrl = candidate;
      break;
    }
  }

  worker.postMessage({ type: 'init', patchBaseUrl });

  setStatus(t('computing'));
  worker.postMessage({ type: 'compute', origin, peaks });

  // Кнопки действий; main() повторяется при смене региона — создаём один раз
  if (!navUiReady) {
    navUiReady = true;
    setupDownloadButton(origin);
    setupSearchButton(origin);
    setupNavPad();
  }
}

/** Кнопки навигации/поиска/скачивания уже созданы */
let navUiReady = false;
/** Поиск вершины: поле ввода поверх панорамы + переход с отступом */
function setupSearchButton(origin: LatLon): void {
  const btn = makeButton('🔍', t('searchPeak'), 'left:16px;bottom:16px');
  let searchOverlay: HTMLElement | null = null;

  btn.onclick = () => {
    if (searchOverlay) {
      searchOverlay.remove();
      searchOverlay = null;
      return;
    }

    // Поле ввода поверх панорамы (prompt() не работает в PWA/iframe)
    searchOverlay = document.createElement('div');
    searchOverlay.style.cssText =
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'background:#1a1a2e;border-radius:12px;padding:16px;z-index:50;' +
      'display:flex;flex-direction:column;gap:12px;min-width:280px;' +
      'border:1px solid #415a77';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('searchPrompt');
    input.style.cssText =
      'background:#2b2d42;color:#f1faee;border:1px solid #415a77;' +
      'border-radius:8px;padding:10px 12px;font-size:14px;outline:none';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('close');
    cancelBtn.style.cssText =
      'background:#415a77;color:#f1faee;border:none;border-radius:8px;' +
      'padding:8px 16px;font-size:14px;cursor:pointer';
    const closeSearch = (): void => {
      searchOverlay?.remove();
      searchOverlay = null;
    };
    cancelBtn.onclick = closeSearch;

    const searchBtn = document.createElement('button');
    searchBtn.textContent = t('searchPeak');
    searchBtn.style.cssText =
      'background:#4cc9f0;color:#1a1a2e;border:none;border-radius:8px;' +
      'padding:8px 16px;font-size:14px;cursor:pointer;font-weight:500';

    // Список вариантов: одноимённых вершин много, выбор — за человеком
    const results = document.createElement('div');
    results.style.cssText =
      'display:none;flex-direction:column;gap:4px;max-height:min(50vh,320px);' +
      'overflow-y:auto;margin-top:4px';

    const runSearch = async (): Promise<void> => {
      const query = input.value.trim();
      if (!query) return;
      searchBtn.disabled = true;
      searchBtn.textContent = '…';
      const hits = await findPeaks(query);
      searchBtn.disabled = false;
      searchBtn.textContent = t('searchPeak');

      if (!hits.length) {
        results.style.display = 'none';
        setStatus(t('peakNotFound'));
        setTimeout(() => setStatus(''), 3000);
        return;
      }
      if (hits.length === 1) {
        closeSearch();
        void goToHit(hits[0], origin);
        return;
      }
      await renderResults(results, hits, (hit) => {
        closeSearch();
        void goToHit(hit, origin);
      });
    };

    searchBtn.onclick = () => void runSearch();

    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') searchBtn.click();
      if (ev.key === 'Escape') cancelBtn.click();
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(searchBtn);
    searchOverlay.appendChild(input);
    searchOverlay.appendChild(btnRow);
    searchOverlay.appendChild(results);
    document.body.appendChild(searchOverlay);
    input.focus();
  };
}

/**
 * Список найденных вершин: название, высота и регион — без региона одинаковые
 * имена («Ostspitze», «Северная») ничем не различить.
 */
async function renderResults(
  container: HTMLElement,
  hits: SearchHit[],
  onPick: (hit: SearchHit) => void,
): Promise<void> {
  const { loadRegions, regionLabel } = await import('./ui/download');
  const regions = await loadRegions();
  container.textContent = '';
  container.style.display = 'flex';

  for (const hit of hits) {
    const row = document.createElement('button');
    row.style.cssText =
      'display:flex;flex-direction:column;align-items:flex-start;gap:2px;' +
      'background:#2b2d42;color:#f1faee;border:1px solid #415a77;border-radius:8px;' +
      'padding:8px 10px;font-size:13px;cursor:pointer;text-align:left;width:100%';
    row.onmouseenter = () => (row.style.background = '#3a3d5c');
    row.onmouseleave = () => (row.style.background = '#2b2d42');

    const title = document.createElement('span');
    const ele =
      hit.peak.ele !== undefined
        ? ` · ${Math.round(hit.peak.ele)} ${getLocale() === 'ru' ? 'м' : 'm'}`
        : '';
    title.textContent = `${peakName(hit.peak)}${ele}`;
    title.style.cssText = 'font-weight:500';

    const sub = document.createElement('span');
    const info = regions[hit.region];
    sub.textContent = info ? regionLabel(info) : hit.region;
    sub.style.cssText = 'opacity:0.7;font-size:12px';

    row.appendChild(title);
    row.appendChild(sub);
    row.onclick = () => onPick(hit);
    container.appendChild(row);
  }
}

/**
 * Переход к найденной вершине: при необходимости меняем регион и подтягиваем
 * его вершины (сеть → офлайн-кеш), затем сам перелёт.
 */
async function goToHit(hit: SearchHit, origin: LatLon): Promise<void> {
  if (hit.region !== currentRegion) {
    currentRegion = hit.region;
    manualRegion = true;
    setStatus(t('loadingRegion'));
    const base = import.meta.env.BASE_URL;
    let peaks: PeaksFile['peaks'] | null = null;
    const res = await fetch(`${base}peaks/${hit.region}.json`).catch(() => null);
    if (res && isJson(res)) {
      peaks = ((await res.json()) as PeaksFile).peaks;
    } else {
      const { getPeaks } = await import('./core/db');
      peaks = ((await getPeaks(hit.region)) ?? null) as PeaksFile['peaks'] | null;
    }
    if (peaks) {
      const { annotateIsolation } = await import('./core/peaks');
      annotateIsolation(peaks);
      currentPeaks = peaks;
    }
    // Вершины региона могли не загрузиться (офлайн) — перелёт всё равно делаем:
    // координаты у нас есть, панорама построится по DEM
  }
  jumpToPeak(hit.peak, origin);
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
 * Индекс (peaks/_index.json) покрывает всю планету, поэтому Казбек или
 * Эверест находятся, даже если их регион никогда не открывали.
 */
async function findPeaks(query: string): Promise<SearchHit[]> {
  const { searchPeaks, searchIndex, mergeHits, loadSearchIndex } = await import('./core/search');
  const groups: SearchHit[][] = [searchPeaks(query, currentPeaks, currentRegion)];

  // Скачанные регионы — работают офлайн
  const { getDownloadedRegions, getPeaks } = await import('./core/db');
  const downloaded = await getDownloadedRegions();
  for (const region of downloaded) {
    if (region === currentRegion) continue;
    const peaks = (await getPeaks(region)) as PeaksFile['peaks'] | undefined;
    if (peaks) groups.push(searchPeaks(query, peaks, region));
  }

  // Глобальный индекс — последним: свои данные полнее и приоритетнее
  const index = await loadSearchIndex(import.meta.env.BASE_URL);
  if (index.length) groups.push(searchIndex(query, index));

  return mergeHits(groups, lastOrigin);
}

/** Кнопка «Скачать для офлайна» в углу экрана */
function setupDownloadButton(origin: LatLon): void {
  const btn = makeButton('⬇', t('downloadRegion'), 'right:16px;bottom:16px');
  let busy = false;
  btn.onclick = async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    try {
      await downloadRegion(currentRegion, origin, (p: DownloadProgress) => {
        if (p.phase === 'peaks') {
          setStatus(t('downloadPeaks'));
        } else if (p.phase === 'tiles') {
          setStatus(`${t('downloadTiles')}: ${p.done}/${p.total}`);
        } else if (p.phase === 'done') {
          setStatus('');
          btn.textContent = '✓';
          setTimeout(() => (btn.textContent = '⬇'), 3000);
        }
      });
    } catch (err) {
      setStatus(`${t('error')}: ${err instanceof Error ? err.message : err}`);
      btn.textContent = '✗';
      setTimeout(() => (btn.textContent = '⬇'), 3000);
    } finally {
      busy = false;
      btn.disabled = false;
    }
  };
}

/** Фабрика круглых кнопок действий */
function makeButton(icon: string, title: string, pos: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = icon;
  btn.title = title;
  btn.style.cssText =
    `position:fixed;${pos};width:48px;height:48px;` +
    'border-radius:50%;border:none;background:#415a77;color:#f1faee;' +
    'font-size:20px;cursor:pointer;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.4);' +
    'display:flex;align-items:center;justify-content:center';
  document.body.appendChild(btn);
  return btn;
}

/** Экранный джойстик: перемещение по земле + сброс на GPS */
function setupNavPad(): void {
  const padSize = 120;
  const pad = document.createElement('div');
  pad.style.cssText =
    `position:fixed;left:16px;bottom:76px;width:${padSize}px;height:${padSize}px;` +
    'z-index:10;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);' +
    'gap:2px';
  document.body.appendChild(pad);

  const dirs = [
    { icon: '↖', az: -Math.PI * 0.75, label: 'Влево-назад' },
    { icon: '↑', az: 0, label: 'Вперёд' },
    { icon: '↗', az: Math.PI * 0.75, label: 'Вправо-вперёд' },
    { icon: '←', az: -Math.PI / 2, label: 'Влево' },
    { icon: '📍', az: 0, label: 'К GPS (и на землю)', action: 'gps' },
    { icon: '→', az: Math.PI / 2, label: 'Вправо' },
    { icon: '↙', az: -Math.PI * 1.25, label: 'Влево-назад' },
    { icon: '↓', az: Math.PI, label: 'Назад' },
    { icon: '↘', az: Math.PI * 1.25, label: 'Вправо-назад' },
  ];

  for (const d of dirs) {
    const btn = document.createElement('button');
    btn.textContent = d.icon;
    btn.title = d.label;
    btn.style.cssText =
      'border:none;border-radius:8px;background:#415a77;color:#f1faee;' +
      'font-size:16px;cursor:pointer;min-width:0;min-height:0';
    if (d.action === 'gps') {
      btn.onclick = () => {
        getPosition().then((pos) => {
          heightOverride = null; // возврат на землю в точке GPS
          requestCompute(pos);
        });
      };
    } else {
      btn.onclick = () => {
        const az = view.centerAzRad + d.az;
        requestCompute(destination(lastOrigin, az, MOVE_STEP_M));
      };
    }
    pad.appendChild(btn);
  }

  // Высота: вверх/вниз + индикатор
  const heightPad = document.createElement('div');
  heightPad.style.cssText =
    'position:fixed;left:16px;bottom:204px;z-index:10;display:flex;flex-direction:column;gap:4px;align-items:center';
  document.body.appendChild(heightPad);

  const upBtn = document.createElement('button');
  upBtn.textContent = '⬆';
  upBtn.title = 'Выше (+100 м)';
  upBtn.style.cssText =
    'border:none;border-radius:8px;background:#415a77;color:#f1faee;width:40px;height:32px;cursor:pointer';
  upBtn.onclick = () => adjustHeight(100);
  heightPad.appendChild(upBtn);

  const heightLabel = document.createElement('div');
  heightLabel.id = 'height-indicator';
  heightLabel.style.cssText =
    'background:rgba(13,27,42,0.8);color:#f1faee;border-radius:6px;padding:2px 8px;font-size:12px;font-family:system-ui';
  heightLabel.textContent = `${Math.round(lastObserverH)} м`;
  heightPad.appendChild(heightLabel);

  const downBtn = document.createElement('button');
  downBtn.textContent = '⬇';
  downBtn.title = 'Ниже (−100 м)';
  downBtn.style.cssText =
    'border:none;border-radius:8px;background:#415a77;color:#f1faee;width:40px;height:32px;cursor:pointer';
  downBtn.onclick = () => adjustHeight(-100);
  heightPad.appendChild(downBtn);
}

/** Текущая высота наблюдателя (из DEM) */
let lastObserverH = 0;

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
}

/** Изменение высоты наблюдателя (пересчёт панорамы) */
function adjustHeight(deltaM: number): void {
  heightOverride = (heightOverride ?? lastObserverH) + deltaM;
  const el = document.getElementById('height-indicator');
  if (el) el.textContent = `${Math.round(heightOverride)} м`;
  requestCompute(lastOrigin);
}

/** Кнопки AR и фото (появляются после первого расчёта панорамы) */
function setupActionButtons(origin: LatLon, observerH: number): void {
  // Вызывается на каждый результат воркера — но кнопки нужны одни
  if (actionButtonsReady) return;
  actionButtonsReady = true;
  // Настройки (⚙) — выбор региона, язык, сброс оффсета
  const settingsBtn = makeButton('⚙', t('settings'), 'left:16px;top:16px');
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
        // Перезагружаем панораму с новым регионом
        main();
      },
      onLocaleChange: () => {
        // Перерисовываем интерфейс
        draw();
      },
      onClose: () => {
        settingsClose = null;
      },
    });
  };

  // AR-режим
  let arStop: (() => void) | null = null;
  const arBtn = makeButton('📷', t('arMode'), 'right:16px;bottom:76px');
  arBtn.onclick = async () => {
    if (arStop) {
      arStop();
      arStop = null;
      arBtn.style.background = '#415a77';
      return;
    }
    if (!panorama) return;
    try {
      const { startAr } = await import('./ui/ar');
      const video = document.createElement('video');
      video.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1';
      document.body.prepend(video);
      arStop = await startAr(video, canvas, panorama, view);
      arBtn.style.background = '#e63946';
    } catch (err) {
      setStatus(`${t('error')}: ${err instanceof Error ? err.message : err}`);
    }
  };

  // Фото с подписями
  const photoBtn = makeButton('📸', t('photo'), 'right:16px;bottom:136px');
  photoBtn.onclick = async () => {
    if (!panorama) return;
    const { capturePhoto, sharePhoto } = await import('./ui/photo');
    const blob = await capturePhoto(panorama, view, {
      origin,
      observerH,
      region: currentRegion,
    });
    await sharePhoto(blob);
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
