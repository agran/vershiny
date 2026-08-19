/**
 * Принудительная ориентация экрана.
 *
 * Панорама вдумчиво смотрится в ландшафте: горизонт длинный, и на узком
 * портрете его видно кусочками. Автоповорот при этом мешает: лёгкий наклон
 * телефона (а в горах телефон наклоняют постоянно) переключает экран туда-
 * сюда. Поэтому ориентация у нас ручная: кнопка рядом с настройками, выбор
 * запоминается; системный автоповорот приложением не используется.
 *
 * Реализация — чисто программная, БЕЗ Screen Orientation lock и БЕЗ
 * fullscreen: lock на Android требует fullscreen, а на части устройств
 * (Samsung Internet, установленный PWA на ряде прошивок) отклоняется вовсе,
 * на iOS API отсутствует. Ландшафт делается CSS-поворотом document.body на
 * 90°: система остаётся в портрете, приложение повёрнуто. Жесты, раскладка
 * и FOV при этом считаются сами — вся геометрия выводится из
 * `canvas.clientWidth/Height` и `getBoundingClientRect`, которые браузер
 * уже отдаёт повёрнутыми. Заодно такой поворот работает без жеста
 * пользователя и на iOS, и на десктопе (удобно для отладки).
 *
 * Поверх этого работает манифест `"orientation": "landscape"`: в
 * установленном Android PWA система сама даёт ландшафт при запуске, и наш
 * поворот тогда просто не нужен (эффективная форма уже совпадает).
 */

export type ScreenOrientationPref = "auto" | "landscape" | "portrait";

const STORAGE_KEY = "vershiny-orientation";

export function storedOrientation(): ScreenOrientationPref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "landscape" || raw === "portrait" ? raw : "auto";
  } catch {
    return "auto";
  }
}

export function rememberOrientation(pref: ScreenOrientationPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Без хранилища выбор живёт до перезагрузки — лучше, чем ничего
  }
}

/**
 * Физическая форма окна (screen.orientation.type, в старых браузерах — по
 * форме экрана). Программный поворот её НЕ меняет: CSS-трансформ до layout-
 * вьюпорта не доходит, поэтому по ней решаем, нужен ли поворот.
 */
export function effectiveOrientation(): "landscape" | "portrait" {
  const type = screen.orientation?.type ?? "";
  if (type.startsWith("landscape")) return "landscape";
  if (type.startsWith("portrait")) return "portrait";
  // Старые браузеры без type: по форме экрана
  return window.innerWidth >= window.innerHeight ? "landscape" : "portrait";
}

// ---------------------------------------------------------------------------
// Программный поворот: CSS-трансформ body — единственный механизм фиксации
// ---------------------------------------------------------------------------

/**
 * Поворачиваем document.body целиком, а не #app: кнопки, плашки, карта и
 * настройки лежат в body и позиционируются position:fixed. Трансформ предка
 * делает его контейнером позиционирования для fixed-потомков (CSS Transforms),
 * поэтому поворот body захватывает ВЕСЬ интерфейс разом — отдельно крутить
 * кнопки и оверлеи не нужно.
 *
 * Побочный эффект нам на руку: getBoundingClientRect, canvas.clientWidth/Height
 * у всего внутри уже «повёрнуты» браузером, поэтому раскладка плашек и FOV
 * продолжают считаться сами. Три вещи браузер НЕ поворачивает:
 *   - window.innerWidth/innerHeight — про физический экран: их читатели
 *     (layoutControls, layoutCaptions) берут virtualViewport();
 *   - clientX/clientY событий указателя — физические координаты: дельты
 *     жестов конвертируются через toLocalDelta(), точки — toLocalPoint();
 *   - vh/vw — от физического окна: видимые доли задаются в cqh/cqw
 *     (body делается query-контейнером container-type:size).
 */
function rotatableRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.body;
}

/** Текущий программный поворот: 0 — как есть; ±90° — по стороне хвата */
let softAngle: -90 | 0 | 90 = 0;

/** Действует ли сейчас программный поворот */
export function softRotated(): boolean {
  return softAngle !== 0;
}

/** Куда повёрнут интерфейс, градусы: -90 | 0 | +90 */
export function softAngleDeg(): number {
  return softAngle;
}

/**
 * Физическая сторона хвата телефона: влево (landscape-primary, верх
 * устройства влево) или вправо (landscape-secondary). По ней выбираем
 * направление поворота UI: повернуть надо ТУДА ЖЕ, куда человек держит
 * телефон, иначе картинка окажется вверх ногами относительно его хвата.
 *
 * Источник — screen.orientation.angle (0 портрет, 90 ландшафт-primary,
 * 270 — secondary). Пока окно портретное (наш типичный случай: манифестный
 * или кнопочный ландшафт на физическом портрете), угол ещё 0, и сторону
 * хвата берём из последних сырых γ датчика ориентации.
 */
