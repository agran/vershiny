#!/usr/bin/env python3
"""WMM .COF → TS-таблица коэффициентов (src/core/wmm-coefficients.ts).

Генератор нужен раз в пять лет, когда выходит новая модель: скачать свежий
WMM.COF с NCEI (https://www.ncei.noaa.gov/products/world-magnetic-model)
и перегенерировать таблицу:

    python tools\\declination\\gen_wmm_coefficients.py tools\\declination\\WMM_2025.COF

Сам алгоритм (сферические гармоники) живёт в src/core/declination.ts — здесь
только данные: эпоха, порядок модели и строки [n, m, g, h, gt, ht] в нТ.
"""

import argparse
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "src" / "core" / "wmm-coefficients.ts"


def parse_cof(path: Path) -> tuple[float, str, list[tuple[int, int, float, float, float, float]]]:
    lines = path.read_text(encoding="ascii").splitlines()
    header = lines[0].split()
    if len(header) != 3:
        raise ValueError(f"битый заголовок: {lines[0]!r}")
    epoch = float(header[0])
    model = header[1]

    rows = []
    for line in lines[1:]:
        if line.startswith("9999"):
            break
        parts = line.split()
        if len(parts) != 6:
            raise ValueError(f"битая строка: {line!r}")
        n, m = int(parts[0]), int(parts[1])
        g, h, gt, ht = (float(p) for p in parts[2:])
        rows.append((n, m, g, h, gt, ht))

    if not rows:
        raise ValueError("коэффициентов нет")
    return epoch, model, rows


def fmt(x: float) -> str:
    """Компактно, но без потери точности: 0.0 → 0, -1410.8 → -1410.8"""
    return str(int(x)) if x == int(x) else repr(x)


def render(epoch: float, model: str, rows: list) -> str:
    maxord = max(n for n, _, *_ in rows)
    tuples = ",\n  ".join(
        f"[{n}, {m}, {fmt(g)}, {fmt(h)}, {fmt(gt)}, {fmt(ht)}]" for n, m, g, h, gt, ht in rows
    )
    return f"""/**
 * Коэффициенты World Magnetic Model {model} (эпоха {epoch}).
 *
 * СГЕНЕРИРОВАНО tools/declination/gen_wmm_coefficients.py — не править руками.
 * Источник: NOAA NCEI / BGS, WMM.COF (общественное достояние,
 * https://www.ncei.noaa.gov/products/world-magnetic-model).
 * Срок модели — 5 лет от эпохи; как перегенерировать — см. генератор.
 */

export const WMM_EPOCH = {epoch};
export const WMM_MODEL = "{model}";
export const WMM_MAXORD = {maxord};

/** Строки модели: [n, m, g, h, годовой дрейф gt, ht], нанотеслы */
export const WMM_ROWS: ReadonlyArray<
  readonly [number, number, number, number, number, number]
> = [
  {tuples},
];
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cof", type=Path, help="путь к WMM.COF")
    parser.add_argument("-o", "--out", type=Path, default=DEFAULT_OUT, help="куда писать TS")
    args = parser.parse_args()

    epoch, model, rows = parse_cof(args.cof)
    text = render(epoch, model, rows)
    args.out.write_text(text, encoding="utf-8", newline="\n")
    print(f"{model} (эпоха {epoch}): {len(rows)} строк -> {args.out}")


if __name__ == "__main__":
    main()
