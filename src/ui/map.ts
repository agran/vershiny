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
import { peakName, t } from "../core/i18n";
import type { Peak } from "../core/peaks";
import { peakScore } from "../core/peaks";
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

// --- Слой вершин (работает и без сети: данные свои, с устройства) ---

/**
 * Страховочный потолок кандидатов слоя вершин.
 *
 * Реального предела по счёту нет: подписи размещаются без перекрытий
 * (placeMapPeakLabels), и метку убирает только реальное столкновение, а не
 * ранг. Потолок нужен лишь от вырожденного кадра — ограничивает сортировку
 * и проекцию в плотном регионе. Вершина, к которой человек ведёт карту,
 * не должна вылетать из-за вошедших в кадр более значимых соседей.
 */
export const MAP_PEAK_CANDIDATE_CAP = 400;

/**
 * Отбор вершин-кандидатов для слоя карты: самые значимые В КАДРЕ по той
 * же формуле, что и подписи на панораме (высота · изоляция; `peakScore`).
 * Геометрия кадра та же, что у projectPeaks: центр, зум, размер экрана и
 * запас в полподписи за краем. Количество не ограничено ничем, кроме
 * страховочного MAP_PEAK_CANDIDATE_CAP: кто реально влезет без перекрытий,
 * решает размещение в renderPeaks.
 *
 * Почему кадр, а не весь регион: регионы у нас крупные (Западный Кавказ —
 * 1226 вершин и Эльбрус по краю bbox), и глобальный топ-N по значимости
 * отдавливал локальные главные вершины видимого кадра: из Краснодара карта
 * на зуме 11 показывала Эльбрус с соседями, а стоящий на виду Фишт-Оштен
 * в лимит не проходил.
 *
 * Сортировка важна не только для отбора: размещение идёт от главной к
 * второстепенным (кто первым встал, того и место), а в DOM подписи
 * накладываются по порядку — поэтому рисуем от хвоста к голове, и главная
 * гора остаётся читаемой в толпе.
 *
 * Здесь же выкидываются одноимённые дубли (зум < 14): в горах «Пик №3»
 * идут пачками и слипаются в одно пятно. Список уже отсортирован по
 * значимости, поэтому из одноимённых выживает главная. Безымянные ('—')
 * не трогаем: это разные вершины, иначе весь кадр схлопывался бы в одну
 * метку-заглушку.
 */
export function selectMapPeaks(
  peaks: Peak[],
  zoom: number,
  center?: LatLon,
  width?: number,
  height?: number,
): Peak[] {
  // Окно кадра в lon/lat с запасом (как margin у projectPeaks)
  let inView = peaks;
  if (center && width && height) {
    const c = project(center, zoom);
    const margin = 80;
    const left = c.x - width / 2 - margin;
    const right = c.x + width / 2 + margin;
    const top = c.y - height / 2 - margin;
    const bottom = c.y + height / 2 + margin;
    const scale = TILE_PX * 2 ** zoom;
    const worldPx = scale;
    const lonLeft = (left / scale) * 360 - 180;
    const lonRight = (right / scale) * 360 - 180;
    const latTop = unproject(0, Math.max(0, top), zoom).lat;
    const latBottom = unproject(0, Math.min(worldPx, bottom), zoom).lat;
    inView = peaks.filter((p) => {
      if (p.lat > latTop || p.lat < latBottom) return false;
      // Долгота с заворотом: кадр у антимеридиана пересекает ±180
      if (lonLeft < -180 || lonRight > 180) {
        const lon =
          p.lon > 0 && lonLeft < -180
            ? p.lon - 360
            : p.lon < 0 && lonRight > 180
              ? p.lon + 360
              : p.lon;
        return lon >= lonLeft && lon <= lonRight;
      }
      return p.lon >= lonLeft && p.lon <= lonRight;
    });
  }
  const sorted = [...inView].sort(
    (a, b) => peakScore(b, 0) - peakScore(a, 0) || (b.ele ?? 0) - (a.ele ?? 0),
  );
  const picked: Peak[] = [];
  const seen = new Set<string>();
  for (const p of sorted) {
    if (zoom < 14) {
      const name = peakName(p);
      // Пустое имя и заглушка '—' — «безымянная»: такие не дедуплицируем,
      // это разные вершины
      if (name && name !== "—") {
        if (seen.has(name)) continue;
        seen.add(name);
      }
    }
    picked.push(p);
    if (picked.length >= MAP_PEAK_CANDIDATE_CAP) break;
  }
  return picked;
}

