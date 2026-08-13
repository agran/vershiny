#!/usr/bin/env python3
"""
Иконки PWA: силуэт гор в стиле панорамы приложения.

Рисуем те же двойные контуры (тёмный сверху, светлый снизу) на фоне ночного
неба — иконка на домашнем экране должна узнаваться как та же программа.

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

#: Цвета из index.html и panorama.ts
SKY_TOP = (13, 27, 42)
SKY_BOTTOM = (58, 74, 104)
INK_LIGHT = (255, 255, 255)
INK_DARK = (0, 0, 0)

OUT_DIR = Path("public/icons")

#: Профили силуэта в долях стороны: дальний гребень и ближний склон
FAR_RIDGE = [
    (0.00, 0.70), (0.14, 0.60), (0.26, 0.66), (0.40, 0.44),
    (0.52, 0.58), (0.64, 0.50), (0.78, 0.62), (0.90, 0.56), (1.00, 0.61),
]
NEAR_RIDGE = [
    (0.00, 0.92), (0.18, 0.84), (0.34, 0.88), (0.50, 0.74),
    (0.66, 0.86), (0.82, 0.80), (1.00, 0.89),
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

    line_w = max(2, round(side * 0.035))
    offset = line_w * 0.55
    for points in (FAR_RIDGE, NEAR_RIDGE):
        pts = [(origin + x * span, origin + y * span) for x, y in points]
        draw.line([(x, y - offset) for x, y in pts], fill=INK_DARK, width=line_w, joint="curve")
        draw.line([(x, y + offset) for x, y in pts], fill=INK_LIGHT, width=line_w, joint="curve")

    # Маркер вершины — как у видимых пиков на панораме
    peak_x = origin + 0.40 * span
    peak_y = origin + 0.44 * span
    r = line_w * 1.7
    draw.ellipse([peak_x - r, peak_y - r, peak_x + r, peak_y + r], fill=INK_DARK)
    r *= 0.55
    draw.ellipse([peak_x - r, peak_y - r, peak_x + r, peak_y + r], fill=INK_LIGHT)

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
