/**
 * Углы обзора камеры и экрана: одна формула для панорамы, AR и калибровки.
 *
 * В вебе браузер не отдаёт фокусное расстояние объектива (в Media Capture
 * его нет вовсе), поэтому базовый угол берётся из калибровки, а всё
 * остальное честно выводится геометрией:
 *
 *   - **портрет/ландшафт** — второй угол выводится через тангенс, а не
 *     пропорцией: только так пиксель «стоит» одинаково по обеим осям;
 *   - **зум камеры** (MediaTrackSettings.zoom, Android Chrome) — сужает оба
 *     угла: tan(FOV/2) делится на коэффициент;
 *   - **cover-кроп** в AR — видео рисуется с заполнением экрана, края кадра
 *     обрезаны, и видимый угол меньше угла сенсора. Без учёта обрезки
 *     оверлей совпадал с кадром в центре и расходился у краёв.
 */

/** Углы обзора кадра, рад */
export interface FrameFov {
  /** По горизонтали */
  h: number;
  /** По вертикали */
  v: number;
}

/**
 * Углы обзора прямоугольного кадра, если по длинной стороне задан baseRad.
 * Как у объектива: длинная сторона всегда получает базовый угол, короткая —
 * производный. Иначе поворот телефона менял бы масштаб картинки.
 */
export function fovForFrame(
  baseRad: number,
  width: number,
  height: number,
): FrameFov {
  if (width <= 0 || height <= 0) return { h: baseRad, v: baseRad };
  const half = Math.tan(baseRad / 2);
  if (width >= height) {
    return { h: baseRad, v: 2 * Math.atan((half * height) / width) };
  }
  return { v: baseRad, h: 2 * Math.atan((half * width) / height) };
}

/** Зум камеры: 1 = без зума, 2 = двукратное приближение (угол вдвое меньше) */
export function applyZoom(fov: FrameFov, zoom: number): FrameFov {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    h: 2 * Math.atan(Math.tan(fov.h / 2) / z),
    v: 2 * Math.atan(Math.tan(fov.v / 2) / z),
  };
}

/**
 * Видимый угол обзора, когда кадр рисуется с заполнением (object-fit: cover):
 * короткая сторона кадра вылезает за экран и обрезается.
 *
 * @param fov углы ПОЛНОГО кадра камеры
 * @param frameW/frameH размеры кадра камеры, пиксели
 * @param viewW/viewH размеры области показа, пиксели
 */
export function applyCoverCrop(
  fov: FrameFov,
  frameW: number,
  frameH: number,
  viewW: number,
  viewH: number,
): FrameFov {
  if (frameW <= 0 || frameH <= 0 || viewW <= 0 || viewH <= 0) return fov;
  const scale = Math.max(viewW / frameW, viewH / frameH);
  const fx = Math.min(1, viewW / (frameW * scale));
  const fy = Math.min(1, viewH / (frameH * scale));
  return {
    h: 2 * Math.atan(Math.tan(fov.h / 2) * fx),
    v: 2 * Math.atan(Math.tan(fov.v / 2) * fy),
  };
}

/**
 * Доля высоты кадра камеры, на которую приходится линия горизонта оверлея,
 * когда кадр показан с cover-кропом.
 *
 * Нужна автокалибровке (core/skyline.ts): профиль «небо/земля» измеряется в
 * долях высоты ПОЛНОГО кадра, а рисуем мы горизонт на доле высоты ЭКРАНА —
 * при разных пропорциях это разные строки кадра.
 */
export function horizonFracInFrame(
  frameW: number,
  frameH: number,
  viewW: number,
  viewH: number,
  horizonFracView: number,
): number {
  if (frameW <= 0 || frameH <= 0 || viewW <= 0 || viewH <= 0) {
    return horizonFracView;
  }
  const scale = Math.max(viewW / frameW, viewH / frameH);
  const drawnH = frameH * scale;
  // Обратный ход от экранной строки к строке полного кадра
  return (horizonFracView * viewH - (viewH - drawnH) / 2) / drawnH;
}
