"""
Бенчмарк кодеков для тайлов DEM 256×256 int16 (квантованные значения).

Сравнивает на реальных тайлах из ..\\..\\vershiny-dem\\tiles\\global:
  1. delta-x + gzip-9   — текущий формат (база)
  2. paeth  + gzip-9    — 2D-предиктор PNG + наш gzip
  3. PNG I;16           — 16-бит gray PNG (Pillow, адаптивные фильтры)
  4. PNG RGB 2×8bit     — hi/lo байты в каналах R,G (декодируется браузером)
  5. Paeth + Rice       — собственный кодек (точный подсчёт битов, блоки 16 строк)
  6. delta-x + zstd-19  — справочно (нужен wasm-декодер на клиенте)

Запуск: python tools\\codec-bench\\codec_bench.py [--tiles N]
"""
import argparse
import gzip
import io
import random
import sys
import zlib
from pathlib import Path

import numpy as np
import zstandard
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEM_ROOT = Path(__file__).resolve().parents[3] / "vershiny-dem" / "tiles" / "global"
SIZE = 256
BLOCK_ROWS = 16


# ────────────────────────────── декодирование тайла ──────────────────────────────

def decode_tile(path: Path) -> np.ndarray:
    """bin.gz → квантованный тайл int16 (256×256). Зеркало src/core/dem.ts."""
    raw = gzip.decompress(path.read_bytes())
    delta = np.frombuffer(raw, dtype="<i2").reshape(SIZE, SIZE).astype(np.int32)
    tile = np.cumsum(delta, axis=1)
    return tile.astype("<i2")  # переполнение int16 снимается симметрично


# ────────────────────────────── предикторы ──────────────────────────────

def delta_x(tile: np.ndarray) -> np.ndarray:
    t = tile.astype(np.int32)
    zeros = np.zeros((SIZE, 1), dtype=np.int32)
    return np.diff(t, axis=1, prepend=zeros).astype("<i2")


def paeth_residuals(tile: np.ndarray) -> np.ndarray:
    """Остатки Paeth (как в PNG), хранятся mod 2^16 — декодирование обратимо."""
    t = tile.astype(np.int32)
    res = np.empty_like(t)
    res[0, 0] = t[0, 0]
    res[0, 1:] = t[0, 1:] - t[0, :-1]
    res[1:, 0] = t[1:, 0] - t[:-1, 0]
    a = t[1:, :-1]
    b = t[:-1, 1:]
    c = t[:-1, :-1]
    p = a + b - c
    pa, pb, pc = np.abs(p - a), np.abs(p - b), np.abs(p - c)
    pred = np.where((pa <= pb) & (pa <= pc), a, np.where(pb <= pc, b, c))
    res[1:, 1:] = t[1:, 1:] - pred
    return res.astype("<i2")


# ────────────────────────────── кодеки ──────────────────────────────

def enc_delta_gzip(tile: np.ndarray) -> int:
    d = delta_x(tile).tobytes()
    c = zlib.compressobj(9, zlib.DEFLATED, 31)
    return len(c.compress(d) + c.flush())


def enc_paeth_gzip(tile: np.ndarray) -> int:
    d = paeth_residuals(tile).tobytes()
    c = zlib.compressobj(9, zlib.DEFLATED, 31)
    return len(c.compress(d) + c.flush())


def enc_delta_zstd(tile: np.ndarray) -> int:
    d = delta_x(tile).tobytes()
    return len(zstandard.ZstdCompressor(level=19).compress(d))


def enc_png_i16(tile: np.ndarray) -> int:
    img = Image.fromarray(tile.astype(np.uint16), mode="I;16")
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=9)
    return buf.tell()


def enc_png_rgb(tile: np.ndarray) -> int:
    u = tile.astype(np.uint16)
    rgb = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    rgb[:, :, 0] = (u >> 8).astype(np.uint8)
    rgb[:, :, 1] = (u & 0xFF).astype(np.uint8)
    img = Image.fromarray(rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=9)
    return buf.tell()


