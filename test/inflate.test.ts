/**
 * Фолбэк-инфлятор (src/core/inflate.ts): проверка против node:zlib.
 *
 * Покрываем все типы блоков DEFLATE: stored (level 0), фиксированный и
 * динамический Хаффман, LZ77 с повторами — и оба формата (zlib/gzip).
 */

import { deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inflateGzip, inflateZlib } from "../src/core/inflate";

/** Детерминированные «случайные» байты (LCG) */
function randBytes(n: number, seed = 42): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function asU8(buffer: Uint8Array): Uint8Array {
  return new Uint8Array(buffer);
}

describe("inflateZlib / inflateGzip (фолбэк для iOS < 16.4)", () => {
  it("zlib: stored-блок (level 0)", () => {
    const data = randBytes(5000);
    expect(inflateZlib(asU8(deflateSync(data, { level: 0 })))).toEqual(data);
  });

  it("zlib: динамический Хаффман на несжимаемых данных", () => {
    const data = randBytes(65536);
    expect(inflateZlib(asU8(deflateSync(data)))).toEqual(data);
  });

  it("zlib: LZ77-повторы", () => {
    const data = new Uint8Array(200000);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor(i / 4) & 0xff;
    expect(inflateZlib(asU8(deflateSync(data)))).toEqual(data);
  });

  it("zlib: пустой поток", () => {
    expect(inflateZlib(asU8(deflateSync(new Uint8Array(0))))).toEqual(
      new Uint8Array(0),
    );
  });

  it("gzip: динамический блок", () => {
    const data = randBytes(100000);
    expect(inflateGzip(asU8(gzipSync(data)))).toEqual(data);
  });

  it("gzip: хранит несжимаемые байты без искажений", () => {
    const data = randBytes(30000, 7);
    expect(inflateGzip(asU8(gzipSync(data, { level: 0 })))).toEqual(data);
  });

  it("бросает на битый zlib-заголовок", () => {
    expect(() =>
      inflateZlib(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00])),
    ).toThrow();
  });
});