// --- Размещение подписей без перекрытий ---

/** Высота бокса метки: подпись (~15px) + треугольник-маркер (8px) */
const LABEL_HEIGHT = 24;
/** Полузазор между подписями, чтобы не слипались */
const LABEL_GAP = 3;
/**
 * Подъём сдвинутой подписи над маркером, px. Освобождает место выноске —
 * тонкой линии от вершины треугольника к углу подписи: без линии в плотном
 * поле непонятно, к какому треугольнику относится уехавшая вбок подпись
 */
const LABEL_LIFT = 8;
/** Боковой отступ сдвинутой подписи от точки: сдвиг = половина ширины + это */
const LABEL_SIDE_GAP = 10;
/** Сколько кадров метка помнит свой якорь, будучи временно неразмещённой */
const LABEL_STICKY_TTL = 30;

// Ширина текста — через canvas measureText с кешем: точнее оценки «6.5px
// на символ» (та завышала бокс на узких глифах в полтора раза) и не трогает
// layout, в отличие от getBoundingClientRect на каждом DOM-элементе. В
// тестовом окружении canvas может не быть — тогда оценка по длине строки.
let measureCtx: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

function measureLabelWidth(text: string): number {
  let w = widthCache.get(text);
  if (w !== undefined) return w;
  if (measureCtx === undefined) {
    measureCtx = null;
    try {
      if (typeof document !== "undefined") {
        const ctx = document.createElement("canvas").getContext("2d");
        if (ctx) {
          ctx.font = "11px system-ui, sans-serif";
          // Проверка адекватности: в jsdom/happy-dom measureText бывает
          // заглушкой с мусором в ответе
          const probe = ctx.measureText("probe").width;
          if (Number.isFinite(probe) && probe > 0) measureCtx = ctx;
        }
      }
    } catch {
      measureCtx = null;
    }
  }
  const raw = measureCtx
    ? measureCtx.measureText(text).width
    : text.length * 6.5;
  // max-width:140px + padding 2×4px из стилей метки
  w = Math.min(148, raw + 8);
  if (widthCache.size > 4000) widthCache.clear();
  widthCache.set(text, w);
  return w;
}

/** Размер бокса метки «имя + высота» */
export function mapPeakLabelSize(text: string): { w: number; h: number } {
  return { w: measureLabelWidth(text), h: LABEL_HEIGHT };
}

export interface MapPeakLabelItem {
  /** Стабильный ключ вершины (координаты) — по нему работает липкость */
  key: string;
  /** Текст подписи («имя высота») */
  text: string;
  /** Экранные координаты точки вершины, px */
  x: number;
  y: number;
}

export interface MapPeakLabelPlaced extends MapPeakLabelItem {
  /** Горизонтальный сдвиг подписи относительно точки, px (0 — над точкой) */
  shift: number;
}

/** Состояние раскладки между кадрами (липкость якорей) */
export interface LabelLayoutState {
  /** Ключ вершины → якорь (0 — по центру, 1 — вправо, 2 — влево) прошлого кадра */
  anchor: Map<string, number>;
  /** Ключ → сколько кадров подряд метка не встала */
  age: Map<string, number>;
}

export function createLabelLayoutState(): LabelLayoutState {
  return { anchor: new Map(), age: new Map() };
}

