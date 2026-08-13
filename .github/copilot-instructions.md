# Инструкции для Copilot (и других чатов)

## Проект
«Вершины» — open-source PWA-аналог PeakFinder. Репозиторий: agran/vershiny. Документация — `docs/`. Код — MIT/Apache-2.0.

## Документация (docs/)

| Файл | Содержание |
|------|-----------|
| **STATUS.md** | **Актуальное состояние**: что работает, известные проблемы, архитектура данных, размеры, производительность, следующие шаги. **Обновлять при каждом значимом изменении!** |
| **ROADMAP.md** | План работ: этапы 0–3 (MVP → v1.1 → v2.0), отмечены выполненные пункты |
| **ARCHITECTURE.md** | Архитектура: Canvas 2D (без WebGL), Web Worker, DemSource (Terrarium → патчи → кеш), система координат |
| **ALGORITHMS.md** | Алгоритмы: ray-marching (3600 лучей, кривизна Земли k=0.13), видимость пиков, калибровка компаса, кластеризация подписей |
| **DATA-PIPELINE.md** | Пайплайн данных: GeoTIFF → int16-тайлы, Overpass → peaks.json, форматы |
| **new-geo-data.md** | Трёхслойная схема геоданных: Terrarium (глобальный) + патчи (регионы) + Wikidata (вершины) |
| **DEM-ECONOMICAL.md** | Исследование: экономичные DEM-тайлы для планеты (гибрид coarse z7 + fine z11, ~600 МБ) |
| **GLO-90-DOWNLOAD.md** | Инструкция: скачивание Copernicus GLO-90 (AWS CLI, no-sign-request), обработка в свои тайлы |
| **MVP-ACCEPTANCE.md** | Критерии приёмки MVP: контрольные точки (Приют 11, Чегет, Азау), бенчмарки |
| **ISSUES-PLAN.md** | План issues для GitHub: этапы, метки, good first issue |
| **CONTRIBUTING.md** | Как контрибьютить: код-стайл, коммиты, тесты |

**Требование**: при изменении функциональности — обновлять STATUS.md (раздел «Что работает» / «Известные проблемы»). При добавлении этапов — обновлять ROADMAP.md.

## Стек
- Vanilla TS + Vite, Canvas 2D (без WebGL/фреймворков — см. docs/ARCHITECTURE.md)
- Web Worker для ray-marching горизонта
- Python 3.12 для инструментов данных (`tools/`)
- Тесты: vitest (`npm test`), типы: `npx tsc`, сборка: `npm run build`
- PWA: манифест + `src/sw.ts`; **Service Worker собирается отдельно**
  (`vite.sw.config.ts` → `dist/sw.js`) — он не может быть частью основного
  бандла с хешами и чанками

## Данные
- Глобальный DEM: AWS Terrarium (онлайн, весь мир) — `src/core/terrarium.ts`
- Офлайн-DEM планеты: глобальная пирамида GLO-90 в отдельном репозитории
  **agran/vershiny-dem** (850 МБ, раздаётся его Pages; адрес —
  `src/core/dem-config.ts`), генератор — `tools/glo90-to-tiles/glo90_to_tiles.py`
- Детальные патчи регионов: int16-тайлы 256×256 — `tools/dem-to-tiles/`
- Вершины: planet.osm.pbf → `tools/planet-peaks/planet_peaks.py --regions-dir` → `tools/peaks-to-json/peaks_to_json.py --region X --from-file`
- Реестр регионов: `tools/regions.json` (115 регионов, двуязычие)
- ⚠️ Не класть тайлы в `public/`: 26 тыс. файлов замедляют старт Vite в 18 раз

## Конвенции
- **Двуязычие обязательно**: UI (i18n.ts), вершины (`name_ru`/`name_en`), регионы (`title_ru`/`title_en`, `core_ru`/`core_en`)
- Комментарии и документация — по-русски; идентификаторы и коммиты — по-английски
- Без сервера: всё прекомпилируется в статику (GitHub Pages)
- Без GPL-зависимостей
- Данные вершин правятся в OpenStreetMap, не в локальных файлах

## Полезные команды
```powershell
npm run dev          # http://localhost:5173/vershiny/
npm test             # vitest
npx tsc              # проверка типов
npm run build        # прод-сборка

# Пики региона из planet.jsonl
python tools\peaks-to-json\peaks_to_json.py --region elbrus --from-file data\peaks-by-region\elbrus.jsonl -o public\peaks\elbrus.json

# Индекс поиска по всем регионам (после регенерации peaks/*)
python tools\peaks-index\build_index.py --quiet

# GLO-90 → глобальная пирамида тайлов (scan кешируется, build возобновляемый)
python tools\glo90-to-tiles\glo90_to_tiles.py scan
python tools\glo90-to-tiles\glo90_to_tiles.py build --dry-run
python tools\glo90-to-tiles\glo90_to_tiles.py build --budget-mb 900 `
  --levels "512:2:400:0.55,256:4:150:0.35,64:8:0:-" -o ..\vershiny-dem\tiles\global

# DEM-патч отдельного региона в 90 м (после gdalwarp в EPSG:4326)
python tools\dem-to-tiles\dem_to_tiles.py input.tif -o public\tiles\elbrus
```

## Отладка в браузере
- URL-параметры позиции: `?lat=43.318&lon=42.458` (Приют 11)
- Локаль: `localStorage.setItem('vershiny-locale', 'en')` → перезагрузка
- Консоль: `Горизонт: 3600 лучей, N пиков, наблюдатель XXXX м, YYY мс`

## Частые ловушки
- Vite на 404 отдаёт index.html (SPA-fallback) — проверяйте Content-Type при fetch данных
- Windows-консоль (cp1251) не выводит Unicode — в Python-скриптах: `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`
- Terrarium z15: пиксель 4.8 м на экваторе, но данные ~90 м — зумы выше z12 впустую качают пиксели
- planet.osm.pbf: DenseNodes поля могут повторяться (packed) — накапливать, не перезаписывать
- **OSM: вулканы — это `natural=volcano`, а не `peak`.** Только по `peak` теряются
  Эльбрус, Казбек, Фудзи, Килиманджаро и вся Камчатка (`SUMMIT_TAGS` в planet_peaks.py)
