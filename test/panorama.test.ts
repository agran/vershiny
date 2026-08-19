/**
 * Разбиение силуэта на сегменты: соседние лучи, попавшие на разные
 * поверхности, не должны соединяться ложной «вертикалью» через весь кадр.
 */

import { describe, expect, it } from "vitest";
import {
    buildRidgeSegments,
    labelVisibleOnScreen,
    MAX_RIDGE_SLOPE,
    rollEdgeMarginX,
    silhouetteProfile,
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

  it("торчащая из-за левого края подпись считается видимой", () => {
    // Вершина за краем, текст заходит на экран — подпись плавно выезжает
    expect(labelVisibleOnScreen(-150, 350, 350, UX, UY, 0, W, H, 1)).toBe(true);
  });

  it("полностью невидимая подпись место не занимает", () => {
    // Текст кончается левее края даже с запасом на глифы
    expect(labelVisibleOnScreen(-400, 350, 350, UX, UY, 0, W, H, 1)).toBe(false);
    // И полностью за правым краем — тоже
    expect(labelVisibleOnScreen(1100, 350, 350, UX, UY, 0, W, H, 1)).toBe(false);
  });

  it("при крене видимость считается в координатах экрана, а не оверлея", () => {
    const roll = 0.5;
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    // Верхний левый угол ЭКРАНА в координатах повёрнутого оверлея
    const toOverlay = (sx: number, sy: number): { x: number; y: number } => {
      const X = sx - W / 2;
      const Y = sy - H / 2;
      return { x: W / 2 + X * c + Y * s, y: H / 2 - X * s + Y * c };
    };
    const a = toOverlay(5, 40);
    const w = 40;
    const b = { x: a.x + w * UX, y: a.y + w * UY };
    // Обе точки отрезка — левее нуля в координатах оверлея, но весь отрезок
    // лежит в углу повёрнутого кадра: он видим только с учётом крена
    expect(a.x).toBeLessThan(0);
    expect(b.x).toBeLessThan(0);
    expect(labelVisibleOnScreen(a.x, a.y, w, UX, UY, roll, W, H, 1)).toBe(true);
    // Без доворота тот же отрезок невидим — запас не «панорамный»
    expect(labelVisibleOnScreen(a.x, a.y, w, UX, UY, 0, W, H, 1)).toBe(false);
  });
});
