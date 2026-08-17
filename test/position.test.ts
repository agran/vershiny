// @vitest-environment jsdom
/**
 * Откуда берётся положение наблюдателя, когда ему можно верить и как быстро
 * оно появляется.
 *
 * Два разных требования. Первое: запасной точке нельзя верить — иначе тот,
 * кому не дали геолокацию, получит «Вы в районе Приэльбрусья», где бы он ни
 * был. Второе: без сети недоступен A-GPS, холодный фикс занимает минуты, и
 * держать человека всё это время на заставке нельзя.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getPosition,
  getFreshPosition,
  awaitAccuratePosition,
  rememberPosition,
  lastKnownPosition,
  worthRefining,
  FALLBACK_POSITION,
  QUICK_TIMEOUT_MS,
  GPS_TIMEOUT_MS,
  ACCURATE_TIMEOUT_MS,
  REFINE_MIN_MOVE_M,
} from '../src/core/position';

const ALPS = { latitude: 46.5, longitude: 8.0 };

/**
 * Геолокация с раздельным поведением на быстрый и точный запрос — именно так
 * ведёт себя телефон: готовый фикс отдаётся сразу, за свежим приходится идти
 * к спутникам.
 */
function geo(behaviour: {
  cached?: { latitude: number; longitude: number } | null;
  precise?: { latitude: number; longitude: number } | null;
  /** Точный запрос молчит: спутников не видно, ошибки браузер не шлёт */
  preciseSilent?: boolean;
}): Geolocation {
  return {
    getCurrentPosition: (ok, fail, options) => {
      const wantsFresh = options?.enableHighAccuracy === true;
      if (!wantsFresh) {
        if (behaviour.cached) ok({ coords: behaviour.cached } as GeolocationPosition);
        else fail?.({ code: 2 } as GeolocationPositionError);
        return;
      }
      if (behaviour.preciseSilent) return;
      if (behaviour.precise) ok({ coords: behaviour.precise } as GeolocationPosition);
      else fail?.({ code: 1 } as GeolocationPositionError);
    },
    watchPosition: () => 0,
    clearWatch: () => {},
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('положение наблюдателя', () => {
  it('координаты из ссылки — настоящие: их задал человек', async () => {
    const fix = await getPosition({
      search: '?lat=43.35&lon=42.44',
      geolocation: geo({ cached: ALPS }),
    });

    expect(fix.pos).toEqual({ lat: 43.35, lon: 42.44 });
    expect(fix.trusted).toBe(true);
  });

  it('мусор в ссылке не принимается за положение', async () => {
    // ?lat=999 иначе молча ломает весь ray-marching
    const fix = await getPosition({
      search: '?lat=999&lon=42.44',
      geolocation: geo({ cached: ALPS }),
    });

    expect(fix.pos).toEqual({ lat: 46.5, lon: 8.0 });
    expect(fix.trusted).toBe(true);
  });

  it('готовый фикс системы принимается сразу и считается настоящим', async () => {
    const fix = await getPosition({ search: '', geolocation: geo({ cached: ALPS }) });

    expect(fix.pos).toEqual({ lat: 46.5, lon: 8.0 });
    expect(fix.trusted).toBe(true);
  });

  it('с точкой прошлого запуска старт мгновенный: спутников не ждём вовсе', async () => {
    // Ровно случай «запустил в горах без сети»: A-GPS недоступен, холодный
    // фикс — это минуты, и всё это время висела заставка. Ждать нечего:
    // вид с прошлой стоянки уже есть, а настоящее положение подставит
    // фоновое уточнение
    vi.useFakeTimers();
    rememberPosition({ lat: 43.35, lon: 42.44 });

    // Время заморожено и ни разу не сдвинуто: если бы старт ждал ответа
    // геолокации, промис не разрешился бы вовсе и тест повис
    const fix = await getPosition({
      search: '',
      geolocation: geo({ cached: null, preciseSilent: true }),
    });

    expect(fix.pos).toEqual({ lat: 43.35, lon: 42.44 });
    // Точка вчерашняя: по ней нельзя ни менять район, ни предлагать соседний
    expect(fix.trusted).toBe(false);
  });

  it('на первом запуске показывать нечего — ждём спутники', async () => {
    vi.useFakeTimers();
    const pending = getPosition({
      search: '',
      geolocation: geo({ cached: null, precise: ALPS }),
    });

    await vi.advanceTimersByTimeAsync(QUICK_TIMEOUT_MS);
    const fix = await pending;

    expect(fix.pos).toEqual({ lat: 46.5, lon: 8.0 });
    expect(fix.trusted).toBe(true);
  });

  it('первый запуск без спутников вовсе — запасная точка без доверия', async () => {
    vi.useFakeTimers();
    const pending = getPosition({
      search: '',
      geolocation: geo({ cached: null, preciseSilent: true }),
    });

    await vi.advanceTimersByTimeAsync(QUICK_TIMEOUT_MS + GPS_TIMEOUT_MS);
    const fix = await pending;

    expect(fix.pos).toEqual(FALLBACK_POSITION);
    expect(fix.trusted).toBe(false);
  });

  it('без самой геолокации берётся прошлая точка, а не Приют 11', async () => {
    rememberPosition({ lat: 49.8, lon: 86.6 });
    const fix = await getPosition({ search: '', geolocation: null });

    expect(fix.pos).toEqual({ lat: 49.8, lon: 86.6 });
    expect(fix.trusted).toBe(false);
  });

  it('без геолокации и без прошлой точки — Приют 11', async () => {
    const fix = await getPosition({ search: '', geolocation: null });

    expect(fix.pos).toEqual(FALLBACK_POSITION);
    expect(fix.trusted).toBe(false);
  });
});

describe('свежий фикс по кнопке «К моему положению»', () => {
  it('точка прошлого запуска НЕ подставляется: идём к спутникам', async () => {
    // Регресс: getPosition() при наличии запомненной точки возвращал её с
    // trusted=false, не спросив GPS вовсе, — и кнопка «К моему положению»
    // кричала об ошибке при полностью рабочей геолокации после каждого
    // первого успешного фикса
    rememberPosition({ lat: 43.35, lon: 42.44 });
    const pos = await getFreshPosition({ geolocation: geo({ cached: ALPS }) });

    expect(pos).toEqual({ lat: 46.5, lon: 8.0 }); // Альпы, а не вчерашний Приют
  });

  it('готовый фикс системы годится: кнопка отвечает мгновенно', async () => {
    vi.useFakeTimers();
    const pending = getFreshPosition({ geolocation: geo({ cached: ALPS }) });
    // Таймеры не сдвигались: промис разрешился синхронно, спутников не ждали
    await expect(pending).resolves.toEqual({ lat: 46.5, lon: 8.0 });
  });

  it('без готового фикса дожидается спутников', async () => {
    vi.useFakeTimers();
    const pending = getFreshPosition({
      geolocation: geo({ cached: null, precise: ALPS }),
    });
    await vi.advanceTimersByTimeAsync(QUICK_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ lat: 46.5, lon: 8.0 });
  });

  it('спутники молчат — честный null, а не вчерашняя точка', async () => {
    vi.useFakeTimers();
    rememberPosition({ lat: 43.35, lon: 42.44 });
    const pending = getFreshPosition({
      geolocation: geo({ cached: null, preciseSilent: true }),
    });
    await vi.advanceTimersByTimeAsync(QUICK_TIMEOUT_MS + GPS_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
  });

  it('без геолокации вовсе — null, запасной точки нет', async () => {
    rememberPosition({ lat: 49.8, lon: 86.6 });
    await expect(getFreshPosition({ geolocation: null })).resolves.toBeNull();
  });
});

describe('уточнение по спутникам', () => {
  it('дожидается настоящего положения дольше, чем стартовый запрос', async () => {
    vi.useFakeTimers();
    // Держим обработчик в объекте: иначе анализ потока считает, что в
    // переменной всё ещё null — присваивание происходит внутри колбэка
    const late: { answer?: (p: GeolocationPosition) => void } = {};
    const slow: Geolocation = {
      getCurrentPosition: (ok) => {
        late.answer = ok;
      },
      watchPosition: () => 0,
      clearWatch: () => {},
    };

    const pending = awaitAccuratePosition({ geolocation: slow });
    // Спутники ответили сильно позже, чем ждал стартовый запрос
    await vi.advanceTimersByTimeAsync(GPS_TIMEOUT_MS + 5_000);
    late.answer?.({ coords: ALPS } as GeolocationPosition);

    await expect(pending).resolves.toEqual({ lat: 46.5, lon: 8.0 });
  });

  it('молчание спутников не оставляет висеть навсегда', async () => {
    vi.useFakeTimers();
    const pending = awaitAccuratePosition({
      geolocation: geo({ cached: null, preciseSilent: true }),
    });

    await vi.advanceTimersByTimeAsync(ACCURATE_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
  });

  it('без геолокации уточнять нечем', async () => {
    await expect(awaitAccuratePosition({ geolocation: null })).resolves.toBeNull();
  });

  it('пересчёт только при заметном сдвиге', () => {
    const here = { lat: 43.35, lon: 42.44 };
    const nearby = { lat: 43.3505, lon: 42.44 }; // ~55 м
    const far = { lat: 43.36, lon: 42.44 }; // ~1.1 км

    expect(worthRefining(here, nearby)).toBe(false);
    expect(worthRefining(here, far)).toBe(true);
    expect(REFINE_MIN_MOVE_M).toBeGreaterThan(100);
  });
});

describe('память о последней точке', () => {
  it('переживает перезапуск', () => {
    rememberPosition({ lat: 43.35, lon: 42.44 });
    expect(lastKnownPosition()).toEqual({ lat: 43.35, lon: 42.44 });
  });

  it('мусор в хранилище не принимается за положение', () => {
    localStorage.setItem('vershiny-position', '{"lat":999,"lon":"нет"}');
    expect(lastKnownPosition()).toBeNull();

    localStorage.setItem('vershiny-position', 'не json');
    expect(lastKnownPosition()).toBeNull();
  });

  it('пустое хранилище — просто нет точки', () => {
    expect(lastKnownPosition()).toBeNull();
  });
});
