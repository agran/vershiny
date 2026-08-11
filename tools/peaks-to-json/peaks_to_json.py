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

QUERY_TEMPLATE = """
[out:json][timeout:120];
node["natural"="peak"]({min_lat},{min_lon},{max_lat},{max_lon});
out body;
"""


def fetch_peaks(bbox: tuple[float, float, float, float], retries: int = 3) -> list[dict]:
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
        if ele is not None:
            peak["ele"] = round(ele)
        if tags.get("wikidata"):
            peak["wikidata"] = tags["wikidata"]
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
                **({"ele": p["ele"]} if p.get("ele") is not None else {}),
                **({"wikidata": p["wikidata"]} if p.get("wikidata") else {}),
            }
        )
    return peaks, stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Overpass/JSONL → peaks/{region}.json")
    parser.add_argument("--region", required=True, help="Имя региона (elbrus, altai, …)")
    parser.add_argument(
        "--bbox",
        help="minLon,minLat,maxLon,maxLat — с запасом 200 км за видимый край!",
    )
    parser.add_argument(
        "--from-file",
        type=Path,
        help="JSONL от planet_peaks.py вместо запроса к Overpass",
    )
    parser.add_argument("-o", "--out", type=Path, required=True)
    args = parser.parse_args()

    if args.from_file:
        peaks, stats = convert_jsonl(args.from_file)
    else:
        if not args.bbox:
            sys.exit("Нужен --bbox (или --from-file)")
        bbox = tuple(float(x) for x in args.bbox.split(","))
        if len(bbox) != 4:
            sys.exit("bbox: minLon,minLat,maxLon,maxLat")
        elements = fetch_peaks(bbox)  # type: ignore[arg-type]
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
