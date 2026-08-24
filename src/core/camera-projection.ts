/**
 * Единая проекция «угол обзора (азимут, возвышение) ↔ пиксели кадра».
 *
 * План docs/AR-PROJECTION.md. Исторически каждая точка кодовой базы сама
 * считала линейный масштаб «пиксель на радиан» (panorama.ts, ar.ts,
 * main.ts, skyline.ts) — и любая будущая модель камеры (пинхол, дисторсия)
 * разъехалась бы на этих обратных пересчётах ровно так же, как линейная
 * сейчас разъезжается с реальным фото у краёв кадра. Здесь одна точка
 * правды: прямая отрисовка и ВСЕ обратные пересчёты (перетаскивание,
 * дрейф кеша, экстракция силуэта кадра, NN-фолбэк) обязаны ходить через
 * один и тот же объект проекции.
 *
 * Два режима:
 * - LinearProjection — линейная (постоянный px/рад); панорама 360° остаётся
 *   на ней навсегда (правильное окно в цилиндр — при панорамировании края
 *   не плывут);
 * - PinholeProjection — гномоника (прямолинейная проекция пинхола) с
 *   поворотом наклона и division-моделью дисторсии Фицгиббона (один
 *   параметр λ): так устроено реальное фото после прошивочной коррекции.
 *
 * Соглашение о наклоне: `tiltRad` — возвышение, на которое смотрит
 * опорная линия `horizonFrac` (как в ViewState), а не оптическая ось.
 * Пинхол пересчитывает опорное возвышение в свою систему:
 * elevC = tiltRad + (horizonFrac − 0.5)·fovVRad — в центре кадра обе
 * проекции совпадают.
 *
 * Крен в проекцию не входит: поворот вокруг оптической оси — это в
 * точности поворот картинной плоскости вокруг главной точки, он остаётся
 * canvas-поворотом (rotateAroundCenter).
 */

import { wrapAngle } from "./geo";

/**
 * Pinhole — стандартная модель AR/фото. Панорама 360° на пинхол не
 * переходит никогда: для неё линейное окно цилиндра геометрически верно.
 */
export const PINHOLE_ENABLED = true;

/** Параметры кадра, в котором живёт проекция */
export interface ProjectionParams {
  /** Ширина кадра, px */
  width: number;
  /** Высота кадра, px */
  height: number;
  /** Азимут центра кадра, рад */
  centerAzRad: number;
  /** Наклон: возвышение опорной линии horizonFrac, рад */
  tiltRad: number;
  /** Горизонтальный FOV, рад */
  fovRad: number;
  /** Вертикальный FOV, рад */
  fovVRad: number;
  /** Доля высоты кадра, на которой рисуется линия горизонта (0 = верх) */
  horizonFrac: number;
}

/** Пиксели кадра */
export interface ProjectedPoint {
  x: number;
  y: number;
}

/** Угол обзора */
export interface ViewAngle {
  azRad: number;
  elevRad: number;
}

export interface CameraProjection {
  /** Угол → пиксели кадра; null — точка за камерой */
  angleToView(azRad: number, elevRad: number): ProjectedPoint | null;
  /** Пиксели кадра → угол; null — вне физической модели */
  viewToAngle(x: number, y: number): ViewAngle | null;
}

/**
 * Поправка азимута/наклона, переносящая оверлей вместе с указателем.
 * У линейной модели результат зависит только от дельты пикселей; у пинхола
 * он зависит и от положения курсора, поэтому нельзя подставлять (0, 0).
 */
export function viewDragDelta(
  projection: CameraProjection,
  from: ProjectedPoint,
  to: ProjectedPoint,
): ViewAngle | null {
  const fromAngle = projection.viewToAngle(from.x, from.y);
  const toAngle = projection.viewToAngle(to.x, to.y);
  if (!fromAngle || !toAngle) return null;
  return {
    azRad: fromAngle.azRad - toAngle.azRad,
    elevRad: fromAngle.elevRad - toAngle.elevRad,
  };
}

/**
 * Линейная проекция: x = wrap(az − centerAz)/fovRad·width + width/2,
 * y = horizonFrac·height − (elev − tiltRad)/fovVRad·height.
 * Побитово повторяет прежние формулы azToX/elevToY из panorama.ts.
 */
export function createLinearProjection(p: ProjectionParams): CameraProjection {
  // Порядок операций сохранён как в прежних формулах azToX/elevToY
  // (деление до умножения) — битовое соответствие этапа 0
  const horizonY = p.horizonFrac * p.height;
  return {
    angleToView(azRad, elevRad) {
      const x =
        (wrapAngle(azRad - p.centerAzRad) / p.fovRad) * p.width + p.width / 2;
      const y = horizonY - ((elevRad - p.tiltRad) / p.fovVRad) * p.height;
      return { x, y };
    },
    viewToAngle(x, y) {
      // Азимут возвращается БЕЗ нормализации: так разности точек сохраняют
      // знак и величину (drag/drift), а не скачут через ±π
      return {
        azRad: p.centerAzRad + (x / p.width - 0.5) * p.fovRad,
        elevRad: p.tiltRad + (p.horizonFrac - y / p.height) * p.fovVRad,
      };
    },
  };
}

