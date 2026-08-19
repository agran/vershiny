/**
 * Доворот кадра камеры к программному повороту UI (AR).
 *
 * Задача: интерфейс поворачивается CSS-трансформом body на ±90°
 * (программный ландшафт, core/screen-orientation.ts), а системная
 * ориентация окна при этом НЕ меняется. Кадр getUserMedia современные
 * браузеры (Android Chrome и производные, iOS) компенсируют под ориентацию
 * ОКНА — то есть кадр приходит «ровным» относительно физического экрана,
 * независимо от того, как держат телефон.
 *
 * drawImage(video) рисует сырые пиксели кадра и CSS-трансформ video-элемента
 * НЕ применяет. Поэтому в повёрнутом на C интерфейсе картинка лежит на боку:
 * кадр надо довернуть обратно на −C. Доворот — константа сессии (знак C не
 * зависит от физического хвата: хват меняет то, ЧТО видит камера, а не то,
 * как кадр соотносится с окном).
 *
 * Все потребители кадра (экран AR, снимок, проба автокалибровки) обязаны
 * рисовать через одну и ту же пару rotatedFrameSize/drawVideoAligned и
 * считать FOV от повёрнутых размеров — иначе оверлей не ляжет на кадр.
 */

import { softAngleDeg } from "./screen-orientation";

/**
 * Доворот кадра при drawImage, градусы CW (0 | 90 | 180 | 270).
 *
 * @param cssAngleDeg угол программного поворота body (−90 | 0 | +90)
 */
export function frameRotationDeg(cssAngleDeg: number): 0 | 90 | 180 | 270 {
  return (((-cssAngleDeg % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

/** Доворот кадра под ТЕКУЩИЙ программный поворот интерфейса */
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
 * Нарисовать кадр камеры с доворотом и cover-кропом по центру.
 * Единственный способ рисовать видео в AR — экран, снимок и проба
 * автокалибровки должны показывать одинаково повёрнутый кадр.
 *
 * @param rotationDeg доворот CW: 0 — обычный drawImage без трансформов
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
