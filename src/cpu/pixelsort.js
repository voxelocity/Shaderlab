// Pixel sorting: within each row (or column), runs of pixels whose brightness falls
// inside [low, high] are sorted by the chosen key.

export function pixelSort(data, w, h, { low, high, direction, key, reverse }) {
  const n = w * h;
  const px = new Uint32Array(data.buffer, data.byteOffset, n);
  const keys = new Uint16Array(n);
  const inBand = new Uint8Array(n);
  const lo = low * 255, hi = high * 255;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    inBand[i] = l >= lo && l <= hi ? 1 : 0;
    if (key === 'brightness') keys[i] = Math.round(l * 4);
    else {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (key === 'saturation') keys[i] = mx ? Math.round((d / mx) * 1023) : 0;
      else {
        let hue = 0;
        if (d) {
          if (mx === r) hue = ((g - b) / d + 6) % 6;
          else if (mx === g) hue = (b - r) / d + 2;
          else hue = (r - g) / d + 4;
        }
        keys[i] = Math.round((hue / 6) * 1023);
      }
    }
  }
  const horizontal = direction !== 'vertical';
  const lines = horizontal ? h : w, len = horizontal ? w : h;
  const idx = horizontal ? (line, i) => line * w + i : (line, i) => i * w + line;
  const tmp = new Uint32Array(len), pix = new Uint32Array(len);
  for (let line = 0; line < lines; line++) {
    let i = 0;
    while (i < len) {
      while (i < len && !inBand[idx(line, i)]) i++;
      const s = i;
      while (i < len && inBand[idx(line, i)]) i++;
      const L = i - s;
      if (L < 2) continue;
      for (let j = 0; j < L; j++) {
        const p = idx(line, s + j);
        tmp[j] = (keys[p] << 21) | j;
        pix[j] = px[p];
      }
      const run = tmp.subarray(0, L).sort();
      for (let j = 0; j < L; j++) px[idx(line, s + j)] = pix[run[reverse ? L - 1 - j : j] & 0x1fffff];
    }
  }
}
