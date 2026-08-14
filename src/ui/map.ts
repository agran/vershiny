/**
 * Карта OpenStreetMap: где я стою, куда смотрю и куда хочу перенестись.
 *
 * Свой слippy-map на полторы сотни строк вместо библиотеки: нужен ровно
 * растровый слой, перетаскивание, зум и маркер — Leaflet ради этого тянуть
 * не хочется, а тайловая математика в проекте уже есть (terrarium.ts).
 *
 * Тайлы — OpenTopoMap: рельеф, вершины с высотами и тропы; подписи на
 * местном языке (в России — кириллица). Требует атрибуции, поэтому
 * кешировать тайлы в Service Worker мы не стали.
 */

import type { LatLon } from "../core/geo";
import { normalizeAz } from "../core/geo";
import { getLocale, peakName, t } from "../core/i18n";
import type { SearchHit } from "../core/search";
import { ICON_CLOSE, ICON_HEADING, ICON_LOCATE, ICON_SEARCH } from "./icons";
import { pushOverlay } from "./overlay-history";

const TILE_PX = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 17;
/** Поддомены OpenTopoMap — по x+y, чтобы браузер качал тайлы параллельно */
const TOPO_SUBS = ["a", "b", "c"];
const TOPO_BASE = "tile.opentopomap.org";

/** Тайл OpenTopoMap: рельеф, вершины с высотами, тропы */
function topoTileUrl(zoom: number, x: number, y: number): string {
  const sub = TOPO_SUBS[(x + y) % TOPO_SUBS.length];
  return `https://${sub}.${TOPO_BASE}/${zoom}/${x}/${y}.png`;
}

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
  /** Поиск вершины по названию (по всей планете) */
  search: (query: string) => Promise<SearchHit[]>;
  /**
   * Перелёт к найденной вершине.
   *
   * Возвращает подобранную точку обзора — карта остаётся открытой и
   * показывает её вместе с самой вершиной: положение и направление можно
   * поправить и только потом уходить к контурам. `null` — точку подобрать
   * не удалось (нет данных, обрыв сети).
   */
  onPickPeak: (
    hit: SearchHit,
  ) => Promise<{ origin: LatLon; headingRad: number } | null>;
  /** Название региона для строки результата */
  regionTitle: (region: string) => string;
  /**
   * Направление взгляда изменили ручкой на маркере.
   *
   * Вызывается по ходу поворота, а не при закрытии: карту закрывают
   * по-разному (крестик, Escape, «Перенестись сюда»), и собирать выбор в
   * каждом из выходов — верный способ его где-нибудь потерять.
   */
  onHeading?: (rad: number) => void;
  /** Карта закрылась сама (крестик, Escape) — владелец кнопки должен знать */
  onClose?: () => void;
}

