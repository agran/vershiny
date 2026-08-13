#!/usr/bin/env python3
"""
glo90-to-tiles: Copernicus GLO-90 (26 475 GeoTIFF, ~175 ГБ) → глобальная
разреженная пирамида тайлов для GitHub Pages (docs/DEM-ECONOMICAL.md).

Схема (docs/DATA-PIPELINE.md, раздел «Глобальная пирамида»):

    tiles/global/{lod}/{x}/{y}.bin.gz   256×256 int16 LE, дельта по строкам, gzip
    tiles/global/index.json             bbox, уровни, квант, битсет покрытия

Уровень задаётся числом ячеек в градусе N; тайл 256 ячеек = 256/N градусов,
поэтому границы тайлов ложатся на градусную сетку исходников:

    LOD 0  N=512  ~217 м   тайл 0.5°   горы           (по бюджету)
    LOD 1  N=256  ~434 м   тайл 1°     рельефная суша (по бюджету)
    LOD 2  N=64   ~1.74 км тайл 4°     вся суша

Отбор ячеек — по score = размах высот × вес приоритета региона (tools/regions.json):
уровень наполняется от «самых горных» к равнинам, пока не исчерпан его бюджет,
поэтому итоговый размер известен точно, а не по оценке.

Использование:

    # 1) статистика по исходникам (кешируется, ~3-10 мин, повторно мгновенно)
    python tools/glo90-to-tiles/glo90_to_tiles.py scan --src dem/glo-90

    # 2) план без записи: сколько ячеек и мегабайт уйдёт на каждый уровень
    python tools/glo90-to-tiles/glo90_to_tiles.py build --dry-run

    # 3) конвертация (возобновляемая; --clean — пересобрать с нуля)
    python tools/glo90-to-tiles/glo90_to_tiles.py build --budget-mb 600
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import shutil
import sys
import zlib
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path

import numpy as np

try:
    import rasterio
    from affine import Affine
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.warp import reproject
except ImportError:  # pragma: no cover — подсказка окружения
    sys.exit("Нужен rasterio: pip install rasterio numpy tqdm")

try:
    from tqdm import tqdm
except ImportError:  # pragma: no cover
    sys.exit("Нужен tqdm: pip install tqdm")

# Консоль Windows (cp1251) не выводит Unicode
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

TILE_SIZE = 256
#: Имя вида Copernicus_DSM_COG_30_N43_00_E042_00_DEM
NAME_RE = re.compile(r"_([NS])(\d{2})_00_([EW])(\d{3})_00_DEM$")
#: Высоты вне диапазона — дыры/мусор (Мёртвое море −430 м, Эверест 8849 м)
MIN_VALID_M, MAX_VALID_M = -500.0, 9000.0
#: Вес порога рельефа по приоритету региона: в низкогорьях с высоким
#: приоритетом (Хибины, Урал, Шотландия) размах мал, но люди там ходят
PRIORITY_WEIGHT = {1: 4.0, 2: 3.0, 3: 2.0, 4: 1.5}
#: Приоритет ячейки, которую не покрывает ни один регион реестра
NO_REGION_PRIORITY = 9


@dataclass(frozen=True)
class Level:
    """Уровень пирамиды: N ячеек в градусе, квант высоты, порог рельефа."""

    cells_per_deg: int
    quant_m: int
    min_relief_m: float
    #: Доля общего бюджета; None — без лимита (уровень пишется целиком)
    budget_share: float | None

    @property
    def cell_deg(self) -> float:
        return 1.0 / self.cells_per_deg

    @property
    def tile_deg(self) -> float:
        return TILE_SIZE / self.cells_per_deg

    @property
    def res_m(self) -> float:
        return self.cell_deg * 111_320


#: LOD 0 — самый детальный (клиент нумерует так же: 0 = детальный).
#: Квант высоты выбран заведомо мельче ошибки самой сетки (217 м ячейка
#: даёт десятки метров), зато экономит ~15% объёма на каждом удвоении.
DEFAULT_LEVELS = (
    Level(cells_per_deg=512, quant_m=2, min_relief_m=600.0, budget_share=0.5),
    Level(cells_per_deg=256, quant_m=4, min_relief_m=150.0, budget_share=0.4),
    Level(cells_per_deg=64, quant_m=8, min_relief_m=0.0, budget_share=None),
)


# ─────────────────────────── исходники и статистика ───────────────────────────


def parse_cell(stem: str) -> tuple[int, int] | None:
    """`..._N43_00_E042_00_DEM` → (lat, lon) юго-западного угла ячейки 1°×1°."""
    m = NAME_RE.search(stem)
    if not m:
        return None
    ns, lat, ew, lon = m.groups()
    return (int(lat) * (1 if ns == "N" else -1), int(lon) * (1 if ew == "E" else -1))


def find_sources(src_dir: Path) -> dict[tuple[int, int], Path]:
    """Все DEM-тайлы бакета: {(lat, lon): путь к .tif}."""
    sources: dict[tuple[int, int], Path] = {}
    for tif in src_dir.glob("*_DEM/*_DEM.tif"):
        cell = parse_cell(tif.stem)
        if cell is not None:
            sources[cell] = tif
    return sources


def scan_one(args: tuple[int, int, str]) -> tuple[int, int, float, float, float]:
    """Статистика исходника по грубому обзору: (lat, lon, min, max, mean)."""
    lat, lon, path = args
    with rasterio.open(path) as src:
        # Обзор ×4 (в COG всегда есть [2, 4]) — полный растр читать незачем
        ow = max(1, src.width // 4)
        oh = max(1, src.height // 4)
        arr = src.read(1, out_shape=(oh, ow), resampling=Resampling.average).astype(np.float32)
    valid = arr[(arr > MIN_VALID_M) & (arr < MAX_VALID_M)]
    if valid.size == 0:
        return (lat, lon, 0.0, 0.0, 0.0)
    # Перцентили, а не min/max: единичный артефакт не должен делать «гору»
    lo, hi = np.percentile(valid, (0.5, 99.5))
    return (lat, lon, float(lo), float(hi), float(valid.mean()))


def load_scan(
    src_dir: Path, cache: Path, workers: int, refresh: bool
) -> dict[tuple[int, int], dict[str, float]]:
    """Статистика по всем исходникам с кешем на диске."""
    sources = find_sources(src_dir)
    if not sources:
        sys.exit(f"Не найдено ни одного *_DEM.tif в {src_dir}")

    stats: dict[tuple[int, int], dict[str, float]] = {}
    if cache.exists() and not refresh:
        raw = json.loads(cache.read_text(encoding="utf-8"))
        for key, value in raw.get("cells", {}).items():
            lat, lon = key.split(",")
            stats[(int(lat), int(lon))] = value

    todo = [
        (lat, lon, str(path))
        for (lat, lon), path in sources.items()
        if (lat, lon) not in stats
    ]
    if not todo:
        print(f"Статистика из кеша: {len(stats)} ячеек ({cache})")
        return stats

    print(f"Статистика исходников: {len(todo)} из {len(sources)} (остальное из кеша)")
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for lat, lon, lo, hi, mean in tqdm(
            pool.map(scan_one, todo, chunksize=16),
            total=len(todo),
            unit="тайл",
            dynamic_ncols=True,
        ):
            stats[(lat, lon)] = {"min": lo, "max": hi, "mean": mean, "relief": hi - lo}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(
        json.dumps({"cells": {f"{lat},{lon}": v for (lat, lon), v in stats.items()}}),
        encoding="utf-8",
    )
    print(f"Кеш статистики: {cache}")
    return stats


def region_priority(
    regions_path: Path, cells: list[tuple[int, int]]
) -> dict[tuple[int, int], int]:
    """Приоритет ячейки = минимальный среди покрывающих её регионов реестра."""
    priority = {cell: NO_REGION_PRIORITY for cell in cells}
    if not regions_path.exists():
        return priority
    regions = json.loads(regions_path.read_text(encoding="utf-8"))
    for key, info in regions.items():
        if key.startswith("$") or not isinstance(info, dict) or "bbox" not in info:
            continue
        min_lon, min_lat, max_lon, max_lat = info["bbox"]
        value = info.get("priority", 4)
        for cell in cells:
            lat, lon = cell
            if lon + 1 > min_lon and lon < max_lon and lat + 1 > min_lat and lat < max_lat:
                if value < priority[cell]:
                    priority[cell] = value
    return priority


# ──────────────────────────────── кодирование ────────────────────────────────


FILL_PASSES = 4


def fill_voids(values: np.ndarray) -> np.ndarray:
    """Дыры DEM → высоты соседей.

    Формат тайла отличать «нет данных» от высоты не умеет, а обнулять дыры
    нельзя: посреди хребта появлялся провал до уровня моря, и клиент честно
    рисовал в нём небо. Затягиваем дыру соседями (в GLO-90 они мелкие), а
    остаток — средним по тайлу: любая правдоподобная высота лучше нуля.
    """
    out = np.asarray(values, dtype=np.float32).copy()
    if not np.isnan(out).any():
        return out
    if np.isnan(out).all():
        return np.zeros_like(out)

    for _ in range(FILL_PASSES):
        holes = np.isnan(out)
        if not holes.any():
            return out
        padded = np.pad(out, 1, constant_values=np.nan)
        neighbours = np.stack(
            [
                padded[:-2, 1:-1],
                padded[2:, 1:-1],
                padded[1:-1, :-2],
                padded[1:-1, 2:],
            ]
        )
        valid = ~np.isnan(neighbours)
        count = valid.sum(axis=0)
        total = np.where(valid, neighbours, 0.0).sum(axis=0)
        mean = np.divide(
            total, count, out=np.full_like(total, np.nan), where=count > 0
        )
        fill = holes & ~np.isnan(mean)
        if not fill.any():
            break
        out[fill] = mean[fill]

    holes = np.isnan(out)
    if holes.any():
        out[holes] = float(np.nanmean(out))
    return out


def encode_tile(values: np.ndarray, quant_m: int) -> bytes:
    """int16 (квант) → дельта по строкам → gzip. Читает src/core/dem.ts."""
    quantized = np.rint(fill_voids(values) / quant_m)
    np.clip(quantized, -32768, 32767, out=quantized)
    tile = quantized.astype(np.int32)
    # Первый столбец — абсолютное значение (клиент начинает накопление с нуля),
    # дальше разности; переполнение int16 симметрично снимается на клиенте
    zeros = np.zeros((tile.shape[0], 1), dtype=np.int32)
    delta = np.diff(tile, axis=1, prepend=zeros).astype("<i2")
    compressor = zlib.compressobj(9, zlib.DEFLATED, 31)  # 31 = gzip-заголовок
    return compressor.compress(delta.tobytes()) + compressor.flush()


def tile_path(out_dir: Path, lod: int, tx: int, ty: int) -> Path:
    return out_dir / str(lod) / str(tx) / f"{ty}.bin.gz"


# ────────────────────────────── чтение исходников ──────────────────────────────


def read_source(path: str, cells_per_deg: int) -> tuple[np.ndarray, Affine]:
    """Чтение исходника с прореживанием до ~2 пикселей на выходную ячейку."""
    with rasterio.open(path) as src:
        deg_w = abs(src.bounds.right - src.bounds.left)
        deg_h = abs(src.bounds.top - src.bounds.bottom)
        ow = min(src.width, max(1, int(math.ceil(deg_w * cells_per_deg * 2))))
        oh = min(src.height, max(1, int(math.ceil(deg_h * cells_per_deg * 2))))
        arr = src.read(1, out_shape=(oh, ow), resampling=Resampling.average).astype(np.float32)
        transform = src.transform * Affine.scale(src.width / ow, src.height / oh)
    arr[(arr < MIN_VALID_M) | (arr > MAX_VALID_M)] = np.nan
    return arr, transform


def render_tile(
    sources: list[tuple[np.ndarray, Affine]], lon0: float, lat0: float, cell: float
) -> np.ndarray | None:
    """Тайл 256×256 из уже прочитанных исходников (усреднение при перепроекции).

    lon0/lat0 — центр левой верхней ячейки: сетка «пиксель-точка», как её
    понимает билинейная интерполяция клиента (src/core/dem.ts).
    """
    dst = np.full((TILE_SIZE, TILE_SIZE), np.nan, dtype=np.float32)
    dst_transform = from_origin(lon0 - cell / 2, lat0 + cell / 2, cell, cell)
    filled = False
    for arr, src_transform in sources:
        patch = np.full((TILE_SIZE, TILE_SIZE), np.nan, dtype=np.float32)
        reproject(
            arr,
            patch,
            src_transform=src_transform,
            src_crs="EPSG:4326",
            src_nodata=np.nan,
            dst_transform=dst_transform,
            dst_crs="EPSG:4326",
            dst_nodata=np.nan,
            resampling=Resampling.average,
        )
        mask = ~np.isnan(patch)
        if mask.any():
            dst[mask] = patch[mask]
            filled = True
    return dst if filled else None


def process_item(job: tuple, write: bool = True) -> tuple[int, int]:
    """Задание воркера: тайлы одной группы. → (тайлов, байт).

    Группа = набор выходных тайлов с общим списком исходников: так каждый
    GeoTIFF читается с диска один раз на уровень. write=False — только замер
    размера (для --dry-run).
    """
    lod, tiles, source_paths, cells_per_deg, quant_m, out_dir = job
    out = Path(out_dir)
    cell = 1.0 / cells_per_deg
    span = TILE_SIZE * cell

    total_bytes = 0
    written = 0
    todo = []
    for tx, ty in tiles:
        path = tile_path(out, lod, tx, ty)
        if write and path.exists():
            total_bytes += path.stat().st_size
            written += 1
        else:
            todo.append((tx, ty, path))
    if not todo:
        return (written, total_bytes)

    sources = [read_source(path, cells_per_deg) for path in source_paths]
    for tx, ty, path in todo:
        values = render_tile(sources, -180 + tx * span, 90 - ty * span, cell)
        if values is None:
            continue  # только вода/дыры — тайла нет, клиент уйдёт на грубый LOD
        blob = encode_tile(values, quant_m)
        if write:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_bytes(blob)
            os.replace(tmp, path)
        total_bytes += len(blob)
        written += 1
    return (written, total_bytes)


def build_item(job: tuple) -> tuple[int, int]:
    return process_item(job, write=True)


def measure_item(job: tuple) -> tuple[int, int]:
    return process_item(job, write=False)


# ─────────────────────────────── план и сборка ───────────────────────────────


def group_jobs(
    lod: int,
    level: Level,
    cells: list[tuple[int, int]],
    sources: dict[tuple[int, int], Path],
    out_dir: Path,
) -> list[tuple]:
    """Ячейки 1° (в порядке приоритета) → задания воркерам.

    Тайл ≤1°: группа = ячейка-исходник (в ней 1, 4, … тайлов).
    Тайл >1°: группа = выходной тайл со всеми исходниками, что в него попадают.
    """
    n = level.cells_per_deg
    span = level.tile_deg
    jobs: list[tuple] = []

    if span <= 1.0:
        per_deg = int(round(1.0 / span))
        for lat, lon in cells:
            tiles = []
            for i in range(per_deg):
                for j in range(per_deg):
                    tx = int(round((lon + 180) * per_deg)) + i
                    ty = int(round((90 - lat - 1) * per_deg)) + j
                    tiles.append((tx, ty))
            jobs.append((lod, tiles, [str(sources[(lat, lon)])], n, level.quant_m, str(out_dir)))
        return jobs

    seen: set[tuple[int, int]] = set()
    for lat, lon in cells:
        tx = int(math.floor((lon + 180) / span))
        ty = int(math.floor((90 - lat - 1e-9) / span))
        if (tx, ty) in seen:
            continue
        seen.add((tx, ty))
        lon_min = -180 + tx * span
        lat_max = 90 - ty * span
        lon_max = lon_min + (TILE_SIZE - 1) / n
        lat_min = lat_max - (TILE_SIZE - 1) / n
        paths = [
            str(sources[(slat, slon)])
            for slat in range(int(math.floor(lat_min)), int(math.floor(lat_max)) + 1)
            for slon in range(int(math.floor(lon_min)), int(math.floor(lon_max)) + 1)
            if (slat, slon) in sources
        ]
        jobs.append((lod, [(tx, ty)], paths, n, level.quant_m, str(out_dir)))
    return jobs


def select_cells(
    level: Level,
    stats: dict[tuple[int, int], dict[str, float]],
    priority: dict[tuple[int, int], int],
) -> list[tuple[int, int]]:
    """Ячейки уровня: сначала приоритетные регионы целиком, внутри — по рельефу.

    Сортировка по абсолютному размаху высот отдала бы весь бюджет Гималаям и
    Андам, а Хибины с Уралом (приоритет 1–2, размах ~1 км) остались бы без
    детального уровня. Поэтому приоритет региона — первый ключ сортировки, а
    порог рельефа для таких регионов дополнительно смягчается.
    """
    selected = []
    for cell, stat in stats.items():
        rank = priority.get(cell, NO_REGION_PRIORITY)
        weight = PRIORITY_WEIGHT.get(rank, 1.0)
        if stat["relief"] * weight < level.min_relief_m:
            continue
        selected.append((rank, -stat["relief"], cell))
    selected.sort()
    return [cell for _, _, cell in selected]


def build_level(
    lod: int, level: Level, jobs: list[tuple], budget_bytes: float, workers: int
) -> tuple[int, int]:
    """Сборка уровня до исчерпания бюджета. → (тайлов, байт)."""
    written = 0
    total_bytes = 0
    limit_text = "∞" if math.isinf(budget_bytes) else f"{budget_bytes / 1e6:.0f}"
    bar = tqdm(
        total=len(jobs),
        unit="группа",
        desc=f"LOD {lod} ({level.res_m:.0f} м)",
        dynamic_ncols=True,
    )
    stopped = False
    with ProcessPoolExecutor(max_workers=workers) as pool:
        queue = iter(jobs)
        pending = set()

        def submit_next() -> bool:
            job = next(queue, None)
            if job is None:
                return False
            pending.add(pool.submit(build_item, job))
            return True

        for _ in range(workers * 3):
            if not submit_next():
                break

        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            pending = set(pending)
            for future in done:
                tiles, size = future.result()
                written += tiles
                total_bytes += size
                bar.update(1)
            bar.set_postfix_str(f"{total_bytes / 1e6:.0f}/{limit_text} МБ, тайлов {written}")
            if total_bytes >= budget_bytes:
                stopped = True
                break
            for _ in range(len(done)):
                if not submit_next():
                    break
        if stopped:
            pool.shutdown(wait=True, cancel_futures=True)
    bar.close()
    if stopped:
        print(f"  LOD {lod}: бюджет уровня выбран, остальные ячейки пропущены")
    return written, total_bytes


def estimate_level(
    jobs: list[tuple], budget_bytes: float, workers: int, samples: int = 12
) -> tuple[int, int, float]:
    """Оценка уровня по выборке групп. → (групп в бюджете, тайлов, байт).

    Размер тайла сильно зависит от рельефа, а группы уже отсортированы от
    «самых горных» к равнинам — поэтому замеряем несколько групп по всему
    диапазону и интерполируем размер остальных по их позиции в списке.
    """
    if not jobs:
        return (0, 0, 0.0)
    count = min(samples, len(jobs))
    picks = sorted({int(round(i * (len(jobs) - 1) / max(1, count - 1))) for i in range(count)})
    with ProcessPoolExecutor(max_workers=min(workers, len(picks))) as pool:
        measured = list(pool.map(measure_item, [jobs[i] for i in picks]))
    tiles_per_job = [m[0] for m in measured]
    bytes_per_job = [float(m[1]) for m in measured]

    sizes = np.interp(np.arange(len(jobs)), picks, bytes_per_job)
    tiles = np.interp(np.arange(len(jobs)), picks, tiles_per_job)
    cumulative = np.cumsum(sizes)
    if math.isinf(budget_bytes) or cumulative[-1] <= budget_bytes:
        fit = len(jobs)
    else:
        fit = int(np.searchsorted(cumulative, budget_bytes))
    total = float(cumulative[fit - 1]) if fit else 0.0
    return (fit, int(round(tiles[:fit].sum())), total)


def coverage_bitset(out_dir: Path, lod: int, tiles_x: int, tiles_y: int) -> tuple[str, int]:
    """Битовая карта существующих тайлов (ty*tilesX+tx) → base64 + средний вес байт.

    Средний вес нужен клиенту: по нему панель настроек честно показывает,
    сколько весит офлайн-загрузка региона (число тайлов в bbox × средний вес).
    """
    bits = bytearray((tiles_x * tiles_y + 7) // 8)
    total_bytes = 0
    count = 0
    lod_dir = out_dir / str(lod)
    if lod_dir.exists():
        for x_dir in lod_dir.iterdir():
            if not x_dir.is_dir() or not x_dir.name.isdigit():
                continue
            tx = int(x_dir.name)
            for tile in x_dir.glob("*.bin.gz"):
                ty = int(tile.name.split(".")[0])
                index = ty * tiles_x + tx
                bits[index >> 3] |= 1 << (index & 7)
                total_bytes += tile.stat().st_size
                count += 1
    avg = round(total_bytes / count) if count else 0
    return base64.b64encode(bytes(bits)).decode("ascii"), avg


def write_index(out_dir: Path, levels: tuple[Level, ...]) -> dict:
    """index.json: bbox планеты, параметры уровней, карта покрытия."""
    lods = []
    for lod, level in enumerate(levels):
        n = level.cells_per_deg
        grid_width, grid_height = 360 * n, 180 * n
        tiles_x, tiles_y = grid_width // TILE_SIZE, grid_height // TILE_SIZE
        coverage, avg_bytes = coverage_bitset(out_dir, lod, tiles_x, tiles_y)
        lods.append(
            {
                "cellDeg": level.cell_deg,
                "quantM": level.quant_m,
                "gridWidth": grid_width,
                "gridHeight": grid_height,
                "tilesX": tiles_x,
                "tilesY": tiles_y,
                "avgTileBytes": avg_bytes,
                "coverage": coverage,
            }
        )
    index = {
        "bbox": [-180.0, -90.0, 180.0, 90.0],
        "encoding": "gzip",
        "filter": "delta-x",
        "tileExt": ".bin.gz",
        "attribution": "© DLR/ESA Copernicus DEM GLO-90",
        "lods": lods,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.json").write_text(json.dumps(index), encoding="utf-8")
    return index


def dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*.bin.gz"))


# ──────────────────────────────────── CLI ────────────────────────────────────


def parse_levels(spec: str | None) -> tuple[Level, ...]:
    """`512:1:600:0.55,256:2:150:0.35,64:4:0:-` → уровни пирамиды."""
    if not spec:
        return DEFAULT_LEVELS
    levels = []
    for part in spec.split(","):
        n, quant, relief, share = part.split(":")
        levels.append(
            Level(
                cells_per_deg=int(n),
                quant_m=int(quant),
                min_relief_m=float(relief),
                budget_share=None if share == "-" else float(share),
            )
        )
    if any(360 * lvl.cells_per_deg % TILE_SIZE for lvl in levels):
        sys.exit("N должно давать целое число тайлов: 360·N кратно 256 (64, 128, 256, 512…)")
    return tuple(levels)


def cmd_scan(args: argparse.Namespace) -> None:
    load_scan(args.src, args.cache, args.workers, args.refresh)


def cmd_build(args: argparse.Namespace) -> None:
    levels = parse_levels(args.levels)
    if args.index_only:
        index = write_index(args.out, levels)
        print(f"index.json пересобран по файлам на диске → {args.out}")
        for lod, lod_info in enumerate(index["lods"]):
            print(f"  LOD {lod}: средний тайл {lod_info['avgTileBytes'] / 1024:.1f} КБ")
        return
    if args.clean and args.out.exists() and not args.dry_run:
        shutil.rmtree(args.out)
        print(f"Каталог очищен: {args.out}")
    sources = find_sources(args.src)
    stats = load_scan(args.src, args.cache, args.workers, args.refresh)
    stats = {cell: stat for cell, stat in stats.items() if cell in sources}

    priority = region_priority(args.regions, list(stats.keys()))
    budget = args.budget_mb * 1e6
    already = dir_size(args.out) if args.out.exists() else 0

    if args.only_region:
        regions = json.loads(args.regions.read_text(encoding="utf-8"))
        info = regions.get(args.only_region)
        if not isinstance(info, dict) or "bbox" not in info:
            sys.exit(f"Регион {args.only_region} не найден в {args.regions}")
        min_lon, min_lat, max_lon, max_lat = info["bbox"]
        stats = {
            (lat, lon): stat
            for (lat, lon), stat in stats.items()
            if lon + 1 > min_lon and lon < max_lon and lat + 1 > min_lat and lat < max_lat
        }
        print(f"Только регион {args.only_region}: {len(stats)} ячеек 1°×1°")

    print(f"\nИсходников: {len(sources)} ячеек 1°×1°, бюджет {args.budget_mb:.0f} МБ")
    plan = []
    for lod, level in enumerate(levels):
        cells = select_cells(level, stats, priority)
        limit = budget * level.budget_share if level.budget_share is not None else math.inf
        plan.append((lod, level, cells, limit))
        by_priority = ", ".join(
            f"p{p}: {sum(1 for c in cells if priority.get(c, NO_REGION_PRIORITY) == p)}"
            for p in (1, 2, 3, 4)
        )
        print(
            f"  LOD {lod}: {level.res_m:7.0f} м, тайл {level.tile_deg:g}°, "
            f"квант {level.quant_m} м, размах ≥{level.min_relief_m:.0f} м → "
            f"{len(cells)} ячеек ({by_priority}), бюджет "
            + ("без лимита" if math.isinf(limit) else f"{limit / 1e6:.0f} МБ")
        )
    if already:
        print(f"  Уже на диске: {already / 1e6:.0f} МБ (засчитывается, файлы не пересобираются)")
        old_index = args.out / "index.json"
        if old_index.exists():
            old_lods = json.loads(old_index.read_text(encoding="utf-8")).get("lods", [])
            if [lod["cellDeg"] for lod in old_lods] != [lvl.cell_deg for lvl in levels]:
                print(
                    "  ⚠ На диске тайлы другой лестницы уровней — очистите каталог, "
                    "иначе получится смесь"
                )

    if args.dry_run:
        print("\nОценка по выборке групп (замер настоящих тайлов, без записи):")
        planned = 0.0
        for lod, level, cells, limit in plan:
            jobs = group_jobs(lod, level, cells, sources, args.out)
            fit, tiles, size = estimate_level(jobs, limit, args.workers)
            planned += size
            print(
                f"  LOD {lod}: ≈{tiles} тайлов, ≈{size / 1e6:.0f} МБ "
                f"(влезает {fit} из {len(jobs)} групп, "
                f"{'вся суша' if fit == len(jobs) else 'обрезано бюджетом'})"
            )
        print(f"  Итого ≈{planned / 1e6:.0f} МБ из {args.budget_mb:.0f} МБ")
        print("\n--dry-run: файлы не пишутся")
        return

    print()
    total_bytes = 0
    total_tiles = 0
    # Грубые уровни первыми: они дёшевы и дают покрытие планеты даже при обрыве
    for lod, level, cells, limit in reversed(plan):
        jobs = group_jobs(lod, level, cells, sources, args.out)
        tiles, size = build_level(lod, level, jobs, limit, args.workers)
        total_tiles += tiles
        total_bytes += size
        print(f"  LOD {lod}: {tiles} тайлов, {size / 1e6:.1f} МБ")

    print("\nИндекс и карта покрытия…")
    index = write_index(args.out, levels)
    index_size = (args.out / "index.json").stat().st_size
    print(
        f"\nГотово: {total_tiles} тайлов, {total_bytes / 1e6:.1f} МБ "
        f"+ index.json {index_size / 1e6:.2f} МБ → {args.out}"
    )
    for lod, lod_info in enumerate(index["lods"]):
        print(
            f"  LOD {lod}: сетка {lod_info['tilesX']}×{lod_info['tilesY']} тайлов, "
            f"ячейка {lod_info['cellDeg'] * 111320:.0f} м"
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="GLO-90 → глобальная пирамида тайлов для GitHub Pages",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--src", type=Path, default=Path("dem/glo-90"), help="Каталог с GLO-90")
        p.add_argument(
            "--cache",
            type=Path,
            default=Path("dem/glo-90-scan.json"),
            help="Кеш статистики исходников",
        )
        p.add_argument("--refresh", action="store_true", help="Пересчитать статистику")
        p.add_argument(
            "--workers",
            type=int,
            default=max(1, (os.cpu_count() or 4) - 1),
            help="Процессов (по умолчанию: ядра − 1)",
        )

    p_scan = sub.add_parser("scan", help="Статистика исходников (кеш для build)")
    common(p_scan)
    p_scan.set_defaults(func=cmd_scan)

    p_build = sub.add_parser("build", help="Собрать пирамиду тайлов")
    common(p_build)
    p_build.add_argument(
        "-o", "--out", type=Path, default=Path("public/tiles/global"), help="Каталог тайлов"
    )
    p_build.add_argument(
        "--budget-mb", type=float, default=600.0, help="Бюджет размера, МБ (GitHub Pages)"
    )
    p_build.add_argument(
        "--levels", help="Уровни: N:квант:мин_размах:доля_бюджета через запятую"
    )
    p_build.add_argument(
        "--regions", type=Path, default=Path("tools/regions.json"), help="Реестр регионов"
    )
    p_build.add_argument(
        "--only-region",
        help="Ограничить bbox региона из реестра (например elbrus) — для проверки "
        "или пересборки одного района",
    )
    p_build.add_argument(
        "--clean", action="store_true", help="Удалить каталог тайлов перед сборкой"
    )
    p_build.add_argument("--dry-run", action="store_true", help="Только план, без записи")
    p_build.add_argument(
        "--index-only",
        action="store_true",
        help="Пересобрать index.json по уже лежащим на диске тайлам, без сборки",
    )
    p_build.set_defaults(func=cmd_build)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
