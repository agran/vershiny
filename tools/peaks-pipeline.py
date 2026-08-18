#!/usr/bin/env python3
"""
peaks-pipeline: один запуск — полная регенерация данных вершин из planet.osm.pbf.

1. planet_peaks.py: planet.osm.pbf → peaks-planet.jsonl + peaks-by-region/*.jsonl
2. peaks_to_json.py: peaks-by-region/*.jsonl → public/peaks/*.json
3. build_index.py: public/peaks/*.json → public/peaks/_index.json

Использование:
    python tools/peaks-pipeline.py planet-260818.osm.pbf
    python tools/peaks-pipeline.py planet-260818.osm.pbf --dry-run  # показать команды
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

# Консоль Windows (cp1251) не выводит Unicode
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent.parent


def run(cmd: list[str], desc: str, dry_run: bool = False) -> bool:
    """Запуск команды с таймером. Возвращает False при ошибке."""
    print(f"\n{'[dry-run] ' if dry_run else ''}▶ {desc}")
    print(f"  {' '.join(cmd)}")
    if dry_run:
        return True
    t0 = time.time()
    result = subprocess.run(cmd, cwd=ROOT)
    elapsed = time.time() - t0
    if result.returncode != 0:
        print(f"✗ {desc}: код {result.returncode} ({elapsed:.0f} с)")
        return False
    print(f"✓ {desc} ({elapsed:.0f} с)")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Полная регенерация данных вершин из planet.osm.pbf"
    )
    parser.add_argument("planet", type=Path, help="planet-*.osm.pbf")
    parser.add_argument(
        "--dry-run", action="store_true", help="Показать команды, не выполнять"
    )
    parser.add_argument(
        "--skip-planet", action="store_true", help="Пропустить шаг 1 (уже есть JSONL)"
    )
    args = parser.parse_args()

    if not args.planet.exists():
        sys.exit(f"Файл не найден: {args.planet}")

    planet_jsonl = ROOT / "data" / "peaks-planet.jsonl"
    regions_dir = ROOT / "data" / "peaks-by-region"
    peaks_dir = ROOT / "public" / "peaks"

    # Шаг 1: planet.osm.pbf → JSONL + разбивка по регионам
    if not args.skip_planet:
        ok = run(
            [
                sys.executable,
                "tools/planet-peaks/planet_peaks.py",
                str(args.planet),
                "-o",
                str(planet_jsonl),
                "--regions-dir",
                str(regions_dir),
            ],
            "planet.osm.pbf → JSONL + регионы",
            args.dry_run,
        )
        if not ok:
            sys.exit(1)
    else:
        print("▶ Шаг 1 пропущен (--skip-planet)")

    # Шаг 2: JSONL → public/peaks/*.json для каждого региона
    regions = json.loads((ROOT / "tools" / "regions.json").read_text(encoding="utf-8"))
    region_names = [
        name
        for name, entry in regions.items()
        if isinstance(entry, dict) and "bbox" in entry
    ]
    print(f"\n▶ Конвертация {len(region_names)} регионов в public/peaks/")

    failed = []
    for name in sorted(region_names):
        jsonl = regions_dir / f"{name}.jsonl"
        if not jsonl.exists():
            print(f"  ⚠ {name}: нет {jsonl.name}, пропускаю")
            continue
        out_json = peaks_dir / f"{name}.json"
        ok = run(
            [
                sys.executable,
                "tools/peaks-to-json/peaks_to_json.py",
                "--region",
                name,
                "--from-file",
                str(jsonl),
                "-o",
                str(out_json),
            ],
            f"peaks_to_json {name}",
            args.dry_run,
        )
        if not ok:
            failed.append(name)

    if failed:
        print(f"\n✗ Не удалось: {', '.join(failed)}")
        sys.exit(1)

    # Шаг 3: индекс поиска
    ok = run(
        [
            sys.executable,
            "tools/peaks-index/build_index.py",
            "--quiet",
        ],
        "Индекс поиска",
        args.dry_run,
    )
    if not ok:
        sys.exit(1)

    print("\n✓ Готово. Данные в public/peaks/ обновлены.")


if __name__ == "__main__":
    main()