/** Открывает карту поверх панорамы. Возвращает функцию закрытия. */
export function openMap(options: MapOptions): () => void {
  let zoom = 11;
  let center: LatLon = { ...options.origin };

  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;inset:0;z-index:70;background:#1a1a2e;overflow:hidden;" +
    "touch-action:none;user-select:none";

  // Слой тайлов: двигаем его целиком, тайлы позиционируются внутри
  const layer = document.createElement("div");
  layer.style.cssText = "position:absolute;inset:0;overflow:hidden";
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
          img = document.createElement("img");
          img.src = topoTileUrl(zoom, wrapped, ty);
          img.alt = "";
          img.loading = "eager";
          img.draggable = false;
          // Не загрузился (офлайн, лимит OSM) — прячем: «битая картинка»
          // поверх карты хуже, чем просто пустая клетка
          img.onerror = () => {
            img!.style.visibility = "hidden";
          };
          img.style.cssText =
            `position:absolute;width:${TILE_PX}px;height:${TILE_PX}px;` +
            "pointer-events:none;image-rendering:auto;z-index:0";
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

    // Маркер «я»: за границей кадра его просто не видно — слой обрезан
    const me = project(observer, zoom);
    marker.style.left = `${me.x - left}px`;
    marker.style.top = `${me.y - top}px`;

    // Вершина, к которой подбиралась точка обзора: с ней понятно, что
    // именно правишь, когда двигаешь наблюдателя или крутишь сектор
    if (target) {
      const at = project(target.pos, zoom);
      targetEl.style.display = "flex";
      targetEl.style.left = `${at.x - left}px`;
      targetEl.style.top = `${at.y - top}px`;
    } else {
      targetEl.style.display = "none";
    }

    coords.textContent = `${center.lat.toFixed(4)}, ${center.lon.toFixed(4)}`;
  };

  /** Где стоит наблюдатель: сдвигается при выборе вершины в поиске */
  let observer: LatLon = { ...options.origin };
  /** Вершина, ради которой подбиралась точка обзора */
  let target: { pos: LatLon; name: string } | null = null;

  // Метка вершины: треугольник с подписью. Появляется после выбора в поиске
  const targetEl = document.createElement("div");
  targetEl.style.cssText =
    "position:absolute;display:none;align-items:center;gap:6px;z-index:1;" +
    "pointer-events:none;transform:translate(-7px,-7px)";
  const targetDot = document.createElement("div");
  targetDot.style.cssText =
    "width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;" +
    "border-bottom:12px solid #e63946;filter:drop-shadow(0 0 2px rgba(0,0,0,.8));flex:none";
  const targetName = document.createElement("span");
  targetName.style.cssText =
    "background:rgba(26,26,46,.85);border-radius:6px;padding:2px 6px;white-space:nowrap;" +
    "font:12px system-ui,sans-serif;color:#f1faee";
  targetEl.append(targetDot, targetName);
  layer.appendChild(targetEl);

  // Маркер: точка + сектор направления взгляда. z-index обязателен: тайлы
  // добавляются в слой позже и без него перекрыли бы маркер
  const marker = document.createElement("div");
  marker.style.cssText =
    "position:absolute;width:0;height:0;pointer-events:none;z-index:1";
  const cone = document.createElement("div");
  // Сектор обзора: треугольник вершиной в точке наблюдателя, повёрнутый по
  // азимуту взгляда. Полупрозрачный к дальнему краю — «докуда смотрим»
  cone.style.cssText =
    "position:absolute;left:-30px;top:-64px;width:60px;height:64px;" +
    "clip-path:polygon(50% 100%, 4% 0%, 96% 0%);" +
    "background:linear-gradient(to top, rgba(76,201,240,.85), rgba(76,201,240,.15));" +
    "filter:drop-shadow(0 0 2px rgba(0,0,0,.6));" +
    "transform-origin:50% 100%";
  const dot = document.createElement("div");
  dot.style.cssText =
    "position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;" +
    "background:#4cc9f0;border:2px solid #0d1b2a;box-shadow:0 0 0 1px #4cc9f0";

  /**
   * Ручка направления — кружок на конце сектора.
   *
   * Тянуть сам сектор было бы естественнее, но он узкий у вершины и
   * полупрозрачный: пальцем в него не попасть, а промах уводит карту вбок.
   * Отдельный кружок в 32 px попадается сразу и не мешает панорамированию.
   */
  const handle = document.createElement("div");
  handle.dataset.role = "heading";
  handle.title = t("mapHeading");
  handle.style.cssText =
    "position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;" +
    "pointer-events:auto;cursor:grab;touch-action:none;z-index:2;" +
    "background:#4cc9f0;border:2px solid #0d1b2a;box-shadow:0 2px 6px rgba(0,0,0,.5);" +
    "display:flex;align-items:center;justify-content:center;color:#0d1b2a";
  handle.innerHTML = ICON_HEADING;

  marker.append(cone, handle, dot);
  layer.appendChild(marker);

  /** Направление взгляда, рад: 0 — север, по часовой (как на панораме) */
  let heading = options.headingRad;

  const applyHeading = (): void => {
    const deg = (heading * 180) / Math.PI;
    cone.style.transform = `rotate(${deg}deg)`;
    // Кружок уезжает на конец сектора вместе со стрелкой: стрелка смотрит
    // туда же, куда взгляд, — иначе она указывала бы на север при любом
    // повороте и спорила бы с самим сектором
    handle.style.transform = `rotate(${deg}deg) translateY(-78px)`;
  };
  applyHeading();

  // Перекрестие центра — точка, куда перенесёмся
  const cross = document.createElement("div");
  cross.style.cssText =
    "position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;" +
    "pointer-events:none;border:2px solid #f1faee;border-radius:50%;" +
    "box-shadow:0 0 0 2px rgba(0,0,0,.5), inset 0 0 0 2px rgba(0,0,0,.5)";
  root.appendChild(cross);

  // --- Управление ---
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  /**
   * Поворот сектора: тянем ручку вокруг точки наблюдателя.
   *
   * Азимут считается от центра маркера к пальцу: экранные оси — x вправо,
   * y вниз, север на карте вверху, поэтому вперёд — это −y.
   */
  let rotating = false;
  handle.addEventListener("pointerdown", (ev) => {
    // Иначе карта примет нажатие за начало перетаскивания и уедет вбок
    ev.stopPropagation();
    rotating = true;
    handle.style.cursor = "grabbing";
    try {
      handle.setPointerCapture(ev.pointerId);
    } catch {
      // Синтетические события без pointerId (тесты) — работаем без захвата
    }
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!rotating) return;
    ev.stopPropagation();
    // Маркер — точка нулевого размера, его прямоугольник и есть наблюдатель
    const at = marker.getBoundingClientRect();
    const dx = ev.clientX - at.left;
    const dy = ev.clientY - at.top;
    // У самого центра направление не определено: рывок на 180° при
    // проходе через точку выглядел бы поломкой
    if (Math.hypot(dx, dy) < 12) return;
    heading = normalizeAz(Math.atan2(dx, -dy));
    applyHeading();
    options.onHeading?.(heading);
  });
  const endRotate = (): void => {
    rotating = false;
    handle.style.cursor = "grab";
  };
  handle.addEventListener("pointerup", endRotate);
  handle.addEventListener("pointercancel", endRotate);

  root.addEventListener("pointerdown", (ev) => {
    // Проверять tagName самой цели нельзя: у кнопки с иконкой цель — <path>
    // внутри <svg>, а не <button>. Промах здесь стоил кнопки «Закрыть»: карта
    // захватывала указатель (setPointerCapture), и click уходил ей, а не
    // кнопке. Текстовые «＋» и «−» при этом работали — оттого и «часто».
    if (
      (ev.target as HTMLElement).closest(
        'button, input, a, [data-role="heading"]',
      )
    )
      return;
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    root.setPointerCapture(ev.pointerId);
  });
  root.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const c = project(center, zoom);
    const nextCenter = unproject(
      c.x - (ev.clientX - lastX),
      c.y - (ev.clientY - lastY),
      zoom,
    );
    center = nextCenter;
    observer = { ...nextCenter };
    lastX = ev.clientX;
    lastY = ev.clientY;
    render();
  });
  const endDrag = (): void => {
    dragging = false;
  };
  root.addEventListener("pointerup", endDrag);
  root.addEventListener("pointercancel", endDrag);

  root.addEventListener(
    "wheel",
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
  const button = (
    label: string,
    css: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    if (label.startsWith("<svg")) b.innerHTML = label;
    else b.textContent = label;
    b.style.cssText =
      "position:absolute;z-index:2;border:1px solid #415a77;border-radius:10px;" +
      "background:rgba(26,26,46,.92);color:#f1faee;font:15px system-ui,sans-serif;" +
      `cursor:pointer;display:flex;align-items:center;justify-content:center;${css}`;
    // Вызываем без аргументов: иначе обработчику прилетает MouseEvent, и
    // функция с необязательным параметром (как `close(commit)`) принимает
    // событие за истинный флаг
    b.onclick = () => onClick();
    root.appendChild(b);
    return b;
  };

  // Объявлен до close(): создаётся он в конце, когда корень уже в DOM
  let resizeObserver: ResizeObserver | null = null;
  /** Отписка от отслеживания размера: для ResizeObserver и запасного resize */
  let stopResize: (() => void) | null = null;

  // Системный «назад» на телефоне должен закрывать карту, а не приложение
  const releaseBack = pushOverlay(() => close());

  /**
   * Закрытие карты.
   *
   * `commit` ставится только «Применить»: крестик и Escape — это отказ.
   * Обработчики оборачиваются в стрелку осознанно: `onclick = close` передавал
   * бы в первый аргумент `MouseEvent`, а он истинный — и «Закрыть» переносило
   * наблюдателя в центр перекрестия ровно так же, как «Применить».
   */
  const close = (commit = false): void => {
    if (commit) {
      options.onPick({ ...observer });
    }
    closeSearch(); // снимаем с истории и вложенный слой поиска
    releaseBack();
    root.remove();
    document.removeEventListener("keydown", onKey);
    // Наблюдатель держал бы ссылку на удалённый корень карты после каждого
    // открытия
    stopResize?.();
    resizeObserver = null;
    options.onClose?.();
  };

  // Escape закрывает карту: привычно и спасает, если кнопка ушла под вырез
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && panel.style.display === "none") close();
  };
  document.addEventListener("keydown", onKey);

  button(ICON_CLOSE, "left:16px;top:16px;width:44px;height:44px", () =>
    close(),
  ).title = t("close");
  button(
    "＋",
    "right:16px;top:16px;width:44px;height:44px;font-size:20px",
    () => setZoom(zoom + 1),
  );
  button("−", "right:16px;top:68px;width:44px;height:44px;font-size:22px", () =>
    setZoom(zoom - 1),
  );
  button(ICON_LOCATE, "left:16px;top:68px;width:44px;height:44px", () => {
    // К наблюдателю, а не к точке открытия: после выбора вершины он уже
    // стоит в подобранной точке обзора
    center = { ...observer };
    render();
  }).title = t("mapMyPosition");

  const searchBtn = button(
    ICON_SEARCH,
    "left:16px;top:120px;width:44px;height:44px",
    () => toggleSearch(),
  );
  searchBtn.title = t("searchPeak");

  const go = button(
    t("mapApply"),
    "left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);" +
      "padding:13px 22px;font-weight:600;background:#4cc9f0;color:#1a1a2e;border-color:#4cc9f0",
    () => {
      close(true);
    },
  );
  go.style.whiteSpace = "nowrap";

  // Координаты центра и обязательная атрибуция OSM
  const coords = document.createElement("div");
  coords.style.cssText =
    "position:absolute;left:50%;bottom:calc(76px + env(safe-area-inset-bottom));" +
    "transform:translateX(-50%);z-index:2;background:rgba(26,26,46,.85);" +
    "border-radius:8px;padding:4px 10px;font:13px system-ui,sans-serif;color:#f1faee";
  root.appendChild(coords);

  const attribution = document.createElement("div");
  attribution.style.cssText =
    "position:absolute;right:0;bottom:0;z-index:2;background:rgba(26,26,46,.8);" +
    "padding:2px 6px;font:11px system-ui,sans-serif;color:#cfd8dc";
  attribution.innerHTML =
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" ' +
    'rel="noreferrer" style="color:#4cc9f0">OpenStreetMap</a> contributors, SRTM · ' +
    '© <a href="https://opentopomap.org/about" target="_blank" ' +
    'rel="noreferrer" style="color:#4cc9f0">OpenTopoMap</a> (CC-BY-SA)';
  root.appendChild(attribution);

  const hint = document.createElement("div");
  hint.style.cssText =
    "position:absolute;left:50%;top:16px;transform:translateX(-50%);z-index:2;" +
    "background:rgba(26,26,46,.85);border-radius:8px;padding:6px 12px;" +
    "font:13px system-ui,sans-serif;color:#cfd8dc;max-width:calc(100vw - 160px);text-align:center";

  /**
   * Подсказка вверху карты.
   *
   * @param holdMs сколько держать; 0 — до следующего сообщения. Стартовое
   *   «ведите карту» само уходит через несколько секунд, а «точка обзора
   *   подобрана» должна висеть, пока человек её правит
   */
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  const setHint = (text: string, holdMs = 0): void => {
    clearTimeout(hintTimer);
    hint.textContent = text;
    root.appendChild(hint);
    if (holdMs) hintTimer = setTimeout(() => hint.remove(), holdMs);
  };

  setHint(
    getLocale() === "ru"
      ? "Ведите карту — центр станет новой точкой. Кружок на луче поворачивает взгляд"
      : "Pan the map — the centre becomes your new spot. Drag the knob to aim the view",
    4000,
  );

  // --- Поиск вершины (живёт в карте, а не отдельной кнопкой на панораме) ---
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:absolute;left:50%;top:16px;transform:translateX(-50%);z-index:3;" +
    "display:none;flex-direction:column;gap:8px;width:min(420px,calc(100vw - 128px));" +
    "background:#1a1a2e;border:1px solid #415a77;border-radius:12px;padding:12px;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.5)";

  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = t("searchPrompt");
  input.style.cssText =
    "background:#2b2d42;color:#f1faee;border:1px solid #415a77;border-radius:8px;" +
    "padding:10px 12px;font:14px system-ui,sans-serif;outline:none;flex:1;min-width:0";

  // Крестик очистки: убирает и запрос, и выдачу. Нативный ✕ у input[type=search]
  // стирает только текст, а список результатов оставался бы висеть на экране.
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "✕";
  clearBtn.title = t("searchClear");
  clearBtn.style.cssText =
    "flex:none;width:34px;height:34px;border:none;border-radius:8px;" +
    "background:#415a77;color:#f1faee;font-size:15px;cursor:pointer;" +
    "display:flex;align-items:center;justify-content:center";

  const inputRow = document.createElement("div");
  inputRow.style.cssText = "display:flex;align-items:center;gap:8px";

  const results = document.createElement("div");
  results.style.cssText =
    "display:flex;flex-direction:column;gap:4px;max-height:min(46vh,300px);overflow-y:auto";

  inputRow.append(input, clearBtn);
  panel.append(inputRow, results);
  root.appendChild(panel);

  /**
   * Панель поиска — слой поверх карты, и «назад» должен закрывать сначала её,
   * а потом уже карту: ровно так же ведёт себя Escape.
   */
  let releaseSearchBack: (() => void) | null = null;

  function openSearch(): void {
    if (panel.style.display !== "none") return;
    panel.style.display = "flex";
    hint.remove();
    input.focus();
    releaseSearchBack = pushOverlay(() => closeSearch());
  }

  function closeSearch(): void {
    releaseSearchBack?.();
    releaseSearchBack = null;
    if (panel.style.display === "none") return;
    panel.style.display = "none";
    hint.remove();
  }

  function toggleSearch(): void {
    if (panel.style.display === "none") openSearch();
    else closeSearch();
  }

  let searchSeq = 0;
  const runSearch = async (): Promise<void> => {
    const query = input.value.trim();
    const seq = ++searchSeq;
    results.textContent = "";
    if (!query) return;

    const searching = document.createElement("div");
    searching.textContent = "…";
    searching.style.cssText =
      "color:#cfd8dc;font:13px system-ui,sans-serif;padding:4px";
    results.appendChild(searching);

    // Поиск не должен оставлять список на «…»: даже если источник отказал
    // (запрет хранилища, обрыв сети), человек обязан увидеть внятный ответ
    const hits = await options.search(query).catch((err) => {
      console.warn("Поиск вершины не удался:", err);
      return [] as SearchHit[];
    });
    // Медленный ответ на прежний запрос иначе перетирал свежие результаты:
    // человек уже дописал название, а список показывает выдачу по трём буквам
    if (seq !== searchSeq) return;
    results.textContent = "";
    if (!hits.length) {
      const empty = document.createElement("div");
      empty.textContent = t("peakNotFound");
      empty.style.cssText =
        "color:#cfd8dc;font:13px system-ui,sans-serif;padding:4px";
      results.appendChild(empty);
      return;
    }

    for (const hit of hits) {
      const row = document.createElement("button");
      row.style.cssText =
        "display:flex;flex-direction:column;align-items:flex-start;gap:2px;" +
        "background:#2b2d42;color:#f1faee;border:1px solid #415a77;border-radius:8px;" +
        "padding:8px 10px;font:13px system-ui,sans-serif;cursor:pointer;text-align:left;width:100%";
      row.onmouseenter = () => (row.style.background = "#3a3d5c");
      row.onmouseleave = () => (row.style.background = "#2b2d42");

      const ele =
        hit.peak.ele !== undefined
          ? ` · ${Math.round(hit.peak.ele)} ${getLocale() === "ru" ? "м" : "m"}`
          : "";
      const title = document.createElement("span");
      title.textContent = `${peakName(hit.peak)}${ele}`;
      title.style.fontWeight = "500";

      const sub = document.createElement("span");
      sub.textContent = hit.typos
        ? `${options.regionTitle(hit.region)} · ${t("searchCorrected")}`
        : options.regionTitle(hit.region);
      sub.style.cssText = "opacity:.7;font-size:12px";

      row.append(title, sub);
      row.onclick = () => void pickPeak(hit);
      results.appendChild(row);
    }
  };

  /**
   * Выбор вершины из поиска: показываем подобранную точку обзора прямо на
   * карте, а не уходим к панораме сразу.
   *
   * Точку обзора подбирает рельеф, и она не всегда там, куда человек
   * собирался: то за перегибом, то на другом берегу реки. Раньше карта
   * закрывалась мгновенно, и поправить это можно было только вернувшись в
   * неё заново — уже без вершины перед глазами.
   */
  async function pickPeak(hit: SearchHit): Promise<void> {
    toggleSearch(); // список свою работу сделал
    const name = peakName(hit.peak);
    setHint(
      getLocale() === "ru"
        ? `Подбираю точку обзора: ${name}…`
        : `Finding a viewpoint: ${name}…`,
    );

    const spot = await options.onPickPeak(hit);
    if (!spot) {
      setHint(
        getLocale() === "ru"
          ? `Не удалось подобрать точку обзора: ${name}`
          : `No viewpoint found: ${name}`,
        5000,
      );
      return;
    }

    observer = spot.origin;
    heading = spot.headingRad;
    target = { pos: { lat: hit.peak.lat, lon: hit.peak.lon }, name };
    targetName.textContent = name;
    // Центр — ровно на наблюдателе: «Перенестись сюда» берёт именно центр,
    // и середина между точкой и вершиной увела бы человека в чистое поле
    center = { ...spot.origin };
    applyHeading();
    render();
    setHint(
      getLocale() === "ru"
        ? "Точка обзора подобрана. Поправьте её и нажмите «Применить»"
        : "Viewpoint ready. Adjust it and press “Apply”",
    );
  }

  input.onkeydown = (ev) => {
    if (ev.key === "Enter") void runSearch();
    if (ev.key === "Escape") {
      // Не даём событию всплыть до document: там Escape увидел бы уже
      // скрытую панель поиска и закрыл заодно карту — одно нажатие
      // сворачивало два уровня, а вернуться к карте было нельзя
      ev.stopPropagation();
      toggleSearch();
    }
  };

  /** Отменить результаты поиска: снять и запрос, и список выдачи */
  const clearSearch = (): void => {
    searchSeq++; // ответ, который ещё едет, больше не применится
    input.value = "";
    results.textContent = "";
    input.focus();
  };
  clearBtn.onclick = clearSearch;
  // Стерли текст до пустоты (в т.ч. нативным ✕) — прячем и результаты
  input.addEventListener("input", () => {
    if (!input.value) clearSearch();
  });

  document.body.appendChild(root);
  render();
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(root);
    stopResize = () => resizeObserver?.disconnect();
  } else {
    // iOS < 13.4: ResizeObserver отсутствует — карта перерисовывается по
    // событиям перетаскивания/зума, а изменение окна добираем слушателем
    window.addEventListener("resize", render);
    stopResize = () => window.removeEventListener("resize", render);
  }
  return close;
}
