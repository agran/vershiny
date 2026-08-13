#!/usr/bin/env python3
"""
peaks-to-json: Overpass API → peaks/{region}.json (прекомпиляция, ROADMAP 1.2).

Приложение НЕ ходит в Overpass в рантайме — этот скрипт запускается офлайн
(или ежемесячным GitHub Action) и кладёт компактный JSON в public/peaks/.

Поля: name (name:ru → name → name:en), ele, lat/lon, wikidata.
prominence в OSM почти не заполнен — не используем (ALGORITHMS.md).

Использование:
  python peaks_to_json.py --region elbrus --bbox 42.0,42.8,44.5,43.9 -o out/elbrus.json
  # bbox: minLon,minLat,maxLon,maxLat
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Консоль Windows (cp1251) не выводит Unicode из help/сообщений
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Вулканы в OSM — natural=volcano, не peak: без них нет Эльбруса, Казбека,
# Фудзи, Килиманджаро, Демавенда и целых регионов реестра (Камчатка, Эквадор)
QUERY_TEMPLATE = """
[out:json][timeout:120];
(
  node["natural"="peak"]({min_lat},{min_lon},{max_lat},{max_lon});
  node["natural"="volcano"]({min_lat},{min_lon},{max_lat},{max_lon});
);
out body;
"""


def split_bbox(
    bbox: tuple[float, float, float, float],
) -> list[tuple[float, float, float, float]]:
    """bbox через антимеридиан → два обычных bbox.

    У Врангеля границы 177.5…−177.5: для Overpass (и для любого сравнения
    min <= lon <= max) такой диапазон пуст, и регион приезжал без единой
    вершины. Режем его по 180° меридиану на две части.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    if min_lon <= max_lon:
        return [bbox]
    return [
        (min_lon, min_lat, 180.0, max_lat),
        (-180.0, min_lat, max_lon, max_lat),
    ]


def in_bbox(lat: float, lon: float, bbox: tuple[float, float, float, float]) -> bool:
    """Точка внутри bbox, с учётом перехода через антимеридиан."""
    min_lon, min_lat, max_lon, max_lat = bbox
    lon_ok = min_lon <= lon <= max_lon if min_lon <= max_lon else (lon >= min_lon or lon <= max_lon)
    return lon_ok and min_lat <= lat <= max_lat


def fetch_peaks(bbox: tuple[float, float, float, float], retries: int = 3) -> list[dict]:
    elements: list[dict] = []
    for part in split_bbox(bbox):
        elements.extend(fetch_peaks_part(part, retries))
    return elements


