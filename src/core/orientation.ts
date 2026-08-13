/**
 * Ориентация устройства (ROADMAP 2.3, ALGORITHMS.md §3):
 * deviceorientation absolute + комплементарный фильтр.
 *
 * Стратегия:
 *   - iOS 13+: DeviceOrientationEvent.requestPermission() по user gesture
 *   - Android: deviceorientationabsolute (истинный север) или deviceorientation
 *   - Fallback: ручной свайп (уже есть) + оффсет на сессию
 */

export interface OrientationState {
  /** Азимут (истинный север), рад [0, 2π) */
  azimuthRad: number;
  /** Наклон (beta: −180..180 → 0 = горизонтально), рад */
  tiltRad: number;
  /** Точность компаса (iOS webkitCompassAccuracy), градусы или −1 */
  accuracyDeg: number;
  /** Откуда данные: 'sensor' | 'manual' | 'none' */
  source: 'sensor' | 'manual' | 'none';
}

type OrientationCallback = (state: OrientationState) => void;

/** Сглаживание сырых данных компаса */
const GYRO_SMOOTH_WINDOW = 5;

/**
 * Куда смотрит человек сквозь экран: азимут и угол над горизонтом.
 *
 * Считается по полной матрице поворота (W3C: R = Rz(α)·Rx(β)·Ry(γ)), а не по
 * одному α. Разница видна ровно тогда, когда телефон переворачивают в
 * горизонтальное положение: у поднятого вертикально телефона β ≈ 90°, и в
 * этой точке α с γ вырождаются — поворот вокруг оси взгляда меняет α на те же
 * 90°, хотя смотрит человек в ту же сторону. Панорама уезжала на четверть
 * горизонта. По той же причине наклон нельзя брать из β: в ландшафте за него
 * отвечает уже γ.
 *
 * Направление взгляда — ось −Z устройства (сквозь экран от лица). Угол
 * поворота экрана (screen.orientation.angle) на него не влияет: вращение
 * вокруг оси взгляда меняет только крен кадра, а горизонт мы всегда держим
 * ровным.
 */
export function lookFromDeviceOrientation(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
): { azimuthRad: number; elevationRad: number } {
  const a = (alphaDeg * Math.PI) / 180;
  const b = (betaDeg * Math.PI) / 180;
  const g = (gammaDeg * Math.PI) / 180;
  const [sa, ca] = [Math.sin(a), Math.cos(a)];
  const [sb, cb] = [Math.sin(b), Math.cos(b)];
  const [sg, cg] = [Math.sin(g), Math.cos(g)];

  // Третий столбец R = Rz(α)·Rx(β)·Ry(γ) — куда в системе Земли смотрит
  // ось +Z устройства (из экрана к лицу); взгляд — противоположная сторона.
  // Оси Земли по спецификации: X — восток, Y — север, Z — вверх.
  const zx = ca * sg + sa * sb * cg;
  const zy = sa * sg - ca * sb * cg;
  const zz = cb * cg;

  const lookX = -zx;
  const lookY = -zy;
  const lookZ = -zz;
  const horizontal = Math.hypot(lookX, lookY);

  return {
    azimuthRad: normalizeAngle(Math.atan2(lookX, lookY)),
    elevationRad: Math.atan2(lookZ, horizontal),
  };
}

class OrientationTracker {
  private state: OrientationState = {
    azimuthRad: 0,
    tiltRad: 0,
    accuracyDeg: -1,
    source: 'none',
  };
  private callback: OrientationCallback | null = null;
  private lastTimestamp = 0;
  private gyroSamples: number[] = [];
  private listening = false;
  private manualOffsetRad = 0; // ручная подстройка (свайп)

  start(callback: OrientationCallback): void {
    this.callback = callback;
    if (this.listening) return;

    // iOS 13+: запрос разрешения
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      'requestPermission' in DeviceOrientationEvent
    ) {
      // Нужен user gesture — показываем кнопку «Включить компас»
      this.requestPermissionIOS();
      return;
    }

