# Скачивание Copernicus GLO-90 для всей планеты

> Цель: ~150 ГБ GeoTIFF → наши компактные тайлы (~600 МБ) для GitHub Pages.

## Источник

**Copernicus DEM GLO-90** — AWS Open Data, без регистрации:
- Бакет: `s3://copernicus-dem-90m/` (eu-central-1)
- Покрытие: глобально, 90 м, GeoTIFF 1°×1°
- Лицензия: свободная, с атрибуцией © DLR/ESA

## Установка AWS CLI

```powershell
winget install Amazon.AWSCLI
# или: https://aws.amazon.com/cli/
```

## Скачивание всей планеты

```powershell
# Все тайлы (1°×1° = ~26 000 файлов, ~150 ГБ)
aws s3 sync s3://copernicus-dem-90m/ ./dem/glo-90/ --no-sign-request

# Или только нужные регионы (пример: Европа)
aws s3 sync s3://copernicus-dem-90m/Copernicus_DSM_90_N40_00_E000_00/ ./dem/glo-90/ --no-sign-request
aws s3 sync s3://copernicus-dem-90m/Copernicus_DSM_90_N40_00_E010_00/ ./dem/glo-90/ --no-sign-request
# ... и т.д. по координатам
```

## Структура тайлов

```
Copernicus_DSM_90_N43_00_E042_00/
  └── Copernicus_DSM_90_N43_00_E042_00.tif   # GeoTIFF 1°×1°
```

Координаты: `N43_00_E042_00` = lat 43°N, lon 42°E.

## Для Приэльбрусья (тест)

```powershell
# 42–44°E, 42–44°N
aws s3 sync s3://copernicus-dem-90m/Copernicus_DSM_90_N42_00_E042_00/ ./dem/elbrus/ --no-sign-request
aws s3 sync s3://copernicus-dem-90m/Copernicus_DSM_90_N42_00_E043_00/ ./dem/elbrus/ --no-sign-request
aws s3 sync s3://copernicus-dem-90m/Copernicus_DSM_90_N43_00_E042_00/ ./dem/elbrus/ --no-sign-request
aws s3 sync s3://copernicus-dem-90m/Copernicus_DSM_90_N43_00_E043_00/ ./dem/elbrus/ --no-sign-request
aws s3 sync s3://copernicus-dem-90m/Copernicus_DSM_90_N44_00_E042_00/ ./dem/elbrus/ --no-sign-request
aws s3 sync s3://copernicus-dem-90m/Copernicus_DSM_90_N44_00_E043_00/ ./dem/elbrus/ --no-sign-request
```

## Обработка в наши тайлы

```powershell
# Установка GDAL (Python)
pip install rasterio gdal

# Слияние тайлов в один GeoTIFF
gdal_merge.py -o dem/elbrus-merged.tif dem/elbrus/*.tif

# Перепроекция в EPSG:4326 (уже в нём, но на всякий случай)
gdalwarp -t_srs EPSG:4326 -tr 0.000833333 0.000833333 dem/elbrus-merged.tif dem/elbrus-90m.tif

# Генерация тайлов
python tools/dem-to-tiles/dem_to_tiles.py dem/elbrus-90m.tif -o public/tiles/elbrus
```

## Оценка времени

| Этап | Время |
|---|---|
| Скачивание планеты (~150 ГБ) | 2–6 часов (зависит от канала) |
| Обработка одного региона | ~5 мин |
| Обработка планеты (все регионы) | ~2–4 часа (параллельно) |

## Альтернатива: только горы

Если планета не нужна — скачивайте только тайлы с рельефом >200 м:

```python
# Скрипт фильтрации: скачать список тайлов, проверить размах высот
# (внутри GeoTIFF есть statistics — можно читать без скачивания всего)
```

## Ссылки

- Реестр: https://registry.opendata.aws/copernicus-dem/
- Документация: https://copernicus-dem-90m.s3.amazonaws.com/readme.html