let lastPhysicalSide: 1 | -1 = 1; // -1 = влево (primary), +1 = вправо

/**
 * Кого известить о смене стороны хвата в ландшафте. main подписывается,
 * чтобы перевернуть UI на 180° при перехвате телефона другим боком — иначе
 * картинка оставалась бы вверх ногами до ручного переключения режима.
 */
let sideListener: (() => void) | null = null;
export function onPhysicalSideChange(cb: () => void): void {
  sideListener = cb;
}

/** Дебаунс переворота: без него шум у порога крутил UI туда-сюда */
const SIDE_FLIP_DEBOUNCE_MS = 600;
let lastFlipMs = 0;

/**
 * Запомнить сторону хвата по углу КРЕНА (rollRad из core/orientation.ts —
 * третья строка матрицы поворота), а НЕ по сырому γ. Причина: γ при
 * вертикальном хвате (β≈90°) вырождается — там его крутит и наклон вверх-
 * вниз (изменение β), и поворот вокруг взгляда (α), поэтому телефон,
 * наклоняемый вверх-вниз, дёргал UI переворотами. Угол крена от α и β
 * не зависит и устойчив в любой позе: это угол от «верха» экрана к земной
 * вертикали. Портретный хват — roll≈0, ландшафт-влево ≈ −90°, вправо ≈ +90°,
 * вверх ногами ≈ ±180°.
 *
 * Мёртвая зона вокруг вертикали (|roll| < 75°) держит прошлую сторону:
 * ландшафт начинается за ней. Порог 75° (не 45°) — запас на шум наклона.
 */
export function notePhysicalTilt(rollDeg: number): void {
  const next =
    rollDeg > 75 ? 1 : rollDeg < -75 ? -1 : lastPhysicalSide;
  if (next === lastPhysicalSide) return;
  const now =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  // Дебаунс глушит повторные вспышки, но не первую осознанную смену стороны
  // (lastFlipMs === 0 — признак «ещё не переворачивали», её пропускаем)
  if (lastFlipMs !== 0 && now - lastFlipMs < SIDE_FLIP_DEBOUNCE_MS) return;
  lastPhysicalSide = next;
  lastFlipMs = now;
  // Смена стороны имеет смысл только когда UI реально повёрнут: в авто
  // переворачивать нечего, пусть при следующем включении возьмёт свежую
  if (softAngle !== 0) sideListener?.();
}

/** Сброс состояния для тестов: модуль живёт между ними, иначе сторона и
 *  время последнего переворота протекают из одного теста в другой */
export function _resetOrientationForTests(): void {
  lastPhysicalSide = 1;
  lastFlipMs = 0;
  sideListener = null;
}

// Сторону хвата узнаём из УГЛА КРЕНА (устойчив, в отличие от сырого γ):
// считаем его здесь из тех же β/γ той же формулой, что orientation.ts —
// так модуль самодостаточен и не зависит от внутренностей трекера
if (typeof window !== "undefined") {
  window.addEventListener("deviceorientation", (ev) => {
    if (ev.beta === null || ev.gamma === null) return;
    const b = (ev.beta * Math.PI) / 180;
    const g = (ev.gamma * Math.PI) / 180;
    // roll = atan2(−cosβ·sinγ, sinβ) — см. lookFromDeviceOrientation
    const rollRad = Math.atan2(-Math.cos(b) * Math.sin(g), Math.sin(b));
    notePhysicalTilt((rollRad * 180) / Math.PI);
  });
}

/** Угол для CSS-поворота под текущий хват: влево → -90°, вправо → +90° */
function targetAngle(): -90 | 90 {
  // Если окно уже ландшафтное (манифест сработал), направление однозначно
  // по его углу; иначе — по запомненной стороне хвата
  const angle =
    typeof screen !== "undefined" ? (screen.orientation?.angle ?? 0) : 0;
  if (angle === 90) return -90; // landscape-primary: хват влево
  if (angle === 270) return 90; // landscape-secondary: хват вправо
  return lastPhysicalSide === -1 ? -90 : 90;
}

/**
 * Типизированные размеры UI как CSS-переменные: --app-w/--app-h. На них же
 * опираются логические единицы cqh/cqw (см. container-type ниже): панель
 * настроек ограничивает высоту долей ВИДИМОГО контейнера, а не физического
 * окна — иначе при повороте 80vh считались от портретного окна и панель с
 * кнопкой закрытия уезжала за кадр.
 *
 * registerProperty с синтаксисом <length> делает переменные пригодными для
 * calc(), а без container-type:size единицы cqw/cqh были бы «маленькими
 * вьюпортными» и считались бы от физического окна — то есть неверно.
 */
