import { describe, expect, it } from 'vitest';
import {
  decodeTerrarium,
  lonLatToPixel,
  lonLatToTile,
  zoomForDistance,
} from '../src/core/terrarium';

describe('terrarium', () => {
  it('slippy-конверсия: Эльбрус z15 → x=20246 y=11996', () => {
    const t = lonLatToTile({ lat: 43.35, lon: 42.44 }, 15);
    expect(t).toEqual({ x: 20246, y: 11996 });
  });

  it('slippy-конверсия: углы карты z0 → единственный тайл', () => {
    expect(lonLatToTile({ lat: 0, lon: 0 }, 0)).toEqual({ x: 0, y: 0 });
    expect(lonLatToTile({ lat: 85, lon: 179.9 }, 1)).toEqual({ x: 1, y: 0 });
    expect(lonLatToTile({ lat: -85, lon: -179.9 }, 1)).toEqual({ x: 0, y: 1 });
  });

  it('декодирование: h = R·256 + G + B/256 − 32768', () => {
    // 5642 м: 5642 + 32768 = 38410 = 150·256 + 10 + 0/256
    expect(decodeTerrarium(150, 10, 0)).toBeCloseTo(5642, 6);
    // Дробная часть: 0.5 м = 128/256
    expect(decodeTerrarium(150, 10, 128)).toBeCloseTo(5642.5, 6);
    // Мёртвое море −430 м: −430 + 32768 = 32338 = 126·256 + 82
    expect(decodeTerrarium(126, 82, 2)).toBeCloseTo(-430 + 2 / 256, 6);
  });

  it('выбор зума по дальности', () => {
    expect(zoomForDistance(1_000)).toBe(12);
    expect(zoomForDistance(5_000)).toBe(11);
    expect(zoomForDistance(30_000)).toBe(10);
    expect(zoomForDistance(150_000)).toBe(9);
  });

  it('пиксельная позиция в пределах тайла', () => {
    const { px, py } = lonLatToPixel({ lat: 43.35, lon: 42.44 }, 15);
    expect(px).toBeGreaterThanOrEqual(0);
    expect(px).toBeLessThan(256);
    expect(py).toBeGreaterThanOrEqual(0);
    expect(py).toBeLessThan(256);
  });
});
