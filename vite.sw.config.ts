import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
 * Версия — хеш исходника: браузер считает worker обновившимся, только если
 * файл побайтово изменился, а имена кешей должны меняться вместе с ним.
 */
const source = readFileSync(new URL('./src/sw.ts', import.meta.url), 'utf-8');
const version = createHash('sha256').update(source).digest('hex').slice(0, 8);

export default defineConfig({
  define: {
    'self.__SW_VERSION__': JSON.stringify(version),
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
