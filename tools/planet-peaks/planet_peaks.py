#!/usr/bin/env python3
"""
planet-peaks: потоковый фильтр planet.osm.pbf → вершины
(natural=peak и natural=volcano).

Читает формат OSM PBF напрямую (zlib-блоки), без внешних зависимостей:
только protobuf-парсер собственной реализации (~100 строк) — ради разового
прогона не тянем osmium/protobuf.

Выход: JSONL (одна вершина на строку), поля:
  lat, lon, name (name:ru → name → name:en), ele (float|None), wikidata,
  volcano (True для natural=volcano)

Опционально фильтрует по bbox, чтобы не писать миллионы строк:
  python planet_peaks.py planet-260803.osm.pbf -o peaks-planet.jsonl
  python planet_peaks.py planet-260803.osm.pbf --bbox 42.0,41.8,45.0,44.9 -o peaks-elbrus.jsonl

Скорость ориентировочно 30–90 мин на планету (зависит от диска/CPU).
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import struct
import sys
import time
import zlib
from pathlib import Path

# Консоль Windows (cp1251) не выводит Unicode из help/сообщений
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

#: Теги вершин. Вулканы в OSM — отдельный тег: без него нет ни Эльбруса,
#: ни Казбека, ни Фудзи, ни Килиманджаро, ни Камчатки с Эквадором.
SUMMIT_TAGS = ("peak", "volcano")
#: Теги, которые вытаскиваем из узла
WANTED_KEYS = ("natural", "name", "name:ru", "name:en", "ele", "wikidata")

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
    """Имя вершины: name:ru → name → name:en; ru/en идут и в отдельные поля."""
    return tags.get("name:ru") or tags.get("name") or tags.get("name:en")


def parse_ele(raw: str | None) -> float | None:
    if not raw:
        return None
    cleaned = raw.replace(",", "").replace("m", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def in_bbox(lat: float, lon: float, bbox: tuple[float, float, float, float]) -> bool:
    """Точка внутри bbox, с учётом перехода через антимеридиан.

    У Врангеля границы 177.5…−177.5, и прямое сравнение `min <= lon <= max`
    ложно для любой точки: региональная выжимка приезжала пустой.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    lon_ok = (
        min_lon <= lon <= max_lon if min_lon <= max_lon else (lon >= min_lon or lon <= max_lon)
    )
    return lon_ok and min_lat <= lat <= max_lat


#: Размер ячейки сетки для предвыбора регионов, градусы.
#: Ячейка 2°: в неё попадает ~10 регионов вместо 115, остальные отсекаются.
REGION_GRID_DEG = 2.0


