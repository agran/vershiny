/**
 * Счётчик посещений (Яндекс.Метрика).
 *
 * Три требования, из которых и вырос отдельный модуль вместо сниппета
 * в разметке:
 *
 *   • **Без сети — не пытаться.** Приложение в горах живёт офлайн неделями;
 *     запрос к счётчику там всё равно не уйдёт, а браузер будет держать его
 *     до таймаута и тратить радио. Проверяем `navigator.onLine` и молчим.
 *   • **Не мешать старту.** Счётчик грузится в простое, после того как
 *     приложение уже считает панораму: на слабом канале он не должен
 *     соревноваться за полосу с тайлами рельефа.
 *   • **Считать запуски установленного приложения.** С домашнего экрана PWA
 *     часто не перезагружает документ, а поднимает уже открытый: обычного
 *     обращения при загрузке страницы там не случается. Поэтому возвращение
 *     приложения на экран после долгого перерыва отмечается отдельно.
 *
 * Зависимости вынесены в параметр: без этого поведение «офлайн — молчим» и
 * «повторный визит не чаще получаса» проверялось бы только руками.
 */

/** Номер счётчика (agran) */
export const METRIKA_ID = 111_599_794;

const TAG_URL = `https://mc.yandex.ru/metrika/tag.js?id=${METRIKA_ID}`;

/**
 * Через сколько простоя возвращение в приложение считается новым визитом.
 * Полчаса — тот же порог, по которому Метрика сама разделяет визиты, поэтому
 * лишних визитов такая отметка не создаёт.
 */
export const REVISIT_MS = 30 * 60 * 1000;

/**
 * Адрес страницы для счётчика — без параметров и якоря.
 *
 * В ссылке живёт `?lat=&lon=`: ею делятся, чтобы показать место, и по ней же
 * приложение открывают с чужого телефона. В статистике это оказалось бы
 * координатами конкретного человека с точностью до метра. Считаем мы
 * посещения, а не тех, кто их сделал.
 */
export function pageUrlForCounter(href: string): string {
  try {
    const url = new URL(href);
    return `${url.origin}${url.pathname}`;
  } catch {
    // Адрес неразбираемый — отдаём как есть, но и параметров в нём нет
    return href;
  }
}

/** Очередь вызовов Метрики: до загрузки tag.js обращения копятся в ней */
type Ym = ((...args: unknown[]) => void) & { a?: unknown[][]; l?: number };

export interface AnalyticsDeps {
  /** Есть ли сеть прямо сейчас */
  isOnline: () => boolean;
  /** Отложить работу до момента, когда приложению не до нас */
  whenIdle: (task: () => void) => void;
  /** Загрузить счётчик и открыть первый визит */
  loadCounter: () => void;
  /** Отметить возвращение в приложение как новый визит */
  sendHit: () => void;
  /** Приложение снова на экране (в том числе поднято с домашнего экрана) */
  onVisible: (handler: () => void) => void;
  now: () => number;
}

function browserDeps(): AnalyticsDeps {
  return {
    // Строгое сравнение с false: там, где свойства нет вовсе, считаем, что
    // сеть есть — молчать из-за незнания хуже, чем сходить впустую
    isOnline: () => navigator.onLine !== false,

    whenIdle: (task) => {
      const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => void })
        .requestIdleCallback;
      // Таймаут обязателен: без него в занятой вкладке простоя можно ждать
      // сколько угодно, и визит не засчитается вовсе
      if (idle) idle(task, { timeout: 5_000 });
      else setTimeout(task, 2_000);
    },

    loadCounter: () => {
      const w = window as unknown as { ym?: Ym };
      // Заглушка-очередь до прихода tag.js — как в штатном сниппете Метрики:
      // init можно вызывать сразу, обращение отправится после загрузки
      const ym: Ym =
        w.ym ??
        function (...args: unknown[]) {
          (ym.a = ym.a ?? []).push(args);
        };
      ym.l = Date.now();
      w.ym = ym;

      const script = document.createElement('script');
      script.async = true; // разметку не блокирует и падение переживает молча
      script.src = TAG_URL;
      document.head.appendChild(script);

      ym(METRIKA_ID, 'init', {
        clickmap: true,
        ecommerce: 'dataLayer',
        accurateTrackBounce: true,
        trackLinks: true,
        referrer: document.referrer,
        url: pageUrlForCounter(location.href),
      });
    },

    sendHit: () => {
      const w = window as unknown as { ym?: Ym };
      w.ym?.(METRIKA_ID, 'hit', pageUrlForCounter(location.href), {
        referer: document.referrer,
      });
    },

    onVisible: (handler) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') handler();
      });
    },

    now: () => Date.now(),
  };
}

/**
 * Подключение счётчика. Вызывается один раз при старте страницы.
 *
 * @param deps подмена окружения для тестов
 */
export function setupAnalytics(deps: Partial<AnalyticsDeps> = {}): void {
  const env = { ...browserDeps(), ...deps };
  let loaded = false;
  let lastVisit = 0;

  const open = (): void => {
    if (loaded || !env.isOnline()) return;
    loaded = true;
    lastVisit = env.now();
    env.loadCounter();
  };

  env.whenIdle(open);

  env.onVisible(() => {
    // Сети не было при загрузке — счётчик ещё не подключён, начинаем с нуля
    if (!loaded) {
      open();
      return;
    }
    if (!env.isOnline()) return;
    if (env.now() - lastVisit < REVISIT_MS) return;
    lastVisit = env.now();
    env.sendHit();
  });
}
