// Built-in passes used by the renderer itself (not user effects).

export const COMPOSE = `
uniform sampler2D u_media;
uniform sampler2D u_text;
uniform bool  u_hasMedia;
uniform vec4  u_mrect;     // media placement in uv space: xy offset, zw size
uniform vec4  u_bg;        // background, a = 0 when transparent
uniform float u_bright;
uniform float u_contrast;
uniform float u_sat;
uniform float u_hue;
uniform bool  u_invert;
uniform bool  u_gray;
void main() {
  vec4 c = u_bg;
  if (u_hasMedia) {
    vec2 m = (v_uv - u_mrect.xy) / u_mrect.zw;
    if (m.x >= 0.0 && m.x <= 1.0 && m.y >= 0.0 && m.y <= 1.0) c = over(texture(u_media, m), c);
  }
  c = over(texture(u_text, v_uv), c);
  vec3 col = c.rgb;
  if (u_gray) col = vec3(luma(col));
  if (u_hue != 0.0) { vec3 h = rgb2hsv(col); h.x = fract(h.x + u_hue / 360.0); col = hsv2rgb(h); }
  col = mix(vec3(luma(col)), col, u_sat);
  col = (col - 0.5) * u_contrast + 0.5 + u_bright;
  if (u_invert) col = 1.0 - col;
  fragColor = vec4(clamp(col, 0.0, 1.0), c.a);
}`;

// Final pass to the visible canvas: optional solid background, then premultiply
// (the canvas context is premultipliedAlpha: true).
export const PRESENT = `
uniform vec4 u_bg;
uniform bool u_premul;
void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_bg.a > 0.0) c = over(c, vec4(u_bg.rgb, 1.0));
  fragColor = u_premul ? vec4(c.rgb * c.a, c.a) : c;
}`;

export const COPY = `
void main() { fragColor = texture(u_tex, v_uv); }`;

export const NEAREST = `
void main() {
  ivec2 sz = textureSize(u_tex, 0);
  ivec2 p = clamp(ivec2(floor(v_uv * vec2(sz))), ivec2(0), sz - 1);
  fragColor = texelFetch(u_tex, p, 0);
}`;

// Area-average resample (box filter over each output pixel's footprint).
export const DOWNSAMPLE = `
uniform vec2 u_srcRes;
void main() {
  vec2 ratio = u_srcRes / u_res;
  vec2 lo = floor(gl_FragCoord.xy) * ratio;
  ivec2 n = ivec2(clamp(ceil(ratio * 0.5), vec2(1.0), vec2(8.0)));
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    if (j >= n.y) break;
    for (int i = 0; i < 8; i++) {
      if (i >= n.x) break;
      vec2 sp = lo + (vec2(i, j) + 0.5) * ratio / vec2(n);
      vec4 s = texture(u_tex, sp / u_srcRes);
      acc += vec4(s.rgb * s.a, s.a);
    }
  }
  fragColor = unpremul(acc / float(n.x * n.y));
}`;

export const BLUR1D = `
uniform vec2 u_dir;
uniform float u_sigma;
void main() {
  int R = int(ceil(u_sigma * 3.0));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -32; i <= 32; i++) {
    if (i < -R || i > R) continue;
    float x = float(i);
    float w = exp(-x * x / (2.0 * u_sigma * u_sigma));
    vec4 c = texture(u_tex, v_uv + u_dir * x / u_res);
    acc += vec4(c.rgb * c.a, c.a) * w;
    wsum += w;
  }
  fragColor = unpremul(acc / wsum);
}`;

export const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'add', 'difference', 'lighten', 'darken'];

export const MIX = `
uniform sampler2D u_base;
uniform float u_mix;
uniform int u_blend;
vec3 blendFn(vec3 b, vec3 t) {
  if (u_blend == 1) return b * t;
  if (u_blend == 2) return 1.0 - (1.0 - b) * (1.0 - t);
  if (u_blend == 3) return mix(2.0 * b * t, 1.0 - 2.0 * (1.0 - b) * (1.0 - t), step(0.5, b));
  if (u_blend == 4) return min(b + t, 1.0);
  if (u_blend == 5) return abs(b - t);
  if (u_blend == 6) return max(b, t);
  if (u_blend == 7) return min(b, t);
  return t;
}
void main() {
  vec4 b = texture(u_base, v_uv);
  vec4 t = texture(u_tex, v_uv);
  vec3 bl = mix(t.rgb, blendFn(b.rgb, t.rgb), b.a);
  vec4 top = vec4(bl, t.a);
  vec4 pm = mix(vec4(b.rgb * b.a, b.a), vec4(top.rgb * top.a, top.a), u_mix);
  fragColor = unpremul(pm);
}`;

export const OVER = `
uniform sampler2D u_top;
void main() { fragColor = over(texture(u_top, v_uv), texture(u_tex, v_uv)); }`;
