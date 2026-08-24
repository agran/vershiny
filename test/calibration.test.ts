/**
 * Калибровка датчиков: поправки, совмещающие нарисованный горизонт с кадром.
 * Главное — они переживают перезапуск и не принимают мусор из хранилища.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getCalibration,
  setCalibration,
  resetCalibration,
  normalizeCalibration,
  CALIBRATION_LIMITS,
  CALIBRATION_VERSION,
  DEFAULT_CAMERA_FOV_DEG,
} from "../src/core/calibration";

/** Хранилище браузера — в тестах его нет, подменяем на карту в памяти */
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

beforeEach(() => {
  store.clear();
  resetCalibration();
});

describe("калибровка датчиков", () => {
  it("по умолчанию поправок нет, поле зрения расчётное", () => {
    const cal = getCalibration();
    expect(cal.azimuthDeg).toBe(0);
    expect(cal.tiltDeg).toBe(0);
    expect(cal.cameraFovDeg).toBeNull();
  });

  it("поправки переживают перезапуск", () => {
    setCalibration({ azimuthDeg: 6.5, tiltDeg: -2, cameraFovDeg: 64 });
    // Свежее чтение из хранилища — как при следующем запуске приложения
    const stored = normalizeCalibration(
      JSON.parse(store.get("vershiny-calibration")!),
    );
    expect(stored.azimuthDeg).toBeCloseTo(6.5, 3);
    expect(stored.tiltDeg).toBeCloseTo(-2, 3);
    expect(stored.cameraFovDeg).toBe(64);
  });

  it("азимут сворачивается в ±180°, а не растёт бесконечно", () => {
    // Свайп по кадру накручивает оффсет: после нескольких оборотов
    // в настройках должно быть читаемое число
    setCalibration({ azimuthDeg: 370 });
    expect(getCalibration().azimuthDeg).toBeCloseTo(10, 3);
    setCalibration({ azimuthDeg: -200 });
    expect(getCalibration().azimuthDeg).toBeCloseTo(160, 3);
  });

  it("наклон и поле зрения не выходят за разумные пределы", () => {
    setCalibration({ tiltDeg: 90, cameraFovDeg: 300 });
    const cal = getCalibration();
    expect(cal.tiltDeg).toBe(CALIBRATION_LIMITS.tiltDeg);
    expect(cal.cameraFovDeg).toBe(CALIBRATION_LIMITS.fovMaxDeg);
    expect(CALIBRATION_LIMITS.fovMaxDeg).toBe(120);
  });

  it("телефото-углы разрешены: минимум 10°, ниже зажимается", () => {
    setCalibration({ cameraFovDeg: 16 });
    expect(getCalibration().cameraFovDeg).toBe(16);
    setCalibration({ cameraFovDeg: 2 });
    expect(getCalibration().cameraFovDeg).toBe(CALIBRATION_LIMITS.fovMinDeg);
    expect(CALIBRATION_LIMITS.fovMinDeg).toBe(10);
  });

  it("битое хранилище не ломает запуск", () => {
    expect(
      normalizeCalibration({ azimuthDeg: NaN, tiltDeg: undefined }),
    ).toEqual({
      azimuthDeg: 0,
      tiltDeg: 0,
      cameraFovDeg: null,
      autoCalibrate: true,
      version: CALIBRATION_VERSION,
    });
    expect(normalizeCalibration(null).cameraFovDeg).toBeNull();
  });

  it("устаревшая версия сбрасывает наклон и FOV, азимут сохраняется", () => {
    // Старая модель проекции (опорная линия 0.62): наклон и FOV подбирались
    // под неё и после смены вредны; азимут компаса от модели не зависит
    const migrated = normalizeCalibration({
      azimuthDeg: 7,
      tiltDeg: -8.4,
      cameraFovDeg: 75,
      autoCalibrate: false,
    });
    expect(migrated.azimuthDeg).toBe(7);
    expect(migrated.tiltDeg).toBe(0);
    expect(migrated.cameraFovDeg).toBeNull();
    expect(migrated.autoCalibrate).toBe(false);
    expect(migrated.version).toBe(CALIBRATION_VERSION);
    // Свежая версия — поправки проходят как раньше
    const fresh = normalizeCalibration({
      ...migrated,
      tiltDeg: 2,
      cameraFovDeg: 70,
    });
    expect(fresh.tiltDeg).toBe(2);
    expect(fresh.cameraFovDeg).toBe(70);
  });

  it("линейная калибровка версии 1 не переживает переход на pinhole", () => {
    const migrated = normalizeCalibration({
      azimuthDeg: -12,
      tiltDeg: 4.5,
      cameraFovDeg: 76,
      version: 1,
    });

    expect(migrated.azimuthDeg).toBe(-12);
    expect(migrated.tiltDeg).toBe(0);
    expect(migrated.cameraFovDeg).toBeNull();
    expect(migrated.version).toBe(CALIBRATION_VERSION);
  });

  it("автосовмещение включено по умолчанию и выключается", () => {
    expect(getCalibration().autoCalibrate).toBe(true);
    setCalibration({ autoCalibrate: false });
    expect(
      normalizeCalibration(JSON.parse(store.get("vershiny-calibration")!))
        .autoCalibrate,
    ).toBe(false);
  });

  it("сброс возвращает расчётное поле зрения", () => {
    setCalibration({
      cameraFovDeg: DEFAULT_CAMERA_FOV_DEG - 10,
      azimuthDeg: 5,
    });
    const cal = resetCalibration();
    expect(cal.azimuthDeg).toBe(0);
    expect(cal.tiltDeg).toBe(0);
    expect(cal.cameraFovDeg).toBeNull();
  });
});
