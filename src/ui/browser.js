// "Add effect" and "presets" browsers. Every tile shows the effect applied to the
// current canvas, rendered on the GPU at thumbnail size.

import { GROUPS, EFFECT_LIST, defaultParams, isCpu } from '../effects/index.js';
import { STACK_PRESETS } from '../presets.js';
import { openModal } from './overlay.js';

// renderThumb(effects, { palette }) -> ImageData; aspect = doc w / h
// Jobs return false when their shader is still compiling; those go to the back of the queue.
function thumbQueue(jobs, modal) {
  const queue = [...jobs];
  const step = () => {
    if (modal.isClosed() || !queue.length) return;
    const t0 = performance.now();
    let n = queue.length;
    while (n-- > 0 && performance.now() - t0 < 24) {
      const job = queue.shift();
      try { if (job() === false) queue.push(job); } catch (e) { console.warn('thumb failed', e); }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function thumbCanvas(aspect, transparent) {
  const c = document.createElement('canvas');
  if (transparent) c.className = 'checker';
  const W = 200;
  c.width = W;
  c.height = Math.max(40, Math.round(W / Math.max(0.4, Math.min(3, aspect))));
  return c;
}

const paint = (c, img) => { if (!img) return false; c.getContext('2d').putImageData(img, 0, 0); return true; };

const fxOf = (type, params, i) => ({ id: -1000 - i, type, enabled: true, params: { ...defaultParams(type), ...params }, mix: 1, blend: 'normal' });

export function openEffectBrowser({ renderThumb, aspect, transparent, onPick }) {
  const m = openModal({ title: 'add <span>effect</span>' });
  m.body.innerHTML = `<div class="control-group"><input type="text" placeholder="search effects…" spellcheck="false" aria-label="search effects"></div>`;
  const search = m.body.querySelector('input');
  const jobs = [];
  const tiles = [];
  GROUPS.forEach(g => {
    const defs = EFFECT_LIST.filter(d => d.group === g.id);
    const sec = document.createElement('div');
    sec.className = 'fx-group';
    sec.innerHTML = `<h4></h4><div class="fx-grid"></div>`;
    sec.querySelector('h4').textContent = g.name;
    const grid = sec.querySelector('.fx-grid');
    defs.forEach((def, i) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'fx-tile';
      const c = thumbCanvas(aspect, transparent);
      tile.append(c);
      const fx = fxOf(def.id, def.thumb || {}, jobs.length);
      const cpu = isCpu(fx) || def.id === 'dither';
      tile.insertAdjacentHTML('beforeend', `<div class="t-name"><span></span><span class="fx-badge ${cpu ? 'cpu' : 'gpu'}">${def.id === 'dither' ? 'gpu+cpu' : cpu ? 'cpu' : 'gpu'}</span></div><div class="t-desc"></div>`);
      tile.querySelector('.t-name span').textContent = `${def.icon} ${def.name}`;
      tile.querySelector('.t-desc').textContent = def.desc;
      tile.addEventListener('click', e => { onPick(def.id); if (!e.shiftKey) m.close(); });
      tile.title = 'click to add · shift-click to add several';
      grid.append(tile);
      tiles.push({ tile, sec, text: `${def.name} ${def.desc} ${g.name}`.toLowerCase() });
      jobs.push(() => paint(c, renderThumb([fx], {}, c.width, c.height)));
    });
    m.body.append(sec);
  });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    tiles.forEach(t => { t.tile.hidden = !!q && !t.text.includes(q); });
    m.body.querySelectorAll('.fx-group').forEach(s => { s.hidden = ![...s.querySelectorAll('.fx-tile')].some(t => !t.hidden); });
  });
  search.addEventListener('keydown', e => e.stopPropagation());
  search.focus();
  thumbQueue(jobs, m);
}

export function openPresetBrowser({ renderThumb, aspect, transparent, onPick }) {
  const m = openModal({ title: 'stack <span>presets</span>' });
  m.body.innerHTML = `<div class="hint" style="margin-bottom:12px">replaces the current effect stack — undo with ctrl+z. presets marked ◆ also set the palette.</div><div class="preset-grid"></div>`;
  const grid = m.body.querySelector('.preset-grid');
  const jobs = [];
  STACK_PRESETS.forEach((preset, pi) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'fx-tile';
    const c = thumbCanvas(aspect, transparent);
    tile.append(c);
    tile.insertAdjacentHTML('beforeend', `<div class="t-name"><span></span></div><div class="t-desc"></div>`);
    tile.querySelector('.t-name span').textContent = (preset.palette ? '◆ ' : '') + preset.name;
    tile.querySelector('.t-desc').textContent = preset.stack.map(([t]) => t).join(' → ');
    tile.addEventListener('click', () => { onPick(preset); m.close(); });
    grid.append(tile);
    const fxs = preset.stack.map(([type, params], i) => fxOf(type, params, pi * 10 + i));
    jobs.push(() => paint(c, renderThumb(fxs, { palette: preset.palette }, c.width, c.height)));
  });
  thumbQueue(jobs, m);
}