let propsRegistered = false;
function registerAppSizeProps(): void {
  if (propsRegistered || typeof CSS === "undefined") return;
  const reg = (
    CSS as unknown as {
      registerProperty?: (def: {
        name: string;
        syntax: string;
        inherits: boolean;
        initialValue: string;
      }) => void;
    }
  ).registerProperty;
  if (typeof reg !== "function") return;
  try {
    reg({
      name: "--app-w",
      syntax: "<length>",
      inherits: true,
      initialValue: "0px",
    });
    reg({
      name: "--app-h",
      syntax: "<length>",
      inherits: true,
      initialValue: "0px",
    });
    propsRegistered = true;
  } catch {
    // Старые браузеры: поворот работает и без переменных, просто настройки
    // ограничат высоту физическим vh (запасной вариант, ничего не ломается)
  }
}

/** Записать актуальные локальные размеры body в --app-w/--app-h */
function syncAppSizeVars(w: number, h: number): void {
  document.documentElement.style.setProperty("--app-w", `${w}px`);
  document.documentElement.style.setProperty("--app-h", `${h}px`);
}

/**
 * Физические safe-area-инсеты окна. env() из JS не читается, поэтому они
 * продублированы CSS-переменными :root в index.html — отсюда и берём.
 * Нужны, чтобы при повороте вырез камеры и полоса жестов остались за
 * пределами UI: body ужимается и сдвигается в безопасную зону.
 */
function safeInsets(): { t: number; b: number; l: number; r: number } {
  const cs = getComputedStyle(document.documentElement);
  const px = (name: string): number =>
    parseFloat(cs.getPropertyValue(name)) || 0;
  return {
    t: px("--inset-top"),
    b: px("--inset-bottom"),
    l: px("--inset-left"),
    r: px("--inset-right"),
  };
}

/**
 * Виртуальный viewport с учётом программного поворота. Это те размеры,
 * под которые надо раскладывать UI: при 90° ширина и высота меняются местами.
 * Используют только читатели СЫРОГО window.innerWidth/innerHeight —
 * layoutCaptions (рамки экрана) и layoutControls (низкий экран). Вся
 * остальная геометрия (canvas, getBoundingClientRect) уже повёрнута
 * браузером и в поправке не нуждается.
 */
export function virtualViewport(): { w: number; h: number } {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (softAngle === 0) return { w, h };
  // Точные локальные размеры — у body (он уже ужат инсетами); в jsdom
  // раскладки нет и clientWidth = 0 — откат на простую перестановку
  const b = document.body;
  return { w: b.clientWidth || h, h: b.clientHeight || w };
}

/**
 * Повернуть интерфейс на 90° или вернуть в 0. При включении стили пишутся
 * всегда (размеры окна могли измениться под нами — клавиатура, строка
 * адреса), при выключении — сброс. Возвращает, ИЗМЕНИЛОСЬ ли состояние
 * поворота. Пересчёт холста делает сам ResizeObserver на canvas: изменение
 * CSS-размеров body меняет clientWidth/clientHeight холста → resize().
 */
export function applySoftRotation(rotated: boolean): boolean {
  const root = rotatableRoot();
  if (!root) return false;
  const next: -90 | 0 | 90 = rotated ? targetAngle() : 0;
  const changed = next !== softAngle;
  softAngle = next;
  if (softAngle === 0) {
    // Полный сброс: возвращаем body к исходной раскладке из index.html
    root.style.transform = "";
    root.style.width = "";
    root.style.height = "";
    root.style.position = "";
    root.style.left = "";
    root.style.top = "";
    root.style.transformOrigin = "";
    root.style.containerType = "";
    // Размеры без поворота — само окно
    syncAppSizeVars(window.innerWidth, window.innerHeight);
    return changed;
  }
  // Геометрия: body делаем размером «высота окна × ширина окна» минус
  // safe-area-инсеты и центрируем в безопасной зоне — после поворота на 90°
  // он ляжет в неё ровно. Локальные оси после rotate(90deg): local-left =
  // physical-top (вырез камеры), local-right = physical-bottom (полоса
  // жестов) — оба вырезаны из body, до них кнопки уже не дотянутся.
  const { t, b, l, r } = safeInsets();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const bw = h - t - b; // локальная ширина = физическая высота без инсетов
  const bh = w - l - r;
  const cx = l + (w - l - r) / 2; // центр безопасной зоны, физические коорд.
  const cy = t + (h - t - b) / 2;
  root.style.position = "fixed";
  root.style.width = `${bw}px`;
  root.style.height = `${bh}px`;
  root.style.left = `${cx - bw / 2}px`;
  root.style.top = `${cy - bh / 2}px`;
  root.style.transformOrigin = "50% 50%";
  // Направление — по физической стороне хвата (targetAngle): поворачиваем
  // туда же, куда человек держит телефон, иначе UI окажется вверх ногами
  root.style.transform = `rotate(${softAngle}deg)`;
  // body — query-контейнер по размеру: cqw/cqh внутри считаются от него
  // (то есть от повёрнутого вьюпорта), а не от физического окна
  registerAppSizeProps();
  root.style.containerType = "size";
  syncAppSizeVars(bw, bh);
  return changed;
}

