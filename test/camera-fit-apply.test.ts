import { describe, it, expect } from "vitest";
import { adjustmentFromFit } from "../src/core/camera-fit-apply";
import { applyZoom, fovForFrame } from "../src/core/camera-fov";

const deg = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

const base = {
  azAtGrabRad: deg(350),
  tiltAtGrabRad: deg(2),
  currentTiltDeg: 1,
  fovObservable: true,
  frameWidth: 1280,
  frameHeight: 720,
  zoom: 1,
};

describe("adjustmentFromFit: поза подгонки → поправки калибровки", () => {
  it("азимут — кратчайшая разница через север, наклон — полная поправка", () => {
    const fov = fovForFrame(deg(70), 1280, 720);
    const adj = adjustmentFromFit({
      ...base,
      pose: {
        azRad: deg(8),
        elevRad: deg(3.5),
        rollRad: 0,
        fovHRad: fov.h,
      },
    });
    expect(adj).not.toBeNull();
    expect(toDeg(adj!.azimuthDeltaRad)).toBeCloseTo(18, 6);
    // было 1° поправки и 2° наклона по датчику; камера на самом деле на 3.5°
    expect(adj!.tiltDeg).toBeCloseTo(2.5, 6);
    expect(adj!.cameraFovDeg).toBeCloseTo(70, 6);
  });

  it("портрет и зум: возвращается базовый FOV по длинной стороне", () => {
    // Кадр 720×1280 с зумом 2×: горизонталь — короткая сторона
    const base70 = fovForFrame(deg(70), 720, 1280);
    const zoomed = applyZoom(base70, 2);
    const adj = adjustmentFromFit({
      ...base,
      frameWidth: 720,
      frameHeight: 1280,
      zoom: 2,
      pose: {
        azRad: deg(350),
        elevRad: deg(2),
        rollRad: 0,
        fovHRad: zoomed.h,
      },
    });
    expect(adj!.cameraFovDeg).toBeCloseTo(70, 4);
    expect(adj!.tiltDeg).toBeCloseTo(1, 6);
    expect(adj!.azimuthDeltaRad).toBeCloseTo(0, 9);
  });

  it("FOV не определился формой линии — прежний остаётся", () => {
    const adj = adjustmentFromFit({
      ...base,
      fovObservable: false,
      pose: { azRad: deg(350), elevRad: deg(2), rollRad: 0, fovHRad: deg(5) },
    });
    expect(adj!.cameraFovDeg).toBeNull();
  });

  it("поправка наклона за пределами ±20° не применяется", () => {
    const fov = fovForFrame(deg(70), 1280, 720);
    expect(
      adjustmentFromFit({
        ...base,
        pose: { azRad: 0, elevRad: deg(25), rollRad: 0, fovHRad: fov.h },
      }),
    ).toBeNull();
  });

  it("FOV вне допустимого диапазона не применяется", () => {
    expect(
      adjustmentFromFit({
        ...base,
        pose: { azRad: 0, elevRad: deg(2), rollRad: 0, fovHRad: deg(3) },
      }),
    ).toBeNull();
  });
});