    this.listen();
  }

  private async requestPermissionIOS(): Promise<void> {
    try {
      const DOE = DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<string>;
      };
      const result = await DOE.requestPermission?.();
      if (result === 'granted') {
        this.listen();
      } else {
        this.state.source = 'manual';
        this.callback?.(this.state);
      }
    } catch {
      this.state.source = 'manual';
      this.callback?.(this.state);
    }
  }

  private listen(): void {
    this.listening = true;

    // Предпочитаем absolute (истинный север); fallback — обычный
    const handler = (ev: DeviceOrientationEvent) => this.onOrientation(ev);
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', handler as EventListener, true);
    }
    window.addEventListener('deviceorientation', handler as EventListener, true);
  }

  private onOrientation(ev: DeviceOrientationEvent): void {
    if (ev.alpha === null) return;

    const now = performance.now();
    this.lastTimestamp = now;

    // iOS: webkitCompassHeading (0–360, от севера по часовой) — единственный
    // абсолютный источник, у самой alpha там произвольный ноль. Переводим его
    // обратно в alpha-подобный угол, чтобы матрица считалась одинаково.
    const webkit = ev as DeviceOrientationEvent & {
      webkitCompassHeading?: number;
      webkitCompassAccuracy?: number;
    };
    const accuracy =
      webkit.webkitCompassHeading !== undefined ? (webkit.webkitCompassAccuracy ?? -1) : -1;
    const alphaDeg =
      webkit.webkitCompassHeading !== undefined
        ? 360 - webkit.webkitCompassHeading
        : (ev.alpha ?? 0);

    const look = lookFromDeviceOrientation(alphaDeg, ev.beta ?? 0, ev.gamma ?? 0);

    // Комплементарный фильтр: сглаживаем скачки компаса
    this.gyroSamples.push(look.azimuthRad);
    if (this.gyroSamples.length > GYRO_SMOOTH_WINDOW) {
      this.gyroSamples.shift();
    }

    // Круговое среднее (чтобы 359° и 1° не давали 180°)
    const smoothed = circularMean(this.gyroSamples);

    // Применяем ручную подстройку (свайп-оффсет)
    const finalAz = normalizeAngle(smoothed + this.manualOffsetRad);

    const prev = this.state;
    this.state = {
      azimuthRad: finalAz,
      tiltRad: look.elevationRad,
      accuracyDeg: accuracy,
      source: 'sensor',
    };

    // Отправляем только при значимом изменении (>0.1°) или раз в 100 мс
    const diff = Math.abs(normalizeAngle(finalAz - prev.azimuthRad));
    if (diff > 0.0017 || now - this.lastTimestamp > 100) {
      this.callback?.(this.state);
    }
  }

  /** Ручная подстройка (свайп): добавляет оффсет к сенсорному азимуту */
  addManualOffset(deltaRad: number): void {
    this.manualOffsetRad = normalizeAngle(this.manualOffsetRad + deltaRad);
    this.state.azimuthRad = normalizeAngle(
      this.state.azimuthRad + deltaRad,
    );
    this.callback?.(this.state);
  }

  /** Сброс оффсета (после калибровки по солнцу) */
  resetOffset(): void {
    this.manualOffsetRad = 0;
  }

  get current(): OrientationState {
    return this.state;
  }

  stop(): void {
    this.listening = false;
    this.callback = null;
  }
}

/** Круговое среднее углов (рад) */
function circularMean(angles: number[]): number {
  let sinSum = 0;
  let cosSum = 0;
  for (const a of angles) {
    sinSum += Math.sin(a);
    cosSum += Math.cos(a);
  }
  return Math.atan2(sinSum / angles.length, cosSum / angles.length);
}

function normalizeAngle(rad: number): number {
  let a = rad % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a;
}

export const orientationTracker = new OrientationTracker();
