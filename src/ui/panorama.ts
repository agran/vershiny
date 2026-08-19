/**
 * Canvas-рендер панорамы (ROADMAP неделя 2):
 * силуэт горизонта, шкала азимутов, подписи пиков с кластеризацией.
 * Проекция: x = (azimuth − centerAz)/fov · width,
 *           y = horizonY − elevationAngle/fovV · height (ARCHITECTURE.md).
 */

import { toDeg, wrapAngle } from "../core/geo";
import type { VisiblePeak } from "../core/horizon";
import { getLocale, peakName, t } from "../core/i18n";
import { perfCount, perfEnabled, perfPhase } from "../core/perf";

export interface PanoramaState {
  /** Углы горизонта по лучам, рад (0 = север) — верхний слой */
  horizon: Float32Array;
  /** Шаг между лучами, рад */
  stepRad: number;
  /** Видимые пики (уже отсортированы по приоритету) */
  peaks: VisiblePeak[];
  /** Слои горизонта по дистанционным корзинам (0 = ближний) */
  layers?: Float32Array[];
  /** Дистанция до точки горизонта по лучам (для классификации пиков) */
  distanceToHorizonM?: Float32Array;
  /** Фронты видимости по лучам (для точных маркеров) */
  fronts?: import("../core/horizon").VisibleFront[][];
  /** Гребни силуэта по корзинам дистанций [корзина][луч] */
  crests?: Float32Array[];
}

export interface ViewState {
  /** Центральный азимут взгляда, рад */
  centerAzRad: number;
  /** Наклон камеры: + вверх, − вниз, рад */
  tiltRad: number;
  /** Горизонтальный FOV, рад */
  fovRad: number;
  /** Вертикальный FOV, рад */
  fovVRad: number;
  /**
   * Крен вокруг оси взгляда, рад (0 = горизонт ровный). Положительный —
   * довернуть оверлей по часовой вокруг центра кадра. Ставится из
   * OrientationState.rollRad (core/orientation.ts); в панораме без камеры
   * остаётся 0 — горизонт держим ровным.
   */
  rollRad?: number;
}

const SKY_TOP = "#0d1b2a";
const SKY_HORIZON = "#415a77";
const SKY_BOTTOM = "#16202c";
/**
 * Кеш градиента неба: он зависит только от высоты холста (стопы — доли),
 * а создавался на каждый кадр. CanvasGradient не привязан к контексту —
 * один и тот же объект годится и для экранного холста, и для холста снимка
 */
let skyGradientCache: { height: number; gradient: CanvasGradient } | null =
  null;
/** Контур гребня: чёрная линия сверху, белая снизу (для наложения на кадр камеры) */
const RIDGE_DARK = "rgba(0,0,0,0.85)";
const RIDGE_LIGHT = "rgba(255,255,255,0.95)";
/** Толщина/сдвиг контура в CSS-пикселях (масштабируются по devicePixelRatio) */
const RIDGE_WIDTH_CSS = 1.4;
const RIDGE_OFFSET_CSS = 1.1;
/**
 * Подписи и выноски — тот же принцип: светлое с тёмной обводкой, без плашек.
 * Экспортируются: снимок подписывает координаты теми же красками, иначе его
 * подпись жила бы своей жизнью и разъезжалась с оверлеем при любой правке.
 */
export const INK_DARK = "rgba(0,0,0,0.85)";
export const INK_LIGHT = "rgba(255,255,255,0.98)";
const INK_LIGHT_DIM = "rgba(255,255,255,0.55)";
/** Наклон подписей вершин: все под одним углом, вправо-вверх от вершины */
const LABEL_ANGLE_DEG = 60;
/**
 * Предельная «крутизна» силуэта: рад подъёма на рад азимута. Всё, что круче,
 * считается обрывом гребня, а не склоном — полилиния там рвётся. При шаге
 * 0.1° это 1.5° на луч: настоящий склон так не скачет, а вот край гребня,
 * за которым начинается другая поверхность, — сколько угодно.
 */
export const MAX_RIDGE_SLOPE = 15;
/**
 * Сколько подписей в кадре «стоят» скрытой вершины. Бюджет тратится сначала
 * на видимые: пустой кадр отдаёт скрытым все 6 мест, плотный — ни одного.
 */
const HIDDEN_LABEL_BUDGET = 6;

/** Потолки многострочной раскладки подписи (построение — в tryPlace) */
const MAX_LABEL_LINES = 4; // ≤ 3 фрагментов названия + строка «высота · расстояние»
const MAX_NAME_BREAKS = 7; // точек разрыва названия (пробел/дефис)

/**
 * Повернуть систему координат вокруг центра холста на крен (рад).
 *
 * AR-режим доворачивает оверлей этим поворотом, чтобы контуры легли на
 * наклонённый кадр камеры (телефон держат с одним углом ниже): ось взгляда
 * проходит через центр кадра и при cover-кропе (обрезка симметрична), так
 * что центр холста и есть оптический центр. Видео при этом рисуется
 * неповёрнутым — в нём мир уже наклонён как есть.
 */
export function rotateAroundCenter(
  ctx: CanvasRenderingContext2D,
  rollRad: number,
): void {
  if (!rollRad) return;
  const { width, height } = ctx.canvas;
  ctx.translate(width / 2, height / 2);
  ctx.rotate(rollRad);
  ctx.translate(-width / 2, -height / 2);
}

/**
 * Горизонтальный запас, с которым нужно рисовать контуры при довороте кадра
 * на крен: в повёрнутых координатах края экрана — наклонные линии, и углы
 * кадра выходят за x = 0 / x = width на (W·(1−cosθ) + H·sinθ)/2 в каждую
 * сторону. Для крена 30° на портретном экране это ~500 px — прежние 20 px
 * оставляли контуры недорисованными у левого и правого края.
 */
export function rollEdgeMarginX(
  width: number,
  height: number,
  rollRad: number,
  uiScale: number,
): number {
  const pad = 2 * (RIDGE_OFFSET_CSS + RIDGE_WIDTH_CSS) * uiScale + 8;
  return Math.max(
    20,
    (width * (1 - Math.cos(rollRad)) +
      height * Math.abs(Math.sin(rollRad))) /
      2 +
      pad,
  );
}

/**
 * Доля высоты кадра, на которой проходит линия горизонта — чуть ниже центра,
 * чтобы небо не занимало полкадра. Экспортируется: автокалибровка (skyline.ts)
 * переводит пиксели кадра в углы по этой же величине, и разойтись они не должны.
 */
export const HORIZON_FRAC = 0.62;

/** Какие части оверлея рисовать */
export interface OverlayOptions {
  /**
   * Контуры гребней и шкала азимутов. false — только подписи вершин:
   * так выглядит снимок из AR, где нарисованный силуэт конфликтовал бы
   * с настоящими горами в кадре (core/photo-caption.ts, галочка «Контуры»).
   */
  ridges?: boolean;
  /**
   * Подписи вершин. false — только контуры и шкала: AR рисует линии
   * полупрозрачными, а подписи затем вторым проходом и непрозрачно
   * (ui/ar.ts, drawArFrame).
   */
  labels?: boolean;
  /**
   * Опорный азимут азимутального цикла, рад. По умолчанию центр кадра:
   * диапазон [centerAz−fov/2, centerAz+fov/2]. AR задаёт центр ЗАПАСА кэша,
   * чтобы проекция не прыгала при каждом перерендере
   */
  anchorAzRad?: number;
  /**
   * Размеры ВИДИМОЙ области, если оверлей рисуется в буфер большего
   * размера (кэш AR с полями запаса): проекция считается от этих размеров,
   * холст — лишь поверхность. Без этого горизонт и масштаб берутся от
   * буфера, оверлей растягивается в bufH/height раз и уезжает за нижний
   * край экрана
   */
  viewWidth?: number;
  viewHeight?: number;
}

