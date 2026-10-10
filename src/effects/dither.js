import { pct, deg, times } from './fmt.js';
import { errorDiffuse, DIFFUSERS } from '../cpu/dither.js';

const TEMPORAL = [['off', 'off'], ['shimmer', 'shimmer'], ['crawl', 'crawl'], ['boil', 'boil'], ['scan', 'scan']];
const ORDERED = ['bayer2', 'bayer4', 'bayer8', 'bayer16', 'cluster', 'bluenoise', 'ign', 'random'];

export default [
  {
    id: 'dither', name: 'dither', icon: '≋', group: 'dither',
    desc: '21 algorithms — error diffusion, ordered, blue noise — onto your palette',
    params: [
      { key: 'algorithm', label: 'algorithm', type: 'select', def: 'floyd', options: [
        ['floyd', 'floyd–steinberg'], ['atkinson', 'atkinson (mac)'], ['jarvis', 'jarvis–judice–ninke'],
        ['stucki', 'stucki'], ['burkes', 'burkes'], ['sierra', 'sierra lite'], ['sierra2', 'sierra two-row'],
        ['sierra3', 'sierra'], ['fan', 'fan'], ['shiaufan', 'shiau–fan'], ['falsefloyd', 'false floyd–steinberg'],
        ['stevenson', 'stevenson–arce'], ['riemersma', 'riemersma (hilbert curve)'],
        ['bluenoise', 'blue noise'], ['bayer2', 'bayer 2×2'], ['bayer4', 'bayer 4×4'], ['bayer8', 'bayer 8×8'],
        ['bayer16', 'bayer 16×16'], ['cluster', 'clustered dot'], ['ign', 'interleaved gradient'], ['random', 'white noise'],
      ] },
      { key: 'scale', label: 'pixel scale', type: 'range', min: 1, max: 12, step: 0.5, def: 1, unit: '×' },
      { key: 'strength', label: 'strength', type: 'range', min: 0, max: 1.5, step: 0.01, def: 1, fmt: pct },
      { key: 'colors', label: 'quantise to', type: 'seg', def: 'palette', options: [['palette', 'palette'], ['rgb', 'rgb levels']] },
      { key: 'levels', label: 'levels per channel', type: 'range', min: 2, max: 8, step: 1, def: 2, show: p => p.colors === 'rgb' },
      { key: 'serpentine', label: 'serpentine scan', type: 'toggle', def: true, glsl: false, show: p => DIFFUSERS.includes(p.algorithm) && p.algorithm !== 'riemersma' },
      { key: 'temporal', label: 'temporal variation', type: 'select', def: 'off', options: TEMPORAL, show: p => ORDERED.includes(p.algorithm) },
      { key: 'speed', label: 'speed', type: 'range', min: 0.1, max: 4, step: 0.1, def: 1, fmt: times, show: p => ORDERED.includes(p.algorithm) && p.temporal !== 'off' },
    ],
    cpu: p => DIFFUSERS.includes(p.algorithm),
    animated: p => ORDERED.includes(p.algorithm) && p.temporal && p.temporal !== 'off',
    run(ctx, p) {
      if (!DIFFUSERS.includes(p.algorithm)) return ctx.shader(this, p, {}, { u_blue: ctx.blueNoise() });
      const cell = Math.max(1, p.scale * ctx.k);
      const sw = Math.max(1, Math.round(ctx.w / cell)), sh = Math.max(1, Math.round(ctx.h / cell));
      const small = ctx.downsample(ctx.input, sw, sh);
      const data = ctx.read(small);
      ctx.release(small);
      errorDiffuse(data, sw, sh, {
        palette: ctx.palette, algo: p.algorithm, strength: p.strength,
        serpentine: p.serpentine, rgbLevels: p.colors === 'rgb' ? p.levels : 0,
      });
      const up = ctx.upload(data, sw, sh);
      const out = ctx.nearest(up);
      ctx.release(up);
      return out;
    },
    frag: `
uniform sampler2D u_blue;
float bayer(ivec2 p, int n) {
  int v = 0;
  for (int i = 0; i < 4; i++) {
    if (i >= n) break;
    int xb = (p.x >> i) & 1;
    int yb = (p.y >> i) & 1;
    v += (2 * (xb ^ yb) + yb) << (2 * (n - 1 - i));
  }
  return (float(v) + 0.5) / float(1 << (2 * n));
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float cluster(ivec2 p) {
  vec2 q = (vec2(p & 7) + 0.5) / 8.0;
  return 0.5 + 0.25 * (cos(TAU * q.x) + cos(TAU * q.y));
}
void main() {
  float cell = max(1.0, u_scale * u_k);
  vec2 cp = floor(gl_FragCoord.xy / cell);
  vec4 c = texture(u_tex, (cp + 0.5) * cell / u_res);
  bool anim = u_temporal != TEMPORAL_OFF;
  float fr = floor(u_time * 12.0 * u_speed);
  ivec2 ip = ivec2(cp);
  if (anim && u_temporal == TEMPORAL_CRAWL) ip += ivec2(int(fr), int(fr) * 2);
  if (anim && u_temporal == TEMPORAL_BOIL) ip += ivec2(int(hash12(vec2(fr, 1.7)) * 64.0), int(hash12(vec2(fr, 9.3)) * 64.0));
  float t;
  if (u_algorithm == ALGORITHM_BAYER2) t = bayer(ip, 1);
  else if (u_algorithm == ALGORITHM_BAYER4) t = bayer(ip, 2);
  else if (u_algorithm == ALGORITHM_BAYER8) t = bayer(ip, 3);
  else if (u_algorithm == ALGORITHM_BAYER16) t = bayer(ip, 4);
  else if (u_algorithm == ALGORITHM_CLUSTER) t = cluster(ip);
  else if (u_algorithm == ALGORITHM_BLUENOISE) t = (texelFetch(u_blue, ip & 63, 0).r * 255.0 + 0.5) / 256.0;
  else if (u_algorithm == ALGORITHM_IGN) t = ign(vec2(ip));
  else t = hash12(vec2(ip) + (anim ? fr * 17.31 : 0.0));
  if (anim && u_temporal == TEMPORAL_SHIMMER) t = fract(t + fr * 0.618034);
  if (anim && u_temporal == TEMPORAL_SCAN) t = clamp(t + 0.3 * sin(v_uv.y * 9.0 - u_time * u_speed * 4.0), 0.0, 1.0);
  vec3 q;
  if (u_colors == COLORS_RGB) {
    float n = u_levels - 1.0;
    q = clamp(floor(c.rgb * n + 0.5 + (t - 0.5) * u_strength) / n, 0.0, 1.0);
  } else {
    q = nearestPal(c.rgb + (t - 0.5) * u_strength / float(max(u_palN - 1, 1)));
  }
  fragColor = vec4(q, step(t, c.a));
}`,
  },

  {
    id: 'patterndither', name: 'pattern dither', icon: '▩', group: 'dither',
    desc: 'bitmap screens — dots, lines, waves, rings, spirals, truchet mazes',
    thumb: { scale: 10 },
    params: [
      { key: 'pattern', label: 'pattern', type: 'select', def: 'dots', options: [
        ['dots', 'clustered dots'], ['lines', 'lines'], ['cross', 'grid'], ['diamond', 'diamonds'], ['checker', 'checker'],
        ['waves', 'waves'], ['zigzag', 'zigzag'], ['rings', 'rings'], ['spiral', 'spiral'], ['maze', 'truchet maze'],
        ['bricks', 'bricks'], ['noise', 'organic noise'],
      ] },
      { key: 'scale', label: 'scale', type: 'range', min: 2, max: 60, step: 0.5, def: 8, unit: 'px' },
      { key: 'angle', label: 'angle', type: 'range', min: 0, max: 180, step: 1, def: 45, fmt: deg },
      { key: 'contrast', label: 'contrast', type: 'range', min: 0.2, max: 3, step: 0.05, def: 1, fmt: times },
      { key: 'output', label: 'output', type: 'seg', def: 'palette', options: [['palette', 'palette'], ['ink', 'ink & paper'], ['source', 'source ink']] },
      { key: 'strength', label: 'strength', type: 'range', min: 0, max: 2, step: 0.01, def: 1, fmt: pct, show: p => p.output === 'palette' },
      { key: 'cx', label: 'centre x', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct, show: p => p.pattern === 'rings' || p.pattern === 'spiral' },
      { key: 'cy', label: 'centre y', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct, show: p => p.pattern === 'rings' || p.pattern === 'spiral' },
      { key: 'animate', label: 'animate', type: 'select', def: 'off', options: [['off', 'off'], ['scroll', 'scroll'], ['rotate', 'rotate'], ['pulse', 'pulse']] },
      { key: 'speed', label: 'speed', type: 'range', min: 0.1, max: 4, step: 0.1, def: 1, fmt: times, show: p => p.animate !== 'off' },
    ],
    paper: true,
    animated: p => p.animate !== 'off',
    frag: `
float tri(float x) { return abs(fract(x) - 0.5) * 2.0; }
float pattern(vec2 q, vec2 px, vec2 centre, float cellPx, float flow) {
  if (u_pattern == PATTERN_LINES) return tri(q.y);
  if (u_pattern == PATTERN_CROSS) return min(tri(q.x), tri(q.y));
  if (u_pattern == PATTERN_DOTS) return 0.5 + 0.25 * (cos(TAU * q.x) + cos(TAU * q.y));
  if (u_pattern == PATTERN_DIAMOND) return (tri(q.x) + tri(q.y)) * 0.5;
  if (u_pattern == PATTERN_CHECKER) return mod(floor(q.x) + floor(q.y), 2.0) * 0.5 + 0.25 + 0.2 * (tri(q.x) * tri(q.y) - 0.5);
  if (u_pattern == PATTERN_WAVES) return tri(q.y + 0.35 * sin(q.x * 1.3));
  if (u_pattern == PATTERN_ZIGZAG) return tri(q.y + tri(q.x * 0.5));
  if (u_pattern == PATTERN_RINGS) return tri(length(px - centre) / cellPx - flow);
  if (u_pattern == PATTERN_SPIRAL) { vec2 d = px - centre; return tri(length(d) / cellPx + atan(d.y, d.x) / TAU - flow); }
  if (u_pattern == PATTERN_MAZE) {
    vec2 id = floor(q), f = fract(q);
    if (hash12(id + 7.0) > 0.5) f.x = 1.0 - f.x;
    float d = min(abs(length(f) - 0.5), abs(length(f - 1.0) - 0.5));
    return clamp(d * 2.6, 0.0, 1.0);
  }
  if (u_pattern == PATTERN_BRICKS) {
    vec2 b = q * vec2(0.5, 1.0);
    b.x += 0.5 * mod(floor(b.y), 2.0);
    vec2 f = fract(b);
    return clamp(min(min(f.x, 1.0 - f.x) * 4.0, min(f.y, 1.0 - f.y) * 2.0) * 1.4, 0.0, 1.0);
  }
  return clamp((fbm(q * 0.45) - 0.5) * 2.4 + 0.5, 0.0, 1.0);
}
void main() {
  float cellPx = max(1.5, u_scale * u_k);
  vec2 px = gl_FragCoord.xy;
  vec2 centre = vec2(u_cx, 1.0 - u_cy) * u_res;
  float t = u_time * u_speed;
  float ang = radians(u_angle) + (u_animate == ANIMATE_ROTATE ? t * 0.4 : 0.0);
  float flow = u_animate == ANIMATE_SCROLL ? t * 1.2 : 0.0;
  vec2 q = rot2(ang) * (px - centre) / cellPx;
  q.y -= flow;
  float th = pattern(q, px, centre, cellPx, flow);
  if (u_animate == ANIMATE_PULSE) th = clamp(th + 0.25 * sin(t * 3.0), 0.0, 1.0);
  float fw = max(fwidth(th) * 0.6, 1e-3);
  vec4 c = texture(u_tex, v_uv);
  float l = clamp((luma(c.rgb) - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  if (u_output == OUTPUT_PALETTE) {
    float k = u_strength / float(max(u_palN - 1, 1));
    vec3 a = nearestPal(c.rgb + (th - fw - 0.5) * k), b = nearestPal(c.rgb + (th + fw - 0.5) * k);
    fragColor = vec4((a + b) * 0.5, c.a);
    return;
  }
  float ink = 1.0 - smoothstep(th - fw, th + fw, l);
  fragColor = inkOver(paperColor(), u_output == OUTPUT_SOURCE ? c.rgb : u_ink, ink * c.a);
}`,
  },

  {
    id: 'linemod', name: 'line modulation', icon: '≣', group: 'dither',
    desc: 'tone drawn as lines — thickness, waves, joy-division ridges, rings, spirals',
    thumb: { spacing: 6 },
    params: [
      { key: 'mode', label: 'mode', type: 'select', def: 'thickness', options: [
        ['thickness', 'thickness (engraving)'], ['wave', 'wave (vibration)'], ['ridge', 'ridges (joy division)'],
        ['rings', 'concentric rings'], ['spiral', 'spiral'],
      ] },
      { key: 'spacing', label: 'line spacing', type: 'range', min: 2, max: 40, step: 0.5, def: 7, unit: 'px' },
      { key: 'thickness', label: 'max thickness', type: 'range', min: 0.05, max: 1, step: 0.01, def: 0.85, fmt: pct },
      { key: 'amplitude', label: 'amplitude', type: 'range', min: 0, max: 4, step: 0.05, def: 1.2, fmt: times, show: p => p.mode === 'wave' || p.mode === 'ridge' },
      { key: 'frequency', label: 'wave frequency', type: 'range', min: 0.2, max: 6, step: 0.05, def: 1.6, show: p => p.mode === 'wave' },
      { key: 'angle', label: 'angle', type: 'range', min: 0, max: 180, step: 1, def: 0, fmt: deg, show: p => p.mode === 'thickness' || p.mode === 'wave' },
      { key: 'cx', label: 'centre x', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct, show: p => p.mode === 'rings' || p.mode === 'spiral' },
      { key: 'cy', label: 'centre y', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct, show: p => p.mode === 'rings' || p.mode === 'spiral' },
      { key: 'contrast', label: 'contrast', type: 'range', min: 0.2, max: 3, step: 0.05, def: 1.2, fmt: times },
      { key: 'color', label: 'line colour', type: 'seg', def: 'ink', options: [['ink', 'palette ink'], ['source', 'source']] },
      { key: 'invert', label: 'lines for light areas', type: 'toggle', def: false },
      { key: 'animate', label: 'animate', type: 'toggle', def: false },
      { key: 'speed', label: 'speed', type: 'range', min: 0.1, max: 4, step: 0.1, def: 1, fmt: times, show: p => p.animate },
    ],
    paper: true,
    frag: `
float dens(vec2 uv) {
  vec4 s = texture(u_tex, uv);
  float l = clamp((luma(s.rgb) - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  return (u_invert ? l : 1.0 - l) * s.a;
}
float lineMask(float y, float d, float sp) {
  float dist = abs(fract(y) - 0.5);
  float hw = d * u_thickness * 0.5;
  float aa = max(fwidth(y), 1e-4) * 0.75;
  return (1.0 - smoothstep(hw - aa, hw + aa, dist)) * clamp(hw * sp * 2.0, 0.0, 1.0);
}
void main() {
  float sp = max(2.0, u_spacing * u_k);
  vec2 px = gl_FragCoord.xy;
  float phase = u_animate ? u_time * u_speed : 0.0;
  vec4 src = texture(u_tex, v_uv);
  float m = 0.0;
  vec3 col = src.rgb;
  if (u_mode == MODE_RIDGE) {
    // rows further down sit in front; the front-most ridge whose fill covers this pixel owns it
    float yTop = u_res.y - px.y;
    float amp = u_amplitude * sp * 3.0;
    float hw = max(0.6, u_thickness * sp * 0.12);
    int rLo = int(floor(yTop / sp)) - 1;
    int rHi = int(floor((yTop + amp) / sp)) + 1;
    for (int i = 0; i < 48; i++) {
      int r = rHi - i;
      if (r < rLo) break;
      float base = (float(r) + 0.5) * sp;
      vec2 suv = vec2(v_uv.x, 1.0 - base / u_res.y);
      float h = suv.y < 0.0 ? 0.0 : (1.0 - dens(suv)) * amp;
      if (u_invert) h = suv.y < 0.0 ? 0.0 : dens(suv) * amp;
      float cy = base - h;
      if (yTop >= cy - hw) {
        m = 1.0 - smoothstep(hw - 0.75, hw + 0.75, abs(yTop - cy));
        col = texture(u_tex, suv).rgb;
        break;
      }
    }
  } else if (u_mode == MODE_RINGS || u_mode == MODE_SPIRAL) {
    vec2 d = px - vec2(u_cx, 1.0 - u_cy) * u_res;
    float y = length(d) / sp - phase;
    if (u_mode == MODE_SPIRAL) y += atan(d.y, d.x) / TAU;
    m = lineMask(y, dens(v_uv), sp);
  } else {
    mat2 R = rot2(radians(u_angle));
    vec2 q = R * (px - u_res * 0.5) / sp;
    float y = q.y - phase;
    float dd;
    if (u_mode == MODE_WAVE) {
      dd = dens(v_uv);
      y += sin(q.x * u_frequency + phase * 3.0) * dd * u_amplitude * 0.5;
    } else {
      vec2 centre = transpose(R) * vec2(q.x, floor(y) + 0.5 + phase) * sp + u_res * 0.5;
      dd = dens(centre / u_res);
    }
    m = lineMask(y, dd, sp);
  }
  vec3 ink = u_color == COLOR_SOURCE ? col : u_ink;
  vec4 paper = paperColor();
  if (u_mode == MODE_RIDGE && u_clear) paper = vec4(0.0);
  fragColor = inkOver(paper, ink, m * max(src.a, u_mode == MODE_RIDGE ? 1.0 : 0.0));
}`,
  },
];