/**
 * Размещение подписей без перекрытий.
 *
 * Три принципа, каждый — против конкретной болезни:
 *  1) нет потолка по счёту — метку убирает только реальное перекрытие;
 *  2) липкость: то, что стояло в прошлом кадре, размещается первым, поэтому
 *     вершина, к которой человек ведёт карту, не гаснет от вошедшего
 *     более значимого соседа — сосед сам уйдёт на другой якорь;
 *  3) три якоря (над точкой, правее, левее): при нехватке места подпись
 *     отходит в сторону, а не пропадает; маркер остаётся на вершине, а
 *     сдвинутая подпись приподнимается (LABEL_LIFT) и соединяется с
 *     маркером выноской — иначе в плотном поле не видно, чья она.
 *
 * Цена липкости — результат зависит от истории: тот же кадр, достигнутый
 * другим путём, может дать другую раскладку. Это осознанный размен ради
 * стабильности кадр-кадру (в MapLibre ту же роль играет переносимый
 * CollisionIndex с fade-переходами).
 */
export function placeMapPeakLabels(
  items: MapPeakLabelItem[],
  state: LabelLayoutState = createLabelLayoutState(),
): MapPeakLabelPlaced[] {
  const placed: number[] = []; // плоско: x0, y0, x1, y1
  const out: MapPeakLabelPlaced[] = [];
  const nextAnchor = new Map<string, number>();
  const nextAge = new Map<string, number>();

  const hits = (x0: number, y0: number, x1: number, y1: number): boolean => {
    for (let i = 0; i < placed.length; i += 4) {
      if (
        x0 < placed[i + 2] &&
        x1 > placed[i] &&
        y0 < placed[i + 3] &&
        y1 > placed[i + 1]
      ) {
        return true;
      }
    }
    return false;
  };

  // Два прохода: сперва стоявшие в прошлом кадре (в их порядке значимости),
  // потом новички — вошедшая в кадр доминанта не выбивает ведомую вершину
  const wasShown = (it: MapPeakLabelItem): boolean => state.anchor.has(it.key);
  const passes = [items.filter(wasShown), items.filter((it) => !wasShown(it))];

  for (const pass of passes) {
    for (const it of pass) {
      const { w: bw, h: bh } = mapPeakLabelSize(it.text);
      // Якоря: сдвиг центра подписи относительно точки. Сдвинутая подпись
      // целиком уходит за пределы маркера плюс небольшой отступ
      const shifts = [0, bw / 2 + LABEL_SIDE_GAP, -(bw / 2 + LABEL_SIDE_GAP)];
      const prev = state.anchor.get(it.key);
      // Прошлый якорь пробуем первым: подпись не должна прыгать вокруг точки
      const order =
        prev === undefined
          ? [0, 1, 2]
          : [prev, ...[0, 1, 2].filter((i) => i !== prev)];

      let done = false;
      for (const ai of order) {
        const cx = it.x + shifts[ai];
        const x0 = cx - bw / 2 - LABEL_GAP;
        const x1 = cx + bw / 2 + LABEL_GAP;
        // Сдвинутая подпись поднята на LABEL_LIFT — бокс выше, чтобы
        // приподнятая метка не наезжала на вершины над её маркером
        const y0 = it.y - bh - (ai === 0 ? 0 : LABEL_LIFT) - LABEL_GAP;
        const y1 = it.y + LABEL_GAP;
        if (hits(x0, y0, x1, y1)) continue;
        placed.push(x0, y0, x1, y1);
        out.push({ ...it, shift: shifts[ai] });
        nextAnchor.set(it.key, ai);
        done = true;
        break;
      }
      if (!done && prev !== undefined) {
        // Не встала — но липкость держим ещё TTL кадров, чтобы при обратном
        // движении карты она вернулась на тот же якорь, а одиночный кадр
        // невезения не сбрасывал историю
        const age = (state.age.get(it.key) ?? 0) + 1;
        if (age < LABEL_STICKY_TTL) {
          nextAnchor.set(it.key, prev);
          nextAge.set(it.key, age);
        }
      }
    }
  }
  state.anchor = nextAnchor;
  state.age = nextAge;
  return out;
}

export interface ProjectedMapPeak {
  peak: Peak;
  /** Экранные координаты от левого верхнего угла видимого куска мира, px */
  x: number;
  y: number;
}

/**
 * Проекция вершин на экран с отсевом за краем (запас в полподписи, чтобы
 * метка у кромки не мигала при микросдвиге карты). Долгота заворачивается
 * через кратчайшую разницу с центром: у антимеридиана вершины «за краем
 * мира» иначе не рисовались бы вовсе.
 */