/**
 * Рендер одного кадра панорамы: небо + оверлей.
 *
 * @param uiScale во сколько раз холст крупнее «экранного» пикселя. По
 *   умолчанию выводится из DOM-геометрии, но у холста, не вставленного в
 *   страницу (снимок), она нулевая — такому вызову масштаб нужно передать.
 */
export function renderPanorama(
  ctx: CanvasRenderingContext2D,
  state: PanoramaState,
  view: ViewState,
  uiScale?: number,
  overlay?: OverlayOptions,
): void {
  const { width, height } = ctx.canvas;
  const tSky = perfEnabled ? performance.now() : 0;

  // Фон — единый градиент на весь кадр (без горизонтальной «ступеньки»).
  // Стопы — доли высоты, поэтому градиент зависит только от неё и кешируется
  if (!skyGradientCache || skyGradientCache.height !== height) {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, SKY_TOP);
    sky.addColorStop(HORIZON_FRAC, SKY_HORIZON);
    sky.addColorStop(1, SKY_BOTTOM);
    skyGradientCache = { height, gradient: sky };
  }
  ctx.fillStyle = skyGradientCache.gradient;
  ctx.fillRect(0, 0, width, height);
  if (perfEnabled) perfPhase("sky", performance.now() - tSky);

  drawOverlay(ctx, state, view, uiScale, overlay);
}

/**
 * Оверлей поверх любого фона: контуры гребней, шкала азимутов, подписи вершин.
 * Используется и панорамой, и AR-режимом поверх кадра камеры, поэтому ничего
 * не заливает — только контрастные линии и текст.
 *
 * @param uiScale во сколько раз холст крупнее «экранного» пикселя: от него
 *   зависят кегль подписей и толщина линий.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  state: PanoramaState,
  view: ViewState,
  uiScaleOverride?: number,
  overlay: OverlayOptions = {},
): void {
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;
  // Кеш AR рисует оверлей в буфер с полями запаса: проекция обязана
  // считаться от размеров ВИДИМОЙ области, а не поверхности рисования —
  // иначе горизонт уезжает к низу буфера, и контуры падают за экран
  const width = overlay.viewWidth ?? canvasW;
  const height = overlay.viewHeight ?? canvasH;
  const horizonY = height * HORIZON_FRAC;
  const drawRidges = overlay.ridges !== false;
  const tTotal = perfEnabled ? performance.now() : 0;
  let tSection = tTotal;

  const azToX = (az: number): number =>
    (wrapAngle(az - (overlay.anchorAzRad ?? view.centerAzRad)) /
      view.fovRad) *
      width +
    width / 2;
  const elevToY = (elev: number): number =>
    horizonY - ((elev - view.tiltRad) / view.fovVRad) * height;

  const { horizon, stepRad } = state;
  const layers = state.layers ?? [horizon];

  // Масштаб под плотность пикселей (canvas в devicePixelRatio раз крупнее CSS).
  // У холста вне DOM геометрия нулевая — там масштаб приходит параметром:
  // иначе на снимке шириной 3840 px подписи рисовались кеглем 12 px
  const uiScale =
    uiScaleOverride ??
    (ctx.canvas.clientWidth > 0 ? width / ctx.canvas.clientWidth : 1);

  // Довёрнутый на крен кадр (rotateAroundCenter) шире холста в повёрнутых
  // координатах — без этого запаса контуры и шкала обрываются, не дойдя
  // до краёв экрана
  const edgeMarginX = rollEdgeMarginX(width, height, view.rollRad ?? 0, uiScale);

  // Профили силуэта: видимые гребни по возрастанию дистанции.
  // Гребень = локальный максимум угла вдоль луча (то, что реально видно как линия).
  const profiles: Float32Array[] = [];
  if (state.crests?.length) {
    profiles.push(...state.crests);
  } else {
    for (const layer of layers) if (layer) profiles.push(layer);
  }

  if (drawRidges && profiles.length) {
    const rayCount = profiles[0].length;
    const ridgeWidth = RIDGE_WIDTH_CSS * uiScale;
    const ridgeOffset = RIDGE_OFFSET_CSS * uiScale;
    // Окклюзия: гребень виден только там, где он выше всех более близких.
    // Буфер переиспользуем между кадрами: 14.4 КБ молодого мусора на кадр
    // на слабом телефоне — это GC-паузы посреди поворота
    if (runningMaxBuf.length !== rayCount) {
      runningMaxBuf = new Float32Array(rayCount);
    }
    runningMaxBuf.fill(-Infinity);
    const runningMax = runningMaxBuf;
    const EPS = 5e-4; // ~0.03° — не рисуем «дрожание» на одном уровне

    for (const prof of profiles) {
      const segments = buildRidgeSegments(
        prof,
        runningMax,
        EPS,
        stepRad,
        azToX,
        elevToY,
        width,
        height,
        edgeMarginX,
      );
      if (segments.length) {
        // Децимация общая для обоих проходов: сдвиг по y не влияет на
        // отклонение от хорды, так что набор точек у чёрной и белой линии
        // один и тот же
        const simplified = decimateSegments(segments);
        strokeRidge(ctx, simplified, -ridgeOffset, RIDGE_DARK, ridgeWidth);
        strokeRidge(ctx, simplified, +ridgeOffset, RIDGE_LIGHT, ridgeWidth);
      }
      for (let i = 0; i < rayCount; i++) {
        if (prof[i] > runningMax[i]) runningMax[i] = prof[i];
      }
    }
  }
  if (perfEnabled) {
    perfPhase("ridge", performance.now() - tSection);
    tSection = performance.now();
  }

  // Шкала азимутов: каждые 15°, подписи сторон света. Без гребней шкала
  // бессмысленна — рисовать риски посреди фотографии нечему
  if (drawRidges) {
    ctx.font = `${12 * uiScale}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    const stepDeg = 15;
    for (let deg = 0; deg < 360; deg += stepDeg) {
      const az = (deg * Math.PI) / 180;
      const x = azToX(az);
      if (x < -edgeMarginX || x > width + edgeMarginX) continue;
      const tickLen = (deg % 45 === 0 ? 14 : 7) * uiScale;
      ctx.beginPath();
      ctx.moveTo(x, horizonY);
      ctx.lineTo(x, horizonY + tickLen);
      ctx.strokeStyle = INK_DARK;
      ctx.lineWidth = 3 * uiScale;
      ctx.stroke();
      ctx.strokeStyle = INK_LIGHT_DIM;
      ctx.lineWidth = 1.2 * uiScale;
      ctx.stroke();
      if (deg % 45 === 0) {
        const ty = horizonY + 28 * uiScale;
        ctx.lineWidth = 3 * uiScale;
        ctx.strokeStyle = INK_DARK;
        ctx.strokeText(cardinal(deg), x, ty);
        ctx.fillStyle = INK_LIGHT;
        ctx.fillText(cardinal(deg), x, ty);
      }
    }
  }
  if (perfEnabled) {
    perfPhase("scale", performance.now() - tSection);
    tSection = performance.now();
  }

  // Подписи пиков с кластеризацией. Отдельным флагом: AR рисует их вторым
  // проходом без полупрозрачности (labels:false у прохода с контурами)
  if (overlay.labels !== false) {
    drawLabels(
      ctx,
      state.peaks,
      azToX,
      elevToY,
      view,
      state,
      uiScale,
      width,
      height,
    );
  }
  if (perfEnabled) {
    perfPhase("labels", performance.now() - tSection);
    perfPhase("overlayTotal", performance.now() - tTotal);
  }
}

/**
 * Разбивает профиль на непрерывные видимые сегменты.
 * Точка входит в сегмент, если: есть данные, она выше окклюдера (runningMax),
 * попадает на экран и не образует разрыв — ни по x, ни по углу возвышения.
 */
