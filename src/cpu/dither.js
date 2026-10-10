// Error-diffusion dithering is inherently serial, so it runs on the CPU over a
// downscaled readback and the result is uploaded again.

const KERNELS = {
  floyd: [[[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]], 16],
  atkinson: [[[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]], 8],
  sierra: [[[1, 0, 2], [-1, 1, 1], [0, 1, 1]], 4],
  sierra2: [[[1, 0, 4], [2, 0, 3], [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1]], 16],
  sierra3: [[[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]], 32],
  burkes: [[[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]], 32],
  stucki: [[[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]], 42],
  jarvis: [[[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]], 48],
  fan: [[[1, 0, 7], [-2, 1, 1], [-1, 1, 3], [0, 1, 5]], 16],
  shiaufan: [[[1, 0, 8], [-3, 1, 1], [-2, 1, 1], [-1, 1, 2], [0, 1, 4]], 16],
  falsefloyd: [[[1, 0, 3], [0, 1, 3], [1, 1, 2]], 8],
  stevenson: [[[2, 0, 32], [-3, 1, 12], [-1, 1, 26], [1, 1, 30], [3, 1, 16], [-2, 2, 12], [0, 2, 26], [2, 2, 12], [-3, 3, 5], [-1, 3, 12], [1, 3, 12], [3, 3, 5]], 200],
};
export const DIFFUSERS = [...Object.keys(KERNELS), 'riemersma'];

function quantizer(palette, rgbLevels) {
  const pn = palette.length;
  const pr = new Float32Array(pn), pg = new Float32Array(pn), pb = new Float32Array(pn);
  palette.forEach((c, i) => { pr[i] = c[0]; pg[i] = c[1]; pb[i] = c[2]; });
  const L = rgbLevels > 1 ? rgbLevels - 1 : 0;
  const step = L ? 255 / L : 0;
  const out = new Float32Array(3);
  return (r, g, b) => {
    if (L) {
      out[0] = Math.min(255, Math.max(0, Math.round(r / step) * step));
      out[1] = Math.min(255, Math.max(0, Math.round(g / step) * step));
      out[2] = Math.min(255, Math.max(0, Math.round(b / step) * step));
    } else {
      let best = 0, bd = Infinity;
      for (let p = 0; p < pn; p++) {
        const dr = r - pr[p], dg = g - pg[p], db = b - pb[p];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = p; }
      }
      out[0] = pr[best]; out[1] = pg[best]; out[2] = pb[best];
    }
    return out;
  };
}

// Hilbert curve index -> (x, y) on an n x n grid (n a power of two), written into `out`.
function d2xy(n, d, out) {
  let x = 0, y = 0, t = d;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & (t >> 1), ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      const tmp = x; x = y; y = tmp;
    }
    x += s * rx; y += s * ry;
    t >>= 2;
  }
  out[0] = x; out[1] = y;
}

// Riemersma: walk a Hilbert curve and spread error over the last 16 pixels visited,
// with exponentially fading weights. Gives an organic, direction-free texture.
function riemersma(buf, w, h, quant, strength) {
  const Q = 16;
  // newest error weighs 1, oldest 1/16 (Riemersma 1998); errors are not renormalised
  const weights = Array.from({ length: Q }, (_, i) => Math.pow(1 / 16, (Q - 1 - i) / (Q - 1)));
  const hist = new Float32Array(Q * 3);
  let n = 1;
  while (n < Math.max(w, h)) n *= 2;
  const xy = new Int32Array(2);
  let px = -9, py = -9;
  for (let d = 0; d < n * n; d++) {
    d2xy(n, d, xy);
    const x = xy[0], y = xy[1];
    if (x >= w || y >= h) continue;
    // the curve leaves the image when the canvas isn't a power-of-two square; don't carry
    // error across the jump or it shows up as rectangular patches
    if (Math.abs(x - px) + Math.abs(y - py) > 1) hist.fill(0);
    px = x; py = y;
    const b = (y * w + x) * 3;
    let er = 0, eg = 0, eb = 0;
    for (let i = 0; i < Q; i++) { er += hist[i * 3] * weights[i]; eg += hist[i * 3 + 1] * weights[i]; eb += hist[i * 3 + 2] * weights[i]; }
    const q = quant(buf[b] + er * strength, buf[b + 1] + eg * strength, buf[b + 2] + eb * strength);
    hist.copyWithin(0, 3);
    hist[(Q - 1) * 3] = buf[b] - q[0]; hist[(Q - 1) * 3 + 1] = buf[b + 1] - q[1]; hist[(Q - 1) * 3 + 2] = buf[b + 2] - q[2];
    buf[b] = q[0]; buf[b + 1] = q[1]; buf[b + 2] = q[2];
  }
}

// data: RGBA bytes, modified in place. palette: [[r,g,b], ...] in 0..255.
export function errorDiffuse(data, w, h, { palette, algo, strength = 1, serpentine = true, rgbLevels = 0 }) {
  const n = w * h;
  const buf = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    buf[i * 3] = data[j]; buf[i * 3 + 1] = data[j + 1]; buf[i * 3 + 2] = data[j + 2];
  }
  const quant = quantizer(palette, rgbLevels);
  if (algo === 'riemersma') riemersma(buf, w, h, quant, strength);
  else {
    const [kernel, div] = KERNELS[algo] || KERNELS.floyd;
    const k = strength / div;
    for (let y = 0; y < h; y++) {
      const rev = serpentine && (y & 1);
      for (let xi = 0; xi < w; xi++) {
        const x = rev ? w - 1 - xi : xi;
        const b = (y * w + x) * 3;
        const r = buf[b], g = buf[b + 1], bl = buf[b + 2];
        const q = quant(r, g, bl);
        buf[b] = q[0]; buf[b + 1] = q[1]; buf[b + 2] = q[2];
        const er = (r - q[0]) * k, eg = (g - q[1]) * k, eb = (bl - q[2]) * k;
        for (let t = 0; t < kernel.length; t++) {
          const kk = kernel[t];
          const nx = x + (rev ? -kk[0] : kk[0]), ny = y + kk[1];
          if (nx < 0 || nx >= w || ny >= h) continue;
          const o = (ny * w + nx) * 3, f = kk[2];
          buf[o] += er * f; buf[o + 1] += eg * f; buf[o + 2] += eb * f;
        }
      }
    }
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    data[j] = buf[i * 3]; data[j + 1] = buf[i * 3 + 1]; data[j + 2] = buf[i * 3 + 2];
    data[j + 3] = data[j + 3] >= 128 ? 255 : 0;
  }
}
