/* ============ SHADER.LAB v0.4 ============ */

import { Renderer } from './gl/renderer.js';
import { EFFECTS, isAnimated, isCpu, defaultParams } from './effects/index.js';
import { BLENDS } from './gl/core.js';
import {
  state, docSize, mediaSize, buildScene, newEffect, newTextLayer, activePalette,
  commit, undo, redo, loadSaved,
} from './state.js';
import { PALETTE_PRESETS } from './presets.js';
import { hexToRgb01 } from './gl/glsl.js';
import { buildControls } from './ui/controls.js';
import { openFontPicker } from './ui/fontpicker.js';
import { openEffectBrowser, openPresetBrowser } from './ui/browser.js';
import { openExport } from './ui/export.js';
import { toast, modalOpen } from './ui/overlay.js';
import { measureLayer, hitTest } from './text.js';
import {
  onFontsChanged, restoreUserFonts, fontLabel, fontWeights, addFontFile, isFontFile, whenFontReady,
} from './fonts.js';
import { medianCut } from './export/quantize.js';

const $ = id => document.getElementById(id);
const stage = $('stage'), canvasBox = $('canvasBox'), view = $('view'), overlay = $('overlay');
const asciiPre = $('asciiPre'), dropHint = $('dropHint'), video = $('video');
const statusLeft = $('statusLeft'), statusRes = $('statusRes'), statusFx = $('statusFx'), statusFps = $('statusFps');

// ---------- renderer ----------
let renderer;
try {
  renderer = new Renderer(view);
} catch (e) {
  stage.innerHTML = `<div class="drop-hint"><div class="big">no webgl2</div><div class="small">${e.message} — try a current chrome, edge, firefox or safari</div></div>`;
  throw e;
}
view.addEventListener('webglcontextlost', e => { e.preventDefault(); setStatus('✗ gpu context lost — restoring'); });
view.addEventListener('webglcontextrestored', () => { renderer = new Renderer(view); requestRender(); setStatus('◆ gpu restored'); });

let dirty = true;
let paused = false;
let started = false;
let previewK = 1;
const requestRender = () => { dirty = true; };
function setStatus(msg) { statusLeft.textContent = msg; }

function liveSource() {
  return state.mediaType === 'camera' || (state.mediaType === 'video' && !video.paused);
}
const anyAnimated = () => state.effects.some(isAnimated);
function lastEnabled() { return [...state.effects].reverse().find(f => f.enabled); }
function asciiTextMode() { const f = lastEnabled(); return !!(f && f.type === 'ascii' && f.params.textMode); }

// ---------- stage layout + preview ----------
let cssScale = 1;
function layoutStage() {
  const narrow = innerWidth < 860;
  const pad = narrow ? 10 : 22;
  const d = docSize();
  if (narrow) {
    // phones: let the stage hug the document instead of a fixed tall box
    const wantH = Math.round(Math.min(innerHeight * 0.62, (stage.clientWidth - pad * 2) * d.h / d.w + pad * 2));
    if (stage.style.height !== `${wantH}px`) stage.style.height = `${wantH}px`;
  } else if (stage.style.height) stage.style.height = '';
  const r = stage.getBoundingClientRect();
  const aw = Math.max(40, r.width - pad * 2), ah = Math.max(40, r.height - pad * 2);
  const s = Math.min(aw / d.w, ah / d.h);
  const cw = Math.max(1, Math.floor(d.w * s)), ch = Math.max(1, Math.floor(d.h * s));
  canvasBox.style.width = `${cw}px`;
  canvasBox.style.height = `${ch}px`;
  cssScale = cw / d.w;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let rw = Math.round(cw * dpr), rh = Math.round(ch * dpr);
  const cap = Math.min(2400, renderer.maxSize);
  const long = Math.max(rw, rh);
  if (long > cap) { rw = Math.round(rw * cap / long); rh = Math.round(rh * cap / long); }
  return { w: Math.max(1, rw), h: Math.max(1, rh) };
}

let time = 0;
function renderPreview(t = time, wantAscii = false, sync = false) {
  if (!started) return;
  time = t;
  const { w, h } = layoutStage();
  previewK = Math.max(w, h) / 1000;
  const textMode = asciiTextMode();
  renderer.render(buildScene(), { w, h, k: previewK, time: t, clear: state.doc.transparent, wantAscii: wantAscii || textMode, sync });
  renderer.present();
  canvasBox.classList.toggle('checker', state.doc.transparent);
  if (textMode) showAsciiPre(); else asciiPre.hidden = true;
  updateOverlay();
  const errored = state.effects.some(f => f._err);
  if (errored) renderStack();
  statusRes.textContent = `${docSize().w}×${docSize().h}`;
}

function showAsciiPre() {
  const fx = lastEnabled();
  const txt = renderer.asciiText || '';
  const lines = txt.split('\n');
  const cols = Math.max(1, lines[0]?.length || 1), rows = Math.max(1, lines.length - 1);
  const pal = activePalette();
  asciiPre.hidden = false;
  asciiPre.textContent = txt;
  const bw = canvasBox.clientWidth - 16, bh = canvasBox.clientHeight - 16;
  asciiPre.style.fontSize = `${Math.max(3, Math.min(14, bw / (cols * 0.6), bh / rows))}px`;
  asciiPre.style.fontFamily = `"${fx.params.font}", "Space Mono", monospace`;
  asciiPre.style.fontWeight = fx.params.bold ? 700 : 400;
  asciiPre.style.color = pal[0];
  asciiPre.style.background = state.doc.transparent ? 'transparent' : pal[pal.length - 1];
}

function getAsciiText() {
  if (!state.effects.some(f => f.enabled && f.type === 'ascii')) return '';
  renderPreview(time, true, true);
  return renderer.asciiText || '';
}

