// Export dialog: format, resolution, background, quality, animation, filename.
// Each export renders on its own WebGL context at full output size.

import { Renderer } from '../gl/renderer.js';
import { hexToRgb01 } from '../gl/glsl.js';
import { GifEncoder } from '../export/gif.js';
import { quantizeFrame } from '../export/quantize.js';
import { openModal, toast } from './overlay.js';
import { toggleHTML, updateSliderFill } from './controls.js';

const canEncode = mime => {
  try { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL(mime).startsWith(`data:${mime}`); } catch { return false; }
};
const videoMime = id => {
  if (typeof MediaRecorder === 'undefined') return null;
  const list = id === 'mp4'
    ? ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find(m => MediaRecorder.isTypeSupported(m)) || null;
};

const FORMATS = [
  { id: 'png', label: 'PNG', sub: 'lossless', kind: 'image', mime: 'image/png', alpha: true },
  { id: 'jpg', label: 'JPG', sub: 'small', kind: 'image', mime: 'image/jpeg', alpha: false, quality: true },
  { id: 'webp', label: 'WEBP', sub: 'modern', kind: 'image', mime: 'image/webp', alpha: true, quality: true },
  { id: 'gif', label: 'GIF', sub: 'animated', kind: 'gif', alpha: true },
  { id: 'webm', label: 'WEBM', sub: 'video', kind: 'video', alpha: false },
  { id: 'mp4', label: 'MP4', sub: 'video', kind: 'video', alpha: false },
  { id: 'txt', label: 'TXT', sub: 'ascii text', kind: 'text' },
];

const S = {
  format: 'png', scale: 1, custom: null, bg: 'shown', bgColor: '#ffffff',
  quality: 0.92, mbps: 8, lock: true, duration: 3, fps: 15, vfps: 30, full: true, filename: '',
};
try { Object.assign(S, JSON.parse(localStorage.getItem('shaderlab-export') || '{}'), { custom: null, filename: '' }); } catch { /* defaults */ }
const saveS = () => { try { const { custom, filename, _userPicked, ...keep } = S; localStorage.setItem('shaderlab-export', JSON.stringify(keep)); } catch { /* ignore */ } };

