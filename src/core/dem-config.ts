/**
 * Источники DEM-тайлов (docs/DATA-PIPELINE.md).
 *
 * Глобальная пирамида GLO-90 (~850 МБ) не помещается в репозиторий приложения,
 * поэтому лежит отдельно и раздаётся своим GitHub Pages. Локальная копия
 * (public/tiles/global) имеет приоритет — так работает разработка без сети.
 */

/** Внешнее хранилище пирамиды: agran/vershiny-dem → GitHub Pages */
export const GLOBAL_DEM_URL = 'https://agran.github.io/vershiny-dem/tiles/global';

/**
 * Кандидаты на роль локального патча, в порядке убывания детализации:
 * детальный патч региона → локальная пирамида → внешняя пирамида.
 */
export function demCandidates(base: string, region: string): string[] {
  return [`${base}tiles/${region}`, `${base}tiles/global`, GLOBAL_DEM_URL];
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
  for (const candidate of candidates) {
    if (await probes.online(candidate)) return candidate;
    if (await probes.cached(candidate)) return candidate;
  }
  return undefined;
}