// Small renders for browsers / export preview (main context, isolated from preview state).
function renderThumb(effects, { palette } = {}, w, h) {
  const scene = buildScene(effects);
  if (palette) {
    const pal = palette.map(hexToRgb01);
    const flat = new Float32Array(24);
    pal.forEach((c, i) => flat.set(c, i * 3));
    Object.assign(scene, { palFlat: flat, palN: pal.length, ink: pal[0], paper: pal[pal.length - 1], palBytes: pal.map(c => c.map(v => Math.round(v * 255))) });
  }
  renderer.render(scene, { w, h, k: 0.45, time, clear: state.doc.transparent, isolated: true });
  const pending = renderer.compiling;
  const img = new ImageData(renderer.readResult(), w, h);
  requestRender();
  return pending ? null : img;
}
function previewThumb({ w, h, k, clear, bg }) {
  renderer.render(buildScene(), { w, h, k, time, clear, isolated: true, sync: true });
  const img = new ImageData(renderer.readResult(bg), w, h);
  requestRender();
  return img;
}

// ---------- main loop ----------
let lastTs = 0, fpsAvg = 0, lastStatus = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  if (paused || !started) return;
  const live = liveSource() || anyAnimated();
  if (!dirty && !live) return;
  dirty = false;
  renderPreview(ts / 1000);
  if (renderer.compiling) dirty = true;      // an effect shader is still compiling
  if (live && lastTs) fpsAvg = fpsAvg * 0.9 + (1000 / Math.max(1, ts - lastTs)) * 0.1;
  lastTs = live ? ts : 0;
  if (ts - lastStatus > 300) {
    lastStatus = ts;
    statusFps.textContent = live ? `${Math.round(fpsAvg)} fps` : `${renderer.lastMs.toFixed(1)} ms`;
  }
}
requestAnimationFrame(loop);
new ResizeObserver(() => requestRender()).observe(stage);

// ---------- loading overlay ----------
const SPIN = ['▓▒░ ░▒▓', '▒░ ░▒▓▓', '░ ░▒▓▓▒', ' ░▒▓▓▒░', '░▒▓▓▒░ ', '▒▓▓▒░ ░', '▓▓▒░ ░▒'];
let spinTimer = 0;
function showLoading(label, sub = '') {
  $('loadingLabel').textContent = label;
  $('loadingSub').textContent = sub;
  $('loading').classList.add('visible');
  let i = 0;
  clearInterval(spinTimer);
  spinTimer = setInterval(() => { $('loadingSpinner').textContent = SPIN[i++ % SPIN.length]; }, 90);
}
function hideLoading() { $('loading').classList.remove('visible'); clearInterval(spinTimer); }

// ---------- sources ----------
let objectURL = null;
function startStage() {
  started = true;
  dropHint.hidden = true;
  canvasBox.hidden = false;
  requestRender();
}
function stopSource() {
  if (state.mediaType === 'camera' && video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
  if (state.mediaType === 'video') { video.pause(); video.removeAttribute('src'); video.load(); }
  if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
  state.media = null;
  state.mediaType = null;
}
function setMedia(media, type, name) {
  if (state.doc.textOnly) { state.doc.textOnly = false; state.doc.size = 'source'; }
  state.media = media;
  state.mediaType = type;
  state.mediaName = name;
  state.mediaKey++;
  startStage();
  syncSourceUI();
  buildCanvasPanel();
  renderTextEditor();
  commit();
}

function fitImage(img) {
  const max = renderer.maxSize;
  const w = img.naturalWidth, h = img.naturalHeight;
  if (Math.max(w, h) <= max) return img;
  const s = max / Math.max(w, h);
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function loadImageFile(file) {
  showLoading('loading image', file.name.slice(0, 28));
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    stopSource();
    objectURL = url;
    setMedia(fitImage(img), 'image', file.name);
    setStatus('◆ image loaded');
    hideLoading();
  };
  img.onerror = () => { URL.revokeObjectURL(url); hideLoading(); setStatus('✗ could not read that image'); };
  img.src = url;
}

function loadVideoFile(file) {
  stopSource();
  showLoading('loading video', file.name.slice(0, 28));
  objectURL = URL.createObjectURL(file);
  video.srcObject = null;
  video.src = objectURL;
  video.loop = true;
  video.onloadeddata = () => {
    video.play().catch(() => {});
    setMedia(video, 'video', file.name);
    setStatus('▶ video playing');
    hideLoading();
  };
  video.onerror = () => { hideLoading(); setStatus('✗ video failed to load'); };
}

async function startCamera() {
  try {
    showLoading('starting webcam', 'allow camera access');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    stopSource();
    video.src = '';
    video.srcObject = stream;
    await video.play();
    setMedia(video, 'camera', 'webcam');
    setStatus('◉ webcam active');
  } catch {
    setStatus('✗ webcam unavailable or denied');
  } finally { hideLoading(); }
}

function loadDemo() {
  const W = 1280, H = 800;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#1a3a5c'); sky.addColorStop(0.5, '#d4846b'); sky.addColorStop(1, '#f4c869');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const sun = g.createRadialGradient(960, 300, 16, 960, 300, 200);
  sun.addColorStop(0, '#fff6dd'); sun.addColorStop(0.35, 'rgba(255,226,170,0.9)'); sun.addColorStop(1, 'rgba(255,220,150,0)');
  g.fillStyle = sun; g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff3d6';
  g.beginPath(); g.arc(960, 300, 70, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 90; i++) { g.globalAlpha = 0.4 + rnd() * 0.6; g.beginPath(); g.arc(rnd() * W, rnd() * 300, rnd() * 1.8 + 0.4, 0, Math.PI * 2); g.fill(); }
  g.globalAlpha = 1;
  const ridge = (base, a1, f1, a2, f2, ph, color) => {
    g.fillStyle = color;
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, base + Math.sin(x * f1 + ph) * a1 + Math.sin(x * f2) * a2);
    g.lineTo(W, H); g.closePath(); g.fill();
  };
  ridge(520, 70, 0.015, 24, 0.05, 0, '#3b3060');
  ridge(600, 50, 0.022, 18, 0.07, 1.4, '#2a2a4a');
  ridge(670, 34, 0.03, 10, 0.11, 3.1, '#0a0a1a');
  g.strokeStyle = 'rgba(255,200,140,0.35)';
  g.lineWidth = 2;
  for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(780 + i * 8, 300 + 120 + i * 30); g.lineTo(1140 - i * 8, 300 + 120 + i * 30); g.stroke(); }
  stopSource();
  setMedia(c, 'image', 'demo scene');
  setStatus('◆ demo loaded');
}

