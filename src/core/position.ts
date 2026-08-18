/**
 * Где стоит наблюдатель на старте.
 *
 * Две тонкости, из-за которых это отдельный модуль.
 *
 * **Ждать спутники нельзя.** Без сети недоступен A-GPS (альманах и эфемериды
 * скачиваются по сети), и холодный фикс занимает десятки секунд, а то и
 * минуты — ровно в том сценарии, ради которого приложение и писалось.
 * Поэтому положение берётся в два этапа: сначала быстрое (готовый фикс
 * системы или точка прошлого запуска), панорама считается сразу, а настоящее
 * положение подставляется, когда спутники ответят.
 *
 * **Запасной точке верить нельзя.** Приложению нужно что-то показать, поэтому
 * есть Приют 11 — но он выдуман, и обращаться с ним как с положением человека
 * нельзя: по нему не подбирается регион и не предлагается соседний, иначе
 * тот, кому просто не дали геолокацию, получит «Вы в районе Приэльбрусья»,
 * где бы он ни был. Отсюда флаг `trusted`.
 */

import { distanceM, isValidLatLon, type LatLon } from "./geo";

/** Приют 11 (4130 м) — сверено с Terrarium: отметка ~4134 м */
export const FALLBACK_POSITION: LatLon = { lat: 43.318, lon: 42.458 };

/** Сколько ждём быстрый ответ: столько система тратит на выдачу готового фикса */
export const QUICK_TIMEOUT_MS = 4_000;
/** Насколько старым может быть готовый фикс системы, чтобы принять его сразу */
export const CACHE_MAX_AGE_MS = 5 * 60_000;
/** Сколько ждём спутники на первом запуске, когда показать больше нечего */
export const GPS_TIMEOUT_MS = 30_000;
/** Сколько ждём точное положение в фоне: холодный старт без сети — это минуты */
export const ACCURATE_TIMEOUT_MS = 60_000;
/** Ближе этого уточнение картины не меняет — пересчитывать незачем */
export const REFINE_MIN_MOVE_M = 500;

const STORAGE_KEY = "vershiny-position";

export interface PositionFix {
  pos: LatLon;
  /**
   * Положение настоящее: пришло от спутников или задано ссылкой явно.
   * По такому можно подбирать регион и предлагать соседний; по точке
   * прошлого запуска и запасной — нельзя, они не про «здесь и сейчас».
   */
  trusted: boolean;
}

export interface PositionDeps {
  /** Строка параметров вида `?lat=43.318&lon=42.458` */
  search: string;
  geolocation: Geolocation | null;
}

/**
 * Запомнить, где человек был.
 *
 * Следующий запуск начнётся отсюда, не дожидаясь спутников: в горах
 * приложение открывают там же, где закрыли, и вид с прошлой стоянки полезнее
 * пустого экрана «Определяем положение по спутникам…» на полминуты.
 */
export function rememberPosition(pos: LatLon): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ lat: pos.lat, lon: pos.lon }),
    );
  } catch {
    // Без хранилища не будет быстрого старта — на этом всё, работать можно
  }
}

/** Точка прошлого запуска, если она была и не испорчена */
export function lastKnownPosition(): LatLon | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lat?: unknown; lon?: unknown };
    const pos = { lat: Number(parsed.lat), lon: Number(parsed.lon) };
    return isValidLatLon(pos) ? pos : null;
  } catch {
    return null;
  }
}

function geolocationOf(deps: Partial<PositionDeps>): Geolocation | null {
  if (deps.geolocation !== undefined) return deps.geolocation;
  return "geolocation" in navigator ? navigator.geolocation : null;
}

/**
 * Один запрос положения со своим сроком ожидания.
 *
 * Свой таймер поверх штатного нужен потому, что часть браузеров не зовёт
 * обработчик ошибки вовсе, пока человек не ответил на запрос доступа: без
 * него приложение осталось бы на «Определяем положение…» навсегда.
 */
function requestFix(
  geolocation: Geolocation,
  options: PositionOptions,
  waitMs: number,
): Promise<LatLon | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: LatLon | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    geolocation.getCurrentPosition(
      (pos) => finish({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => finish(null),
      options,
    );
  });
}

/**
 * Положение для первого кадра — быстрое.
 *
 * Порядок: ссылка → готовый фикс системы → точка прошлого запуска →
 * ожидание спутников (только если показать больше нечего) → запасная точка.
 */
