#!/usr/bin/env python3
"""
Иконки PWA: слоистый силуэт гор в стиле панорамы приложения.

Ночное небо с градиентом и звёздами, два залитых гребня со светлой кромкой
(отсылка к контурам панорамы) и маркер главной вершины.

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
SKY_TOP = (10, 20, 38)
SKY_BOTTOM = (74, 96, 142)
FAR_FILL = (52, 70, 104)
FAR_RIM = (168, 188, 220)
NEAR_FILL = (16, 26, 44)
NEAR_RIM = (245, 248, 255)
STAR = (214, 226, 246)

OUT_DIR = Path("public/icons")

#: Профили гребней в долях стороны; главная вершина — дальний пик на x=0.36
FAR_RIDGE = [
    (0.00, 0.660), (0.10, 0.575), (0.20, 0.625), (0.36, 0.315),
    (0.47, 0.520), (0.59, 0.415), (0.73, 0.560), (0.85, 0.480), (1.00, 0.600),
]
NEAR_RIDGE = [
    (0.00, 0.880), (0.14, 0.785), (0.30, 0.850), (0.48, 0.680),
    (0.63, 0.805), (0.79, 0.730), (1.00, 0.860),
]

#: Звёзды: (x, y, радиус в долях стороны)
STARS = [
    (0.14, 0.14, 0.010), (0.30, 0.09, 0.007), (0.52, 0.16, 0.009),
    (0.68, 0.08, 0.007), (0.84, 0.19, 0.010), (0.93, 0.10, 0.006),
    (0.07, 0.30, 0.006), (0.62, 0.26, 0.006),
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

    # Звёзды над гребнями
    for sx, sy, sr in STARS:
        x, y = pt(sx, sy)
        r = sr * span
        draw.ellipse([x - r, y - r, x + r, y + r], fill=STAR)

    rim_w = max(2, round(side * 0.016))

    def ridge(points: list[tuple[float, float]], fill, rim, rim_width: int) -> None:
        pts = [pt(x, y) for x, y in points]
        # Продлеваем гребень до краёв холста, сохраняя наклон крайних сегментов
        (x0, y0), (x1, y1) = pts[0], pts[1]
        left_y = y0 - (y1 - y0) / (x1 - x0) * x0
        (x0, y0), (x1, y1) = pts[-2], pts[-1]
        right_y = y1 + (y1 - y0) / (x1 - x0) * (side - x1)
        pts = [(0, left_y)] + pts + [(side, right_y)]
        draw.polygon(pts + [(side, side), (0, side)], fill=fill)
        draw.line(pts, fill=rim, width=rim_width, joint="curve")

    ridge(FAR_RIDGE, FAR_FILL, FAR_RIM, rim_w)
    ridge(NEAR_RIDGE, NEAR_FILL, NEAR_RIM, round(rim_w * 1.25))

    # Маркер главной вершины — как у пиков на панораме
    peak_x, peak_y = pt(0.36, 0.315)
    peak_y -= span * 0.075
    r = span * 0.042
    draw.ellipse(
        [peak_x - r, peak_y - r, peak_x + r, peak_y + r],
        fill=NEAR_RIM,
        outline=NEAR_FILL,
        width=max(2, round(r * 0.42)),
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