export function buildRidgeSegments(
  prof: Float32Array,
  runningMax: Float32Array,
  eps: number,
  stepRad: number,
  azToX: (az: number) => number,
  elevToY: (elev: number) => number,
  width: number,
  height: number,
  /** Горизонтальный запас за края кадра, px (доворот кадра на крен) */
  marginX = 20,
): { x: number; y: number }[][] {
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  let prevX = NaN;
  let prevV = NaN;
  const maxGap = width * 0.25; // разрыв при заходе за край панорамы
  // Скачок угла между соседними лучами круче 30:1 — это не склон, а обрыв
  // силуэта: за краем гребня начинается совсем другая поверхность. Соединять
  // их линией нельзя, иначе через кадр протягивается ложная «вертикаль».
  const maxStepRad = MAX_RIDGE_SLOPE * stepRad;

  const flush = (): void => {
    if (current.length > 1) segments.push(current);
    current = [];
    prevX = NaN;
    prevV = NaN;
  };

  for (let i = 0; i < prof.length; i++) {
    const v = prof[i];
    if (v === -Infinity || v <= runningMax[i] + eps) {
      flush();
      continue;
    }
    const x = azToX(i * stepRad);
    if (x < -marginX || x > width + marginX) {
      flush();
      continue;
    }
    const y = elevToY(v);
    if (y < -height || y > height * 2) {
      flush();
      continue;
    }
    if (!Number.isNaN(prevX) && Math.abs(x - prevX) > maxGap) flush();
    if (!Number.isNaN(prevV) && Math.abs(v - prevV) > maxStepRad) flush();
    current.push({ x, y });
    prevX = x;
    prevV = v;
  }
  flush();
  return segments;
}

/**
 * Порог децимации точек гребня, px устройства: RDP гарантирует, что каждая
 * отброшенная точка отклоняется от итоговой ломаной не больше порога — на
 * линии в 1.4 CSS px (2.8 px при DPR 2) это невидимо
 */
const RIDGE_SIMPLIFY_PX = 0.5;

/**
 * Прореживание точек сегментов перед stroke — Ramer–Douglas–Peucker.
 * На пологих дугах (снежные хребты) отбрасывается до 90 % точек, на скалистой
 * «пиле» — около трети. Stroke — самая дорогая часть рендера (два прохода:
 * чёрный и белый), децимация режет оба. Острые пики отклоняются от хорд
 * на десятки px и сохраняются вместе с плечами. Итеративно, явным стеком:
 * сегменты доходят до тысячи с лишним точек, и на вырожденных зигзагах
 * рекурсия уперлась бы в глубину стека. Расстояние меряется до ПРЯМОЙ, а не
 * отрезка: внутри сегмента x монотонен (лучи идут по порядку азимутов),
 * проекции точек за концы не вылетают
 */