export async function getPosition(
  deps: Partial<PositionDeps> = {},
): Promise<PositionFix> {
  const search = deps.search ?? location.search;
  const geolocation = geolocationOf(deps);

  // Отладка и обмен ссылками: ?lat=43.318&lon=42.458 (Приют 11).
  // Диапазон проверяем: ?lat=999 иначе молча ломает весь ray-marching
  const q = new URLSearchParams(search);
  const lat = Number(q.get("lat"));
  const lon = Number(q.get("lon"));
  if (q.get("lat") && q.get("lon") && isValidLatLon({ lat, lon })) {
    // Точку задал человек — она настоящая не меньше спутниковой
    return { pos: { lat, lon }, trusted: true };
  }

  const remembered = lastKnownPosition();
  if (!geolocation) {
    return { pos: remembered ?? FALLBACK_POSITION, trusted: false };
  }

  // Известно, где были в прошлый раз — показываем оттуда немедленно, вообще
  // ничего не спрашивая. Настоящее положение дослушивается в фоне
  // (awaitAccuratePosition) и подставляется, если человек оказался не здесь
  if (remembered) return { pos: remembered, trusted: false };

  // Показывать нечего. Готовый фикс системы приходит мгновенно: его мог
  // оставить навигатор, камера или карта. Высокая точность здесь не нужна —
  // именно она и заставляет ждать спутники
  const quick = await requestFix(
    geolocation,
    {
      enableHighAccuracy: false,
      maximumAge: CACHE_MAX_AGE_MS,
      timeout: QUICK_TIMEOUT_MS,
    },
    QUICK_TIMEOUT_MS,
  );
  if (quick) return { pos: quick, trusted: true };

  // Первый запуск и холодный приёмник: остаётся ждать
  const precise = await requestFix(
    geolocation,
    { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS },
    GPS_TIMEOUT_MS,
  );
  return precise
    ? { pos: precise, trusted: true }
    : { pos: FALLBACK_POSITION, trusted: false };
}

/**
 * Свежий фикс по явному запросу пользователя (кнопка «К моему положению»).
 *
 * Отличается от getPosition(): тот обслуживает СТАРТ приложения и сознательно
 * отдаёт точку прошлого запуска как недостоверную — показать что-то сразу,
 * спутники дослушать в фоне. Кнопка имеет противоположный смысл: «сходи за
 * положением СЕЙЧАС». Если взять getPosition(), то при наличии точки прошлого
 * запуска она возвращается мгновенно с trusted=false, не спросив GPS вовсе,
 * и кнопка выводила «Не удалось определить положение» при полностью рабочей
 * геолокации — каждый раз после первого успешного фикса.
 *
 * Здесь — только живые источники: готовый фикс системы (мгновенно, если его
 * недавно оставил навигатор или карта), затем точный запрос к спутникам.
 * `null` — геолокация недоступна, отклонена или спутники не ответили.
 */
export async function getFreshPosition(
  deps: Partial<PositionDeps> = {},
): Promise<LatLon | null> {
  const geolocation = geolocationOf(deps);
  if (!geolocation) return null;

  // Готовый фикс — как в getPosition(): мгновенно и достаточно точен
  const quick = await requestFix(
    geolocation,
    {
      enableHighAccuracy: false,
      maximumAge: CACHE_MAX_AGE_MS,
      timeout: QUICK_TIMEOUT_MS,
    },
    QUICK_TIMEOUT_MS,
  );
  if (quick) return quick;

  // Кеша нет — идём к спутникам, сколько нужно
  return requestFix(
    geolocation,
    { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS },
    GPS_TIMEOUT_MS,
  );
}

/**
 * Настоящее положение — сколько бы спутники его ни искали.
 *
 * Вызывается после того, как панорама уже нарисована по быстрой точке.
 * Готовый фикс системы принимается: он приходит мгновенно и для вопроса
 * «в какой я долине» точен более чем достаточно. `null` — ответа так и не
 * было: остаёмся на том, что показали.
 */
export function awaitAccuratePosition(
  deps: Partial<PositionDeps> = {},
): Promise<LatLon | null> {
  const geolocation = geolocationOf(deps);
  if (!geolocation) return Promise.resolve(null);
  return requestFix(
    geolocation,
    {
      enableHighAccuracy: true,
      timeout: ACCURATE_TIMEOUT_MS,
      maximumAge: CACHE_MAX_AGE_MS,
    },
    ACCURATE_TIMEOUT_MS,
  );
}

/** Стоит ли пересчитывать панораму из-за уточнённого положения */
export function worthRefining(from: LatLon, to: LatLon): boolean {
  return distanceM(from, to) >= REFINE_MIN_MOVE_M;
}
