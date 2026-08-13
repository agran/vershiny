/**
 * Service Worker: обновление приложения и чистка кешей.
 *
 * Логику проверяем на исходнике, собранном esbuild'ом на лету (он идёт с
 * Vite): так тест не зависит от того, была ли сборка. Отдельно сверяем, что
 * рядом с собранным приложением лежит и sw.js — раньше его не было вовсе,
 * и офлайн-режим молча не работал.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import vm from 'node:vm';

const SRC = fileURLToPath(new URL('../src/sw.ts', import.meta.url));
const DIST_APP = fileURLToPath(new URL('../dist/index.html', import.meta.url));
const DIST_SW = fileURLToPath(new URL('../dist/sw.js', import.meta.url));

const built = buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: 'iife',
  write: false,
  define: {
    'self.__SW_VERSION__': '"testver"',
    'self.__SW_ASSETS__': '["assets/main-abc.js","assets/settings-def.js"]',
  },
}).outputFiles[0].text;

interface SwEnv {
  handlers: Record<string, (ev: unknown) => void>;
  deleted: string[];
  added: string[];
  claimed: () => boolean;
  skipped: () => boolean;
}

interface SwOptions {
  /** Что отвечает сеть на fetch внутри worker'а */
  fetchImpl?: () => Promise<Response>;
  /** Готовое содержимое кеша: URL → тело */
  cached?: Record<string, string>;
}

function runSw(existingCaches: string[], opts: SwOptions = {}): SwEnv {
  const handlers: Record<string, (ev: unknown) => void> = {};
  const deleted: string[] = [];
  const added: string[] = [];
  let claimed = false;
  let skipped = false;

  const context = {
    self: {
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        handlers[type] = fn;
      },
      location: { href: 'https://example.org/vershiny/sw.js' },
      clients: {
        claim: async () => {
          claimed = true;
        },
      },
      skipWaiting: async () => {
        skipped = true;
      },
    },
    caches: {
      keys: async () => existingCaches,
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
      open: async () => ({
        match: async (req: { url: string }) => {
          const body = opts.cached?.[req.url];
          return body === undefined ? undefined : new Response(body);
        },
        put: async () => {},
        add: async (url: string) => {
          added.push(url);
        },
      }),
    },
    fetch: opts.fetchImpl ?? (async () => new Response('')),
    Response,
    URL,
  };
  vm.createContext(context);
  vm.runInContext(built, context);

  return {
    handlers,
    deleted,
    added,
    claimed: () => claimed,
    skipped: () => skipped,
  };
}

describe('Service Worker', () => {
  it('вешает обработчики install/activate/fetch/message', () => {
    const { handlers } = runSw([]);
    expect(Object.keys(handlers).sort()).toEqual(['activate', 'fetch', 'install', 'message']);
  });

  it('при активации удаляет кеши прошлых версий, тайлы и данные — оставляет', async () => {
    const env = runSw([
      'vershiny-app-oldver',
      'vershiny-data-oldver',
      'vershiny-data-v1',
      'vershiny-tiles-v1',
      'other-app',
    ]);
    let done: Promise<unknown> = Promise.resolve();
    env.handlers.activate({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;

    expect(env.deleted).toContain('vershiny-app-oldver');
    // Тайлы и данные не привязаны к версии оболочки: после обновления
    // приложения офлайн-запас должен остаться на месте
    expect(env.deleted).not.toContain('vershiny-tiles-v1');
    expect(env.deleted).not.toContain('vershiny-data-v1');
    expect(env.deleted).not.toContain('other-app');
    // Кеш данных из старой схемы имён (с версией) больше не нужен
    expect(env.deleted).toContain('vershiny-data-oldver');
    expect(env.claimed()).toBe(true);
  });

  it('версию меняет только по команде страницы', () => {
    const env = runSw([]);
    // Установка не должна вытеснять работающую версию сама
    env.handlers.install({ waitUntil: () => {} });
    expect(env.skipped()).toBe(false);

    env.handlers.message({ data: { type: 'SKIP_WAITING' } });
    expect(env.skipped()).toBe(true);
  });

  it('при установке кладёт чанки приложения в кеш', async () => {
    // Ленивые чанки (настройки, карта, поиск) грузятся по нажатию: без
    // предзагрузки офлайн работало только то, что успели открыть при сети
    const env = runSw([]);
    let done: Promise<unknown> = Promise.resolve();
    env.handlers.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;

    expect(env.added).toContain('https://example.org/vershiny/assets/settings-def.js');
    expect(env.added).toContain('https://example.org/vershiny/assets/main-abc.js');
  });

  it('при установке кладёт в кеш и саму оболочку', async () => {
    // Иначе «поставил PWA и ушёл в горы, ни разу не перезагрузив страницу»
    // кончается белым 503 вместо приложения
    const env = runSw([]);
    let done: Promise<unknown> = Promise.resolve();
    env.handlers.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;

    expect(env.added).toContain('https://example.org/vershiny/index.html');
    expect(env.added).toContain('https://example.org/vershiny/manifest.webmanifest');
  });

  it('при 500 от сервера отдаёт кеш, а не ошибку', async () => {
    // Битый деплой Pages не должен выглядеть как отсутствие данных, когда
    // рабочая копия regions.json лежит рядом в кеше
    const url = 'https://example.org/vershiny/regions.json';
    const env = runSw([], {
      fetchImpl: async () => new Response('boom', { status: 500 }),
      cached: { [url]: '{"caucasus-west":{}}' },
    });
    let responded: Promise<Response> | null = null;
    env.handlers.fetch({
      request: { url, method: 'GET', mode: 'cors' },
      waitUntil: () => {},
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });
    const res = await responded!;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"caucasus-west":{}}');
  });

  it('не трогает не-GET запросы', () => {
    const env = runSw([]);
    let responded = false;
    env.handlers.fetch({
      request: { url: 'https://example.org/x', method: 'POST', mode: 'cors' },
      respondWith: () => {
        responded = true;
      },
    });
    expect(responded).toBe(false);
  });

  it('рядом с собранным приложением лежит sw.js', () => {
    if (!existsSync(DIST_APP)) return; // сборки не было — проверять нечего
    expect(
      existsSync(DIST_SW),
      'dist/index.html есть, а dist/sw.js нет: сборка SW отдельная (vite.sw.config.ts)',
    ).toBe(true);
    // Версия кеша — хеш исходника, иначе обновление не доедет до браузера
    expect(/[0-9a-f]{8}/.test(readFileSync(DIST_SW, 'utf-8'))).toBe(true);
  });
});