function textOnly() {
  stopSource();
  state.doc.size = 'custom';
  state.doc.textOnly = true;
  if (!state.texts.length) {
    const t = newTextLayer({ text: 'SHADER\nLAB', size: 0.34, leading: 0.9, color: activePalette()[0] });
    state.texts.push(t);
    state.selectedText = t.id;
  } else if (state.selectedText == null) {
    state.selectedText = state.texts[state.texts.length - 1].id;
  }
  state.mediaName = '';
  startStage();
  syncSourceUI();
  buildCanvasPanel();
  renderTextList();
  renderTextEditor();
  setStatus('Aa text canvas');
  commit();
}

function syncSourceUI() {
  const ms = mediaSize();
  const d = docSize();
  $('sourceInfo').textContent = state.mediaType
    ? `${state.mediaType} · ${state.mediaName} · ${ms.w}×${ms.h}`
    : `text-only canvas · ${d.w}×${d.h}`;
  $('videoCtl').hidden = state.mediaType !== 'video';
  $('playBtn').textContent = video.paused ? '▶ play' : '❚❚ pause';
}

$('imgBtn').addEventListener('click', () => $('imgInput').click());
$('vidBtn').addEventListener('click', () => $('vidInput').click());
$('imgInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadImageFile(f); e.target.value = ''; });
$('vidInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadVideoFile(f); e.target.value = ''; });
$('camBtn').addEventListener('click', startCamera);
$('demoBtn').addEventListener('click', loadDemo);
$('textOnlyBtn').addEventListener('click', textOnly);
$('playBtn').addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); syncSourceUI(); requestRender(); });
$('restartBtn').addEventListener('click', () => { video.currentTime = 0; video.play(); syncSourceUI(); });

// ---------- canvas panel ----------
const SIZE_PRESETS = [['1:1', 1080, 1080], ['4:5', 1080, 1350], ['9:16', 1080, 1920], ['16:9', 1920, 1080], ['3:2', 1800, 1200], ['banner', 1500, 500]];
let canvasCtl = null;
function buildCanvasPanel() {
  const hasMedia = !!state.media;
  const schema = [
    { key: 'size', label: 'size', type: 'seg', options: [['source', 'match source'], ['custom', 'custom']], show: () => hasMedia },
    {
      key: 'dims', type: 'custom', show: d => !hasMedia || d.size === 'custom',
      render(row, d, changed) {
        row.innerHTML = `<div class="chips" style="margin-bottom:8px"></div>
          <div class="dims"><input type="number" min="16" max="8192" aria-label="canvas width"><span>×</span><input type="number" min="16" max="8192" aria-label="canvas height"></div>`;
        const chips = row.querySelector('.chips');
        const [wi, hi] = row.querySelectorAll('input');
        SIZE_PRESETS.forEach(([name, w, h]) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'chip'; b.textContent = name; b.title = `${w}×${h}`;
          b.addEventListener('click', () => { d.w = w; d.h = h; changed(true); sync(); });
          chips.append(b);
        });
        const onIn = () => {
          d.w = Math.max(16, Math.min(8192, parseInt(wi.value, 10) || d.w));
          d.h = Math.max(16, Math.min(8192, parseInt(hi.value, 10) || d.h));
          changed(true);
        };
        wi.addEventListener('change', onIn);
        hi.addEventListener('change', onIn);
        [wi, hi].forEach(i => i.addEventListener('keydown', e => e.stopPropagation()));
        const sync = () => {
          wi.value = d.w; hi.value = d.h;
          chips.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('active', SIZE_PRESETS[i][1] === d.w && SIZE_PRESETS[i][2] === d.h));
        };
        return sync;
      },
    },
    { key: 'fit', label: 'fit media', type: 'seg', options: [['cover', 'cover'], ['contain', 'contain'], ['stretch', 'stretch']], show: d => hasMedia && d.size === 'custom' },
    { key: 'transparent', label: 'transparent background', type: 'toggle' },
    { key: 'bg', label: 'background colour', type: 'color', show: d => !d.transparent },
  ];
  canvasCtl = buildControls($('canvasBody'), schema, state.doc, (key, final) => {
    requestRender();
    syncSourceUI();
    if (key === 'size' || key === 'dims') canvasCtl?.refresh();
    if (final) commit();
  });
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'transparent also makes effect “paper” (halftone, ascii, threshold…) see-through.';
  $('canvasBody').append(hint);
}

// ---------- text layers ----------
function selectedText() { return state.texts.find(t => t.id === state.selectedText) || null; }

