/**
 * Разбиение силуэта на сегменты: соседние лучи, попавшие на разные
 * поверхности, не должны соединяться ложной «вертикалью» через весь кадр.
 */

import { describe, it, expect } from "vitest";
import {
  buildRidgeSegments,
  silhouetteProfile,
  MAX_RIDGE_SLOPE,
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
