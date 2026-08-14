#!/usr/bin/env python3
"""
Иконки PWA: контуры гор в стиле панорамы приложения.

Как на экране приложения: градиентное небо и двойные контуры гребней —
тёмная полоска сверху, белая снизу. Кружок на гребне — маркер вершины,
такой же, как метка пика на панораме.

    python tools/icons/make_icons.py
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("Нужен Pillow: pip install pillow")

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

#: Цвета согласованы с index.html и panorama.ts
SKY_TOP = (13, 27, 42)
SKY_BOTTOM = (74, 96, 142)
INK_DARK = (20, 28, 44)
INK_LIGHT = (245, 248, 255)

OUT_DIR = Path("public/icons")

#: Профили гребней в долях стороны; главная вершина — дальний пик на x=0.36
FAR_RIDGE = [
    (0.00, 0.560), (0.10, 0.475), (0.20, 0.525), (0.36, 0.235),
    (0.47, 0.440), (0.59, 0.345), (0.73, 0.480), (0.85, 0.410), (1.00, 0.520),
]
NEAR_RIDGE = [
    (0.00, 0.850), (0.14, 0.755), (0.30, 0.820), (0.48, 0.650),
    (0.63, 0.775), (0.79, 0.700), (1.00, 0.830),
]


def draw_icon(size: int, padding: float) -> Image.Image:
    """Иконка size×size. padding — поле под safe zone (для maskable шире)."""
    # Рисуем с четырёхкратным запасом и уменьшаем: дешёвое сглаживание
    ss = 4
    side = size * ss
    img = Image.new("RGB", (side, side), SKY_TOP)
    draw = ImageDraw.Draw(img)

    # Небо: вертикальный градиент, как в панораме
    for y in range(side):
        t = y / max(1, side - 1)
        draw.line(
            [(0, y), (side, y)],
            fill=tuple(round(a + (b - a) * t) for a, b in zip(SKY_TOP, SKY_BOTTOM)),
        )

    inner = 1 - 2 * padding
    origin = side * padding
    span = side * inner

    def pt(x: float, y: float) -> tuple[float, float]:
        return (origin + x * span, origin + y * span)

    line_w = max(2, round(span * 0.028))

    def ridge(points: list[tuple[float, float]]) -> None:
        pts = [pt(x, y) for x, y in points]
        # Продлеваем гребень до краёв холста, сохраняя наклон крайних сегментов
        (x0, y0), (x1, y1) = pts[0], pts[1]
        left_y = y0 - (y1 - y0) / (x1 - x0) * x0
        (x0, y0), (x1, y1) = pts[-2], pts[-1]
        right_y = y1 + (y1 - y0) / (x1 - x0) * (side - x1)
        pts = [(0, left_y)] + pts + [(side, right_y)]
        # Двойная полоска как в панораме: тёмная сверху, белая снизу
        half = line_w / 2
        draw.line([(x, y - half) for x, y in pts], fill=INK_DARK, width=line_w, joint="curve")
        draw.line([(x, y + half) for x, y in pts], fill=INK_LIGHT, width=line_w, joint="curve")

    ridge(FAR_RIDGE)
    ridge(NEAR_RIDGE)

    # Маркер вершины сидит прямо на гребне, как метка пика на панораме
    peak_x, peak_y = pt(0.36, 0.235)
    r = span * 0.045
    draw.ellipse(
        [peak_x - r, peak_y - r, peak_x + r, peak_y + r],
        fill=INK_LIGHT,
        outline=INK_DARK,
        width=max(2, round(r * 0.45)),
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    made: list[Path] = []

    # Обычные иконки — почти во весь размер
    for size in (192, 512):
        path = OUT_DIR / f"icon-{size}.png"
        draw_icon(size, padding=0.06).save(path, optimize=True)
        made.append(path)

    # Maskable: система обрезает до ~80%, поэтому поля шире
    for size in (192, 512):
        path = OUT_DIR / f"maskable-{size}.png"
        draw_icon(size, padding=0.18).save(path, optimize=True)
        made.append(path)

    # Apple touch icon: iOS не понимает maskable и не любит прозрачность
    apple = OUT_DIR / "apple-touch-icon.png"
    draw_icon(180, padding=0.08).save(apple, optimize=True)
    made.append(apple)

    favicon = OUT_DIR.parent / "favicon.png"
    draw_icon(64, padding=0.04).save(favicon, optimize=True)
    made.append(favicon)

    for p in made:
        print(f"  {p} — {p.stat().st_size // 1024} КБ")
    print(f"OK: {len(made)} файлов")


if __name__ == "__main__":
    main()
