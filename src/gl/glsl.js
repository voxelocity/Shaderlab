// Shared GLSL for every pass. Effects only write `void main()` (plus helpers);
// the header and their param uniforms are prepended automatically.

export const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_tex;   // pass input (straight alpha)
uniform vec2  u_res;       // target size in px
uniform float u_time;
uniform float u_k;         // effect scale: render px per reference px (ref = 1/1000 of the long side)
uniform vec3  u_pal[8];
uniform int   u_palN;
uniform vec3  u_ink;       // first palette colour
uniform vec3  u_paper;     // last palette colour
uniform bool  u_clear;     // transparent background: "paper" becomes transparent

#define PI  3.14159265359
#define TAU 6.28318530718

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec4 srcPx(vec2 px) { return texture(u_tex, px / u_res); }

vec3 nearestPal(vec3 c) {
  vec3 best = u_pal[0];
  float bd = 1e9;
  for (int i = 0; i < 8; i++) {
    if (i >= u_palN) break;
    vec3 d = c - u_pal[i];
    float dd = dot(d, d);
    if (dd < bd) { bd = dd; best = u_pal[i]; }
  }
  return best;
}
vec3 palRamp(float t) {
  float f = clamp(t, 0.0, 1.0) * float(u_palN - 1);
  int i = int(floor(f));
  int j = min(i + 1, u_palN - 1);
  return mix(u_pal[i], u_pal[j], f - float(i));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Straight-alpha compositing helpers.
vec4 over(vec4 top, vec4 bot) {
  float a = top.a + bot.a * (1.0 - top.a);
  vec3 c = (top.rgb * top.a + bot.rgb * bot.a * (1.0 - top.a)) / max(a, 1e-5);
  return vec4(c, a);
}
vec4 paperColor() { return u_clear ? vec4(0.0) : vec4(u_paper, 1.0); }
vec4 inkOver(vec4 paper, vec3 ink, float cov) {
  return over(vec4(ink, clamp(cov, 0.0, 1.0)), paper);
}
vec4 unpremul(vec4 pm) { return vec4(pm.a > 1e-5 ? pm.rgb / pm.a : vec3(0.0), pm.a); }
`;

export function optionList(p) {
  return p.options.map(o => Array.isArray(o) ? { value: o[0], label: o[1] } : { value: o, label: o });
}

const defineName = (key, value) => `${key}_${value}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

// Effect params become uniforms named u_<key>. Selects become ints with a #define
// per option, so shaders read `u_shape == SHAPE_CIRCLE`.
export function paramDecls(params = []) {
  let s = '';
  for (const p of params) {
    if (p.glsl === false) continue;
    const name = 'u_' + p.key;
    if (p.type === 'range') s += `uniform float ${name};\n`;
    else if (p.type === 'toggle') s += `uniform bool ${name};\n`;
    else if (p.type === 'color') s += `uniform vec3 ${name};\n`;
    else if (p.type === 'select' || p.type === 'seg') {
      s += `uniform int ${name};\n`;
      optionList(p).forEach((o, i) => { s += `#define ${defineName(p.key, o.value)} ${i}\n`; });
    }
  }
  return s;
}

export function hexToRgb01(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function paramUniforms(params = [], values = {}) {
  const u = {};
  for (const p of params) {
    if (p.glsl === false) continue;
    const v = values[p.key] ?? p.def;
    const name = 'u_' + p.key;
    if (p.type === 'range') u[name] = +v;
    else if (p.type === 'toggle') u[name] = !!v;
    else if (p.type === 'color') u[name] = hexToRgb01(v);
    else if (p.type === 'select' || p.type === 'seg') u[name] = Math.max(0, optionList(p).findIndex(o => o.value === v));
  }
  return u;
}
