/**
 * Источники DEM-тайлов (docs/DATA-PIPELINE.md).
 *
 * Глобальная пирамида GLO-90 (~850 МБ) не помещается в репозиторий приложения,
 * поэтому лежит отдельно и раздаётся своим GitHub Pages. Локальная копия
 * (public/tiles/global) имеет приоритет — так работает разработка без сети.
 */

/** Внешнее хранилище пирамиды: agran/vershiny-dem → GitHub Pages */
export const GLOBAL_DEM_URL =
  "https://agran.github.io/vershiny-dem/tiles/global";

/**
 * Детальный слой (~87 м, квант 1 м) для горных регионов реестра:
 * agran/vershiny-dem-hi → GitHub Pages. Разреженный: покрывает все p1–p3
 * и часть p4 (Япония, Анды, Тибет, Hindu Kush…); вне покрытия тайлов нет,
 * клиент не тратит запросы (битсет coverage) и уходит на базовую пирамиду.
 */
export const GLOBAL_DEM_HI_URL =
  "https://agran.github.io/vershiny-dem-hi/tiles/hi";

/**
 * Локальные кандидаты существуют только в репозитории разработчика: тайлы
 * не публикуются в public/ (26 тыс. файлов валят старт Vite), поэтому в
 * прод-сборке их пробы — чистые 404 в консоли при каждом старте. Параметр
 * `local` оставлен явным, чтобы тесты проверяли и прод-путь.
 */
const LOCAL_TILES = import.meta.env.DEV;

/**
 * Кандидаты на роль локального патча, в порядке убывания детализации:
 * детальный патч региона → локальная пирамида → внешняя пирамида.
 * В прод-сборке остаётся только внешняя пирамида.
 */
export function demCandidates(
  base: string,
  region: string,
  local = LOCAL_TILES,
): string[] {
  return local
    ? [`${base}tiles/${region}`, `${base}tiles/global`, GLOBAL_DEM_URL]
    : [GLOBAL_DEM_URL];
}

/**
 * Детальный патч региона: локальная копия есть только в репозитории
 * разработчика, прод-сборке пробивать её нечего.
 */
export function regionDemCandidates(
  base: string,
  region: string,
  local = LOCAL_TILES,
): string[] {
  return local ? [`${base}tiles/${region}`] : [];
}

/** Детальный слой p1–p2: локальная копия (разработка) → внешний сайт */
export function hiDemCandidates(
  base: string,
  local = LOCAL_TILES,
): string[] {
  return local ? [`${base}tiles/hi`, GLOBAL_DEM_HI_URL] : [GLOBAL_DEM_HI_URL];
}

/** Базовая пирамида: локальная копия (разработка) → внешний сайт */
export function globalDemCandidates(
  base: string,
  local = LOCAL_TILES,
): string[] {
  return local ? [`${base}tiles/global`, GLOBAL_DEM_URL] : [GLOBAL_DEM_URL];
}

/**
 * Префикс ключа тайла в офлайн-хранилище для данного источника.
 *
 * Сам ключ — «lod/x/y», и он одинаков у всех источников, хотя сетки у них
 * разные: у детального патча региона своё начало координат и своя ячейка,
 * у глобальной пирамиды — свои. В общем хранилище они молча читали бы тайлы
 * друг друга, отдавая высоты не того места и без единого признака ошибки.
 *
 * Локальная и внешняя копии пирамиды — это одни и те же данные, поэтому
 * пространство имён берётся из последнего сегмента пути, а не из полного URL:
 * иначе тайл, скачанный с Pages, не нашёлся бы при разработке с локальной
 * копией. У самой пирамиды префикс пустой — она была единственным источником,
 * и смена её ключей обнулила бы всё уже скачанное на устройствах.
 */
export function demStorePrefix(baseUrl: string): string {
  const name = baseUrl.replace(/\/+$/, "").split("/").pop() ?? "";
  return name && name !== "global" ? `${name}/` : "";
}

/**
 * Выбор источника рельефа из кандидатов.
 *
 * Проверка «есть ли index.json» раньше была чисто сетевой: офлайн она не
 * проходила ни для одного кандидата, приложение оставалось на голом Terrarium
 * и падало с «HTTP 503» — при том что и пирамида, и её тайлы лежали в
 * IndexedDB. Поэтому кандидат годится, если индекс отдаёт сеть **или** он
 * сохранён с прошлого раза.
 */
export async function pickDemBase(
  candidates: string[],
  probes: {
    online(url: string): Promise<boolean>;
    cached(url: string): Promise<boolean>;
  },
): Promise<string | undefined> {
  // Заведомый офлайн (onLine === false ложным не бывает, в отличие от true):
  // сетевые пробы пропускаем целиком — не тратим по 2.5 с таймаута на
  // кандидата, когда всё равно ответ один, из IndexedDB
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    for (const candidate of candidates) {
      if (await probes.cached(candidate)) return candidate;
    }
    return undefined;
  }

  // Пробы всех кандидатов параллельно, выбор — первый подошедший в исходном
  // порядке приоритета. Время = максимум проб, а не сумма: при мёртвой сети
  // последовательный перебор умножал таймаут на длину цепочки
  const results = await Promise.all(
    candidates.map(async (url) => {
      if (await probes.online(url)) return true;
      return probes.cached(url);
    }),
  );
  const idx = results.indexOf(true);
  return idx >= 0 ? candidates[idx] : undefined;
}
