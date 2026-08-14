/**
 * Где стоит наблюдатель на старте.
 *
 * Тонкость не в самом вызове геолокации, а в том, что делать при отказе.
 * Приложению нужно что-то показать, поэтому есть запасная точка (Приют 11) —
 * но она выдумана, и обращаться с ней как с настоящим положением нельзя:
 * по ней нельзя менять активный регион и уж тем более заявлять человеку
 * «Вы в районе Приэльбрусья», когда он в Альпах и просто отказал в доступе
 * к геолокации. Отсюда флаг `trusted` рядом с координатами.
 *
 * Вынесено из main.ts отдельным модулем ради проверяемости: сценарии здесь —
 * отказ, молчание датчика, мусор в ссылке — руками воспроизводятся плохо.
 */

import { isValidLatLon, type LatLon } from './geo';

/** Приют 11 (4130 м) — сверено с Terrarium: отметка ~4134 м */
export const FALLBACK_POSITION: LatLon = { lat: 43.318, lon: 42.458 };

/** Сколько ждём спутникового фикса, мс */
export const GPS_TIMEOUT_MS = 30_000;

export interface PositionFix {
  pos: LatLon;
  /**
   * Положение настоящее: пришло от спутников или задано ссылкой явно.
   * По такому можно подбирать регион и предлагать соседний; по запасному —
   * нельзя, оно не про этого человека.
   */
  trusted: boolean;
}

export interface PositionDeps {
  /** Строка параметров вида `?lat=43.318&lon=42.458` */
  search: string;
  geolocation: Geolocation | null;
}

/**
 * Положение наблюдателя: ссылка → спутники → запасная точка.
 *
 * На смартфоне лучше не показывать горы до первого реального фикса: при
 * мгновенном запасном варианте загрузка выглядит как «попался в чужой
 * регион», хотя человек ещё ждёт определения своего положения.
 */
export function getPosition(deps: Partial<PositionDeps> = {}): Promise<PositionFix> {
  const search = deps.search ?? location.search;
  const geolocation =
    deps.geolocation !== undefined
      ? deps.geolocation
      : 'geolocation' in navigator
        ? navigator.geolocation
        : null;

  return new Promise((resolve) => {
    // Отладка и обмен ссылками: ?lat=43.318&lon=42.458 (Приют 11).
    // Диапазон проверяем: ?lat=999 иначе молча ломает весь ray-marching
    const q = new URLSearchParams(search);
    const lat = Number(q.get('lat'));
    const lon = Number(q.get('lon'));
    if (q.get('lat') && q.get('lon') && isValidLatLon({ lat, lon })) {
      // Точка задана человеком осознанно — она настоящая не меньше спутниковой
      resolve({ pos: { lat, lon }, trusted: true });
      return;
    }

    if (!geolocation) {
      resolve({ pos: FALLBACK_POSITION, trusted: false });
      return;
    }

    // Свой таймер поверх штатного: часть браузеров не зовёт обработчик ошибки
    // вовсе, если человек не ответил на запрос доступа, — и приложение
    // осталось бы на «Определяем положение…» навсегда
    let done = false;
    const finish = (fix: PositionFix): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(fix);
    };
    const timer = setTimeout(
      () => finish({ pos: FALLBACK_POSITION, trusted: false }),
      GPS_TIMEOUT_MS,
    );

    geolocation.getCurrentPosition(
      (pos) =>
        finish({
          pos: { lat: pos.coords.latitude, lon: pos.coords.longitude },
          trusted: true,
        }),
      () => finish({ pos: FALLBACK_POSITION, trusted: false }),
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS },
    );
  });
}
