#!/usr/bin/env python3
"""
planet-peaks: потоковый фильтр planet.osm.pbf → вершины (natural=peak).

Читает формат OSM PBF напрямую (zlib-блоки), без внешних зависимостей:
только protobuf-парсер собственной реализации (~100 строк) — ради разового
прогона не тянем osmium/protobuf.

Выход: JSONL (одна вершина на строку), поля:
  lat, lon, name (name:ru → name → name:en), ele (float|None), wikidata

Опционально фильтрует по bbox, чтобы не писать миллионы строк:
  python planet_peaks.py planet-260803.osm.pbf -o peaks-planet.jsonl
  python planet_peaks.py planet-260803.osm.pbf --bbox 42.0,41.8,45.0,44.9 -o peaks-elbrus.jsonl

Скорость ориентировочно 30–90 мин на планету (зависит от диска/CPU).
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
import zlib
from pathlib import Path

# Консоль Windows (cp1251) не выводит Unicode из help/сообщений
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# Мини-парсер protobuf (только нужные wire types: varint, fixed64, LEN)
# ---------------------------------------------------------------------------


class PBReader:
    __slots__ = ("buf", "pos", "end")

    def __init__(self, buf: bytes, start: int = 0, end: int | None = None):
        self.buf = buf
        self.pos = start
        self.end = len(buf) if end is None else end

    def eof(self) -> bool:
        return self.pos >= self.end

    def varint(self) -> int:
        result = 0
        shift = 0
        while True:
            b = self.buf[self.pos]
            self.pos += 1
            result |= (b & 0x7F) << shift
            if not (b & 0x80):
                return result
            shift += 7

    def fixed64(self) -> int:
        v = struct.unpack_from("<Q", self.buf, self.pos)[0]
        self.pos += 8
        return v

    def tag(self) -> tuple[int, int]:
        v = self.varint()
        return v >> 3, v & 7

    def skip(self, wire: int) -> None:
        if wire == 0:
            self.varint()
        elif wire == 2:
            self.pos += self.varint()
        elif wire == 5:
            self.pos += 4
        elif wire == 1:
            self.pos += 8
        elif wire == 3:  # SGROUP (deprecated, group nesting)
            while True:
                _, w = self.tag()
                if w == 4:
                    break
                self.skip(w)
        else:
            raise ValueError(f"wire type {wire} at pos {self.pos}")

    def bytes(self) -> bytes:
        n = self.varint()
        out = self.buf[self.pos : self.pos + n]
        self.pos += n
        return out


def zigzag(v: int) -> int:
    return (v >> 1) ^ -(v & 1)


# ---------------------------------------------------------------------------
# PBF: HeaderBlock / PrimitiveBlock / PrimitiveGroup / Node / DenseNodes
# ---------------------------------------------------------------------------

GRANULARITY = 100  # дефолт; реальное значение читаем из блока


def read_blob_header(f) -> tuple[str, int] | None:
    raw_len = f.read(4)
    if len(raw_len) < 4:
        return None
    (header_len,) = struct.unpack(">I", raw_len)
    header = f.read(header_len)
    r = PBReader(header)
    blob_type = ""
    datasize = 0
    while not r.eof():
        field, wire = r.tag()
        if field == 1:  # type
            blob_type = r.bytes().decode()
        elif field == 3:  # datasize
            datasize = r.varint()
        else:
            r.skip(wire)
    return blob_type, datasize


def read_blob(f, datasize: int) -> bytes:
    raw = f.read(datasize)
    r = PBReader(raw)
    while not r.eof():
        field, wire = r.tag()
        if field == 1:  # raw
            return r.bytes()
        if field == 3:  # zlib_data
            return zlib.decompress(r.bytes())
        r.skip(wire)
    raise ValueError("blob без данных")


def parse_string_table(r: PBReader) -> list[bytes]:
    strings: list[bytes] = []
    while not r.eof():
        field, wire = r.tag()
        if field == 1:
            strings.append(r.bytes())
        else:
            r.skip(wire)
    return strings


def pick_name(tags: dict[str, str]) -> str | None:
    return tags.get("name:ru") or tags.get("name") or tags.get("name:en")


def parse_ele(raw: str | None) -> float | None:
    if not raw:
        return None
    cleaned = raw.replace(",", "").replace("m", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def emit_peak(
    out,
    lat: float,
    lon: float,
    tags: dict[str, str],
    bbox: tuple[float, float, float, float] | None,
    stats: dict,
) -> None:
    stats["peaks"] += 1
    if bbox:
        min_lon, min_lat, max_lon, max_lat = bbox
        if not (min_lon <= lon <= max_lon and min_lat <= lat <= max_lat):
            stats["outside"] += 1
            return
    name = pick_name(tags)
    if not name:
        stats["no_name"] += 1
        return
    peak: dict = {"lat": round(lat, 6), "lon": round(lon, 6), "name": name}
    ele = parse_ele(tags.get("ele"))
    if ele is not None:
        peak["ele"] = round(ele)
    else:
        stats["no_ele"] += 1
    if tags.get("wikidata"):
        peak["wikidata"] = tags["wikidata"]
    out.write(json.dumps(peak, ensure_ascii=False) + "\n")
    stats["written"] += 1


def parse_dense_nodes(
    data: bytes,
    strings: list[bytes],
    granularity: int,
    lat_offset: int,
    lon_offset: int,
    out,
    bbox,
    stats: dict,
) -> None:
    r = PBReader(data)
    ids: list[int] = []
    lats: list[int] = []
    lons: list[int] = []
    kvs: list[int] = []
    while not r.eof():
        field, wire = r.tag()
        if field == 1:  # id (packed sint64; поля могут повторяться — накапливаем!)
            if wire == 2:
                sub = PBReader(r.bytes())
                while not sub.eof():
                    ids.append(zigzag(sub.varint()))
            else:
                ids.append(zigzag(r.varint()))
        elif field == 5:  # DenseInfo — не нужен, пропускаем как bytes
            if wire == 2:
                r.bytes()
            else:
                r.skip(wire)
        elif field == 8:  # lat (packed sint64)
            if wire == 2:
                sub = PBReader(r.bytes())
                while not sub.eof():
                    lats.append(zigzag(sub.varint()))
            else:
                lats.append(zigzag(r.varint()))
        elif field == 9:  # lon (packed sint64)
            if wire == 2:
                sub = PBReader(r.bytes())
                while not sub.eof():
                    lons.append(zigzag(sub.varint()))
            else:
                lons.append(zigzag(r.varint()))
        elif field == 10:  # keys_vals (packed int32, 0 = разделитель)
            if wire == 2:
                sub = PBReader(r.bytes())
                while not sub.eof():
                    kvs.append(sub.varint())
            else:
                kvs.append(r.varint())
        else:
            r.skip(wire)

    lat_acc = 0
    lon_acc = 0
    kv_pos = 0
    for i in range(len(ids)):
        lat_acc += lats[i]
        lon_acc += lons[i]
        lat = (lat_offset + granularity * lat_acc) / 1e9
        lon = (lon_offset + granularity * lon_acc) / 1e9

        tags: dict[str, str] = {}
        while kv_pos < len(kvs) and kvs[kv_pos] != 0:
            k = strings[kvs[kv_pos]].decode("utf-8", "replace")
            v = strings[kvs[kv_pos + 1]].decode("utf-8", "replace")
            if k in ("natural", "name", "name:ru", "name:en", "ele", "wikidata"):
                tags[k] = v
            kv_pos += 2
        kv_pos += 1  # разделитель 0

        if tags.get("natural") == "peak":
            emit_peak(out, lat, lon, tags, bbox, stats)


def parse_node(
    data: bytes, strings: list[bytes], granularity: int, lat_offset: int, lon_offset: int,
    out, bbox, stats: dict,
) -> None:
    r = PBReader(data)
    lat = lon = 0
    keys: list[int] = []
    vals: list[int] = []
    while not r.eof():
        field, wire = r.tag()
        if field == 2:  # keys packed
            sub = PBReader(r.bytes())
            keys = []
            while not sub.eof():
                keys.append(sub.varint())
        elif field == 3:  # vals packed
            sub = PBReader(r.bytes())
            vals = []
            while not sub.eof():
                vals.append(sub.varint())
        elif field == 8:
            lat = zigzag(r.varint())
        elif field == 9:
            lon = zigzag(r.varint())
        else:
            r.skip(wire)
    tags = {
        strings[k].decode("utf-8", "replace"): strings[v].decode("utf-8", "replace")
        for k, v in zip(keys, vals)
        if strings[k].decode("utf-8", "replace")
        in ("natural", "name", "name:ru", "name:en", "ele", "wikidata")
    }
    if tags.get("natural") == "peak":
        emit_peak(
            out,
            (lat_offset + granularity * lat) / 1e9,
            (lon_offset + granularity * lon) / 1e9,
            tags,
            bbox,
            stats,
        )


def parse_primitive_block(
    data: bytes, out, bbox, stats: dict,
) -> None:
    r = PBReader(data)
    strings: list[bytes] = []
    granularity = GRANULARITY
    lat_offset = 0
    lon_offset = 0
    groups: list[bytes] = []
    while not r.eof():
        field, wire = r.tag()
        if field == 1:
            strings = parse_string_table(PBReader(r.bytes()))
        elif field == 2:
            groups.append(r.bytes())
        elif field == 17:
            granularity = r.varint()
        elif field == 19:
            lat_offset = r.fixed64()
        elif field == 20:
            lon_offset = r.fixed64()
        else:
            r.skip(wire)

    for group in groups:
        gr = PBReader(group)
        while not gr.eof():
            gfield, gwire = gr.tag()
            if gwire != 2:
                # В группах OSM PBF только LEN-поля; прочее — мусор/deprecated
                try:
                    gr.skip(gwire)
                except ValueError:
                    break
                continue
            if gfield == 1:  # nodes (редко в планете)
                parse_node(gr.bytes(), strings, granularity, lat_offset, lon_offset, out, bbox, stats)
            elif gfield == 2:  # dense
                data = gr.bytes()
                # Защита от битых/пустых dense (встречаются в планете)
                if len(data) >= 16:
                    parse_dense_nodes(
                        data, strings, granularity, lat_offset, lon_offset, out, bbox, stats
                    )
            else:  # ways (3), relations (4) и прочее — пропускаем
                gr.bytes()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="planet.osm.pbf → JSONL вершин (natural=peak)"
    )
    parser.add_argument("input", type=Path, help="planet-*.osm.pbf")
    parser.add_argument("-o", "--out", type=Path, required=True, help="JSONL на выход")
    parser.add_argument(
        "--bbox",
        help="minLon,minLat,maxLon,maxLat — фильтр по области (необязательно)",
    )
    args = parser.parse_args()

    bbox = None
    if args.bbox:
        bbox = tuple(float(x) for x in args.bbox.split(","))
        if len(bbox) != 4:
            sys.exit("bbox: minLon,minLat,maxLon,maxLat")

    stats = {"peaks": 0, "outside": 0, "no_name": 0, "no_ele": 0, "written": 0}
    t0 = time.time()
    blocks = 0
    file_size = args.input.stat().st_size

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.input.open("rb") as f, args.out.open("w", encoding="utf-8") as out:
        while True:
            header = read_blob_header(f)
            if header is None:
                break
            blob_type, datasize = header
            if blob_type == "OSMData":
                raw = read_blob(f, datasize)
                parse_primitive_block(raw, out, bbox, stats)
                blocks += 1
                if blocks % 50 == 0:
                    elapsed = time.time() - t0
                    pos = f.tell()
                    pct = 100 * pos / file_size
                    speed = pos / max(elapsed, 1) / 1e6
                    eta_min = (file_size - pos) / max(pos / elapsed, 1) / 60
                    print(
                        f"  {pct:5.1f}% | {blocks} блоков | "
                        f"{stats['peaks']} пиков, записано {stats['written']} | "
                        f"{speed:.1f} МБ/с | прошло {elapsed / 60:.1f} мин, "
                        f"осталось ~{eta_min:.1f} мин",
                        flush=True,
                    )
            else:  # OSMHeader — пропускаем
                f.seek(datasize, 1)

    elapsed = time.time() - t0
    print(
        f"OK: {stats['written']} вершин → {args.out} за {elapsed / 60:.1f} мин\n"
        f"  найдено natural=peak: {stats['peaks']}, вне bbox: {stats['outside']}, "
        f"без имени: {stats['no_name']}, без ele: {stats['no_ele']}"
    )


if __name__ == "__main__":
    main()
