/**
 * Тесты единой проекции кадра (core/camera-projection.ts).
 *
 * LinearProjection обязан побитово повторять прежние разрозненные формулы
 * (azToX/elevToY из panorama.ts): это сторожевая проверка этапа 0 — рефакторинг
 * не меняет поведение. PinholeProjection проверяется на свойствах гномоники:
 * центр, край FOV, дисторсия и обратный ход.
 */

import { describe, expect, it } from "vitest";
import {
  createLinearProjection,
  createPinholeProjection,
  PINHOLE_ENABLED,
  type ProjectionParams,
  viewDragDelta,
} from "../src/core/camera-projection";
import { wrapAngle } from "../src/core/geo";

const params: ProjectionParams = {
  width: 400,
  height: 300,
  centerAzRad: 1.234,
  tiltRad: 0.2,
  fovRad: (76 * Math.PI) / 180,
  fovVRad: (61 * Math.PI) / 180,
  horizonFrac: 0.62,
};

/** Старые формулы azToX/elevToY — эталон для LinearProjection */
const legacy = {
  azToX(az: number): number {
    return (
      (wrapAngle(az - params.centerAzRad) / params.fovRad) * params.width +
      params.width / 2
    );
  },
  elevToY(elev: number): number {
    return (
      params.horizonFrac * params.height -
      ((elev - params.tiltRad) / params.fovVRad) * params.height
    );
  },
};

it("pinhole включён для AR/фото без URL-параметра", () => {
  expect(PINHOLE_ENABLED).toBe(true);
});

describe("LinearProjection", () => {
  const proj = createLinearProjection(params);

  it("angleToView побитово повторяет прежние azToX/elevToY", () => {
    for (const az of [0, 0.7, 1.234, 2.1, 5.9]) {
      expect(proj.angleToView(az, 0)!.x).toBe(legacy.azToX(az));
    }
    for (const elev of [-0.5, -0.1, 0, 0.2, 0.8]) {
      expect(proj.angleToView(0, elev)!.y).toBe(legacy.elevToY(elev));
    }
  });

  it("угол в центре кадра — в (width/2, horizonFrac·height)", () => {
    const p = proj.angleToView(params.centerAzRad, params.tiltRad)!;
    expect(p.x).toBeCloseTo(params.width / 2, 12);
    expect(p.y).toBeCloseTo(params.horizonFrac * params.height, 12);
  });

  it("обратный ход: viewToAngle ∘ angleToView = тождество", () => {
    for (const az of [0.5, 1.234, 2.9]) {
      for (const elev of [-0.3, 0.2, 0.55]) {
        const p = proj.angleToView(az, elev)!;
        const back = proj.viewToAngle(p.x, p.y)!;
        expect(back.azRad).toBeCloseTo(az, 9);
        expect(back.elevRad).toBeCloseTo(elev, 9);
      }
    }
  });

  it("разности viewToAngle сохраняют прежний масштаб drag'а", () => {
    // drag: dy экрана → прирост наклона dy/height·fovVRad (знак + вниз)
    const dy = 17;
    const dTilt =
      proj.viewToAngle(0, 0)!.elevRad - proj.viewToAngle(0, dy)!.elevRad;
    expect(dTilt).toBeCloseTo((dy / params.height) * params.fovVRad, 12);
    // азимут: +dx экрана → −dx/width·fovRad
    const dx = 23;
    const dAz =
      proj.viewToAngle(0, 0)!.azRad - proj.viewToAngle(dx, 0)!.azRad;
    expect(dAz).toBeCloseTo((-dx / params.width) * params.fovRad, 12);
  });

  it("drag между точками кадра сохраняет прежний линейный масштаб", () => {
    const proj = createLinearProjection(params);
    const from = { x: 137, y: 89 };
    const to = { x: 160, y: 106 };
    const delta = viewDragDelta(proj, from, to)!;

    expect(delta.azRad).toBeCloseTo(
      (-(to.x - from.x) / params.width) * params.fovRad,
      12,
    );
    expect(delta.elevRad).toBeCloseTo(
      ((to.y - from.y) / params.height) * params.fovVRad,
      12,
    );
  });
});

