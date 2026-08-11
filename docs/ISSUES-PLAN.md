# План issues для agran/vershiny

Метки: `epic`, `data`, `core`, `ui`, `pwa`, `research`, `good first issue`

## Epic: Этап 0 — данные
1. [data] Проверить покрытие DEM целевых регионов (SRTM vs GLO-90 >60°N) — good first issue
2. [data] Скачать и проверить SRTM V3 void-filled для Приэльбрусья
3. [data] Выгрузка пиков Кавказа из Overpass, оценка качества данных — good first issue

## Epic: MVP
4. [data] tools/dem-to-tiles: GeoTIFF → int16-тайлы 256×256 + LOD + index.json
5. [data] tools/peaks-to-json: Overpass → peaks/{region}.json (прекомпиляция)
5a. [core] DemSource: абстракция источника высот (патч → Terrarium → кеш) — точка
    расширения из new-geo-data.md; выбор зума Terrarium по дальности луча
6. [core] Ray-marching горизонта в Web Worker (кривизна+рефракция, LOD-выборка)
7. [core] Бенчмарк производительности на телефоне, цель <500 мс
8. [core] Видимость пиков: точные лучи + проекция (азимут, возвышение)
9. [ui] Canvas-рендер: силуэт, шкала азимутов, подписи, кластеризация
10. [ui] Поворот пальцем (fallback-режим без сенсоров)
11. [core] Ориентация: deviceorientation + комплементарный фильтр
12. [core] Позиционирование: GPS, высота из DEM, ручной выбор на карте
13. [ui] Свайп-подстройка азимута с сохранением оффсета
14. [ui] AR-режим: getUserMedia + полупрозрачный оверлей
15. [pwa] Service Worker + IndexedDB: офлайн-загрузка региона
16. [ui] Фото с запечёнными подписями + шаринг
17. [research] Тестовая матрица устройств (iOS Safari / Android Chrome) — good first issue
18. [epic] Полевой тест: контрольные точки из MVP-ACCEPTANCE.md

## Epic: v1.1
19. [core] Калибровка по солнцу/луне (suncalc)
20. [ui] «Покорённые вершины»: бейджи, личная карта
21. [ui] Петля OSM: правка названий пиков из приложения
22. [data] Регионы: Алтай, Урал; GLO-90-пайплайн для Хибин
22a. [data] global-peaks.json из Wikidata SPARQL (instance of mountain + ele + coords,
     ~50–100 тыс. записей); name:ru из OSM-регионов приоритетнее Wikidata
22b. [pwa] Кеширование Terrarium-тайлов просмотренных областей (Cache API/IndexedDB)

## Epic: v2.0 (research)
23. [research] CV-калибровка: 1D-корреляция профиля горизонта
24. [ui] Слои дальности / воздушная перспектива (VoxelSpace-стиль)
25. [research] Ночной режим: звёзды (astronomy-engine)