/**
 * Service Worker: обновление приложения и чистка кешей.
 *
 * Логику проверяем на исходнике, собранном esbuild'ом на лету (он идёт с
 * Vite): так тест не зависит от того, была ли сборка. Отдельно сверяем, что
 * рядом с собранным приложением лежит и sw.js — раньше его не было вовсе,
 * и офлайн-режим молча не работал.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import vm from "node:vm";

const SRC = fileURLToPath(new URL("../src/sw.ts", import.meta.url));
const DIST_APP = fileURLToPath(new URL("../dist/index.html", import.meta.url));
const DIST_SW = fileURLToPath(new URL("../dist/sw.js", import.meta.url));

const built = buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: "iife",
  write: false,
  define: {
    "self.__SW_VERSION__": '"testver"',
    "self.__SW_ASSETS__": '["assets/main-abc.js","assets/settings-def.js"]',
  },
}).outputFiles[0].text;

interface SwEnv {
  handlers: Record<string, (ev: unknown) => void>;
  deleted: string[];
  added: string[];
  /** Отложенные таймеры (страховка прекэша в activate) — для ручного запуска */
  timers: (() => void)[];
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
  const timers: (() => void)[] = [];
  let claimed = false;
  let skipped = false;

  const context = {
    self: {
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        handlers[type] = fn;
      },
      location: { href: "https://example.org/vershiny/sw.js" },
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
        // Ключом может быть и Request, и строка (запасной адрес оболочки)
        match: async (req: { url: string } | string) => {
          const body = opts.cached?.[typeof req === "string" ? req : req.url];
          return body === undefined ? undefined : new Response(body);
        },
        put: async () => {},
        add: async (url: string) => {
          added.push(url);
        },
      }),
    },
    fetch: opts.fetchImpl ?? (async () => new Response("")),
    Response,
    URL,
    // Отложенный прекэш: таймер activate запоминаем, чтобы запустить вручную
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  };
  vm.createContext(context);
  vm.runInContext(built, context);

  return {
    handlers,
    deleted,
    added,
    timers,
    claimed: () => claimed,
    skipped: () => skipped,
  };
}

