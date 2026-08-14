import { defineConfig } from "vite";

export default defineConfig({
  base: "/vershiny/",
  build: {
    // es2019, а не es2022: у бандла с синтаксисом ES2022 (class fields, ??=,
    // ?., числовые разделители) на iOS Safari < 14.5 парсинг падал целиком —
    // страница навсегда оставалась на статичной плашке «Загрузка…».
    target: "es2019",
    outDir: "dist",
    rollupOptions: {
      input: {
        // Приложение и страница установки: вторая нужна как ссылка «поставить
        // на телефон», её открывают до того, как увидят саму панораму
        main: new URL("./index.html", import.meta.url).pathname,
        install: new URL("./install.html", import.meta.url).pathname,
      },
    },
  },
  worker: {
    // Классический воркер (iife), а не ES-модуль: module workers появились
    // только в Safari 15, а до того `new Worker(..., {type:"module"})` бросал
    // исключение при загрузке модуля — то же вечное «Загрузка…» на айфоне.
    format: "iife",
    rollupOptions: {
      output: {
        // В воркере есть `import('./db')` — без инлайна Rollup пытался бы
        // резать классический воркер на чанки, что в iife запрещено
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    watch: {
      // Исходники DEM и промежуточные данные — сотни тысяч файлов вне сборки:
      // без этого Vite их сторожит и дёргает перезагрузку страницы
      ignored: ["**/dem/**", "**/data/**"],
    },
  },
  // PWA: Service Worker собирается отдельно (vite.sw.config.ts) — ему нужен
  // один самодостаточный файл по стабильному адресу, без хешей и чанков
});
