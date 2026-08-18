/**
 * Ориентация устройства (ROADMAP 2.3, ALGORITHMS.md §3):
 * deviceorientation absolute + комплементарный фильтр с гироскопом.
 *
 * Стратегия:
 *   - iOS 13+: DeviceOrientationEvent.requestPermission() по user gesture
 *     (и DeviceMotionEvent.requestPermission() — для гироскопа)
 *   - Android: deviceorientationabsolute или deviceorientation
 *   - Fallback: ручной свайп + поправка из калибровки (core/calibration.ts)
 *
 * Комплементарный фильтр — честный, а не скользящее среднее: азимут
 * интегрируется из rotationRate гироскопа (devicemotion, до 60 Гц, без шума
 * и лага магнитометра), а компас служит только медленным якорем против
 * дрейфа (correctDrift, τ ≈ 1.5 с). Без живого гироскопа (десктоп, часть
 * WebView) — прежняя схема: круговое среднее по окну + followAzimuth.
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
   * NaN — точность неизвестна (Android не сообщает её вовсе).
   */
  accuracyDeg: number;
  /** Откуда данные: 'sensor' | 'manual' | 'none' */
  source: 'sensor' | 'manual' | 'none';
}

type OrientationCallback = (state: OrientationState) => void;

/** Сглаживание сырых данных компаса (fallback без гироскопа) */
const COMPASS_SMOOTH_WINDOW = 5;
/** Изменение меньше этого считаем дрожанием датчика, рад (≈2°) */
const NOISE_RAD = 0.035;
/** Изменение больше этого — осознанный поворот, пропускаем как есть, рад (≈8°) */
const MOTION_RAD = 4 * NOISE_RAD;
/** Минимальная доля шага: иначе за медленным поворотом картинка не поспевает */
const MIN_FOLLOW = 0.12;

/** Гироскоп считается живым, если rotationRate приходил не старше этого, мс */
const GYRO_ALIVE_MS = 500;
/**
 * Максимальный шаг интегрирования, с. После сна вкладки события приходят
 * пачкой — без ограничения один такой шаг закрутил бы азимут на весь
 * накопленный поворот.
 */
const GYRO_MAX_DT_S = 0.1;
/**
 * Постоянная времени подтяжки к компасу, с: быстрые повороты идут за
 * гироскопом, а магнитометр только убирает дрейф. Шум компаса (±2–5°) через
 * такую коррекцию в картинку почти не проходит.
 */
const GYRO_TAU_S = 1.5;
/**
 * Расхождение с компасом больше этого — кандидат на мгновенный приём,
 * рад (≈20°): это не дрейф, а смена системы отсчёта (перекалибровка
 * «восьмёркой», первое absolute-показание после относительных).
 * Но такой же скачок даёт и одиночный выброс магнитометра возле металла —
 * поэтому приём только после подтверждения, см. confirmSnap.
 */
const GYRO_SNAP_RAD = 0.35;
/**
 * Сколько подряд показаний за порогом GYRO_SNAP_RAD подтверждают скачок.
 * При 20–60 Гц событий это 50–150 мс — перекалибровка принимается быстро,
 * а одиночный выброс успевает пройти мимо.
 */
const SNAP_CONFIRM_SAMPLES = 3;
/**
 * Snap'и, случающиеся чаще этого, — не перекалибровки, а систематическое
 * расхождение gyro-интеграла с компасом (кривой rotationRate: знак,
 * единицы, редкие события с зажатым dt). Наблюдалось в поле на Samsung
 * S25 Ultra: «пила» — панорама дёргалась скачком примерно раз в секунду.
 * Детектор отключает гироскоп до конца сессии — на таком устройстве
 * прежнее сглаживание компаса лучше.
 */
const GYRO_SNAP_MUTE_COUNT = 3;
/** Окно подсчёта серии snap'ов, мс */
const GYRO_SNAP_WINDOW_MS = 10_000;
/**
 * Absolute-показания молчат дольше этого — компас потерян (ушёл магнитометр
 * в WebView, webkitCompassHeading стал NaN): снова принимаем относительные
 * события. Стабильный якорь с постоянным офсетом (закрывается свайпом)
 * лучше, чем гиро-интеграл, дрейфующий без предела.
 */