function makeSortable(list, items, getId, onMove) {
  list.querySelectorAll('.stack-item').forEach(item => {
    item.draggable = true;
    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-shaderlab', item.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.stack-item').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
    });
    item.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/x-shaderlab')) return;
      e.preventDefault();
      e.stopPropagation();
      const r = item.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      list.querySelectorAll('.stack-item').forEach(el => { if (el !== item) el.classList.remove('drag-over-top', 'drag-over-bottom'); });
      item.classList.toggle('drag-over-top', above);
      item.classList.toggle('drag-over-bottom', !above);
    });
    item.addEventListener('drop', e => {
      const raw = e.dataTransfer.getData('text/x-shaderlab');
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      const fromId = +raw, toId = +item.dataset.id;
      if (fromId === toId) return;
      const r = item.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      const from = items.findIndex(x => getId(x) === fromId);
      if (from < 0) return;
      const [moved] = items.splice(from, 1);
      let to = items.findIndex(x => getId(x) === toId);
      if (!above) to++;
      items.splice(to, 0, moved);
      onMove();
    });
  });
}

function renderTextList() {
  const list = $('textList');
  list.innerHTML = '';
  $('textNum').textContent = state.texts.length ? `/ 03 · ${state.texts.length}` : '/ 03';
  if (!state.texts.length) {
    list.innerHTML = '<div class="stack-empty">no text — add a layer, then drag it on the canvas</div>';
    return;
  }
  // top-most layer first, like a layers panel
  [...state.texts].reverse().forEach(L => {
    const item = document.createElement('div');
    item.className = 'stack-item' + (L.id === state.selectedText ? ' selected' : '') + (L.visible ? '' : ' disabled');
    item.dataset.id = L.id;
    item.innerHTML = `<span class="drag-handle">⋮⋮</span><span class="stack-name"></span>
      <span class="fx-badge ${L.filtered ? 'gpu' : 'cpu'}" title="${L.filtered ? 'effects apply to this text' : 'drawn on top of the effects'}">${L.filtered ? 'fx' : 'top'}</span>
      <span class="stack-actions">
        <button class="stack-btn" data-a="vis" title="${L.visible ? 'hide' : 'show'}">${L.visible ? '●' : '○'}</button>
        <button class="stack-btn" data-a="del" title="delete">✕</button>
      </span>`;
    const first = String(L.text).split('\n').find(s => s.trim()) || '(empty)';
    item.querySelector('.stack-name').textContent = `T ${first}`;
    item.querySelector('.stack-name').style.fontFamily = `"${L.font}", "VT323", monospace`;
    item.addEventListener('click', e => {
      if (e.target.closest('.stack-btn')) return;
      state.selectedText = L.id;
      renderTextList(); renderTextEditor(); updateOverlay();
    });
    item.querySelectorAll('.stack-btn').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      if (b.dataset.a === 'vis') L.visible = !L.visible;
      else deleteText(L.id);
      renderTextList(); renderTextEditor(); requestRender(); commit();
    }));
    list.append(item);
  });
  // list is displayed reversed, so reorder against a reversed copy then flip back
  const rev = [...state.texts].reverse();
  makeSortable(list, rev, x => x.id, () => {
    state.texts = rev.reverse();
    renderTextList(); requestRender(); commit();
  });
}

function deleteText(id) {
  state.texts = state.texts.filter(t => t.id !== id);
  if (state.selectedText === id) state.selectedText = state.texts[state.texts.length - 1]?.id ?? null;
}