def fetch_peaks_part(bbox: tuple[float, float, float, float], retries: int = 3) -> list[dict]:
    min_lon, min_lat, max_lon, max_lat = bbox
    query = QUERY_TEMPLATE.format(
        min_lat=min_lat, min_lon=min_lon, max_lat=max_lat, max_lon=max_lon
    )
    data = f"data={urllib.parse.quote(query)}".encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                OVERPASS_URL,
                data=data,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "vershiny-peaks-to-json/0.1 (github.com/agran/vershiny)",
                },
            )
            with urllib.request.urlopen(req, timeout=180) as resp:
                payload = json.loads(resp.read())
            return payload.get("elements", [])
        except Exception as exc:  # noqa: BLE001 — сетевые ошибки разнообразны
            print(f"Overpass попытка {attempt + 1}/{retries}: {exc}", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    sys.exit("Overpass не ответил — попробуйте позже или другой инстанс")


def pick_name(tags: dict) -> str | None:
    return tags.get("name:ru") or tags.get("name") or tags.get("name:en")


def parse_ele(raw: str | None) -> float | None:
    if not raw:
        return None
    # В OSM встречается "5642", "5642 m", "5,642" (запятая как разделитель)
    cleaned = raw.replace(",", "").replace("m", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def convert(elements: list[dict]) -> tuple[list[dict], dict]:
    peaks: list[dict] = []
    stats = {"total": len(elements), "no_name": 0, "no_ele": 0}
    for el in elements:
        tags = el.get("tags", {})
        name = pick_name(tags)
        if not name:
            stats["no_name"] += 1
            continue
        ele = parse_ele(tags.get("ele"))
        if ele is None:
            stats["no_ele"] += 1
        peak: dict = {"lat": el["lat"], "lon": el["lon"], "name": name}
        if tags.get("name:ru"):
            peak["name_ru"] = tags["name:ru"]
        if tags.get("name:en"):
            peak["name_en"] = tags["name:en"]
        if ele is not None:
            peak["ele"] = round(ele)
        if tags.get("wikidata"):
            peak["wikidata"] = tags["wikidata"]
        if tags.get("natural") == "volcano":
            peak["volcano"] = True
        peaks.append(peak)
    return peaks, stats


def convert_jsonl(path: Path) -> tuple[list[dict], dict]:
    """Чтение JSONL от planet_peaks.py вместо Overpass."""
    peaks: list[dict] = []
    stats = {"total": 0, "no_name": 0, "no_ele": 0}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        p = json.loads(line)
        stats["total"] += 1
        if not p.get("name"):
            stats["no_name"] += 1
            continue
        if p.get("ele") is None:
            stats["no_ele"] += 1
        peaks.append(
            {
                "lat": p["lat"],
                "lon": p["lon"],
                "name": p["name"],
                **({"name_ru": p["name_ru"]} if p.get("name_ru") else {}),
                **({"name_en": p["name_en"]} if p.get("name_en") else {}),
                **({"ele": p["ele"]} if p.get("ele") is not None else {}),
                **({"wikidata": p["wikidata"]} if p.get("wikidata") else {}),
                **({"volcano": True} if p.get("volcano") else {}),
            }
        )
    return peaks, stats


def load_region_bbox(region: str) -> tuple[float, float, float, float] | None:
    """bbox региона из tools/regions.json (единый реестр)."""
    registry = Path(__file__).parent.parent / "regions.json"
    if not registry.exists():
        return None
    data = json.loads(registry.read_text(encoding="utf-8"))
    entry = data.get(region)
    if not isinstance(entry, dict) or "bbox" not in entry:
        return None
    return tuple(entry["bbox"])  # type: ignore[return-value]


def main() -> None:
    parser = argparse.ArgumentParser(description="Overpass/JSONL → peaks/{region}.json")
    parser.add_argument("--region", required=True, help="Имя региона (elbrus, altai, …)")
    parser.add_argument(
        "--bbox",
        help="minLon,minLat,maxLon,maxLat — переопределить bbox из regions.json",
    )
    parser.add_argument(
        "--from-file",
        type=Path,
        help="JSONL от planet_peaks.py вместо запроса к Overpass",
    )
    parser.add_argument("-o", "--out", type=Path, required=True)
    args = parser.parse_args()

    # bbox: явный --bbox > regions.json
    bbox = None
    if args.bbox:
        bbox = tuple(float(x) for x in args.bbox.split(","))
        if len(bbox) != 4:
            sys.exit("bbox: minLon,minLat,maxLon,maxLat")
    else:
        bbox = load_region_bbox(args.region)

    if args.from_file:
        # JSONL уже может быть отфильтрован; режем по bbox, если он известен
        peaks, stats = convert_jsonl(args.from_file)
        if bbox:
            peaks = [p for p in peaks if in_bbox(p["lat"], p["lon"], bbox)]
    else:
        if not bbox:
            sys.exit(
                f"Неизвестный регион «{args.region}»: добавьте в tools/regions.json "
                "или передайте --bbox"
            )
        elements = fetch_peaks(bbox)
        peaks, stats = convert(elements)

    out = {
        "region": args.region,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "peaks": sorted(peaks, key=lambda p: -(p.get("ele") or 0)),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    pct_no_ele = 100 * stats["no_ele"] / max(stats["total"], 1)
    print(
        f"OK: {len(peaks)} вершин → {args.out}\n"
        f"  всего записей: {stats['total']}, без имени (пропущены): {stats['no_name']}, "
        f"без ele: {stats['no_ele']} ({pct_no_ele:.0f}%)"
    )


if __name__ == "__main__":
    main()
