// Text layers: layout, drawing to a 2D canvas, measuring and hit-testing.
// Layer geometry is resolution independent: x/y are 0..1 of the document,
// size is a fraction of the document height.

import { ensureFont } from './fonts.js';

const measureCtx = document.createElement('canvas').getContext('2d');
const HAS_SPACING = 'letterSpacing' in measureCtx;

export function fontCSS(L, px) {
  return `${L.italic ? 'italic ' : ''}${L.weight} ${px}px "${L.font}", "Space Mono", sans-serif`;
}

function layout(ctx, L, px) {
  ctx.font = fontCSS(L, px);
  const ls = HAS_SPACING ? L.tracking * px : 0;
  if (HAS_SPACING) ctx.letterSpacing = `${ls}px`;
  ctx.textBaseline = 'middle';
  const lines = String(L.text).split('\n');
  // measureText includes the spacing after the last glyph; strip it so boxes hug the ink.
  const widths = lines.map(l => Math.max(0, ctx.measureText(l).width - (l.length ? ls : 0)));
  const lineH = px * L.leading;
  return { lines, widths, w: Math.max(1, ...widths), h: lineH * lines.length, lineH, ls };
}

export function drawTextLayers(ctx, layers, docW, docH, w, h) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const s = w / docW;
  for (const L of layers) {
    if (!L.visible || !L.text) continue;
    ensureFont(L.font, L.weight, L.italic);
    const px = L.size * docH * s;
    ctx.save();
    ctx.translate(L.x * w, L.y * h);
    ctx.rotate((L.rotation || 0) * Math.PI / 180);
    ctx.globalAlpha = L.opacity ?? 1;
    const m = layout(ctx, L, px);
    ctx.textAlign = L.align;
    const ax = L.align === 'left' ? -m.w / 2 : L.align === 'right' ? m.w / 2 + m.ls : m.ls / 2;
    m.lines.forEach((line, i) => {
      const y = -m.h / 2 + m.lineH * (i + 0.5);
      if (L.stroke > 0) {
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.lineWidth = L.stroke * px * 2;
        ctx.strokeStyle = L.strokeColor;
        ctx.strokeText(line, ax, y);
      }
      ctx.fillStyle = L.color;
      ctx.fillText(line, ax, y);
    });
    ctx.restore();
  }
  if (HAS_SPACING) ctx.letterSpacing = '0px';
}

// Box in document px (unrotated), centred on the layer origin.
export function measureLayer(L, docW, docH) {
  const px = Math.max(1, L.size * docH);
  const m = layout(measureCtx, L, px);
  const pad = (L.stroke || 0) * px + px * 0.08;
  return { w: m.w + pad * 2, h: m.h + pad * 2 };
}

export function hitTest(layers, docW, docH, dx, dy) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i];
    if (!L.visible || !L.text) continue;
    const { w, h } = measureLayer(L, docW, docH);
    const a = -(L.rotation || 0) * Math.PI / 180;
    const ox = dx - L.x * docW, oy = dy - L.y * docH;
    const lx = ox * Math.cos(a) - oy * Math.sin(a);
    const ly = ox * Math.sin(a) + oy * Math.cos(a);
    if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return L;
  }
  return null;
}
