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

const STORAGE_KEY = 'vershiny-ar';

/**
 * Прошлый выбор пользователя:
 *   - `on` — вышел из приложения в режиме камеры;
 *   - `off` — выключил камеру сам либо отказал в доступе;
 *   - `unset` — ещё не решал (первый запуск).
 */
export type ArPreference = 'on' | 'off' | 'unset';

export function storedArPreference(): ArPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'on' || raw === 'off' ? raw : 'unset';
  } catch {
    // Приватный режим: считаем, что человек ещё не решал
    return 'unset';
  }
}

export function rememberArMode(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
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
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return coarse && (navigator.maxTouchPoints ?? 0) > 0;
}

/**
 * Включать ли камеру самим при запуске.
 *
 * Первый запуск на телефоне — включаем: это главный режим, и разрешение всё
 * равно придётся дать. Отказ (или явный выход из AR) запоминается, и больше
 * при каждой загрузке камеру никто не просит: кнопка остаётся на месте.
 */
export function shouldAutoStartAr(
  preference: ArPreference = storedArPreference(),
  handheld: boolean = isHandheld(),
): boolean {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  if (preference === 'off') return false;
  if (preference === 'on') return true;
  return handheld;
}
