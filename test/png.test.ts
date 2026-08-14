/**
 * Декодер PNG (src/core/png.ts): проверка на собранных вручную PNG.
 *
 * PNG собираем сами (сигнатура + IHDR + IDAT + IEND, zlib из node), чтобы
 * пройти все пять фильтров, RGB и RGBA, не завися от сетевых тайлов.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePngToRgba } from "../src/core/png";

function writeU32BE(data: Uint8Array, pos: number, value: number): void {
  data[pos] = (value >>> 24) & 0xff;
  data[pos + 1] = (value >>> 16) & 0xff;
  data[pos + 2] = (value >>> 8) & 0xff;
  data[pos + 3] = value & 0xff;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  ]);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  const out = new Uint8Array(12 + data.length);
  writeU32BE(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  writeU32BE(out, 8 + data.length, crc32(body));
  return out;
}

/** Применяет PNG-фильтр к строке (для сборки тестового PNG) */
function filterRow(
  filter: number,
  row: Uint8Array,
  prev: Uint8Array,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = prev[i];
    const upLeft = i >= bpp ? prev[i - bpp] : 0;
    let predictor = 0;
    if (filter === 1) predictor = left;
    else if (filter === 2) predictor = up;
    else if (filter === 3) predictor = (left + up) >> 1;
    else if (filter === 4) {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
    }
    out[i] = (row[i] - predictor) & 0xff;
  }
  return out;
}

/** Собирает PNG 8-бит без чересстрочности (colorType 2 = RGB, 6 = RGBA) */
function buildPng(
  width: number,
  height: number,
  colorType: 2 | 6,
  raw: Uint8Array,
  filter: number,
): Uint8Array {
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const scanlines = new Uint8Array(height * (1 + stride));
  let off = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    scanlines[off++] = filter;
    const filtered = filterRow(filter, row, prev, bpp);
    scanlines.set(filtered, off);
    off += stride;
    prev = new Uint8Array(row); // реконструированная строка == исходная
  }

  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, width);
  writeU32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = asU8(deflateSync(scanlines));

  const parts = [
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const png = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    png.set(p, pos);
    pos += p.length;
  }
  return png;
}

function asU8(buffer: Uint8Array): Uint8Array {
  return new Uint8Array(buffer);
}

describe("decodePngToRgba (фолбэк для iOS < 16.4)", () => {
  it("декодирует RGBA с фильтром 0", () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 40, 128, 64,
      32, 16, 1, 2, 3, 4,
    ]);
    const decoded = decodePngToRgba(buildPng(3, 2, 6, rgba, 0));
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.data)).toEqual(Array.from(rgba));
  });

  it("декодирует RGB и дополняет alpha=255", () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 64, 32]);
    const decoded = decodePngToRgba(buildPng(2, 2, 2, rgb, 0));
    expect(Array.from(decoded.data)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 128, 64, 32, 255,
    ]);
  });

  it("снимает все пять фильтров", () => {
    const rgba = new Uint8Array(4 * 3 * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 11) & 0xff;
    for (let filter = 0; filter <= 4; filter++) {
      const decoded = decodePngToRgba(buildPng(4, 3, 6, rgba, filter));
      expect(Array.from(decoded.data), `фильтр ${filter}`).toEqual(
        Array.from(rgba),
      );
    }
  });

  it("бросает на чересстрочный PNG", () => {
    const png = buildPng(2, 2, 6, new Uint8Array(16), 0);
    // interlace = 1 — это 12-й байт данных IHDR; данные IHDR начинаются с
    // 16-го байта файла (8 сигнатура + 4 длина + 4 тип)
    png[16 + 12] = 1;
    expect(() => decodePngToRgba(png)).toThrow(/чересстроч/);
  });
});
