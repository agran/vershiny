/**
 * Принудительная ориентация экрана.
 *
 * Панорама вдумчиво смотрится в ландшафте: горизонт длинный, и на узком
 * портрете его видно кусочками. Автоповорот при этом мешает: лёгкий наклон
 * телефона (а в горах телефон наклоняют постоянно) переключает экран туда-
 * сюда. Поэтому ориентация у нас ручная: кнопка рядом с настройками, выбор
 * запоминается; системный автоповорот приложением не используется.
 *
 * На десктопе и где API недоступен (старый Android, iOS без полноэкранного
 * режима) — считаем, что экран свободный: показывать кнопку, которая ничего
 * не делает, нельзя.
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
 * Screen Orientation API в базовых типах TS без `lock`/`unlock`: они из
 * WICG-спецификации и до сих пор не во всех lib.dom. Достаём через пересечение.
 */
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
};

function orientationApi(): LockableOrientation | null {
  return (screen.orientation as LockableOrientation) ?? null;
}

/** Можем ли вообще запирать экран (Fullscreen API — обязательное условие lock) */
export function canLockOrientation(): boolean {
  return (
    typeof document !== "undefined" &&
    !!document.documentElement &&
    typeof document.documentElement.requestFullscreen === "function" &&
    typeof orientationApi()?.lock === "function"
  );
}

/**
 * Текущий эффективный вид: что реально видно на экране (заперт он или нет).
 * По нему кнопка показывает, ЧТО включится по нажатию.
 */
export function effectiveOrientation(): "landscape" | "portrait" {
  const type = screen.orientation?.type ?? "";
  if (type.startsWith("landscape")) return "landscape";
  if (type.startsWith("portrait")) return "portrait";
  // Старые браузеры без type: по форме экрана
  return window.innerWidth >= window.innerHeight ? "landscape" : "portrait";
}

/**
 * Применить предпочтение. `auto` снимает запрет; фиксированная ориентация
 * запирает экран (во вкладке браузера нужен полноэкранный режим, в
 * установленном PWA lock работает и без него). Возвращает, получилось ли
 * применить: вызывающий обязан это знать — иконка не имеет права рисовать
 * замок на свободном экране.
 */
export async function applyOrientation(
  pref: ScreenOrientationPref,
): Promise<boolean> {
  if (!canLockOrientation()) return false;
  const api = orientationApi();
  if (!api) return false;
  if (pref === "auto") {
    api.unlock?.();
    return true;
  }
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // Нет жеста (запуск приложения) или отказ политики: в установленном PWA
    // lock работает и без fullscreen — попытку не отменяем
  }
  try {
    await api.lock?.(pref);
    return true;
  } catch {
    // Отказали (нет fullscreen, политика браузера) — экран остался свободным
    return false;
  }
}

export function rememberOrientation(pref: ScreenOrientationPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Без хранилища выбор живёт до перезагрузки — лучше, чем ничего
  }
}
