/**
 * Точка входа. MVP-цикл: загрузка региона → позиция → горизонт из worker →
 * рендер панорамы; поворот пальцем (fallback без сенсоров, ROADMAP 2.2).
 */

import { renderPanorama, type PanoramaState, type ViewState } from './ui/panorama';
import type { PeaksFile } from './core/peaks';
import { toRad, type LatLon } from './core/geo';
import { t } from './core/i18n';
import { downloadRegion, type DownloadProgress } from './ui/download';
import type { ResultMessage, WorkerOutMessage } from './workers/horizon.worker';

const REGION = 'elbrus';

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

// --- Поворот пальцем / мышью (fallback-режим, работает без сенсоров) ---
// Влево-вправо — азимут, вверх-вниз — наклон; диагональ = оба сразу
let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.addEventListener('pointerdown', (ev) => {
  dragging = true;
  lastX = ev.clientX;
  lastY = ev.clientY;
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointermove', (ev) => {
  if (!dragging) return;
  const dx = ev.clientX - lastX;
  const dy = ev.clientY - lastY;
  lastX = ev.clientX;
  lastY = ev.clientY;
  view.centerAzRad -= (dx / canvas.clientWidth) * view.fovRad;
  view.tiltRad = Math.max(
    -MAX_TILT,
    Math.min(MAX_TILT, view.tiltRad + (dy / canvas.clientHeight) * view.fovVRad),
  );
  draw();
});
canvas.addEventListener('pointerup', () => (dragging = false));

// --- Ориентация устройства (сенсоры + ручная подстройка) ---
import { orientationTracker } from './core/orientation';

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
  panorama = { horizon: r.horizon, stepRad: r.stepRad, peaks: r.peaks };
  setStatus('');
  draw();
  console.info(
    `Горизонт: ${r.horizon.length} лучей, ${r.peaks.length} пиков, ` +
      `наблюдатель ${r.observerH.toFixed(0)} м, ${r.computeMs.toFixed(0)} мс`,
  );
};

async function main(): Promise<void> {
  setStatus(t('loadingRegion'));

  const base = import.meta.env.BASE_URL;

  // Пики: сеть → офлайн-кеш (IndexedDB). Без них панорама всё равно строится.
  // Vite на 404 отдаёт index.html (SPA-fallback) — проверяем Content-Type.
  let peaks: PeaksFile['peaks'] = [];
  const peaksRes = await fetch(`${base}peaks/${REGION}.json`).catch(() => null);
  if (peaksRes && isJson(peaksRes)) {
    peaks = ((await peaksRes.json()) as PeaksFile).peaks;
  } else {
    const { getPeaks } = await import('./core/db');
    peaks = ((await getPeaks(REGION)) ?? []) as PeaksFile['peaks'];
  }

  // Локальный DEM-патч — если сгенерирован; иначе глобальный Terrarium
  // (docs/new-geo-data.md, слой 1). Офлайн: Terrarium из IndexedDB.
  let patchBaseUrl: string | undefined;
  const patchProbe = await fetch(`${base}tiles/${REGION}/index.json`).catch(() => null);
  if (patchProbe && isJson(patchProbe)) patchBaseUrl = `${base}tiles/${REGION}`;

  worker.postMessage({ type: 'init', patchBaseUrl });

  // Позиция: GPS, fallback — Приют 11 (контрольная точка MVP-ACCEPTANCE)
  const origin = await getPosition();
  setStatus(t('computing'));
  worker.postMessage({ type: 'compute', origin, peaks });

  // Кнопка офлайн-загрузки региона (появляется после первого расчёта)
  setupDownloadButton(origin);
}

/** Кнопка «Скачать для офлайна» в углу экрана */
function setupDownloadButton(origin: LatLon): void {
  const btn = document.createElement('button');
  btn.id = 'download-btn';
  btn.textContent = '⬇';
  btn.title = t('downloadRegion');
  btn.style.cssText =
    'position:fixed;right:16px;bottom:16px;width:48px;height:48px;' +
    'border-radius:50%;border:none;background:#415a77;color:#f1faee;' +
    'font-size:22px;cursor:pointer;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.4)';
  document.body.appendChild(btn);

  let busy = false;
  btn.onclick = async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    try {
      await downloadRegion(REGION, origin, (p: DownloadProgress) => {
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