const WEIGHT_NAMES = { 100: 'thin', 200: 'xlight', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semi', 700: 'bold', 800: 'xbold', 900: 'black' };
let textCtl = null;
function renderTextEditor() {
  const box = $('textEditor');
  const L = selectedText();
  if (!L) { box.innerHTML = ''; textCtl = null; return; }
  const d = docSize();
  const schema = [
    { key: 'text', label: 'text', type: 'text' },
    {
      key: 'font', label: 'font', type: 'custom',
      render(row, obj, changed) {
        row.innerHTML = '<label>font</label><button class="font-btn" type="button"><span class="fname"></span><span class="caret">change ▾</span></button>';
        const btn = row.querySelector('.font-btn');
        btn.addEventListener('click', () => openFontPicker(btn, {
          current: obj.font,
          sample: obj.text,
          onPick: fam => {
            obj.font = fam;
            const ws = fontWeights(fam);
            if (!ws.includes(obj.weight) && obj.weight !== 700) obj.weight = ws.includes(400) ? 400 : ws[0];
            whenFontReady(fam, obj.weight, obj.italic).then(requestRender);
            changed(true);
            textCtl?.refresh();
            renderTextList();
          },
        }));
        return () => {
          const n = row.querySelector('.fname');
          n.textContent = fontLabel(obj.font);
          n.style.fontFamily = `"${obj.font}", "Space Mono", sans-serif`;
        };
      },
    },
    {
      key: 'weight', label: 'weight', type: 'custom',
      render(row, obj, changed) {
        row.innerHTML = '<label>weight</label><div class="segmented"></div>';
        const seg = row.querySelector('.segmented');
        return () => {
          const ws = [...new Set([...fontWeights(obj.font), 700])].sort((a, b) => a - b);
          seg.innerHTML = '';
          ws.forEach(w => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = WEIGHT_NAMES[w] || w;
            b.title = fontWeights(obj.font).includes(w) ? `${w}` : `${w} (synthesised)`;
            b.classList.toggle('active', obj.weight === w);
            b.addEventListener('click', () => { obj.weight = w; whenFontReady(obj.font, w, obj.italic).then(requestRender); changed(true); textCtl?.refresh(); });
            seg.append(b);
          });
        };
      },
    },
    { key: 'italic', label: 'italic', type: 'toggle' },
    { key: 'sizePx', label: 'size', type: 'range', min: 6, max: Math.max(60, Math.round(d.h * 0.8)), step: 1, unit: 'px', hardMax: d.h * 4, get: o => Math.round(o.size * docSize().h), set: (o, v) => { o.size = v / docSize().h; } },
    {
      key: 'color', label: 'colour', type: 'custom',
      render(row, obj, changed) {
        row.innerHTML = '<label>colour</label><div class="color-pair"><input type="color" aria-label="text colour"><div class="palette-swatches"></div></div>';
        const c = row.querySelector('input');
        const sw = row.querySelector('.palette-swatches');
        c.addEventListener('input', () => { obj.color = c.value; changed(false); });
        c.addEventListener('change', () => changed(true));
        return () => {
          c.value = obj.color;
          sw.innerHTML = '';
          activePalette().forEach(hex => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'palette-preset';
            b.style.height = '32px';
            b.style.background = hex;
            b.title = `use ${hex}`;
            b.addEventListener('click', () => { obj.color = hex; c.value = hex; changed(true); });
            sw.append(b);
          });
        };
      },
    },
    { key: 'align', label: 'align', type: 'seg', options: [['left', 'left'], ['center', 'centre'], ['right', 'right']] },
    { key: 'tracking', label: 'letter spacing', type: 'range', min: -0.2, max: 1, step: 0.005, fmt: v => `${v.toFixed(3)}em` },
    { key: 'leading', label: 'line height', type: 'range', min: 0.6, max: 3, step: 0.01, fmt: v => `${v.toFixed(2)}×` },
    { key: 'rotation', label: 'rotation', type: 'range', min: -180, max: 180, step: 1, fmt: v => `${Math.round(v)}°` },
    { key: 'stroke', label: 'outline', type: 'range', min: 0, max: 0.25, step: 0.0025, fmt: v => v ? `${Math.max(1, Math.round(v * (selectedText()?.size || 0) * docSize().h))}px` : 'off' },
    { key: 'strokeColor', label: 'outline colour', type: 'color', show: o => o.stroke > 0 },
    { key: 'opacity', label: 'opacity', type: 'range', min: 0, max: 1, step: 0.01, fmt: v => `${Math.round(v * 100)}%` },
    { key: 'filtered', label: 'apply effects to this text', type: 'toggle' },
    { sep: 'position' },
    { key: 'x', label: 'x', type: 'range', min: -0.25, max: 1.25, step: 0.001, fmt: v => `${Math.round(v * 100)}%` },
    { key: 'y', label: 'y', type: 'range', min: -0.25, max: 1.25, step: 0.001, fmt: v => `${Math.round(v * 100)}%` },
  ];
  textCtl = buildControls(box, schema, L, (key, final) => {
    requestRender();
    if (key === 'text' || key === 'filtered') renderTextList();
    if (final) commit();
  });
  const btns = document.createElement('div');
  btns.className = 'btn-row three control-group';
  btns.style.marginTop = '14px';
  btns.innerHTML = '<button class="btn alt small" data-a="center">⊕ centre</button><button class="btn alt small" data-a="dup">⧉ duplicate</button><button class="btn alt small" data-a="del">✕ delete</button>';
  btns.querySelector('[data-a=center]').addEventListener('click', () => { L.x = 0.5; L.y = 0.5; textCtl.refresh(); requestRender(); commit(); });
  btns.querySelector('[data-a=dup]').addEventListener('click', () => {
    const copy = newTextLayer({ ...L, id: undefined, x: Math.min(1, L.x + 0.03), y: Math.min(1, L.y + 0.03) });
    copy.id = state.nextId++;
    state.texts.push(copy);
    state.selectedText = copy.id;
    renderTextList(); renderTextEditor(); requestRender(); commit();
  });
  btns.querySelector('[data-a=del]').addEventListener('click', () => {
    deleteText(L.id);
    renderTextList(); renderTextEditor(); requestRender(); commit();
  });
  box.append(btns);
}

function addText(over = {}) {
  if (!started) textOnly();
  const t = newTextLayer({ color: activePalette()[0], ...over });
  t.font = over.font || t.font;
  state.texts.push(t);
  state.selectedText = t.id;
  whenFontReady(t.font, t.weight, t.italic).then(requestRender);
  renderTextList(); renderTextEditor(); requestRender(); commit();
  setTimeout(() => $('textEditor').querySelector('textarea')?.select(), 0);
}
$('addTextBtn').addEventListener('click', () => addText());

// ---------- on-canvas text handles ----------
const selBox = document.createElement('div');
selBox.className = 'sel-box';
selBox.innerHTML = '<div class="sel-handle rotate" data-h="rotate" title="rotate"></div><div class="sel-handle resize" data-h="resize" title="resize"></div>';
selBox.hidden = true;
overlay.append(selBox);

function updateOverlay() {
  overlay.classList.toggle('has-text', state.texts.length > 0);
  const L = selectedText();
  if (!L || !L.visible || !started) { selBox.hidden = true; return; }
  const d = docSize();
  const { w, h } = measureLayer(L, d.w, d.h);
  selBox.hidden = false;
  selBox.style.width = `${w * cssScale}px`;
  selBox.style.height = `${h * cssScale}px`;
  selBox.style.left = `${(L.x * d.w - w / 2) * cssScale}px`;
  selBox.style.top = `${(L.y * d.h - h / 2) * cssScale}px`;
  selBox.style.transform = `rotate(${L.rotation || 0}deg)`;
}

