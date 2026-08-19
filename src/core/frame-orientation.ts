/**
 * Доворот кадра камеры к программному повороту UI (AR).
 *
 * Задача: интерфейс поворачивается CSS-трансформом body на ±90°
 * (программный ландшафт, core/screen-orientation.ts). Кадр камеры,
 * отдаваемый в drawImage(video), ориентирован относительно ОКНА (современный
 * Android Chrome компенсирует монтаж сенсора под системную ориентацию окна;
 * iOS — под UI). Но body при CSS-повороте уже повёрнут ВМЕСТЕ с видео —
 * поэтому в ветке browser-compensated доворачивать кадр НЕ нужно: кадр
 * портретный (под портретное окно), body поворачивает его в ландшафт, глаз
 * держащего телефон видит мир ровно. Композиция «кадр→окно→CSS→глаз»
 * сходится в тождество.
 *
 * Подтверждено на устройстве (Samsung, скриншоты отладочного оверлея):
 * в программном ландшафте frame: 1080×1920 (кадр портретный), и доворот
 * R=−C ложил его боком — значит, кадр уже был правильный, и доворот
 * не нужен вовсе.
 */

import { softAngleDeg } from "./screen-orientation";

/** Как браузер ориентирует кадр getUserMedia */
export type FrameSourceMode =
  /** Кадр уже довёрнут под системную ориентацию окна (современный Chrome, iOS) */
  | "browser-compensated"
  /** Сырые данные сенсора в его монтажной ориентации (старые/особые случаи) */
  | "raw-sensor";

/**
 * Доворот кадра при drawImage, градусы CW по модулю 360: 0 | 90 | 180 | 270.
 *
 * @param cssAngleDeg угол программного поворота body (−90 | 0 | +90)
 * @param mode ветка ориентации кадра (см. выше)
 * @param windowAngleDeg системная ориентация окна (screen.orientation.angle)
 * @param sensorMountDeg монтаж сенсора относительно портрета (Android задняя: 90)
 */
export function frameRotationDeg(
  cssAngleDeg: number,
  mode: FrameSourceMode = "browser-compensated",
  windowAngleDeg = 0,
  sensorMountDeg = 90,
): 0 | 90 | 180 | 270 {
  // browser-compensated: кадр уже ориентирован под окно, а body повёрнут
  // вместе с видео — доворачивать нечего, cssAngle не входит в формулу
  const base =
    mode === "browser-compensated"
      ? 0
      : sensorMountDeg - windowAngleDeg - cssAngleDeg;
  const r = ((base % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/**
 * Доворот кадра под ТЕКУЩЕЕ состояние интерфейса. Единственный источник
 * истины для всех потребителей (экран AR, проба автокалибровки, снимок) —
 * локальные копии логики расходятся.
 */
export function currentFrameRotationDeg(): 0 | 90 | 180 | 270 {
  return frameRotationDeg(softAngleDeg());
}

/**
 * Эффективные размеры кадра после доворота: при ±90° ширина и высота
 * меняются местами. От них считаются FOV и cover-кроп.
 */
export function rotatedFrameSize(
  frameW: number,
  frameH: number,
  rotationDeg: number,
): { w: number; h: number } {
  return rotationDeg === 90 || rotationDeg === 270
    ? { w: frameH, h: frameW }
    : { w: frameW, h: frameH };
}

/**
 * Нарисовать кадр камеры с доворотом и cover-кропом по центру холста.
 * Все потребители (экран AR, проба автокалибровки, фото) рисуют через него —
 * иначе системы координат расходятся.
 *
 * @param rotationDeg доворот CW; 0 — обычный drawImage без трансформов
 */
export function drawVideoAligned(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  targetW: number,
  targetH: number,
  rotationDeg: 0 | 90 | 180 | 270,
): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw <= 0 || vh <= 0) return;
  const { w: pw, h: ph } = rotatedFrameSize(vw, vh, rotationDeg);
  const scale = Math.max(targetW / pw, targetH / ph);
  if (rotationDeg === 0) {
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(video, (targetW - dw) / 2, (targetH - dh) / 2, dw, dh);
    return;
  }
  ctx.save();
  ctx.translate(targetW / 2, targetH / 2);
  ctx.rotate((rotationDeg * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.drawImage(video, -vw / 2, -vh / 2);
  ctx.restore();
}
