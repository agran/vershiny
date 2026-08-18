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
  verticalRateFromGyro,
  correctDrift,
  confirmSnap,
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

  it('NaN от датчика не липнет к азимуту', () => {
    // Часть WebView и Firefox for Android кладут NaN в webkitCompassHeading,
    // когда абсолютного азимута нет. Раньше один такой отсчёт превращал
    // азимут в NaN навсегда: diff от NaN — тоже NaN, и рисовать было нечего
    const kept = followAzimuth(deg2rad(100), NaN);
    expect(Number.isFinite(kept)).toBe(true);
    expect(deg(kept)).toBeCloseTo(100, 6);

    // И обратно: испорченное состояние чинится первым же годным показанием
    expect(deg(followAzimuth(NaN, deg2rad(42)))).toBeCloseTo(42, 6);
  });
});

describe('гироскоп: скорость изменения азимута', () => {
  const dps = (degPerSec: number): number => (degPerSec * 180) / Math.PI;

  it('портрет (β=90°): поворот вправо увеличивает азимут', () => {
    // Экран вертикально: земная вертикаль — ось Y устройства, поворот вправо
    // (по часовой сверху) — вращение вокруг −Y → скорость gamma отрицательна
    const rate = verticalRateFromGyro(90, 0, 0, 0, -90);
    expect(dps(rate)).toBeCloseTo(90, 3);
  });

  it('телефон экраном вверх (β=0): поворот вправо увеличивает азимут', () => {
    // Земная вертикаль — ось Z устройства, по часовой сверху — alpha < 0
    const rate = verticalRateFromGyro(0, 0, -90, 0, 0);
    expect(dps(rate)).toBeCloseTo(90, 3);
  });

  it('ландшафт (β=0, γ=90°): поворот вправо увеличивает азимут', () => {
    // Земная вертикаль — ось −X устройства → скорость beta положительна
    const rate = verticalRateFromGyro(0, 90, 0, 90, 0);
    expect(dps(rate)).toBeCloseTo(90, 3);
  });

  it('крен вокруг оси взгляда азимут не меняет', () => {
    // Портрет: вращение вокруг Z устройства (горизонтальной) — чистый крен
    expect(verticalRateFromGyro(90, 0, 90, 0, 0)).toBeCloseTo(0, 6);
    // Ландшафт: крен — тоже вращение вокруг Z устройства
    expect(verticalRateFromGyro(0, 90, 90, 0, 0)).toBeCloseTo(0, 6);
  });

  it('наклон вверх-вниз азимут не меняет', () => {
    // Портрет: подъём/опускание — вращение вокруг X устройства (горизонтальной)
    expect(verticalRateFromGyro(110, 0, 0, 60, 0)).toBeCloseTo(0, 6);
  });
});

describe('комплементарный фильтр: коррекция дрейфа компасом', () => {
  const deg2rad = (d: number): number => (d * Math.PI) / 180;

  it('малое расхождение гасится экспонентой, а не мгновенно', () => {
    // Гироскоп ушёл на 1°: за шаг 0.1 с съедается только ~6% расхождения —
    // кратковременный шум магнитометра в картинку не проходит
    const next = correctDrift(deg2rad(1), 0, 0.1);
    expect(degSigned(next)).toBeGreaterThan(0.8);
    expect(degSigned(next)).toBeLessThan(1);

    // А накопленный дрейф за несколько секунд сходится к компасу
    let v = deg2rad(1);
    for (let i = 0; i < 60; i++) v = correctDrift(v, 0, 0.1);
    expect(Math.abs(degSigned(v))).toBeLessThan(0.05);
  });

  it('большое расхождение принимается сразу: это смена системы отсчёта', () => {
    // Перекалибровка «восьмёркой» или первое absolute после относительных —
    // тянуть 70° секундами было бы хуже, чем один скачок
    expect(deg(correctDrift(deg2rad(10), deg2rad(80), 0.016))).toBeCloseTo(80, 6);
  });

  it('идёт кратчайшим путём через север', () => {
    const next = correctDrift(deg2rad(359), deg2rad(1), 1);
    const d = deg(next);
    expect(d > 358 || d < 2).toBe(true);
  });

  it('NaN от датчика не ломает интеграл', () => {
    expect(deg(correctDrift(deg2rad(100), NaN, 0.1))).toBeCloseTo(100, 6);
    expect(deg(correctDrift(NaN, deg2rad(42), 0.1))).toBeCloseTo(42, 6);
  });

  it('без подтверждения (allowSnap=false) большое расхождение идёт экспонентой', () => {
    // Выброс на 70°, но snap не подтверждён: за шаг 16 мс съедается ~1%
    const next = correctDrift(deg2rad(10), deg2rad(80), 0.016, false);
    expect(degSigned(next)).toBeCloseTo(10 + 70 * (1 - Math.exp(-0.016 / 1.5)), 3);
  });
});

describe('подтверждение скачка компаса (snap)', () => {
  const deg2rad = (d: number): number => (d * Math.PI) / 180;
  const big = deg2rad(25); // за порогом ≈20°

  it('одиночный выброс не подтверждён, серия растёт', () => {
    let s = confirmSnap(0, 0, big);
    expect(s.confirmed).toBe(false);
    expect(s.run).toBe(1);
    s = confirmSnap(s.run, s.dir, big);
    expect(s.confirmed).toBe(false);
    s = confirmSnap(s.run, s.dir, big);
    expect(s.confirmed).toBe(true); // третье подряд — перекалибровка
  });

  it('смена знака сбрасывает серию', () => {
    let s = confirmSnap(0, 0, big);
    s = confirmSnap(s.run, s.dir, big);
    expect(s.run).toBe(2);
    s = confirmSnap(s.run, s.dir, -big); // выброс в другую сторону
    expect(s.run).toBe(1);
    expect(s.confirmed).toBe(false);
  });

  it('возврат под порог сбрасывает серию', () => {
    let s = confirmSnap(0, 0, big);
    s = confirmSnap(s.run, s.dir, big);
    s = confirmSnap(s.run, s.dir, deg2rad(2));
    expect(s.run).toBe(0);
    expect(s.confirmed).toBe(false);
  });
});
