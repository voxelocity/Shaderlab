// Blue-noise threshold map by progressive void filling: each new point goes where the
// gaussian "energy" of the points already placed is lowest (toroidally), and the order of
// insertion becomes its threshold rank. 64x64 takes a few tens of ms and is built once.

const cache = new Map();

export function blueNoise(size = 64) {
  if (cache.has(size)) return cache.get(size);
  const N = size * size;
  const energy = new Float32Array(N);
  const placed = new Uint8Array(N);
  const rank = new Uint8Array(N);
  const sigma = 1.9, R = 6;
  const kx = [], ky = [], kw = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      kx.push(dx); ky.push(dy); kw.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)));
    }
  }
  let seed = 12345;
  for (let i = 0; i < N; i++) { seed = (seed * 16807) % 2147483647; energy[i] = (seed / 2147483647) * 1e-4; }
  for (let n = 0; n < N; n++) {
    let best = 0, be = Infinity;
    for (let i = 0; i < N; i++) if (!placed[i] && energy[i] < be) { be = energy[i]; best = i; }
    placed[best] = 1;
    rank[best] = Math.floor((n * 256) / N);
    const bx = best % size, by = (best / size) | 0;
    for (let k = 0; k < kw.length; k++) {
      const x = (bx + kx[k] + size) % size, y = (by + ky[k] + size) % size;
      energy[y * size + x] += kw[k];
    }
  }
  cache.set(size, rank);
  return rank;
}
