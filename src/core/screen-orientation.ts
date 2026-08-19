/**
 * Принудительная ориентация экрана.
 *
 * Панорама вдумчиво смотрится в ландшафте: горизонт длинный, и на узком
 * портрете его видно кусочками. Автоповорот при этом мешает: лёгкий наклон
 * телефона (а в горах телефон наклоняют постоянно) переключает экран туда-
 * сюда. Поэтому ориентация у нас ручная: кнопка рядом с настройками, выбор
 * запоминается; системный автоповорот приложением не используется.
 *
 * Реализация — чисто программная, БЕЗ Screen Orientation lock: на Android
 * он требует fullscreen, а на части устройств (Samsung Internet,
 * установленный PWA на ряде прошивок) отклоняется вовсе. Ландшафт делается
 * CSS-поворотом document.body на 90°: система остаётся в портрете,
 * приложение повёрнуто. Жесты, раскладка и FOV при этом считаются сами —
 * вся геометрия выводится из `canvas.clientWidth/Height` и
 * `getBoundingClientRect`, которые браузер уже отдаёт повёрнутыми.
 * Заодно такой поворот работает без жеста пользователя и на iOS, и на
 * десктопе (удобно для отладки).
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

/**
 * Физическая форма окна (screen.orientation.type, в старых браузерах —
 * по форме экрана). Программный поворот её НЕ меняет: CSS-трансформ до
 * layout-вьюпорта не доходит, поэтому по ней решаем, нужен ли поворот.
 */
export function effectiveOrientation(): "landscape" | "portrait" {
  const type = screen.orientation?.type ?? "";
  if (type.startsWith("landscape")) return "landscape";
  if (type.startsWith("portrait")) return "portrait";
  // Старые браузеры без type: по форме экрана
  return window.innerWidth >= window.innerHeight ? "landscape" : "portrait";
}

export function rememberOrientation(pref: ScreenOrientationPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Без хранилища выбор живёт до перезагрузки — лучше, чем ничего
  }
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
 * продолжают считаться сами. Две вещи браузер НЕ поворачивает:
 *   - window.innerWidth/innerHeight — про физический экран: их читатели
 *     (layoutControls, layoutCaptions) берут virtualViewport();
 *   - clientX/clientY событий указателя — физические координаты: дельты
 *     жестов конвертируются через toLocalDelta(), точки — toLocalPoint().
 */
function rotatableRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.body;
}

/** Текущий программный поворот: 0 — системная ориентация как есть */
let softAngle: 0 | 90 = 0;

/** Действует ли сейчас программный поворот */
export function softRotated(): boolean {
  return softAngle !== 0;
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
    reg({ name: "--app-w", syntax: "<length>", inherits: true, initialValue: "0px" });
    reg({ name: "--app-h", syntax: "<length>", inherits: true, initialValue: "0px" });
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
  const next: 0 | 90 = rotated ? 90 : 0;
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
  root.style.transform = "rotate(90deg)";
  // body — query-контейнер по размеру: cqw/cqh внутри считаются от него
  // (то есть от повёрнутого вьюпорта), а не от физического окна
  registerAppSizeProps();
  root.style.containerType = "size";
  syncAppSizeVars(bw, bh);
  return changed;
}

/**
 * Применить предпочтение. «Авто» — следовать физической форме окна;
 * «ландшафт»/«портрет» — повернуть UI на 90°, если физическая форма не
 * совпадает с желаемой. Вызывается при смене режима и при ресайзе окна
 * (системный автоповорот ОС мог перевернуть само окно — тогда наш поворот
 * либо стал лишним, либо наоборот понадобился; так «портрет» честно держит
 * портрет, даже когда телефон физически горизонтален). Возвращает,
 * ИЗМЕНИЛОСЬ ли состояние поворота.
 */
export function applyOrientation(pref: ScreenOrientationPref): boolean {
  const phys = effectiveOrientation();
  const rotated =
    (pref === "landscape" && phys === "portrait") ||
    (pref === "portrait" && phys === "landscape");
  return applySoftRotation(rotated);
}

/**
 * Дельта указателя (clientX/Y) из физических координат экрана в локальные
 * оси UI. При повороте на 90°: local +x = physical +y, local +y = −x.
 * Без поворота — тождественность. Нужна жестам: drag панорамы,
 * панорамирование карты.
 */
export function toLocalDelta(dx: number, dy: number): { x: number; y: number } {
  return softAngle === 0 ? { x: dx, y: dy } : { x: dy, y: -dx };
}

/**
 * Точка указателя из физических координат в локальные (система body).
 * Обратный поворот вокруг центра body: lx = bw/2 + (py − cy),
 * ly = bh/2 + (cx − px). Нужна тем, кто меряет по canvas.clientWidth —
 * двойной клик «переместиться в точку», ручка сектора взгляда на карте.
 */
export function toLocalPoint(px: number, py: number): { x: number; y: number } {
  if (softAngle === 0) return { x: px, y: py };
  const b = document.body;
  const br = b.getBoundingClientRect(); // физический бокс повёрнутого body
  const cx = br.left + br.width / 2;
  const cy = br.top + br.height / 2;
  return {
    x: b.offsetWidth / 2 + (py - cy), // offset* игнорируют трансформ
    y: b.offsetHeight / 2 + (cx - px),
  };
}
