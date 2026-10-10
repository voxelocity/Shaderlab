import { pct, deg, times } from './fmt.js';
import { hexToRgb01 } from '../gl/glsl.js';

function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return null;
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
          B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
          C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}

// Least-squares spot-colour separation: find ink amounts x >= 0 whose combined absorbance
// K x best matches the pixel's absorbance (1 - rgb). Returns a column-major mat3 for GLSL.
function separation(inks) {
  const K = inks.map(c => c.map(v => 1 - v));          // rows: inks, cols: rgb absorbance
  while (K.length < 3) K.push([0, 0, 0]);
  // KtK (3x3) where Kmat columns are inks: (Kmat^T Kmat)_ij = dot(K[i], K[j])
  const KtK = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) KtK.push(K[r][0] * K[c][0] + K[r][1] * K[c][1] + K[r][2] * K[c][2] + (r === c ? 0.02 : 0));
  const inv = inv3(KtK) || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // M = inv(KtK) * Kmat^T : M[r][ch] = sum_c inv[r][c] * K[c][ch]
  const M = [];
  for (let r = 0; r < 3; r++) M.push([0, 1, 2].map(ch => inv[r * 3] * K[0][ch] + inv[r * 3 + 1] * K[1][ch] + inv[r * 3 + 2] * K[2][ch]));
  return new Float32Array([M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]);
}