def _region_grid(
    region_bboxes: dict[str, tuple[float, float, float, float]],
) -> dict[tuple[int, int], list[str]]:
    """Сетка регионов: (gx, gy) → имена регионов, чей bbox пересекает ячейку.

    Без неё каждая вершина проверяла все 115 регионов — на 600K вершинах
    это 70 млн вызовов in_bbox и главная причина замедления с ростом данных.
    """
    grid: dict[tuple[int, int], list[str]] = {}
    for name, (min_lon, min_lat, max_lon, max_lat) in region_bboxes.items():
        gx0 = int(min_lon // REGION_GRID_DEG)
        gx1 = int(max_lon // REGION_GRID_DEG)
        gy0 = int(min_lat // REGION_GRID_DEG)
        gy1 = int(max_lat // REGION_GRID_DEG)
        for gx in range(gx0, gx1 + 1):
            for gy in range(gy0, gy1 + 1):
                grid.setdefault((gx, gy), []).append(name)
    return grid


def emit_peak(
    out,
    lat: float,
    lon: float,
    tags: dict[str, str],
    bbox: tuple[float, float, float, float] | None,
    stats: dict,
    region_writers: dict | None = None,
    region_grid: dict[tuple[int, int], list[str]] | None = None,
) -> None:
    stats["peaks"] += 1
    # Фильтр по bbox: раньше счётчик «вне bbox» увеличивался, но точка всё
    # равно писалась в выход — --bbox не сокращал файл, как обещает описание
    if bbox and not in_bbox(lat, lon, bbox):
        stats["outside"] += 1
        return

    name = pick_name(tags)
    if not name:
        stats["no_name"] += 1
        return
    peak: dict = {"lat": round(lat, 6), "lon": round(lon, 6), "name": name}
    if tags.get("name:ru"):
        peak["name_ru"] = tags["name:ru"]
    if tags.get("name:en"):
        peak["name_en"] = tags["name:en"]
    ele = parse_ele(tags.get("ele"))
    if ele is not None:
        peak["ele"] = round(ele)
    else:
        stats["no_ele"] += 1
    if tags.get("wikidata"):
        peak["wikidata"] = tags["wikidata"]
    if tags.get("natural") == "volcano":
        peak["volcano"] = True
        stats["volcanoes"] += 1
    line = json.dumps(peak, ensure_ascii=False) + "\n"

    out.write(line)
    stats["written"] += 1

    # Региональные выжимки: только регионы своей ячейки сетки, не все 115
    if region_writers and region_grid:
        gx = int(lon // REGION_GRID_DEG)
        gy = int(lat // REGION_GRID_DEG)
        for region_name in region_grid.get((gx, gy), ()):
            rbbox, fh = region_writers[region_name]
            if in_bbox(lat, lon, rbbox):
                fh.write(line)
                stats[f"region:{region_name}"] = stats.get(f"region:{region_name}", 0) + 1


def parse_dense_nodes(
    data: bytes,
    strings: list[bytes],
    granularity: int,
    lat_offset: int,
    lon_offset: int,
    out,
    bbox,
    stats: dict,
    region_writers: dict | None = None,
    region_grid: dict[tuple[int, int], list[str]] | None = None,
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
            if k in WANTED_KEYS:
                tags[k] = v
            kv_pos += 2
        # Разделитель 0 есть только после ноды С тегами; у пустой ноды его
        # нет. Без проверки пустая нода сдвигала kv_pos в середину списка
        # соседа — та получала чужие теги, а сам сосед оставался без них.
        # Именно так терялся Собер-Баш (OSM 498480291): natural=peak уехал
        # предыдущей ноде, а он сам остался без natural и был отброшен
        if kv_pos < len(kvs) and kvs[kv_pos] == 0:
            kv_pos += 1

        if tags.get("natural") in SUMMIT_TAGS:
            emit_peak(out, lat, lon, tags, bbox, stats, region_writers, region_grid)


def parse_node(
    data: bytes, strings: list[bytes], granularity: int, lat_offset: int, lon_offset: int,
    out, bbox, stats: dict, region_writers: dict | None = None,
    region_grid: dict[tuple[int, int], list[str]] | None = None,
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
        if strings[k].decode("utf-8", "replace") in WANTED_KEYS
    }
    if tags.get("natural") in SUMMIT_TAGS:
        emit_peak(
            out,
            (lat_offset + granularity * lat) / 1e9,
            (lon_offset + granularity * lon) / 1e9,
            tags,
            bbox,
            stats,
            region_writers,
            region_grid,
        )


def parse_primitive_block(
    data: bytes, out, bbox, stats: dict, region_writers: dict | None = None,
    region_grid: dict[tuple[int, int], list[str]] | None = None,
) -> None:
    """Один блок PBF → вершины в out (и по регионам, если заданы).

    В многопроцессном режиме вызывается в воркерах: `out` и `region_writers`
    — локальные файлы процесса, а не общие. Статистика собирается через
    возвращаемый словарь, а не изменение аргумента.
    """
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
                parse_node(gr.bytes(), strings, granularity, lat_offset, lon_offset, out, bbox, stats, region_writers, region_grid)
            elif gfield == 2:  # dense
                data = gr.bytes()
                # Защита от битых/пустых dense (встречаются в планете)
                if len(data) >= 16:
                    parse_dense_nodes(
                        data, strings, granularity, lat_offset, lon_offset, out, bbox, stats, region_writers, region_grid
                    )
            else:  # ways (3), relations (4) и прочее — пропускаем
                gr.bytes()


# ---------------------------------------------------------------------------
# Многопроцессность: читатель → воркеры (пишут напрямую) → merge в конце
# ---------------------------------------------------------------------------

# Глобальные файлы воркера: открыты один раз при старте процесса, не per-блок.
# Без этого open/close на каждый блок × 115 регионов × 40K блоков — квадратичная
# деградация скорости (главная причина падения с 80 до 32 МБ/с).
# Каждый воркер пишет в СВОЙ файл ({pid}.jsonl): иначе append из 8 процессов
# в один файл дал бы кашу из обрезанных строк
_worker_out = None
_worker_region_fhs: dict[str, object] = {}
_worker_region_grid: dict[tuple[int, int], list[str]] | None = None
_worker_bbox: tuple[float, float, float, float] | None = None
_worker_pid: int = 0


def _worker_init(out_path: Path, region_bboxes: dict[str, tuple] | None, regions_dir: Path | None) -> None:
    """Initializer воркера: открывает файлы один раз на процесс."""
    global _worker_out, _worker_region_fhs, _worker_region_grid, _worker_bbox, _worker_pid
    _worker_pid = os.getpid()
    _worker_out = out_path.with_suffix(f".{_worker_pid}.jsonl").open("w", encoding="utf-8", buffering=8192)
    _worker_bbox = None  # не используется в воркере, bbox фильтрация в emit_peak
    if region_bboxes and regions_dir:
        _worker_region_grid = _region_grid(region_bboxes)
        for name, rbbox in region_bboxes.items():
            fh = (regions_dir / f"{name}.{_worker_pid}.jsonl").open("w", encoding="utf-8", buffering=8192)
            _worker_region_fhs[name] = (rbbox, fh)


def _worker_parse_block(raw: bytes) -> dict:
    """Воркер: декодирует блок и пишет вершины в свои файлы.

    Возвращает только статистику (крошечный pickle) — данные уже на диске.
    Порядок блоков не сохраняется: JSONL можно сортировать потом, а скорость
    не деградирует от ожидания next_write.
    """
    stats = {"peaks": 0, "volcanoes": 0, "outside": 0, "no_name": 0, "no_ele": 0, "written": 0}
    # Первые 4 байта — служебный префикс (индекс блока), не часть PBF
    pbf_data = raw[4:]
    parse_primitive_block(
        pbf_data, _worker_out, _worker_bbox, stats,
        _worker_region_fhs if _worker_region_fhs else None,
        _worker_region_grid,
    )
    # Флашим на каждый блок: иначе merge читает пустые файлы — процессы
    # не закрываются до конца пула. 8192 байт буфера хватает на ~80 строк,
    # так что flush срабатывает не чаще, чем раз в несколько блоков.
    _worker_out.flush()
    for _, fh in _worker_region_fhs.values():
        fh.flush()
    return stats


def _merge_stats(dst: dict, src: dict) -> None:
    for k, v in src.items():
        dst[k] = dst.get(k, 0) + v


def main() -> None:
    parser = argparse.ArgumentParser(
        description="planet.osm.pbf → JSONL вершин (natural=peak и natural=volcano)"
    )
    parser.add_argument("input", type=Path, help="planet-*.osm.pbf")
    parser.add_argument("-o", "--out", type=Path, required=True, help="JSONL на выход")
    parser.add_argument(
        "--bbox",
        help="minLon,minLat,maxLon,maxLat — писать только вершины внутри (необязательно)",
    )
    parser.add_argument(
        "--regions-dir",
        type=Path,
        help="Каталог: для КАЖДОГО региона из tools/regions.json писать {dir}/{name}.jsonl",
    )
    parser.add_argument(
        "-j",
        "--jobs",
        type=int,
        default=max(1, (os.cpu_count() or 2) - 1),
        help="Число процессов (по умолчанию: CPU−1)",
    )
    args = parser.parse_args()

    bbox = None
    if args.bbox:
        bbox = tuple(float(x) for x in args.bbox.split(","))
        if len(bbox) != 4:
            sys.exit("bbox: minLon,minLat,maxLon,maxLat")

    # Региональные bbox для воркеров (сами файлы пишутся в главном процессе)
    region_bboxes: dict[str, tuple[float, float, float, float]] = {}
    if args.regions_dir:
        registry = Path(__file__).parent.parent / "regions.json"
        regions = json.loads(registry.read_text(encoding="utf-8"))
        for name, entry in regions.items():
            if not isinstance(entry, dict) or "bbox" not in entry:
                continue
            region_bboxes[name] = tuple(entry["bbox"])
        print(f"Регионов для воркеров: {len(region_bboxes)}")

    stats = {
        "peaks": 0,
        "volcanoes": 0,
        "outside": 0,
        "no_name": 0,
        "no_ele": 0,
        "written": 0,
    }
    t0 = time.time()
    blocks = 0
    file_size = args.input.stat().st_size

    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.regions_dir:
        args.regions_dir.mkdir(parents=True, exist_ok=True)

    with args.input.open("rb") as f:
        # Воркеры пишут напрямую в свои файлы (открыты один раз на процесс).
        # Порядок блоков не сохраняем: JSONL можно сортировать потом, зато
        # нет ни квадратичного сбора tmp-файлов, ни пузырей от ожидания
        # next_write. Статистика — крошечный pickle на блок, не данные.
        with mp.Pool(
            args.jobs,
            initializer=_worker_init,
            initargs=(args.out, region_bboxes, args.regions_dir),
        ) as pool:
            async_results = []
            while True:
                header = read_blob_header(f)
                if header is None:
                    break
                blob_type, datasize = header
                if blob_type == "OSMData":
                    # Ждём, если очередь переполнена: inqueue — это память,
                    # а не скорость. Воркеры всё равно не успеют больше
                    while pool._taskqueue.qsize() > args.jobs * 2:
                        time.sleep(0.01)
                    raw = read_blob(f, datasize)
                    block_id = blocks.to_bytes(4, "little") + raw
                    blocks += 1
                    async_results.append(pool.apply_async(_worker_parse_block, (block_id,)))

                    # Периодический сбор статистики: без данных, только счётчики.
                    # Баг: del async_results[:ready] резал с начала, хотя готовые
                    # разбросаны по списку — не готовые в начале затыкали удаление,
                    # список рос квадратично, и каждые 50 блоков мы сканировали
                    # тысячи AsyncResult. Исправление: новый список без готовых
                    if blocks % 50 == 0:
                        still_pending = []
                        for ar in async_results:
                            if ar.ready():
                                _merge_stats(stats, ar.get())
                            else:
                                still_pending.append(ar)
                        async_results = still_pending
                        elapsed = time.time() - t0
                        pos = f.tell()
                        pct = 100 * pos / file_size
                        speed = pos / max(elapsed, 1) / 1e6
                        eta_min = (file_size - pos) / max(pos / elapsed, 1) / 60
                        print(
                            f"  {pct:5.1f}% | {blocks} блоков | "
                            f"{stats['peaks']} пиков, записано {stats['written']}"
                            + (
                                f" | регионов с пиками: "
                                f"{sum(1 for k in stats if k.startswith('region:'))}"
                                if region_bboxes
                                else ""
                            )
                            + f" | {speed:.1f} МБ/с | прошло {elapsed / 60:.1f} мин, "
                            f"осталось ~{eta_min:.1f} мин",
                            flush=True,
                        )
                else:  # OSMHeader — пропускаем
                    f.seek(datasize, 1)

            # Досбор статистики
            for ar in async_results:
                _merge_stats(stats, ar.get())

    # Merge: все воркеры писали в свои {pid}.jsonl — конкатенируем в финальные
    # файлы. Это секунды: последовательное чтение/запись без парсинга.
    # Регионы ищем в regions_dir, а не в out.parent — каталоги разные
    import glob
    import shutil

    for pattern, target_dir, target_name in [
        (f"{args.out.stem}.*.jsonl", args.out.parent, args.out.name),
        *(
            (f"{name}.*.jsonl", args.regions_dir, f"{name}.jsonl")
            for name in region_bboxes
        ),
    ]:
        parts = sorted(glob.glob(str(target_dir / pattern)))
        if not parts:
            continue
        with (target_dir / target_name).open("wb") as out_f:
            for p in parts:
                with open(p, "rb") as in_f:
                    shutil.copyfileobj(in_f, out_f)
        for p in parts:
            Path(p).unlink()

    elapsed = time.time() - t0
    print(
        f"OK: {stats['written']} вершин → {args.out} за {elapsed / 60:.1f} мин\n"
        f"  найдено peak/volcano: {stats['peaks']} (вулканов: {stats['volcanoes']}), "
        f"без имени: {stats['no_name']}, без ele: {stats['no_ele']}"
    )
    if region_bboxes:
        print("  По регионам:")
        for name in sorted(region_bboxes):
            n = stats.get(f"region:{name}", 0)
            if n:
                print(f"    {name}: {n}")


if __name__ == "__main__":
    main()