export function decimateSegments(
  segments: { x: number; y: number }[][],
  epsilonPx = RIDGE_SIMPLIFY_PX,
): { x: number; y: number }[][] {
  return segments.map((pts) => {
    const n = pts.length;
    if (n < 3) return pts;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack: [number, number][] = [[0, n - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop()!;
      const a = pts[i0];
      const b = pts[i1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let maxDev = -1;
      let maxIdx = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const p = pts[i];
        const dev =
          len2 === 0
            ? Math.hypot(p.x - a.x, p.y - a.y)
            : Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / Math.sqrt(len2);
        if (dev > maxDev) {
          maxDev = dev;
          maxIdx = i;
        }
      }
      if (maxDev > epsilonPx) {
        keep[maxIdx] = 1;
        stack.push([i0, maxIdx], [maxIdx, i1]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  });
}

/** Обводка гребня со сдвигом по вертикали (для двойной линии чёрная/белая) */
function strokeRidge(
  ctx: CanvasRenderingContext2D,
  segments: { x: number; y: number }[][],
  offsetY: number,
  style: string,
  lineWidth: number,
): void {
  ctx.beginPath();
  for (const pts of segments) {
    ctx.moveTo(pts[0].x, pts[0].y + offsetY);
    for (let k = 1; k < pts.length - 1; k++) {
      const mx = (pts[k].x + pts[k + 1].x) / 2;
      const my = (pts[k].y + pts[k + 1].y) / 2 + offsetY;
      ctx.quadraticCurveTo(pts[k].x, pts[k].y + offsetY, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y + offsetY);
  }
  ctx.strokeStyle = style;
  ctx.lineWidth = lineWidth;
  // Стыки bevel вместо round: round строит дугу на каждой из тысяч вершин,
  // а на линии 1.4 CSS px разницы не видно. Концы сегментов остаются round —
  // их единицы, и плоский срез на конце обрыва гребня был бы заметен
  ctx.lineJoin = "bevel";
  ctx.lineCap = "round";
  ctx.stroke();
  if (perfEnabled) {
    // Объём геометрии на GPU: по одной обводке — два вызова на профиль
    perfCount("ridgeStrokes");
    let pts = 0;
    for (const s of segments) pts += s.length;
    perfCount("ridgePoints", pts);
  }
}

/** Размещённая подпись в повёрнутой системе координат (все подписи параллельны) */
interface PlacedLabel {
  peak: VisiblePeak;
  /** Точка вершины на силуэте */
  mx: number;
  my: number;
  /** Строки подписи: первая — от выноски, остальные — под ней (дорожки k·LINE_H) */
  lines: { ax: number; ay: number; text: string }[];
  /** Дорожки строк в координатах (v, u) — для проверки пересечений */
  boxes: { v: number; u0: number; u1: number }[];
}

/**
 * Видимая линия силуэта по лучам: максимум по всем гребням и слоям.
 *
 * Раньше геометрия подписей смотрела в `state.horizon` — а это ближняя
 * корзина 0–5 км, которая в горах почти целиком −Infinity (за неё отвечает
 * трава под ногами). Пустые лучи подменялись нулём, то есть линией горизонта:
 * выноска скрытой вершины обрывалась в воздухе, а подпись «поднималась над
 * склоном», которого в этом расчёте не было. Человек же видит в кадре именно
 * верхнюю линию — по ней и работаем.
 *
 * Луч без рельефа остаётся −Infinity: подменять его нулём нельзя (см. выше),
 * потребители переводят его в «силуэт бесконечно низко».
 */
export function silhouetteProfile(state: PanoramaState): Float32Array {
  // Панорама мутируется на месте (Object.assign в worker.onmessage), поэтому
  // кеш привязан к ссылке на horizon: она меняется при каждом новом расчёте,
  // а между ними все поля константны — итоговый массив побитово тот же
  if (
    silhouetteCache &&
    silhouetteCache.horizon === state.horizon &&
    silhouetteCache.crests === state.crests &&
    silhouetteCache.layers === state.layers
  ) {
    return silhouetteCache.out;
  }
  const profiles: (Float32Array | undefined)[] = [
    ...(state.crests ?? []),
    ...(state.layers ?? []),
    state.horizon,
  ];
  const out = new Float32Array(state.horizon.length).fill(-Infinity);
  for (const prof of profiles) {
    if (!prof || prof.length !== out.length) continue;
    for (let i = 0; i < out.length; i++) {
      const v = prof[i];
      if (Number.isFinite(v) && v > out[i]) out[i] = v;
    }
  }
  silhouetteCache = {
    horizon: state.horizon,
    crests: state.crests,
    layers: state.layers,
    out,
  };
  return out;
}

/** Кеш силуэта: ключи — ссылки на массивы панорамы (меняются при пересчёте) */
let silhouetteCache: {
  horizon: Float32Array;
  crests: Float32Array[] | undefined;
  layers: Float32Array[] | undefined;
  out: Float32Array;
} | null = null;

/** Переиспользуемый буфер окклюзии гребней (drawOverlay) */
let runningMaxBuf = new Float32Array(0);

/**
 * Помещается ли отрезок строки подписи в кадр целиком. Отрезок — от якоря
 * вдоль направления текста (толщина ±vh поперёк, обводка включена). Если
 * хоть один угол рамки глифов выходит за край экрана — пусть и на несколько
 * пикселей — отрезок не помещается: обрезанный канвасом хвост «· 12 км»
 * или начало названия выглядят как брак, а не как край кадра. Экран при
 * довороте на крен — повёрнутый прямоугольник, поэтому углы рамки сперва
 * переводятся в экранные координаты (тот же переход, что делает ctx.rotate
 * в rotateAroundCenter) и проверяются на попадание в кадр.
 */
export function labelFullyOnScreen(
  ax: number,
  ay: number,
  w: number,
  ux: number,
  uy: number,
  rollRad: number,
  width: number,
  height: number,
  uiScale: number,
): boolean {
  const vh = 9 * uiScale; // полувысота глифов с обводкой
  const vx = -uy; // ось поперёк текста: перпендикуляр к (ux, uy)
  const vy = ux;
  const corners: [number, number][] = [];
  for (const u of [0, w]) {
    for (const v of [-vh, vh]) {
      corners.push([ax + u * ux + v * vx, ay + u * uy + v * vy]);
    }
  }
  if (rollRad) {
    const c = Math.cos(rollRad);
    const s = Math.sin(rollRad);
    const cx = width / 2;
    const cy = height / 2;
    for (let i = 0; i < corners.length; i++) {
      const [x, y] = corners[i];
      corners[i] = [
        cx + (x - cx) * c - (y - cy) * s,
        cy + (x - cx) * s + (y - cy) * c,
      ];
    }
  }
  return corners.every(
    ([x, y]) => x >= 0 && x <= width && y >= 0 && y <= height,
  );
}

/**
 * Какие части подписи остаются в кадре. Части лежат на одной строке подряд:
 * k-я начинается на prefixW[k] от якоря, последняя кончается на последнем
 * элементе. Часть, уходящая за край кадра, скрывается ЦЕЛИКОМ (вместе со
 * своим « · »), поэтому режем по границам частей: сперва отпадает хвост
 * «· N км», затем «· высота»; название держится, пока влезает само.
 * fits(u0, u1) — помещается ли отрезок строки [u0, u1] вместе с рамкой
 * глифов в кадр. null — не влезла ни одна часть, подпись не ставится.
 */
export function visibleLabelRange(
  prefixW: number[],
  fits: (u0: number, u1: number) => boolean,
): { first: number; last: number } | null {
  let first = 0;
  let last = prefixW.length - 2;
  while (first <= last) {
    if (fits(prefixW[first], prefixW[last + 1])) break;
    // Убираем крайнюю часть, из-за которой отрезок не влезает. Обе стороны
    // могут мешать сразу (название за левым краем, хвост за правым) — режем
    // с двух; если ни одна порознь не виновата (плавающая погрешность на
    // самой границе) — снимаем хвост, обрезок не рисуем.
    const endClears = fits(prefixW[first], prefixW[last]);
    const startClears = fits(prefixW[first + 1], prefixW[last + 1]);
    if (endClears) last--;
    if (startClears) first++;
    if (!endClears && !startClears) last--;
  }
  return first <= last ? { first, last } : null;
}

/**
 * Кеш ширины подписей: measureText на каждую вершину каждый кадр — одна из
 * самых дорогих операций раскладки, а результат зависит только от кегля и
 * строки. Смена языка или региона просто кладёт новые ключи; потолок не даёт
 * кешу расти бесконечно
 */
const labelWidthCache = new Map<string, number>();

function measureLabelWidth(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
): number {
  const key = `${font}|${text}`;
  const cached = labelWidthCache.get(key);
  if (cached !== undefined) return cached;
  perfCount("labelMeasureText"); // реальные measureText (мимо кеша)
  const measured = ctx.measureText(text).width;
  if (labelWidthCache.size >= 4000) labelWidthCache.clear();
  labelWidthCache.set(key, measured);
  return measured;
}

/**
 * Точка переноса названия: фрагмент кончается на end (дефис входит во
 * фрагмент, чтобы остаться в конце строки), следующий начинается со start.
 */
interface NameBreak {
  end: number;
  start: number;
}

/**
 * Разбивка названия по пробелам и дефисам вместе со всеми ширинами
 * фрагментов. Считается один раз на название и кешируется: точки разрыва и
 * ширины от кадра не зависят, а measureText — самая дорогая операция
 * раскладки (в устоявшемся кадре все ширины уже в labelWidthCache).
 */
interface NameTokens {
  breaks: NameBreak[];
  /** prefW[i] — ширина name[0..breaks[i].end); prefW[n] — полная ширина */
  prefW: number[];
  /** tailW[i] — ширина name[breaks[i].start..) */
  tailW: number[];
  /** midW[i][j] — ширина name[breaks[i].start..breaks[j].end), j > i */
  midW: number[][];
}

const nameTokenCache = new Map<string, NameTokens>();

function nameTokens(
  ctx: CanvasRenderingContext2D,
  font: string,
  name: string,
): NameTokens {
  const cached = nameTokenCache.get(name);
  if (cached) return cached;
  const breaks: NameBreak[] = [];
  for (let i = 0; i < name.length && breaks.length < MAX_NAME_BREAKS; i++) {
    const c = name[i];
    if (c !== " " && c !== "-") continue;
    const end = c === "-" ? i + 1 : i; // дефис остаётся в конце строки
    const start = i + 1;
    if (end === 0 || end >= name.length) continue; // пустой фрагмент/хвост
    if (name[start] === " " || name[start] === "-") continue; // слипшиеся разделители
    breaks.push({ end, start });
  }
  const n = breaks.length;
  const prefW: number[] = [];
  for (let i = 0; i < n; i++) {
    prefW.push(measureLabelWidth(ctx, font, name.slice(0, breaks[i].end)));
  }
  prefW.push(measureLabelWidth(ctx, font, name));
  const tailW: number[] = [];
  for (let i = 0; i < n; i++) {
    tailW.push(measureLabelWidth(ctx, font, name.slice(breaks[i].start)));
  }
  const midW: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n).fill(0);
    for (let j = i + 1; j < n; j++) {
      row[j] = measureLabelWidth(
        ctx,
        font,
        name.slice(breaks[i].start, breaks[j].end),
      );
    }
    midW.push(row);
  }
  const tokens: NameTokens = { breaks, prefW, tailW, midW };
  if (nameTokenCache.size >= 500) nameTokenCache.clear();
  nameTokenCache.set(name, tokens);
  return tokens;
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  peaks: VisiblePeak[],
  azToX: (az: number) => number,
  elevToY: (elev: number) => number,
  view: ViewState,
  state: PanoramaState,
  uiScale: number,
  width: number,
  height: number,
): void {
  const labelFont = `${13 * uiScale}px system-ui, sans-serif`;
  ctx.font = labelFont;
  // Обратная проекция экрана в азимут — для обрыва выносок о силуэт
  const xToAz = (x: number): number =>
    view.centerAzRad + ((x - width / 2) / width) * view.fovRad;
  // Видимая линия силуэта: считается один раз на кадр, её спрашивают
  // и подъём подписи, и обрыв выноски, и запасное место маркера
  const silhouette = silhouetteProfile(state);
  const stepRad = state.stepRad;

  // Все подписи под одним углом: так они не пересекают друг друга,
  // их помещается больше, а выноска не режет соседние надписи.
  const theta = (LABEL_ANGLE_DEG * Math.PI) / 180;
  const ux = Math.cos(theta); // ось вдоль текста (вправо-вверх)
  const uy = -Math.sin(theta);
  const vx = Math.sin(theta); // ось поперёк текста
  const vy = Math.cos(theta);

  const LINE_H = 15 * uiScale; // зазор между параллельными «дорожками»
  const LEAD = 7 * uiScale; // отступ от вершины до первой буквы
  const PAD_U = 8 * uiScale; // зазор между подписями вдоль строки

  // Дешёвый отсев по азимуту ДО дорогой раскладки: подпись уходит
  // вправо-вверх от вершины, поэтому вершина правее кадра или глубже
  // левого края, чем длина подписи, заведомо невидима. Запас: длинный
  // текст (~400 px) плюс доворот кадра на крен (rollEdgeMarginX).
  // Раньше все 500+ вершин региона проходили findPeakMarkerPosition
  // (поиск фронта по окну лучей) и проверку видимости — самая дорогая
  // фаза полного рендера
  const xSkipPad = rollEdgeMarginX(width, height, view.rollRad ?? 0, uiScale) +
    400 * uiScale;
  const azimuthNearView = (peak: VisiblePeak): boolean => {
    const x = azToX(peak.azimuthRad);
    return x >= -xSkipPad && x <= width + xSkipPad;
  };

  // Список отсортирован по приоритету (высота + бонус за близость), поэтому
  // при нехватке места остаётся более высокая (и более близкая) вершина.
  const placed: PlacedLabel[] = [];

  /**
   * Отступ от точки скрытой вершины до первой буквы: поднимаемся вдоль строки,
   * пока вся подпись не выйдет из-за загораживающего склона. Её место — сразу
   * над силуэтом: текст поверх склона читался бы как «вершина вот здесь».
   */
  const liftAboveSilhouette = (mx: number, my: number, w: number): number => {
    const STEP = 5 * uiScale;
    const CLEAR = 5 * uiScale; // запас над линией силуэта
    const MAX_LEAD = 260 * uiScale;
    for (let lead = LEAD; lead <= MAX_LEAD; lead += STEP) {
      const ax = mx + ux * lead;
      const ay = my + uy * lead;
      if (ay < LINE_H) break;
      // Проверяем всю строку: склон правее может подниматься круче текста
      let clear = true;
      for (let s = 0; s <= 1; s += 0.25) {
        const x = ax + ux * w * s;
        const y = ay + uy * w * s;
        if (x < 0 || x > width) continue;
        if (
          y >
          horizonAtAzimuth(silhouette, stepRad, xToAz(x), elevToY) - CLEAR
        ) {
          clear = false;
          break;
        }
      }
      if (clear) return lead;
    }
    return MAX_LEAD;
  };

  /** Попытка занять место под подпись. false — не поместилась */
  const tryPlace = (peak: VisiblePeak): boolean => {
    perfCount("labelTries");
    const marker = findPeakMarkerPosition(
      peak,
      state,
      silhouette,
      azToX,
      elevToY,
    );
    if (!marker) return false;
    const { x: mx, y: my } = marker;
    const hidden = peak.visibility === "hidden";
    // Точка скрытой вершины лежит ниже силуэта — она и должна уходить
    // за нижний край, важно лишь чтобы сама подпись попала в кадр
    if (my < 0 || (!hidden && my > height)) return false;

    // Части подписи: название, высота, расстояние. Часть, уходящая за край
    // кадра, скрывается целиком (вместе со своим « · »), остальные остаются
    // на своих местах: сперва отпадает хвост «· N км», затем «· высота» —
    // название держится, пока влезает само.
    const parts = labelParts(peak);
    const partW = parts.map((p) => measureLabelWidth(ctx, labelFont, p));
    const sepW = measureLabelWidth(ctx, labelFont, LABEL_SEP);
    // prefixW[k] — смещение начала k-й части от якоря вдоль строки
    const prefixW = [0];
    for (let k = 0; k < parts.length; k++) {
      prefixW.push(prefixW[k] + partW[k] + (k > 0 ? sepW : 0));
    }
    const fullW = prefixW[parts.length];
    // Ширины info-строки «высота · расстояние» (кладётся отдельной дорожкой)
    const partW2 = partW.slice(1);
    const prefixW2 = [0];
    for (let k = 0; k < partW2.length; k++) {
      prefixW2.push(prefixW2[k] + partW2[k] + (k > 0 ? sepW : 0));
    }

    // Якорь первой буквы. Обычно — сразу над вершиной по направлению текста;
    // для скрытой вершины поднимаемся вдоль строки, пока подпись целиком
    // не выйдет из-за загораживающего склона (её место — над силуэтом).
    const lead = hidden ? liftAboveSilhouette(mx, my, fullW) : LEAD;
    const ax = mx + ux * lead;
    const ay = my + uy * lead;
    if (ay < LINE_H) return false; // подпись ушла бы за верх кадра

    // Базовая точка строки k: дорожки отстоят на LINE_H по поперечной оси v
    const lineBase = (k: number): { x: number; y: number } => ({
      x: ax + k * LINE_H * vx,
      y: ay + k * LINE_H * vy,
    });
    // Помещается ли отрезок строки [u0, u1] на дорожке k целиком в кадр.
    // Проверка — в координатах ЭКРАНА, чтобы крен (rotateAroundCenter) не
    // резал подписи у углов повёрнутого кадра; невидимые части места в
    // кадре не занимают.
    const fitsAt = (k: number, u0: number, u1: number): boolean => {
      const b = lineBase(k);
      return labelFullyOnScreen(
        b.x + u0 * ux,
        b.y + u0 * uy,
        u1 - u0,
        ux,
        uy,
        view.rollRad ?? 0,
        width,
        height,
        uiScale,
      );
    };

    // Пересечение параллельных прямоугольников — это пересечение интервалов
    // по обеим осям повёрнутой системы координат. Вытесненная вершина просто
    // не подписывается: счётчик «+N» рядом с соседней подписью ничего не
    // сообщал (что именно за N — не узнать), но забирал место в кадре
    const conflicts = (
      boxes: { v: number; u0: number; u1: number }[],
    ): boolean =>
      placed.some((p) =>
        p.boxes.some((pb) =>
          boxes.some(
            (b) =>
              Math.abs(pb.v - b.v) < LINE_H &&
              b.u0 < pb.u1 + PAD_U &&
              b.u1 > pb.u0 - PAD_U,
          ),
        ),
      );

    /** Строка-кандидат: дорожка, части и их префиксные ширины */
    interface LineCand {
      k: number;
      parts: string[];
      prefixW: number[];
    }
    /** Отрисованная строка раскладки */
    interface DrawLine {
      ax: number;
      ay: number;
      text: string;
      first: number;
      last: number;
    }
    /**
     * Пробуем раскладку из строк сверху вниз. Каждая строка проходит
     * почастную обрезку краем кадра и проверку своей дорожки; неудачная
     * хвостовая строка (и всё, что под ней) просто отбрасывается, неудачная
     * первая строка — провал всей раскладки.
     */
    const tryLines = (
      lines: LineCand[],
      overhangFirst = false,
    ): {
      draw: DrawLine[];
      boxes: { v: number; u0: number; u1: number }[];
      hang: boolean;
    } | null => {
      // Многострочная подпись якорится нижней строкой: та стоит на обычном
      // LEAD от вершины, выноска к ней остаётся короткой при любом числе
      // строк, а остальные строки уходят от неё вверх — вся пачка выше
      // точки вершины. Сдвиг блока — по поперечной оси (без u-компоненты),
      // поэтому расстояния вдоль строк и центрирование не меняются.
      const bottomK = lines.length - 1;
      const baseOf = (k: number): { x: number; y: number } => ({
        x: ax + (k - bottomK) * LINE_H * vx,
        y: ay + (k - bottomK) * LINE_H * vy,
      });

      // Проход 1: почастная обрезка краем кадра БЕЗ сдвига (как раньше).
      // Обрезать уже сдвинутую строку нельзя: обрезка меняет ширину, ширина
      // меняет сдвиг, сдвиг меняет обрезку — цикл. Поэтому двухфазно.
      const trimmed: {
        line: LineCand;
        range: { first: number; last: number };
        w: number;
        hang: boolean;
      }[] = [];
      for (let i = 0; i < lines.length && i < MAX_LABEL_LINES; i++) {
        const line = lines[i];
        const b = baseOf(line.k);
        const range = visibleLabelRange(line.prefixW, (u0, u1) =>
          labelFullyOnScreen(
            b.x + u0 * ux,
            b.y + u0 * uy,
            u1 - u0,
            ux,
            uy,
            view.rollRad ?? 0,
            width,
            height,
            uiScale,
          ),
        );
        if (!range) {
          // Первая строка может свешиваться за край кадра (канвас обрежет),
          // если кандидат явно попросил: иначе при уходе названия за край
          // подпись схлопывалась бы в одну строку, хотя многострочная
          // структура ещё уместна.
          if (i === 0 && overhangFirst) {
            trimmed.push({
              line,
              range: { first: 0, last: line.parts.length - 1 },
              w: line.prefixW[line.prefixW.length - 1],
              hang: true,
            });
            continue;
          }
          break; // строку и всё, что под ней, отбрасываем
        }
        trimmed.push({
          line,
          range,
          w: line.prefixW[range.last + 1] - line.prefixW[range.first],
          hang: false,
        });
      }
      if (trimmed.length === 0) return null;

      // Проход 2: сдвиги центрирования. Строка 0 — база (выноска ведёт к её
      // первой букве), остальные центрируются под ней: off = (w0 − wk)/2,
      // с округлением до целых пикселей — иначе субпиксельное дрожание ширин
      // из кеша даст мерцание текста между кадрами.
      const off: number[] = [];
      for (let i = 1; i < trimmed.length; i++) {
        off.push(Math.round((trimmed[0].w - trimmed[i].w) / 2));
      }

      // Проход 3: перепроверка со сдвигом. Сдвинутая строка не влезла (в кадр
      // или в свою дорожку) — детерминированный откат к выравниванию влево;
      // если и влево не влезает — строку (и всё ниже) отбрасываем.
      const boxes: { v: number; u0: number; u1: number }[] = [];
      const draw: DrawLine[] = [];
      for (let i = 0; i < trimmed.length; i++) {
        const { line, range, w, hang } = trimmed[i];
        const b = baseOf(line.k);
        const base = b.x * ux + b.y * uy;
        const startU = line.prefixW[range.first];
        let o = i === 0 ? 0 : off[i - 1];
        // Нижняя строка — якорь выноски: левее якоря её не сдвигать, иначе
        // текст накроет кружок вершины и стрелку
        if (i === trimmed.length - 1) o = Math.max(0, o);
        const fits = (s: number): boolean =>
          labelFullyOnScreen(
            b.x + (startU + s) * ux,
            b.y + (startU + s) * uy,
            w,
            ux,
            uy,
            view.rollRad ?? 0,
            width,
            height,
            uiScale,
          );
        const boxOf = (s: number): { v: number; u0: number; u1: number } => ({
          v: b.x * vx + b.y * vy,
          u0: base + startU + s,
          u1: base + startU + s + w,
        });
        let box = boxOf(o);
        // Свешивающаяся строка кадр игнорирует — канвас обрежет сам
        if (!hang && o !== 0 && (!fits(o) || conflicts(boxes.concat([box])))) {
          o = 0;
          box = boxOf(0);
        }
        // fits(0) гарантирован проходом 1 — остаётся проверить дорожку
        if (conflicts(boxes.concat([box]))) {
          if (i === 0) return null;
          break;
        }
        boxes.push(box);
        draw.push({
          ax: b.x + ux * (startU + o),
          ay: b.y + uy * (startU + o),
          text: line.parts.slice(range.first, range.last + 1).join(LABEL_SEP),
          first: range.first,
          last: range.last,
        });
      }
      return { draw, boxes, hang: trimmed.some((t) => t.hang) };
    };

    // Критерий «лучше» (лексикографический): полнота названия (2 — целиком,
    // 1 — обрезано переносом, 0 — нет) > число видимых info-частей (2/1/0) >
    // меньше строк. Подпись стремится к минимуму строк: к одной строке она
    // возвращается, как только края кадра перестают мешать.
    let bestScore = -1;
    // Результат — в поле объекта: к let-переменной, присваиваемой внутри
    // замыкания, TS применяет сужение по инициализатору (null навсегда)
    const result: {
      value: {
        draw: DrawLine[];
        boxes: { v: number; u0: number; u1: number }[];
      } | null;
    } = { value: null };
    const consider = (
      res: {
        draw: DrawLine[];
        boxes: { v: number; u0: number; u1: number }[];
      },
      nameScore: number,
      infoParts: number,
      penalty = 0,
    ): void => {
      const score =
        nameScore * 100 + infoParts * 10 - penalty - res.draw.length;
      if (score > bestScore) {
        bestScore = score;
        result.value = res;
      }
    };

    // A. Одна строка: «Название · высота · расстояние» с почастной обрезкой
    // краем кадра (она же — финальный фолбэк: усечённая строка, если не
    // вышло ничего другого).
    const single = tryLines([{ k: 0, parts, prefixW }]);
    if (single) {
      const nameSeen = single.draw[0].first === 0;
      const infoParts = nameSeen
        ? single.draw[0].last
        : single.draw[0].last - single.draw[0].first + 1;
      consider(single, nameSeen ? 2 : 0, infoParts);
    }

    // B. Двустрочная форма, если под подписью есть свободное место:
    // название первой строкой, «высота · расстояние» — второй, под первой.
    // Название может свешиваться за край кадра (канвас обрежет): иначе при
    // его уходе за край подпись схлопывалась бы в одну строку. Пачка
    // якорится нижней строкой, поэтому и у скрытых вершин — их подпись
    // поднята над склоном — нижняя строка на склон не ложится.
    if (parts.length > 1) {
      const two = tryLines(
        [
          { k: 0, parts: [parts[0]], prefixW: [0, prefixW[1]] },
          { k: 1, parts: parts.slice(1), prefixW: prefixW2 },
        ],
        true,
      );
      if (two) {
        const infoParts =
          two.draw.length === 2
            ? two.draw[1].last - two.draw[1].first + 1
            : 0;
        consider(two, 2, infoParts, two.hang ? 3 : 0);
      }
    }

    // C. Перенос названия по пробелам и дефисам, когда целиком оно в одну
    // строку не влезает: фрагменты складываются друг под другом, info-строка
    // — последней, если для неё есть место. Точка разрыва — жадный
    // максимальный префикс; меньший первый фрагмент только удлиняет хвост,
    // так что первый успешный разрыв — последний проверяемый. Работает и у
    // скрытых вершин: пачка целиком поднята над склоном.
    if (!fitsAt(0, 0, prefixW[1])) {
        const T = nameTokens(ctx, labelFont, parts[0]);
        wrapped: for (let i = T.breaks.length - 1; i >= 0; i--) {
          if (!fitsAt(0, 0, T.prefW[i])) continue;
          const b = T.breaks[i];
          let any = false;

          // 2 фрагмента: остаток названия целиком на второй дорожке
          const twoFrag = tryLines([
            { k: 0, parts: [parts[0].slice(0, b.end)], prefixW: [0, T.prefW[i]] },
            { k: 1, parts: [parts[0].slice(b.start)], prefixW: [0, T.tailW[i]] },
            { k: 2, parts: parts.slice(1), prefixW: prefixW2 },
          ]);
          if (twoFrag) {
            any = true;
            const infoParts =
              twoFrag.draw.length === 3
                ? twoFrag.draw[2].last - twoFrag.draw[2].first + 1
                : 0;
            consider(twoFrag, twoFrag.draw.length >= 2 ? 2 : 1, infoParts);
          }

          // 3 фрагмента: хвост делится на оставшихся разрывах
          for (let j = i + 1; j < T.breaks.length; j++) {
            const bj = T.breaks[j];
            const threeFrag = tryLines([
              { k: 0, parts: [parts[0].slice(0, b.end)], prefixW: [0, T.prefW[i]] },
              {
                k: 1,
                parts: [parts[0].slice(b.start, bj.end)],
                prefixW: [0, T.midW[i][j]],
              },
              { k: 2, parts: [parts[0].slice(bj.start)], prefixW: [0, T.tailW[j]] },
              { k: 3, parts: parts.slice(1), prefixW: prefixW2 },
            ]);
            if (threeFrag) {
              any = true;
              const infoParts =
                threeFrag.draw.length === 4
                  ? threeFrag.draw[3].last - threeFrag.draw[3].first + 1
                  : 0;
              consider(
                threeFrag,
                threeFrag.draw.length >= 3 ? 2 : 1,
                infoParts,
              );
            }
          }
          if (any) break wrapped;
        }
      }

    // D. Перенос не помог (нет точек разрыва или фрагмент всё равно не
    // влезает): полная строка может частично уходить за левый и правый край
    // экрана — ничего не скрываем, лишнее обрежет канвас. Штраф в критерии
    // держит D ниже всех влезающих раскладок (включая перенос), но выше
    // тех, что что-нибудь скрывают.
    const fullBox = {
      v: ax * vx + ay * vy,
      u0: ax * ux + ay * uy,
      u1: ax * ux + ay * uy + fullW,
    };
    if (!conflicts([fullBox])) {
      consider(
        {
          draw: [
            {
              ax,
              ay,
              text: parts.join(LABEL_SEP),
              first: 0,
              last: parts.length - 1,
            },
          ],
          boxes: [fullBox],
        },
        2,
        parts.length - 1,
        5,
      );
    }

    if (!result.value) return false; // ни одна раскладка не влезла — прячем всё

    placed.push({
      peak,
      mx,
      my,
      lines: result.value.draw,
      boxes: result.value.boxes,
    });
    return true;
  };

  // Проход 1: видимые вершины разбирают места первыми — подпись того, что
  // реально видно, всегда важнее подписи того, что за склоном
  for (const peak of peaks) {
    if (peak.visibility === "hidden") continue;
    if (!azimuthNearView(peak)) {
      perfCount("labelSkipped");
      continue;
    }
    tryPlace(peak);
  }

  // Проход 2: скрытые добираются по остаточному бюджету. Чем пустее кадр, тем
  // их больше: на голом склоне подпись «за этим гребнем Эльбрус» — единственная
  // полезная информация, а в плотной панораме она только мешала бы.
  let budget = Math.max(0, HIDDEN_LABEL_BUDGET - placed.length);
  for (const peak of peaks) {
    if (budget <= 0) break;
    if (peak.visibility === "hidden") {
      if (!azimuthNearView(peak)) {
        perfCount("labelSkipped");
        continue;
      }
      if (tryPlace(peak)) budget--;
    }
  }
  perfCount("labelPlaced", placed.length);

  // Рендер: подпись вершины, для которой нашлось место
  for (const p of placed) {
    // Выноска ведёт к нижней строке пачки — она ближе всех к вершине, и
    // стрелка не удлиняется с ростом числа строк
    const anchorLine = p.lines[p.lines.length - 1];
    // Скрытая вершина: выноска обрывается о склон, маркера вершины нет
    const end =
      p.peak.visibility === "hidden"
        ? clipToSilhouette(
            anchorLine.ax,
            anchorLine.ay,
            p.mx,
            p.my,
            silhouette,
            stepRad,
            xToAz,
            elevToY,
          )
        : { x: p.mx, y: p.my };
    drawPeakAnchor(
      ctx,
      end.x,
      end.y,
      anchorLine.ax,
      anchorLine.ay,
      p.peak.visibility,
      uiScale,
    );
    for (const l of p.lines) {
      drawRotatedLabel(
        ctx,
        l.ax,
        l.ay,
        theta,
        l.text,
        p.peak.visibility,
        uiScale,
      );
    }
  }
}

/** Разделитель частей подписи */
const LABEL_SEP = " · ";

/** Части подписи: название, высота, расстояние — собираются через « · ». */
function labelParts(peak: VisiblePeak): string[] {
  const parts = [peakName(peak)];
  if (peak.ele !== undefined) {
    const unit = getLocale() === "ru" ? "м" : "m";
    parts.push(`${Math.round(peak.ele)} ${unit}`);
  }
  const km = (peak.distanceM / 1000).toFixed(peak.distanceM < 10_000 ? 1 : 0);
  const kmUnit = getLocale() === "ru" ? "км" : "km";
  parts.push(`${km} ${kmUnit}`);
  return parts;
}

/**
 * Подпись под фиксированным углом: без плашки, светлый текст с тёмной обводкой.
 * Начало строки — в якоре (первая буква над вершиной), текст уходит вправо-вверх.
 */
function drawRotatedLabel(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  theta: number,
  text: string,
  visibility: "visible" | "onSlope" | "hidden",
  uiScale: number,
): void {
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(-theta);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = 3.5 * uiScale;
  ctx.strokeStyle = INK_DARK;
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = visibility === "hidden" ? INK_LIGHT_DIM : INK_LIGHT;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** Точка на вершине и короткая связка до первой буквы подписи */
function drawPeakAnchor(
  ctx: CanvasRenderingContext2D,
  mx: number,
  my: number,
  ax: number,
  ay: number,
  visibility: "visible" | "onSlope" | "hidden",
  uiScale: number,
): void {
  const hidden = visibility === "hidden";
  ctx.lineCap = "round";
  ctx.setLineDash(hidden ? [3 * uiScale, 3 * uiScale] : []);
  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(ax, ay);
  ctx.strokeStyle = INK_DARK;
  ctx.lineWidth = 3 * uiScale;
  ctx.stroke();
  ctx.strokeStyle = hidden ? INK_LIGHT_DIM : INK_LIGHT;
  ctx.lineWidth = 1.2 * uiScale;
  ctx.stroke();
  ctx.setLineDash([]);

  // Точка-якорь на вершине (только для видимых)
  if (visibility === "visible") {
    ctx.beginPath();
    ctx.arc(mx, my, 3.4 * uiScale, 0, Math.PI * 2);
    ctx.fillStyle = INK_DARK;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(mx, my, 2 * uiScale, 0, Math.PI * 2);
    ctx.fillStyle = INK_LIGHT;
    ctx.fill();
  }
}

/**
 * Высота силуэта на заданном азимуте в пикселях (интерполяция между лучами).
 * `+Infinity` — рельефа на этом азимуте нет вовсе: силуэт «бесконечно низко»,
 * и загораживать он ничего не может.
 */
function horizonAtAzimuth(
  silhouette: Float32Array,
  stepRad: number,
  azRad: number,
  elevToY: (elev: number) => number,
): number {
  // Азимут приходит и отрицательным (обратная проекция экрана) — нормализуем,
  // иначе индекс уходит в минус и высота силуэта становится NaN
  const idx = azRad / stepRad;
  const i0 =
    ((Math.floor(idx) % silhouette.length) + silhouette.length) %
    silhouette.length;
  const i1 = (i0 + 1) % silhouette.length;
  const frac = idx - Math.floor(idx);
  const a0 = silhouette[i0];
  const a1 = silhouette[i1];
  // Дырявый луч не «опускает» силуэт к нулю: берём соседний, а если данных
  // нет вовсе — сообщаем, что рельефа здесь не существует
  if (!Number.isFinite(a0) && !Number.isFinite(a1)) return Infinity;
  if (!Number.isFinite(a0)) return elevToY(a1);
  if (!Number.isFinite(a1)) return elevToY(a0);
  return elevToY(a0 + (a1 - a0) * frac);
}

/**
 * Обрыв выноски о силуэт: идём от подписи к вершине и останавливаемся там,
 * где линия уходит за гребень. Так подпись «привязана» к месту за склоном,
 * а линия не рисует несуществующую вершину поверх рельефа.
 */
function clipToSilhouette(
  ax: number,
  ay: number,
  mx: number,
  my: number,
  silhouette: Float32Array,
  stepRad: number,
  xToAz: (x: number) => number,
  elevToY: (elev: number) => number,
): { x: number; y: number } {
  const STEPS = 24;
  let last = { x: ax, y: ay };
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const x = ax + (mx - ax) * t;
    const y = ay + (my - ay) * t;
    // y растёт вниз: точка ниже линии силуэта — уже за склоном
    if (y > horizonAtAzimuth(silhouette, stepRad, xToAz(x), elevToY)) break;
    last = { x, y };
  }
  return last;
}

/**
 * Точная позиция маркера вершины на силуэте.
 * Алгоритм из промта: матчинг по дистанции фронта, не по углу.
 */
function findPeakMarkerPosition(
  peak: VisiblePeak,
  state: PanoramaState,
  silhouette: Float32Array,
  azToX: (az: number) => number,
  elevToY: (elev: number) => number,
): { x: number; y: number } | null {
  // Скрытая вершина: ставим точку в её истинное положение — оно ниже силуэта,
  // а выноска обрежется о склон (clipToSilhouette). Матчинг по фронтам тут
  // не годится: фронта на этой дистанции нет, он и перекрыл вершину.
  if (peak.visibility === "hidden") {
    return { x: azToX(peak.azimuthRad), y: elevToY(peak.elevationRad) };
  }

  // Запасное место маркера: линия силуэта на азимуте вершины. Рельефа на
  // азимуте может не быть вовсе — тогда маркеру взяться неоткуда
  const onSilhouette = (): { x: number; y: number } | null => {
    const y = horizonAtAzimuth(
      silhouette,
      state.stepRad,
      peak.azimuthRad,
      elevToY,
    );
    return Number.isFinite(y) ? { x: azToX(peak.azimuthRad), y } : null;
  };

  if (!state.layers || !state.fronts) {
    return onSilhouette();
  }

  // Окно азимутов: ширина зависит от дистанции (ближние горы шире)
  const windowRad = Math.max(
    0.009,
    Math.min(0.052, Math.atan2(1500, peak.distanceM)),
  );
  const stepRad = state.stepRad;
  const centerIdx = Math.round(peak.azimuthRad / stepRad);
  const windowRays = Math.ceil(windowRad / stepRad);

  // Ищем фронт, соответствующий дистанции пика
  const distTolerance = Math.max(2000, peak.distanceM * 0.15);
  let best: { az: number; elev: number; score: number } | null = null;

  for (
    let i = Math.max(0, centerIdx - windowRays);
    i <= Math.min(state.fronts.length - 1, centerIdx + windowRays);
    i++
  ) {
    const az = i * stepRad;
    const rayFronts = state.fronts[i];
    if (!rayFronts) continue;

    for (const front of rayFronts) {
      const dDist =
        peak.distanceM < front.distM
          ? front.distM - peak.distanceM
          : peak.distanceM > front.distEndM
            ? peak.distanceM - front.distEndM
            : 0;
      if (dDist > distTolerance) continue;

      const dAz = Math.abs(wrapAngle(az - peak.azimuthRad));
      const score =
        -(dDist / distTolerance) * 0.4 -
        (dAz / windowRad) * 0.3 +
        (front.elevMaxRad / 0.3) * 0.3;

      if (!best || score > best.score) {
        best = { az, elev: front.elevMaxRad, score };
      }
    }
  }

  if (best) {
    return { x: azToX(best.az), y: elevToY(best.elev) };
  }

  // Не нашли фронт — запасной вариант: линия силуэта на азимуте
  return onSilhouette();
}

function cardinal(deg: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  return `${t(names[deg / 45])} ${deg}°`;
}

/** Форматирование азимута для HUD */
export function formatAzimuth(rad: number): string {
  const deg = ((toDeg(rad) % 360) + 360) % 360;
  return `${deg.toFixed(0)}°`;
}
