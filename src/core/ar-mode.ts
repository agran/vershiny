/**
 * Режим камеры — основной сценарий приложения.
 *
 * Человек стоит на склоне и наводит телефон на хребет: подписи поверх живого
 * кадра отвечают на вопрос «что это за гора» сразу, без сопоставления
 * нарисованного силуэта с тем, что перед глазами. Поэтому камера включается
 * сама, а не по нажатию кнопки, которую ещё нужно найти.
 *
 * Само решение отделено от интерфейса: «спрашивать ли камеру при запуске» —
 * логика с тремя источниками (прошлый выбор, тип устройства, наличие
 * самого API), и её проще проверить тестами, чем кликами.
 */

const STORAGE_KEY = "vershiny-ar";

/**
 * Прошлый выбор пользователя:
 *   - `on` — вышел из приложения в режиме камеры;
 *   - `off` — выключил камеру сам либо отказал в доступе;
 *   - `unset` — ещё не решал (первый запуск).
 */
export type ArPreference = "on" | "off" | "unset";

export function storedArPreference(): ArPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "on" || raw === "off" ? raw : "unset";
  } catch {
    // Приватный режим: считаем, что человек ещё не решал
    return "unset";
  }
}

export function rememberArMode(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Без хранилища выбор живёт до перезагрузки — это лучше, чем ничего
  }
}

/**
 * Телефон или планшет в руках, а не монитор на столе.
 *
 * Проверяем основной указатель, а не ширину экрана: узкое окно браузера на
 * ноутбуке — это не повод просить камеру, а планшет в ландшафте — повод.
 */
export function isHandheld(): boolean {
  const coarse =
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return coarse && (navigator.maxTouchPoints ?? 0) > 0;
}

/**
 * Приложение открыто как установленный PWA (отдельное окно), а не вкладка.
 */
export function isStandalone(): boolean {
  if (typeof matchMedia !== "function") return false;
  return (
    matchMedia("(display-mode: standalone)").matches ||
    matchMedia("(display-mode: fullscreen)").matches ||
    // Старые WebView (Android < 4.4) и часть прошивок другого медиа-запроса не дают
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * Браузер Xiaomi (Mi Browser): в установленном из него приложении
 * getUserMedia не работает — ни автозапуск, ни кнопка камеру не откроют.
 * UA: «XiaoMi/MiuiBrowser/...» или «MiuiBrowser/...».
 */
export function isMiBrowser(): boolean {
  const ua = navigator.userAgent;
  return /XiaoMi\/MiuiBrowser|MiuiBrowser\//i.test(ua);
}

// --- Сторож автозапуска камеры ---------------------------------------------
//
// На части прошивок (Xiaomi HyperOS) старт камеры во время запуска
// установленного PWA убивает весь процесс: иконка камеры вспыхивает, и
// приложение исчезает без единого события JS — обработать «падение» в коде
// невозможно. Единственный зацеп — метка в хранилище, которую мы ставим
// ПЕРЕД автозапуском и снимаем, когда сеанс его пережил: если при следующей
// загрузке метка на месте, прошлый автозапуск не дожил до ответа камеры.

const AR_LAUNCH_MARK = "vershiny-ar-launching";

export function markArAutoStart(): void {
  try {
    localStorage.setItem(AR_LAUNCH_MARK, "1");
  } catch {
    // Без хранилища сторож не работает — автозапуск остаётся как есть
  }
}

export function clearArAutoStartMark(): void {
  try {
    localStorage.removeItem(AR_LAUNCH_MARK);
  } catch {
    // Приватный режим: метки и не было
  }
}

export function hadArAutostartKill(): boolean {
  try {
    return localStorage.getItem(AR_LAUNCH_MARK) === "1";
  } catch {
    return false;
  }
}

/**
 * Включать ли камеру самим при запуске.
 *
 * Первый запуск на телефоне — включаем: это главный режим, и разрешение всё
 * равно придётся дать. Отказ (или явный выход из AR) запоминается, и больше
 * при каждой загрузке камеру никто не просит: кнопка остаётся на месте.
 *
 * Исключения:
 *   - Mi Browser — камера в нём не работает вовсе (см. isMiBrowser);
 *   - установленное приложение до первого явного выбора: камеру не просим
 *     на самом запуске — на прошивках вроде HyperOS это убивает процесс,
 *     а человек ещё не показал, что ему нужен AR (включит кнопкой).
 */
export function shouldAutoStartAr(
  preference: ArPreference = storedArPreference(),
  handheld: boolean = isHandheld(),
): boolean {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  if (isMiBrowser()) return false;
  if (preference === "off") return false;
  if (preference === "on") return true;
  if (!handheld) return false;
  return !isStandalone();
}
