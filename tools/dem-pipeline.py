#!/usr/bin/env python3
"""
dem-pipeline: одна команда — оба репо DEM-тайлов (base + hi).

1. scan: статистика исходников (кешируется)
2. base: vershiny-dem — глобальная пирамида 217 м (вся суша)
3. hi: vershiny-dem-hi — детальный слой 87 м (p1–p3 целиком + верхушки p4)

Использование:
    python tools/dem-pipeline.py
    python tools/dem-pipeline.py --dry-run  # показать команды
"""

from __future__ import annotations

import argparse
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
        description="Полная регенерация обоих DEM-репо из GLO-90"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Показать команды, не выполнять"
    )
    parser.add_argument(
        "--skip-scan", action="store_true", help="Пропустить scan (кеш уже есть)"
    )
    parser.add_argument(
        "--skip-base", action="store_true", help="Пропустить base (vershiny-dem)"
    )
    parser.add_argument(
        "--skip-hi", action="store_true", help="Пропустить hi (vershiny-dem-hi)"
    )
    args = parser.parse_args()

    src = ROOT / "dem" / "glo-90"
    if not src.exists():
        sys.exit(f"Исходники не найдены: {src}")

    # Шаг 1: scan (кеш статистики)
    if not args.skip_scan:
        ok = run(
            [
                sys.executable,
                "tools/glo90-to-tiles/glo90_to_tiles.py",
                "scan",
                "--src",
                str(src),
            ],
            "Статистика исходников GLO-90",
            args.dry_run,
        )
        if not ok:
            sys.exit(1)

    # Шаг 2: base (vershiny-dem) — глобальная пирамида
    if not args.skip_base:
        ok = run(
            [
                sys.executable,
                "tools/glo90-to-tiles/glo90_to_tiles.py",
                "build",
                "--src",
                str(src),
                "--budget-mb",
                "1050",
                "--levels",
                "512:2:400:0.60,256:4:150:0.30,64:8:0:-",
                "-o",
                str(ROOT.parent / "vershiny-dem" / "tiles" / "global"),
                "--clean",
            ],
            "vershiny-dem: глобальная пирамида 217 м",
            args.dry_run,
        )
        if not ok:
            sys.exit(1)

    # Шаг 3: hi (vershiny-dem-hi) — детальный слой 87 м: p1–p3 целиком,
    # остаток бюджета съедают самые горные ячейки p4 (сортировка по рельефу).
    # Доля 1.0 обязательна: «-» = inf, и --budget-mb не действовал бы вообще.
    # Запас до 1000 МБ — на штатный перелёт (бюджет проверяется после групп
    # в полёте, 3×workers).
    if not args.skip_hi:
        ok = run(
            [
                sys.executable,
                "tools/glo90-to-tiles/glo90_to_tiles.py",
                "build",
                "--src",
                str(src),
                "--budget-mb",
                "950",
                "--levels",
                "1280:2:100:1.0",
                "--only-priority",
                "1,2,3,4",
                "-o",
                str(ROOT.parent / "vershiny-dem-hi" / "tiles" / "hi"),
                "--clean",
            ],
            "vershiny-dem-hi: детальный слой 87 м (p1–p3 + верхушки p4)",
            args.dry_run,
        )
        if not ok:
            sys.exit(1)

    print("\n✓ Оба репо сгенерированы.")
    print(f"  base: {ROOT.parent / 'vershiny-dem' / 'tiles' / 'global'}")
    print(f"  hi:   {ROOT.parent / 'vershiny-dem-hi' / 'tiles' / 'hi'}")


if __name__ == "__main__":
    main()
