/**
 * Доворот кадра камеры к программному повороту UI (AR).
 *
 * Задача: интерфейс поворачивается CSS-трансформом body на ±90°
 * (программный ландшафт, core/screen-orientation.ts), а системная ориентация
 * окна при этом НЕ меняется. Кадр камеры, отдаваемый в drawImage(video),
 * ориентирован относительно ОКНА (современный Android Chrome компенсирует
 * монтаж сенсора под системную ориентацию окна; iOS — под UI). Окно наше
 * повёрнуто на C — значит, кадр надо довернуть обратно на −C, иначе мир в
 * нём лежит боком, пока контуры (они в осях UI) стоят правильно.
 *
 * Ключевое свойство модели: доворот — константа сессии, а не функция
 * физической позы (хвата). Хват влияет на то, ЧТО видит камера, но не на
 * то, как кадр соотносится с окном. Это и делает прошлый детектор
 * «кадр шире высоты, холст выше ширины» мёртвым: при программном ландшафте
 * холст в локальных осях как раз ландшафтный, условие не выполняется никогда.
 *
 * Ветка «сырой сенсор» (старые Chrome, не компенсирующие под окно) — поле
 * mode на будущее: там доворот = sensorMount − windowAngle − C. Определяется
 * она не из кода, а калибровкой на устройстве (VideoFrame.rotation из
 * WebCodecs, где доступен, либо отладочным оверлеем).
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
  const base =
    mode === "browser-compensated" ? 0 : sensorMountDeg - windowAngleDeg;
  const r = (((base - cssAngleDeg) % 360) + 360) % 360;
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
