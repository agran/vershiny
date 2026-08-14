// @vitest-environment jsdom
/**
 * Счётчик посещений: когда он имеет право сходить в сеть, а когда обязан
 * молчать.
 *
 * Проверяем именно поведение, а не факт вызова Метрики: приложение живёт в
 * горах офлайн, и счётчик там не должен ни грузиться, ни держать запросы.
 */

import { describe, it, expect } from 'vitest';
import { setupAnalytics, REVISIT_MS, type AnalyticsDeps } from '../src/core/analytics';

/** Окружение под управлением теста: сеть, время и момент простоя */
function env(online = true) {
  let visible: (() => void) | null = null;
  let idle: (() => void) | null = null;
  const state = {
    online,
    time: 1_000_000,
    loads: 0,
    hits: 0,
    /** Дождаться простоя — до этого счётчик грузиться не должен */
    settle: () => idle?.(),
    /** Приложение вернулось на экран (или поднято с домашнего экрана) */
    reopen: () => visible?.(),
    /** Промотать время */
    wait: (ms: number) => (state.time += ms),
  };

  const deps: Partial<AnalyticsDeps> = {
    isOnline: () => state.online,
    whenIdle: (task) => {
      idle = task;
    },
    loadCounter: () => state.loads++,
    sendHit: () => state.hits++,
    onVisible: (handler) => {
      visible = handler;
    },
    now: () => state.time,
  };

  return { state, deps };
}

describe('счётчик посещений', () => {
  it('без сети не грузится вовсе', () => {
    const { state, deps } = env(false);
    setupAnalytics(deps);
    state.settle();

    expect(state.loads).toBe(0);
    expect(state.hits).toBe(0);
  });

  it('грузится не сразу, а в простое — старт приложения важнее', () => {
    const { state, deps } = env();
    setupAnalytics(deps);
    expect(state.loads).toBe(0); // подписались и ждём

    state.settle();
    expect(state.loads).toBe(1);
  });

  it('возвращение в приложение в тот же час нового визита не создаёт', () => {
    // Иначе каждое переключение между приложениями на телефоне считалось бы
    // отдельным посещением
    const { state, deps } = env();
    setupAnalytics(deps);
    state.settle();

    state.wait(REVISIT_MS - 1);
    state.reopen();

    expect(state.hits).toBe(0);
    expect(state.loads).toBe(1);
  });

  it('запуск приложения после долгого перерыва считается', () => {
    // С домашнего экрана PWA часто поднимает уже открытый документ, и
    // обращения при загрузке страницы не происходит вовсе
    const { state, deps } = env();
    setupAnalytics(deps);
    state.settle();

    state.wait(REVISIT_MS + 1);
    state.reopen();
    expect(state.hits).toBe(1);

    // И следующий визит — снова только после перерыва
    state.reopen();
    expect(state.hits).toBe(1);
    state.wait(REVISIT_MS + 1);
    state.reopen();
    expect(state.hits).toBe(2);
  });

  it('связь появилась позже — счётчик подключается при возвращении в приложение', () => {
    const { state, deps } = env(false);
    setupAnalytics(deps);
    state.settle();
    expect(state.loads).toBe(0);

    state.online = true;
    state.reopen();

    expect(state.loads).toBe(1);
    // Именно подключение, а не отдельное обращение поверх незагруженного счётчика
    expect(state.hits).toBe(0);
  });

  it('пропавшая сеть не порождает обращений', () => {
    const { state, deps } = env();
    setupAnalytics(deps);
    state.settle();

    state.online = false;
    state.wait(REVISIT_MS + 1);
    state.reopen();

    expect(state.hits).toBe(0);
  });

  it('счётчик подключается один раз, сколько бы раз ни возвращались', () => {
    const { state, deps } = env();
    setupAnalytics(deps);
    state.settle();
    state.settle(); // повторный простой
    state.reopen();
    state.wait(REVISIT_MS + 1);
    state.reopen();

    expect(state.loads).toBe(1);
  });

  it('в браузере без сети ни одного запроса не появляется', () => {
    // Настоящее окружение, а не подменённое: без сети в документе не
    // возникает <script> счётчика — ни запроса, ни ожидания таймаута
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    const before = document.scripts.length;

    setupAnalytics({ whenIdle: (task) => task() });

    expect(document.scripts.length).toBe(before);

    // А с сетью — появляется, и именно адрес Метрики
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    setupAnalytics({ whenIdle: (task) => task() });

    const added = Array.from(document.scripts).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].src).toContain('mc.yandex.ru/metrika/tag.js');
    expect(added[0].async).toBe(true); // разметку не блокирует
    added[0].remove();
    delete (navigator as { onLine?: boolean }).onLine;
  });
});