function docPoint(e) {
  const r = canvasBox.getBoundingClientRect();
  return { x: (e.clientX - r.left) / cssScale, y: (e.clientY - r.top) / cssScale };
}
let drag = null;
overlay.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const d = docSize();
  const p = docPoint(e);
  const handle = e.target.dataset?.h;
  let L = handle ? selectedText() : hitTest(state.texts, d.w, d.h, p.x, p.y);
  if (!L) {
    if (state.selectedText != null) { state.selectedText = null; renderTextList(); renderTextEditor(); updateOverlay(); }
    return;
  }
  if (state.selectedText !== L.id) { state.selectedText = L.id; renderTextList(); renderTextEditor(); }
  const cx = L.x * d.w, cy = L.y * d.h;
  drag = {
    L, mode: handle || 'move', start: p, x0: L.x, y0: L.y, size0: L.size, rot0: L.rotation || 0,
    dist0: Math.hypot(p.x - cx, p.y - cy) || 1, ang0: Math.atan2(p.y - cy, p.x - cx), moved: false,
  };
  overlay.setPointerCapture(e.pointerId);
  e.preventDefault();
});
overlay.addEventListener('pointermove', e => {
  const d = docSize();
  const p = docPoint(e);
  if (!drag) {
    overlay.style.cursor = hitTest(state.texts, d.w, d.h, p.x, p.y) ? 'move' : '';
    return;
  }
  const { L } = drag;
  drag.moved = true;
  if (drag.mode === 'move') {
    let x = drag.x0 + (p.x - drag.start.x) / d.w, y = drag.y0 + (p.y - drag.start.y) / d.h;
    if (!e.altKey) {                                   // soft snap to centre lines
      if (Math.abs(x - 0.5) < 6 / (d.w * cssScale)) x = 0.5;
      if (Math.abs(y - 0.5) < 6 / (d.h * cssScale)) y = 0.5;
    }
    L.x = x; L.y = y;
  } else if (drag.mode === 'resize') {
    const dist = Math.hypot(p.x - L.x * d.w, p.y - L.y * d.h);
    L.size = Math.max(4 / d.h, drag.size0 * dist / drag.dist0);
  } else {
    let a = drag.rot0 + (Math.atan2(p.y - L.y * d.h, p.x - L.x * d.w) - drag.ang0) * 180 / Math.PI;
    a = ((a + 540) % 360) - 180;
    if (e.shiftKey) a = Math.round(a / 15) * 15;
    L.rotation = Math.round(a * 10) / 10;
  }
  textCtl?.refresh();
  updateOverlay();
  requestRender();
});
const endDrag = () => { if (drag?.moved) commit(); drag = null; };
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);
overlay.addEventListener('dblclick', () => { const ta = $('textEditor').querySelector('textarea'); if (ta) { ta.focus(); ta.select(); } });

// ---------- effect stack ----------
function renderStack() {
  const wrap = $('effectStack');
  wrap.innerHTML = '';
  statusFx.textContent = `${state.effects.filter(f => f.enabled).length} fx`;
  const cpu = state.effects.some(f => f.enabled && isCpu(f));
  $('rendererBadge').textContent = cpu ? 'gpu+cpu' : 'gpu';
  if (!state.effects.length) {
    wrap.innerHTML = '<div class="stack-empty">no effects — add one below</div>';
    return;
  }
  state.effects.forEach((fx, idx) => {
    const def = EFFECTS[fx.type];
    const item = document.createElement('div');
    item.className = 'stack-item' + (fx.id === state.selectedFx ? ' selected' : '') + (fx.enabled ? '' : ' disabled') + (fx._err ? ' errored' : '');
    item.dataset.id = fx.id;
    const c = isCpu(fx);
    item.innerHTML = `<span class="drag-handle">⋮⋮</span><span class="stack-name"></span>
      <span class="fx-badge ${c ? 'cpu' : 'gpu'}">${c ? 'cpu' : 'gpu'}</span>
      <span class="stack-actions">
        <button class="stack-btn" data-a="toggle" title="${fx.enabled ? 'disable' : 'enable'}">${fx.enabled ? '●' : '○'}</button>
        <button class="stack-btn" data-a="up" title="move up">▲</button>
        <button class="stack-btn" data-a="down" title="move down">▼</button>
        <button class="stack-btn" data-a="remove" title="remove">✕</button>
      </span>`;
    const nm = item.querySelector('.stack-name');
    nm.textContent = `${def.icon} ${def.name}`;
    if (fx._err) nm.title = fx._err;
    item.addEventListener('click', e => {
      if (e.target.closest('.stack-btn')) return;
      state.selectedFx = fx.id;
      renderStack(); renderParams();
    });
    item.querySelectorAll('.stack-btn').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const a = b.dataset.a;
      if (a === 'toggle') fx.enabled = !fx.enabled;
      else if (a === 'up' && idx > 0) [state.effects[idx - 1], state.effects[idx]] = [state.effects[idx], state.effects[idx - 1]];
      else if (a === 'down' && idx < state.effects.length - 1) [state.effects[idx + 1], state.effects[idx]] = [state.effects[idx], state.effects[idx + 1]];
      else if (a === 'remove') {
        state.effects.splice(idx, 1);
        if (state.selectedFx === fx.id) state.selectedFx = state.effects[Math.min(idx, state.effects.length - 1)]?.id ?? null;
      }
      renderStack(); renderParams(); requestRender(); commit();
    }));
    wrap.append(item);
  });
  makeSortable(wrap, state.effects, x => x.id, () => { renderStack(); requestRender(); commit(); });
}