const ABSOLUTE_LOST_MS = 10_000;

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
 * Скорость изменения азимута взгляда по гироскопу, рад/с.
 * Положительное значение — поворот вправо (азимут растёт, N→E).
 *
 * rotationRate задан в системе устройства (alpha/beta/gamma — скорости
 * вокруг осей Z/X/Y устройства, град/с), а азимут живёт вокруг вертикальной
 * оси Земли. Перевод — третьей строкой той же матрицы R = Rz(α)·Rx(β)·Ry(γ),
 * что и для взгляда: ωz_earth = R[2]·ω_device. Третья строка не зависит от
 * α (вертикаль инвариантна к повороту вокруг себя), поэтому α здесь нет.
 *
 * Знак: компас отсчитывает азимут по часовой, а положительное вращение
 * вокруг +Z Земли (вверх) — против часовой, поэтому возвращаем −ωz.
 */
export function verticalRateFromGyro(
  betaDeg: number,
  gammaDeg: number,
  rateAlphaDps: number,
  rateBetaDps: number,
  rateGammaDps: number,
): number {
  const b = (betaDeg * Math.PI) / 180;
  const g = (gammaDeg * Math.PI) / 180;
  const wa = (rateAlphaDps * Math.PI) / 180;
  const wb = (rateBetaDps * Math.PI) / 180;
  const wg = (rateGammaDps * Math.PI) / 180;
  // Третья строка R: проекция осей устройства на вертикаль Земли
  const wzEarth =
    -Math.cos(b) * Math.sin(g) * wb + Math.sin(b) * wg + Math.cos(b) * Math.cos(g) * wa;
  return -wzEarth;
}

/**
 * Шаг комплементарного фильтра: медленная подтяжка интеграла гироскопа
 * к показанию компаса.
 *
 * Малое расхождение (дрейф, смещение нуля гироскопа) гасится экспонентой с
 * постоянной времени GYRO_TAU_S — кратковременный шум магнитометра в
 * картинку не проходит. Большое — принимается сразу, но только с
 * `allowSnap` (см. confirmSnap): столько дрейф не накапливает, значит
 * изменилась сама система отсчёта (перекалибровка «восьмёркой», приход
 * absolute-показаний после относительных).
 */
export function correctDrift(
  prevRad: number,
  compassRad: number,
  dtS: number,
  allowSnap = true,
): number {
  if (!Number.isFinite(compassRad)) return normalizeAngle(prevRad);
  if (!Number.isFinite(prevRad)) return normalizeAngle(compassRad);
  const diff = shortestAngle(compassRad - prevRad);
  if (allowSnap && Math.abs(diff) > GYRO_SNAP_RAD) return normalizeAngle(compassRad);
  const k = 1 - Math.exp(-Math.max(0, dtS) / GYRO_TAU_S);
  return normalizeAngle(prevRad + diff * k);
}

/**
 * Подтверждение скачка компаса перед мгновенным приёмом (snap).
 *
 * Одиночный выброс магнитометра возле металла (перила, машина) выглядит
 * как смена системы отсчёта — тот же скачок на десятки градусов, но через
 * пару событий компас возвращается, и картинку дёргает туда-обратно.
 * Отличить их может только стойкость: настоящая перекалибровка держится,
 * выброс — нет. Поэтому snap — после SNAP_CONFIRM_SAMPLES подряд показаний
 * за порогом в одну сторону; до этого расхождение идёт обычной экспонентой.
 *
 * @returns новый счётчик/направление серии и признак подтверждения
 */
