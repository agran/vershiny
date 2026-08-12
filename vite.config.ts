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
  // PWA: регистрация SW через main.ts (без плагина — контроль над кешами)
});
