// Minimal animated GIF89a writer: local colour table per frame, LZW-compressed,
// optional 1-bit transparency, infinite loop.

class ByteWriter {
  constructor(size = 1 << 20) { this.buf = new Uint8Array(size); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b) { this.ensure(1); this.buf[this.len++] = b & 255; }
  word(w) { this.byte(w); this.byte(w >> 8); }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  result() { return this.buf.subarray(0, this.len); }
}

function lzw(indices, minCodeSize, out) {
  const clearCode = 1 << minCodeSize, eoi = clearCode + 1;
  let codeSize = minCodeSize + 1, nextCode = eoi + 1;
  let dict = new Map();
  const block = new Uint8Array(255);
  let blen = 0, cur = 0, curBits = 0;
  const flushByte = b => {
    block[blen++] = b;
    if (blen === 255) { out.byte(255); out.bytes(block); blen = 0; }
  };
  const emit = code => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) { flushByte(cur & 255); cur >>>= 8; curBits -= 8; }
  };
  out.byte(minCodeSize);
  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const code = dict.get(key);
    if (code !== undefined) { prefix = code; continue; }
    emit(prefix);
    if (nextCode === 4096) {
      emit(clearCode);
      dict = new Map();
      codeSize = minCodeSize + 1;
      nextCode = eoi + 1;
    } else {
      if (nextCode >= (1 << codeSize)) codeSize++;
      dict.set(key, nextCode++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (curBits > 0) flushByte(cur & 255);
  if (blen) { out.byte(blen); out.bytes(block.subarray(0, blen)); }
  out.byte(0);
}

export class GifEncoder {
  constructor(width, height, { loop = 0 } = {}) {
    this.w = width; this.h = height;
    const o = this.out = new ByteWriter(Math.max(1 << 16, width * height));
    o.str('GIF89a');
    o.word(width); o.word(height);
    o.byte(0x00); o.byte(0); o.byte(0);           // no global colour table
    o.byte(0x21); o.byte(0xff); o.byte(11); o.str('NETSCAPE2.0');
    o.byte(3); o.byte(1); o.word(loop); o.byte(0);
  }
  // frame: { palette: [[r,g,b]...], indices: Uint8Array, transparentIndex }, delay in 1/100 s
  addFrame({ palette, indices, transparentIndex = -1 }, delay = 4) {
    const o = this.out;
    let bits = 1;
    while ((1 << bits) < palette.length) bits++;
    const hasT = transparentIndex >= 0;
    o.byte(0x21); o.byte(0xf9); o.byte(4);
    o.byte(((hasT ? 2 : 1) << 2) | (hasT ? 1 : 0));
    o.word(delay);
    o.byte(hasT ? transparentIndex : 0);
    o.byte(0);
    o.byte(0x2c); o.word(0); o.word(0); o.word(this.w); o.word(this.h);
    o.byte(0x80 | (bits - 1));
    const table = new Uint8Array(3 * (1 << bits));
    palette.forEach((c, i) => { table[i * 3] = c[0]; table[i * 3 + 1] = c[1]; table[i * 3 + 2] = c[2]; });
    o.bytes(table);
    lzw(indices, Math.max(2, bits), o);
  }
  finish() {
    this.out.byte(0x3b);
    return new Blob([this.out.result()], { type: 'image/gif' });
  }
}
