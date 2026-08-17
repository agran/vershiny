/**
 * Ориентация устройства (ROADMAP 2.3, ALGORITHMS.md §3):
 * deviceorientation absolute + комплементарный фильтр.
 *
 * Стратегия:
 *   - iOS 13+: DeviceOrientationEvent.requestPermission() по user gesture
 *   - Android: deviceorientationabsolute или deviceorientation
 *   - Fallback: ручной свайп + поправка из калибровки (core/calibration.ts)
 *
 * Важно: «absolute» у обеих платформ — от **магнитного** севера, а панорама
 * строится от истинного. Склонение (на Кавказе +7°, на Камчатке −9°) мы
 * добавляем сами по модели WMM (core/declination.ts), как только известно
 * физическое положение (setLocation). Ручная поправка в калибровке остаётся —
 * она теперь закрывает только железо рядом и дешёвый магнитометр.
 * На iOS webkitCompassHeading тоже магнитный: WebKit транслирует
 * CLHeading.magneticHeading, а не trueHeading (подтверждено по исходникам
 * WebKit и спецификации WebKit DOM Additions, 2026-08).
 */

import { getCalibration, setCalibration } from './calibration';
import { decimalYear, magneticDeclinationDeg } from './declination';

export interface OrientationState {
  /** Азимут (истинный север), рад [0, 2π) */
  azimuthRad: number;
  /** Наклон (beta: −180..180 → 0 = горизонтально), рад */
  tiltRad: number;
  /**
   * Точность компаса (iOS webkitCompassAccuracy), градусы. Отрицательное
   * значение — датчик раскалиброван: iOS отдаёт −1, когда магнитометру
   * нельзя верить, пока человек не покрутит телефон «восьмёркой».
   */
  accuracyDeg: number;
  /** Откуда данные: 'sensor' | 'manual' | 'none' */
  source: 'sensor' | 'manual' | 'none';
}

type OrientationCallback = (state: OrientationState) => void;

/** Сглаживание сырых данных компаса */
const GYRO_SMOOTH_WINDOW = 5;
/** Изменение меньше этого считаем дрожанием датчика, рад (≈2°) */
const NOISE_RAD = 0.035;
/** Изменение больше этого — осознанный поворот, пропускаем как есть, рад (≈8°) */
const MOTION_RAD = 4 * NOISE_RAD;
/** Минимальная доля шага: иначе за медленным поворотом картинка не поспевает */
const MIN_FOLLOW = 0.12;

/**
 * Годится ли показание как источник абсолютного азимута.
 *
 * На Android приходят два разных события: `deviceorientationabsolute` — от
 * севера, и `deviceorientation` — от произвольного нуля, выбранного при
 * запуске. Раньше оба висели на одном обработчике, и панораму дёргало между
 * двумя системами отсчёта: на глаз — рывки в десятки градусов на месте.
 *
 * На iOS всё наоборот: absolute-события не приходят вовсе, а абсолютный
 * компас живёт в `webkitCompassHeading` обычного события — такое пропускаем
 * всегда.
 */
export function isAbsoluteReading(
  eventType: string,
  hasCompassHeading: boolean,
  isAbsoluteFlag: boolean,
  seenAbsolute: boolean,
): boolean {
  if (eventType === 'deviceorientationabsolute') return true;
  if (hasCompassHeading || isAbsoluteFlag) return true;
  // Относительное показание годится, только если абсолютного нет вовсе
  return !seenAbsolute;
}

/**
 * Слежение картинки за компасом: дрожание гасим, поворот пропускаем.
 *
 * Компас телефона шумит на единицы градусов даже в покое, а среднее по окну
 * этот шум только размазывает. Поэтому доля, на которую картинка подтягивается
 * к показанию, растёт вместе с величиной расхождения: мелочь почти игнорируем,
 * настоящий поворот отрабатываем целиком.
 */
