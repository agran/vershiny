/**
 * Разбиение силуэта на сегменты: соседние лучи, попавшие на разные
 * поверхности, не должны соединяться ложной «вертикалью» через весь кадр.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/core/i18n";
import {
  buildRidgeSegments,
  decimateSegments,
  drawOverlay,
  labelFullyOnScreen,
  MAX_RIDGE_SLOPE,
  rollEdgeMarginX,
  segmentsCross,
  segVsAabb,
  silhouetteProfile,
  visibleLabelRange,
  type PanoramaState,
} from "../src/ui/panorama";

const STEP_RAD = (0.1 * Math.PI) / 180; // 3600 лучей
const WIDTH = 1000;
const HEIGHT = 600;

/** Проекции как в drawOverlay, но без вида: 1 луч = 1 пиксель */
const azToX = (az: number): number => (az / STEP_RAD) * 1;
const elevToY = (elev: number): number => 300 - elev * 1000;

function segmentsOf(profile: number[]): { x: number; y: number }[][] {
  const prof = new Float32Array(profile);
  const runningMax = new Float32Array(profile.length).fill(-Infinity);
  return buildRidgeSegments(
    prof,
    runningMax,
    5e-4,
    STEP_RAD,
    azToX,
    elevToY,
    WIDTH,
    HEIGHT,
  );
}

/**
 * Разбиение силуэта на сегменты: соседние лучи, попавшие на разные
 * поверхности, не должны соединяться ложной «вертикалью» через весь кадр.
 */

describe("оверлей в буфере с полями (кэш AR)", () => {
  it("проекция считается от видимой области, а не от поверхности", () => {
    const points: [number, number][] = [];
    const ctx = {
      canvas: { width: 1440, height: 810, clientWidth: 800, clientHeight: 450 },
      beginPath: () => {},
      moveTo: (x: number, y: number) => points.push([x, y]),
      lineTo: () => {},
      stroke: () => {},
      strokeText: () => {},
      fillText: () => {},
      measureText: vi.fn(() => ({ width: 10 })),
      set font(_v: string) {},
      set textAlign(_v: string) {},
      set lineJoin(_v: string) {},
      set lineCap(_v: string) {},
      set strokeStyle(_v: unknown) {},
      set fillStyle(_v: unknown) {},
      set lineWidth(_v: number) {},
      set miterLimit(_v: number) {},
      set globalAlpha(_v: number) {},
    } as unknown as CanvasRenderingContext2D;

    const state = {
      horizon: new Float32Array(0),
      peaks: [],
      stepRad: 0.001,
    } as unknown as PanoramaState;
    const view = {
      centerAzRad: 0,
      tiltRad: 0,
      fovRad: 1,
      fovVRad: 1,
      rollRad: 0,
    } as never;

    drawOverlay(ctx, state, view, 1, {
      labels: false,
      viewWidth: 800,
      viewHeight: 450,
    });

    // Тик шкалы на азимуте 0: x — центр видимой области, y — её горизонт.
    // Без viewWidth/viewHeight горизонт считался бы от буфера (810·0.62),
    // и контуры вместе с ним уезжали за нижний край экрана
    expect(points).toContainEqual([400, 450 * 0.62]);
    const bufferHorizon = points.filter(
      ([, y]) => Math.abs(y - 810 * 0.62) < 0.5,
    );
    expect(bufferHorizon).toHaveLength(0);
  });
});