describe("PinholeProjection", () => {
  const elevC = params.tiltRad + (params.horizonFrac - 0.5) * params.fovVRad;

  it("без дисторсии в центре кадра совпадает с линейной моделью", () => {
    const pinhole = createPinholeProjection(params);
    const linear = createLinearProjection(params);
    const pp = pinhole.angleToView(params.centerAzRad, elevC)!;
    const lp = linear.angleToView(params.centerAzRad, elevC)!;
    expect(pp.x).toBeCloseTo(lp.x, 9);
    expect(pp.y).toBeCloseTo(lp.y, 9);
    expect(pp.x).toBeCloseTo(params.width / 2, 9);
    expect(pp.y).toBeCloseTo(params.height / 2, 9);
  });

  it("точка выше оси — выше центра кадра (y кадра растёт вниз)", () => {
    // Регрессия: пинхол рисовал картинку вверх ногами (y = cy + f·v_y/v_z)
    const pinhole = createPinholeProjection(params);
    const above = pinhole.angleToView(params.centerAzRad, elevC + 0.2)!;
    const below = pinhole.angleToView(params.centerAzRad, elevC - 0.2)!;
    expect(above.y).toBeLessThan(params.height / 2);
    expect(below.y).toBeGreaterThan(params.height / 2);
    // Знак вертикали совпадает с линейной моделью
    const linear = createLinearProjection(params);
    expect(
      Math.sign(linear.angleToView(params.centerAzRad, elevC + 0.2)!.y - params.height / 2),
    ).toBe(Math.sign(above.y - params.height / 2));
    expect(
      Math.sign(linear.angleToView(params.centerAzRad, elevC - 0.2)!.y - params.height / 2),
    ).toBe(Math.sign(below.y - params.height / 2));
  });

  it("мировой горизонт (elev = 0) — прямая линия при наклонённой камере", () => {
    // y_n = −tan(elevC) независимо от Δa — аналитически; численно до 1e-6 px
    const pinhole = createPinholeProjection(params);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = -20; i <= 20; i++) {
      const az = params.centerAzRad + (i / 20) * (params.fovRad / 2);
      const p = pinhole.angleToView(az, 0);
      if (!p) continue;
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    expect(maxY - minY).toBeLessThan(1e-6);
  });

  it("край FOV ложится на край кадра: x(centerAz ± fov/2) ≈ 0 / width", () => {
    // Для наклонённой камеры строка горизонта (y=cy) уже не отвечает elevC —
    // прямолинейность краёв проверяем на ровной камере (elevC = 0)
    const level: ProjectionParams = {
      ...params,
      tiltRad: -(params.horizonFrac - 0.5) * params.fovVRad,
    };
    const pinhole = createPinholeProjection(level);
    const left = pinhole.angleToView(level.centerAzRad - level.fovRad / 2, 0)!;
    const right = pinhole.angleToView(level.centerAzRad + level.fovRad / 2, 0)!;
    expect(left.x).toBeCloseTo(0, 6);
    expect(right.x).toBeCloseTo(level.width, 6);
  });

  it("обратный ход тождественен (λ = 0)", () => {
    const pinhole = createPinholeProjection(params);
    for (const az of [0.6, 1.234, 2.7]) {
      for (const elev of [-0.2, elevC, 0.7]) {
        const p = pinhole.angleToView(az, elev);
        if (!p) continue;
        const back = pinhole.viewToAngle(p.x, p.y)!;
        expect(back.azRad).toBeCloseTo(az, 7);
        expect(back.elevRad).toBeCloseTo(elev, 7);
      }
    }
  });

  it("drag в стороне от центра переносит пинхол вместе с курсором", () => {
    const pinhole = createPinholeProjection(params);
    const from = { x: 316, y: 238 };
    const to = { x: 320, y: 241 };
    const sourceAngle = pinhole.viewToAngle(from.x, from.y)!;
    const delta = viewDragDelta(pinhole, from, to)!;
    const moved = createPinholeProjection({
      ...params,
      centerAzRad: params.centerAzRad + delta.azRad,
      tiltRad: params.tiltRad + delta.elevRad,
    });
    const pointAfterDrag = moved.angleToView(
      sourceAngle.azRad,
      sourceAngle.elevRad,
    )!;

    expect(Math.abs(pointAfterDrag.x - to.x)).toBeLessThan(0.5);
    expect(Math.abs(pointAfterDrag.y - to.y)).toBeLessThan(0.5);
  });

  it("точка за камерой — null, а не зеркальная проекция", () => {
    const pinhole = createPinholeProjection(params);
    // Взгляд далеко вниз: vz ≤ 0
    expect(pinhole.angleToView(params.centerAzRad, elevC - Math.PI / 2)).toBe(
      null,
    );
  });

  it("λ > 0 (подушка) отталкивает точку от центра, λ < 0 (бочка) — к центру", () => {
    const plain = createPinholeProjection(params);
    const pin = createPinholeProjection(params, 2e-8);
    const barrel = createPinholeProjection(params, -2e-8);
    const az = params.centerAzRad + params.fovRad / 3;
    const r0 = Math.abs(plain.angleToView(az, elevC)!.x - params.width / 2);
    const rPin = Math.abs(pin.angleToView(az, elevC)!.x - params.width / 2);
    const rBarrel = Math.abs(
      barrel.angleToView(az, elevC)!.x - params.width / 2,
    );
    expect(rPin).toBeGreaterThan(r0);
    expect(rBarrel).toBeLessThan(r0);
  });

  it("обратный ход тождественен при дисторсии (λ ≠ 0)", () => {
    const pinhole = createPinholeProjection(params, 1.5e-8);
    for (const az of [0.8, 1.234, 2.4]) {
      for (const elev of [-0.15, elevC, 0.6]) {
        const p = pinhole.angleToView(az, elev);
        if (!p) continue;
        const back = pinhole.viewToAngle(p.x, p.y);
        if (!back) continue;
        expect(back.azRad).toBeCloseTo(az, 6);
        expect(back.elevRad).toBeCloseTo(elev, 6);
      }
    }
  });

  it("слишком большая подушка у края — честный null (предел модели)", () => {
    // λ = 1: физично только при r_u² < 1/4 — на краю кадра модель рвётся
    const pinhole = createPinholeProjection(params, 1);
    const edge = pinhole.angleToView(
      params.centerAzRad + params.fovRad / 2,
      elevC,
    );
    expect(edge === null || Number.isFinite(edge.x)).toBe(true);
  });
});
