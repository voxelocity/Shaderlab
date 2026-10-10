import tone from './tone.js';
import dither from './dither.js';
import print from './print.js';
import graphic from './graphic.js';
import glitch from './glitch.js';
import distort from './distort.js';
import light from './light.js';
import atmosphere from './atmosphere.js';
import stylize from './stylize.js';
import more from './more.js';

export const GROUPS = [
  { id: 'dither', name: 'dither' },
  { id: 'tone', name: 'tone & colour' },
  { id: 'print', name: 'print' },
  { id: 'graphic', name: 'graphic' },
  { id: 'light', name: 'light & material' },
  { id: 'glitch', name: 'glitch' },
  { id: 'distort', name: 'distort' },
  { id: 'atmosphere', name: 'atmosphere & lens' },
  { id: 'stylize', name: 'stylize' },
];

export const EFFECT_LIST = [...dither, ...tone, ...print, ...graphic, ...light, ...glitch, ...distort, ...atmosphere, ...stylize, ...more];
export const EFFECTS = Object.fromEntries(EFFECT_LIST.map(d => [d.id, d]));

export function defaultParams(type) {
  const def = EFFECTS[type];
  const p = {};
  for (const q of def?.params || []) if (q.key) p[q.key] = q.def;
  return p;
}

export function isAnimated(fx) {
  const def = EFFECTS[fx.type];
  if (!def || !fx.enabled) return false;
  return def.animated ? !!def.animated(fx.params) : !!fx.params.animate;
}

export function isCpu(fx) {
  const def = EFFECTS[fx.type];
  return !!(def?.cpu && def.cpu(fx.params));
}