export function confirmSnap(
  prevRun: number,
  prevDir: number,
  diffRad: number,
): { run: number; dir: number; confirmed: boolean } {
  if (Math.abs(diffRad) <= GYRO_SNAP_RAD) return { run: 0, dir: 0, confirmed: false };
  const dir = Math.sign(diffRad);
  const run = dir === prevDir ? prevRun + 1 : 1;
  return { run, dir, confirmed: run >= SNAP_CONFIRM_SAMPLES };
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
  /** Сглаженный азимут без ручной поправки (fallback без гироскопа), рад */
  private followedRad: number | null = null;
  /** Азимут комплементарного фильтра без ручной поправки; null — гироскопа нет */
  private fusedRad: number | null = null;
  /**
   * Последние углы Эйлера из события ориентации: rotationRate приходит
   * отдельным событием (devicemotion), а переводить его в систему Земли
   * нужно текущей ориентацией устройства.
   */
  private lastEulerDeg: { beta: number; gamma: number } | null = null;
  /** performance.now() последнего валидного rotationRate; 0 — гироскопа нет */
  private lastGyroMs = 0;
  /** performance.now() последнего события ориентации — шаг коррекции дрейфа */
  private lastOrientMs = 0;
  /** performance.now() последнего принятого absolute-показания; 0 — не было */
  private lastAbsoluteMs = 0;
  /** Серия подряд идущих показаний за snap-порогом (confirmSnap) */
  private snapRun = 0;
  private snapDir = 0;
  /** Времена недавних snap'ов — детектор систематического расхождения gyro/компас */
  private snapTimes: number[] = [];
  /** Гироскоп отключён детектором «пилы» — до конца сессии работает сглаживание */
  private gyroMuted = false;
  /** Сглаженные частоты событий, Гц — для полевой диагностики в console.warn */
  private gyroHz = 0;
  private orientHz = 0;
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

  /** Система попросила калибровку событием compassneedscalibration */
  private calibrationRequested = false;
  /**
   * Таймер авто-снятия просьбы о калибровке. На iOS флаг снимает вернувшаяся
   * точность (onOrientation), но там, где точности нет (Android), событие
   * приходит повторно, пока датчик плох, — а тишина означает «откалибровался».
   * Без таймера одна-единственная просьба висела бы вечно.
   */
  private calibrationTimer: ReturnType<typeof setTimeout> | null = null;

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
    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    const DME =
      typeof DeviceMotionEvent !== 'undefined'
        ? (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> })
        : null;
    // Оба запроса — параллельно из одного жеста: после await первого
    // транзиентная активация жеста может быть уже израсходована, и iOS
    // молча отклонит второй диалог — гироскоп не включился бы никогда.
    // Отказ motion не страшен: без гироскопа работает сглаживание компаса
    const [orientation] = await Promise.allSettled([
      DOE.requestPermission?.(),
      DME?.requestPermission?.(),
    ]);
    if (orientation.status === 'fulfilled' && orientation.value === 'granted') {
      this.permissionPending = false;
      this.listen();
      return true;
    }
    // Отказ или вызов вне жеста — остаёмся на ручной подстройке
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
    // Гироскоп — быстрая составляющая комплементарного фильтра. Там, где
    // rotationRate не приходит вовсе (десктоп), обработчик просто молчит
    window.addEventListener('devicemotion', this.onMotion, true);
    // iOS сама просит калибровку: событие приходит, когда магнитометр
    // раскалиброван или рядом источник помех
    window.addEventListener('compassneedscalibration', this.onCalibrationNeeded, true);
  }

  private onCalibrationNeeded = (): void => {
    this.calibrationRequested = true;
    if (this.calibrationTimer) clearTimeout(this.calibrationTimer);
    this.calibrationTimer = setTimeout(() => {
      this.calibrationTimer = null;
      this.calibrationRequested = false;
      this.callback?.(this.state);
    }, 15000);
    this.callback?.(this.state); // UI перечитает needsCalibration
  };

  /**
   * Быстрая составляющая комплементарного фильтра: интегрирование
   * rotationRate. Гироскоп не шумит и не отстаёт — плавное панорамирование
   * идёт по нему один-в-один, без «резинки» сглаживания. Дрейф интеграла
   * (смещение нуля) убирает компас в onOrientation (correctDrift).
   */
  private onMotion = (ev: Event): void => {
    const rate = (ev as DeviceMotionEvent).rotationRate;
    if (!rate) return;
    const { alpha: ra, beta: rb, gamma: rg } = rate;
    if (ra == null || rb == null || rg == null) return;
    if (!Number.isFinite(ra) || !Number.isFinite(rb) || !Number.isFinite(rg)) return;

    const now = performance.now();
    const rawDtS = (now - this.lastGyroMs) / 1000;
    // Частоту считаем до зажима dt — иначе редкие события выглядят как 10 Гц
    if (rawDtS > 0) {
      const hz = 1 / rawDtS;
      this.gyroHz = this.gyroHz === 0 ? hz : 0.95 * this.gyroHz + 0.05 * hz;
    }
    const dtS = Math.min(rawDtS, GYRO_MAX_DT_S);
    this.lastGyroMs = now;
    if (this.gyroMuted || dtS <= 0 || !this.lastEulerDeg) return;

    // Фильтр ещё пуст (события ориентации ещё не было или гироскоп ожил
    // после перерыва): начинаем интегрировать от текущей оценки — скачка нет
    this.fusedRad ??= this.followedRad;
    if (this.fusedRad === null) return;

    const azRate = verticalRateFromGyro(
      this.lastEulerDeg.beta,
      this.lastEulerDeg.gamma,
      ra,
      rb,
      rg,
    );
    this.fusedRad = normalizeAngle(this.fusedRad + azRate * dtS);
    this.emitSensorState(now);
  };

  /** Собрать состояние из текущей оценки азимута и отправить, если оно значимо */
  private emitSensorState(
    now: number,
    patch?: { tiltRad: number; accuracyDeg: number },
  ): void {
    const base = this.fusedRad ?? this.followedRad;
    if (base === null) return;
    // Применяем ручную подстройку (свайп-оффсет)
    const finalAz = normalizeAngle(base + this.manualOffsetRad);

    const prev = this.state;
    this.state = {
      azimuthRad: finalAz,
      tiltRad: patch?.tiltRad ?? prev.tiltRad,
      accuracyDeg: patch?.accuracyDeg ?? prev.accuracyDeg,
      source: 'sensor',
    };

    // Отправляем только при значимом изменении (>0.1°) или раз в 100 мс:
    // сравнивать нужно со временем прошлой отправки, а не с текущим.
    // Смена флага калибровки — тоже повод сообщить: UI показывает подсказку
    const wasUncalibrated = prev.source === 'sensor' && prev.accuracyDeg < 0;
    const isUncalibrated = this.state.accuracyDeg < 0;
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

    // Absolute-показания молчат дольше ABSOLUTE_LOST_MS — компас потерян:
    // снова годятся относительные, иначе гиро-интеграл останется без якоря
    // и будет дрейфовать без предела
    if (
      this.seenAbsolute &&
      this.lastAbsoluteMs > 0 &&
      performance.now() - this.lastAbsoluteMs > ABSOLUTE_LOST_MS
    ) {
      this.seenAbsolute = false;
    }

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
      this.lastAbsoluteMs = performance.now();
    }

    // Компас отсчитывает азимут от магнитного севера — переводим в истинный
    // по WMM. Только абсолютным показаниям: у относительных ноль произвольный,
    // и склонение было бы просто лишним сдвигом.
    const azimuthRad = absolute
      ? normalizeAngle(look.azimuthRad + this.declinationRad())
      : look.azimuthRad;

    const now = performance.now();
    // Точность −1 — это iOS-семантика «магнитометр раскалиброван». На Android
    // webkitCompass* нет вовсе, и прежний код присваивал −1 КАЖДОМУ сенсорному
    // показанию: подсказка про «восьмёрку» висела вечно, сколько ни крути.
    // Там точность неизвестна — честный NaN, а не «плохо»
    const accuracy = hasCompass ? (webkit.webkitCompassAccuracy ?? -1) : NaN;

    // Гироскопу нужна текущая ориентация устройства для перевода
    // rotationRate в систему Земли — запоминаем из этого же события
    this.lastEulerDeg = { beta: betaDeg, gamma: gammaDeg };

    const gyroAlive =
      !this.gyroMuted && this.lastGyroMs > 0 && now - this.lastGyroMs < GYRO_ALIVE_MS;
    if (gyroAlive) {
      // Комплементарный фильтр: азимут интегрируется гироскопом (onMotion),
      // компас здесь — только медленный якорь против дрейфа. Запасную
      // оценку followAzimuth не ведём: если гироскоп умолкнет, fallback
      // продолжит от fusedRad без скачка
      const dtS = this.lastOrientMs > 0 ? (now - this.lastOrientMs) / 1000 : 0;
      if (dtS > 0) {
        const hz = 1 / dtS;
        this.orientHz = this.orientHz === 0 ? hz : 0.95 * this.orientHz + 0.05 * hz;
      }
      if (this.fusedRad === null) {
        this.fusedRad = azimuthRad;
        this.snapRun = 0;
        this.snapDir = 0;
      } else {
        // Мгновенный приём большого расхождения — только подтверждённого:
        // одиночный выброс возле металла уходит обычной экспонентой
        const snap = confirmSnap(
          this.snapRun,
          this.snapDir,
          shortestAngle(azimuthRad - this.fusedRad),
        );
        this.snapRun = snap.confirmed ? 0 : snap.run;
        this.snapDir = snap.confirmed ? 0 : snap.dir;
        if (snap.confirmed) {
          this.snapTimes = this.snapTimes.filter((t) => now - t < GYRO_SNAP_WINDOW_MS);
          this.snapTimes.push(now);
          if (this.snapTimes.length >= GYRO_SNAP_MUTE_COUNT) {
            // Перекалибровка «восьмёркой» даёт одиночный snap. Серия —
            // gyro-интеграл систематически разъезжается с компасом (знак,
            // единицы или редкие события rotationRate): на таком устройстве
            // гироскопу верить нельзя, уходим в сглаживание компаса
            this.gyroMuted = true;
            console.warn(
              'Гироскоп отключён: интеграл систематически расходится с компасом. ' +
                'Диагностика: ' +
                `gyro ${this.gyroHz.toFixed(0)} Гц, compass ${this.orientHz.toFixed(0)} Гц, ` +
                `${this.snapTimes.length} snap за ${GYRO_SNAP_WINDOW_MS / 1000} с`,
            );
          }
        }
        this.fusedRad = correctDrift(this.fusedRad, azimuthRad, dtS, snap.confirmed);
      }
      this.followedRad = null;
      this.gyroSamples.length = 0;
    } else {
      // Гироскопа нет (десктоп, часть WebView): прежняя схема —
      // круговое среднее по окну (чтобы 359° и 1° не давали 180°), затем
      // слежение с подавлением дрожания: одного среднего мало — шум компаса
      // оно размазывает
      this.followedRad ??= this.fusedRad; // гироскоп только что умолк: без скачка
      this.fusedRad = null;
      this.gyroSamples.push(azimuthRad);
      if (this.gyroSamples.length > COMPASS_SMOOTH_WINDOW) {
        this.gyroSamples.shift();
      }
      const smoothed = circularMean(this.gyroSamples);
      this.followedRad =
        this.followedRad === null ? smoothed : followAzimuth(this.followedRad, smoothed);
    }
    this.lastOrientMs = now;

    // Точность вернулась в норму — системная просьба о калибровке отработана
    if (accuracy >= 0) this.calibrationRequested = false;

    this.emitSensorState(now, { tiltRad: look.elevationRad, accuracyDeg: accuracy });
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
    window.removeEventListener('devicemotion', this.onMotion, true);
    window.removeEventListener('compassneedscalibration', this.onCalibrationNeeded, true);
    if (this.calibrationTimer) {
      clearTimeout(this.calibrationTimer);
      this.calibrationTimer = null;
    }
    this.calibrationRequested = false;
    // Гироскоп и фильтр — в исходное: после повторного start() старые
    // motion-события не должны считаться живыми
    this.lastGyroMs = 0;
    this.lastOrientMs = 0;
    this.lastEulerDeg = null;
    this.fusedRad = null;
    this.snapRun = 0;
    this.snapDir = 0;
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
