# Скачивание Copernicus GLO-90 для всей планеты

> Цель: ~175 ГБ GeoTIFF → наши компактные тайлы (~600 МБ) для GitHub Pages.

## Статус загрузки (2026-08-12)

| Показатель | Значение |
|---|---|
| Скачано тайлов | 21 744 из 26 475 (82%) |
| Скачано | ~162 ГБ (351 539 файлов) |
| Осталось | ~10.8 ГБ (75 698 объектов) |
| Позиция | дошли до `S77_00_W089`, идёт Антарктида (`S78…S90`) |
| Свободно на C: | ~108 ГБ |

Оставшиеся тайлы — Антарктида и приполярные широты: для приложения они почти
бесполезны (аудитория ≈ 0), но досинхронизировать дешевле, чем прерывать `sync`.

Проверить прогресс:

```powershell
# Сколько папок-тайлов уже есть
(Get-ChildItem C:\dev\vershiny\dem\glo-90 -Directory).Count

# Объём и последний скачанный тайл
$s = Get-ChildItem C:\dev\vershiny\dem\glo-90 -Recurse -File | Measure-Object Length -Sum
"{0:N1} ГБ, {1} файлов" -f ($s.Sum/1GB), $s.Count
(Get-ChildItem C:\dev\vershiny\dem\glo-90 -Directory | Select-Object -Last 1).Name
```

`aws s3 sync` идемпотентен: при обрыве просто запустите ту же команду — уже
скачанные файлы пропускаются по размеру и дате.

## Источник

**Copernicus DEM GLO-90** — AWS Open Data, без регистрации:
- Бакет: `s3://copernicus-dem-90m/` (eu-central-1)
- Покрытие: глобально, 90 м, Cloud-Optimized GeoTIFF 1°×1°
- Лицензия: свободная, с атрибуцией © DLR/ESA

## Установка AWS CLI

```powershell
winget install Amazon.AWSCLI
# или: https://aws.amazon.com/cli/
```

## Скачивание всей планеты

```powershell
# Все тайлы (1°×1° = 26 475 папок, ~175 ГБ вместе с AUXFILES)
aws s3 sync s3://copernicus-dem-90m/ ./dem/glo-90/ --no-sign-request

# Только DEM без вспомогательных слоёв (примерно вдвое меньше объём)
aws s3 sync s3://copernicus-dem-90m/ ./dem/glo-90/ --no-sign-request `
  --exclude "*/AUXFILES/*" --exclude "*/PREVIEW/*" --exclude "*/INFO/*"
```

## Структура тайлов

Реальные имена в бакете — `COG_30` (не `90`), с суффиксом `_DEM`:

```
Copernicus_DSM_COG_30_N43_00_E042_00_DEM/
  ├── Copernicus_DSM_COG_30_N43_00_E042_00_DEM.tif   # COG 1°×1°, ~1–3 МБ
  ├── AUXFILES/                                       # маски: HEM, WBM, EDM, FLM
  ├── INFO/
  └── PREVIEW/
```

Координаты: `N43_00_E042_00` = lat 43°N, lon 42°E (юго-западный угол).
`30` в имени — 30 угловых секунд (это и есть ~90 м на экваторе).

## Для Приэльбрусья (тест)

```powershell
# 42–44°N, 42–43°E — 6 тайлов
foreach ($lat in 42..44) {
  foreach ($lon in 42..43) {
    $t = "Copernicus_DSM_COG_30_N{0:D2}_00_E{1:D3}_00_DEM" -f $lat, $lon
    aws s3 sync "s3://copernicus-dem-90m/$t/" "./dem/elbrus/$t/" --no-sign-request
  }
}
```

## Обработка в наши тайлы

> ⚠️ Пайплайн ещё не прогонялся на реальных данных GLO-90 — только на синтетике.
> Первый прогон делаем на Приэльбрусье и сверяем с контрольными точками
> (MVP-ACCEPTANCE.md): Приют 11 — 4127 м, Эльбрус — 5642 м.

```powershell
# Установка GDAL (Python)
pip install rasterio gdal

# Слияние тайлов в один GeoTIFF (COG лежат по подпапкам)
gdal_merge.py -o dem/elbrus-merged.tif (Get-ChildItem dem/elbrus -Recurse -Filter *_DEM.tif).FullName

# Перепроекция в EPSG:4326 (уже в нём, но на всякий случай)
gdalwarp -t_srs EPSG:4326 -tr 0.000833333 0.000833333 dem/elbrus-merged.tif dem/elbrus-90m.tif

# Генерация тайлов
python tools/dem-to-tiles/dem_to_tiles.py dem/elbrus-90m.tif -o public/tiles/elbrus
```

После генерации патч подхватится автоматически: `DemSource` сначала спрашивает
локальный патч (`/tiles/{region}`), и только при промахе идёт в Terrarium.

## Оценка времени

| Этап | Время |
|---|---|
| Скачивание планеты (~175 ГБ) | 6+ часов (фактически — около суток на бытовом канале) |
| Обработка одного региона | ~5 мин |
| Обработка планеты (все регионы) | ~2–4 часа (параллельно) |

## Альтернатива: только горы

Планета целиком не нужна — для тайлов идут только горные регионы из
`tools/regions.json`. Остальное закрывает онлайн-слой Terrarium.
Оценка объёмов и схема LOD — в [DEM-ECONOMICAL.md](DEM-ECONOMICAL.md).

```powershell
# Тайлы под bbox региона: качаем только пересекающиеся 1°×1° клетки
# (bbox берём из tools/regions.json)
```

## Ссылки

- Реестр: https://registry.opendata.aws/copernicus-dem/
- Документация: https://copernicus-dem-90m.s3.amazonaws.com/readme.html
