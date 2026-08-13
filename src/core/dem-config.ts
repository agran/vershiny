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
