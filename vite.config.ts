import { defineConfig } from 'vite';

export default defineConfig({
  base: '/vershiny/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        // Приложение и страница установки: вторая нужна как ссылка «поставить
        // на телефон», её открывают до того, как увидят саму панораму
        main: new URL('./index.html', import.meta.url).pathname,
        install: new URL('./install.html', import.meta.url).pathname,
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    watch: {
      // Исходники DEM и промежуточные данные — сотни тысяч файлов вне сборки:
      // без этого Vite их сторожит и дёргает перезагрузку страницы
      ignored: ['**/dem/**', '**/data/**'],
    },
  },
  // PWA: Service Worker собирается отдельно (vite.sw.config.ts) — ему нужен
  // один самодостаточный файл по стабильному адресу, без хешей и чанков
});
