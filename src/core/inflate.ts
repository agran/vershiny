/**
 * Минимальный DEFLATE-инфлятор (zlib и gzip) без зависимостей.
 *
 * Нужен как фолбэк для iOS < 16.4, где в воркере нет `DecompressionStream`:
 * там тайлы пирамиды (`.bin.gz`) и IDAT-потоки PNG распаковываются этим кодом.
 * На современных браузерах модуль не вызывается — используется нативный
 * `DecompressionStream` (см. dem.ts / png.ts).
 *
 * Реализация полная: stored / fixed-Huffman / dynamic-Huffman блоки, код
 * длин с повторами (16–18), LZ77 с перекрывающимися копиями. Чтение битов —
 * LSB-first, как требует RFC 1951.
 */

const HUFF_MAX_BITS = 15;

/** Чтение битов из потока DEFLATE (младший бит первым) */
class BitReader {
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Добирает байты в буфер; у конца потока оставшиеся биты считаются нулями
   *  (последний блок DEFLATE дополняется нулями до границы байта). */
  private fill(n: number): void {
    while (this.bitCount < n && this.pos < this.data.length) {
      this.bitBuf |= this.data[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
  }

  peekBits(n: number): number {
    this.fill(n);
    return this.bitBuf & ((1 << n) - 1);
  }

  dropBits(n: number): void {
    this.bitBuf >>>= n;
    this.bitCount -= n;
  }

  readBits(n: number): number {
    const value = this.peekBits(n);
    this.dropBits(n);
    return value;
  }

  /** Выравнивание на границу байта (stored-блок) */
  alignByte(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  readByte(): number {
    if (this.pos >= this.data.length)
      throw new Error("неожиданный конец deflate-потока");
    return this.data[this.pos++];
  }
}

/** Декодер Хаффмана по каноническим кодам (поразрядно, без таблицы) */
class Huffman {
  /** Количество кодов каждой длины */
  private readonly count = new Int32Array(HUFF_MAX_BITS + 1);
  /** Символы, отсортированные по (длина, код) */
  private readonly symbols: Uint16Array;

  constructor(lengths: Uint8Array) {
    for (let i = 0; i < lengths.length; i++) {
      const len = lengths[i];
      if (len) this.count[len]++;
    }

    // Символы одной длины идут в порядке назначения канонических кодов,
    // то есть в порядке самих символов (0, 1, 2, …)
    this.symbols = new Uint16Array(lengths.length);
    for (let sym = 0; sym < lengths.length; sym++) {
      const len = lengths[sym];
      if (!len) continue;
      let index = 0;
      for (let l = 1; l < len; l++) index += this.count[l];
      for (let s = 0; s < sym; s++) if (lengths[s] === len) index++;
      this.symbols[index] = sym;
    }
  }

  decode(br: BitReader): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= HUFF_MAX_BITS; len++) {
      code = (code << 1) | br.readBits(1);
      const count = this.count[len];
      if (code < first + count) {
        return this.symbols[index + (code - first)];
      }
      index += count;
      first = (first + count) << 1;
    }
    throw new Error("недопустимый код Хаффмана");
  }
}

/** Фиксированная таблица literal/length (RFC 1951 §3.2.6) */
function makeFixedLitLen(): Huffman {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 288; i++) {
    lengths[i] = i <= 143 ? 8 : i <= 255 ? 9 : i <= 279 ? 7 : 8;
  }
  return new Huffman(lengths);
}

/** Фиксированная таблица дистанций (32 кода по 5 бит) */
function makeFixedDist(): Huffman {
  return new Huffman(new Uint8Array(32).fill(5));
}

const FIXED_LL = makeFixedLitLen();
const FIXED_D = makeFixedDist();

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];

/** Коды длин кода в порядке обхода RFC 1951 (§3.2.7) */
const CL_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