describe("Service Worker", () => {
  it("вешает обработчики install/activate/fetch/message", () => {
    const { handlers } = runSw([]);
    expect(Object.keys(handlers).sort()).toEqual([
      "activate",
      "fetch",
      "install",
      "message",
    ]);
  });

  it("при активации удаляет кеши прошлых версий, тайлы и данные — оставляет", async () => {
    const env = runSw([
      "vershiny-app-oldver",
      "vershiny-data-oldver",
      "vershiny-data-v1",
      "vershiny-tiles-v2",
      "other-app",
    ]);
    let done: Promise<unknown> = Promise.resolve();
    env.handlers.activate({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;

    expect(env.deleted).toContain("vershiny-app-oldver");
    // Тайлы и данные не привязаны к версии оболочки: после обновления
    // приложения офлайн-запас должен остаться на месте
    expect(env.deleted).not.toContain("vershiny-tiles-v2");
    expect(env.deleted).not.toContain("vershiny-data-v1");
    expect(env.deleted).not.toContain("other-app");
    // Кеш данных из старой схемы имён (с версией) больше не нужен
    expect(env.deleted).toContain("vershiny-data-oldver");
    expect(env.claimed()).toBe(true);
  });

  it("сносит тайловый кеш v1: пересборка пирамиды сменила байты по тем же URL", async () => {
    const env = runSw(["vershiny-tiles-v1", "vershiny-tiles-v2"]);
    let done: Promise<unknown> = Promise.resolve();
    env.handlers.activate({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;

    expect(env.deleted).toContain("vershiny-tiles-v1");
    expect(env.deleted).not.toContain("vershiny-tiles-v2");
  });

  it("версию меняет только по команде страницы", () => {
    const env = runSw([]);
    // Установка не должна вытеснять работающую версию сама
    env.handlers.install({ waitUntil: () => {} });
    expect(env.skipped()).toBe(false);

    env.handlers.message({ data: { type: "SKIP_WAITING" } });
    expect(env.skipped()).toBe(true);
  });

  it("чанки приложения докачиваются после первой панорамы, не в install", async () => {
    // Прекэш чанков в install соревновался за соединения с веером тайлов
    // первого расчёта: на слабой сети человек ждал и панораму, и настройки.
    // Теперь install кладёт только оболочку, чанки — по сигналу страницы
    // (PRECACHE_READY) или по таймеру-страховке после активации
    const env = runSw([]);
    let done: Promise<unknown> = Promise.resolve();
    env.handlers.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;

    // В install — только оболочка, чанков нет
    expect(env.added).toContain("https://example.org/vershiny/index.html");
    expect(env.added).not.toContain(
      "https://example.org/vershiny/assets/settings-def.js",
    );

    // Сигнал «первая панорама готова» — чанки докачиваются
    env.handlers.message({ data: { type: "PRECACHE_READY" } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.added).toContain(
      "https://example.org/vershiny/assets/settings-def.js",
    );
    expect(env.added).toContain(
      "https://example.org/vershiny/assets/main-abc.js",
    );
  });

  it("без сигнала страницы чанки докачиваются по таймеру-страховке", async () => {
    // Упавшая до первой панорамы страница не должна навсегда лишать офлайн
    // доступа к настройкам/карте: минута после активации — и кеш полон
    const env = runSw([]);
    let done: Promise<unknown> = Promise.resolve();
    env.handlers.activate({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(env.timers.length).toBeGreaterThan(0);

    env.timers[0]();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.added).toContain(
      "https://example.org/vershiny/assets/main-abc.js",
    );
  });

  it("при установке кладёт в кеш и саму оболочку", async () => {
    // Иначе «поставил PWA и ушёл в горы, ни разу не перезагрузив страницу»
    // кончается белым 503 вместо приложения
    const env = runSw([]);
    let done: Promise<unknown> = Promise.resolve();
    env.handlers.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;

    expect(env.added).toContain("https://example.org/vershiny/index.html");
    expect(env.added).toContain(
      "https://example.org/vershiny/manifest.webmanifest",
    );
  });

  it("при 500 от сервера отдаёт кеш, а не ошибку", async () => {
    // Битый деплой Pages не должен выглядеть как отсутствие данных, когда
    // рабочая копия regions.json лежит рядом в кеше
    const url = "https://example.org/vershiny/regions.json";
    const env = runSw([], {
      fetchImpl: async () => new Response("boom", { status: 500 }),
      cached: { [url]: '{"caucasus-west":{}}' },
    });
    let responded: Promise<Response> | null = null;
    env.handlers.fetch({
      request: { url, method: "GET", mode: "cors" },
      waitUntil: () => {},
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });
    const res = await responded!;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"caucasus-west":{}}');
  });

  it("офлайн открывает ссылку с координатами, а не 503", async () => {
    // Ссылкой на место делятся вместе с параметрами (?lat=&lon=), а в кеше
    // оболочка лежит без них: `cache.match` их учитывает, и офлайн такая
    // ссылка упиралась в «Offline» вместо панорамы
    const env = runSw([], {
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
      cached: { "https://example.org/vershiny/": "<!doctype html>панорама" },
    });
    let responded: Promise<Response> | null = null;
    env.handlers.fetch({
      request: {
        url: "https://example.org/vershiny/?lat=43.318&lon=42.458",
        method: "GET",
        mode: "navigate",
      },
      waitUntil: () => {},
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });
    const res = await responded!;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("панорама");
  });

  it("фоновое обновление ассета не спотыкается о прочитанный ответ", async () => {
    // Ответ из кеша уже отдан странице, и она прочитала его тело. Прежний код
    // ловил отказ фонового запроса через `cached.clone()` — клонировать
    // прочитанный ответ нельзя, и консоль забивалась «Response body is already
    // used» по ошибке на каждый ассет при каждой загрузке
    const url = "https://example.org/vershiny/assets/main-abc.js";
    const env = runSw([], {
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
      cached: { [url]: "чанк из кеша" },
    });

    const kept: Promise<unknown>[] = [];
    let responded: Promise<Response> | null = null;
    env.handlers.fetch({
      request: { url, method: "GET", mode: "no-cors" },
      waitUntil: (p: Promise<unknown>) => kept.push(p),
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });

    const res = await responded!;
    expect(await res.text()).toBe("чанк из кеша"); // тело прочитано страницей

    // Фоновое обновление удержано: запрос, которого никто не ждёт, браузер
    // вправе оборвать — тогда кеш не обновится никогда
    expect(kept.length).toBeGreaterThan(0);
    // И завершается молча, без необработанного отклонения
    await expect(Promise.all(kept)).resolves.toBeDefined();
  });

  it("не трогает не-GET запросы", () => {
    const env = runSw([]);
    let responded = false;
    env.handlers.fetch({
      request: { url: "https://example.org/x", method: "POST", mode: "cors" },
      respondWith: () => {
        responded = true;
      },
    });
    expect(responded).toBe(false);
  });

  it("рядом с собранным приложением лежит sw.js", () => {
    if (!existsSync(DIST_APP)) return; // сборки не было — проверять нечего
    expect(
      existsSync(DIST_SW),
      "dist/index.html есть, а dist/sw.js нет: сборка SW отдельная (vite.sw.config.ts)",
    ).toBe(true);
    // Версия кеша — хеш исходника, иначе обновление не доедет до браузера
    expect(/[0-9a-f]{8}/.test(readFileSync(DIST_SW, "utf-8"))).toBe(true);
  });
});
