import { pct, deg, times } from './fmt.js';
import { pixelSort } from '../cpu/pixelsort.js';

export default [
  {
    id: 'rgbshift', name: 'rgb shift', icon: '⚡', group: 'glitch',
    desc: 'split the red, green and blue channels apart',
    params: [
      { key: 'amount', label: 'amount', type: 'range', min: 0, max: 60, step: 0.5, def: 8, unit: 'px' },
      { key: 'angle', label: 'angle', type: 'range', min: 0, max: 360, step: 1, def: 0, fmt: deg },
      { key: 'animate', label: 'animate', type: 'toggle', def: false },
    ],
    frag: `
void main() {
  float t = u_animate ? u_time : 0.0;
  float amt = u_amount * u_k * (u_animate ? 0.7 + 0.3 * sin(t * 3.0) : 1.0);
  float ang = radians(u_angle + t * 20.0);
  vec2 off = vec2(cos(ang), sin(ang)) * amt / u_res;
  vec4 r = texture(u_tex, v_uv - off), g = texture(u_tex, v_uv), b = texture(u_tex, v_uv + off);
  vec4 pm = vec4(r.r * r.a, g.g * g.a, b.b * b.a, max(max(r.a, g.a), b.a));
  fragColor = unpremul(pm);
}`,
  },

  {
    id: 'scanglitch', name: 'scan glitch', icon: '▦', group: 'glitch',
    desc: 'torn horizontal bands with channel split',
    params: [
      { key: 'intensity', label: 'intensity', type: 'range', min: 0, max: 100, step: 1, def: 30 },
      { key: 'frequency', label: 'frequency', type: 'range', min: 1, max: 40, step: 1, def: 8 },
      { key: 'animate', label: 'animate', type: 'toggle', def: true },
    ],
    frag: `
void main() {
  float t = u_animate ? floor(u_time * 10.0) : 0.0;
  float I = u_intensity / 100.0;
  float y = 1.0 - v_uv.y;
  float rowsA = 24.0 + 40.0 * hash12(vec2(t, 1.3));
  float rA = floor(y * rowsA);
  float hA = hash12(vec2(rA, t));
  float rB = floor(y * 140.0);
  float hB = hash12(vec2(rB, t + 9.1));
  float prob = u_frequency / 40.0;
  float on = step(1.0 - prob * 0.5, hA);
  float fine = step(1.0 - prob * 0.25, hB);
  float shift = on * (hash12(vec2(rA, t + 3.7)) - 0.5) * 0.25 * I + fine * (hB - 0.5) * 0.06 * I;
  vec2 uv = vec2(fract(v_uv.x + shift), v_uv.y);
  vec4 c = texture(u_tex, uv);
  if (on > 0.5) {
    float sp = 0.012 * I;
    vec4 r = texture(u_tex, vec2(fract(uv.x + sp), uv.y));
    vec4 b = texture(u_tex, vec2(fract(uv.x - sp), uv.y));
    c = vec4(r.r, c.g, b.b, max(c.a, max(r.a, b.a)));
  }
  fragColor = c;
}`,
  },

  {
    id: 'databend', name: 'data bend', icon: '⦿', group: 'glitch',
    desc: 'corrupted blocks: xor, channel swaps, bit-crush, smears',
    params: [
      { key: 'amount', label: 'amount', type: 'range', min: 0, max: 100, step: 1, def: 20 },
      { key: 'blockSize', label: 'block size', type: 'range', min: 2, max: 60, step: 1, def: 10, unit: 'px' },
      { key: 'seed', label: 'seed', type: 'range', min: 1, max: 999, step: 1, def: 42 },
      { key: 'animate', label: 'animate', type: 'toggle', def: false },
    ],
    frag: `
void main() {
  vec2 p = gl_FragCoord.xy;
  float s = u_seed + (u_animate ? floor(u_time * 6.0) * 7.0 : 0.0);
  float bs = max(1.0, u_blockSize * u_k);
  float rowH = max(1.0, bs * 0.5);
  float row = floor(p.y / rowH);
  float bw = bs * (2.0 + 6.0 * hash12(vec2(row, s)));
  float col = floor((p.x + hash12(vec2(row, s + 1.0)) * bw) / bw);
  vec2 id = vec2(col, row);
  vec4 c = texture(u_tex, v_uv);
  if (hash12(id + s * 0.37) < u_amount / 100.0 * 0.6) {
    float sh = (hash12(id.yx * 1.7 + s) - 0.5) * 200.0 * u_k;
    float mode = floor(hash12(id * 2.3 + s * 1.1) * 4.0);
    vec4 d = mode == 3.0 ? texture(u_tex, vec2(p.x + sh, row * rowH) / u_res)
                         : texture(u_tex, (p + vec2(sh, 0.0)) / u_res);
    uvec3 b = uvec3(clamp(d.rgb, 0.0, 1.0) * 255.0 + 0.5);
    uint x = uint(hash12(id + s * 3.1) * 255.0);
    if (mode == 0.0) b = b ^ uvec3(x, x >> 1u, x >> 2u);
    else if (mode == 1.0) b = b.gbr;
    else if (mode == 2.0) b = (b >> 3u) << 3u;
    c = vec4(vec3(b & 255u) / 255.0, d.a);
  }
  fragColor = c;
}`,
  },

  {
    id: 'slice', name: 'slice displace', icon: '✂', group: 'glitch',
    desc: 'shuffle strips sideways',
    params: [
      { key: 'slices', label: 'slice count', type: 'range', min: 2, max: 120, step: 1, def: 20 },
      { key: 'maxOffset', label: 'max offset', type: 'range', min: 0, max: 300, step: 1, def: 30, unit: 'px' },
      { key: 'direction', label: 'direction', type: 'seg', def: 'horizontal', options: [['horizontal', 'rows'], ['vertical', 'columns']] },
      { key: 'seed', label: 'seed', type: 'range', min: 0, max: 100, step: 1, def: 0 },
      { key: 'animate', label: 'animate', type: 'toggle', def: false },
    ],
    frag: `
void main() {
  float t = (u_animate ? floor(u_time * 5.0) : 0.0) + u_seed * 13.0;
  vec2 uv = v_uv;
  if (u_direction == DIRECTION_HORIZONTAL) {
    float sl = floor((1.0 - uv.y) * u_slices);
    uv.x = fract(uv.x - (hash12(vec2(sl, t)) - 0.5) * 2.0 * u_maxOffset * u_k / u_res.x);
  } else {
    float sl = floor(uv.x * u_slices);
    uv.y = fract(uv.y - (hash12(vec2(sl, t + 5.0)) - 0.5) * 2.0 * u_maxOffset * u_k / u_res.y);
  }
  fragColor = texture(u_tex, uv);
}`,
  },

  {
    id: 'pixelsort', name: 'pixel sort', icon: '⇶', group: 'glitch',
    desc: 'sort runs of pixels inside a brightness band',
    params: [
      { key: 'low', label: 'band low', type: 'range', min: 0, max: 1, step: 0.01, def: 0.25, fmt: pct },
      { key: 'high', label: 'band high', type: 'range', min: 0, max: 1, step: 0.01, def: 0.85, fmt: pct },
      { key: 'direction', label: 'direction', type: 'seg', def: 'vertical', options: [['horizontal', 'rows'], ['vertical', 'columns']] },
      { key: 'key', label: 'sort by', type: 'seg', def: 'brightness', options: [['brightness', 'bright'], ['hue', 'hue'], ['saturation', 'sat']] },
      { key: 'reverse', label: 'reverse order', type: 'toggle', def: false },
    ],
    cpu: () => true,
    run(ctx, p) {
      const data = ctx.read(ctx.input);
      pixelSort(data, ctx.w, ctx.h, p);
      return ctx.upload(data, ctx.w, ctx.h);
    },
  },

  {
    id: 'echo', name: 'echo / feedback', icon: '◎', group: 'glitch',
    desc: 'each frame feeds back into the next — trails & tunnels',
    params: [
      { key: 'decay', label: 'persistence', type: 'range', min: 0, max: 0.99, step: 0.01, def: 0.9, fmt: pct },
      { key: 'zoom', label: 'zoom', type: 'range', min: 0.9, max: 1.15, step: 0.002, def: 1.02, fmt: times },
      { key: 'rotate', label: 'rotate', type: 'range', min: -10, max: 10, step: 0.1, def: 0.5, fmt: deg },
      { key: 'driftX', label: 'drift x', type: 'range', min: -5, max: 5, step: 0.1, def: 0 },
      { key: 'driftY', label: 'drift y', type: 'range', min: -5, max: 5, step: 0.1, def: 0 },
      { key: 'hueShift', label: 'hue drift', type: 'range', min: 0, max: 1, step: 0.01, def: 0, fmt: pct },
      { key: 'mode', label: 'mode', type: 'select', def: 'lighten', options: [['lighten', 'lighten'], ['screen', 'screen'], ['trail', 'trail behind'], ['mix', 'mix']] },
    ],
    animated: () => true,
    run(ctx, p, fx) {
      const hist = ctx.history('echo' + fx.id);
      if (hist.fresh) ctx.copyInto(ctx.input, hist.rt);
      const out = ctx.shader(this, p, {}, { u_prev: hist.rt });
      ctx.copyInto(out, hist.rt);
      return out;
    },
    frag: `
uniform sampler2D u_prev;
void main() {
  vec4 cur = texture(u_tex, v_uv);
  vec2 asp = vec2(u_res.x / u_res.y, 1.0);
  vec2 q = (v_uv - 0.5 - vec2(u_driftX, u_driftY) * 0.004) * asp;
  q = rot2(radians(u_rotate)) * q / u_zoom;
  vec2 puv = q / asp + 0.5;
  vec4 prev = texture(u_prev, puv);
  if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) prev = vec4(0.0);
  if (u_hueShift > 0.0) { vec3 h = rgb2hsv(prev.rgb); h.x = fract(h.x + u_hueShift * 0.05); prev.rgb = hsv2rgb(h); }
  vec4 P = vec4(prev.rgb * prev.a, prev.a) * u_decay;
  vec4 C = vec4(cur.rgb * cur.a, cur.a);
  vec4 o;
  if (u_mode == MODE_LIGHTEN) o = max(C, P);
  else if (u_mode == MODE_SCREEN) o = C + P - C * P;
  else if (u_mode == MODE_TRAIL) o = C + P * (1.0 - C.a);
  else o = mix(C, P, u_decay);
  fragColor = unpremul(clamp(o, 0.0, 1.0));
}`,
  },
];