def rice_bits(res: np.ndarray) -> int:
    """Биты потока Rice: k на блок 16 строк, zigzag, escape q>47 → 49+20 бит."""
    zz = ((res << 1) ^ (res >> 31)).astype(np.int64)
    total = 0
    for r0 in range(0, SIZE, BLOCK_ROWS):
        block = zz[r0:r0 + BLOCK_ROWS].ravel()
        best = None
        for k in range(16):
            q = block >> k
            bits = np.where(q > 47, 69, q + 1 + k).sum()
            if best is None or bits < best:
                best = int(bits)
        total += best
    return 4 + (SIZE // BLOCK_ROWS) + (total + 7) // 8


def eg_bits(res: np.ndarray) -> int:
    """Биты потока Exp-Golomb: 2·floor(log2(zz+1))+1 на значение, без k."""
    zz = ((res << 1) ^ (res >> 31)).astype(np.int64) + 1
    bits = (2 * np.floor(np.log2(zz)) + 1).sum()
    return 4 + (int(bits) + 7) // 8


def enc_paeth_rice(tile: np.ndarray) -> int:
    return rice_bits(paeth_residuals(tile).astype(np.int32))


def enc_paeth_eg(tile: np.ndarray) -> int:
    return eg_bits(paeth_residuals(tile).astype(np.int32))


def fit_plane(tile: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """LSQ-плоскость z = a·x + b·y + c. Возвращает (предсказание, остаток)."""
    t = tile.astype(np.float64)
    xs, ys = np.meshgrid(np.arange(SIZE, dtype=np.float64),
                         np.arange(SIZE, dtype=np.float64))
    a_mat = np.array([
        [(xs * xs).sum(), (xs * ys).sum(), xs.sum()],
        [(xs * ys).sum(), (ys * ys).sum(), ys.sum()],
        [xs.sum(), ys.sum(), float(SIZE * SIZE)],
    ])
    b_vec = np.array([(xs * t).sum(), (ys * t).sum(), t.sum()])
    a, b, c = np.linalg.solve(a_mat, b_vec)
    pred = a * xs + b * ys + c
    res = (tile.astype(np.int32) - np.rint(pred)).astype("<i2")
    return pred, res


def enc_plane_rice(tile: np.ndarray) -> int:
    _, res = fit_plane(tile)
    return 12 + rice_bits(paeth_residuals(res).astype(np.int32))  # 3×f32 заголовок


def upsample_point_grid(parent: np.ndarray, ratio: int) -> np.ndarray:
    """Билинейный апсемпл pixel-is-point сетки: родительские точки совпадают
    с чётными индексами ребёнка (ratio 2) или кратными ratio."""
    idx = np.arange(SIZE, dtype=np.float64) / ratio
    j0 = idx.astype(np.int64)
    t = idx - j0
    p = parent.astype(np.float64)
    cols = p[:, j0] * (1 - t) + p[:, j0 + 1] * t      # (256, 256) по колонкам
    rows = cols[j0] * (1 - t)[:, None] + cols[j0 + 1] * t[:, None]
    return rows


def enc_crosslod_rice(tile: np.ndarray, parent: np.ndarray | None,
                      quant_ratio: int) -> int:
    """Остаток от билинейного апсемпла родителя → Paeth + Rice.
    quant_ratio = квант_родителя / квант_ребёнка (единицы → единицы ребёнка)."""
    if parent is None:
        return enc_paeth_rice(tile)  # дыра в разреженной пирамиде — как обычно
    up = np.rint(upsample_point_grid(parent, 2) * quant_ratio)
    res = (tile.astype(np.int32) - up).astype("<i2")
    return rice_bits(paeth_residuals(res.astype(np.int32)).astype(np.int32))


CODECS = [
    ("delta-x+gzip9 (база)", enc_delta_gzip),
    ("paeth+gzip9", enc_paeth_gzip),
    ("PNG I;16", enc_png_i16),
    ("PNG RGB 2×8bit", enc_png_rgb),
    ("Paeth+Rice (свой)", enc_paeth_rice),
    ("Paeth+ExpGolomb", enc_paeth_eg),
    ("plane+Paeth+Rice", enc_plane_rice),
    ("delta-x+zstd19", enc_delta_zstd),
]

# Родительский уровень для кросс-LOD-предиктора и отношение квантов
CROSS_PARENT = {0: (1, 2), 1: (2, 2)}  # lod → (parent_lod, quant_ratio)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tiles", type=int, default=250, help="тайлов на уровень")
    args = ap.parse_args()

    rng = random.Random(42)
    grand: dict[str, list[int]] = {}

    for lod in (0, 1, 2):
        files = sorted(DEM_ROOT.glob(f"{lod}/**/*.bin.gz"))
        sample = rng.sample(files, min(args.tiles, len(files)))
        sums = {name: 0 for name, _ in CODECS}
        cross_sum, cross_missing, actual = 0, 0, 0
        parent_cfg = CROSS_PARENT.get(lod)
        for f in sample:
            tile = decode_tile(f)
            actual += f.stat().st_size
            for name, fn in CODECS:
                sums[name] += fn(tile)
            if parent_cfg:
                plod, qratio = parent_cfg
                # тайл (x, y) ложится на родителя (x/r, y/r): r = 2^(plod-lod)... 
                # сетки 0.5°/1°/4° → шаг индексов 2 и 4
                step = {0: 2, 1: 4}[lod]
                ppath = DEM_ROOT / str(plod) / str(int(f.parent.name) // step) / \
                    f"{int(f.stem.split('.')[0]) // step}.bin.gz"
                parent = decode_tile(ppath) if ppath.exists() else None
                if parent is None:
                    cross_missing += 1
                cross_sum += enc_crosslod_rice(tile, parent, qratio)
        base = sums[CODECS[0][0]]
        print(f"\nLOD {lod}: {len(sample)} тайлов (всего на диске {len(files)})")
        print(f"  {'фактический размер .bin.gz':34s} {actual / len(sample):8.1f} Б  (контроль)")
        for name, _ in CODECS:
            avg = sums[name] / len(sample)
            print(f"  {name:34s} {avg:8.1f} Б  {sums[name] / base:6.3f}× от базы")
        if parent_cfg:
            print(f"  {'cross-LOD+Paeth+Rice':34s} {cross_sum / len(sample):8.1f} Б  "
                  f"{cross_sum / base:6.3f}× от базы  (родителя нет у {cross_missing})")
        for name, val in sums.items():
            grand.setdefault(name, []).append(val)

    print("\nИТОГО (сумма средних по LOD — пропорционально вкладу уровней в объём):")
    names = [n for n, _ in CODECS]
    base_total = sum(grand[names[0]][i] for i in range(3))
    for name in names:
        tot = sum(grand[name][i] for i in range(3))
        print(f"  {name:34s} {tot / base_total:6.3f}× от базы")


if __name__ == "__main__":
    main()