describe("силуэт: разбиение на сегменты", () => {
  it("плавный гребень остаётся одной линией", () => {
    const smooth = Array.from(
      { length: 40 },
      (_, i) => 0.05 + Math.sin(i / 6) * 0.01,
    );
    const segments = segmentsOf(smooth);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(40);
  });

  it("обрыв гребня рвёт линию, а не рисует вертикаль", () => {
    // Гребень 3°, за его краем — далёкое дно долины под −1°
    const cliff = [
      ...Array.from({ length: 20 }, () => 0.052),
      ...Array.from({ length: 20 }, () => -0.017),
    ];
    const segments = segmentsOf(cliff);
    expect(segments).toHaveLength(2);
    // Ни один сегмент не содержит скачка круче предельной крутизны
    const maxStepY = MAX_RIDGE_SLOPE * STEP_RAD * 1000;
    for (const pts of segments) {
      for (let i = 1; i < pts.length; i++) {
        expect(Math.abs(pts[i].y - pts[i - 1].y)).toBeLessThanOrEqual(
          maxStepY + 1e-6,
        );
      }
    }
  });

  it("перекрытый ближним рельефом участок выпадает из линии", () => {
    const prof = new Float32Array([0.05, 0.05, 0.05, 0.05, 0.05, 0.05]);
    const runningMax = new Float32Array([
      -Infinity,
      -Infinity,
      0.06,
      0.06,
      -Infinity,
      -Infinity,
    ]);
    const segments = buildRidgeSegments(
      prof,
      runningMax,
      5e-4,
      STEP_RAD,
      azToX,
      elevToY,
      WIDTH,
      HEIGHT,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(2);
    expect(segments[1]).toHaveLength(2);
  });
});

describe("видимая линия силуэта", () => {
  const state = (extra: Partial<PanoramaState>): PanoramaState => ({
    horizon: Float32Array.from([-Infinity, -Infinity, -Infinity]),
    stepRad: STEP_RAD,
    peaks: [],
    ...extra,
  });

  it("берёт по каждому лучу самую высокую линию из гребней и слоёв", () => {
    const profile = silhouetteProfile(
      state({
        crests: [Float32Array.from([0.3, 0.05, -Infinity])],
        layers: [Float32Array.from([-Infinity, 0.1, -Infinity])],
      }),
    );

    expect(profile[0]).toBeCloseTo(0.3);
    expect(profile[1]).toBeCloseTo(0.1);
    // Луч, где рельефа нет ни в одном слое, так и остаётся дырой: подменить
    // его нулём значит поставить силуэт на линию горизонта
    expect(profile[2]).toBe(-Infinity);
  });

  it("не спотыкается о профили другой длины", () => {
    // Гребни считаются по тем же 3600 лучам, но подстраховка нужна: чужой
    // длины массив молча сместил бы весь силуэт по азимуту
    const profile = silhouetteProfile(
      state({ crests: [Float32Array.from([0.2, 0.4])], layers: [] }),
    );
    expect(profile.length).toBe(3);
    expect(profile[0]).toBe(-Infinity);
  });

  it("обходится без гребней и слоёв — остаётся ближний горизонт", () => {
    const profile = silhouetteProfile({
      horizon: Float32Array.from([0.02, -Infinity, 0.07]),
      stepRad: STEP_RAD,
      peaks: [],
    });
    expect(profile[0]).toBeCloseTo(0.02);
    expect(profile[2]).toBeCloseTo(0.07);
  });
});

describe("контуры при довороте кадра (крен)", () => {
  it("запас по x удерживает гребень за краем кадра", () => {
    const prof = new Float32Array(30).fill(0.05);
    const runningMax = new Float32Array(30).fill(-Infinity);
    // x от −60 до −31: за пределами дефолтного запаса ±20, но внутри ±60
    const shiftedAzToX = (az: number): number => az / STEP_RAD - 60;
    const noMargin = buildRidgeSegments(
      prof, runningMax, 5e-4, STEP_RAD, shiftedAzToX, elevToY, WIDTH, HEIGHT,
    );
    expect(noMargin).toHaveLength(0);
    const withMargin = buildRidgeSegments(
      prof, runningMax, 5e-4, STEP_RAD, shiftedAzToX, elevToY, WIDTH, HEIGHT, 60,
    );
    expect(withMargin).toHaveLength(1);
    expect(withMargin[0]).toHaveLength(30);
  });

  it("запас покрывает угол повёрнутого кадра при любом крене", () => {
    for (const roll of [0, 0.2, 0.5, 1.0, Math.PI / 2, Math.PI]) {
      const needed =
        (WIDTH * (1 - Math.cos(roll)) +
          HEIGHT * Math.abs(Math.sin(roll))) /
        2;
      expect(rollEdgeMarginX(WIDTH, HEIGHT, roll, 1)).toBeGreaterThanOrEqual(
        needed,
      );
    }
    // Без крена запас не растёт сверх прежних 20 px
    expect(rollEdgeMarginX(WIDTH, HEIGHT, 0, 1)).toBeGreaterThanOrEqual(20);
    expect(rollEdgeMarginX(WIDTH, HEIGHT, 0, 1)).toBeLessThan(30);
  });
});

describe("подписи за краем кадра", () => {
  const W = 1000;
  const H = 600;
  // Направление текста подписи: вправо-вверх под 60°
  const UX = Math.cos(Math.PI / 3);
  const UY = -Math.sin(Math.PI / 3);

  it("полностью поместившаяся подпись ставится", () => {
    // Якорь (600, 400), текст 200 px вправо-вверх: вся рамка глифов в кадре
    expect(labelFullyOnScreen(600, 400, 200, UX, UY, 0, W, H, 1)).toBe(true);
  });

  it("название, торчащее из-за левого края, не помещается", () => {
    // Вершина и начало названия за краем: раньше подпись «выезжала» обрезком
    expect(labelFullyOnScreen(-150, 350, 350, UX, UY, 0, W, H, 1)).toBe(false);
  });

  it("хвост «· км», уходящий за правый край, не помещается", () => {
    // Конец строки выходит на x ≈ 1008 (рамка глифов) — расстояние обрезано
    expect(labelFullyOnScreen(900, 500, 200, UX, UY, 0, W, H, 1)).toBe(false);
  });

  it("отрезок, уходящий за верхний край, не помещается", () => {
    // Верх строки выше нуля: хвост обрезан по верху кадра
    expect(labelFullyOnScreen(200, 20, 300, UX, UY, 0, W, H, 1)).toBe(false);
  });

  it("полностью невидимая подпись место не занимает", () => {
    // Текст кончается левее края даже с запасом на глифы
    expect(labelFullyOnScreen(-400, 350, 350, UX, UY, 0, W, H, 1)).toBe(false);
    // И полностью за правым краем — тоже
    expect(labelFullyOnScreen(1100, 350, 350, UX, UY, 0, W, H, 1)).toBe(false);
  });

  it("при крене вместимость считается в координатах экрана, а не оверлея", () => {
    const roll = 0.5;
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    // Верхний левый угол ЭКРАНА в координатах повёрнутого оверлея
    const toOverlay = (sx: number, sy: number): { x: number; y: number } => {
      const X = sx - W / 2;
      const Y = sy - H / 2;
      return { x: W / 2 + X * c + Y * s, y: H / 2 - X * s + Y * c };
    };
    const a = toOverlay(10, 60);
    const w = 40;
    // Якорь — левее нуля в координатах оверлея, но вся рамка глифов лежит
    // в углу повёрнутого кадра: помещается только с учётом крена
    expect(a.x).toBeLessThan(0);
    expect(labelFullyOnScreen(a.x, a.y, w, UX, UY, roll, W, H, 1)).toBe(true);
    // Без доворота та же рамка целиком левее нуля — подпись не ставится
    expect(labelFullyOnScreen(a.x, a.y, w, UX, UY, 0, W, H, 1)).toBe(false);
  });
});

describe("отсечение частей подписи за краем кадра", () => {
  // Ширины: название 100, высота 150, расстояние 250, разделители по 20
  const PREFIX = [0, 100, 270, 540];
  // fits: отрезок [u0, u1] целиком внутри [left, right] (рамка глифов
  // у реальной проверки шире, для отсечения важно положение границ)
  const makeFits =
    (left: number, right: number) =>
    (u0: number, u1: number): boolean =>
      u0 >= left && u1 <= right;

  it("полностью поместившаяся подпись остаётся целиком", () => {
    expect(visibleLabelRange(PREFIX, makeFits(0, 600))).toEqual({
      first: 0,
      last: 2,
    });
  });

  it("хвост «· км» за краем отпадает, название и высота остаются", () => {
    // Влезает [0, 270]: расстояние целиком за правым краем
    expect(visibleLabelRange(PREFIX, makeFits(0, 300))).toEqual({
      first: 0,
      last: 1,
    });
  });

  it("название за левым краем отпадает, высота и расстояние остаются", () => {
    // Влезает [100, 540]: название целиком за левым краем
    expect(visibleLabelRange(PREFIX, makeFits(100, 1000))).toEqual({
      first: 1,
      last: 2,
    });
  });

  it("при обрезанных обоих концах остаётся середина", () => {
    // Влезает только высота [100, 270]
    expect(visibleLabelRange(PREFIX, makeFits(100, 300))).toEqual({
      first: 1,
      last: 1,
    });
  });

  it("не влезла ни одна часть — подпись не ставится", () => {
    expect(visibleLabelRange(PREFIX, () => false)).toBeNull();
  });
});

describe("многострочная подпись", () => {
  // Названия в ожиданиях — кириллицей, а detectLocale() в jsdom на CI даёт
  // «en»: транслитерация и единицы m/km ломали бы сравнения. Локаль — явно.
  beforeEach(() => setLocale("ru"));
  const W = 1000;
  const H = 600;
  const WIDTHS: Record<string, number> = {
    "Эльбрус": 60,
    "М": 10,
    "5642 м": 58,
    "5.0 км": 55,
    " · ": 20,
    "Длинное Название": 600,
    "Длинное": 250,
    "Название": 300,
    "Джанги-Тау": 600,
    "Джанги-": 250,
    "Тау": 300,
    "Большой Пик": 1900,
    "Большой": 100,
    "Пик": 480,
    "Широкий": 200,
    "Монолит": 1400,
  };

  /** Контекст, который ведёт счёт transform-ов и собирает fillText */
  const makeCtx = (): {
    ctx: CanvasRenderingContext2D;
    texts: { text: string; x: number; y: number; w: number }[];
    segs: { x1: number; y1: number; x2: number; y2: number }[];
  } => {
    const texts: { text: string; x: number; y: number; w: number }[] = [];
    const segs: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const stack: { tx: number; ty: number; rot: number }[] = [];
    let t = { tx: 0, ty: 0, rot: 0 };
    const point = (x: number, y: number): { x: number; y: number } => ({
      x: t.tx + x * Math.cos(t.rot) - y * Math.sin(t.rot),
      y: t.ty + x * Math.sin(t.rot) + y * Math.cos(t.rot),
    });
    let path: { x: number; y: number }[] | null = null;
    let last = { x: 0, y: 0 };
    const widthOf = (text: string): number => {
      const parts = text.split(" · ");
      return (
        parts.reduce((s, p) => s + (WIDTHS[p] ?? 30), 0) +
        (parts.length - 1) * (WIDTHS[" · "] ?? 20)
      );
    };
    const ctx = {
      canvas: { width: W, height: H, clientWidth: W, clientHeight: H },
      save: () => stack.push({ ...t }),
      restore: () => {
        t = stack.pop() ?? t;
      },
      translate: (x: number, y: number) => {
        const c = Math.cos(t.rot);
        const s = Math.sin(t.rot);
        t = { tx: t.tx + x * c - y * s, ty: t.ty + x * s + y * c, rot: t.rot };
      },
      rotate: (r: number) => {
        t = { ...t, rot: t.rot + r };
      },
      fillText: (text: string, x: number, y: number) => {
        const p = point(x, y);
        texts.push({ text: String(text), x: p.x, y: p.y, w: widthOf(String(text)) });
      },
      strokeText: () => {},
      measureText: (s: string) => ({ width: WIDTHS[s] ?? 30 }),
      beginPath: () => {
        path = [];
      },
      moveTo: (x: number, y: number) => {
        last = point(x, y);
      },
      lineTo: (x: number, y: number) => {
        const p = point(x, y);
        if (path) path.push(last, p);
        last = p;
      },
      stroke: () => {
        if (path) {
          for (let i = 0; i + 1 < path.length; i += 2) {
            segs.push({
              x1: path[i].x,
              y1: path[i].y,
              x2: path[i + 1].x,
              y2: path[i + 1].y,
            });
          }
        }
        path = null;
      },
      fill: () => {},
      arc: () => {},
      setLineDash: () => {},
      set font(_v: string) {},
      set textAlign(_v: string) {},
      set textBaseline(_v: string) {},
      set lineJoin(_v: string) {},
      set lineCap(_v: string) {},
      set strokeStyle(_v: unknown) {},
      set fillStyle(_v: unknown) {},
      set lineWidth(_v: number) {},
      set miterLimit(_v: number) {},
      set globalAlpha(_v: number) {},
    } as unknown as CanvasRenderingContext2D;
    return { ctx, texts, segs };
  };

  const state = (horizon: Float32Array, name = "Эльбрус"): PanoramaState =>
    ({
      horizon,
      stepRad: 0.001,
      peaks: [
        {
          azimuthRad: 0.1,
          elevationRad: 0.05,
          distanceM: 5000,
          ele: 5642,
          visibility: "visible",
          name,
        },
      ],
    }) as unknown as PanoramaState;

  const view = {
    centerAzRad: 0.1,
    tiltRad: 0,
    fovRad: 1,
    fovVRad: 1,
    rollRad: 0,
  } as never;

  it("когда всё помещается в одну строку, подпись остаётся одной строкой", () => {
    const horizon = new Float32Array(2000).fill(0.05);
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, state(horizon), view, 1, { ridges: false });

    // Минимум строк: одна строка, пока края кадра не мешают
    expect(
      texts.find((t) => t.text === "Эльбрус · 5642 м · 5.0 км"),
    ).toBeDefined();
    expect(texts.find((t) => t.text === "Эльбрус")).toBeUndefined();
    expect(texts.find((t) => t.text === "5642 м · 5.0 км")).toBeUndefined();
  });

  it("две строки выигрывают, когда хвост не влезает в одну строку", () => {
    // Якорь у правого края: в одной строке « · 5.0 км» обрезается, а на
    // второй строке info-части помещаются целиком
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon, "Широкий");
    (st.peaks[0] as unknown as { azimuthRad: number }).azimuthRad = 0.4265;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    expect(texts.find((t) => t.text === "Широкий")).toBeDefined();
    expect(texts.find((t) => t.text === "5642 м · 5.0 км")).toBeDefined();
    expect(
      texts.find((t) => t.text === "Широкий · 5642 м · 5.0 км"),
    ).toBeUndefined();
    expect(texts.find((t) => t.text === "Широкий · 5642 м")).toBeUndefined();
  });

  it("если перенос не помогает, полная строка уходит за край, ничего не скрывая", () => {
    // Вершина у самого правого края: ни одна раскладка не влезает целиком —
    // ставится полная строка, частично уходящая за правый край
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon);
    (st.peaks[0] as unknown as { azimuthRad: number }).azimuthRad = 0.5525;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    expect(
      texts.find((t) => t.text === "Эльбрус · 5642 м · 5.0 км"),
    ).toBeDefined();
    expect(texts.find((t) => t.text === "Эльбрус")).toBeUndefined();
  });

  it("длинное название без разрывов уходит за оба края, а не скрывается", () => {
    const horizon = new Float32Array(2000).fill(0.05);
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, state(horizon, "Монолит"), view, 1, { ridges: false });

    // Переносить не по чему: название свешивается за оба края кадра,
    // info-строка — под ним, ничего не скрывается
    expect(texts.find((t) => t.text === "Монолит")).toBeDefined();
    expect(texts.find((t) => t.text === "5642 м · 5.0 км")).toBeDefined();
  });

  it("полностью невидимая подпись не ставится — место в кадре не занимает", () => {
    // Вершина за правым краем (x ≈ 1300): ни одна буква не попадает в кадр.
    // Раньше фолбэк D ставил подпись-невидимку, и она забивала дорожки
    // видимым подписям и тратила бюджет скрытых
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon);
    (st.peaks[0] as unknown as { azimuthRad: number }).azimuthRad = 0.9;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    expect(texts.filter((t) => t.text.includes("Эльбрус"))).toHaveLength(0);
  });

  it("нижняя строка не сдвигается левее якоря — стрелка и кружок видны", () => {
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon);
    (st.peaks[0] as unknown as { azimuthRad: number }).azimuthRad = 0.5;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    const info = texts.find((t) => t.text === "5642 м · 5.0 км")!;
    // Якорь 900 + LEAD·ux: центрирование влево (off = −36) нижней строке
    // запрещено — иначе текст накрыл бы кружок вершины и стрелку
    expect(info.x).toBeCloseTo(903.5, 0);
  });

  it("у верхнего края название свешивается, многострочность сохраняется", () => {
    // Горизонт −0.3 рад: якорь у верхнего края — строка названия уходит за
    // край, но подпись остаётся двухстрочной (название + info-строка)
    const horizon = new Float32Array(2000).fill(-0.3);
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, state(horizon, "Монолит"), view, 1, { ridges: false });

    expect(texts.find((t) => t.text === "Монолит")).toBeDefined();
    expect(texts.find((t) => t.text === "5642 м · 5.0 км")).toBeDefined();
    expect(
      texts.find((t) => t.text === "Монолит · 5642 м · 5.0 км"),
    ).toBeUndefined();
  });

  it("название, не влезающее в строку, переносится по пробелу", () => {
    const horizon = new Float32Array(2000).fill(0.05);
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, state(horizon, "Длинное Название"), view, 1, {
      ridges: false,
    });

    // Одна строка не влезает (600 px от x≈503), перенос — влезает:
    // «Длинное» и «Название» на разных дорожках, info — последней строкой
    expect(texts.find((t) => t.text === "Длинное")).toBeDefined();
    expect(texts.find((t) => t.text === "Название")).toBeDefined();
    expect(texts.find((t) => t.text === "5642 м · 5.0 км")).toBeDefined();
    expect(texts.find((t) => t.text === "Длинное Название")).toBeUndefined();
  });

  it("перенос по дефису оставляет дефис в конце первой строки", () => {
    const horizon = new Float32Array(2000).fill(0.05);
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, state(horizon, "Джанги-Тау"), view, 1, {
      ridges: false,
    });

    expect(texts.find((t) => t.text === "Джанги-")).toBeDefined();
    expect(texts.find((t) => t.text === "Тау")).toBeDefined();
    expect(texts.find((t) => t.text === "Джанги-Тау")).toBeUndefined();
  });

  it("перенос работает и для скрытых вершин", () => {
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon, "Длинное Название");
    (st.peaks[0] as unknown as { visibility: string }).visibility = "hidden";
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    expect(texts.find((t) => t.text === "Длинное")).toBeDefined();
    expect(texts.find((t) => t.text === "Название")).toBeDefined();
  });

  it("выноска скрытой вершины обрывается точно на линии силуэта", () => {
    // Ровный горизонт (0.05 рад → y = 342), вершина на 0.03 рад ниже него.
    // Конец выноски должен лечь на линию силуэта, а не висеть в воздухе
    // над склоном — раньше обрыв был на последней пробе ВЫШЕ линии
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon);
    (st.peaks[0] as unknown as { visibility: string }).visibility = "hidden";
    (st.peaks[0] as unknown as { elevationRad: number }).elevationRad = 0.03;
    const { ctx, segs } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    // Мок контекста сбрасывает путь после каждого stroke: в segs попадает
    // только тёмный проход выноски (светлый повторяет тот же путь)
    expect(segs.length).toBe(1);
    const end = segs[0];
    expect(end.y1).toBeCloseTo(342, 0);
    expect(end.x1).toBeCloseTo(506.9, 1);
  });

  // Раньше liftAboveSilhouette при недостижимом клиренсе возвращала MAX_LEAD
  // как фолбэк — неотличимый от честно найденного отступа, и подпись ложилась
  // прямо на склон (то самое «вершина вот здесь», ради отказа от которого
  // подъём и существует) плюс тратила бюджет скрытых.
  it("клиренса нет — подпись скрытой вершины не ставится", () => {
    // Силуэт по всему кадру на 0.4 рад → y = 132. Скрытая вершина на
    // −0.1 рад → y = 432; на любом отступе вплоть до MAX_LEAD начало
    // строки остаётся ниже силуэта
    const horizon = new Float32Array(2000).fill(0.4);
    const st = state(horizon);
    (st.peaks[0] as unknown as { visibility: string }).visibility = "hidden";
    (st.peaks[0] as unknown as { elevationRad: number }).elevationRad = -0.1;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    expect(texts.filter((t) => t.text.includes("Эльбрус"))).toHaveLength(0);
  });

  // Раньше клиренс над силуэтом искался до раскладки, а подъём стопкой
  // сдвигал готовую пачку вдоль −v (влево-вверх, 30° к горизонту) или
  // зеркально (вправо-вверх) без перепроверки клиренса — на склоне круче
  // 30° начало строки возвращалось под силуэт.
  it("подъём стопкой не возвращает подпись скрытой вершины под склон", () => {
    // x = индекс + 400. Стена (0.3 рад → y = 192) левее x = 655, дальше
    // низкий гребень (0.05 рад → y = 342). Сосед занимает естественное
    // место скрытой вершины
    const horizon = new Float32Array(2000);
    for (let i = 0; i < horizon.length; i++) horizon[i] = i < 255 ? 0.3 : 0.05;
    const st = {
      horizon,
      stepRad: 0.001,
      peaks: [
        {
          azimuthRad: 0.26,
          elevationRad: 0.05,
          distanceM: 5000,
          ele: 5642,
          visibility: "visible",
          name: "Сосед",
        },
        {
          azimuthRad: 0.25,
          elevationRad: 0.02,
          distanceM: 5000,
          ele: 5642,
          visibility: "hidden",
          name: "Эльбрус",
        },
      ],
    } as unknown as PanoramaState;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    // Без соседа подъём вдоль строки выводит якорь правее стены
    const solo = { ...st, peaks: [st.peaks[1]] } as unknown as PanoramaState;
    const control = makeCtx();
    drawOverlay(control.ctx, solo, view, 1, { ridges: false });
    const alone = control.texts.find((t) => t.text.startsWith("Эльбрус"))!;
    expect(alone.x).toBeCloseTo(663.5, 0);
    expect(alone.x).toBeGreaterThanOrEqual(655);

    // С соседом обычная сторона ведёт на стену и отсеивается по клиренсу,
    // а чистая зеркальная дорожка стоит дороже, чем подпись (штраф
    // 100/дорожку) — вершина остаётся без подписи, это нормально для
    // тесного места. Главное: подпись не должна возвращаться на стену
    // (x < 655 ниже её верха с запасом CLEAR, y > 187)
    const label = texts.find((t) => t.text.startsWith("Эльбрус"));
    if (label) {
      expect(label.x >= 655 || label.y <= 187).toBe(true);
    }
  });

  it("строки центрируются под первой (по оси текста)", () => {
    const horizon = new Float32Array(2000).fill(0.05);
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, state(horizon, "Длинное Название"), view, 1, {
      ridges: false,
    });

    // Проекция точки на ось текста u (то же, что в раскладке)
    const uOf = (t: { x: number; y: number }): number =>
      t.x * 0.5 - t.y * Math.sin(Math.PI / 3);
    const center = (t: { x: number; y: number }, w: number): number =>
      uOf(t) + w / 2;
    const name = texts.find((t) => t.text === "Длинное")!;
    const tail = texts.find((t) => t.text === "Название")!;
    const info = texts.find((t) => t.text === "5642 м · 5.0 км")!;
    const cName = center(name, WIDTHS["Длинное"]);
    // Сдвиги округляются до целых пикселей — допуск 1 px
    expect(Math.abs(center(tail, WIDTHS["Название"]) - cName)).toBeLessThanOrEqual(1);
    const wInfo =
      WIDTHS["5642 м"] + WIDTHS[" · "] + WIDTHS["5.0 км"];
    expect(Math.abs(center(info, wInfo) - cName)).toBeLessThanOrEqual(1);
  });

  it("в тесной паре подпись уходит на зеркальную сторону, сосед остаётся на якоре", () => {
    // Сосед (М) занимает дорожку 0. Непрерывная укладка не двигает чужие
    // подписи: Эльбрус ищет место сам. Обычный подъём (влево-вверх) уводит
    // выноску в рамку М, поэтому выигрывает зеркальная сторона — пачка
    // уезжает вправо-вверх на дорожку, обе подписи целы, выноски не режут
    // чужой текст
    const horizon = new Float32Array(2000).fill(0.05);
    horizon[194] = 0.05933;
    horizon[195] = 0.05933;
    const st = state(horizon);
    st.peaks = [
      {
        azimuthRad: 0.1946,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "М",
      },
      {
        azimuthRad: 0.2,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "Эльбрус",
      },
    ] as never;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    // Сосед — на естественном якоре своей вершины (маркер на бугорке
    // 0.05933 → my = 336.4, LEAD = 7 → 330.34)
    const pLine = texts.find((t) => t.text === "М · 5642 м · 5.0 км")!;
    expect(pLine).toBeDefined();
    expect(pLine.x).toBeCloseTo(598.1, 0);
    expect(pLine.y).toBeCloseTo(330.34, 0);
    // Эльбрус — одной строкой, правее и выше своего естественного якоря
    // (603.5, 335.94): зеркальный подъём на дорожку даёт (616.5, 328.4)
    const xLine = texts.find((t) => t.text === "Эльбрус · 5642 м · 5.0 км")!;
    expect(xLine).toBeDefined();
    expect(xLine.x).toBeCloseTo(616.5, 0);
    expect(xLine.y).toBeCloseTo(328.4, 0);
  });

  it("тесная пара не разводится за счёт соседа — новичок остаётся без подписи", () => {
    // Вершины почти на одном азимуте (Δx ≈ 7 px, дорожки конфликтуют).
    // Непрерывная укладка двигает только саму подпись: выноска Эльбруса
    // при любом подъёме пересекает рамку М, а поднять соседа некому —
    // кандидат отклоняется, вершина без подписи. Обе подписи М при этом
    // стоят на естественных якорях, ничего не пересекая
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon);
    st.peaks = [
      {
        azimuthRad: 0.3,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "М",
      },
      {
        azimuthRad: 0.545,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "М",
      },
      {
        azimuthRad: 0.307,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "Эльбрус",
      },
    ] as never;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    const mLines = texts.filter((t) => t.text === "М · 5642 м · 5.0 км");
    expect(mLines).toHaveLength(2);
    const xs = mLines.map((t) => t.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(703.5, 0);
    expect(xs[1]).toBeCloseTo(948.5, 0);
    for (const m of mLines) expect(m.y).toBeCloseTo(335.94, 0);

    // Эльбрус не подписан вовсе: выноска не должна резать чужой текст
    expect(texts.filter((t) => t.text.includes("Эльбрус"))).toHaveLength(0);
  });

  it("в кластере из четырёх укладываются двое — остальные без подписи", () => {
    // Четыре вершины почти на одном азимуте. Непрерывная укладка не делает
    // парных разменов и кластерной релаксации: первая подпись занимает
    // якорь, вторая уходит на зеркальную сторону вправо-вверх (обычный
    // подъём упёрся бы в первую), третья и Джанги-Тау не помещаются вовсе
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon);
    st.peaks = [
      {
        azimuthRad: 0.3,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "М",
      },
      {
        azimuthRad: 0.313,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "М",
      },
      {
        azimuthRad: 0.307,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "М",
      },
      {
        azimuthRad: 0.307,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "Джанги-Тау",
      },
    ] as never;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    const mLines = texts.filter((t) => t.text === "М · 5642 м · 5.0 км");
    expect(mLines).toHaveLength(2);
    // Первая — на естественном якоре, вторая — зеркально правее-выше
    const byX = [...mLines].sort((a, b) => a.x - b.x);
    expect(byX[0].x).toBeCloseTo(703.5, 0);
    expect(byX[0].y).toBeCloseTo(335.94, 0);
    expect(byX[1].x).toBeCloseTo(723, 0);
    expect(byX[1].y).toBeCloseTo(332.2, 0);

    // Джанги-Тау подпись не получила: её выноска пересекла бы размещённые
    expect(texts.filter((t) => t.text.includes("Джанги"))).toHaveLength(0);
  });

  it("четыре подписи на одном азимуте — место находится только первой", () => {
    // Четыре одинаковые подписи в 1–3 px друг от друга: вторая и следующие
    // упираются в рамку первой и при обычном, и при зеркальном подъёме
    // (выноска режет уже размещённый текст) — место в кадре только одной.
    // Раньше дискретные зеркальные дорожки давали место трём
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon);
    st.peaks = [0.3, 0.301, 0.302, 0.303].map((az) => ({
      azimuthRad: az,
      elevationRad: 0.05,
      distanceM: 5000,
      ele: 5642,
      visibility: "visible",
      name: "Эльбрус",
    })) as never;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    const full = texts.filter((t) => t.text === "Эльбрус · 5642 м · 5.0 км");
    expect(full).toHaveLength(1);
    expect(full[0].x).toBeCloseTo(703.5, 0);
    expect(full[0].y).toBeCloseTo(335.94, 0);
  });

  it("во время перетаскивания подписи не перекладываются — форма не меняется", () => {
    // «Широкий» у правого края — двухстрочная подпись (хвост не влезает).
    // При перетаскивании взгляд сдвигается, вершина уходит к центру, где
    // полная строка помещается: раскладка должна ЗАМЕРЗНУТЬ (stableLabels),
    // а не схлопнуться в одну строку. В конце жеста — честный пересчёт
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon, "Широкий");
    (st.peaks[0] as unknown as { azimuthRad: number }).azimuthRad = 0.4265;

    // До жеста: две строки
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });
    const name0 = texts.find((t) => t.text === "Широкий");
    const info0 = texts.find((t) => t.text === "5642 м · 5.0 км");
    expect(name0).toBeDefined();
    expect(info0).toBeDefined();

    // Жест: взгляд сдвинут на 0.2 рад, раскладка замёрзла — форма та же,
    // позиции переехали вместе с вершиной (−200 px при fovRad 1 и W=1000)
    const moved = {
      centerAzRad: 0.3,
      tiltRad: 0,
      fovRad: 1,
      fovVRad: 1,
      rollRad: 0,
    } as never;
    const { ctx: ctx2, texts: texts2 } = makeCtx();
    drawOverlay(ctx2, st, moved, 1, { ridges: false, stableLabels: true });
    const name2 = texts2.find((t) => t.text === "Широкий");
    const info2 = texts2.find((t) => t.text === "5642 м · 5.0 км");
    expect(name2).toBeDefined();
    expect(info2).toBeDefined();
    expect(name2!.x).toBeCloseTo(name0!.x - 200, 1);
    expect(info2!.x).toBeCloseTo(info0!.x - 200, 1);
    expect(name2!.y).toBeCloseTo(name0!.y, 1);

    // Конец жеста: пересчёт — в центре кадра всё помещается в одну строку
    const { ctx: ctx3, texts: texts3 } = makeCtx();
    drawOverlay(ctx3, st, moved, 1, { ridges: false });
    expect(
      texts3.find((t) => t.text === "Широкий · 5642 м · 5.0 км"),
    ).toBeDefined();
    expect(texts3.find((t) => t.text === "Широкий")).toBeUndefined();
  });

  it("при смене плотности пикселей замёрзшая раскладка масштабируется, а не перекладывается", () => {
    // Регресс: dragLowRes сбрасывает DPR на время жеста — uiScale менялся,
    // кеш замёрзшей раскладки промахивался, и первый кадр жеста перекладывал
    // подписи заново (видимый прыжок при нажатии, возврат при отпускании).
    // Теперь раскладка масштабируется под текущий uiScale без пересчёта
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon, "Широкий");
    (st.peaks[0] as unknown as { azimuthRad: number }).azimuthRad = 0.4265;

    // Покой: uiScale 2 — у правого края подпись в две строки
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 2, { ridges: false });
    const name0 = texts.find((t) => t.text === "Широкий");
    const info0 = texts.find((t) => t.text === "5642 м · 5.0 км");
    expect(name0).toBeDefined();
    expect(info0).toBeDefined();

    // Нажатие: stableLabels + uiScale 1 — та же форма, но смещения подписи
    // от якоря вершины масштабированы ×0.5 (в моке холст не уменьшается,
    // поэтому якорь остаётся на месте; в приложении DPR-сдвиг уменьшает и
    // якорь — подпись сохраняет своё место в CSS-координатах)
    const mx = 500 + (0.4265 - 0.1) * 1000; // azToX(0.4265)
    const my = 0.62 * 600 - 0.05 * 600; // elevToY(0.05)
    const { ctx: ctx2, texts: texts2 } = makeCtx();
    drawOverlay(ctx2, st, view, 1, { ridges: false, stableLabels: true });
    const name2 = texts2.find((t) => t.text === "Широкий");
    const info2 = texts2.find((t) => t.text === "5642 м · 5.0 км");
    expect(name2).toBeDefined();
    expect(info2).toBeDefined();
    expect(name2!.x).toBeCloseTo(mx + (name0!.x - mx) / 2, 1);
    expect(name2!.y).toBeCloseTo(my + (name0!.y - my) / 2, 1);
    expect(info2!.x).toBeCloseTo(mx + (info0!.x - mx) / 2, 1);
    expect(info2!.y).toBeCloseTo(my + (info0!.y - my) / 2, 1);
  });

  it("сдвиг, выталкивающий строку за край кадра, откатывается к левому выравниванию", () => {
    // Горизонт −0.15 рад: якорь ниже, чтобы хвост (480 px) и подъём пачки
    // на (nLines−1)·LINE_H помещались по высоте
    const horizon = new Float32Array(2000).fill(-0.15);
    const st = state(horizon, "Большой Пик");
    (st.peaks[0] as unknown as { azimuthRad: number }).azimuthRad = -0.34;
    const { ctx, texts } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    const f0 = texts.find((t) => t.text === "Большой")!;
    const tail = texts.find((t) => t.text === "Пик")!;
    // Блок якорится нижней строкой: f0 — двумя дорожками выше якоря,
    // т.е. 63.5 (якорь) − 2·13 (LINE_H·vx)
    expect(f0.x).toBeCloseTo(37.5, 0);
    // Отцентрованный хвост ушёл бы за левый край (off = −190) — откат к 0:
    // база хвоста = якорь − LINE_H·vx = 63.5 − 13
    expect(tail.x).toBeCloseTo(50.5, 0);
  });

  it("выноска не пересекает чужую подпись — кандидат отклоняется целиком", () => {
    // P слева и чуть выше X: рамка P накрывает путь выноски X при любом
    // подъёме пачки. Парного сдвига в непрерывной укладке нет, поэтому X
    // остаётся без подписи: стрелка, режущая соседний текст, хуже
    // отсутствующей подписи
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon);
    st.peaks = [
      {
        azimuthRad: 0.19423, // mx = 594.23: рамка P — точно над путём выноски X
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "М",
      },
      {
        azimuthRad: 0.2,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "Эльбрус",
      },
    ] as never;
    const { ctx, texts, segs } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    // P — одной строкой на естественном якоре
    const pLine = texts.find((t) => t.text === "М · 5642 м · 5.0 км")!;
    expect(pLine).toBeDefined();
    expect(pLine.x).toBeCloseTo(597.7, 0);
    expect(pLine.y).toBeCloseTo(335.94, 0);
    // X не подписан: все его выноски пересекали рамку P
    expect(texts.filter((t) => t.text.includes("Эльбрус"))).toHaveLength(0);
    // Единственная выноска в кадре — сама P: тёмный проход один
    expect(segs.length).toBe(1);
  });

  it("в плотном кластере выноски не пересекают чужие подписи и друг друга", () => {
    // Четыре вершины вплотную: подписи вынуждены разъезжаться по дорожкам,
    // но инвариант держится — выноска не режет чужую подпись и чужую выноску
    const horizon = new Float32Array(2000).fill(0.05);
    const st = state(horizon);
    st.peaks = [
      {
        azimuthRad: 0.2,
        elevationRad: 0.05,
        distanceM: 5000,
        ele: 5642,
        visibility: "visible",
        name: "Эльбрус",
      },
      {
        azimuthRad: 0.204,
        elevationRad: 0.0504,
        distanceM: 5000,
        ele: 5000,
        visibility: "visible",
        name: "Широкий",
      },
      {
        azimuthRad: 0.208,
        elevationRad: 0.0496,
        distanceM: 5000,
        ele: 4800,
        visibility: "visible",
        name: "Казбек",
      },
      {
        azimuthRad: 0.212,
        elevationRad: 0.0508,
        distanceM: 5000,
        ele: 4500,
        visibility: "visible",
        name: "Джанги-Тау",
      },
      {
        azimuthRad: 0.216,
        elevationRad: 0.0501,
        distanceM: 5000,
        ele: 4400,
        visibility: "visible",
        name: "Монолит",
      },
      {
        azimuthRad: 0.220,
        elevationRad: 0.0506,
        distanceM: 5000,
        ele: 4300,
        visibility: "visible",
        name: "Большой Пик",
      },
      {
        azimuthRad: 0.224,
        elevationRad: 0.0498,
        distanceM: 5000,
        ele: 4200,
        visibility: "visible",
        name: "Длинное Название",
      },
      {
        azimuthRad: 0.228,
        elevationRad: 0.0509,
        distanceM: 5000,
        ele: 4100,
        visibility: "visible",
        name: "Крутой",
      },
    ] as never;
    const { ctx, texts, segs } = makeCtx();
    drawOverlay(ctx, st, view, 1, { ridges: false });

    const ux = 0.5;
    const uy = -Math.sin(Math.PI / 3);
    const vx = Math.sin(Math.PI / 3);
    const vy = 0.5;
    const names = [
      "Эльбрус",
      "Широкий",
      "Казбек",
      "Джанги",
      "Монолит",
      "Большой",
      "Длинное",
      "Крутой",
    ];
    // Подписи вершин (шкала и компас отбрасываются)
    const peakTexts = texts.filter(
      (t) =>
        names.some((n) => t.text.includes(n)) ||
        t.text.includes(" м ") ||
        t.text.includes(" км "),
    );
    const boxes = peakTexts.map((t) => ({
      text: t.text,
      u0: t.x * ux + t.y * uy,
      v: t.x * vx + t.y * vy,
      u1: t.x * ux + t.y * uy + t.w,
    }));
    // Идентификатор подписи: строка с именем с тем же якорем. В строку
    // выноски попадают строки той же подписи — их пересечения не считаются
    const labelIdOf = (u0: number, v: number): number => {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (!names.some((n) => b.text.includes(n))) continue;
        if (Math.abs(b.u0 - u0) < 80 && Math.abs(b.v - v) < 60) return i;
      }
      return -1;
    };
    const segHit = (
      s: { x1: number; y1: number; x2: number; y2: number },
      b: { u0: number; u1: number; v: number },
    ): boolean => {
      const u1 = s.x1 * ux + s.y1 * uy;
      const v1 = s.x1 * vx + s.y1 * vy;
      const u2 = s.x2 * ux + s.y2 * uy;
      const v2 = s.x2 * vx + s.y2 * vy;
      if (Math.max(u1, u2) < b.u0 || Math.min(u1, u2) > b.u1) return false;
      if (Math.max(v1, v2) < b.v - 9 || Math.min(v1, v2) > b.v + 9) return false;
      return true;
    };
    const cross = (a: typeof segs[number], b: typeof segs[number]): boolean => {
      const d1 = (b.x1 - a.x1) * (a.y2 - a.y1) - (b.y1 - a.y1) * (a.x2 - a.x1);
      const d2 = (b.x2 - a.x1) * (a.y2 - a.y1) - (b.y2 - a.y1) * (a.x2 - a.x1);
      const d3 = (a.x1 - b.x1) * (b.y2 - b.y1) - (a.y1 - b.y1) * (b.x2 - b.x1);
      const d4 = (a.x2 - b.x1) * (b.y2 - b.y1) - (a.y2 - b.y1) * (b.x2 - b.x1);
      return (
        ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
      );
    };
    // Выноски: сегменты, заканчивающиеся у начала подписи. Каждая рисуется
    // дважды (тёмная и светлая обводка) — дедуплицируем по координатам
    const dedup = new Set<string>();
    const leaders: { s: typeof segs[number]; ti: number }[] = [];
    for (const s of segs) {
      const key = [s.x1, s.y1, s.x2, s.y2].map((v) => v.toFixed(1)).join(",");
      if (dedup.has(key)) continue;
      dedup.add(key);
      const i1 = boxes.findIndex((b) =>
        Math.hypot(
          b.u0 * ux + b.v * vx - s.x1,
          b.u0 * uy + b.v * vy - s.y1,
        ) < 4,
      );
      const i2 = boxes.findIndex((b) =>
        Math.hypot(
          b.u0 * ux + b.v * vx - s.x2,
          b.u0 * uy + b.v * vy - s.y2,
        ) < 4,
      );
      if (i1 >= 0 || i2 >= 0) leaders.push({ s, ti: i1 >= 0 ? i1 : i2 });
    }
    expect(leaders.length).toBeGreaterThanOrEqual(2);

    const ownId = leaders.map((L) => {
      const b = boxes[L.ti];
      return labelIdOf(b.u0, b.v);
    });
    for (let i = 0; i < leaders.length; i++) {
      const L = leaders[i];
      for (let j = 0; j < boxes.length; j++) {
        if (j === L.ti) continue;
        const otherId = labelIdOf(boxes[j].u0, boxes[j].v);
        if (otherId === ownId[i]) continue;
        expect(
          segHit(L.s, boxes[j]),
          `выноска подписи «${boxes[L.ti].text}» пересекает подпись «${boxes[j].text}»`,
        ).toBe(false);
      }
    }
    for (let i = 0; i < leaders.length; i++) {
      for (let j = i + 1; j < leaders.length; j++) {
        if (ownId[i] === ownId[j]) continue;
        expect(
          cross(leaders[i].s, leaders[j].s),
          `выноски подписей «${boxes[leaders[i].ti].text}» и «${boxes[leaders[j].ti].text}» пересекаются`,
        ).toBe(false);
      }
    }
  });
});

