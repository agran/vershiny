#!/usr/bin/env python3
"""
dem-to-tiles: GeoTIFF (SRTM V3 / GLO-90 / AW3D30) → бинарные тайлы 256×256 int16.

Формат — docs/DATA-PIPELINE.md:
  {out}/{lod}/{x}/{y}.bin  int16 LE, без заголовка, строки с севера на юг
  {out}/index.json         bbox, размеры ячеек, LOD-список

LOD-схема:
  LOD 0 — исходное разрешение (~90 м, радиус 0–30 км от центра региона)
  LOD 1 — даунсэмпл средним ×4 (~360–500 м, 30–200 км)

Использование:
  python dem_to_tiles.py input.tif -o out/elbrus
  python dem_to_tiles.py input.tif -o out/elbrus --lod-factor 4
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

try:
    import rasterio
except ImportError:
    sys.exit("Нужен rasterio: pip install rasterio numpy")

# Консоль Windows (cp1251) не выводит Unicode из help/сообщений
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

TILE_SIZE = 256


def downsample_mean(arr: np.ndarray, factor: int) -> np.ndarray:
    """Даунсэмпл средним (не ближайшим — иначе теряются гребни, DATA-PIPELINE)."""
    h, w = arr.shape
    h2, w2 = h // factor * factor, w // factor * factor
    cropped = arr[:h2, :w2].astype(np.float64)
    # NaN (дыры/море) не должны утянуть среднее
    valid = ~np.isnan(cropped)
    summed = np.where(valid, cropped, 0.0).reshape(h2 // factor, factor, w2 // factor, factor).sum(axis=(1, 3))
    count = valid.reshape(h2 // factor, factor, w2 // factor, factor).sum(axis=(1, 3))
    out = np.full(summed.shape, np.nan)
    np.divide(summed, count, out=out, where=count > 0)
    return out


def write_tiles(arr: np.ndarray, out_dir: Path) -> tuple[int, int]:
    """Нарезка массива высот на тайлы 256×256 int16 LE. Пустые (все NaN) тайлы не пишем."""
    height, width = arr.shape
    tiles_x = (width + TILE_SIZE - 1) // TILE_SIZE
    tiles_y = (height + TILE_SIZE - 1) // TILE_SIZE
    written = 0
    for ty in range(tiles_y):
        for tx in range(tiles_x):
            tile = arr[
                ty * TILE_SIZE : (ty + 1) * TILE_SIZE,
                tx * TILE_SIZE : (tx + 1) * TILE_SIZE,
            ]
            if np.all(np.isnan(tile)):
                continue
            # Краевые тайлы дополняем NaN→0 за пределами сетки
            padded = np.full((TILE_SIZE, TILE_SIZE), np.nan)
            padded[: tile.shape[0], : tile.shape[1]] = tile
            filled = np.where(np.isnan(padded), 0, padded).astype("<i2")
            tile_path = out_dir / str(tx) / f"{ty}.bin"
            tile_path.parent.mkdir(parents=True, exist_ok=True)
            tile_path.write_bytes(filled.tobytes())
            written += 1
    return tiles_x, tiles_y


def main() -> None:
    parser = argparse.ArgumentParser(description="GeoTIFF → int16 тайлы 256×256 + LOD")
    parser.add_argument("input", type=Path, help="GeoTIFF в EPSG:4326")
    parser.add_argument("-o", "--out", type=Path, required=True, help="Каталог региона")
    parser.add_argument("--lod-factor", type=int, default=4, help="Фактор даунсэмпла LOD 1")
    args = parser.parse_args()

    with rasterio.open(args.input) as src:
        if src.crs and src.crs.to_epsg() != 4326:
            sys.exit("Перепроецируйте в EPSG:4326: gdalwarp -t_srs EPSG:4326 in.tif out.tif")
        arr = src.read(1).astype(np.float64)
        nodata = src.nodata
        if nodata is not None:
            arr[arr == nodata] = np.nan
        # SRTM void-filled: дыры иногда -32768
        arr[arr < -500] = np.nan
        bounds = src.bounds
        cell_deg = abs(src.res[0])
        if abs(src.res[0] - src.res[1]) > 1e-12:
            sys.exit("Ячейка не квадратная в градусах — сделайте gdalwarp -tr <deg> <deg>")

    out_lod0 = args.out / "0"
    print(f"LOD 0: {arr.shape[1]}×{arr.shape[0]}, ячейка {cell_deg:.8f}°")
    tiles_x0, tiles_y0 = write_tiles(arr, out_lod0)

    lod1 = downsample_mean(arr, args.lod_factor)
    out_lod1 = args.out / "1"
    print(f"LOD 1: {lod1.shape[1]}×{lod1.shape[0]}, ячейка {cell_deg * args.lod_factor:.8f}°")
    tiles_x1, tiles_y1 = write_tiles(lod1, out_lod1)

    index = {
        "bbox": [bounds.left, bounds.bottom, bounds.right, bounds.top],
        "lods": [
            {
                "cellDeg": cell_deg,
                "gridWidth": arr.shape[1],
                "gridHeight": arr.shape[0],
                "tilesX": tiles_x0,
                "tilesY": tiles_y0,
            },
            {
                "cellDeg": cell_deg * args.lod_factor,
                "gridWidth": lod1.shape[1],
                "gridHeight": lod1.shape[0],
                "tilesX": tiles_x1,
                "tilesY": tiles_y1,
            },
        ],
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"OK: {args.out} (LOD0 {tiles_x0}×{tiles_y0}, LOD1 {tiles_x1}×{tiles_y1} тайлов)")

    # struct импортирован для отладочного чтения тайлов в тестах
    _ = struct


if __name__ == "__main__":
    main()
