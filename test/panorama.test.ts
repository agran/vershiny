/**
 * Разбиение силуэта на сегменты: соседние лучи, попавшие на разные
 * поверхности, не должны соединяться ложной «вертикалью» через весь кадр.
 */

import { describe, it, expect } from 'vitest';
import { buildRidgeSegments, MAX_RIDGE_SLOPE } from '../src/ui/panorama';

const STEP_RAD = (0.1 * Math.PI) / 180; // 3600 лучей
const WIDTH = 1000;
const HEIGHT = 600;

/** Проекции как в drawOverlay, но без вида: 1 луч = 1 пиксель */
const azToX = (az: number): number => (az / STEP_RAD) * 1;
const elevToY = (elev: number): number => 300 - elev * 1000;

function segmentsOf(profile: number[]): { x: number; y: number }[][] {
  const prof = new Float32Array(profile);
  const runningMax = new Float32Array(profile.length).fill(-Infinity);
  return buildRidgeSegments(prof, runningMax, 5e-4, STEP_RAD, azToX, elevToY, WIDTH, HEIGHT);
}

describe('силуэт: разбиение на сегменты', () => {
  it('плавный гребень остаётся одной линией', () => {
    const smooth = Array.from({ length: 40 }, (_, i) => 0.05 + Math.sin(i / 6) * 0.01);
    const segments = segmentsOf(smooth);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(40);
  });

  it('обрыв гребня рвёт линию, а не рисует вертикаль', () => {
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
        expect(Math.abs(pts[i].y - pts[i - 1].y)).toBeLessThanOrEqual(maxStepY + 1e-6);
      }
    }
  });

  it('перекрытый ближним рельефом участок выпадает из линии', () => {
    const prof = new Float32Array([0.05, 0.05, 0.05, 0.05, 0.05, 0.05]);
    const runningMax = new Float32Array([-Infinity, -Infinity, 0.06, 0.06, -Infinity, -Infinity]);
    const segments = buildRidgeSegments(
      prof, runningMax, 5e-4, STEP_RAD, azToX, elevToY, WIDTH, HEIGHT,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(2);
    expect(segments[1]).toHaveLength(2);
  });
});
