// Median-cut colour quantisation over a 15-bit (5 bits per channel) histogram.

const key15 = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

export function medianCut(data, maxColors, { step = 1, alphaMin = 128 } = {}) {
  const hist = new Uint32Array(32768);
  for (let i = 0; i < data.length; i += 4 * step) {
    if (data[i + 3] < alphaMin) continue;
    hist[key15(data[i], data[i + 1], data[i + 2])]++;
  }
  const colors = [];
  for (let k = 0; k < 32768; k++) if (hist[k]) colors.push(k);
  if (!colors.length) return [[0, 0, 0]];
  const ch = (k, c) => c === 0 ? (k >> 10) & 31 : c === 1 ? (k >> 5) & 31 : k & 31;
  const boxes = [colors];
  while (boxes.length < maxColors) {
    let bi = -1, bestRange = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 31, hi = 0;
        for (const k of b) { const v = ch(k, c); if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi - lo > bestRange) { bestRange = hi - lo; bi = i; }
      }
    });
    if (bi < 0) break;
    const box = boxes[bi];
    let axis = 0, wide = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 31, hi = 0;
      for (const k of box) { const v = ch(k, c); if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi - lo > wide) { wide = hi - lo; axis = c; }
    }
    box.sort((a, b) => ch(a, axis) - ch(b, axis));
    let total = 0;
    for (const k of box) total += hist[k];
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += hist[box[i]];
      if (acc >= total / 2) { cut = i + 1; break; }
      cut = i + 1;
    }
    boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map(b => {
    let r = 0, g = 0, bl = 0, n = 0;
    for (const k of b) {
      const w = hist[k];
      r += (ch(k, 0) * 8 + 4) * w; g += (ch(k, 1) * 8 + 4) * w; bl += (ch(k, 2) * 8 + 4) * w; n += w;
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
}

// Index a frame for GIF: exact palette when the frame has <= maxColors colours (typical
// after dithering), otherwise median cut. Transparent pixels get their own index.
export function quantizeFrame(data, maxColors = 256) {
  const n = data.length / 4;
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) { hasAlpha = true; break; }
  const limit = maxColors - (hasAlpha ? 1 : 0);
  const indices = new Uint8Array(n);
  const exact = new Map();
  let ok = true;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (data[j + 3] < 128) continue;
    const c = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
    if (!exact.has(c)) {
      if (exact.size >= limit) { ok = false; break; }
      exact.set(c, exact.size);
    }
  }
  let palette;
  if (ok) {
    palette = [...exact.keys()].map(c => [(c >> 16) & 255, (c >> 8) & 255, c & 255]);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] < 128) continue;
      indices[i] = exact.get((data[j] << 16) | (data[j + 1] << 8) | data[j + 2]);
    }
  } else {
    palette = medianCut(data, limit, { step: n > 400000 ? 2 : 1 });
    const lut = new Int16Array(32768).fill(-1);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] < 128) continue;
      const k = key15(data[j], data[j + 1], data[j + 2]);
      let idx = lut[k];
      if (idx < 0) {
        const r = data[j], g = data[j + 1], b = data[j + 2];
        let bd = Infinity;
        for (let p = 0; p < palette.length; p++) {
          const c = palette[p];
          const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
          if (d < bd) { bd = d; idx = p; }
        }
        lut[k] = idx;
      }
      indices[i] = idx;
    }
  }
  let transparentIndex = -1;
  if (hasAlpha) {
    transparentIndex = palette.length;
    palette.push([0, 0, 0]);
    for (let i = 0, j = 3; i < n; i++, j += 4) if (data[j] < 128) indices[i] = transparentIndex;
  }
  return { palette, indices, transparentIndex };
}
