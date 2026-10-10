import { pct, deg, times } from './fmt.js';

// Standard JPEG quantisation tables (quality 50), row = vertical frequency.
const QL = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...new Array(32).fill(99)];
function qtables(quality) {
  const S = quality < 50 ? 5000 / quality : 200 - 2 * quality;
  const f = b => Math.max(1, Math.floor((b * S + 50) / 100));
  return [Float32Array.from(QL, f), Float32Array.from(QC, f)];
}

// Forward DCT per 8x8 block in YCbCr, quantised and stored as bytes (q + 128).
const DCT = `
uniform float u_ql[64];
uniform float u_qc[64];
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 blk = p / 8, f = p % 8;
  ivec2 sz = textureSize(u_tex, 0);
  vec3 acc = vec3(0.0);
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
    vec3 c = texelFetch(u_tex, clamp(blk * 8 + ivec2(x, y), ivec2(0), sz - 1), 0).rgb;
    vec3 ycc = vec3(dot(c, vec3(0.299, 0.587, 0.114)),
                    dot(c, vec3(-0.168736, -0.331264, 0.5)) + 0.5,
                    dot(c, vec3(0.5, -0.418688, -0.081312)) + 0.5) * 255.0 - 128.0;
    acc += ycc * cos((2.0 * float(x) + 1.0) * float(f.x) * PI / 16.0) * cos((2.0 * float(y) + 1.0) * float(f.y) * PI / 16.0);
  }
  acc *= 0.25 * (f.x == 0 ? 0.70710678 : 1.0) * (f.y == 0 ? 0.70710678 : 1.0);
  int qi = f.y * 8 + f.x;
  vec3 q = clamp(floor(acc / vec3(u_ql[qi], u_qc[qi], u_qc[qi]) + 0.5), -127.0, 127.0);
  fragColor = vec4((q + 128.0) / 255.0, 1.0);
}`;

// Inverse DCT with stream-style corruption: blocks borrow other blocks' data, DC drifts,
// AC gets boosted or dropped, and whole rows of blocks slip sideways.
const IDCT = `
uniform sampler2D u_coef;
uniform float u_ql[64];
uniform float u_qc[64];
uniform float u_glitch;
uniform float u_seed;
uniform bool u_anim;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 blk = p / 8, xy = p % 8;
  ivec2 nb = textureSize(u_coef, 0) / 8;
  float s = u_seed + (u_anim ? floor(u_time * 8.0) : 0.0);
  ivec2 src = blk;
  vec3 dc = vec3(0.0);
  float acGain = 1.0;
  int mode = -1;
  if (hash12(vec2(blk) + s * 0.731) < u_glitch * 0.35) {
    mode = int(hash12(vec2(blk) * 1.37 + s) * 4.0);
    if (mode == 0) src.x += int((hash12(vec2(float(blk.y), s)) - 0.5) * 14.0);
    if (mode == 1) dc = (vec3(hash12(vec2(blk) + s + 1.0), hash12(vec2(blk) + s + 2.0), hash12(vec2(blk) + s + 3.0)) - 0.5) * vec3(70.0, 110.0, 110.0);
    if (mode == 2) acGain = 3.0 + hash12(vec2(blk) + s + 4.0) * 6.0;
  }
  if (hash12(vec2(float(blk.y), s * 2.1 + 0.5)) > 1.0 - u_glitch * 0.1) {
    src.x += int(hash12(vec2(float(blk.y), s + 5.0)) * 24.0);
    dc.yz += (hash22(vec2(float(blk.y), s + 6.0)) - 0.5) * 80.0;
  }
  src = ivec2(mod(vec2(src), vec2(nb)));
  vec3 acc = vec3(0.0);
  for (int v = 0; v < 8; v++) for (int u = 0; u < 8; u++) {
    vec3 q = texelFetch(u_coef, src * 8 + ivec2(u, v), 0).rgb * 255.0 - 128.0;
    int qi = v * 8 + u;
    vec3 coef = q * vec3(u_ql[qi], u_qc[qi], u_qc[qi]);
    if (u == 0 && v == 0) coef += dc * 8.0;
    else coef *= mode == 3 ? 0.0 : acGain;
    float cu = u == 0 ? 0.70710678 : 1.0, cv = v == 0 ? 0.70710678 : 1.0;
    acc += cu * cv * coef * cos((2.0 * float(xy.x) + 1.0) * float(u) * PI / 16.0) * cos((2.0 * float(xy.y) + 1.0) * float(v) * PI / 16.0);
  }
  vec3 ycc = (acc * 0.25 + 128.0) / 255.0;
  float cb = ycc.y - 0.5, cr = ycc.z - 0.5;
  vec3 rgb = vec3(ycc.x + 1.402 * cr, ycc.x - 0.344136 * cb - 0.714136 * cr, ycc.x + 1.772 * cb);
  fragColor = vec4(clamp(rgb, 0.0, 1.0), texelFetch(u_tex, p, 0).a);
}`;

