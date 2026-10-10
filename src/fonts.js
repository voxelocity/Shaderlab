// Font catalogue: Google Fonts presets (loaded lazily, one stylesheet per family so a
// single bad family can't break the rest), system fonts, and user-uploaded files
// (kept in IndexedDB so they survive reloads).

const F = (family, cat, weights = [400]) => ({ family, cat, weights });

export const FONT_CATS = ['all', 'sans', 'display', 'serif', 'mono', 'pixel', 'script', 'gothic', 'weird', 'system', 'yours'];

export const PRESET_FONTS = [
  F('Inter', 'sans', [400, 700, 900]),
  F('Space Grotesk', 'sans', [400, 700]),
  F('Syne', 'sans', [400, 700, 800]),
  F('Unbounded', 'sans', [400, 700, 900]),
  F('Outfit', 'sans', [300, 600, 900]),
  F('Archivo Black', 'sans'),
  F('Anton', 'display'),
  F('Bebas Neue', 'display'),
  F('Bungee', 'display'),
  F('Rubik Mono One', 'display'),
  F('Black Ops One', 'display'),
  F('Righteous', 'display'),
  F('Monoton', 'display'),
  F('Bungee Shade', 'display'),
  F('Shrikhand', 'display'),
  F('Abril Fatface', 'display'),
  F('Playfair Display', 'serif', [400, 700, 900]),
  F('DM Serif Display', 'serif'),
  F('Instrument Serif', 'serif'),
  F('Fraunces', 'serif', [300, 600, 900]),
  F('Cormorant Garamond', 'serif', [400, 700]),
  F('Space Mono', 'mono', [400, 700]),
  F('JetBrains Mono', 'mono', [400, 800]),
  F('IBM Plex Mono', 'mono', [400, 700]),
  F('VT323', 'mono'),
  F('Major Mono Display', 'mono'),
  F('Courier Prime', 'mono', [400, 700]),
  F('Press Start 2P', 'pixel'),
  F('Silkscreen', 'pixel', [400, 700]),
  F('Pixelify Sans', 'pixel', [400, 700]),
  F('DotGothic16', 'pixel'),
  F('Jersey 10', 'pixel'),
  F('Tiny5', 'pixel'),
  F('Sixtyfour', 'pixel'),
  F('Pacifico', 'script'),
  F('Permanent Marker', 'script'),
  F('Caveat', 'script', [400, 700]),
  F('Lobster', 'script'),
  F('Rock Salt', 'script'),
  F('UnifrakturMaguntia', 'gothic'),
  F('Pirata One', 'gothic'),
  F('Grenze Gotisch', 'gothic', [400, 900]),
  F('Rubik Glitch', 'weird'),
  F('Rubik Wet Paint', 'weird'),
  F('Rubik Beastly', 'weird'),
  F('Workbench', 'weird'),
  { family: 'Arial', cat: 'system', weights: [400, 700], system: true },
  { family: 'Georgia', cat: 'system', weights: [400, 700], system: true },
  { family: 'Times New Roman', cat: 'system', weights: [400, 700], system: true },
  { family: 'Courier New', cat: 'system', weights: [400, 700], system: true },
  { family: 'Impact', cat: 'system', weights: [400], system: true },
];

// Families already pulled in by the page stylesheet.
const PRELOADED = new Set(['Space Mono', 'VT323', 'Major Mono Display', 'Anton']);

export const userFonts = [];
export const fontState = { gen: 0 };

const listeners = new Set();
export function onFontsChanged(fn) { listeners.add(fn); }
function bump() {
  fontState.gen++;
  listeners.forEach(fn => fn());
}

export function findFont(family) {
  return userFonts.find(f => f.family === family) || PRESET_FONTS.find(f => f.family === family) || null;
}
export function allFonts() { return [...userFonts, ...PRESET_FONTS]; }
export function fontLabel(family) { return findFont(family)?.label || family; }
export function fontWeights(family) { return findFont(family)?.weights || [400, 700]; }

const cssLoads = new Map();
function cssURL(f) {
  const fam = f.family.replace(/ /g, '+');
  const w = f.weights.length > 1 ? `:wght@${f.weights.join(';')}` : '';
  return `https://fonts.googleapis.com/css2?family=${fam}${w}&display=swap`;
}
export function loadFontCSS(family) {
  const f = PRESET_FONTS.find(x => x.family === family);
  if (!f || f.system || PRELOADED.has(family)) return Promise.resolve();
  if (cssLoads.has(family)) return cssLoads.get(family);
  const p = new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssURL(f);
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
  cssLoads.set(family, p);
  return p;
}
export function loadAllPresetCSS() { PRESET_FONTS.forEach(f => loadFontCSS(f.family)); }

const ready = new Set();
const pending = new Map();
// Returns true when the face is usable right now; otherwise starts loading it and
// bumps fontState.gen (so text/atlas caches redraw) once it arrives.
export function ensureFont(family, weight = 400, italic = false) {
  const key = `${family}|${weight}|${italic ? 1 : 0}`;
  if (ready.has(key)) return true;
  if (!pending.has(key)) {
    const p = (async () => {
      await loadFontCSS(family);
      try { await document.fonts.load(`${italic ? 'italic ' : ''}${weight} 48px "${family}"`); } catch { /* fall back */ }
      ready.add(key);
      pending.delete(key);
      bump();
    })();
    pending.set(key, p);
  }
  return false;
}
export function whenFontReady(family, weight = 400, italic = false) {
  ensureFont(family, weight, italic);
  return pending.get(`${family}|${weight}|${italic ? 1 : 0}`) || Promise.resolve();
}

// ---------- user uploads ----------
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
export function isFontFile(file) {
  return FONT_EXT.test(file.name) || /^font\//.test(file.type) || /font-(ttf|otf|woff)/.test(file.type);
}

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('shaderlab', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('fonts', { keyPath: 'family' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('fonts', mode);
    const out = fn(tx.objectStore('fonts'));
    tx.oncomplete = () => resolve(out?.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function registerFont(family, label, data) {
  const face = new FontFace(family, data);
  await face.load();
  document.fonts.add(face);
  const f = { family, label, cat: 'yours', weights: [400, 700], user: true, face };
  userFonts.unshift(f);
  ready.add(`${family}|400|0`);
  return f;
}

export async function addFontFile(file) {
  const data = await file.arrayBuffer();
  const label = file.name.replace(FONT_EXT, '').slice(0, 48) || 'font';
  const existing = userFonts.find(f => f.label === label);
  if (existing) return existing;
  const family = `SL-${label.replace(/[^\w-]+/g, '_')}-${Date.now().toString(36)}`;
  const f = await registerFont(family, label, data);   // throws on an invalid file
  try { await idbDo('readwrite', s => s.put({ family, label, data })); } catch { /* private mode: session only */ }
  bump();
  return f;
}

export async function removeUserFont(family) {
  const i = userFonts.findIndex(f => f.family === family);
  if (i < 0) return;
  const [f] = userFonts.splice(i, 1);
  try { document.fonts.delete(f.face); } catch { /* ignore */ }
  try { await idbDo('readwrite', s => s.delete(family)); } catch { /* ignore */ }
  bump();
}

export async function restoreUserFonts() {
  let rows = [];
  try {
    const db = await idb();
    rows = await new Promise((resolve, reject) => {
      const req = db.transaction('fonts', 'readonly').objectStore('fonts').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch { return; }
  for (const r of rows) {
    try { await registerFont(r.family, r.label, r.data); } catch { /* corrupt entry: skip */ }
  }
  if (rows.length) bump();
}
