/**
 * Точка входа. MVP-цикл: загрузка региона → позиция → горизонт из worker →
 * рендер панорамы; поворот пальцем (fallback без сенсоров, ROADMAP 2.2).
 */

import { renderPanorama, type PanoramaState, type ViewState } from './ui/panorama';
import type { PeaksFile } from './core/peaks';
import { toRad, type LatLon } from './core/geo';
import type { ResultMessage, WorkerOutMessage } from './workers/horizon.worker';

const REGION = 'elbrus';

const statusEl = document.getElementById('status')!;
const appEl = document.getElementById('app')!;

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
  fovRad: toRad(60),
  fovVRad: toRad(25),
};

let panorama: PanoramaState | null = null;

function draw(): void {
  if (!panorama) return;
  renderPanorama(ctx, panorama, view);
}

// --- Поворот пальцем / мышью (fallback-режим, работает без сенсоров) ---
let dragging = false;
let lastX = 0;
canvas.addEventListener('pointerdown', (ev) => {
  dragging = true;
  lastX = ev.clientX;
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointermove', (ev) => {
  if (!dragging) return;
  const dx = ev.clientX - lastX;
  lastX = ev.clientX;
  view.centerAzRad -= (dx / canvas.clientWidth) * view.fovRad;
  draw();
});
canvas.addEventListener('pointerup', () => (dragging = false));

// --- Worker горизонта ---
const worker = new Worker(new URL('./workers/horizon.worker.ts', import.meta.url), {
  type: 'module',
});

worker.onmessage = (ev: MessageEvent<WorkerOutMessage>) => {
  const msg = ev.data;
  if (msg.type === 'error') {
    setStatus(`Ошибка: ${msg.message}`);
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
  setStatus('Загрузка региона…');

  const base = import.meta.env.BASE_URL;

  // Пики региона — опционально; без них панорама всё равно строится.
  // Vite на 404 отдаёт index.html (SPA-fallback) — проверяем Content-Type.
  let peaks: PeaksFile['peaks'] = [];
  const peaksRes = await fetch(`${base}peaks/${REGION}.json`);
  if (isJson(peaksRes)) {
    peaks = ((await peaksRes.json()) as PeaksFile).peaks;
  }

  // Локальный DEM-патч — если сгенерирован; иначе глобальный Terrarium
  // (docs/new-geo-data.md, слой 1)
  let patchBaseUrl: string | undefined;
  const patchProbe = await fetch(`${base}tiles/${REGION}/index.json`);
  if (isJson(patchProbe)) patchBaseUrl = `${base}tiles/${REGION}`;

  worker.postMessage({ type: 'init', patchBaseUrl });

  // Позиция: GPS, fallback — Приют 11 (контрольная точка MVP-ACCEPTANCE)
  const origin = await getPosition();
  setStatus('Расчёт панорамы…');
  worker.postMessage({ type: 'compute', origin, peaks });
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
