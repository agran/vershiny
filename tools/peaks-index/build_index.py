#!/usr/bin/env python3
"""
peaks-index: public/peaks/*.json → компактный индекс поиска по всей планете.

Зачем: поиск вершины работал только по текущему и скачанным регионам —
Казбек или Монблан из Приэльбрусья не находились вовсе. Качать ради поиска
все 115 регионов (58 МБ) нельзя, поэтому кладём рядом один небольшой файл
с самыми значимыми вершинами каждого региона.

Отбор — той же эвристикой, что и приоритет подписей (docs/ALGORITHMS.md §5):
    score = ele × вес(изоляция)
Изоляция (расстояние до ближайшей более высокой вершины) поднимает одиноко
стоящие горы и топит побочные пики: без неё в индекс из Альп попадали бы
двести жандармов одного массива вместо двухсот разных гор.

Формат (компактный, поля позиционные):
    {"generated": "...", "peaks": [[name, lat, lon, ele, region, name_en?, name_ru?], ...]}
Необязательные хвостовые поля добавляются, только если отличаются от name;
если name_ru есть, а name_en нет, на месте name_en остаётся пустая строка.

Использование:
    python tools/peaks-index/build_index.py
    python tools/peaks-index/build_index.py --per-region 250 -o public/peaks/_index.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

# Консоль Windows (cp1251) не выводит Unicode
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

#: Параметры изоляции — те же, что в src/core/peaks.ts
ISO_CELL_M = 5_000
ISO_LIMIT_M = 36_000
ISO_DOMINANT_M = 30_000
ISO_SUBORDINATE_M = 300
ISO_MIN_WEIGHT = 0.55


def isolation(peaks: list[dict]) -> list[float]:
    """Расстояние до ближайшей более высокой вершины, м (поиск по сетке)."""
    if not peaks:
        return []
    lat0 = sum(p["lat"] for p in peaks) / len(peaks)
    kx = 111_320 * math.cos(math.radians(lat0))
    xs = [p["lon"] * kx for p in peaks]
    ys = [p["lat"] * 111_320 for p in peaks]
    order = sorted(range(len(peaks)), key=lambda i: -(peaks[i].get("ele") or 0))

    grid: dict[tuple[int, int], list[int]] = {}
    iso = [float(ISO_LIMIT_M)] * len(peaks)
    max_ring = int(ISO_LIMIT_M / ISO_CELL_M) + 1

    for i in order:
        gx, gy = int(xs[i] // ISO_CELL_M), int(ys[i] // ISO_CELL_M)
        best2 = math.inf
        for r in range(max_ring + 1):
            reach = max(0, r - 1) * ISO_CELL_M
            if r > 0 and reach * reach > min(best2, ISO_LIMIT_M**2):
                break
            for cx in range(gx - r, gx + r + 1):
                for cy in range(gy - r, gy + r + 1):
                    if max(abs(cx - gx), abs(cy - gy)) != r:
                        continue
                    for j in grid.get((cx, cy), ()):
                        d2 = (xs[j] - xs[i]) ** 2 + (ys[j] - ys[i]) ** 2
                        if d2 < best2:
                            best2 = d2
        iso[i] = ISO_LIMIT_M if best2 == math.inf else min(math.sqrt(best2), ISO_LIMIT_M)
        grid.setdefault((gx, gy), []).append(i)
    return iso


def isolation_weight(iso_m: float) -> float:
    """0.55 у побочной вершины в группе → 1.0 у самостоятельной горы."""
    if iso_m <= ISO_SUBORDINATE_M:
        return ISO_MIN_WEIGHT
    t = min(
        1.0,
        math.log(iso_m / ISO_SUBORDINATE_M) / math.log(ISO_DOMINANT_M / ISO_SUBORDINATE_M),
    )
    return ISO_MIN_WEIGHT + (1 - ISO_MIN_WEIGHT) * t


def main() -> None:
    parser = argparse.ArgumentParser(description="Индекс поиска вершин по всем регионам")
    parser.add_argument(
        "--peaks-dir", type=Path, default=Path("public/peaks"), help="Каталог peaks/*.json"
    )
    parser.add_argument(
        "--per-region", type=int, default=250, help="Сколько вершин брать из региона"
    )
    parser.add_argument(
        "-o", "--out", type=Path, help="Файл индекса (по умолчанию peaks/_index.json)"
    )
    parser.add_argument("--quiet", action="store_true", help="Без построчного отчёта")
    args = parser.parse_args()

    out = args.out or args.peaks_dir / "_index.json"
    files = sorted(p for p in args.peaks_dir.glob("*.json") if not p.name.startswith("_"))
    if not files:
        sys.exit(f"Не найдено peaks/*.json в {args.peaks_dir}")

    entries: list[list] = []
    total = 0
    for path in files:
        region = path.stem
        peaks = json.loads(path.read_text(encoding="utf-8")).get("peaks", [])
        total += len(peaks)
        if not peaks:
            continue
        iso = isolation(peaks)
        ranked = sorted(
            range(len(peaks)),
            key=lambda i: -((peaks[i].get("ele") or 0) * isolation_weight(iso[i])),
        )
        taken = 0
        for i in ranked[: args.per_region]:
            p = peaks[i]
            if not p.get("name"):
                continue
            entry = [p["name"], round(p["lat"], 5), round(p["lon"], 5), p.get("ele"), region]
            # Иные написания — только если отличаются: индекс должен остаться
            # лёгким. Без name_ru не находились «Джомолунгма», «Денали»,
            # «Маттерхорн»: в OSM их `name` — на местном языке.
            name_en = p.get("name_en")
            name_ru = p.get("name_ru")
            if name_ru == p["name"]:
                name_ru = None
            if name_en == p["name"]:
                name_en = None
            if name_en or name_ru:
                entry.append(name_en or "")
            if name_ru:
                entry.append(name_ru)
            entries.append(entry)
            taken += 1
        if not args.quiet:
            print(f"  {region:26} {len(peaks):6} вершин → {taken}")

    index = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "peaks": entries,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(index, ensure_ascii=False, separators=(",", ":"))
    out.write_text(blob, encoding="utf-8")
    print(
        f"\nOK: {len(entries)} вершин из {total} ({len(files)} регионов) → {out}"
        f" ({len(blob.encode()) / 1e6:.2f} МБ)"
    )


if __name__ == "__main__":
    main()