let paramsCtl = null;
function renderParams() {
  const body = $('paramsBody');
  const fx = state.effects.find(f => f.id === state.selectedFx);
  if (!fx) {
    body.innerHTML = '<div class="stack-empty">select an effect to edit its parameters</div>';
    $('paramsNum').textContent = '/ —';
    paramsCtl = null;
    return;
  }
  const def = EFFECTS[fx.type];
  $('paramsNum').textContent = `/ ${def.name}`;
  body.innerHTML = '';
  const main = document.createElement('div');
  const blend = document.createElement('div');
  body.append(main, blend);
  if (def.paper) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.style.marginTop = '0';
    h.style.marginBottom = '12px';
    h.textContent = 'draws palette ink on paper (the last palette colour). with a transparent canvas the paper is see-through.';
    main.before(h);
  }
  paramsCtl = buildControls(main, def.params, fx.params, (key, final) => {
    requestRender();
    if (final) { commit(); if (key === 'algorithm' || key === 'textMode') renderStack(); }
  });
  const blendSchema = [
    { sep: 'blend with layer below' },
    { key: 'mix', label: 'mix', type: 'range', min: 0, max: 1, step: 0.01, def: 1, fmt: v => `${Math.round(v * 100)}%` },
    { key: 'blend', label: 'blend mode', type: 'select', options: BLENDS },
  ];
  buildControls(blend, blendSchema, fx, (key, final) => { requestRender(); if (final) commit(); });
  const btns = document.createElement('div');
  btns.className = 'btn-row control-group';
  btns.style.marginTop = '14px';
  btns.innerHTML = '<button class="btn alt small" data-a="reset">↺ reset</button><button class="btn alt small" data-a="dup">⧉ duplicate</button>';
  btns.querySelector('[data-a=reset]').addEventListener('click', () => {
    fx.params = defaultParams(fx.type); fx.mix = 1; fx.blend = 'normal';
    renderParams(); renderStack(); requestRender(); commit();
  });
  btns.querySelector('[data-a=dup]').addEventListener('click', () => {
    const copy = newEffect(fx.type, JSON.parse(JSON.stringify(fx.params)));
    copy.mix = fx.mix; copy.blend = fx.blend;
    state.effects.splice(state.effects.indexOf(fx) + 1, 0, copy);
    state.selectedFx = copy.id;
    renderStack(); renderParams(); requestRender(); commit();
  });
  body.append(btns);
}

function addEffect(type) {
  const fx = newEffect(type);
  state.effects.push(fx);
  state.selectedFx = fx.id;
  renderStack(); renderParams(); requestRender(); commit();
}
const thumbAspect = () => { const d = docSize(); return d.w / d.h; };
$('addFxBtn').addEventListener('click', () => openEffectBrowser({ renderThumb, aspect: thumbAspect(), transparent: state.doc.transparent, onPick: addEffect }));
$('presetsBtn').addEventListener('click', () => openPresetBrowser({
  renderThumb, aspect: thumbAspect(), transparent: state.doc.transparent,
  onPick: preset => {
    state.effects = preset.stack.map(([type, params]) => newEffect(type, params));
    if (preset.palette) { preset.palette.forEach((c, i) => { state.palette[i] = c; }); state.paletteSize = preset.palette.length; syncPalette(); }
    state.selectedFx = state.effects[0]?.id ?? null;
    renderStack(); renderParams(); requestRender(); commit();
    toast(`preset: ${preset.name}`);
  },
}));
$('clearFxBtn').addEventListener('click', () => {
  state.effects = [];
  state.selectedFx = null;
  renderStack(); renderParams(); requestRender(); commit();
});

// ---------- palette ----------
function syncPalette() {
  const seg = $('paletteSize');
  seg.innerHTML = '';
  for (let n = 2; n <= 8; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = n === 2 ? '1-bit' : n;
    b.classList.toggle('active', n === state.paletteSize);
    b.addEventListener('click', () => { state.paletteSize = n; syncPalette(); requestRender(); commit(); });
    seg.append(b);
  }
  const sw = $('swatches');
  sw.innerHTML = '';
  activePalette().forEach((color, i) => {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = color;
    input.title = i === 0 ? 'ink' : i === state.paletteSize - 1 ? 'paper' : `colour ${i + 1}`;
    input.addEventListener('input', () => { state.palette[i] = input.value; requestRender(); });
    input.addEventListener('change', () => { commit(); textCtl?.refresh(); });
    sw.append(input);
  });
  textCtl?.refresh();
}
function buildPalettePresets() {
  const wrap = $('palettePresets');
  PALETTE_PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'palette-preset';
    b.title = p.name;
    p.colors.forEach(c => { const d = document.createElement('div'); d.style.background = c; b.append(d); });
    const nm = document.createElement('div');
    nm.className = 'palette-preset-name';
    nm.textContent = p.name;
    b.append(nm);
    b.addEventListener('click', () => {
      p.colors.forEach((c, i) => { state.palette[i] = c; });
      state.paletteSize = Math.max(2, Math.min(p.colors.length, 8));
      syncPalette(); requestRender(); commit();
    });
    wrap.append(b);
  });
}
$('palReverse').addEventListener('click', () => {
  const n = state.paletteSize;
  const rev = state.palette.slice(0, n).reverse();
  rev.forEach((c, i) => { state.palette[i] = c; });
  syncPalette(); requestRender(); commit();
});
$('palFromImg').addEventListener('click', () => {
  if (!started) return;
  const d = docSize();
  const w = 128, h = Math.max(8, Math.round(128 * d.h / d.w));
  renderer.render(buildScene([]), { w, h, k: 0.1, time, clear: true, isolated: true });
  const data = renderer.readResult();
  const cols = medianCut(data, state.paletteSize)
    .sort((a, b) => (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]) - (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2]));
  cols.forEach((c, i) => { state.palette[i] = '#' + c.map(v => v.toString(16).padStart(2, '0')).join(''); });
  if (cols.length < state.paletteSize) state.paletteSize = Math.max(2, cols.length);
  syncPalette(); requestRender(); commit();
  toast('◎ palette taken from the image');
});

// ---------- adjust ----------
const ADJUST_SCHEMA = [
  { key: 'brightness', label: 'brightness', type: 'range', min: -100, max: 100, step: 1, def: 0 },
  { key: 'contrast', label: 'contrast', type: 'range', min: -100, max: 100, step: 1, def: 0 },
  { key: 'saturation', label: 'saturation', type: 'range', min: -100, max: 100, step: 1, def: 0 },
  { key: 'hue', label: 'hue', type: 'range', min: -180, max: 180, step: 1, def: 0, fmt: v => `${v}°` },
  { key: 'invert', label: 'invert colours', type: 'toggle' },
  { key: 'grayscale', label: 'grayscale input', type: 'toggle' },
];
let adjustCtl = buildControls($('adjustBody'), ADJUST_SCHEMA, state.adjust, (k, final) => { requestRender(); if (final) commit(); });

