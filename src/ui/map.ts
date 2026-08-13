/**
 * Карта OpenStreetMap: где я стою, куда смотрю и куда хочу перенестись.
 *
 * Свой слippy-map на полторы сотни строк вместо библиотеки: нужен ровно
 * растровый слой, перетаскивание, зум и маркер — Leaflet ради этого тянуть
 * не хочется, а тайловая математика в проекте уже есть (terrarium.ts).
 *
 * Тайлы — стандартные OSM: политика использования требует атрибуции и
 * умеренных объёмов, поэтому кешировать их в Service Worker мы не стали.
 */

import type { LatLon } from '../core/geo';
import { t, getLocale } from '../core/i18n';

const TILE_PX = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 17;
const OSM_TILES = 'https://tile.openstreetmap.org';

/** lon/lat → пиксели мира на зуме z (Web Mercator) */
function project(pos: LatLon, zoom: number): { x: number; y: number } {
  const scale = TILE_PX * 2 ** zoom;
  const lat = Math.max(-85.0511, Math.min(85.0511, pos.lat));
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((pos.lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

/** Пиксели мира → lon/lat */
function unproject(x: number, y: number, zoom: number): LatLon {
  const scale = TILE_PX * 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - 2 * Math.PI * (y / scale);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon };
}

export interface MapOptions {
  /** Где мы сейчас стоим */
  origin: LatLon;
  /** Азимут центра взгляда, рад (0 — север, по часовой) */
  headingRad: number;
  /** Перенос в выбранную точку */
  onPick: (pos: LatLon) => void;
}

/** Открывает карту поверх панорамы. Возвращает функцию закрытия. */
export function openMap(options: MapOptions): () => void {
  let zoom = 11;
  let center: LatLon = { ...options.origin };

  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;z-index:70;background:#1a1a2e;overflow:hidden;' +
    'touch-action:none;user-select:none';

  // Слой тайлов: двигаем его целиком, тайлы позиционируются внутри
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0;overflow:hidden';
  root.appendChild(layer);

  const tiles = new Map<string, HTMLImageElement>();

  /** Перерисовка слоя под текущий центр и зум */
  const render = (): void => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    const c = project(center, zoom);
    const left = c.x - w / 2;
    const top = c.y - h / 2;
    const maxTile = 2 ** zoom;

    const x0 = Math.floor(left / TILE_PX);
    const y0 = Math.floor(top / TILE_PX);
    const x1 = Math.ceil((left + w) / TILE_PX);
    const y1 = Math.ceil((top + h) / TILE_PX);

    const alive = new Set<string>();
    for (let ty = y0; ty < y1; ty++) {
      if (ty < 0 || ty >= maxTile) continue;
      for (let tx = x0; tx < x1; tx++) {
        // По долготе мир замкнут — заворачиваем индекс
        const wrapped = ((tx % maxTile) + maxTile) % maxTile;
        const key = `${zoom}/${wrapped}/${ty}`;
        alive.add(key + `@${tx}`);
        let img = tiles.get(key + `@${tx}`);
        if (!img) {
          img = document.createElement('img');
          img.src = `${OSM_TILES}/${zoom}/${wrapped}/${ty}.png`;
          img.alt = '';
          img.loading = 'eager';
          img.draggable = false;
          img.style.cssText =
            `position:absolute;width:${TILE_PX}px;height:${TILE_PX}px;` +
            'pointer-events:none;image-rendering:auto;z-index:0';
          layer.appendChild(img);
          tiles.set(key + `@${tx}`, img);
        }
        img.style.left = `${tx * TILE_PX - left}px`;
        img.style.top = `${ty * TILE_PX - top}px`;
      }
    }
    // Убираем уехавшие тайлы, иначе их накапливаются тысячи
    for (const [key, img] of tiles) {
      if (!alive.has(key)) {
        img.remove();
        tiles.delete(key);
      }
    }

    // Маркер «я» — только если попадает в кадр
    const me = project(options.origin, zoom);
    marker.style.left = `${me.x - left}px`;
    marker.style.top = `${me.y - top}px`;

    coords.textContent = `${center.lat.toFixed(4)}, ${center.lon.toFixed(4)}`;
  };

  // Маркер: точка + сектор направления взгляда. z-index обязателен: тайлы
  // добавляются в слой позже и без него перекрыли бы маркер
  const marker = document.createElement('div');
  marker.style.cssText =
    'position:absolute;width:0;height:0;pointer-events:none;z-index:1';
  const cone = document.createElement('div');
  // Сектор обзора: треугольник вершиной в точке наблюдателя, повёрнутый по
  // азимуту взгляда. Полупрозрачный к дальнему краю — «докуда смотрим»
  cone.style.cssText =
    'position:absolute;left:-30px;top:-64px;width:60px;height:64px;' +
    'clip-path:polygon(50% 100%, 4% 0%, 96% 0%);' +
    'background:linear-gradient(to top, rgba(76,201,240,.85), rgba(76,201,240,.15));' +
    'filter:drop-shadow(0 0 2px rgba(0,0,0,.6));' +
    `transform-origin:50% 100%;transform:rotate(${(options.headingRad * 180) / Math.PI}deg)`;
  const dot = document.createElement('div');
  dot.style.cssText =
    'position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;' +
    'background:#4cc9f0;border:2px solid #0d1b2a;box-shadow:0 0 0 1px #4cc9f0';
  marker.append(cone, dot);
  layer.appendChild(marker);

  // Перекрестие центра — точка, куда перенесёмся
  const cross = document.createElement('div');
  cross.style.cssText =
    'position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;' +
    'pointer-events:none;border:2px solid #f1faee;border-radius:50%;' +
    'box-shadow:0 0 0 2px rgba(0,0,0,.5), inset 0 0 0 2px rgba(0,0,0,.5)';
  root.appendChild(cross);

  // --- Управление ---
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  root.addEventListener('pointerdown', (ev) => {
    if ((ev.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    root.setPointerCapture(ev.pointerId);
  });
  root.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const c = project(center, zoom);
    center = unproject(c.x - (ev.clientX - lastX), c.y - (ev.clientY - lastY), zoom);
    lastX = ev.clientX;
    lastY = ev.clientY;
    render();
  });
  const endDrag = (): void => {
    dragging = false;
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  root.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      setZoom(zoom + (ev.deltaY < 0 ? 1 : -1));
    },
    { passive: false },
  );

  function setZoom(next: number): void {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    if (clamped === zoom) return;
    zoom = clamped;
    // Тайлы другого зума — другие ключи, старые убираем целиком
    for (const img of tiles.values()) img.remove();
    tiles.clear();
    render();
  }

  // --- Кнопки ---
  const button = (label: string, css: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'position:absolute;z-index:2;border:1px solid #415a77;border-radius:10px;' +
      'background:rgba(26,26,46,.92);color:#f1faee;font:15px system-ui,sans-serif;' +
      `cursor:pointer;${css}`;
    b.onclick = onClick;
    root.appendChild(b);
    return b;
  };

  const close = (): void => {
    root.remove();
  };

  button('✕', 'left:16px;top:16px;width:44px;height:44px;font-size:18px', close);
  button('＋', 'right:16px;top:16px;width:44px;height:44px;font-size:20px', () =>
    setZoom(zoom + 1),
  );
  button('−', 'right:16px;top:68px;width:44px;height:44px;font-size:22px', () =>
    setZoom(zoom - 1),
  );
  button('📍', 'left:16px;top:68px;width:44px;height:44px', () => {
    center = { ...options.origin };
    render();
  }).title = t('mapMyPosition');

  const go = button(
    t('mapGoHere'),
    'left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);' +
      'padding:13px 22px;font-weight:600;background:#4cc9f0;color:#1a1a2e;border-color:#4cc9f0',
    () => {
      options.onPick({ ...center });
      close();
    },
  );
  go.style.whiteSpace = 'nowrap';

  // Координаты центра и обязательная атрибуция OSM
  const coords = document.createElement('div');
  coords.style.cssText =
    'position:absolute;left:50%;bottom:calc(76px + env(safe-area-inset-bottom));' +
    'transform:translateX(-50%);z-index:2;background:rgba(26,26,46,.85);' +
    'border-radius:8px;padding:4px 10px;font:13px system-ui,sans-serif;color:#f1faee';
  root.appendChild(coords);

  const attribution = document.createElement('div');
  attribution.style.cssText =
    'position:absolute;right:0;bottom:0;z-index:2;background:rgba(26,26,46,.8);' +
    'padding:2px 6px;font:11px system-ui,sans-serif;color:#cfd8dc';
  attribution.innerHTML =
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" ' +
    'rel="noreferrer" style="color:#4cc9f0">OpenStreetMap</a>';
  root.appendChild(attribution);

  const hint = document.createElement('div');
  hint.textContent = getLocale() === 'ru' ? 'Ведите карту — центр станет новой точкой' : 'Pan the map — the centre becomes your new spot';
  hint.style.cssText =
    'position:absolute;left:50%;top:16px;transform:translateX(-50%);z-index:2;' +
    'background:rgba(26,26,46,.85);border-radius:8px;padding:6px 12px;' +
    'font:13px system-ui,sans-serif;color:#cfd8dc;max-width:calc(100vw - 160px);text-align:center';
  root.appendChild(hint);
  setTimeout(() => hint.remove(), 4000);

  document.body.appendChild(root);
  render();
  new ResizeObserver(render).observe(root);

  return close;
}
