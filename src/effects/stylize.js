import { pct, deg, times, fixed } from './fmt.js';
import { paramDecls } from '../gl/glsl.js';

export default [
  {
    id: 'edge', name: 'edge detect', icon: '⌇', group: 'stylize',
    desc: 'sobel edges: alone, inked over the image, or neon',
    params: [
      { key: 'mode', label: 'output mode', type: 'seg', def: 'edges', options: [['edges', 'edges only'], ['overlay', 'overlay'], ['neon', 'neon']] },
      { key: 'strength', label: 'strength', type: 'range', min: 0.1, max: 4, step: 0.05, def: 1, fmt: fixed(2) },
      { key: 'thickness', label: 'edge thickness', type: 'range', min: 0.3, max: 4, step: 0.05, def: 1, fmt: fixed(2) },
      { key: 'threshold', label: 'edge threshold', type: 'range', min: 0, max: 1, step: 0.01, def: 0.15, fmt: fixed(2), show: p => p.mode !== 'edges' },
      { key: 'edgeColor', label: 'edge colour', type: 'color', def: '#000000', show: p => p.mode === 'overlay' },
      { key: 'invert', label: 'invert (dark edges)', type: 'toggle', def: false, show: p => p.mode === 'edges' },
    ],
    frag: `
vec2 lumA(vec2 px) { vec4 s = srcPx(px); return vec2(luma(s.rgb) * s.a, s.a); }
void main() {
  float o = max(1.0, u_thickness * u_k);
  vec2 px = gl_FragCoord.xy;
  vec2 tl = lumA(px + vec2(-o, o)), t = lumA(px + vec2(0.0, o)), tr = lumA(px + vec2(o, o));
  vec2 l = lumA(px + vec2(-o, 0.0)), r = lumA(px + vec2(o, 0.0));
  vec2 bl = lumA(px + vec2(-o, -o)), b = lumA(px + vec2(0.0, -o)), br = lumA(px + vec2(o, -o));
  vec2 gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  vec2 gy = tl + 2.0 * t + tr - bl - 2.0 * b - br;
  float mag = clamp(max(length(vec2(gx.x, gy.x)), length(vec2(gx.y, gy.y))) * u_strength, 0.0, 1.0);
  vec4 c = texture(u_tex, v_uv);
  if (u_mode == MODE_OVERLAY) {
    float e = smoothstep(u_threshold, u_threshold + 0.1, mag);
    fragColor = vec4(mix(c.rgb, u_edgeColor, e), max(c.a, e));
  } else if (u_mode == MODE_NEON) {
    float e = smoothstep(u_threshold, u_threshold + 0.25, mag);
    vec3 hue = c.a > 0.01 ? c.rgb / max(max(c.r, max(c.g, c.b)), 0.05) : vec3(1.0);
    fragColor = u_clear ? vec4(hue, e) : vec4(hue * e, 1.0);
  } else {
    float m = u_invert ? 1.0 - mag : mag;
    fragColor = u_clear ? vec4(vec3(u_invert ? 0.0 : 1.0), u_invert ? 1.0 - m : m) : vec4(vec3(m), 1.0);
  }
}`,
  },

  {
    id: 'emboss', name: 'emboss', icon: '▨', group: 'stylize',
    desc: 'raised relief lit from one side',
    params: [
      { key: 'mode', label: 'style', type: 'seg', def: 'relief', options: [['relief', 'grey relief'], ['color', 'colour relief'], ['classic', 'classic']] },
      { key: 'strength', label: 'strength', type: 'range', min: 0.1, max: 4, step: 0.05, def: 1, fmt: fixed(2) },
      { key: 'angle', label: 'light angle', type: 'range', min: 0, max: 360, step: 1, def: 135, fmt: deg, show: p => p.mode !== 'classic' },
    ],
    frag: `
void main() {
  vec4 c = texture(u_tex, v_uv);
  float o = max(1.0, u_k);
  vec2 px = gl_FragCoord.xy;
  if (u_mode == MODE_CLASSIC) {
    vec3 s = srcPx(px + vec2(-o, -o)).rgb * -2.0 + srcPx(px + vec2(0.0, -o)).rgb * -1.0 + srcPx(px + vec2(-o, 0.0)).rgb * -1.0
           + c.rgb + srcPx(px + vec2(o, 0.0)).rgb + srcPx(px + vec2(0.0, o)).rgb + srcPx(px + vec2(o, o)).rgb * 2.0;
    fragColor = vec4(clamp(s * u_strength + 0.5, 0.0, 1.0), c.a);
    return;
  }
  vec2 d = vec2(cos(radians(u_angle)), sin(radians(u_angle))) * o;
  float e = (luma(srcPx(px + d).rgb) - luma(srcPx(px - d).rgb)
           + 0.5 * (luma(srcPx(px + 2.0 * d).rgb) - luma(srcPx(px - 2.0 * d).rgb))) * u_strength;
  vec3 res = u_mode == MODE_RELIEF ? vec3(0.5 + e) : c.rgb + e;
  fragColor = vec4(clamp(res, 0.0, 1.0), c.a);
}`,
  },

  {
    id: 'sharpen', name: 'sharpen', icon: '◇', group: 'stylize',
    desc: 'unsharp mask for crisp detail',
    params: [
      { key: 'amount', label: 'amount', type: 'range', min: 0, max: 4, step: 0.05, def: 1, fmt: fixed(2) },
      { key: 'radius', label: 'radius', type: 'range', min: 0.5, max: 6, step: 0.1, def: 1, unit: 'px' },
    ],
    frag: `
void main() {
  vec4 c = texture(u_tex, v_uv);
  float o = u_radius * max(1.0, u_k);
  vec2 px = gl_FragCoord.xy;
  vec3 b = (srcPx(px + vec2(o, 0.0)).rgb + srcPx(px - vec2(o, 0.0)).rgb + srcPx(px + vec2(0.0, o)).rgb + srcPx(px - vec2(0.0, o)).rgb) * 0.15
         + (srcPx(px + vec2(o, o)).rgb + srcPx(px - vec2(o, o)).rgb + srcPx(px + vec2(o, -o)).rgb + srcPx(px - vec2(o, -o)).rgb) * 0.1;
  fragColor = vec4(clamp(c.rgb + (c.rgb - b) * u_amount, 0.0, 1.0), c.a);
}`,
  },

  {
    id: 'kuwahara', name: 'kuwahara (painterly)', icon: '❋', group: 'stylize',
    desc: 'edge-preserving smoothing — oil paint & watercolour',
    params: [
      { key: 'variant', label: 'variant', type: 'seg', def: 'basic', options: [['basic', 'basic'], ['generalized', 'generalized']] },
      { key: 'radius', label: 'kernel radius', type: 'range', min: 2, max: 16, step: 0.5, def: 4, unit: 'px' },
      { key: 'sharpness', label: 'sharpness', type: 'range', min: 0, max: 18, step: 1, def: 8, show: p => p.variant === 'generalized' },
      { key: 'downscale', label: 'brush scale (downscale)', type: 'range', min: 1, max: 4, step: 1, def: 1, unit: '×', glsl: false },
    ],
    run(ctx, p) {
      const gen = p.variant === 'generalized';
      const body = `#define GENERALIZED ${gen ? 1 : 0}
` + paramDecls(this.params) + this.frag;
      const key = `kuwahara.${gen ? 'gen' : 'basic'}`;
      const ds = Math.max(1, p.downscale | 0);
      if (ds === 1) return ctx.pass(key, body, { ...ctx.uniforms(this, p), u_scaleK: ctx.k }, { u_tex: ctx.input });
      const sw = Math.max(1, Math.round(ctx.w / ds)), sh = Math.max(1, Math.round(ctx.h / ds));
      const small = ctx.downsample(ctx.input, sw, sh);
      const k = ctx.pass(key, body, { ...ctx.uniforms(this, p), u_scaleK: ctx.k / ds }, { u_tex: small }, sw, sh);
      ctx.release(small);
      const up = ctx.copy(k, ctx.w, ctx.h);
      ctx.release(k);
      return up;
    },
    frag: `
uniform float u_scaleK;
void main() {
  vec2 px = gl_FragCoord.xy;
  float alpha = srcPx(px).a;
  float r = max(1.0, u_radius * u_scaleK);
#if !GENERALIZED
  {
    int N = int(min(ceil(r), 8.0));
    float st = r / float(N);
    vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
    float s0 = 0.0, s1 = 0.0, s2 = 0.0, s3 = 0.0, q0 = 0.0, q1 = 0.0, q2 = 0.0, q3 = 0.0;
    for (int j = 0; j <= 8; j++) {
      if (j > N) break;
      for (int i = 0; i <= 8; i++) {
        if (i > N) break;
        vec2 o = vec2(float(i), float(j)) * st;
        vec3 c0 = srcPx(px + vec2(-o.x, -o.y)).rgb, c1 = srcPx(px + vec2(o.x, -o.y)).rgb;
        vec3 c2 = srcPx(px + vec2(-o.x, o.y)).rgb,  c3 = srcPx(px + vec2(o.x, o.y)).rgb;
        float l0 = luma(c0), l1 = luma(c1), l2 = luma(c2), l3 = luma(c3);
        m0 += c0; m1 += c1; m2 += c2; m3 += c3;
        s0 += l0; s1 += l1; s2 += l2; s3 += l3;
        q0 += l0 * l0; q1 += l1 * l1; q2 += l2 * l2; q3 += l3 * l3;
      }
    }
    float n = float((N + 1) * (N + 1));
    float v0 = abs(q0 / n - (s0 / n) * (s0 / n)), v1 = abs(q1 / n - (s1 / n) * (s1 / n));
    float v2 = abs(q2 / n - (s2 / n) * (s2 / n)), v3 = abs(q3 / n - (s3 / n) * (s3 / n));
    vec3 col = m0; float best = v0;
    if (v1 < best) { best = v1; col = m1; }
    if (v2 < best) { best = v2; col = m2; }
    if (v3 < best) { best = v3; col = m3; }
    fragColor = vec4(col / n, alpha);
  }
#else
  // generalized: 8 overlapping gaussian-weighted sectors, blended by inverse variance
  vec3 sm[8]; vec3 sq[8]; float sw[8];
  for (int k = 0; k < 8; k++) { sm[k] = vec3(0.0); sq[k] = vec3(0.0); sw[k] = 0.0; }
  int N = int(min(ceil(r), 8.0));
  float st = r / float(N);
  float sigma2 = 2.0 * (r / 2.5) * (r / 2.5);
  for (int j = -8; j <= 8; j++) {
    if (j < -N || j > N) continue;
    for (int i = -8; i <= 8; i++) {
      if (i < -N || i > N) continue;
      vec2 o = vec2(float(i), float(j)) * st;
      float d2 = dot(o, o);
      if (d2 > r * r || d2 == 0.0) continue;
      float g = exp(-d2 / sigma2);
      float phi = atan(o.y, o.x);
      if (phi < 0.0) phi += TAU;
      float sf = phi / (TAU / 8.0);
      int a = int(floor(sf)) % 8;
      int b = (a + 1) % 8;
      float fr = fract(sf);
      vec3 c = srcPx(px + o).rgb;
      float wa = g * (1.0 - fr * 0.5), wb = g * fr * 0.5;
      sm[a] += c * wa; sq[a] += c * c * wa; sw[a] += wa;
      sm[b] += c * wb; sq[b] += c * c * wb; sw[b] += wb;
    }
  }
  vec3 outc = vec3(0.0);
  float ow = 0.0;
  for (int k = 0; k < 8; k++) {
    if (sw[k] <= 0.0) continue;
    vec3 m = sm[k] / sw[k];
    vec3 v = abs(sq[k] / sw[k] - m * m);
    float w = 1.0 / (1.0 + pow(1000.0 * (v.r + v.g + v.b), 0.5 * u_sharpness));
    outc += m * w;
    ow += w;
  }
  fragColor = vec4(ow > 0.0 ? outc / ow : srcPx(px).rgb, alpha);
#endif
}`,
  },
];
