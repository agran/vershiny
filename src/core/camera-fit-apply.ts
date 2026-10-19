/**
 * Перевод позы, подобранной по кадру камеры (core/photo-fit.ts), в поправки
 * калибровки (core/calibration.ts).
 *
 * Подгонка отвечает на вопрос «куда на самом деле смотрела камера в момент
 * кадра», а калибровка хранит ошибки датчиков: сдвиг азимута, сдвиг наклона
 * и поле зрения объектива. Поэтому берётся разница между подобранной позой
 * и тем, что показывали датчики в момент снимка кадра (а не сейчас: пока
 * шла подгонка, телефон мог повернуться).
 */

import { longSideFovFromHorizontalFov } from "./camera-fov";
import { CALIBRATION_LIMITS } from "./calibration";
import { wrapAngle } from "./geo";
import type { CameraPose } from "./photo-fit";

export interface CameraFitAdjustment {
  /** Сдвиг азимута, рад (прибавляется к показаниям компаса) */
  azimuthDeltaRad: number;
  /** Новая поправка наклона, градусы (полная, а не приращение) */
  tiltDeg: number;
  /** Новое поле зрения по длинной стороне, градусы; null — оставить прежнее */
  cameraFovDeg: number | null;
}

export interface CameraFitAdjustInput {
  pose: CameraPose;
  /** Азимут и наклон взгляда по датчикам в момент снимка кадра, рад */
  azAtGrabRad: number;
  tiltAtGrabRad: number;
  /** Текущая поправка наклона, градусы */
  currentTiltDeg: number;
  /** FOV однозначно определился формой линии (иначе берётся прежний) */
  fovObservable: boolean;
  frameWidth: number;
  frameHeight: number;
  /** Зум трека камеры: FOV подгонки — после зума, калибровка хранит базовый */
  zoom: number;
}

/**
 * null — поправка вне допустимых границ: подгонка «нашла» то, чего не бывает
 * у исправного датчика, и применять её нельзя.
 */
export function adjustmentFromFit(
  input: CameraFitAdjustInput,
): CameraFitAdjustment | null {
  const { pose } = input;
  const tiltDeg =
    input.currentTiltDeg +
    ((pose.elevRad - input.tiltAtGrabRad) * 180) / Math.PI;
  if (
    !Number.isFinite(tiltDeg) ||
    Math.abs(tiltDeg) > CALIBRATION_LIMITS.tiltDeg
  ) {
    return null;
  }
  let cameraFovDeg: number | null = null;
  if (input.fovObservable) {
    const baseRad = longSideFovFromHorizontalFov(
      pose.fovHRad,
      input.frameWidth,
      input.frameHeight,
      input.zoom,
    );
    const baseDeg = baseRad === null ? NaN : (baseRad * 180) / Math.PI;
    if (
      !Number.isFinite(baseDeg) ||
      baseDeg < CALIBRATION_LIMITS.fovMinDeg ||
      baseDeg > CALIBRATION_LIMITS.fovMaxDeg
    ) {
      return null;
    }
    cameraFovDeg = baseDeg;
  }
  return {
    azimuthDeltaRad: wrapAngle(pose.azRad - input.azAtGrabRad),
    tiltDeg,
    cameraFovDeg,
  };
}
