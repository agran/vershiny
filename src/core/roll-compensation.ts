/**
 * Компенсация крена в AR (roll compensation).
 *
 * Когда телефон держат не ровно — один угол ниже другого — кадр камеры уже
 * наклонён, и ровный горизонт оверлея расходится с ним по всему экрану.
 * По умолчанию оверлей доворачивается на угол крена (rollRad из
 * core/orientation.ts) вокруг центра кадра — контуры лежат на наклонённых
 * горах.
 *
 * Отключается в настройках: на слабом телефоне лишний поворот контекста на
 * каждый кадр — не бесплатен, а кому-то ровный горизонт привычнее (линия
 * остаётся горизонталью экрана, даже когда мир в кадре завален).
 */

const STORAGE_KEY = "vershiny-roll-compensation";

/** Включена ли доводка оверлея по крену. По умолчанию — да */
export function isRollCompensationOn(): boolean {
  try {
    // По умолчанию включено: отсутствие ключа и мусор читаются как «вкл»
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setRollCompensation(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Без хранилища выбор живёт до перезагрузки — лучше, чем ничего
  }
}

/**
 * Крен для доворота оверлея, рад.
 *
 * Крен датчика (state.rollRad в core/orientation.ts) отсчитывается от
 * портретного окна: при ровном ЛАНДШАФТНОМ хвате он показывает ±90° —
 * а картинка при этом стоит ровно, потому что кадр камеры при программном
 * повороте UI довёрнут на −softAngle при отрисовке
 * (core/frame-orientation.ts). Чтобы оверлей не лёг боком на 90°, из крена
 * вычитается тот же softAngle: видимый в кадре крен = крен датчика −
 * softAngle. Без программного поворота (softAngleDeg = 0) — тождественность.
 *
 * @param rollRad крен из датчика, рад
 * @param softAngleDeg угол программного поворота UI (−90 | 0 | +90)
 */
export function overlayRollRad(
  rollRad: number,
  softAngleDeg: number,
): number {
  return rollRad - (softAngleDeg * Math.PI) / 180;
}
