import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { defineConfig } from 'vite';

/**
 * Отдельная сборка Service Worker: `dist/sw.js`.
 *
 * Он не может быть частью основного бандла — там код разложен по чанкам с
 * хешами и импортами, а worker должен быть одним самодостаточным файлом по
 * стабильному адресу. Раньше сборки не было вовсе: приложение регистрировало
 * `sw.js`, которого в `dist/` не существовало, поэтому офлайн-режим и
 * установка PWA не работали ни разу.
 *
 * Версия — хеш исходника и списка ассетов: браузер считает worker
 * обновившимся, только если файл побайтово изменился, а имена кешей и
 * предзагружаемые чанки должны меняться вместе со сборкой приложения.
 */
const source = readFileSync(new URL('./src/sw.ts', import.meta.url), 'utf-8');

/**
 * Список чанков приложения для предзагрузки. Собирается уже после основной
 * сборки (см. npm run build), поэтому dist/assets на этот момент готов.
 *
 * Без предзагрузки офлайн работало только то, что человек успел открыть
 * онлайн: ленивые чанки (настройки, карта, поиск) кешировались лишь по факту
 * запроса, и в горах кнопка настроек просто ничего не делала.
 */
const assetsDir = new URL('./dist/assets/', import.meta.url);
const assets = existsSync(assetsDir)
  ? readdirSync(assetsDir)
      .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
      .map((name) => `assets/${name}`)
  : [];

const version = createHash('sha256')
  .update(source)
  .update(assets.join('|'))
  .digest('hex')
  .slice(0, 8);

export default defineConfig({
  define: {
    'self.__SW_VERSION__': JSON.stringify(version),
    'self.__SW_ASSETS__': JSON.stringify(assets),
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false, // основная сборка уже положила сюда приложение
    rollupOptions: {
      input: new URL('./src/sw.ts', import.meta.url).pathname,
      output: {
        format: 'iife',
        entryFileNames: 'sw.js',
        inlineDynamicImports: true,
      },
    },
  },
});