/**
 * Дельта указателя (clientX/Y) из физических координат экрана в локальные
 * оси UI. CSS-трансформ body — rotate(softAngle): локальные координаты
 * получаются ОБРАТНЫМ поворотом физической дельты (R(−softAngle)), а не
 * прямым — знак ±90° решает, и при прямом повороте жесты в ландшафте
 * шли на 180° не туда (drag панорамы, панорамирование карты, подстройка
 * контуров). Без поворота — тождественность.
 */
export function toLocalDelta(
  dx: number,
  dy: number,
): { x: number; y: number } {
  if (softAngle === 0) return { x: dx, y: dy };
  // Обратный поворот на −softAngle вокруг центра: для ±90° оси меняются
  // местами со сменой знака одной из них
  return softAngle === -90 ? { x: -dy, y: dx } : { x: dy, y: -dx };
}

/**
 * Точка указателя из физических координат в локальные (система body).
 * Обратный поворот вокруг центра body: как getBoundingClientRect видит
 * повёрнутую раскладку, так и точка должна пройти через обратный трансформ
 * (R(−softAngle)), иначе x-координата зеркалится. Нужна тем, кто меряет по
 * canvas.clientWidth — двойной клик «переместиться в точку», карта.
 */
export function toLocalPoint(px: number, py: number): { x: number; y: number } {
  if (softAngle === 0) return { x: px, y: py };
  const b = document.body;
  const br = b.getBoundingClientRect(); // физический бокс повёрнутого body
  const cx = br.left + br.width / 2;
  const cy = br.top + br.height / 2;
  const bw = b.offsetWidth; // offset* игнорируют трансформ — это локальные
  const bh = b.offsetHeight;
  // Обратный поворот вокруг центра body. Для −90°: lx = bw/2 − (py − cy),
  // ly = bh/2 + (px − cx); для +90° — наоборот
  if (softAngle === -90)
    return { x: bw / 2 - (py - cy), y: bh / 2 + (px - cx) };
  return { x: bw / 2 + (py - cy), y: bh / 2 - (px - cx) };
}

// ---------------------------------------------------------------------------
// Оркестрация: предпочтение → поворот
// ---------------------------------------------------------------------------

/** Эффективная ВИДИМАЯ форма: физическая форма с поправкой на наш трансформ */
function visibleOrientation(): "landscape" | "portrait" {
  const phys = effectiveOrientation();
  // Любой ±90° меняет оси местами — знак на форму не влияет
  if (softAngle === 0) return phys;
  return phys === "landscape" ? "portrait" : "landscape";
}

/**
 * Применить предпочтение. «Авто» — следовать физической форме окна;
 * «ландшафт»/«портрет» — повернуть UI на 90°, если физическая форма не
 * совпадает с желаемой (например, манифест уже дал ландшафт — поворот не
 * нужен; «портрет» на ландшафтном окне — поворачиваем обратно). Вызывается
 * при смене режима и при ресайзе окна (системный автоповорот ОС мог
 * перевернуть само окно — тогда наш поворот либо стал лишним, либо
 * наоборот понадобился). Возвращает true: программный поворот не требует
 * ни жеста, ни разрешений и отказать не может (нет body — false).
 */
export function applyOrientation(pref: ScreenOrientationPref): boolean {
  const phys = effectiveOrientation();
  const rotated =
    pref !== "auto" &&
    ((pref === "landscape" && phys === "portrait") ||
      (pref === "portrait" && phys === "landscape"));
  applySoftRotation(rotated);
  return true;
}

/**
 * Проверка «режим реально действует» — для пере-применения после возврата
 * в приложение. Сравниваем по пропорциям окна (с поправкой на наш трансформ),
 * а не по строке type: при повороте ровно на ±90° primary/secondary меняются
 * местами, и проверка по type ложно решала бы, что поворот «не сработал».
 * Возвращает true, если видимая форма совпадает с желаемой.
 */
export function orientationMatches(pref: ScreenOrientationPref): boolean {
  if (pref === "auto") return true; // авто не может «слететь»
  return visibleOrientation() === pref;
}
