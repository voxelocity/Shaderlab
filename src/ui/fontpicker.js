// Font picker: every preset previewed in its own face with the layer's text,
// plus .ttf / .otf / .woff / .woff2 upload.

import { allFonts, FONT_CATS, loadAllPresetCSS, addFontFile, removeUserFont, isFontFile } from '../fonts.js';
import { openPopover, toast } from './overlay.js';

let lastCat = 'all';

export function openFontPicker(anchor, { current, sample, onPick }) {
  loadAllPresetCSS();
  const { pop, place, close } = openPopover(anchor, { className: 'font-pop', width: 380 });
  pop.innerHTML = `
    <div class="popover-head">
      <div class="popover-title">fonts <button class="icon-btn" data-x aria-label="close">✕</button></div>
      <input type="text" placeholder="search fonts…" spellcheck="false" aria-label="search fonts">
      <div class="chips"></div>
      <div class="upload-zone" tabindex="0" role="button">+ upload .ttf / .otf / .woff — or drop it here</div>
      <input type="file" class="file-input" accept=".ttf,.otf,.woff,.woff2,font/*">
    </div>
    <div class="popover-body"></div>`;
  const search = pop.querySelector('input[type=text]');
  const chips = pop.querySelector('.chips');
  const list = pop.querySelector('.popover-body');
  const zone = pop.querySelector('.upload-zone');
  const file = pop.querySelector('.file-input');
  pop.querySelector('[data-x]').addEventListener('click', close);
  const previewText = (String(sample || '').split('\n').find(l => l.trim()) || 'Shader Lab').slice(0, 40);

  FONT_CATS.forEach(cat => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = cat;
    b.addEventListener('click', () => { lastCat = cat; draw(); });
    chips.append(b);
  });

  function draw() {
    chips.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.textContent === lastCat));
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    const fonts = allFonts().filter(f =>
      (lastCat === 'all' || f.cat === lastCat) &&
      (!q || (f.label || f.family).toLowerCase().includes(q) || f.cat.includes(q)));
    if (!fonts.length) {
      list.innerHTML = `<div class="stack-empty">${lastCat === 'yours' ? 'no uploaded fonts yet' : 'no fonts match'}</div>`;
      return;
    }
    let group = null;
    for (const f of fonts) {
      if (lastCat === 'all' && f.cat !== group) {
        group = f.cat;
        const g = document.createElement('div');
        g.className = 'font-group-label';
        g.textContent = group === 'yours' ? 'your uploads' : group;
        list.append(g);
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'font-row' + (f.family === current ? ' current' : '');
      row.innerHTML = `<span class="font-name"></span><span class="font-cat"></span><span class="font-sample"></span>`;
      row.querySelector('.font-name').textContent = f.label || f.family;
      row.querySelector('.font-cat').textContent = f.user ? '' : f.cat;
      const s = row.querySelector('.font-sample');
      s.textContent = previewText;
      s.style.fontFamily = `"${f.family}", "Space Mono", sans-serif`;
      if (f.user) {
        const del = document.createElement('span');
        del.className = 'del';
        del.textContent = '✕';
        del.title = 'remove this font';
        del.addEventListener('click', async e => {
          e.stopPropagation();
          await removeUserFont(f.family);
          draw();
        });
        row.querySelector('.font-cat').replaceWith(del);
      }
      row.addEventListener('click', () => { onPick(f.family); close(); });
      list.append(row);
    }
  }

  async function upload(files) {
    const f = [...files].find(isFontFile);
    if (!f) { toast('✗ not a font file (.ttf .otf .woff .woff2)'); return; }
    try {
      const font = await addFontFile(f);
      toast(`✓ added ${font.label}`);
      onPick(font.family);
      close();
    } catch {
      toast('✗ could not read that font');
    }
  }
  zone.addEventListener('click', () => file.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => upload(file.files));
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag'); upload(e.dataTransfer.files); });
  search.addEventListener('input', draw);
  search.addEventListener('keydown', e => e.stopPropagation());

  draw();
  place();
  search.focus();
  list.querySelector('.current')?.scrollIntoView({ block: 'center' });
}
