/**
 * Автокалибровка по кадру: линия неба из картинки и её совмещение с горизонтом.
 *
 * Проверяется главное свойство: если камеру «повернуть» на известный угол,
 * алгоритм должен вернуть ровно этот угол обратно. Кадр рисуется синтетически
 * по тому же профилю рельефа, поэтому настоящая камера для теста не нужна.
 */

import { describe, it, expect } from 'vitest';
import {
  extractSkyline,
  matchSkyline,
  MIN_CONFIDENCE,
  type SkylineMatchOptions,
} from '../src/core/skyline';

const deg = (d: number): number => (d * Math.PI) / 180;

/** Горизонт с узнаваемым гребнем: две вершины и седловина между ними */
function makeHorizon(rays = 3600): Float32Array {
  const horizon = new Float32Array(rays);
  for (let i = 0; i < rays; i++) {
    const az = (i / rays) * 2 * Math.PI;
    horizon[i] =
      deg(4) * Math.sin(az * 3) +
      deg(7) * Math.exp(-(((az - 1.0) / 0.12) ** 2)) +
      deg(5) * Math.exp(-(((az - 1.35) / 0.08) ** 2));
  }
  return horizon;
}

const HORIZON = makeHorizon();
const STEP = (2 * Math.PI) / HORIZON.length;

const VIEW: Omit<SkylineMatchOptions, 'centerAzRad' | 'tiltRad'> = {
  fovRad: deg(70),
  fovVRad: deg(40),
  horizonFrac: 0.62,
  horizon: HORIZON,
  stepRad: STEP,
};

/**
 * Синтетический кадр: небо сверху, земля снизу, граница — тот же горизонт,
 * снятый камерой, которая на самом деле смотрит в azTrue с наклоном tiltTrue.
 */
function renderFrame(
  azTrue: number,
  tiltTrue: number,
  width = 320,
  height = 240,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    const az = azTrue + ((x + 0.5) / width - 0.5) * VIEW.fovRad;
    const idx = az / STEP;
    const i0 = Math.floor(idx);
    const f = idx - i0;
    const a = HORIZON[((i0 % HORIZON.length) + HORIZON.length) % HORIZON.length];
    const b = HORIZON[(((i0 + 1) % HORIZON.length) + HORIZON.length) % HORIZON.length];
    const elev = a + (b - a) * f;
    const yFrac = VIEW.horizonFrac - (elev - tiltTrue) / VIEW.fovVRad;
    const boundary = Math.round(yFrac * height);
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      const sky = y < boundary;
      // Небо — светло-синее, земля — тёмно-серая
      rgba[i] = sky ? 150 : 70;
      rgba[i + 1] = sky ? 180 : 68;
      rgba[i + 2] = sky ? 235 : 62;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe('линия неба из кадра', () => {
  it('находит границу неба и земли', () => {
    const frame = renderFrame(deg(60), 0);
    const profile = extractSkyline(frame, 320, 240);
    const defined = [...profile].filter((v) => !Number.isNaN(v));
    expect(defined.length).toBeGreaterThan(profile.length * 0.9);
    // Граница около линии горизонта кадра, а не у краёв
    for (const v of defined) {
      expect(v).toBeGreaterThan(0.05);
      expect(v).toBeLessThan(0.95);
    }
  });

  it('на однородном кадре честно говорит «не знаю»', () => {
    const flat = new Uint8ClampedArray(320 * 240 * 4).fill(120);
    const profile = extractSkyline(flat, 320, 240);
    const defined = [...profile].filter((v) => !Number.isNaN(v));
    expect(defined.length).toBe(0);
  });
});

describe('совмещение кадра с рельефом', () => {
  it('возвращает поправку, на которую врал компас', () => {
    const azTrue = deg(60);
    const compassError = deg(8); // компас показывает на 8° меньше правды
    const frame = renderFrame(azTrue, 0);
    const profile = extractSkyline(frame, 320, 240);

    const match = matchSkyline(profile, {
      ...VIEW,
      centerAzRad: azTrue - compassError,
      tiltRad: 0,
    });

    expect(match.confidence).toBeGreaterThan(MIN_CONFIDENCE);
    expect((match.azimuthRad * 180) / Math.PI).toBeCloseTo(8, 0);
  });

  it('ловит и наклон, и азимут разом', () => {
    const azTrue = deg(75);
    const frame = renderFrame(azTrue, deg(3));
    const profile = extractSkyline(frame, 320, 240);

    const match = matchSkyline(profile, {
      ...VIEW,
      centerAzRad: azTrue - deg(5),
      tiltRad: 0,
    });

    // Поправка — это то, что надо прибавить к показаниям датчиков: камера
    // на самом деле смотрит на 5° правее и на 3° выше, чем они говорят
    expect(match.confidence).toBeGreaterThan(MIN_CONFIDENCE);
    expect((match.azimuthRad * 180) / Math.PI).toBeCloseTo(5, 0);
    expect((match.tiltRad * 180) / Math.PI).toBeCloseTo(3, 0);
  });

  it('не верит ровному горизонту: там совпадает любой азимут', () => {
    const flatHorizon = new Float32Array(HORIZON.length); // море до края света
    const frame = renderFrame(deg(60), 0);
    const profile = extractSkyline(frame, 320, 240);

    const match = matchSkyline(profile, {
      ...VIEW,
      horizon: flatHorizon,
      centerAzRad: deg(60),
      tiltRad: 0,
    });

    expect(match.confidence).toBeLessThan(MIN_CONFIDENCE);
  });

  it('переживает облако на половину кадра', () => {
    const azTrue = deg(60);
    const width = 320;
    const height = 240;
    const frame = renderFrame(azTrue, 0, width, height);
    // Половина колонок засвечена: граница там уедет к верху кадра
    for (let x = 0; x < width / 2; x++) {
      for (let y = 0; y < height; y++) {
        const i = (y * width + x) * 4;
        frame[i] = frame[i + 1] = frame[i + 2] = y < height * 0.2 ? 250 : 245;
      }
    }
    const profile = extractSkyline(frame, width, height);
    const match = matchSkyline(profile, {
      ...VIEW,
      centerAzRad: azTrue - deg(6),
      tiltRad: 0,
    });

    // Медианная ошибка не даёт испорченной половине увести результат
    expect((match.azimuthRad * 180) / Math.PI).toBeCloseTo(6, 0);
  });
});
