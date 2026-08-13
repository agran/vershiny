# Скачивание Copernicus GLO-90 для всей планеты

> Цель: ~175 ГБ GeoTIFF → наши компактные тайлы (~600 МБ) для GitHub Pages.

## Статус загрузки (2026-08-12)

| Показатель | Значение |
|---|---|
| Скачано тайлов | 26 475 из 26 475 (100%) |
| Расположение | `C:\dev\vershiny\dem\glo-90` (в `.gitignore`) |
| Следующий шаг | конвертация: `tools/glo90-to-tiles` |

Проверить:

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

### Вся планета → глобальная пирамида (основной путь)

`tools/glo90-to-tiles` сам обходит `dem/glo-90`, сливать и перепроецировать
заранее ничего не нужно. Формат и схема уровней —
[DATA-PIPELINE.md](DATA-PIPELINE.md), раздел «Глобальная пирамида».

```powershell
pip install rasterio numpy tqdm

# 1. Статистика исходников (кеш dem/glo-90-scan.json, ~5 мин, повторно мгновенно)
python tools\glo90-to-tiles\glo90_to_tiles.py scan

# 2. План: сколько тайлов и мегабайт влезет в бюджет (ничего не пишет)
python tools\glo90-to-tiles\glo90_to_tiles.py build --dry-run

# 3. Конвертация с прогрессом (возобновляемая — можно прервать и повторить).
#    Пишем сразу в клон репозитория данных agran/vershiny-dem
python tools\glo90-to-tiles\glo90_to_tiles.py build --budget-mb 900 `
  --levels "512:2:400:0.55,256:4:150:0.35,64:8:0:-" `
  -o ..\vershiny-dem\tiles\global
```

Фактический прогон в отдельный репозиторий (бюджет 900 МБ, ~4 минуты):
**26 408 тайлов, 850 МБ** — LOD 2 вся суша (2156 тайлов, 37 МБ), LOD 1 —
13 184 тайла (315 МБ), LOD 0 — 11 068 тайлов (495 МБ). Покрытие регионов
приоритета 1 — 88% по LOD 0.

Данные лежат в [agran/vershiny-dem](https://github.com/agran/vershiny-dem)
и раздаются его GitHub Pages: в репозитории приложения им не место (тяжёлый
клон, да и Vite тормозит на 26 тыс. файлов в `public/`).

Ключи: `--workers N` (по умолчанию ядра−1), `--only-region elbrus` (пересобрать
один район), `--clean` (пересобрать с нуля — нужно, если менялись уровни или
правила отбора), `--levels 512:2:600:0.5,256:4:150:0.4,64:8:0:-` (своя лестница
уровней: `N:квант:мин_размах:доля_бюджета`).

Проверено на Приэльбрусье: Приют 11 → 4133 м, Азау → 2330 м, вершина
Эльбруса → 5524 м (пик сглажен ячейкой 217 м — ожидаемо).

### Один регион в 90 м (детальный патч)

Патч региона приоритетнее пирамиды — если району нужна максимальная детализация:

```powershell
# Слияние тайлов в один GeoTIFF (COG лежат по подпапкам)
gdal_merge.py -o dem/elbrus-merged.tif (Get-ChildItem dem/elbrus -Recurse -Filter *_DEM.tif).FullName

# Перепроекция в EPSG:4326 (уже в нём, но на всякий случай)
gdalwarp -t_srs EPSG:4326 -tr 0.000833333 0.000833333 dem/elbrus-merged.tif dem/elbrus-90m.tif

# Генерация тайлов
python tools/dem-to-tiles/dem_to_tiles.py dem/elbrus-90m.tif -o public/tiles/elbrus
```

После генерации патч подхватится автоматически: `DemSource` сначала спрашивает
детальный патч (`/tiles/{region}`), затем Terrarium, затем глобальную пирамиду.

## Оценка времени

| Этап | Время |
|---|---|
| Скачивание планеты (~175 ГБ) | 6+ часов (фактически — около суток на бытовом канале) |
| `scan` (статистика 26 475 тайлов) | ~5 мин, кешируется |
| `build --dry-run` (план с замером) | ~1–2 мин |
| `build` планеты в 600 МБ | ~1–3 часа (зависит от диска и числа воркеров) |
| `build --only-region` одного района | секунды-минуты |

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
