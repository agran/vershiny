/**
 * Калибровка датчиков: поправки, которые совмещают нарисованный горизонт
 * с реальным кадром камеры (AR, ROADMAP 2.3, ALGORITHMS.md §3).
 *
 * Три независимые причины расхождения:
 *
 *   - **азимут** — железо в кармане, соседняя машина, дешёвый магнитометр.
 *     (Магнитное склонение — самая большая систематика — убирается до этого
 *     автоматически: core/declination.ts, WMM по положению GPS.) Свайп по
 *     кадру двигает контуры вбок, поправка запоминается;
 *   - **наклон** — телефон редко держат ровно, да и датчик наклона на дешёвых
 *     аппаратах уезжает на пару градусов;
 *   - **поле зрения камеры** — самая частая причина, о которой не думают.
 *     Панорама рисуется с расчётным углом обзора, а объектив у каждого
 *     телефона свой: если углы разошлись, контуры совпадут по центру кадра и
 *     разъедутся к краям, сколько ни крути азимут. Ползунок «поле зрения»
 *     растягивает картинку под конкретный аппарат.
 *
 * Поправки переживают перезапуск: раньше подстройка свайпом жила до
 * перезагрузки страницы, и в следующий выход её приходилось делать заново.
 */

/** Угол обзора по длинной стороне кадра по умолчанию — примерно как у камеры телефона */
export const DEFAULT_CAMERA_FOV_DEG = 70;

const STORAGE_KEY = "vershiny-calibration";

export interface Calibration {
  /** Поправка азимута, градусы (прибавляется к показаниям компаса) */
  azimuthDeg: number;
  /** Поправка наклона, градусы (плюс — горизонт выше) */
  tiltDeg: number;
  /** Поле зрения камеры по длинной стороне кадра, градусы; null — расчётное */
  cameraFovDeg: number | null;
  /** Пробовать совместить контуры с кадром автоматически при входе в AR */
  autoCalibrate: boolean;
}

export const DEFAULT_CALIBRATION: Calibration = {
  azimuthDeg: 0,
  tiltDeg: 0,
  cameraFovDeg: null,
  autoCalibrate: true,
};

/** Границы ползунков: за ними подстройка перестаёт быть подстройкой */
export const CALIBRATION_LIMITS = {
  tiltDeg: 20,
  fovMinDeg: 40,
  fovMaxDeg: 100,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Приведение к допустимым значениям (в хранилище мог остаться мусор) */
export function normalizeCalibration(
  raw: Partial<Calibration> | null,
): Calibration {
  if (!raw) return { ...DEFAULT_CALIBRATION };
  const azimuth = Number(raw.azimuthDeg);
  const tilt = Number(raw.tiltDeg);
  const fov = raw.cameraFovDeg == null ? null : Number(raw.cameraFovDeg);
  return {
    azimuthDeg: Number.isFinite(azimuth)
      ? (((azimuth % 360) + 540) % 360) - 180
      : 0,
    tiltDeg: Number.isFinite(tilt)
      ? clamp(tilt, -CALIBRATION_LIMITS.tiltDeg, CALIBRATION_LIMITS.tiltDeg)
      : 0,
    cameraFovDeg:
      fov != null && Number.isFinite(fov)
        ? clamp(fov, CALIBRATION_LIMITS.fovMinDeg, CALIBRATION_LIMITS.fovMaxDeg)
        : null,
    autoCalibrate: raw.autoCalibrate !== false,
  };
}

let current: Calibration | null = null;

export function getCalibration(): Calibration {
  if (current) return current;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    current = normalizeCalibration(stored ? JSON.parse(stored) : null);
  } catch {
    current = { ...DEFAULT_CALIBRATION }; // приватный режим или битый JSON
  }
  return current;
}

/** Изменить поправки. Возвращает применённые значения */
export function setCalibration(patch: Partial<Calibration>): Calibration {
  current = normalizeCalibration({ ...getCalibration(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Без хранилища поправка живёт до перезагрузки — это лучше, чем ничего
  }
  return current;
}

export function resetCalibration(): Calibration {
  return setCalibration({ ...DEFAULT_CALIBRATION });
}