/** Тело DEFLATE после заголовков zlib/gzip */
function inflateRaw(br: BitReader): Uint8Array {
  let out = new Uint8Array(1 << 16);
  let outLen = 0;
  const ensure = (n: number): void => {
    while (outLen + n > out.length) {
      const next = new Uint8Array(out.length << 1);
      next.set(out.subarray(0, outLen));
      out = next;
    }
  };

  let ll = FIXED_LL;
  let dist = FIXED_D;

  let last = false;
  while (!last) {
    last = br.readBits(1) === 1;
    const type = br.readBits(2);

    if (type === 0) {
      // Несжатый блок: выравнивание + LEN/NLEN
      br.alignByte();
      const len = br.readByte() | (br.readByte() << 8);
      const nlen = br.readByte() | (br.readByte() << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error("битый stored-блок deflate");
      ensure(len);
      for (let i = 0; i < len; i++) out[outLen++] = br.readByte();
      continue; // stored-блок не содержит Хаффман-символов
    } else if (type === 1) {
      ll = FIXED_LL;
      dist = FIXED_D;
    } else if (type === 2) {
      const hlit = br.readBits(5) + 257;
      const hdist = br.readBits(5) + 1;
      const hclen = br.readBits(4) + 4;

      const clLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clLengths[CL_ORDER[i]] = br.readBits(3);
      const clHuff = new Huffman(clLengths);

      const lengths = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < lengths.length) {
        const sym = clHuff.decode(br);
        if (sym < 16) {
          lengths[i++] = sym;
        } else if (sym === 16) {
          if (i === 0) throw new Error("повтор длины кода без предыдущего");
          const prev = lengths[i - 1];
          const rep = br.readBits(2) + 3;
          for (let k = 0; k < rep && i < lengths.length; k++)
            lengths[i++] = prev;
        } else if (sym === 17) {
          const rep = br.readBits(3) + 3;
          for (let k = 0; k < rep && i < lengths.length; k++) lengths[i++] = 0;
        } else if (sym === 18) {
          const rep = br.readBits(7) + 11;
          for (let k = 0; k < rep && i < lengths.length; k++) lengths[i++] = 0;
        } else {
          throw new Error("недопустимый символ длины кода");
        }
      }
      ll = new Huffman(lengths.subarray(0, hlit));
      dist = new Huffman(lengths.subarray(hlit));
    } else {
      throw new Error("недопустимый тип блока deflate");
    }

    // Содержимое блока до символа «конец блока» (256)
    for (;;) {
      const sym = ll.decode(br);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        const idx = sym - 257;
        if (idx < 0 || idx >= LEN_BASE.length)
          throw new Error("недопустимый код длины");
        const len = LEN_BASE[idx] + br.readBits(LEN_EXTRA[idx]);
        const dSym = dist.decode(br);
        if (dSym >= DIST_BASE.length)
          throw new Error("недопустимый код дистанции");
        const d = DIST_BASE[dSym] + br.readBits(DIST_EXTRA[dSym]);
        if (d > outLen) throw new Error("дистанция за пределы окна LZ77");
        ensure(len);
        for (let k = 0; k < len; k++) {
          out[outLen] = out[outLen - d];
          outLen++;
        }
      }
    }
  }

  return out.slice(0, outLen);
}

/** Распаковка zlib-потока (заголовок CMF/FLG + deflate + Adler-32) */
export function inflateZlib(data: Uint8Array): Uint8Array {
  if (data.length < 6) throw new Error("zlib: слишком короткий поток");
  const cmf = data[0];
  const flg = data[1];
  if ((cmf & 0x0f) !== 8) throw new Error("zlib: неизвестный метод сжатия");
  if (((cmf << 8) | flg) % 31 !== 0) throw new Error("zlib: битый заголовок");
  const br = new BitReader(data.subarray(2, data.length - 4));
  return inflateRaw(br);
}

function readU16LE(data: Uint8Array, pos: number): number {
  return data[pos] | (data[pos + 1] << 8);
}

/** Распаковка gzip-потока (RFC 1952) */
export function inflateGzip(data: Uint8Array): Uint8Array {
  if (data.length < 18) throw new Error("gzip: слишком короткий поток");
  if (data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8) {
    throw new Error("gzip: неверная сигнатура");
  }
  const flg = data[3];
  let pos = 10;
  if (flg & 0x04) {
    // FEXTRA
    if (pos + 2 > data.length) throw new Error("gzip: битый FEXTRA");
    pos += 2 + readU16LE(data, pos);
  }
  if (flg & 0x08) {
    // FNAME — до нулевого байта
    while (pos < data.length && data[pos] !== 0) pos++;
    pos++;
  }
  if (flg & 0x10) {
    // FCOMMENT
    while (pos < data.length && data[pos] !== 0) pos++;
    pos++;
  }
  if (flg & 0x02) pos += 2; // FHCRC
  if (pos > data.length - 8) throw new Error("gzip: битый заголовок");
  const br = new BitReader(data.subarray(pos, data.length - 8));
  return inflateRaw(br);
}
