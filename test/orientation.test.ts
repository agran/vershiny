/**
 * Ориентация устройства: куда смотрит человек сквозь экран.
 *
 * Главное, что здесь проверяется, — поворот телефона в горизонтальное
 * положение. У поднятого вертикально телефона beta ≈ 90°, и в этой точке
 * alpha с gamma вырождаются: разворот вокруг оси взгляда меняет alpha на 90°,
 * хотя смотрит человек в ту же сторону.
 */

import { describe, it, expect } from 'vitest';
import {
  lookFromDeviceOrientation,
  isAbsoluteReading,
  followAzimuth,
} from '../src/core/orientation';

const deg = (rad: number): number => ((rad * 180) / Math.PI + 360) % 360;
const degSigned = (rad: number): number => (rad * 180) / Math.PI;

describe('направление взгляда по датчику ориентации', () => {
  it('телефон поднят вертикально: азимут = alpha, горизонт по центру', () => {
    // beta = 90° — экран к лицу, смотрим прямо перед собой
    const north = lookFromDeviceOrientation(0, 90, 0);
    expect(deg(north.azimuthRad)).toBeCloseTo(0, 1);
    expect(degSigned(north.elevationRad)).toBeCloseTo(0, 1);

    const east = lookFromDeviceOrientation(270, 90, 0);
    expect(deg(east.azimuthRad)).toBeCloseTo(90, 1);

    const south = lookFromDeviceOrientation(180, 90, 0);
    expect(deg(south.azimuthRad)).toBeCloseTo(180, 1);
  });

  it('поворот в ландшафт не меняет азимут', () => {
    // Тот же взгляд на север, но телефон повёрнут на 90° вокруг оси взгляда:
    // alpha уходит на 90°, beta падает до нуля, работать начинает gamma
    const portrait = lookFromDeviceOrientation(0, 90, 0);
    const landscapeLeft = lookFromDeviceOrientation(90, 0, -90);
    const landscapeRight = lookFromDeviceOrientation(270, 0, 90);

    expect(deg(landscapeLeft.azimuthRad)).toBeCloseTo(deg(portrait.azimuthRad), 1);
    expect(deg(landscapeRight.azimuthRad)).toBeCloseTo(deg(portrait.azimuthRad), 1);
    expect(degSigned(landscapeLeft.elevationRad)).toBeCloseTo(0, 1);
    expect(degSigned(landscapeRight.elevationRad)).toBeCloseTo(0, 1);
  });

  it('наклон вверх и вниз читается в обеих ориентациях', () => {
    // Портрет: подняли телефон на 20° к небу
    const upPortrait = lookFromDeviceOrientation(0, 110, 0);
    expect(degSigned(upPortrait.elevationRad)).toBeCloseTo(20, 1);

    const downPortrait = lookFromDeviceOrientation(0, 70, 0);
    expect(degSigned(downPortrait.elevationRad)).toBeCloseTo(-20, 1);

    // Ландшафт: тот же подъём описывается отклонением gamma от прямого угла,
    // beta в этом положении на наклон уже не влияет
    const upLandscape = lookFromDeviceOrientation(90, 0, -110);
    expect(degSigned(upLandscape.elevationRad)).toBeCloseTo(20, 1);
    expect(deg(upLandscape.azimuthRad)).toBeCloseTo(0, 1);

    const downLandscape = lookFromDeviceOrientation(90, 0, -70);
    expect(degSigned(downLandscape.elevationRad)).toBeCloseTo(-20, 1);
  });

  it('телефон лежит экраном вверх: взгляд сквозь экран идёт в стол', () => {
    const flat = lookFromDeviceOrientation(0, 0, 0);
    expect(degSigned(flat.elevationRad)).toBeCloseTo(-90, 1);
  });
});

describe('выбор источника азимута', () => {
  it('при наличии абсолютного игнорирует относительное событие', () => {
    // Android шлёт оба события: absolute — от севера, обычное — от
    // произвольного нуля. Вперемешку они дёргают панораму на десятки градусов
    expect(isAbsoluteReading('deviceorientationabsolute', false, true, false)).toBe(true);
    expect(isAbsoluteReading('deviceorientation', false, false, true)).toBe(false);
  });

  it('пока абсолютного нет, берёт что есть', () => {
    expect(isAbsoluteReading('deviceorientation', false, false, false)).toBe(true);
  });

  it('iOS: webkitCompassHeading абсолютен, хотя событие обычное', () => {
    expect(isAbsoluteReading('deviceorientation', true, false, true)).toBe(true);
  });

  it('флаг absolute у обычного события тоже считается', () => {
    expect(isAbsoluteReading('deviceorientation', false, true, true)).toBe(true);
  });
});

describe('слежение за компасом', () => {
  const deg2rad = (d: number): number => (d * Math.PI) / 180;

  it('гасит дрожание датчика', () => {
    // Компас шумит на ±1–2° даже в покое: картинка не должна метаться
    let view = deg2rad(100);
    for (let i = 0; i < 20; i++) {
      const noisy = deg2rad(100 + (i % 2 === 0 ? 1.5 : -1.5));
      view = followAzimuth(view, noisy);
    }
    expect(Math.abs(degSigned(view) - 100)).toBeLessThan(0.5);
  });

  it('отрабатывает настоящий поворот за несколько кадров', () => {
    let view = deg2rad(0);
    for (let i = 0; i < 8; i++) view = followAzimuth(view, deg2rad(90));
    expect(deg(view)).toBeGreaterThan(85);
  });

  it('идёт кратчайшим путём через север', () => {
    // 350° → 10° — это +20°, а не −340°
    const next = followAzimuth(deg2rad(350), deg2rad(10));
    const d = deg(next);
    expect(d > 350 || d < 20).toBe(true);
  });
});
