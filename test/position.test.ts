// @vitest-environment jsdom
/**
 * Откуда берётся положение наблюдателя и когда ему можно верить.
 *
 * Главное здесь — не сам вызов геолокации, а отказ: приложению нужно что-то
 * показать, поэтому есть запасная точка. Но она выдумана, и если обращаться
 * с ней как с настоящим положением, человек, которому просто не дали доступ
 * к геолокации, получает предложение сменить район на Приэльбрусье.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getPosition,
  FALLBACK_POSITION,
  GPS_TIMEOUT_MS,
} from '../src/core/position';

/** Геолокация, которая отвечает заданным образом */
function geo(
  behaviour: 'success' | 'error' | 'silent',
  coords = { latitude: 46.5, longitude: 8.0 },
): Geolocation {
  return {
    getCurrentPosition: (ok, fail) => {
      if (behaviour === 'success') ok({ coords } as GeolocationPosition);
      if (behaviour === 'error') fail?.({ code: 1 } as GeolocationPositionError);
    },
    watchPosition: () => 0,
    clearWatch: () => {},
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('положение наблюдателя', () => {
  it('координаты из ссылки — настоящие: их задал человек', async () => {
    const fix = await getPosition({
      search: '?lat=43.35&lon=42.44',
      geolocation: geo('error'),
    });

    expect(fix.pos).toEqual({ lat: 43.35, lon: 42.44 });
    expect(fix.trusted).toBe(true);
  });

  it('мусор в ссылке не принимается за положение', async () => {
    // ?lat=999 иначе молча ломает весь ray-marching
    const fix = await getPosition({
      search: '?lat=999&lon=42.44',
      geolocation: geo('success'),
    });

    expect(fix.pos).toEqual({ lat: 46.5, lon: 8.0 }); // ушли к спутникам
    expect(fix.trusted).toBe(true);
  });

  it('спутниковый фикс — настоящее положение', async () => {
    const fix = await getPosition({ search: '', geolocation: geo('success') });

    expect(fix.pos).toEqual({ lat: 46.5, lon: 8.0 });
    expect(fix.trusted).toBe(true);
  });

  it('отказ в геолокации даёт запасную точку, но доверия ей нет', async () => {
    // По такой точке нельзя ни менять активный регион, ни заявлять «Вы в
    // районе Приэльбрусья» человеку, который стоит в Альпах
    const fix = await getPosition({ search: '', geolocation: geo('error') });

    expect(fix.pos).toEqual(FALLBACK_POSITION);
    expect(fix.trusted).toBe(false);
  });

  it('без самой геолокации — то же самое', async () => {
    const fix = await getPosition({ search: '', geolocation: null });

    expect(fix.pos).toEqual(FALLBACK_POSITION);
    expect(fix.trusted).toBe(false);
  });

  it('молчание датчика не оставляет приложение висеть навсегда', async () => {
    // Часть браузеров не зовёт обработчик ошибки вовсе, пока человек не
    // ответил на запрос доступа: без своего таймера экран «Определяем
    // положение…» остался бы навсегда
    vi.useFakeTimers();
    const pending = getPosition({ search: '', geolocation: geo('silent') });

    vi.advanceTimersByTime(GPS_TIMEOUT_MS);
    const fix = await pending;

    expect(fix.pos).toEqual(FALLBACK_POSITION);
    expect(fix.trusted).toBe(false);
  });

  it('поздний ответ датчика не перебивает уже принятое решение', async () => {
    vi.useFakeTimers();
    let late: ((p: GeolocationPosition) => void) | null = null;
    const slow: Geolocation = {
      getCurrentPosition: (ok) => {
        late = ok;
      },
      watchPosition: () => 0,
      clearWatch: () => {},
    };

    const pending = getPosition({ search: '', geolocation: slow });
    vi.advanceTimersByTime(GPS_TIMEOUT_MS);
    const fix = await pending;
    expect(fix.trusted).toBe(false);

    // Датчик очнулся — промис уже разрешён, второго ответа быть не может
    expect(() =>
      late?.({ coords: { latitude: 1, longitude: 2 } } as GeolocationPosition),
    ).not.toThrow();
    await expect(pending).resolves.toEqual(fix);
  });
});