const MAX_LONG = { image: 8192, gif: 1600, video: 3840 };

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}
// Yield to the event loop without depending on requestAnimationFrame, which stops while
// the tab is in the background or the window is covered.
const yieldNow = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
// Real-time tick for video recording: next animation frame, or a timer if frames stall.
const tick = ms => new Promise(r => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(f); setTimeout(f, ms); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function seek(video, t) {
  return new Promise(resolve => {
    const done = () => { video.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 1500);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

// app: { state, docSize, buildScene, time, previewThumb(opts) -> ImageData, asciiText(), hasAnimation(), hasAscii(), setPaused(bool) }
export function openExport(app) {
  const { state } = app;
  const formats = FORMATS.map(f => ({
    ...f,
    ok: f.kind === 'image' ? (f.id === 'png' || canEncode(f.mime))
      : f.kind === 'video' ? !!videoMime(f.id)
      : f.kind === 'text' ? app.hasAscii() : true,
  }));
  const moving = state.mediaType === 'video' || state.mediaType === 'camera' || app.hasAnimation();
  if (!formats.find(f => f.id === S.format)?.ok) S.format = 'png';
  if (moving && formats.find(f => f.id === S.format).kind === 'image' && !S._userPicked) S.format = 'gif';
  if (!S.filename) S.filename = `shaderlab-${new Date().toLocaleDateString('en-CA')}`;

  let busy = false, cancel = false;
  const m = openModal({ title: 'export <span>/ render</span>', onClose: () => { cancel = true; saveS(); } });
  m.body.innerHTML = `
  <div class="export-layout">
    <div>
      <div class="export-preview"><canvas></canvas><span class="px-note"></span></div>
      <div class="note" data-srcnote></div>
    </div>
    <div class="export-settings">
      <div class="control-group"><label>format</label><div class="fmt-grid" data-fmt></div></div>
      <div class="control-group" data-sec="size">
        <div class="label-row"><label>resolution</label><span class="note" data-mp style="margin:0"></span></div>
        <div class="chips" data-scales style="margin-bottom:8px"></div>
        <div class="dims"><input type="number" min="16" data-w aria-label="width"><span>×</span><input type="number" min="16" data-h aria-label="height"></div>
        <div class="note" data-sizenote></div>
      </div>
      <div class="control-group" data-sec="bg">
        <label>background</label>
        <div class="segmented" data-bg>
          <button type="button" data-v="shown">as previewed</button><button type="button" data-v="transparent">transparent</button><button type="button" data-v="color">colour</button>
        </div>
        <div style="margin-top:6px" data-bgcolorrow><input type="color" data-bgcolor aria-label="background colour"></div>
        <div class="note" data-bgnote></div>
      </div>
      <div class="control-group" data-sec="quality">
        <div class="label-row"><label data-qlabel>quality</label><input class="val" data-qval readonly tabindex="-1"></div>
        <div class="slider-wrap"><input type="range" class="filled" data-q aria-label="quality"></div>
      </div>
      <div class="control-group" data-sec="scale">
        <label>effect scale</label>
        <div class="segmented" data-lock><button type="button" data-v="1">match preview</button><button type="button" data-v="0">fine detail (1:1 px)</button></div>
        <div class="note">match preview keeps dots, pixels & lines the same size relative to the image. fine detail uses real pixels, so big exports get finer patterns.</div>
      </div>
      <div class="control-group" data-sec="anim">
        <label>animation</label>
        <div class="toggle-row" data-fullrow style="margin-bottom:8px"><label>whole clip</label>${toggleHTML(true)}</div>
        <div data-durrow>
          <div class="label-row"><label>duration</label><input class="val" data-durval readonly tabindex="-1"></div>
          <div class="slider-wrap"><input type="range" class="filled" min="0.5" max="20" step="0.5" data-dur aria-label="duration"></div>
        </div>
        <label style="margin-top:8px">frame rate</label>
        <div class="chips" data-fps></div>
        <div class="note" data-animnote></div>
      </div>
      <div class="control-group">
        <label>filename</label>
        <div class="fname-row"><input type="text" data-name spellcheck="false" aria-label="filename"><span class="ext" data-ext></span></div>
      </div>
    </div>
  </div>`;
  const foot = document.createElement('div');
  foot.className = 'modal-foot';
  foot.innerHTML = `<div class="progress"><div></div></div><span class="progress-label" data-plabel>ready</span>
    <button class="btn alt" data-cancel hidden>cancel</button><button class="btn accent" data-go>↓ export</button>`;
  m.modal.append(foot);

  const $ = s => m.body.querySelector(s) || foot.querySelector(s);
  const pv = $('.export-preview canvas');
  const fmt = () => formats.find(f => f.id === S.format);
  const doc = () => app.docSize();

  // ---------- derived ----------
  function dims() {
    const d = doc(), f = fmt();
    let W, H;
    if (S.custom) { W = S.custom.w; H = S.custom.h; }
    else { W = Math.round(d.w * S.scale); H = Math.round(d.h * S.scale); }
    const cap = MAX_LONG[f.kind] || 8192;
    const long = Math.max(W, H);
    let capped = false;
    if (long > cap) { W = Math.round(W * cap / long); H = Math.round(H * cap / long); capped = true; }
    if (f.kind === 'video') { W -= W % 2; H -= H % 2; }
    return { W: Math.max(16, W), H: Math.max(16, H), capped, cap };
  }
  const isAlphaFmt = () => !!fmt().alpha;
  const clearFlag = () => S.bg === 'shown' ? state.doc.transparent : true;
  function bgRGB() {
    if (S.bg === 'color') return hexToRgb01(S.bgColor);
    if (!isAlphaFmt() && clearFlag()) return hexToRgb01(S.bg === 'shown' ? state.doc.bg : S.bgColor);
    return null;
  }
  const kFor = (W, H) => S.lock ? Math.max(W, H) / 1000 : 1;
  const ext = () => fmt().id;

  // ---------- UI ----------
  const fmtGrid = $('[data-fmt]');
  formats.forEach(f => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fmt-btn';
    b.innerHTML = `${f.label}<small>${f.sub}</small>`;
    b.disabled = !f.ok;
    b.title = f.ok ? '' : (f.kind === 'text' ? 'add an ascii effect to export text' : 'not supported by this browser');
    b.addEventListener('click', () => { S.format = f.id; S._userPicked = true; if (!f.alpha && S.bg === 'transparent') S.bg = 'color'; sync(); });
    b.dataset.id = f.id;
    fmtGrid.append(b);
  });
  const scales = $('[data-scales]');
  [0.25, 0.5, 1, 2, 3, 4].forEach(s => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `${s}×`;
    b.dataset.s = s;
    b.addEventListener('click', () => { S.scale = s; S.custom = null; sync(); });
    scales.append(b);
  });
  const wIn = $('[data-w]'), hIn = $('[data-h]');
  const onDim = which => {
    const d = doc();
    const v = Math.max(16, Math.min(16384, parseInt((which === 'w' ? wIn : hIn).value, 10) || 16));
    S.custom = which === 'w' ? { w: v, h: Math.round(v * d.h / d.w) } : { h: v, w: Math.round(v * d.w / d.h) };
    sync();
  };
  wIn.addEventListener('change', () => onDim('w'));
  hIn.addEventListener('change', () => onDim('h'));
  [wIn, hIn].forEach(i => i.addEventListener('keydown', e => e.stopPropagation()));
  $('[data-bg]').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { S.bg = b.dataset.v; sync(); }));
  const bgc = $('[data-bgcolor]');
  bgc.addEventListener('input', () => { S.bgColor = bgc.value; drawPreviewSoon(); });
  const q = $('[data-q]');
  q.addEventListener('input', () => {
    if (fmt().kind === 'video') S.mbps = +q.value; else S.quality = +q.value;
    syncQuality();
  });
  $('[data-lock]').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { S.lock = b.dataset.v === '1'; sync(); }));
  const fullCb = $('[data-fullrow] input');
  fullCb.addEventListener('change', () => { S.full = fullCb.checked; sync(); });
  const dur = $('[data-dur]');
  dur.addEventListener('input', () => { S.duration = +dur.value; syncAnim(); });
  const nameIn = $('[data-name]');
  nameIn.value = S.filename;
  nameIn.addEventListener('input', () => { S.filename = nameIn.value.replace(/[\\/:*?"<>|]+/g, '-'); });
  nameIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go(); });

  function syncQuality() {
    const f = fmt();
    if (f.kind === 'video') {
      Object.assign(q, { min: 1, max: 40, step: 1 });
      q.value = S.mbps;
      $('[data-qlabel]').textContent = 'bitrate';
      $('[data-qval]').value = `${S.mbps} mbps`;
    } else {
      Object.assign(q, { min: 0.3, max: 1, step: 0.01 });
      q.value = S.quality;
      $('[data-qlabel]').textContent = 'quality';
      $('[data-qval]').value = `${Math.round(S.quality * 100)}%`;
    }
    updateSliderFill(q);
  }
  function syncAnim() {
    const f = fmt();
    const vid = state.mediaType === 'video' && state.media;
    $('[data-fullrow]').hidden = !vid;
    fullCb.checked = S.full;
    const useDur = !vid || !S.full;
    $('[data-durrow]').hidden = !useDur;
    dur.value = S.duration;
    updateSliderFill(dur);
    $('[data-durval]').value = `${S.duration}s`;
    const fpsList = f.kind === 'gif' ? [8, 10, 12, 15, 20, 25] : [24, 30, 60];
    const cur = f.kind === 'gif' ? S.fps : S.vfps;
    const box = $('[data-fps]');
    box.innerHTML = '';
    fpsList.forEach(v => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (v === cur ? ' active' : '');
      b.textContent = `${v} fps`;
      b.addEventListener('click', () => { if (f.kind === 'gif') S.fps = v; else S.vfps = v; syncAnim(); });
      box.append(b);
    });
    const seconds = vid && S.full ? Math.min(vid.duration || 0, f.kind === 'gif' ? 30 : 600) : S.duration;
    let note = '';
    if (f.kind === 'gif') note = `${Math.max(1, Math.round(seconds * S.fps))} frames · gifs get big fast — keep them short and small.`;
    else note = 'video records in real time' + (state.mediaType === 'camera' ? ' from the webcam' : '') + ` (~${Math.ceil(seconds)}s). no audio track.`;
    if (!moving) note += ' nothing is animated right now, so every frame will look the same.';
    $('[data-animnote]').textContent = note;
  }

  function sync() {
    const f = fmt();
    fmtGrid.querySelectorAll('.fmt-btn').forEach(b => b.classList.toggle('active', b.dataset.id === S.format));
    const text = f.kind === 'text';
    m.body.querySelector('[data-sec=size]').hidden = text;
    m.body.querySelector('[data-sec=bg]').hidden = text;
    m.body.querySelector('[data-sec=scale]').hidden = text;
    m.body.querySelector('[data-sec=quality]').hidden = !(f.quality || f.kind === 'video');
    m.body.querySelector('[data-sec=anim]').hidden = !(f.kind === 'gif' || f.kind === 'video');
    const { W, H, capped, cap } = dims();
    scales.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', !S.custom && +c.dataset.s === S.scale));
    if (document.activeElement !== wIn) wIn.value = W;
    if (document.activeElement !== hIn) hIn.value = H;
    $('[data-mp]').textContent = `${(W * H / 1e6).toFixed(W * H > 1e7 ? 0 : 1)} mp`;
    const d = doc();
    $('[data-sizenote]').textContent = capped ? `capped to ${cap}px on the long side for ${f.label}.` : `document is ${d.w}×${d.h}.`;
    $('[data-sizenote]').classList.toggle('warn', capped);
    const bgBtns = $('[data-bg]').querySelectorAll('button');
    bgBtns.forEach(b => {
      b.classList.toggle('active', b.dataset.v === S.bg);
      b.disabled = b.dataset.v === 'transparent' && !f.alpha;
    });
    $('[data-bgcolorrow]').hidden = S.bg !== 'color';
    bgc.value = S.bgColor;
    let bgNote = '';
    if (S.bg === 'transparent') bgNote = 'empty canvas and the "paper" of halftone, ascii, threshold, hatch & led effects become see-through.';
    else if (S.bg === 'color') bgNote = 'replaces the canvas background and effect paper with this colour.';
    else if (!f.alpha && state.doc.transparent) bgNote = `${f.label} has no transparency — see-through areas get the canvas colour.`;
    if (S.bg !== 'shown' && state.media && state.doc.size === 'source' && state.mediaType !== 'image') bgNote += ' video frames are opaque, so this mostly affects effect paper.';
    $('[data-bgnote]').textContent = bgNote;
    $('[data-lock]').querySelectorAll('button').forEach(b => b.classList.toggle('active', (b.dataset.v === '1') === S.lock));
    $('[data-ext]').textContent = `.${ext()}`;
    $('[data-go]').textContent = `↓ export ${f.label}`;
    const src = state.mediaType ? `${state.mediaType}: ${state.mediaName || 'untitled'}` : 'text-only canvas';
    $('[data-srcnote]').textContent = `source — ${src} · ${app.effectCount()} fx`;
    syncQuality();
    syncAnim();
    drawPreviewSoon();
  }

  // ---------- live preview ----------
  let pvTimer = 0;
  function drawPreviewSoon() { clearTimeout(pvTimer); pvTimer = setTimeout(drawPreview, 60); }
  function drawPreview() {
    if (m.isClosed() || busy) return;
    const f = fmt();
    const { W, H } = dims();
    const box = Math.min(640, (m.body.querySelector('.export-preview').clientWidth || 600) - 24);
    const s = Math.min(1, box / W, 420 / H);
    const pw = Math.max(16, Math.round(W * s)), ph = Math.max(16, Math.round(H * s));
    pv.width = pw; pv.height = ph;
    $('.px-note').textContent = `${W}×${H}`;
    if (f.kind === 'text') {
      const ctx = pv.getContext('2d');
      pv.width = 600; pv.height = 360;
      ctx.fillStyle = '#f4f0e4'; ctx.fillRect(0, 0, 600, 360);
      ctx.fillStyle = '#1a1a1a'; ctx.font = '6px "Space Mono", monospace';
      const txt = app.asciiText() || '';
      txt.split('\n').slice(0, 60).forEach((l, i) => ctx.fillText(l.slice(0, 200), 4, 8 + i * 6));
      $('.px-note').textContent = `${(txt.split('\n')[0] || '').length} cols × ${txt.split('\n').length - 1} rows`;
      pv.classList.remove('checker');
      return;
    }
    const k = S.lock ? Math.max(pw, ph) / 1000 : Math.max(pw, ph) / Math.max(W, H);
    const img = app.previewThumb({ w: pw, h: ph, k, clear: clearFlag(), bg: bgRGB() });
    pv.getContext('2d').putImageData(img, 0, 0);
    pv.classList.toggle('checker', clearFlag() && !bgRGB());
  }

  // ---------- export runners ----------
  const bar = foot.querySelector('.progress > div');
  const plabel = $('[data-plabel]');
  const progress = (p, label) => { bar.style.width = `${Math.round(p * 100)}%`; if (label) plabel.textContent = label; };

  async function exportStill(f, name) {
    const { W, H } = dims();
    progress(0.1, `rendering ${W}×${H}…`);
    await sleep(30);
    const r = new Renderer(document.createElement('canvas'), { sync: true });
    try {
      r.render(app.buildScene(), { w: W, h: H, k: kFor(W, H), time: app.time(), clear: clearFlag(), isolated: true });
      const data = r.readResult(bgRGB());
      progress(0.7, 'encoding…');
      await sleep(10);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      c.getContext('2d').putImageData(new ImageData(data, W, H), 0, 0);
      const blob = await new Promise(res => c.toBlob(res, f.mime, S.quality));
      if (!blob) throw new Error('the browser could not encode this image (too large?)');
      download(blob, `${name}.${f.id}`);
      return `${(blob.size / 1024 / 1024).toFixed(2)} mb`;
    } finally { r.destroy(); }
  }

  async function exportGif(name) {
    const { W, H } = dims();
    const fps = S.fps;
    const video = state.mediaType === 'video' ? state.media : null;
    const seconds = video && S.full ? Math.min(video.duration || S.duration, 30) : S.duration;
    const frames = Math.max(1, Math.round(seconds * fps));
    const r = new Renderer(document.createElement('canvas'), { sync: true });
    const enc = new GifEncoder(W, H);
    const wasPaused = video?.paused, oldTime = video?.currentTime;
    app.setPaused(true);
    try {
      if (video) video.pause();
      for (let i = 0; i < frames; i++) {
        if (cancel) throw new Error('cancelled');
        const t = i / fps;
        if (video) await seek(video, Math.min(t, Math.max(0, video.duration - 0.01)));
        else if (state.mediaType === 'camera' && i) await sleep(1000 / fps);
        const scene = app.buildScene();
        scene.mediaLive = !!state.mediaType && state.mediaType !== 'image';
        r.render(scene, { w: W, h: H, k: kFor(W, H), time: t, clear: clearFlag(), isolated: true });
        enc.addFrame(quantizeFrame(r.readResult(bgRGB()), 256), Math.max(2, Math.round(100 / fps)));
        progress((i + 1) / frames, `frame ${i + 1} / ${frames}`);
        await yieldNow();
      }
      progress(1, 'packing gif…');
      const blob = enc.finish();
      download(blob, `${name}.gif`);
      return `${frames} frames · ${(blob.size / 1024 / 1024).toFixed(2)} mb`;
    } finally {
      r.destroy();
      if (video) { video.currentTime = oldTime; if (!wasPaused) video.play().catch(() => {}); }
      app.setPaused(false);
    }
  }

  async function exportVideo(f, name) {
    const { W, H } = dims();
    const mime = videoMime(f.id);
    const fps = S.vfps;
    const video = state.mediaType === 'video' ? state.media : null;
    const seconds = video && S.full ? Math.min(video.duration || S.duration, 600) : S.duration;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const r = new Renderer(c, { preserve: true, sync: true });
    const stream = c.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: S.mbps * 1e6 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    const wasLoop = video?.loop, wasPaused = video?.paused;
    try {
      if (video) {
        video.loop = false;
        video.pause();
        await seek(video, 0);
        await video.play();
      }
      rec.start(250);
      const t0 = performance.now();
      for (;;) {
        await tick(1000 / fps);
        const el = (performance.now() - t0) / 1000;
        if (cancel || el >= seconds || (video && video.ended)) break;
        const scene = app.buildScene();
        scene.mediaLive = !!state.mediaType && state.mediaType !== 'image';
        r.render(scene, { w: W, h: H, k: kFor(W, H), time: el, clear: clearFlag(), isolated: true });
        r.present(bgRGB());
        progress(el / seconds, `recording ${el.toFixed(1)}s / ${seconds.toFixed(1)}s`);
      }
      rec.stop();
      await stopped;
      if (cancel) throw new Error('cancelled');
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      download(blob, `${name}.${f.id}`);
      return `${(blob.size / 1024 / 1024).toFixed(2)} mb`;
    } finally {
      if (rec.state !== 'inactive') rec.stop();
      stream.getTracks().forEach(t => t.stop());
      r.destroy();
      if (video) { video.loop = wasLoop; if (!wasPaused) video.play().catch(() => {}); }
    }
  }

  async function go() {
    if (busy) return;
    const f = fmt();
    if (!f.ok) return;
    const name = (S.filename || 'shaderlab').trim();
    busy = true;
    cancel = false;
    const goBtn = $('[data-go]'), cancelBtn = $('[data-cancel]');
    goBtn.disabled = true;
    cancelBtn.hidden = false;
    try {
      let info;
      if (f.kind === 'text') {
        const txt = app.asciiText();
        if (!txt) throw new Error('no ascii output');
        download(new Blob([txt], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
        info = `${txt.length} chars`;
      } else if (f.kind === 'image') info = await exportStill(f, name);
      else if (f.kind === 'gif') info = await exportGif(name);
      else info = await exportVideo(f, name);
      progress(1, `✓ saved · ${info}`);
      toast(`✓ exported ${name}.${f.id}`);
    } catch (e) {
      progress(0, e.message === 'cancelled' ? 'cancelled' : `✗ ${e.message}`);
      if (e.message !== 'cancelled') console.error(e);
    } finally {
      busy = false;
      goBtn.disabled = false;
      cancelBtn.hidden = true;
      saveS();
    }
  }
  $('[data-go]').addEventListener('click', go);
  $('[data-cancel]').addEventListener('click', () => { cancel = true; });

  sync();
}