/**
 * Гномоническая проекция пинхола с division-моделью дисторсии:
 *
 *   направление d = (cos e·sin Δa, sin e, cos e·cos Δa), где Δa = az − az₀;
 *   камера v = Rx(elevC)·d — оптическая ось смотрит на возвышение elevC;
 *   нормированные координаты u = (v_x/v_z, v_y/v_z);
 *   дисторсия (обратный ход, undistort):  r_u = r_d / (1 + λ·r_d²);
 *   прямой ход (нужен на каждый кадр) — корень квадратного уравнения:
 *   r_d = (1 − √(1 − 4λr_u²)) / (2λr_u);
 *   пиксели: x = width/2 + f·d_x,  y = height/2 + f·d_y,
 *   f = (width/2) / tan(fovRad/2).
 *
 * λ нормирован по ПИКСЕЛЯМ кадра (не по f): не меняет смысла при
 * pinch-зуме (правке f) и cover-кропе. λ > 0 — подушка (кадр растянут
 * от центра: r_d ≈ r_u·(1+λr_u²)), λ < 0 — бочка (кадр сжат к центру).
 * Положительное λ физично только при r_u² < 1/(4λ) — дальше null.
 */
export function createPinholeProjection(
  p: ProjectionParams,
  lambda = 0,
): CameraProjection {
  const half = p.fovRad / 2;
  // Guard: вырожденный FOV (0) дал бы бесконечный фокус
  const f = half > 1e-6 ? p.width / 2 / Math.tan(half) : p.width;
  // Возвышение оптической оси: в центре кадра пинхол обязан совпасть
  // с линейной моделью (опорная линия horizonFrac)
  const elevC = p.tiltRad + (p.horizonFrac - 0.5) * p.fovVRad;
  const sinC = Math.sin(elevC);
  const cosC = Math.cos(elevC);
  const cx = p.width / 2;
  const cy = p.height / 2;
  // λ задан в px⁻² (по пикселям кадра — смысл не зависит от f); внутри
  // модель живёт в нормированных координатах u = px/f, поэтому λ·f² разово
  const lam = lambda * f * f;

  /** Нормированные (неискажённые) координаты → искажённые */
  const distort = (ux: number, uy: number): { x: number; y: number } | null => {
    const ru2 = ux * ux + uy * uy;
    if (lam === 0 || ru2 < 1e-12) return { x: ux, y: uy };
    const disc = 1 - 4 * lam * ru2;
    if (disc < 0) return null; // за физическим пределом модели
    const ru = Math.sqrt(ru2);
    const rd = (1 - Math.sqrt(disc)) / (2 * lam * ru);
    const s = rd / ru;
    return { x: ux * s, y: uy * s };
  };

  return {
    angleToView(azRad, elevRad) {
      const dAz = azRad - p.centerAzRad;
      const sinE = Math.sin(elevRad);
      const cosE = Math.cos(elevRad);
      const dx = cosE * Math.sin(dAz);
      const dy = sinE;
      const dz = cosE * Math.cos(dAz);
      // Поворот камеры на elevC вокруг оси x (вниз положительный наклон):
      // v = Rx(elevC)·d
      const vy = cosC * dy - sinC * dz;
      const vz = sinC * dy + cosC * dz;
      if (vz <= 1e-9) return null; // за камерой
      const ud = distort(dx / vz, vy / vz);
      if (!ud) return null;
      // Канвас отсчитывает y ВНИЗ: точка выше оптической оси (v_y > 0) —
      // выше центра кадра, y меньше cy
      return { x: cx + f * ud.x, y: cy - f * ud.y };
    },
    viewToAngle(x, y) {
      const xd = (x - cx) / f;
      // Обратно к прямому ходу: y кадра вниз → камерная ось y вверх
      const yd = (cy - y) / f;
      const rd2 = xd * xd + yd * yd;
      if (lam !== 0 && rd2 > 1e-12) {
        const den = 1 + lam * rd2;
        if (den <= 0) return null; // за физическим пределом модели
        // r_u = r_d/(1 + λr_d²) → точки внутрь в том же масштабе
        const s = 1 / den;
        const ux = xd * s;
        const uy = yd * s;
        // Обратный поворот Rx(−elevC) над однородными (ux, uy, 1)
        const dy = cosC * uy + sinC;
        const dz = -sinC * uy + cosC;
        const norm = Math.hypot(ux, dy, dz);
        return {
          azRad: p.centerAzRad + Math.atan2(ux, dz),
          elevRad: Math.asin(Math.max(-1, Math.min(1, dy / norm))),
        };
      }
      const dy = cosC * yd + sinC;
      const dz = -sinC * yd + cosC;
      const norm = Math.hypot(xd, dy, dz);
      return {
        azRad: p.centerAzRad + Math.atan2(xd, dz),
        elevRad: Math.asin(Math.max(-1, Math.min(1, dy / norm))),
      };
    },
  };
}