export function projectPeaks(
  peaks: Peak[],
  center: LatLon,
  zoom: number,
  width: number,
  height: number,
): ProjectedMapPeak[] {
  const c = project(center, zoom);
  const left = c.x - width / 2;
  const top = c.y - height / 2;
  const worldPx = TILE_PX * 2 ** zoom;
  const margin = 80;
  const out: ProjectedMapPeak[] = [];
  for (const peak of peaks) {
    const pt = project(peak, zoom);
    let px = pt.x;
    // Кратчайший путь по долготе: центр −179°, вершина +179° — соседи,
    // а без заворота между ними «весь мир»
    const dxWorld = px - c.x;
    if (dxWorld > worldPx / 2) px -= worldPx;
    else if (dxWorld < -worldPx / 2) px += worldPx;
    const x = px - left;
    const y = pt.y - top;
    if (
      x < -margin ||
      x > width + margin ||
      y < -margin ||
      y > height + margin
    ) {
      continue;
    }
    out.push({ peak, x, y });
  }
  return out;
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
   * Вершины для базового слоя карты: сначала текущий регион (он уже в
   * памяти), затем владелец может подложить остальные скачанные — карта
   * перечитает слой по `onPeaksAdded`. Без сети это единственное содержимое
   * карты: тайлы OpenTopoMap не приходят, а вершины остаются.
   */
  peaks?: Peak[];
  /** Владелец догрузил вершины (офлайн-регионы из IndexedDB) */
  onPeaksAdded?: (peaks: Peak[]) => void;
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

  /**
   * Базовый слой вершин: наши данные, поэтому это единственное содержимое
   * карты офлайн, когда тайлов нет вовсе. Онлайн слой скрывается целиком:
   * на OpenTopoMap вершины уже подписаны, и наши метки сверху только
   * дублировали бы их. Элементы переиспользуются из пула — регион с
   * тысячами вершин при каждом сдвиге карты иначе создавал бы тысячи
   * DOM-узлов заново. Под маркером наблюдателя и меткой цели.
   */
  const peaksLayer = document.createElement("div");
  peaksLayer.style.cssText = "position:absolute;inset:0;z-index:1";
  layer.appendChild(peaksLayer);

  /** Вершины слоя: текущий регион сразу, скачанные владелец доложит позже */
  let mapPeaks: Peak[] = options.peaks ? [...options.peaks] : [];
  /** Пул DOM-элементов меток: скрываем лишние, а не удаляем */
  const peakEls: HTMLElement[] = [];
  /** Раскладка подписей между кадрами: липкость якорей (placeMapPeakLabels) */
  const labelLayout = createLabelLayoutState();
  /** Слой виден, только пока тайлы не загрузились (офлайн) — см. render */
  let peaksLayerNeeded = true;
  /** Дебаунс переключения слоя: тайлы догружаются рывками, не дёргаем слой */
  let layerFlipTimer: ReturnType<typeof setTimeout> | undefined;

  /** Спрятать все метки вершин (слой закрыт тайлами, пуст или карта нулевая) */
  const hidePeakLabels = (): void => {
    peaksLayer.style.display = "none";
  };

  /**
   * Нужен ли слой вершин: только когда тайлов нет. Кадр считается покрытым,
   * если хотя бы один видимый тайл загрузился И НИ ОДИН видимый не упал с
   * ошибкой — половинчатая картина (часть тайлов отвалилась по 429/обрыву)
   * дырявее с закрытым слоем, чем с двойными подписями. Плюс не должно
   * остаться летящих: иначе при панорамировании въезжающие незагруженные
   * тайлы включали и выключали слой по несколько раз в секунду.
   */
  const computePeaksLayerNeeded = (): boolean => {
    let okCount = 0;
    let failedCount = 0;
    let pendingCount = 0;
    for (const img of tiles.values()) {
      if (img.dataset.ok) okCount++;
      else if (img.dataset.failed) failedCount++;
      else pendingCount++;
    }
    return !(okCount > 0 && failedCount === 0 && pendingCount === 0);
  };

  const updatePeaksLayerNeed = (): void => {
    if (computePeaksLayerNeeded() === peaksLayerNeeded) {
      // Состояние снова согласовано — отложенное переключение не нужно
      if (layerFlipTimer !== undefined) {
        clearTimeout(layerFlipTimer);
        layerFlipTimer = undefined;
      }
      return;
    }
    // Переключение — с дебаунсом: одиночный запоздавший тайл не должен
    // мигать слоем; по таймауту пересчитываем на свежем состоянии
    if (layerFlipTimer !== undefined) return;
    layerFlipTimer = setTimeout(() => {
      layerFlipTimer = undefined;
      // За окно дебаунса состояние могло вернуться к прежнему — тогда слой
      // не трогаем. Иначе переключаем и перерисовываем: без присваивания
      // (так и было до исправления) таймер лишь перепланировал сам себя,
      // и слой вершин навсегда оставался поверх загрузившейся карты
      const needed = computePeaksLayerNeeded();
      if (needed !== peaksLayerNeeded) {
        peaksLayerNeeded = needed;
        renderPeaks();
      }
    }, 250);
  };

  /** Перерисовать слой вершин под текущий центр/зум */
  let renderPeaks = (): void => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (!mapPeaks.length || !w || !h || !peaksLayerNeeded) {
      hidePeakLabels();
      return;
    }
    peaksLayer.style.display = "block";
    const selected = selectMapPeaks(mapPeaks, zoom, center, w, h);
    const projected = projectPeaks(selected, center, zoom, w, h);
    const placedLabels = placeMapPeakLabels(
      projected.map((p) => ({
        key: `${p.peak.lat.toFixed(5)},${p.peak.lon.toFixed(5)}`,
        text:
          p.peak.ele !== undefined
            ? `${peakName(p.peak)} ${Math.round(p.peak.ele)}`
            : peakName(p.peak),
        x: p.x,
        y: p.y,
      })),
      labelLayout,
    );

    let used = 0;
    // Главные рисуем последними (выше в DOM): placeMapPeakLabels вернул их
    // по убыванию значимости, поэтому идём с хвоста
    for (let i = placedLabels.length - 1; i >= 0; i--) {
      const { x, y, text, shift } = placedLabels[i];

      let el = peakEls[used];
      if (!el) {
        el = document.createElement("div");
        // Без cursor:pointer: метка не кликабельна, а обманчивый аффорданс
        // обещал действие, которого нет. pointer-events оставлены — события
        // всплывают к корню карты, и drag с метки работает как с фона
        el.style.cssText =
          "position:absolute;transform:translate(-50%,-100%);display:flex;" +
          "flex-direction:column;align-items:center;pointer-events:auto;" +
          "z-index:1";
        const markerEl = document.createElement("div");
        markerEl.style.cssText =
          "width:0;height:0;border-left:5px solid transparent;" +
          "border-right:5px solid transparent;border-bottom:8px solid #f1faee;" +
          "filter:drop-shadow(0 0 2px rgba(0,0,0,.9));flex:none";
        const label = document.createElement("div");
        label.style.cssText =
          "background:rgba(13,27,42,.8);border-radius:4px;padding:0 4px;" +
          "font:11px system-ui,sans-serif;color:#f1faee;white-space:nowrap;" +
          "max-width:140px;overflow:hidden;text-overflow:ellipsis";
        // Выноска: линия от вершины треугольника к углу сдвинутой подписи.
        // position:absolute — вне flex-потока. Начало (left:50%, bottom:7px)
        // на пиксель заходит ПОД остриё треугольника, конец (+3px к длине) —
        // под край подписи: стыки не «светятся» зазорами
        const leaderEl = document.createElement("div");
        leaderEl.style.cssText =
          "position:absolute;left:50%;bottom:7px;width:0;height:2px;" +
          "border-radius:1px;background:rgba(241,250,238,.55);" +
          "transform-origin:0 50%;" +
          "filter:drop-shadow(0 0 1px rgba(0,0,0,.9));" +
          "pointer-events:none;display:none";
        el.append(label, markerEl, leaderEl);
        peaksLayer.appendChild(el);
        peakEls.push(el);
      }
      // Подпись — ПЕРВЫЙ ребёнок (label), маркер-стрелка вторым: иначе текст
      // уходил в треугольник, оставался без стилей и разворачивался крупно
      const label = el.firstElementChild as HTMLElement;
      const leader = el.lastElementChild as HTMLElement;
      label.textContent = text;
      // Сдвинутый якорь: уезжает и приподнимается только подпись, маркер
      // остаётся на вершине, а выноска показывает, к какому треугольнику
      // относится подпись (в плотном поле иначе не разобрать)
      label.style.transform = shift ? `translateX(${shift}px)` : "";
      label.style.marginBottom = shift ? `${LABEL_LIFT}px` : "";
      if (shift) {
        // От острия треугольника (центр, 8px от точки) к ближнему нижнему
        // углу подписи: он на LABEL_SIDE_GAP вбок и на LABEL_LIFT выше
        // острия. +3px — конец заходит под край подписи: выноска
        // визуально «воткнута» в неё, а не висит рядом
        const dx = shift > 0 ? LABEL_SIDE_GAP : -LABEL_SIDE_GAP;
        leader.style.display = "block";
        leader.style.width = `${Math.hypot(dx, LABEL_LIFT) + 3}px`;
        leader.style.transform = `rotate(${(Math.atan2(-LABEL_LIFT, dx) * 180) / Math.PI}deg)`;
      } else {
        leader.style.display = "none";
      }
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.display = "flex";
      used++;
    }
    for (let i = used; i < peakEls.length; i++)
      peakEls[i].style.display = "none";
  };

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
          img.alt = "";
          img.loading = "eager";
          img.draggable = false;
          // Загрузившийся тайл перекрывает наш слой вершин: на OpenTopoMap они
          // уже подписаны, дублировать незачем. Скрытие — в конце render(),
          // когда все тайлы кадра пройдены (часть могла быть из кеша)
          img.onload = () => {
            img!.dataset.ok = "1";
            updatePeaksLayerNeed();
          };
          // Не загрузился (офлайн, лимит OSM) — прячем: «битая картинка»
          // поверх карты хуже, чем просто пустая клетка
          img.onerror = () => {
            img!.dataset.failed = "1";
            img!.style.visibility = "hidden";
            updatePeaksLayerNeed();
          };
          img.src = topoTileUrl(zoom, wrapped, ty);
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

    updatePeaksLayerNeed();
    renderPeaks();

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

  // Владелец может доложить вершины после открытия (офлайн-регионы из
  // IndexedDB читаются асинхронно): добавляем и перерисовываем слой
  options.onPeaksAdded = (extra) => {
    mapPeaks.push(...extra);
    renderPeaks();
  };

  /** Остановка слушателя добавления вершин: карта закрыта — обновления не нужны */
  const stopPeaksFeed = (): void => {
    options.onPeaksAdded = undefined;
  };

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
    stopPeaksFeed();
    if (layerFlipTimer !== undefined) {
      clearTimeout(layerFlipTimer);
      layerFlipTimer = undefined;
    }
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
  const zoomInBtn = button(
    "＋",
    "right:16px;top:16px;width:44px;height:44px;font-size:20px",
    () => setZoom(zoom + 1),
  );
  zoomInBtn.title = t("mapZoomIn");
  zoomInBtn.setAttribute("aria-label", t("mapZoomIn"));
  const zoomOutBtn = button(
    "−",
    "right:16px;top:68px;width:44px;height:44px;font-size:22px",
    () => setZoom(zoom - 1),
  );
  zoomOutBtn.title = t("mapZoomOut");
  zoomOutBtn.setAttribute("aria-label", t("mapZoomOut"));
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

  setHint(t("mapHintPan"), 4000);

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
          ? ` · ${Math.round(hit.peak.ele)} ${t("unitM")}`
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
    setHint(`${t("mapHintFinding")}: ${name}…`);

    const spot = await options.onPickPeak(hit);
    if (!spot) {
      setHint(`${t("mapHintNoSpot")}: ${name}`, 5000);
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
    setHint(t("mapHintReady"));
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