export default [
  {
    id: 'riso', name: 'risograph', icon: '◍', group: 'print', paper: true,
    desc: 'separates into 2–3 fluoro spot inks — grainy, misregistered, on paper',
    thumb: { size: 1.5 },
    params: [
      { key: 'ink1', label: 'ink 1', type: 'color', def: '#ff48b0' },
      { key: 'ink2', label: 'ink 2', type: 'color', def: '#0078bf' },
      { key: 'useInk3', label: 'third ink', type: 'toggle', def: true },
      { key: 'ink3', label: 'ink 3', type: 'color', def: '#ffe800', show: p => p.useInk3 },
      { key: 'paperColor', label: 'paper', type: 'color', def: '#f6f1e7' },
      { key: 'screen', label: 'screen', type: 'seg', def: 'grain', options: [['grain', 'stochastic grain'], ['dots', 'dots']] },
      { key: 'size', label: 'grain / dot size', type: 'range', min: 1, max: 16, step: 0.5, def: 2, unit: 'px' },
      { key: 'misregister', label: 'misregistration', type: 'range', min: 0, max: 14, step: 0.5, def: 3, unit: 'px' },
      { key: 'density', label: 'ink density', type: 'range', min: 0.4, max: 2.2, step: 0.05, def: 1.15, fmt: times },
      { key: 'texture', label: 'ink unevenness', type: 'range', min: 0, max: 1, step: 0.01, def: 0.45, fmt: pct },
      { key: 'paperGrain', label: 'paper grain', type: 'range', min: 0, max: 1, step: 0.01, def: 0.4, fmt: pct },
      { key: 'seed', label: 'registration seed', type: 'range', min: 0, max: 99, step: 1, def: 7 },
    ],
    run(ctx, p) {
      const inks = [p.ink1, p.ink2, ...(p.useInk3 ? [p.ink3] : [])].map(hexToRgb01);
      const offs = [0, 1, 2].map(i => {
        const a = (p.seed * 2.399 + i * 2.1) % (Math.PI * 2);
        const r = p.misregister * ctx.k * (i === 0 ? 0.35 : 1);
        return [Math.cos(a) * r, Math.sin(a) * r];
      });
      return ctx.shader(this, p, { u_sep: separation(inks), u_off1: offs[0], u_off2: offs[1], u_off3: offs[2] }, { u_blue: ctx.blueNoise() });
    },
    frag: `
uniform sampler2D u_blue;
uniform mat3 u_sep;
uniform vec2 u_off1, u_off2, u_off3;
vec3 amounts(vec2 px) {
  vec4 s = srcPx(px);
  return clamp(u_sep * ((1.0 - s.rgb) * s.a) * u_density, 0.0, 1.0);
}
float screenMask(float v, vec2 px, int i) {
  float cell = max(1.0, u_size * u_k);
  if (u_screen == SCREEN_GRAIN) {
    ivec2 ip = ivec2(floor(px / cell)) + ivec2(i * 23, i * 41);
    vec4 b = texelFetch(u_blue, ip & 63, 0);
    float t = (i == 0 ? b.r : i == 1 ? b.g : b.b) * 0.996 + 0.002;
    return step(t, v);
  }
  float dc = cell * 2.5;
  vec2 q = rot2(radians(15.0 + float(i) * 30.0)) * px / dc;
  float d = length(fract(q) - 0.5) - 0.70711 * sqrt(v);
  return (1.0 - smoothstep(-0.75 / dc, 0.75 / dc, d)) * step(0.004, v);
}
void main() {
  vec2 px = gl_FragCoord.xy;
  float v1 = amounts(px + u_off1).x, v2 = amounts(px + u_off2).y, v3 = amounts(px + u_off3).z;
  vec2 tp = px / max(1.0, u_k);
  v1 *= 1.0 - u_texture * 0.55 * fbm(tp / 38.0 + 3.1);
  v2 *= 1.0 - u_texture * 0.55 * fbm(tp / 41.0 + 7.7);
  v3 *= 1.0 - u_texture * 0.55 * fbm(tp / 36.0 + 1.9);
  float m1 = screenMask(v1, px, 0), m2 = screenMask(v2, px, 1), m3 = u_useInk3 ? screenMask(v3, px, 2) : 0.0;
  vec3 col = vec3(1.0);
  col *= mix(vec3(1.0), u_ink1, m1 * 0.93);
  col *= mix(vec3(1.0), u_ink2, m2 * 0.93);
  col *= mix(vec3(1.0), u_ink3, m3 * 0.93);
  float grain = (hash12(floor(tp)) - 0.5) * u_paperGrain * 0.1 + (vnoise(tp * vec2(0.05, 0.4)) - 0.5) * u_paperGrain * 0.05;
  if (u_clear) {
    float cov = 1.0 - (1.0 - m1 * 0.93) * (1.0 - m2 * 0.93) * (1.0 - m3 * 0.93);
    fragColor = vec4(clamp((col - (1.0 - cov)) / max(cov, 1e-4), 0.0, 1.0), cov);
  } else {
    fragColor = vec4(clamp(col * u_paperColor + grain, 0.0, 1.0), 1.0);
  }
}`,
  },

  {
    id: 'contour', name: 'contour lines', icon: '◎', group: 'graphic', paper: true,
    desc: 'topographic iso-lines traced through brightness',
    params: [
      { key: 'levels', label: 'levels', type: 'range', min: 2, max: 60, step: 1, def: 14 },
      { key: 'width', label: 'line width', type: 'range', min: 0.3, max: 6, step: 0.1, def: 1.2, unit: 'px' },
      { key: 'smooth', label: 'smoothing', type: 'range', min: 0, max: 24, step: 0.5, def: 3, unit: 'px', glsl: false },
      { key: 'fill', label: 'fill', type: 'seg', def: 'none', options: [['none', 'paper'], ['bands', 'palette bands'], ['source', 'source']] },
      { key: 'lineColor', label: 'line colour', type: 'seg', def: 'ink', options: [['ink', 'ink'], ['ramp', 'palette ramp'], ['source', 'source']] },
      { key: 'animate', label: 'flow', type: 'toggle', def: false },
      { key: 'speed', label: 'speed', type: 'range', min: 0.05, max: 2, step: 0.05, def: 0.3, show: p => p.animate },
    ],
    run(ctx, p) {
      const soft = p.smooth > 0 ? ctx.blur(ctx.input, p.smooth * ctx.k * 0.5) : null;
      const out = ctx.shader(this, p, {}, { u_soft: soft || ctx.input });
      if (soft) ctx.release(soft);
      return out;
    },
    frag: `
uniform sampler2D u_soft;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec4 s = texture(u_soft, v_uv);
  float h = luma(s.rgb) * s.a + (1.0 - s.a);
  float f = h * u_levels - (u_animate ? u_time * u_speed : 0.0);
  float d = abs(fract(f + 0.5) - 0.5) / max(fwidth(f), 1e-4);
  float w = max(0.5, u_width * u_k * 0.5);
  float line = 1.0 - smoothstep(w - 0.6, w + 0.6, d);
  float band = clamp(floor(f) / max(u_levels - 1.0, 1.0), 0.0, 1.0);
  vec4 base = paperColor();
  if (u_fill == FILL_BANDS) base = vec4(palRamp(band), 1.0);
  else if (u_fill == FILL_SOURCE) base = over(c, base);
  vec3 lc = u_lineColor == LINECOLOR_RAMP ? palRamp(u_fill == FILL_BANDS ? 1.0 - band : band)
          : u_lineColor == LINECOLOR_SOURCE ? s.rgb : u_ink;
  fragColor = inkOver(base, lc, line);
}`,
  },

  {
    id: 'stained', name: 'stained glass', icon: '⬡', group: 'graphic',
    desc: 'voronoi cells of colour with lead lines — or soft crystallize',
    params: [
      { key: 'size', label: 'cell size', type: 'range', min: 6, max: 140, step: 1, def: 28, unit: 'px' },
      { key: 'jitter', label: 'irregularity', type: 'range', min: 0, max: 1, step: 0.01, def: 0.85, fmt: pct },
      { key: 'mode', label: 'style', type: 'seg', def: 'stained', options: [['stained', 'stained glass'], ['crystal', 'crystallize']] },
      { key: 'lead', label: 'lead width', type: 'range', min: 0, max: 10, step: 0.25, def: 2.5, unit: 'px', show: p => p.mode === 'stained' },
      { key: 'leadColor', label: 'lead colour', type: 'color', def: '#15120f', show: p => p.mode === 'stained' },
      { key: 'shading', label: 'glass shading', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct },
      { key: 'animate', label: 'animate', type: 'toggle', def: false },
      { key: 'speed', label: 'speed', type: 'range', min: 0.05, max: 2, step: 0.05, def: 0.4, show: p => p.animate },
    ],
    frag: `
vec2 fpoint(vec2 id) {
  vec2 h = hash22(id);
  if (u_animate) h = 0.5 + 0.5 * sin(u_time * u_speed + TAU * h);
  return 0.5 + (h - 0.5) * u_jitter;
}
void main() {
  float cell = max(3.0, u_size * u_k);
  vec2 p = gl_FragCoord.xy / cell;
  vec2 ip = floor(p), fp = fract(p);
  vec2 mr = vec2(0.0), mg = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + fpoint(ip + g) - fp;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  float bd = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + fpoint(ip + g) - fp;
    if (dot(mr - r, mr - r) > 1e-5) bd = min(bd, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  vec2 centre = (ip + mg + fpoint(ip + mg)) * cell;
  vec4 s = texture(u_tex, centre / u_res);
  vec3 col = s.rgb;
  float shade = 1.0 + u_shading * (0.22 - sqrt(md) * 0.5) + u_shading * 0.18 * (vnoise(gl_FragCoord.xy / (cell * 0.3)) - 0.5);
  col *= shade;
  float a = s.a;
  if (u_mode == MODE_STAINED) {
    float w = u_lead * u_k * 0.5;
    float L = w > 0.0 ? 1.0 - smoothstep(w - 0.7, w + 0.7, bd * cell) : 0.0;
    col = mix(col, u_leadColor, L);
    a = max(a, L * step(0.01, a));
  }
  fragColor = vec4(clamp(col, 0.0, 1.0), a);
}`,
  },

  {
    id: 'flowstrokes', name: 'flow strokes', icon: '⫽', group: 'graphic', paper: true,
    desc: 'pen strokes that follow the edges of the image',
    thumb: { size: 8 },
    params: [
      { key: 'size', label: 'stroke spacing', type: 'range', min: 4, max: 40, step: 0.5, def: 9, unit: 'px' },
      { key: 'length', label: 'stroke length', type: 'range', min: 0.5, max: 3, step: 0.05, def: 1.6, fmt: times },
      { key: 'thickness', label: 'thickness', type: 'range', min: 0.05, max: 1, step: 0.01, def: 0.45, fmt: pct },
      { key: 'follow', label: 'follow edges', type: 'range', min: 0, max: 1, step: 0.01, def: 1, fmt: pct },
      { key: 'angle', label: 'base angle', type: 'range', min: 0, max: 180, step: 1, def: 45, fmt: deg },
      { key: 'jitter', label: 'jitter', type: 'range', min: 0, max: 1, step: 0.01, def: 0.6, fmt: pct },
      { key: 'contrast', label: 'contrast', type: 'range', min: 0.3, max: 3, step: 0.05, def: 1.2, fmt: times },
      { key: 'color', label: 'stroke colour', type: 'seg', def: 'ink', options: [['ink', 'palette ink'], ['source', 'source']] },
    ],
    frag: `
void main() {
  float cell = max(3.0, u_size * u_k);
  vec2 px = gl_FragCoord.xy;
  vec2 ig = floor(px / cell);
  vec2 base = vec2(cos(radians(u_angle)), sin(radians(u_angle)));
  float best = 0.0;
  vec3 bestCol = u_ink;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 id = ig + vec2(float(i), float(j));
    vec2 c = (id + 0.5 + (hash22(id) - 0.5) * u_jitter) * cell;
    vec4 s = texture(u_tex, c / u_res);
    float l = clamp((luma(s.rgb) - 0.5) * u_contrast + 0.5, 0.0, 1.0);
    float d = (1.0 - l) * s.a;
    if (d < 0.04 || hash12(id + 9.1) > d * 1.6) continue;
    float e = cell * 0.75;
    float gx = luma(texture(u_tex, (c + vec2(e, 0.0)) / u_res).rgb) - luma(texture(u_tex, (c - vec2(e, 0.0)) / u_res).rgb);
    float gy = luma(texture(u_tex, (c + vec2(0.0, e)) / u_res).rgb) - luma(texture(u_tex, (c - vec2(0.0, e)) / u_res).rgb);
    float gl = length(vec2(gx, gy));
    vec2 along = gl > 1e-4 ? vec2(-gy, gx) / gl : base;
    if (dot(along, base) < 0.0) along = -along;
    vec2 dir = normalize(mix(base, along, u_follow * smoothstep(0.0, 0.08, gl)) + 1e-4);
    float len = u_length * cell * 0.5 * (0.65 + 0.35 * hash12(id + 3.0));
    float hw = max(0.5, u_thickness * cell * 0.22 * (0.45 + d));
    vec2 pa = px - c;
    float h = clamp(dot(pa, dir), -len, len);
    float m = 1.0 - smoothstep(-0.75, 0.75, length(pa - dir * h) - hw);
    if (m > best) { best = m; bestCol = s.rgb; }
  }
  fragColor = inkOver(paperColor(), u_color == COLOR_SOURCE ? bestCol : u_ink, best);
}`,
  },

  {
    id: 'cubes', name: 'isometric cubes', icon: '⬢', group: 'graphic',
    desc: 'the image rebuilt from shaded isometric blocks',
    thumb: { size: 14 },
    params: [
      { key: 'size', label: 'cube size', type: 'range', min: 6, max: 80, step: 0.5, def: 18, unit: 'px' },
      { key: 'shading', label: 'shading', type: 'range', min: 0, max: 1, step: 0.01, def: 0.6, fmt: pct },
      { key: 'light', label: 'light from', type: 'seg', def: 'left', options: [['left', 'left'], ['right', 'right']] },
      { key: 'outline', label: 'edge lines', type: 'range', min: 0, max: 3, step: 0.05, def: 0.6, unit: 'px' },
      { key: 'gap', label: 'gap', type: 'range', min: 0, max: 0.4, step: 0.01, def: 0, fmt: pct },
      { key: 'levels', label: 'colour steps', type: 'range', min: 1, max: 8, step: 1, def: 1, fmt: v => v < 2 ? 'smooth' : `${v}` },
      { key: 'usePalette', label: 'snap to palette', type: 'toggle', def: false },
    ],
    frag: `
void main() {
  float s = max(4.0, u_size * u_k);
  vec2 g = gl_FragCoord.xy / s;
  vec2 r = vec2(1.0, 1.7320508), h = r * 0.5;
  vec2 a = mod(g, r) - h, b = mod(g - h, r) - h;
  vec2 loc = dot(a, a) < dot(b, b) ? a : b;
  vec4 c = texture(u_tex, (g - loc) * s / u_res);
  vec3 col = c.rgb;
  if (u_usePalette) col = nearestPal(col);
  else if (u_levels >= 2.0) col = floor(col * (u_levels - 1.0) + 0.5) / (u_levels - 1.0);
  loc /= max(1.0 - u_gap, 0.05);
  vec2 q = abs(loc);
  float hexd = max(q.x, dot(q, vec2(0.5, 0.8660254))) - 0.5;
  float ang = degrees(atan(loc.y, loc.x));
  if (ang < 0.0) ang += 360.0;
  bool top = ang >= 30.0 && ang < 150.0;
  bool left = ang >= 150.0 && ang < 270.0;
  float sh = u_shading;
  float fl = 1.0 - 0.22 * sh, fr = 1.0 - 0.5 * sh;
  if (u_light == LIGHT_RIGHT) { float t = fl; fl = fr; fr = t; }
  col *= top ? 1.0 + 0.18 * sh : (left ? fl : fr);
  // edge lines: hexagon outline + the three spokes meeting at the near corner
  float spoke = 1e9;
  vec2 dirs[3] = vec2[3](vec2(0.8660254, 0.5), vec2(-0.8660254, 0.5), vec2(0.0, -1.0));
  for (int i = 0; i < 3; i++) {
    float along = dot(loc, dirs[i]);
    if (along > 0.0) spoke = min(spoke, abs(dot(loc, vec2(-dirs[i].y, dirs[i].x))));
  }
  float edgePx = min(abs(hexd), spoke) * s * max(1.0 - u_gap, 0.05);
  float w = u_outline * u_k * 0.5;
  float line = w > 0.0 ? 1.0 - smoothstep(w - 0.6, w + 0.6, edgePx) : 0.0;
  col = mix(col, col * 0.35, line);
  float inside = 1.0 - smoothstep(-0.01, 0.01, hexd);
  vec4 o = vec4(clamp(col, 0.0, 1.0), c.a);
  fragColor = mix(paperColor(), o, inside);
}`,
  },
];