// ---------- export row ----------
const exportApp = {
  state, docSize, buildScene,
  time: () => time,
  previewThumb,
  asciiText: getAsciiText,
  hasAnimation: anyAnimated,
  hasAscii: () => state.effects.some(f => f.enabled && f.type === 'ascii'),
  effectCount: () => state.effects.filter(f => f.enabled).length,
  setPaused: v => { paused = v; if (!v) requestRender(); },
};
function openExportDialog() {
  if (!started) { toast('load something first'); return; }
  openExport(exportApp);
}
$('exportBtn').addEventListener('click', openExportDialog);

$('copyBtn').addEventListener('click', async () => {
  if (!started) return;
  try {
    if (asciiTextMode()) {
      await navigator.clipboard.writeText(getAsciiText());
      toast('✓ ascii text copied');
      return;
    }
    renderPreview(time, false, true);
    const r = renderer.result;
    const data = renderer.readResult();
    const c = document.createElement('canvas');
    c.width = r.w; c.height = r.h;
    c.getContext('2d').putImageData(new ImageData(data, r.w, r.h), 0, 0);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('✓ image copied (preview size)');
  } catch {
    toast('✗ clipboard blocked — use export instead');
  }
});

let recorder = null;
$('recBtn').addEventListener('click', () => {
  const btn = $('recBtn');
  if (recorder) { recorder.stop(); return; }
  if (!started || typeof MediaRecorder === 'undefined') { toast('recording not supported here'); return; }
  const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m));
  const stream = view.captureStream(30);
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    const type = mime.split(';')[0];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, { type }));
    a.download = `shaderlab-rec-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 15000);
    recorder = null;
    btn.textContent = '● rec';
    btn.classList.remove('recording');
  };
  recorder.start(250);
  btn.textContent = '■ stop';
  btn.classList.add('recording');
  toast('recording the preview — press stop when done');
});

function doUndo(r = false) {
  if (!(r ? redo() : undo())) { toast(r ? 'nothing to redo' : 'nothing to undo'); return; }
  syncAll();
  requestRender();
}
$('undoBtn').addEventListener('click', () => doUndo(false));

function syncAll() {
  renderStack();
  renderParams();
  syncPalette();
  adjustCtl = buildControls($('adjustBody'), ADJUST_SCHEMA, state.adjust, (k, final) => { requestRender(); if (final) commit(); });
  buildCanvasPanel();
  renderTextList();
  renderTextEditor();
  syncSourceUI();
}

// ---------- drag & drop / paste ----------
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; dragDepth++; stage.classList.add('drag-over'); });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; stage.classList.remove('drag-over'); } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  stage.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});
async function handleFiles(files) {
  for (const f of files) {
    if (isFontFile(f)) {
      try {
        const font = await addFontFile(f);
        const L = selectedText();
        if (L) { L.font = font.family; renderTextEditor(); renderTextList(); requestRender(); commit(); }
        else addText({ font: font.family, text: font.label.toUpperCase() });
        toast(`✓ font added: ${font.label}`);
      } catch { toast('✗ could not read that font'); }
    } else if (f.type.startsWith('image/')) { loadImageFile(f); return; }
    else if (f.type.startsWith('video/')) { loadVideoFile(f); return; }
  }
}
const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
};
addEventListener('paste', e => {
  if (typing() || modalOpen()) return;
  const items = [...(e.clipboardData?.items || [])];
  const img = items.find(i => i.type.startsWith('image/'));
  if (img) { e.preventDefault(); loadImageFile(img.getAsFile()); return; }
  const text = e.clipboardData?.getData('text/plain');
  if (text && text.trim()) { e.preventDefault(); addText({ text: text.slice(0, 500) }); }
});

// ---------- keyboard ----------
addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); if (!modalOpen()) openExportDialog(); return; }
  if (modalOpen() || typing()) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(e.shiftKey); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doUndo(true); return; }
  const L = selectedText();
  if (!L) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteText(L.id);
    renderTextList(); renderTextEditor(); requestRender(); commit();
  } else if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const d = docSize();
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') L.x -= step / d.w;
    if (e.key === 'ArrowRight') L.x += step / d.w;
    if (e.key === 'ArrowUp') L.y -= step / d.h;
    if (e.key === 'ArrowDown') L.y += step / d.h;
    textCtl?.refresh(); requestRender(); commit();
  } else if (e.key === 'Escape') {
    state.selectedText = null;
    renderTextList(); renderTextEditor(); updateOverlay();
  }
});

// ---------- theme ----------
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('themeThumb').textContent = theme === 'dark' ? '☾' : '☼';
  try { localStorage.setItem('shaderlab-theme', theme); } catch { /* ignore */ }
}
const flipTheme = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
$('themeSwitch').addEventListener('click', flipTheme);
$('themeSwitch').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flipTheme(); } });
setTheme(document.documentElement.dataset.theme || 'light');

// ---------- fonts ----------
onFontsChanged(() => { requestRender(); textCtl?.refresh(); });
restoreUserFonts();

// ---------- boot ----------
const restored = loadSaved();
if (!restored) {
  state.effects = [newEffect('dither', { algorithm: 'atkinson', scale: 2 })];
  state.selectedFx = state.effects[0].id;
}
syncAll();
commit(true);
renderStack();

const restoreTextOnly = restored && state.doc.textOnly;
setTimeout(() => {
  ['bootOverlay', 'bootLabel', 'bootPixelMask'].forEach(id => $(id)?.remove());
}, 2800);
setTimeout(() => {
  if (started) return;
  if (restoreTextOnly) textOnly();
  else loadDemo();
}, matchMedia('(prefers-reduced-motion: reduce)').matches ? 50 : 2000);

