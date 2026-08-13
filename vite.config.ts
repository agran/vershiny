import { defineConfig } from 'vite';

export default defineConfig({
  base: '/vershiny/',
  build: {
    target: 'es2022',
    outDir: 'dist',
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
  // PWA: регистрация SW через main.ts (без плагина — контроль над кешами)
});
