import { pct, deg, times, fixed } from './fmt.js';

const bokehCache = new Map();
function bokehOffsets(shape, samples) {
  const key = `${shape}|${samples}`;
  if (bokehCache.has(key)) return bokehCache.get(key);
  const o = [[0, 0]];
  const TAU = Math.PI * 2;
  if (shape === 'circle') {
    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * TAU;
      for (const r of [1 / 3, 2 / 3, 1]) o.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
  } else if (shape === 'star') {
    for (const ring of [0.3, 0.55, 0.8, 1]) {
      for (let s = 0; s < 10; s++) {
        const a = (s / 10) * TAU - Math.PI / 2;
        const rr = s % 2 === 0 ? ring : ring * 0.4;
        o.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
    }
  } else {
    const sides = shape === 'hexagon' ? 6 : shape === 'pentagon' ? 5 : 4;
    const perSide = Math.max(2, Math.floor(samples / sides));
    for (const ring of [0.4, 0.7, 1]) {
      for (let s = 0; s < sides; s++) {
        const a1 = (s / sides) * TAU - Math.PI / 2, a2 = ((s + 1) / sides) * TAU - Math.PI / 2;
        for (let t = 0; t < perSide; t++) {
          const u = t / perSide;
          o.push([(Math.cos(a1) + (Math.cos(a2) - Math.cos(a1)) * u) * ring, (Math.sin(a1) + (Math.sin(a2) - Math.sin(a1)) * u) * ring]);
        }
      }
    }
  }
  const list = o.slice(0, 150);
  const flat = new Float32Array(300);
  list.forEach(([x, y], i) => { flat[i * 2] = x; flat[i * 2 + 1] = -y; });
  const out = { flat, count: list.length };
  bokehCache.set(key, out);
  return out;
}

export default [
  {
    id: 'blur', name: 'blur', icon: '○', group: 'atmosphere',
    desc: 'gaussian, motion or zoom blur',
    params: [
      { key: 'type', label: 'type', type: 'seg', def: 'gaussian', options: [['gaussian', 'gaussian'], ['motion', 'motion'], ['zoom', 'zoom']] },
      { key: 'radius', label: 'radius', type: 'range', min: 0, max: 80, step: 0.5, def: 4, unit: 'px' },
      { key: 'angle', label: 'angle', type: 'range', min: 0, max: 360, step: 1, def: 0, fmt: deg, show: p => p.type === 'motion' },
    ],
    run(ctx, p) {
      if (p.radius <= 0) return null;
      if (p.type === 'gaussian') return ctx.blur(ctx.input, p.radius * ctx.k);
      return ctx.shader(this, p);
    },
    frag: `
void main() {
  vec4 acc = vec4(0.0);
  const int N = 32;
  float j = hash12(gl_FragCoord.xy) / float(N);
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N) + j;
    vec2 uv;
    if (u_type == TYPE_MOTION) {
      float a = radians(u_angle);
      uv = v_uv + vec2(cos(a), sin(a)) * (t - 0.5) * 2.0 * u_radius * u_k / u_res;
    } else {
      uv = 0.5 + (v_uv - 0.5) * (1.0 - u_radius / 200.0 * t);
    }
    vec4 s = texture(u_tex, uv);
    acc += vec4(s.rgb * s.a, s.a);
  }
  fragColor = unpremul(acc / float(N));
}`,
  },

  {
    id: 'bokeh', name: 'bokeh', icon: '◌', group: 'atmosphere',
    desc: 'lens blur where highlights bloom into aperture shapes',
    params: [
      { key: 'radius', label: 'radius', type: 'range', min: 2, max: 40, step: 0.5, def: 8, unit: 'px' },
      { key: 'shape', label: 'aperture shape', type: 'select', def: 'hexagon', options: ['circle', 'hexagon', 'pentagon', 'star', 'square'], glsl: false },
      { key: 'brightBoost', label: 'bright boost', type: 'range', min: 1, max: 5, step: 0.05, def: 1.5, fmt: times },
      { key: 'threshold', label: 'highlight threshold', type: 'range', min: 0, max: 255, step: 1, def: 140 },
      { key: 'samples', label: 'quality', type: 'range', min: 8, max: 48, step: 2, def: 24, fmt: v => `${v} taps`, glsl: false },
    ],
    run(ctx, p) {
      const { flat, count } = bokehOffsets(p.shape, p.samples);
      return ctx.shader(this, p, { u_offs: flat, u_count: count });
    },
    frag: `
uniform vec2 u_offs[150];
uniform int u_count;
void main() {
  float R = u_radius * u_k;
  float thr = u_threshold / 255.0;
  vec3 acc = vec3(0.0);
  float aw = 0.0, wsum = 0.0;
  for (int i = 0; i < 150; i++) {
    if (i >= u_count) break;
    vec4 s = texture(u_tex, v_uv + u_offs[i] * R / u_res);
    float l = luma(s.rgb);
    float w = l > thr ? 1.0 + (l - thr) / max(1.0 - thr, 1e-3) * (u_brightBoost - 1.0) * 4.0 : 1.0;
    acc += s.rgb * s.a * w;
    aw += s.a * w;
    wsum += w;
  }
  fragColor = vec4(aw > 0.0 ? acc / aw : vec3(0.0), aw / wsum);
}`,
  },

  {
    id: 'glow', name: 'bloom / glow', icon: '✺', group: 'atmosphere',
    desc: 'bright areas bleed soft light (two-scale bloom)',
    params: [
      { key: 'threshold', label: 'threshold', type: 'range', min: 0, max: 255, step: 1, def: 180 },
      { key: 'radius', label: 'radius', type: 'range', min: 1, max: 80, step: 0.5, def: 10, unit: 'px' },
      { key: 'amount', label: 'strength', type: 'range', min: 0, max: 3, step: 0.01, def: 0.6, fmt: pct },
      { key: 'tint', label: 'tint', type: 'color', def: '#ffffff' },
    ],
    run(ctx, p) {
      const hw = Math.max(1, Math.round(ctx.w / 2)), hh = Math.max(1, Math.round(ctx.h / 2));
      const bright = ctx.pass('glow.bright', BRIGHT, { u_threshold: p.threshold / 255 }, { u_tex: ctx.input }, hw, hh);
      const s = p.radius * ctx.k * 0.5;
      const a = ctx.blur(bright, s * 0.3 + 0.5);
      const b = ctx.blur(bright, s);
      ctx.release(bright);
      const out = ctx.shader(this, p, {}, { u_a: a, u_b: b });
      ctx.release(a); ctx.release(b);
      return out;
    },
    frag: `
uniform sampler2D u_a;
uniform sampler2D u_b;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec4 a = texture(u_a, v_uv), b = texture(u_b, v_uv);
  vec3 g = (a.rgb * a.a * 0.45 + b.rgb * b.a * 0.85) * u_amount * u_tint;
  vec3 pm = c.rgb * c.a + g;
  float al = clamp(max(c.a, max(g.r, max(g.g, g.b))), 0.0, 1.0);
  fragColor = vec4(min(pm / max(al, 1e-4), 1.0), al);
}`,
  },

  {
    id: 'chromatic', name: 'chromatic aberration', icon: '◈', group: 'atmosphere',
    desc: 'lens colour fringing, radial or straight',
    params: [
      { key: 'amount', label: 'amount', type: 'range', min: 0, max: 40, step: 0.5, def: 5, unit: 'px' },
      { key: 'radial', label: 'radial (from centre)', type: 'toggle', def: true },
      { key: 'spectral', label: 'smooth spectral fringe', type: 'toggle', def: true },
    ],
    frag: `
void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 c = u_res * 0.5;
  vec2 dir = u_radial ? (px - c) / length(c) : vec2(1.0, 0.0);
  vec2 off = dir * u_amount * u_k;
  if (!u_spectral) {
    vec4 r = srcPx(px - off), g = srcPx(px), b = srcPx(px + off);
    fragColor = unpremul(vec4(r.r * r.a, g.g * g.a, b.b * b.a, max(max(r.a, g.a), b.a)));
    return;
  }
  const int N = 12;
  vec3 acc = vec3(0.0), wsum = vec3(0.0);
  float a = 0.0;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1);
    vec3 w = vec3(max(0.0, 1.0 - 2.0 * t), 1.0 - abs(t - 0.5) * 2.0, max(0.0, 2.0 * t - 1.0));
    vec4 s = srcPx(px + off * (t * 2.0 - 1.0));
    acc += s.rgb * s.a * w;
    wsum += w;
    a += s.a;
  }
  a /= float(N);
  fragColor = vec4(a > 0.0 ? acc / wsum / a : vec3(0.0), a);
}`,
  },

  {
    id: 'vignette', name: 'vignette', icon: '⬢', group: 'atmosphere',
    desc: 'darken — or tint, or fade out — the edges',
    params: [
      { key: 'amount', label: 'darkness', type: 'range', min: 0, max: 1, step: 0.01, def: 0.6, fmt: pct },
      { key: 'softness', label: 'softness', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct },
      { key: 'roundness', label: 'roundness', type: 'range', min: 0, max: 1, step: 0.01, def: 0, fmt: pct },
      { key: 'color', label: 'colour', type: 'color', def: '#000000' },
      { key: 'fade', label: 'fade to transparent', type: 'toggle', def: false },
    ],
    frag: `
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 d = v_uv - 0.5;
  d.x *= mix(1.0, u_res.x / u_res.y, u_roundness);
  float r = length(d) * 1.414;
  float inner = (1.0 - u_softness) * 0.4;
  float f = mix(1.0 - u_amount, 1.0, smoothstep(0.8, inner, r));
  if (u_fade) c.a *= f;
  else c.rgb = mix(u_color, c.rgb, f);
  fragColor = c;
}`,
  },

  {
    id: 'grain', name: 'film grain', icon: '⋮', group: 'atmosphere',
    desc: 'photographic grain, strongest in the midtones',
    params: [
      { key: 'amount', label: 'amount', type: 'range', min: 0, max: 100, step: 1, def: 20 },
      { key: 'size', label: 'size', type: 'range', min: 1, max: 6, step: 0.5, def: 1, unit: 'px' },
      { key: 'mono', label: 'monochrome', type: 'toggle', def: true },
      { key: 'animate', label: 'animate', type: 'toggle', def: true },
    ],
    frag: `
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 p = floor(gl_FragCoord.xy / max(1.0, u_size * u_k));
  float t = u_animate ? floor(u_time * 24.0) : 0.0;
  p += vec2(t * 13.17, t * 7.31);
  vec3 n = u_mono ? vec3(hash12(p)) : vec3(hash12(p), hash12(p + 37.0), hash12(p + 71.0));
  float l = luma(c.rgb);
  float resp = 0.45 + 0.55 * 4.0 * l * (1.0 - l);
  c.rgb = clamp(c.rgb + (n - 0.5) * (u_amount / 100.0) * 1.2 * resp, 0.0, 1.0);
  fragColor = c;
}`,
  },

  {
    id: 'noise', name: 'animated noise', icon: '▓', group: 'atmosphere',
    desc: 'tv static, organic fbm, cells, vhs bands, interference',
    params: [
      { key: 'type', label: 'noise type', type: 'select', def: 'white', options: [['white', 'white (tv static)'], ['perlin', 'fbm (organic)'], ['cellular', 'cellular'], ['vhs', 'vhs bands'], ['stripes', 'horizontal lines'], ['interference', 'interference']] },
      { key: 'amount', label: 'amount', type: 'range', min: 0, max: 100, step: 1, def: 30, unit: '%' },
      { key: 'scale', label: 'scale', type: 'range', min: 1, max: 40, step: 0.5, def: 1, unit: '×' },
      { key: 'blend', label: 'blend mode', type: 'select', def: 'overlay', options: ['overlay', 'soft light', 'multiply', 'screen', 'add', 'replace'] },
      { key: 'color', label: 'colour noise', type: 'toggle', def: false },
      { key: 'animate', label: 'animate', type: 'toggle', def: true },
    ],
    frag: `
float worley(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d = 1.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    d = min(d, length(g + hash22(i + g) - f));
  }
  return d;
}
float noiseAt(vec2 px, float t, float seed) {
  vec2 p = px / max(1.0, u_scale * u_k);
  if (u_type == TYPE_WHITE) return hash12(floor(p) + seed + floor(t * 60.0) * 1.37);
  if (u_type == TYPE_PERLIN) return fbm(p * 0.08 + vec2(t * 0.6, t * 0.4) + seed);
  if (u_type == TYPE_CELLULAR) return 1.0 - worley(p * 0.12 + t * 0.4 + seed);
  if (u_type == TYPE_VHS) {
    float band = floor(p.y);
    float j = sin(band * 0.7 + t * 9.0) * sin(px.x * 0.01 + t);
    return (j + 1.0) * 0.5 * (hash12(vec2(band + seed, floor(t * 30.0))) * 0.5 + 0.5);
  }
  if (u_type == TYPE_STRIPES) return mod(floor(p.y) + floor(t * 10.0), 2.0);
  return (sin(p.x * 0.35 + t * 5.0 + seed) * sin(p.y * 0.28 - t * 3.0) + 1.0) * 0.5;
}
vec3 blendN(vec3 b, vec3 m) {
  if (u_blend == BLEND_OVERLAY) return mix(2.0 * b * m, 1.0 - 2.0 * (1.0 - b) * (1.0 - m), step(0.5, b));
  if (u_blend == BLEND_SOFT_LIGHT) return mix(2.0 * b * m + b * b * (1.0 - 2.0 * m), sqrt(b) * (2.0 * m - 1.0) + 2.0 * b * (1.0 - m), step(0.5, m));
  if (u_blend == BLEND_MULTIPLY) return b * m;
  if (u_blend == BLEND_SCREEN) return 1.0 - (1.0 - b) * (1.0 - m);
  if (u_blend == BLEND_ADD) return clamp(b + m - 0.5, 0.0, 1.0);
  return m;
}
void main() {
  vec4 c = texture(u_tex, v_uv);
  float t = u_animate ? u_time : 0.0;
  vec2 px = gl_FragCoord.xy;
  vec3 n = u_color ? vec3(noiseAt(px, t, 0.0), noiseAt(px, t, 19.7), noiseAt(px, t, 41.3)) : vec3(noiseAt(px, t, 0.0));
  c.rgb = mix(c.rgb, blendN(c.rgb, n), u_amount / 100.0);
  fragColor = c;
}`,
  },

  {
    id: 'crt', name: 'crt', icon: '▤', group: 'atmosphere',
    desc: 'curved glass, scanlines, phosphor mask, halation',
    params: [
      { key: 'curvature', label: 'screen curvature', type: 'range', min: 0, max: 0.5, step: 0.01, def: 0.15, fmt: fixed(2) },
      { key: 'lineSize', label: 'scanline size', type: 'range', min: 1, max: 8, step: 0.5, def: 1, unit: '×' },
      { key: 'lineStrength', label: 'line strength', type: 'range', min: 0, max: 3, step: 0.05, def: 1, fmt: fixed(2) },
      { key: 'brightnessAdjust', label: 'brightness boost', type: 'range', min: -0.5, max: 0.5, step: 0.01, def: 0, fmt: fixed(2) },
      { key: 'scanlines', label: 'classic scanline spacing', type: 'range', min: 2, max: 12, step: 0.5, def: 4, unit: 'px' },
      { key: 'classicDim', label: 'classic line darkness', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3, fmt: pct },
      { key: 'mask', label: 'phosphor mask', type: 'select', def: 'stripes', options: [['none', 'none'], ['stripes', 'rgb stripes'], ['shadow', 'shadow mask'], ['slot', 'slot mask']] },
      { key: 'maskStrength', label: 'mask strength', type: 'range', min: 0, max: 1, step: 0.01, def: 0.25, fmt: pct, show: p => p.mask !== 'none' },
      { key: 'maskSize', label: 'mask size', type: 'range', min: 0.5, max: 4, step: 0.1, def: 1, unit: '×', show: p => p.mask !== 'none' },
      { key: 'glow', label: 'halation', type: 'range', min: 0, max: 1, step: 0.01, def: 0.25, fmt: pct },
      { key: 'vignette', label: 'vignette strength', type: 'range', min: 0, max: 1, step: 0.01, def: 0.4, fmt: pct },
      { key: 'vignetteWidth', label: 'vignette width', type: 'range', min: 5, max: 150, step: 1, def: 30, unit: 'px' },
      { key: 'flicker', label: 'flicker', type: 'toggle', def: false },
    ],
    animated: p => p.flicker,
    frag: `
void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  vec2 off = uv.yx * u_curvature;
  uv += uv * off * off;
  uv = uv * 0.5 + 0.5;
  vec4 bezel = u_clear ? vec4(0.0) : vec4(0.0, 0.0, 0.0, 1.0);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { fragColor = bezel; return; }
  vec4 src = texture(u_tex, uv);
  vec3 c = src.rgb;
  if (u_glow > 0.0) {
    vec3 g = vec3(0.0);
    vec2 o = 2.5 * u_k / u_res;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * TAU / 8.0;
      vec2 d = vec2(cos(a), sin(a));
      g += texture(u_tex, uv + d * o * 2.0).rgb + texture(u_tex, uv + d * o * 5.0).rgb;
    }
    g /= 16.0;
    c += g * g * u_glow * 1.2;
  }
  float yRef = (1.0 - uv.y) * u_res.y / u_k;
  float ph = yRef * 2.0 / pow(2.0, u_lineSize);
  float gMod = (sin(ph) + 1.0) * 0.15 * u_lineStrength + 1.0 + u_brightnessAdjust;
  float rbMod = (cos(ph) + 1.0) * 0.135 * u_lineStrength + 1.0 + u_brightnessAdjust;
  c *= vec3(rbMod, gMod, rbMod);
  if (u_mask != MASK_NONE) {
    vec2 mp = gl_FragCoord.xy / max(1.0, u_k * u_maskSize);
    float x = mp.x;
    if (u_mask == MASK_SHADOW) x += mod(floor(mp.y), 2.0) * 1.5;
    float ph3 = mod(floor(x), 3.0);
    vec3 m = ph3 < 1.0 ? vec3(1.0, 0.0, 0.0) : (ph3 < 2.0 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
    float dim = 1.0 - u_maskStrength;
    vec3 mk = mix(vec3(dim), vec3(1.0), m);
    if (u_mask == MASK_SLOT && fract((mp.y + floor(x / 3.0) * 1.5) / 3.0) > 0.8) mk *= dim;
    c *= mk;
  }
  float yPx = gl_FragCoord.y / u_k;
  c *= mod(yPx, u_scanlines) < u_scanlines * 0.5 ? 1.0 : 1.0 - u_classicDim;
  vec2 d = min(gl_FragCoord.xy, u_res - gl_FragCoord.xy);
  float vw = u_vignetteWidth * u_k;
  c *= mix(1.0 - u_vignette, 1.0, smoothstep(0.0, vw, d.x) * smoothstep(0.0, vw, d.y));
  if (u_flicker) c *= 1.0 + 0.035 * sin(u_time * 113.0) + 0.02 * sin(u_time * 7.3);
  fragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}`,
  },

  {
    id: 'vhs', name: 'vhs tape', icon: '▭', group: 'atmosphere',
    desc: 'tape wobble, chroma bleed, tracking noise, head switching',
    params: [
      { key: 'wobble', label: 'tape wobble', type: 'range', min: 0, max: 1, step: 0.01, def: 0.4, fmt: pct },
      { key: 'bleed', label: 'chroma bleed', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct },
      { key: 'tracking', label: 'tracking error', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3, fmt: pct },
      { key: 'noise', label: 'noise', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3, fmt: pct },
      { key: 'fade', label: 'colour fade', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3, fmt: pct },
      { key: 'animate', label: 'animate', type: 'toggle', def: true },
    ],
    frag: `
vec3 rgb2yiq(vec3 c) { return mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c; }
vec3 yiq2rgb(vec3 c) { return mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * c; }
void main() {
  float t = u_animate ? u_time : 0.0;
  vec2 uv = v_uv;
  float yTop = 1.0 - uv.y;
  float line = floor(yTop * u_res.y / max(1.0, u_k));
  float wob = (vnoise(vec2(yTop * 8.0, t * 2.0)) - 0.5) * 0.006 * u_wobble
            + (hash12(vec2(line, floor(t * 30.0))) - 0.5) * 0.0015 * u_wobble;
  float bandPos = fract(t * 0.08 + 0.3);
  float band = u_tracking > 0.0 ? smoothstep(0.06 * u_tracking + 0.002, 0.0, abs(yTop - bandPos)) : 0.0;
  wob += band * (hash12(vec2(line, floor(t * 60.0))) - 0.5) * 0.04;
  float hs = smoothstep(0.955, 1.0, yTop);
  wob += hs * (0.02 + 0.03 * vnoise(vec2(yTop * 40.0, t * 10.0)));
  uv.x += wob;
  vec4 c0 = texture(u_tex, uv);
  vec3 yiq = rgb2yiq(c0.rgb);
  vec2 iq = vec2(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 10; i++) {
    float o = float(i) / 9.0;
    float w = 1.0 - o * 0.7;
    iq += rgb2yiq(texture(u_tex, uv - vec2(o * u_bleed * 0.015, 0.0)).rgb).yz * w;
    wsum += w;
  }
  yiq.yz = iq / wsum * (1.0 - u_fade * 0.45);
  vec3 col = yiq2rgb(yiq);
  col = mix(col, col * vec3(1.05, 0.98, 0.9) + vec3(0.04, 0.03, 0.05), u_fade);
  col += (hash12(gl_FragCoord.xy + t * 100.0) - 0.5) * u_noise * 0.18;
  float speck = step(0.992 - band * 0.05, hash12(vec2(floor(gl_FragCoord.x / (6.0 * u_k)), line + floor(t * 50.0))));
  col += speck * u_noise * (0.35 + band);
  col = mix(col, vec3(hash12(gl_FragCoord.xy * 0.5 + t)), band * 0.25 * u_tracking);
  fragColor = vec4(clamp(col, 0.0, 1.0), c0.a);
}`,
  },
];

const BRIGHT = `
uniform float u_threshold;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float l = max(c.r, max(c.g, c.b));
  float knee = 0.08;
  float soft = clamp(l - u_threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float contrib = max(soft, l - u_threshold) / max(l, 1e-4);
  fragColor = vec4(c.rgb * clamp(contrib, 0.0, 1.0), c.a);
}`;