export default [
  {
    id: 'fluted', name: 'fluted glass', icon: '⦀', group: 'distort',
    desc: 'ribbed lenticular glass — refraction, colour split, highlights',
    params: [
      { key: 'flutes', label: 'flutes', type: 'range', min: 4, max: 140, step: 1, def: 28 },
      { key: 'angle', label: 'angle', type: 'range', min: 0, max: 180, step: 1, def: 0, fmt: deg },
      { key: 'shape', label: 'profile', type: 'seg', def: 'round', options: [['round', 'round'], ['prism', 'prism']] },
      { key: 'distortion', label: 'distortion', type: 'range', min: 0, max: 2, step: 0.01, def: 1, fmt: pct },
      { key: 'chroma', label: 'colour split', type: 'range', min: 0, max: 1, step: 0.01, def: 0.35, fmt: pct },
      { key: 'shading', label: 'highlights', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct },
      { key: 'frost', label: 'frost', type: 'range', min: 0, max: 1, step: 0.01, def: 0.15, fmt: pct },
    ],
    frag: `
void main() {
  float W = max(u_res.x, u_res.y) / u_flutes;
  mat2 R = rot2(radians(u_angle));
  vec2 px = gl_FragCoord.xy;
  float u = fract((R * px).x / W) - 0.5;
  float off;
  if (u_shape == SHAPE_ROUND) { float x = clamp(u * 2.0, -0.999, 0.999); off = -x / sqrt(1.0 - 0.85 * x * x) * W * 0.22 * u_distortion; }
  else off = -u * W * u_distortion * 0.9;
  vec2 across = transpose(R) * vec2(1.0, 0.0), along = transpose(R) * vec2(0.0, 1.0);
  vec4 acc = vec4(0.0);
  float ch = u_chroma * 0.18;
  for (int i = 0; i < 5; i++) {
    float jt = (float(i) - 2.0) * 0.5;
    vec2 fr = along * jt * u_frost * W * 0.6 + across * jt * u_frost * W * 0.08;
    vec4 r = srcPx(px + across * off * (1.0 + ch) + fr);
    vec4 g = srcPx(px + across * off + fr);
    vec4 b = srcPx(px + across * off * (1.0 - ch) + fr);
    acc += vec4(r.r * r.a, g.g * g.a, b.b * b.a, max(g.a, max(r.a, b.a)));
  }
  vec4 c = unpremul(acc / 5.0);
  float hi = smoothstep(0.28, 0.48, u) * 0.3 + exp(-pow((u - 0.36) * 22.0, 2.0)) * 0.25;
  float sh = smoothstep(-0.15, -0.5, u) * 0.3;
  c.rgb = clamp(c.rgb * (1.0 - sh * u_shading) + hi * u_shading, 0.0, 1.0);
  fragColor = c;
}`,
  },

  {
    id: 'displace', name: 'displace', icon: '⤳', group: 'distort',
    desc: 'push pixels by their own brightness, by noise, or by waves',
    params: [
      { key: 'source', label: 'map', type: 'seg', def: 'image', options: [['image', 'brightness'], ['noise', 'noise'], ['waves', 'waves']] },
      { key: 'amount', label: 'amount', type: 'range', min: 0, max: 250, step: 1, def: 40, unit: 'px' },
      { key: 'angle', label: 'direction', type: 'range', min: 0, max: 360, step: 1, def: 0, fmt: deg },
      { key: 'scale', label: 'map scale', type: 'range', min: 0.5, max: 20, step: 0.1, def: 3, show: p => p.source !== 'image' },
      { key: 'split', label: 'split rgb', type: 'toggle', def: false },
      { key: 'speed', label: 'speed', type: 'range', min: 0, max: 2, step: 0.01, def: 0, fmt: v => v ? `${v.toFixed(2)}` : 'off' },
    ],
    animated: p => p.speed > 0,
    frag: `
float map(vec2 uv) {
  float t = u_time * u_speed;
  vec2 asp = vec2(u_res.x / u_res.y, 1.0);
  if (u_source == SOURCE_IMAGE) return luma(texture(u_tex, uv + vec2(0.0, t * 0.05)).rgb);
  if (u_source == SOURCE_NOISE) return fbm(uv * asp * u_scale + vec2(t * 0.4, -t * 0.3));
  return 0.5 + 0.5 * sin((uv.y * asp.y + 0.3 * sin(uv.x * asp.x * u_scale * 2.0)) * u_scale * TAU + t * 3.0);
}
void main() {
  float m = map(v_uv) - 0.5;
  vec2 off = vec2(cos(radians(u_angle)), sin(radians(u_angle))) * m * 2.0 * u_amount * u_k / u_res;
  if (u_split) {
    vec4 r = texture(u_tex, v_uv + off * 1.25), g = texture(u_tex, v_uv + off), b = texture(u_tex, v_uv + off * 0.75);
    fragColor = unpremul(vec4(r.r * r.a, g.g * g.a, b.b * b.a, max(g.a, max(r.a, b.a))));
  } else {
    fragColor = texture(u_tex, v_uv + off);
  }
}`,
  },

  {
    id: 'tiltshift', name: 'tilt-shift', icon: '⊟', group: 'atmosphere',
    desc: 'progressive lens blur around a sharp band — instant miniature',
    params: [
      { key: 'mode', label: 'shape', type: 'seg', def: 'linear', options: [['linear', 'band'], ['radial', 'radial']] },
      { key: 'position', label: 'focus y', type: 'range', min: 0, max: 1, step: 0.01, def: 0.6, fmt: pct },
      { key: 'cx', label: 'focus x', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct, show: p => p.mode === 'radial' },
      { key: 'angle', label: 'angle', type: 'range', min: -90, max: 90, step: 1, def: 0, fmt: deg, show: p => p.mode === 'linear' },
      { key: 'focus', label: 'sharp area', type: 'range', min: 0, max: 0.5, step: 0.01, def: 0.1, fmt: pct },
      { key: 'falloff', label: 'falloff', type: 'range', min: 0.02, max: 0.8, step: 0.01, def: 0.28, fmt: pct },
      { key: 'blur', label: 'max blur', type: 'range', min: 1, max: 60, step: 0.5, def: 14, unit: 'px', glsl: false },
      { key: 'saturation', label: 'saturation boost', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3, fmt: pct },
      { key: 'contrast', label: 'contrast boost', type: 'range', min: 0, max: 0.6, step: 0.01, def: 0.1, fmt: pct },
    ],
    run(ctx, p) {
      const b1 = ctx.blur(ctx.input, p.blur * ctx.k * 0.3);
      const b2 = ctx.blur(ctx.input, p.blur * ctx.k);
      const out = ctx.shader(this, p, {}, { u_b1: b1, u_b2: b2 });
      ctx.release(b1); ctx.release(b2);
      return out;
    },
    frag: `
uniform sampler2D u_b1;
uniform sampler2D u_b2;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 asp = vec2(u_res.x / u_res.y, 1.0);
  float d;
  if (u_mode == MODE_RADIAL) d = length((v_uv - vec2(u_cx, 1.0 - u_position)) * asp);
  else d = abs(dot((v_uv - vec2(0.5, 1.0 - u_position)) * asp, vec2(-sin(radians(u_angle)), cos(radians(u_angle)))));
  float m = smoothstep(u_focus, u_focus + u_falloff, d);
  vec4 b1 = texture(u_b1, v_uv), b2 = texture(u_b2, v_uv);
  vec4 o = m < 0.5 ? mix(c, b1, m * 2.0) : mix(b1, b2, m * 2.0 - 1.0);
  vec3 col = mix(vec3(luma(o.rgb)), o.rgb, 1.0 + u_saturation);
  col = (col - 0.5) * (1.0 + u_contrast) + 0.5;
  fragColor = vec4(clamp(col, 0.0, 1.0), o.a);
}`,
  },

  {
    id: 'jpeg', name: 'jpeg glitch', icon: '▧', group: 'glitch',
    desc: 'real 8×8 dct compression, crushed and corrupted block by block',
    params: [
      { key: 'quality', label: 'quality', type: 'range', min: 1, max: 50, step: 1, def: 8, glsl: false },
      { key: 'blockSize', label: 'block size', type: 'range', min: 3, max: 40, step: 0.5, def: 8, unit: 'px', glsl: false },
      { key: 'glitch', label: 'corruption', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3, fmt: pct, glsl: false },
      { key: 'seed', label: 'seed', type: 'range', min: 0, max: 999, step: 1, def: 11, glsl: false },
      { key: 'crisp', label: 'crisp blocks', type: 'toggle', def: true, glsl: false },
      { key: 'animate', label: 'animate', type: 'toggle', def: false, glsl: false },
    ],
    run(ctx, p) {
      const blockPx = Math.max(2, p.blockSize * ctx.k);
      const ww = Math.max(8, Math.round(ctx.w * 8 / blockPx)), wh = Math.max(8, Math.round(ctx.h * 8 / blockPx));
      const small = ctx.downsample(ctx.input, ww, wh);
      const [ql, qc] = qtables(p.quality);
      const coef = ctx.pass('jpeg.dct', DCT, { u_ql: ql, u_qc: qc }, { u_tex: small }, Math.ceil(ww / 8) * 8, Math.ceil(wh / 8) * 8);
      const dec = ctx.pass('jpeg.idct', IDCT, { u_ql: ql, u_qc: qc, u_glitch: p.glitch, u_seed: p.seed, u_anim: !!p.animate }, { u_tex: small, u_coef: coef }, ww, wh);
      ctx.release(small); ctx.release(coef);
      const up = p.crisp ? ctx.nearest(dec) : ctx.copy(dec, ctx.w, ctx.h);
      ctx.release(dec);
      return up;
    },
  },

  {
    id: 'datamosh', name: 'datamosh', icon: '⧉', group: 'glitch',
    desc: 'p-frame smearing — blocks drift, flow or melt instead of refreshing',
    params: [
      { key: 'mode', label: 'motion', type: 'seg', def: 'drift', options: [['drift', 'drift'], ['flow', 'flow'], ['melt', 'melt']] },
      { key: 'block', label: 'block size', type: 'range', min: 2, max: 64, step: 1, def: 16, unit: 'px' },
      { key: 'motion', label: 'motion', type: 'range', min: 0, max: 40, step: 0.5, def: 6, unit: 'px' },
      { key: 'refresh', label: 'keyframe chance', type: 'range', min: 0, max: 0.5, step: 0.005, def: 0.03, fmt: pct },
      { key: 'bleed', label: 'source bleed', type: 'range', min: 0, max: 0.5, step: 0.005, def: 0.02, fmt: pct },
    ],
    animated: () => true,
    run(ctx, p, fx) {
      const hist = ctx.history('mosh' + fx.id);
      if (hist.fresh) ctx.copyInto(ctx.input, hist.rt);
      const out = ctx.shader(this, p, {}, { u_prev: hist.rt });
      ctx.copyInto(out, hist.rt);
      return out;
    },
    frag: `
uniform sampler2D u_prev;
void main() {
  float bs = max(2.0, u_block * u_k);
  vec2 px = gl_FragCoord.xy;
  vec2 blk = floor(px / bs);
  vec4 cur = texture(u_tex, v_uv);
  if (hash12(blk + floor(u_time * 30.0) * 0.123) < u_refresh) { fragColor = cur; return; }
  vec2 mv;
  if (u_mode == MODE_DRIFT) mv = (hash22(blk + floor(u_time * 0.5) * 7.1) - 0.5) * 2.0 * u_motion * u_k;
  else if (u_mode == MODE_FLOW) {
    vec2 c = (blk + 0.5) * bs;
    float gx = luma(srcPx(c + vec2(bs, 0.0)).rgb) - luma(srcPx(c - vec2(bs, 0.0)).rgb);
    float gy = luma(srcPx(c + vec2(0.0, bs)).rgb) - luma(srcPx(c - vec2(0.0, bs)).rgb);
    mv = vec2(gx, gy) * u_motion * u_k * 2.0;
  } else {
    mv = vec2(0.0, -(0.3 + hash12(vec2(blk.x, 3.0))) * u_motion * u_k * 0.5);
  }
  vec4 prev = texture(u_prev, (px - mv) / u_res);
  fragColor = mix(prev, cur, u_bleed);
}`,
  },
];