describe("пересечения выносок", () => {
  it("отрезок против прямоугольника (slab)", () => {
    const box = { xMin: 0, xMax: 10, yMin: 0, yMax: 10 };
    const hit = (x1: number, y1: number, x2: number, y2: number): boolean =>
      segVsAabb(x1, y1, x2, y2, box.xMin, box.xMax, box.yMin, box.yMax);
    // Насквозь
    expect(hit(-5, 5, 15, 5)).toBe(true);
    // Концами внутри
    expect(hit(2, 2, 8, 8)).toBe(true);
    // Мимо
    expect(hit(-5, 5, -1, 5)).toBe(false);
    expect(hit(5, 11, 5, 20)).toBe(false);
    // Параллелен грани и снаружи
    expect(hit(5, 15, 5, 25)).toBe(false);
  });

  it("пересечение двух отрезков — строгое, без касаний", () => {
    expect(segmentsCross(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
    expect(segmentsCross(0, 0, 10, 0, 0, 5, 10, 5)).toBe(false); // параллельны
    expect(segmentsCross(0, 0, 10, 10, 10, 10, 20, 20)).toBe(false); // касание
    expect(segmentsCross(0, 0, 1, 1, 5, 5, 6, 6)).toBe(false);
  });
});

describe("децимация точек гребня", () => {
  it("прямая линия схлопывается до концов", () => {
    const line = Array.from({ length: 20 }, (_, i) => ({ x: i * 4, y: i * 2 }));
    const out = decimateSegments([line]);
    expect(out[0]).toHaveLength(2);
    expect(out[0][0]).toEqual({ x: 0, y: 0 });
    expect(out[0][1]).toEqual({ x: 76, y: 38 });
  });

  it("острый пик сохраняется, а пологие хвосты схлопываются", () => {
    const peak = [
      ...Array.from({ length: 20 }, (_, i) => ({ x: i * 4, y: 100 })),
      { x: 80, y: 20 }, // вершина: отклонение от любой хорды — десятки px
      ...Array.from({ length: 20 }, (_, i) => ({ x: 84 + i * 4, y: 100 })),
    ];
    const out = decimateSegments([peak]);
    expect(out[0]).toContainEqual({ x: 80, y: 20 });
    // Остались концы, пик и по точке-плечу рядом с ним (их отклонение от
    // крутых хорд велико законно), всё остальное схлопнулось
    expect(out[0]).toHaveLength(5);
    expect(out[0][0]).toEqual({ x: 0, y: 100 });
    expect(out[0][4]).toEqual({ x: 160, y: 100 });
  });

  it("концы сегмента и короткие сегменты не трогаются", () => {
    const two = [{ x: 0, y: 0 }, { x: 10, y: 5 }];
    const out = decimateSegments([two]);
    expect(out[0]).toHaveLength(2);
    // Конец сегмента — это обрыв гребня: его положение точное
    const out2 = decimateSegments([
      [
        { x: 0, y: 0 },
        { x: 4, y: 0.2 },
        { x: 8, y: 0 },
      ],
    ]);
    expect(out2[0][out2[0].length - 1]).toEqual({ x: 8, y: 0 });
  });

  it("ошибка децимации ограничена порогом на любой форме", () => {
    // Дуга окружности R=200: каждая тройка почти коллинеарна, но дуга длинная
    const arc = Array.from({ length: 100 }, (_, i) => {
      const x = i * 4;
      return { x, y: 200 - Math.sqrt(200 * 200 - (x - 200) ** 2) || 0 };
    });
    const out = decimateSegments([arc], 0.5)[0];
    expect(out.length).toBeLessThan(arc.length);
    // RDP гарантирует: каждая исходная точка в пределах ε от итоговой ломаной
    // (плюс щель на округление float)
    for (const p of arc) {
      let minDist = Infinity;
      for (let k = 1; k < out.length; k++) {
        const a = out[k - 1];
        const b = out[k];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (!len2) continue;
        const t = Math.max(
          0,
          Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
        );
        const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
        if (d < minDist) minDist = d;
      }
      expect(minDist).toBeLessThanOrEqual(0.51);
    }
  });

  it("ручной проход по keep даёт те же точки, что filter (эталон)", () => {
    // Эталонная копия прежней реализации с pts.filter((_, i) => keep[i]):
    // набор и порядок точек обязаны совпасть побитово на сложных сегментах
    const refDecimate = (
      segments: { x: number; y: number }[][],
      epsilonPx: number,
    ): { x: number; y: number }[][] =>
      segments.map((pts) => {
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
                : Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) /
                  Math.sqrt(len2);
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

    // Пилообразный гребень и плавная дуга
    const saw = Array.from({ length: 300 }, (_, i) => ({
      x: i * 2,
      y: 50 + ((i % 17) - 8) * ((i * 13) % 5) + Math.sin(i * 0.31) * 40,
    }));
    const arc = Array.from({ length: 200 }, (_, i) => {
      const x = i * 3;
      return { x, y: 120 - Math.sqrt(14400 - (x - 300) ** 2) || 0 };
    });
    for (const eps of [0.1, 0.5, 2]) {
      expect(decimateSegments([saw, arc], eps)).toEqual(
        refDecimate([saw, arc], eps),
      );
    }
  });
});
