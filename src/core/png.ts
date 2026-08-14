/**
 * Минимальный декодер PNG (8-бит, без чересстрочности, RGB/RGBA).
 *
 * Нужен как фолбэк для iOS < 16.4: в воркере там нет `OffscreenCanvas` и
 * `createImageBitmap`, поэтому Terrarium-тайлы декодируются этим кодом.
 * На современных браузерах не вызывается (см. terrarium.ts).
 *
 * Поддерживает только то, что реально приходит в тайлах Terrarium: битовая
 * глубина 8, colorType 2 (RGB) или 6 (RGBA), фильтры 0–4, без чересстрочности.
 */

import { inflateZlib } from "./inflate";

export interface DecodedPng {
  width: number;
  height: number;
  /** Пиксели RGBA, width*height*4 байт */
  data: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readU32BE(data: Uint8Array, pos: number): number {
  return (
    ((data[pos] << 24) |
      (data[pos + 1] << 16) |
      (data[pos + 2] << 8) |
      data[pos + 3]) >>>
    0
  );
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(
  filter: number,
  row: Uint8Array,
  prev: Uint8Array,
  bpp: number,
): void {
  switch (filter) {
    case 0:
      return;
    case 1: // Sub
      for (let i = bpp; i < row.length; i++)
        row[i] = (row[i] + row[i - bpp]) & 0xff;
      return;
    case 2: // Up
      for (let i = 0; i < row.length; i++) row[i] = (row[i] + prev[i]) & 0xff;
      return;
    case 3: // Average
      for (let i = 0; i < row.length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      return;
    case 4: // Paeth
      for (let i = 0; i < row.length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        row[i] = (row[i] + paeth(left, prev[i], upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`PNG: неизвестный фильтр ${filter}`);
  }
}

/** PNG-байты → пиксели RGBA */
export function decodePngToRgba(png: Uint8Array): DecodedPng {
  if (png.length < 8) throw new Error("PNG: слишком короткий файл");
  for (let i = 0; i < 8; i++) {
    if (png[i] !== PNG_SIGNATURE[i]) throw new Error("PNG: неверная сигнатура");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts: Uint8Array[] = [];
  let idatLen = 0;

  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = readU32BE(png, pos);
    const type = String.fromCharCode(
      png[pos + 4],
      png[pos + 5],
      png[pos + 6],
      png[pos + 7],
    );
    const dataStart = pos + 8;
    if (dataStart + len > png.length) throw new Error("PNG: битый чанк");

    if (type === "IHDR") {
      if (len < 13) throw new Error("PNG: короткий IHDR");
      width = readU32BE(png, dataStart);
      height = readU32BE(png, dataStart + 4);
      bitDepth = png[dataStart + 8];
      colorType = png[dataStart + 9];
      interlace = png[dataStart + 12];
    } else if (type === "IDAT") {
      idatParts.push(png.subarray(dataStart, dataStart + len));
      idatLen += len;
    } else if (type === "IEND") {
      break;
    }
    pos = dataStart + len + 4; // + CRC
  }

  if (width <= 0 || height <= 0) throw new Error("PNG: нет IHDR");
  if (bitDepth !== 8)
    throw new Error(`PNG: поддерживается только 8 бит (получено ${bitDepth})`);
  if (interlace !== 0)
    throw new Error("PNG: чересстрочность не поддерживается");
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG: неподдерживаемый colorType ${colorType}`);

  const raw = new Uint8Array(idatLen);
  let off = 0;
  for (const part of idatParts) {
    raw.set(part, off);
    off += part.length;
  }

  const inflated = inflateZlib(raw);
  const stride = width * bpp;
  if (inflated.length < height * (1 + stride))
    throw new Error("PNG: неполные данные IDAT");

  const out = new Uint8Array(width * height * 4);
  const row = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let src = 0;

  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    for (let i = 0; i < stride; i++) row[i] = inflated[src++];
    unfilter(filter, row, prev, bpp);
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      out[d] = row[s];
      out[d + 1] = row[s + 1];
      out[d + 2] = row[s + 2];
      out[d + 3] = bpp === 4 ? row[s + 3] : 255;
    }
    prev.set(row);
  }

  return { width, height, data: out };
}
