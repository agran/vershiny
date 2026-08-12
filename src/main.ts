/**
 * Точка входа. MVP-цикл: загрузка региона → позиция → горизонт из worker →
 * рендер панорамы; поворот пальцем (fallback без сенсоров, ROADMAP 2.2).
 */

import { renderPanorama, type PanoramaState, type ViewState } from './ui/panorama';
import type { Peak, PeaksFile } from './core/peaks';
import { toRad, type LatLon } from './core/geo';
import { t } from './core/i18n';
import { downloadRegion, type DownloadProgress } from './ui/download';
import type { ResultMessage, WorkerOutMessage } from './workers/horizon.worker';

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

function resize(): void {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
}
new ResizeObserver(resize).observe(canvas);
resize();

const view: ViewState = {
  centerAzRad: 0,
  tiltRad: 0,
  fovRad: toRad(60),
  fovVRad: toRad(25),
};

/** Предел наклона камеры, рад */
const MAX_TILT = toRad(45);

let panorama: PanoramaState | null = null;

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
      lastOrigin = newPos;
      worker.postMessage({ type: 'compute', origin: newPos, peaks: currentPeaks });
      setStatus(t('computing'));
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
  lastOrigin = newPos;
  worker.postMessage({ type: 'compute', origin: newPos, peaks: currentPeaks });
  setStatus(t('computing'));
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
  lastOrigin = newPos;
  setStatus(t('computing'));
  worker.postMessage({ type: 'compute', origin: newPos, peaks: currentPeaks });
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
const worker = new Worker(new URL('./workers/horizon.worker.ts', import.meta.url), {
  type: 'module',
});

worker.onmessage = (ev: MessageEvent<WorkerOutMessage>) => {
  const msg = ev.data;
  if (msg.type === 'error') {
    setStatus(`${t('error')}: ${msg.message}`);
    return;
  }
  const r = msg as ResultMessage;
  panorama = {
    horizon: r.horizon,
    stepRad: r.stepRad,
    peaks: r.peaks,
    layers: r.layers,
    distanceToHorizonM: r.distanceToHorizonM,
  };
  setStatus('');
  draw();
  // Кнопки AR/фото — после первого результата
  setupActionButtons(lastOrigin, r.observerH);
  console.info(
    `Горизонт: ${r.horizon.length} лучей, ${r.peaks.length} пиков, ` +
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
  currentPeaks = peaks; // сохраняем для навигации

  // Локальный DEM-патч — если сгенерирован; иначе глобальный Terrarium
  // (docs/new-geo-data.md, слой 1). Офлайн: Terrarium из IndexedDB.
  let patchBaseUrl: string | undefined;
  const patchProbe = await fetch(`${base}tiles/${currentRegion}/index.json`).catch(() => null);
  if (patchProbe && isJson(patchProbe)) patchBaseUrl = `${base}tiles/${currentRegion}`;

  worker.postMessage({ type: 'init', patchBaseUrl });

  setStatus(t('computing'));
  worker.postMessage({ type: 'compute', origin, peaks });

  // Кнопки действий (появляются после первого расчёта)
  setupDownloadButton(origin);
  setupSearchButton(origin);
}

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
    cancelBtn.onclick = () => {
      searchOverlay?.remove();
      searchOverlay = null;
    };

    const searchBtn = document.createElement('button');
    searchBtn.textContent = t('searchPeak');
    searchBtn.style.cssText =
      'background:#4cc9f0;color:#1a1a2e;border:none;border-radius:8px;' +
      'padding:8px 16px;font-size:14px;cursor:pointer;font-weight:500';
    searchBtn.onclick = () => {
      const query = input.value.trim();
      if (!query) return;
      const peak = findPeakByName(query, currentPeaks);
      searchOverlay?.remove();
      searchOverlay = null;
      if (!peak) {
        setStatus(t('peakNotFound'));
        setTimeout(() => setStatus(''), 3000);
        return;
      }
      jumpToPeak(peak, origin);
    };

    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') searchBtn.click();
      if (ev.key === 'Escape') cancelBtn.click();
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(searchBtn);
    searchOverlay.appendChild(input);
    searchOverlay.appendChild(btnRow);
    document.body.appendChild(searchOverlay);
    input.focus();
  };
}

/** Переход к вершине: точка в 5 км, взгляд на неё */
async function jumpToPeak(peak: Peak, from: LatLon): Promise<void> {
  const distToPeak = 5000; // 5 км
  const azToPeak = Math.atan2(peak.lon - from.lon, peak.lat - from.lat);
  const backAz = azToPeak + Math.PI;
  const { destination } = await import('./core/geo');
  const viewPos = destination({ lat: peak.lat, lon: peak.lon }, backAz, distToPeak);
  lastOrigin = viewPos;
  setStatus(t('computing'));
  worker.postMessage({ type: 'compute', origin: viewPos, peaks: currentPeaks });
  view.centerAzRad = azToPeak;
  draw();
}

/** Поиск вершины по имени (частичное совпадение, без учёта регистра) */
function findPeakByName(query: string, peaks: PeaksFile['peaks']): Peak | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  // Точное совпадение по name/name_ru/name_en
  for (const p of peaks) {
    if (
      p.name.toLowerCase() === q ||
      p.name_ru?.toLowerCase() === q ||
      p.name_en?.toLowerCase() === q
    ) {
      return p;
    }
  }
  // Частичное совпадение
  for (const p of peaks) {
    if (
      p.name.toLowerCase().includes(q) ||
      p.name_ru?.toLowerCase().includes(q) ||
      p.name_en?.toLowerCase().includes(q)
    ) {
      return p;
    }
  }
  return null;
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

/** Кнопки AR и фото (появляются после первого расчёта панорамы) */
function setupActionButtons(origin: LatLon, observerH: number): void {
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
