// Builds sidebar controls from a declarative schema (the same schema effects use for
// their uniforms). Each entry: { key, label, type: range|select|seg|toggle|color|text,
// def, min, max, step, unit, fmt, options, show(obj), get(obj), set(obj, v) } or { sep }.

import { optionList } from '../gl/glsl.js';

export function updateSliderFill(el) {
  const min = parseFloat(el.min), max = parseFloat(el.max), v = parseFloat(el.value);
  el.style.setProperty('--fill', `${((v - min) / (max - min || 1)) * 100}%`);
}

export function fmtVal(p, v) {
  if (p.fmt) return p.fmt(v);
  if (p.type === 'range') {
    const d = p.step < 0.01 ? 3 : p.step < 0.1 ? 2 : p.step < 1 ? 1 : 0;
    return `${(+v).toFixed(d).replace(/\.0+$/, '')}${p.unit || ''}`;
  }
  return String(v);
}

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

export function toggleHTML(checked) {
  return `<label class="toggle-switch"><input type="checkbox" ${checked ? 'checked' : ''}><span class="toggle-switch-track"><span class="toggle-switch-thumb"></span></span></label>`;
}

export function buildControls(root, schema, obj, onChange) {
  root.innerHTML = '';
  const rows = [];
  const read = p => (p.get ? p.get(obj) : obj[p.key]);
  const write = (p, v) => (p.set ? p.set(obj, v) : (obj[p.key] = v));
  const visibility = () => rows.forEach(r => { if (r.p.show) r.el.hidden = !r.p.show(obj); });
  const changed = (p, final) => { onChange(p.key, final); visibility(); };

  for (const p of schema) {
    if (p.sep) {
      const s = el('div', 'control-sep', p.sep);
      rows.push({ p, el: s });
      root.append(s);
      continue;
    }
    const row = el('div', 'control-group');
    let sync = () => {};
    const label = p.label || p.key;

    if (p.type === 'range') {
      row.innerHTML = `<div class="label-row"><label></label><input class="val" type="text" spellcheck="false" aria-label="value"></div>
        <div class="slider-wrap"><input type="range" class="filled"></div>`;
      const lab = row.querySelector('label');
      const badge = row.querySelector('.val');
      const slider = row.querySelector('input[type=range]');
      lab.textContent = label;
      lab.title = 'double-click to reset';
      Object.assign(slider, { min: p.min, max: p.max, step: p.step ?? 1 });
      slider.setAttribute('aria-label', label);
      sync = () => {
        const v = read(p);
        slider.value = v;
        if (document.activeElement !== badge) badge.value = fmtVal(p, v);
        updateSliderFill(slider);
      };
      slider.addEventListener('input', () => {
        write(p, parseFloat(slider.value));
        badge.value = fmtVal(p, read(p));
        updateSliderFill(slider);
        changed(p, false);
      });
      slider.addEventListener('change', () => changed(p, true));
      badge.addEventListener('focus', () => { badge.value = String(+(+read(p)).toFixed(4)); badge.select(); });
      const commitBadge = () => {
        const v = parseFloat(badge.value);
        if (Number.isFinite(v)) {
          write(p, Math.min(p.hardMax ?? p.max, Math.max(p.hardMin ?? p.min, v)));
          changed(p, true);
        }
        badge.blur();
        sync();
      };
      badge.addEventListener('keydown', e => {
        if (e.key === 'Enter') commitBadge();
        if (e.key === 'Escape') { badge.blur(); sync(); }
        e.stopPropagation();
      });
      badge.addEventListener('change', commitBadge);
      lab.addEventListener('dblclick', () => { if (p.def !== undefined) { write(p, p.def); sync(); changed(p, true); } });
    } else if (p.type === 'select') {
      row.innerHTML = '<label></label><select></select>';
      row.querySelector('label').textContent = label;
      const sel = row.querySelector('select');
      const opts = optionList(p);
      opts.forEach((o, i) => { const op = el('option'); op.value = i; op.textContent = o.label; sel.append(op); });
      sync = () => { sel.value = Math.max(0, opts.findIndex(o => o.value === read(p))); };
      sel.addEventListener('change', () => { write(p, opts[+sel.value].value); changed(p, true); });
    } else if (p.type === 'seg') {
      row.innerHTML = '<label></label><div class="segmented"></div>';
      row.querySelector('label').textContent = label;
      const seg = row.querySelector('.segmented');
      const opts = optionList(p);
      const btns = opts.map(o => {
        const b = el('button');
        b.type = 'button';
        b.textContent = o.label;
        b.title = o.label;
        b.addEventListener('click', () => { write(p, o.value); sync(); changed(p, true); });
        seg.append(b);
        return b;
      });
      sync = () => btns.forEach((b, i) => b.classList.toggle('active', opts[i].value === read(p)));
    } else if (p.type === 'toggle') {
      row.classList.add('toggle-row');
      row.innerHTML = `<label></label>${toggleHTML(false)}`;
      row.querySelector('label').textContent = label;
      const cb = row.querySelector('input');
      sync = () => { cb.checked = !!read(p); };
      cb.addEventListener('change', () => { write(p, cb.checked); changed(p, true); });
    } else if (p.type === 'color') {
      row.innerHTML = '<label></label><input type="color">';
      row.querySelector('label').textContent = label;
      const c = row.querySelector('input');
      sync = () => { c.value = read(p); };
      c.addEventListener('input', () => { write(p, c.value); changed(p, false); });
      c.addEventListener('change', () => changed(p, true));
    } else if (p.type === 'text') {
      row.innerHTML = '<label></label><textarea spellcheck="false" rows="3"></textarea>';
      row.querySelector('label').textContent = label;
      const ta = row.querySelector('textarea');
      sync = () => { if (document.activeElement !== ta) ta.value = read(p); };
      ta.addEventListener('input', () => { write(p, ta.value); changed(p, false); });
      ta.addEventListener('change', () => changed(p, true));
    } else if (p.type === 'custom') {
      sync = p.render(row, obj, final => changed(p, final)) || (() => {});
    }
    rows.push({ p, el: row, sync });
    root.append(row);
  }
  const refresh = () => { rows.forEach(r => r.sync?.()); visibility(); };
  refresh();
  return { refresh };
}
