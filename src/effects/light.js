import { pct, deg, times } from './fmt.js';

const BRIGHT = `
uniform float u_threshold;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(u_threshold - 0.08, u_threshold + 0.08, l);
  fragColor = vec4(c.rgb * c.a * k, 1.0);
}`;

const RADIAL = `
uniform vec2 u_light;
uniform float u_len;
uniform float u_decay;
void main() {
  const int N = 40;
  vec2 stp = (v_uv - u_light) * u_len / float(N);
  vec2 uv = v_uv;
  vec3 acc = vec3(0.0);
  float w = 1.0, ws = 0.0;
  for (int i = 0; i < N; i++) {
    acc += texture(u_tex, uv).rgb * w;
    ws += w;
    w *= u_decay;
    uv -= stp;
  }
  fragColor = vec4(acc / ws, 1.0);
}`;

const HEIGHT = `
uniform int u_src;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float h = u_src == 0 ? (1.0 - luma(c.rgb)) * c.a : (u_src == 1 ? luma(c.rgb) * c.a : c.a);
  fragColor = vec4(vec3(h), 1.0);
}`;

const SOURCES = [['dark', 'raise dark areas'], ['light', 'raise light areas'], ['alpha', 'raise shapes (alpha)']];

export default [
  {
    id: 'rays', name: 'god rays', icon: '☼', group: 'light',
    desc: 'volumetric light streaming from the bright parts of the image',
    params: [
      { key: 'x', label: 'light x', type: 'range', min: 0, max: 1, step: 0.01, def: 0.75, fmt: pct },
      { key: 'y', label: 'light y', type: 'range', min: 0, max: 1, step: 0.01, def: 0.37, fmt: pct },
      { key: 'length', label: 'ray length', type: 'range', min: 0, max: 1, step: 0.01, def: 0.55, fmt: pct },
      { key: 'strength', label: 'strength', type: 'range', min: 0, max: 3, step: 0.01, def: 0.75, fmt: times },
      { key: 'threshold', label: 'threshold', type: 'range', min: 0, max: 255, step: 1, def: 175 },
      { key: 'decay', label: 'falloff', type: 'range', min: 0.85, max: 1, step: 0.001, def: 0.96, fmt: v => v.toFixed(3) },
      { key: 'tint', label: 'tint', type: 'color', def: '#ffe6c2' },
      { key: 'animate', label: 'sway', type: 'toggle', def: false },
    ],
    run(ctx, p) {
      const hw = Math.max(1, Math.round(ctx.w / 2)), hh = Math.max(1, Math.round(ctx.h / 2));
      let lx = p.x, ly = 1 - p.y;
      if (p.animate) { lx += 0.03 * Math.sin(ctx.time * 0.9); ly += 0.02 * Math.cos(ctx.time * 0.7); }
      const bright = ctx.pass('rays.bright', BRIGHT, { u_threshold: p.threshold / 255 }, { u_tex: ctx.input }, hw, hh);
      const r1 = ctx.pass('rays.radial', RADIAL, { u_light: [lx, ly], u_len: p.length, u_decay: p.decay }, { u_tex: bright }, hw, hh);
      ctx.release(bright);
      const r2 = ctx.pass('rays.radial', RADIAL, { u_light: [lx, ly], u_len: p.length * 0.3, u_decay: 0.985 }, { u_tex: r1 }, hw, hh);
      ctx.release(r1);
      const out = ctx.shader(this, p, {}, { u_rays: r2 });
      ctx.release(r2);
      return out;
    },
    frag: `
uniform sampler2D u_rays;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 r = texture(u_rays, v_uv).rgb * u_strength * u_tint * 1.6;
  vec3 pm = c.rgb * c.a + r;
  float a = clamp(max(c.a, max(r.r, max(r.g, r.b))), 0.0, 1.0);
  fragColor = vec4(min(pm / max(a, 1e-4), 1.0), a);
}`,
  },

  {
    id: 'chrome', name: 'chrome / liquid metal', icon: '◒', group: 'light',
    desc: 'turns shapes and type into reflective y2k chrome, gold or holo foil',
    params: [
      { key: 'source', label: 'height from', type: 'select', def: 'dark', options: SOURCES, glsl: false },
      { key: 'style', label: 'material', type: 'select', def: 'chrome', options: [['chrome', 'chrome'], ['gold', 'gold'], ['holo', 'holographic'], ['palette', 'palette']] },
      { key: 'bevel', label: 'bevel', type: 'range', min: 1, max: 40, step: 0.5, def: 8, unit: 'px' },
      { key: 'depth', label: 'depth', type: 'range', min: 0.3, max: 8, step: 0.05, def: 2.5, fmt: times },
      { key: 'horizon', label: 'horizon line', type: 'range', min: 0, max: 1, step: 0.01, def: 0.55, fmt: pct, show: p => p.style === 'chrome' || p.style === 'gold' },
      { key: 'angle', label: 'light angle', type: 'range', min: 0, max: 360, step: 1, def: 135, fmt: deg },
      { key: 'shine', label: 'shine', type: 'range', min: 0, max: 1.5, step: 0.01, def: 0.7, fmt: pct },
      { key: 'coverage', label: 'only on shapes', type: 'toggle', def: true },
    ],
    run(ctx, p) {
      const src = ['dark', 'light', 'alpha'].indexOf(p.source);
      const h0 = ctx.pass('chrome.height', HEIGHT, { u_src: Math.max(0, src) }, { u_tex: ctx.input });
      const hb = ctx.blur(h0, Math.max(0.5, p.bevel * ctx.k * 0.5));
      const out = ctx.shader(this, p, {}, { u_h: hb, u_h0: h0 });
      ctx.release(h0); ctx.release(hb);
      return out;
    },
    frag: `
uniform sampler2D u_h;
uniform sampler2D u_h0;
vec3 env(vec3 r) {
  float y = r.y + 0.06 * sin(r.x * 7.0);
  // chrome & gold: a horizon runs across the image, bent by the surface normals
  float yc = (r.y - 0.33) * 1.6 + (v_uv.y - (1.0 - u_horizon)) * 2.4 + 0.05 * sin(r.x * 7.0);
  if (u_style == STYLE_PALETTE) return palRamp(clamp(y * 0.5 + 0.5, 0.0, 1.0));
  if (u_style == STYLE_HOLO) return hsv2rgb(vec3(fract(y * 0.9 + r.x * 0.7 + 0.25), 0.5, 1.0)) * (0.85 + 0.15 * y);
  vec3 skyTop, skyHor, gndHor, gndBot;
  if (u_style == STYLE_GOLD) {
    skyTop = vec3(0.62, 0.38, 0.1); skyHor = vec3(1.0, 0.93, 0.62); gndHor = vec3(0.22, 0.1, 0.02); gndBot = vec3(0.88, 0.62, 0.25);
  } else {
    skyTop = vec3(0.32, 0.42, 0.62); skyHor = vec3(0.96, 0.98, 1.0); gndHor = vec3(0.14, 0.12, 0.12); gndBot = vec3(0.72, 0.62, 0.52);
  }
  vec3 col = yc > 0.0 ? mix(skyHor, skyTop, pow(clamp(yc, 0.0, 1.0), 0.6)) : mix(gndHor, gndBot, pow(clamp(-yc, 0.0, 1.0), 0.55));
  return col * (1.0 - 0.6 * exp(-pow(yc * 14.0, 2.0)) * step(yc, 0.0));
}
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 e = 1.0 / u_res;
  float hx = texture(u_h, v_uv + vec2(e.x, 0.0)).r - texture(u_h, v_uv - vec2(e.x, 0.0)).r;
  float hy = texture(u_h, v_uv + vec2(0.0, e.y)).r - texture(u_h, v_uv - vec2(0.0, e.y)).r;
  float bevelPx = max(1.0, u_bevel * u_k);
  vec3 n = normalize(vec3(-vec2(hx, hy) * u_depth * bevelPx * 0.5, 1.0));
  vec3 view = normalize(vec3(0.0, 0.35, -1.0));   // tilted so flat areas mirror the sky
  vec3 r = reflect(view, n);
  vec3 col = env(r);
  vec3 L = normalize(vec3(cos(radians(u_angle)), sin(radians(u_angle)), 0.8));
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 36.0) * u_shine;
  float rim = pow(1.0 - n.z, 2.0);
  col = col * (1.0 - rim * 0.35) + spec;
  float mask = u_coverage ? smoothstep(0.04, 0.45, texture(u_h0, v_uv).r) : 1.0;
  fragColor = vec4(clamp(mix(c.rgb, col, mask), 0.0, 1.0), c.a);
}`,
  },

  {
    id: 'inkbleed', name: 'ink bleed', icon: '❖', group: 'light', paper: true,
    desc: 'wet ink soaking into paper — organic edges, pooled rims',
    params: [
      { key: 'source', label: 'ink from', type: 'select', def: 'dark', options: [['dark', 'dark areas'], ['alpha', 'shapes (alpha)']], glsl: false },
      { key: 'spread', label: 'bleed', type: 'range', min: 0, max: 24, step: 0.25, def: 3, unit: 'px' },
      { key: 'roughness', label: 'roughness', type: 'range', min: 0, max: 1, step: 0.01, def: 0.6, fmt: pct },
      { key: 'grain', label: 'fibre scale', type: 'range', min: 0.5, max: 8, step: 0.1, def: 2 },
      { key: 'threshold', label: 'ink threshold', type: 'range', min: 0.05, max: 0.95, step: 0.01, def: 0.45, fmt: pct },
      { key: 'wetEdge', label: 'wet edges', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct },
      { key: 'color', label: 'ink colour', type: 'seg', def: 'ink', options: [['ink', 'palette ink'], ['source', 'source']] },
    ],
    run(ctx, p) {
      const cov = ctx.pass('chrome.height', HEIGHT, { u_src: p.source === 'alpha' ? 2 : 0 }, { u_tex: ctx.input });
      const b = ctx.blur(cov, Math.max(0.4, p.spread * ctx.k * 0.5));
      ctx.release(cov);
      const colr = p.color === 'source' ? ctx.blur(ctx.input, Math.max(0.4, p.spread * ctx.k * 0.5)) : null;
      const out = ctx.shader(this, p, {}, { u_cov: b, u_col: colr || ctx.input });
      ctx.release(b);
      if (colr) ctx.release(colr);
      return out;
    },
    frag: `
uniform sampler2D u_cov;
uniform sampler2D u_col;
void main() {
  float v = texture(u_cov, v_uv).r;
  vec2 tp = gl_FragCoord.xy / max(1.0, u_k);
  float n = fbm(tp / (u_grain * 6.0)) - 0.5;
  float fibre = vnoise(tp * vec2(0.08, 0.6) / u_grain) - 0.5;
  float v2 = v + (n * 0.6 + fibre * 0.25) * u_roughness * 0.5;
  float aa = fwidth(v2) * 0.8 + 1e-3;
  float m = smoothstep(u_threshold - aa, u_threshold + aa, v2);
  float rim = smoothstep(u_threshold, u_threshold + 0.2, v2);
  float dens = mix(1.0, 0.7 + 0.3 * (1.0 - rim), u_wetEdge) * (0.9 + 0.2 * (n + 0.5));
  vec4 ic = texture(u_col, v_uv);
  vec3 ink = u_color == COLOR_SOURCE ? (ic.a > 0.0 ? ic.rgb : u_ink) : u_ink;
  fragColor = inkOver(paperColor(), ink, clamp(m * dens, 0.0, 1.0));
}`,
  },

  {
    id: 'meshgrad', name: 'mesh gradient', icon: '◐', group: 'light',
    desc: 'animated palette gradient — behind, inside type, or tinting the ink',
    params: [
      { key: 'placement', label: 'placement', type: 'select', def: 'ink', options: [
        ['ink', 'colour the ink (dark areas)'], ['paper', 'colour the paper (light areas)'], ['inside', 'fill shapes (alpha)'],
        ['behind', 'behind (transparent areas)'], ['replace', 'replace everything'],
      ] },
      { key: 'scale', label: 'scale', type: 'range', min: 0.3, max: 3, step: 0.01, def: 1, fmt: times },
      { key: 'warp', label: 'warp', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct },
      { key: 'softness', label: 'softness', type: 'range', min: 0.1, max: 1, step: 0.01, def: 0.45, fmt: pct },
      { key: 'speed', label: 'speed', type: 'range', min: 0, max: 2, step: 0.01, def: 0.25 },
      { key: 'grain', label: 'grain', type: 'range', min: 0, max: 1, step: 0.01, def: 0.25, fmt: pct },
    ],
    animated: p => p.speed > 0,
    frag: `
vec3 mesh(vec2 uv) {
  vec2 asp = vec2(u_res.x / u_res.y, 1.0);
  vec2 p = (uv - 0.5) * asp / u_scale;
  float t = u_time * u_speed;
  p += (vec2(fbm(p * 1.6 + t * 0.3), fbm(p * 1.6 + 5.2 - t * 0.25)) - 0.5) * u_warp * 1.5;
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_palN) break;
    float fi = float(i);
    vec2 h = hash22(vec2(fi * 7.31, 3.1)) - 0.5;
    vec2 c = (h * 1.25 + 0.22 * vec2(sin(t * (0.5 + h.x) + fi), cos(t * (0.4 + h.y) + fi * 1.3))) * asp;
    float d = length(p - c);
    float w = exp(-d * d / (u_softness * u_softness * 0.5));
    acc += u_pal[i] * w;
    ws += w;
  }
  return acc / max(ws, 1e-4);
}
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 g = mesh(v_uv) + (hash12(gl_FragCoord.xy + floor(u_time * 24.0)) - 0.5) * u_grain * 0.1;
  g = clamp(g, 0.0, 1.0);
  float l = luma(c.rgb);
  if (u_placement == PLACEMENT_INK) fragColor = vec4(mix(c.rgb, g, smoothstep(0.75, 0.2, l)), c.a);
  else if (u_placement == PLACEMENT_PAPER) fragColor = vec4(mix(c.rgb, g, smoothstep(0.3, 0.85, l)), c.a);
  else if (u_placement == PLACEMENT_INSIDE) fragColor = vec4(g, c.a);
  else if (u_placement == PLACEMENT_BEHIND) fragColor = over(c, vec4(g, 1.0));
  else fragColor = vec4(g, 1.0);
}`,
  },
];