export function followAzimuth(prevRad: number, targetRad: number): number {
  // Один NaN от датчика (Firefox for Android и часть WebView кладут его в
  // webkitCompassHeading, когда абсолютного азимута нет) иначе прилипал
  // навсегда: diff от NaN — NaN, и вся отрисовка получала NaN-координаты
  if (!Number.isFinite(targetRad)) return Number.isFinite(prevRad) ? normalizeAngle(prevRad) : 0;
  if (!Number.isFinite(prevRad)) return normalizeAngle(targetRad);
  const diff = shortestAngle(targetRad - prevRad);
  const k = Math.min(1, Math.max(MIN_FOLLOW, Math.abs(diff) / MOTION_RAD));
  return normalizeAngle(prevRad + diff * k);
}

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
  private lastEmitted = 0;
  private gyroSamples: number[] = [];
  private listening = false;
  /** Ждём жеста пользователя для запроса доступа к датчикам (iOS 13+) */
  private permissionPending = false;
  /** Слушатели событий ориентации: нужны, чтобы stop() их действительно снял */
  private handler: ((ev: Event) => void) | null = null;
  /** Пришло ли хоть одно абсолютное показание (север, а не произвольный ноль) */
  private seenAbsolute = false;
  /** Сглаженный азимут без ручной поправки, рад */
  private followedRad: number | null = null;
  /** Физическое положение устройства (GPS) — для склонения по WMM */
  private locationDeg: { lat: number; lon: number } | null = null;
  /** Кэш склонения: WMM-суммирование — ~90 гармоник, на каждое событие незачем */
  private declinationCache: { key: string; rad: number } | null = null;

  /**
   * Физическое положение устройства (не виртуальная точка обзора!).
   * По нему считается магнитное склонение: компас отсчитывает азимут от
   * магнитного севера, и поправка зависит от того, где стоит человек.
   */
  setLocation(latDeg: number, lonDeg: number): void {
    this.locationDeg = { lat: latDeg, lon: lonDeg };
  }

  /**
   * Склонение в текущей точке, рад. Кэшируем по округлённым координатам
   * и дате: поле меняется на градусы за сотни километров и за годы.
   */
  private declinationRad(): number {
    if (!this.locationDeg) return 0;
    const year = decimalYear();
    const key =
      `${Math.round(this.locationDeg.lat * 2)},` +
      `${Math.round(this.locationDeg.lon * 2)},${Math.round(year * 10)}`;
    if (this.declinationCache?.key !== key) {
      const deg = magneticDeclinationDeg(
        this.locationDeg.lat,
        this.locationDeg.lon,
        year,
      );
      this.declinationCache = { key, rad: (deg * Math.PI) / 180 };
    }
    return this.declinationCache.rad;
  }

  /** Ручная подстройка (свайп по кадру); хранится в калибровке, рад */
  private get manualOffsetRad(): number {
    return (getCalibration().azimuthDeg * Math.PI) / 180;
  }

  /**
   * Нужен ли жест пользователя, чтобы включить компас.
   *
   * Интерфейс по этому флагу показывает кнопку «Включить компас»: на iOS
   * `requestPermission()` работает только из обработчика жеста, а вызов при
   * загрузке страницы Safari отклоняет молча — компас не включался никогда,
   * и на iPhone оставался только ручной свайп.
   */
  get needsPermission(): boolean {
    return this.permissionPending && !this.listening;
  }

  /**
   * Компасу нельзя верить: iOS сообщила отрицательную точность (−1 —
   * магнитометр раскалиброван) или прислала системное событие
   * `compassneedscalibration`. Пока флаг стоит, показания азимута
   * недостоверны, и интерфейсу лучше показать подсказку про «восьмёрку».
   */
  get needsCalibration(): boolean {
    return (
      this.calibrationRequested ||
      (this.state.source === 'sensor' && this.state.accuracyDeg < 0)
    );
  }

  /** iOS попросила калибровку системным событием compassneedscalibration */
  private calibrationRequested = false;

  start(callback: OrientationCallback): void {
    this.callback = callback;
    if (this.listening) return;

    // iOS 13+: доступ к датчикам даётся только из обработчика жеста
    if (needsUserGesture()) {
      this.permissionPending = true;
      this.state.source = 'manual';
      this.callback(this.state);
      return;
    }

    this.listen();
  }

  /**
   * Запрос доступа к датчикам. Вызывать только из обработчика жеста
   * пользователя (нажатие кнопки), иначе iOS откажет.
   *
   * @returns удалось ли включить компас
   */
  async requestPermission(): Promise<boolean> {
    if (this.listening) return true;
    // Запрос идёт через await: два быстрых нажатия кнопки иначе открывают два
    // системных диалога подряд. Переиспользуем уже начатый
    this.permissionRequest ??= this.doRequestPermission().finally(() => {
      this.permissionRequest = null;
    });
    return this.permissionRequest;
  }

  private permissionRequest: Promise<boolean> | null = null;

  private async doRequestPermission(): Promise<boolean> {
    try {
      const DOE = DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<string>;
      };
      const result = await DOE.requestPermission?.();
      if (result === 'granted') {
        this.permissionPending = false;
        this.listen();
        return true;
      }
    } catch {
      // Отказ или вызов вне жеста — остаёмся на ручной подстройке
    }
    this.state.source = 'manual';
    this.callback?.(this.state);
    return false;
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.permissionPending = false;

    // Оба события ведут в один обработчик, но относительное (произвольный
    // ноль) используется только пока нет абсолютного — см. isAbsoluteReading
    const handler = (ev: Event) => this.onOrientation(ev as DeviceOrientationEvent, ev.type);
    this.handler = handler;
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', handler, true);
    }
    window.addEventListener('deviceorientation', handler, true);
    // iOS сама просит калибровку: событие приходит, когда магнитометр
    // раскалиброван или рядом источник помех
    window.addEventListener('compassneedscalibration', this.onCalibrationNeeded, true);
  }

  private onCalibrationNeeded = (): void => {
    if (this.calibrationRequested) return;
    this.calibrationRequested = true;
    this.callback?.(this.state); // UI перечитает needsCalibration
  };

  private onOrientation(ev: DeviceOrientationEvent, eventType: string): void {
    if (ev.alpha === null) return;

    // iOS: webkitCompassHeading (0–360, от МАГНИТНОГО севера по часовой) —
    // единственный абсолютный источник, у самой alpha там произвольный ноль.
    // Переводим его обратно в alpha-подобный угол, чтобы матрица считалась
    // одинаково. Склонение добавится ниже, как и на Android.
    const webkit = ev as DeviceOrientationEvent & {
      webkitCompassHeading?: number;
      webkitCompassAccuracy?: number;
    };
    // Проверка именно на конечность, а не на undefined: часть WebView и
    // Firefox for Android кладут в это поле NaN, когда абсолютного азимута
    // нет. Раньше такое показание считалось абсолютным, NaN расползался по
    // всему состоянию и рисовать становилось нечего — до перезагрузки
    const heading = webkit.webkitCompassHeading;
    const hasCompass = Number.isFinite(heading);
    if (!isAbsoluteReading(eventType, hasCompass, ev.absolute === true, this.seenAbsolute)) {
      return;
    }

    const alphaDeg = hasCompass ? 360 - (heading as number) : (ev.alpha ?? 0);
    const betaDeg = ev.beta ?? 0;
    const gammaDeg = ev.gamma ?? 0;
    if (!Number.isFinite(alphaDeg) || !Number.isFinite(betaDeg) || !Number.isFinite(gammaDeg)) {
      return;
    }

    const look = lookFromDeviceOrientation(alphaDeg, betaDeg, gammaDeg);
    if (!Number.isFinite(look.azimuthRad) || !Number.isFinite(look.elevationRad)) return;

    // Флаг «абсолютное показание уже видели» ставим только по годным данным:
    // иначе одно битое событие закрывало дорогу относительным показаниям,
    // которые в этот момент — единственный рабочий источник
    const absolute =
      eventType === 'deviceorientationabsolute' || hasCompass || ev.absolute === true;
    if (absolute) {
      this.seenAbsolute = true;
    }

    // Компас отсчитывает азимут от магнитного севера — переводим в истинный
    // по WMM. Только абсолютным показаниям: у относительных ноль произвольный,
    // и склонение было бы просто лишним сдвигом.
    const azimuthRad = absolute
      ? normalizeAngle(look.azimuthRad + this.declinationRad())
      : look.azimuthRad;

    const now = performance.now();
    const accuracy = hasCompass ? (webkit.webkitCompassAccuracy ?? -1) : -1;

    // Комплементарный фильтр: сглаживаем скачки компаса
    this.gyroSamples.push(azimuthRad);
    if (this.gyroSamples.length > GYRO_SMOOTH_WINDOW) {
      this.gyroSamples.shift();
    }

    // Круговое среднее (чтобы 359° и 1° не давали 180°), затем слежение с
    // подавлением дрожания: одного среднего мало — шум компаса оно размазывает
    const smoothed = circularMean(this.gyroSamples);
    this.followedRad =
      this.followedRad === null ? smoothed : followAzimuth(this.followedRad, smoothed);

    // Применяем ручную подстройку (свайп-оффсет)
    const finalAz = normalizeAngle(this.followedRad + this.manualOffsetRad);

    // Точность вернулась в норму — системная просьба о калибровке отработана
    if (accuracy >= 0) this.calibrationRequested = false;

    const prev = this.state;
    this.state = {
      azimuthRad: finalAz,
      tiltRad: look.elevationRad,
      accuracyDeg: accuracy,
      source: 'sensor',
    };

    // Отправляем только при значимом изменении (>0.1°) или раз в 100 мс:
    // сравнивать нужно со временем прошлой отправки, а не с текущим.
    // Смена флага калибровки — тоже повод сообщить: UI показывает подсказку
    const wasUncalibrated = prev.source === 'sensor' && prev.accuracyDeg < 0;
    const isUncalibrated = accuracy < 0;
    const diff = Math.abs(shortestAngle(finalAz - prev.azimuthRad));
    if (
      diff > 0.0017 ||
      now - this.lastEmitted > 100 ||
      wasUncalibrated !== isUncalibrated
    ) {
      this.lastEmitted = now;
      this.callback?.(this.state);
    }
  }

  /** Ручная подстройка (свайп): добавляет оффсет к сенсорному азимуту */
  addManualOffset(deltaRad: number): void {
    const deltaDeg = (deltaRad * 180) / Math.PI;
    setCalibration({ azimuthDeg: getCalibration().azimuthDeg + deltaDeg });
    this.state.azimuthRad = normalizeAngle(this.state.azimuthRad + deltaRad);
    this.callback?.(this.state);
  }

  /** Сброс оффсета (после калибровки по солнцу или из настроек) */
  resetOffset(): void {
    setCalibration({ azimuthDeg: 0 });
  }

  /** Пересобрать состояние после правки калибровки в настройках */
  applyCalibration(): void {
    this.callback?.(this.state);
  }

  get current(): OrientationState {
    return this.state;
  }

  stop(): void {
    // Слушатели снимаем вместе с флагом: иначе повторный start() навешивал бы
    // второй комплект обработчиков поверх живого первого
    if (this.handler) {
      window.removeEventListener('deviceorientationabsolute', this.handler, true);
      window.removeEventListener('deviceorientation', this.handler, true);
      this.handler = null;
    }
    window.removeEventListener('compassneedscalibration', this.onCalibrationNeeded, true);
    this.calibrationRequested = false;
    this.listening = false;
    this.callback = null;
  }
}

/**
 * Требует ли платформа жеста пользователя для доступа к датчикам (iOS 13+).
 */
export function needsUserGesture(): boolean {
  return (
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown })
      .requestPermission === 'function'
  );
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

/** Кратчайшая разница углов: (−π, π] */
function shortestAngle(rad: number): number {
  let a = normalizeAngle(rad);
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

export const orientationTracker = new OrientationTracker();
