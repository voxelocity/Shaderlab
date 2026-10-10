import { EFFECTS, defaultParams } from './effects/index.js';
import { hexToRgb01 } from './gl/glsl.js';

export const state = {
  // live source (never serialised)
  media: null,            // HTMLImageElement | HTMLCanvasElement | HTMLVideoElement
  mediaType: null,        // 'image' | 'video' | 'camera' | null
  mediaName: '',
  mediaKey: 0,
  // document
  doc: { size: 'source', w: 1920, h: 1080, fit: 'cover', bg: '#f4f0e4', transparent: false, textOnly: false },
  effects: [],
  selectedFx: null,
  nextId: 1,
  palette: ['#1a1a1a', '#888888', '#f4f0e4', '#ff3c00', '#3a6ea5', '#f9a03f', '#7b9e57', '#ffffff'],
  paletteSize: 3,
  adjust: { brightness: 0, contrast: 0, saturation: 0, hue: 0, invert: false, grayscale: false },
  texts: [],
  selectedText: null,
};

export function mediaSize() {
  const m = state.media;
  if (!m) return null;
  if (state.mediaType === 'image') return { w: m.naturalWidth || m.width, h: m.naturalHeight || m.height };
  return { w: m.videoWidth || 640, h: m.videoHeight || 480 };
}

export function docSize() {
  const ms = mediaSize();
  if (ms && state.doc.size === 'source') return { w: ms.w, h: ms.h };
  return { w: Math.max(16, state.doc.w | 0), h: Math.max(16, state.doc.h | 0) };
}

// Where the media sits inside the document, in uv space (bottom-left origin).
function mediaRect() {
  const ms = mediaSize();
  const d = docSize();
  if (!ms || state.doc.size === 'source' || state.doc.fit === 'stretch') return [0, 0, 1, 1];
  const am = ms.w / ms.h, ad = d.w / d.h;
  let sw = 1, sh = 1;
  if (state.doc.fit === 'contain') { if (am > ad) sh = ad / am; else sw = am / ad; }
  else { if (am > ad) sw = am / ad; else sh = ad / am; }
  return [(1 - sw) / 2, (1 - sh) / 2, sw, sh];
}

export function activePalette() {
  return state.palette.slice(0, state.paletteSize);
}

export function buildScene(effects = state.effects) {
  const d = docSize();
  const pal = activePalette().map(hexToRgb01);
  const palFlat = new Float32Array(24);
  pal.forEach((c, i) => palFlat.set(c, i * 3));
  const live = state.mediaType === 'camera' || (state.mediaType === 'video' && state.media && !state.media.paused);
  return {
    media: state.media,
    mediaKey: state.mediaKey,
    mediaLive: live,
    mediaRect: mediaRect(),
    docW: d.w, docH: d.h,
    bg: hexToRgb01(state.doc.bg),
    adjust: state.adjust,
    palFlat, palN: pal.length,
    ink: pal[0], paper: pal[pal.length - 1],
    palBytes: pal.map(c => c.map(v => Math.round(v * 255))),
    texts: state.texts,
    effects: effects.filter(f => f.enabled),
  };
}

export function newEffect(type, params = {}) {
  return {
    id: state.nextId++,
    type,
    enabled: true,
    params: { ...defaultParams(type), ...params },
    mix: 1,
    blend: 'normal',
  };
}

export function newTextLayer(over = {}) {
  return {
    id: state.nextId++,
    text: 'TYPE HERE',
    font: 'Anton',
    weight: 400,
    italic: false,
    size: 0.18,
    color: state.palette[0],
    align: 'center',
    tracking: 0.02,
    leading: 1.05,
    x: 0.5, y: 0.5,
    rotation: 0,
    stroke: 0,
    strokeColor: '#ff3c00',
    opacity: 1,
    filtered: true,
    visible: true,
    ...over,
  };
}

// ---------- persistence + undo ----------
const STORE_KEY = 'shaderlab-session-v2';

export function serialize() {
  return {
    v: 2,
    doc: { ...state.doc },
    effects: state.effects.map(({ id, type, enabled, params, mix, blend }) => ({ id, type, enabled, params: { ...params }, mix, blend })),
    nextId: state.nextId,
    palette: [...state.palette],
    paletteSize: state.paletteSize,
    adjust: { ...state.adjust },
    texts: state.texts.map(t => ({ ...t })),
  };
}

export function deserialize(o) {
  if (!o || o.v !== 2) return false;
  Object.assign(state.doc, o.doc || {});
  state.effects = (o.effects || []).filter(e => EFFECTS[e.type]).map(e => ({
    id: e.id, type: e.type, enabled: e.enabled !== false,
    params: { ...defaultParams(e.type), ...e.params },
    mix: e.mix ?? 1, blend: e.blend || 'normal',
  }));
  if (Array.isArray(o.palette)) state.palette = [...o.palette, ...state.palette.slice(o.palette.length)].slice(0, 8);
  state.paletteSize = Math.min(8, Math.max(2, o.paletteSize | 0 || 3));
  Object.assign(state.adjust, o.adjust || {});
  state.texts = (o.texts || []).map(t => newTextLayer(t));
  const ids = [...state.effects.map(e => e.id), ...state.texts.map(t => t.id)];
  state.nextId = Math.max(o.nextId | 0, ...ids, 0) + 1;
  if (!state.effects.some(e => e.id === state.selectedFx)) state.selectedFx = state.effects[0]?.id ?? null;
  if (!state.texts.some(t => t.id === state.selectedText)) state.selectedText = null;
  return true;
}

export function loadSaved() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? deserialize(JSON.parse(raw)) : false;
  } catch { return false; }
}

const history = { stack: [], index: -1, timer: 0, applying: false, pending: null };

export function commit(immediate = false) {
  if (history.applying) return;
  clearTimeout(history.timer);
  const run = () => {
    history.pending = null;
    const snap = JSON.stringify(serialize());
    if (snap === history.stack[history.index]) return;
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(snap);
    if (history.stack.length > 100) history.stack.shift();
    history.index = history.stack.length - 1;
    try { localStorage.setItem(STORE_KEY, snap); } catch { /* storage full or blocked */ }
  };
  if (immediate) run(); else { history.pending = run; history.timer = setTimeout(run, 350); }
}
function flushPending() {
  if (!history.pending) return;
  clearTimeout(history.timer);
  history.pending();
}

function applySnap(snap) {
  history.applying = true;
  try { deserialize(JSON.parse(snap)); } finally { history.applying = false; }
  try { localStorage.setItem(STORE_KEY, snap); } catch { /* ignore */ }
}
export function undo() {
  flushPending();
  if (history.index <= 0) return false;
  history.index--;
  applySnap(history.stack[history.index]);
  return true;
}
export function redo() {
  flushPending();
  if (history.index >= history.stack.length - 1) return false;
  history.index++;
  applySnap(history.stack[history.index]);
  return true;
}
