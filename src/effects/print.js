import { pct, deg, times, fixed } from './fmt.js';

export const ASCII_CHARSETS = {
  standard: ' .:-=+*#%@',
  blocks: ' ░▒▓█',
  halfblocks: ' ▁▂▃▄▅▆▇█',
  dots: ' .·•○●',
  binary: ' 01',
  matrix: ' .,:;|()[]{}#@',
  dense: ' .`\'^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
  slashes: ' /\\|-+*#',
  minimal: ' .#',
  braille: ' ⠁⠃⠇⠏⠟⠿⣿',
  shades: ' ░▒▓█',
  geometric: ' ◦○◎●◉■',
  katakana: ' ･ｰｼﾂﾐｦｱﾈﾒﾀ',
};
const EDGE_CHARS = ['|', '-', '\\', '/'];
export const ASCII_FONTS = ['Space Mono', 'JetBrains Mono', 'IBM Plex Mono', 'Courier Prime', 'VT323', 'Press Start 2P', 'Silkscreen', 'Major Mono Display'];

const SHAPES = [['circle', 'circle'], ['square', 'square'], ['diamond', 'diamond'], ['line', 'line'], ['cross', 'cross'], ['hex', 'hexagon'], ['ring', 'ring']];

const plateParams = ['c', 'm', 'y', 'k'].flatMap(ch => {
  const name = { c: 'cyan', m: 'magenta', y: 'yellow', k: 'black' }[ch];
  const up = ch.toUpperCase();
  const show = p => p.cmyk;
  return [
    { sep: `${name} plate`, show },
    { key: `print${up}`, label: `print ${name}`, type: 'toggle', def: true, show },
    { key: `${ch}Size`, label: `${name} · dot size`, type: 'range', min: 0.2, max: 3, step: 0.05, def: 1, fmt: times, show },
    { key: `${ch}Bias`, label: `${name} · bias`, type: 'range', min: -1, max: 1, step: 0.02, def: 0, fmt: fixed(2), show },
    { key: `${ch}Curve`, label: `${name} · curve`, type: 'range', min: 0.2, max: 5, step: 0.05, def: 1, fmt: fixed(2), show },
    { key: `${ch}OffX`, label: `${name} · misregister x`, type: 'range', min: -8, max: 8, step: 1, def: 0, unit: 'px', show },
    { key: `${ch}OffY`, label: `${name} · misregister y`, type: 'range', min: -8, max: 8, step: 1, def: 0, unit: 'px', show },
  ];
});

export default [
  {
    id: 'halftone', name: 'halftone', icon: '◉', group: 'print', paper: true,
    desc: 'print dots — mono, colour, or full cmyk plates',
    thumb: { dotSize: 10 },
    params: [
      { key: 'cmyk', label: 'cmyk separation', type: 'toggle', def: false },
      { key: 'dotSize', label: 'dot size', type: 'range', min: 3, max: 40, step: 1, def: 8, unit: 'px' },
      { key: 'spacing', label: 'dot spacing', type: 'range', min: 0.7, max: 2.5, step: 0.05, def: 1, fmt: times },
      { key: 'angle', label: 'rotation', type: 'range', min: 0, max: 90, step: 1, def: 15, fmt: deg },
      { key: 'contrast', label: 'contrast', type: 'range', min: 0.2, max: 3, step: 0.05, def: 1, fmt: times, show: p => !p.cmyk },
      { key: 'shape', label: 'shape', type: 'select', def: 'circle', options: SHAPES },
      { key: 'color', label: 'dot colour', type: 'seg', def: 'ink', options: [['ink', 'palette ink'], ['source', 'source']], show: p => !p.cmyk },
      { key: 'invert', label: 'dots for light areas', type: 'toggle', def: false, show: p => !p.cmyk },
      ...plateParams,
    ],
    frag: `
float shapeSD(vec2 d, float D, float v) {
  float sv = sqrt(v);
  vec2 a = abs(d);
  if (u_shape == SHAPE_CIRCLE)  return length(d) - 0.70711 * D * sv;
  if (u_shape == SHAPE_SQUARE)  return max(a.x, a.y) - 0.5 * D * sv;
  if (u_shape == SHAPE_DIAMOND) return (a.x + a.y) - D * sv;
  if (u_shape == SHAPE_LINE)    return a.y - 0.5 * D * v;
  if (u_shape == SHAPE_CROSS)   { float L = 0.6 * D * sv, T = L * 0.36; return min(max(a.x - L, a.y - T), max(a.y - L, a.x - T)); }
  if (u_shape == SHAPE_HEX)     return max(a.x * 0.866025 + a.y * 0.5, a.y) - 0.58 * D * sv;
  return abs(length(d) - 0.3 * D) - 0.36 * D * v;   // ring
}

// One screen: rotated grid, dot per cell sized by the channel value at the cell centre.
// Checks the 3x3 neighbourhood so dots larger than a cell still merge cleanly.
// Returns rgb = colour under the winning dot, a = coverage.
vec4 screen(float angle, float D, float cellStep, vec2 offset, int ch, float bias, float curve) {
  mat2 R = rot2(angle);
  vec2 p = R * (gl_FragCoord.xy + offset);
  vec2 id = floor(p / cellStep);
  float cov = 0.0;
  vec3 col = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 cid = id + vec2(float(i), float(j));
    vec2 centre = (cid + 0.5) * cellStep;
    vec4 s = texture(u_tex, (transpose(R) * centre - offset) / u_res);
    float v;
    if (ch == 0) {
      float l = luma(s.rgb);
      v = u_invert ? l : 1.0 - l;
      v = pow(clamp(v, 0.0, 1.0), 1.0 / u_contrast);
    } else {
      float k = 1.0 - max(max(s.r, s.g), s.b);
      vec3 cmy = k >= 0.999 ? vec3(0.0) : (1.0 - s.rgb - k) / (1.0 - k);
      v = ch == 1 ? cmy.r : ch == 2 ? cmy.g : ch == 3 ? cmy.b : k;
      v = pow(clamp(v + bias, 0.0, 1.0), curve);
    }
    v *= s.a;
    if (v < 0.002) continue;
    float sd = shapeSD(p - centre, D, v);
    float m = 1.0 - smoothstep(-0.75, 0.75, sd);
    if (m > cov) { cov = m; col = s.rgb; }
  }
  return vec4(col, cov);
}

void main() {
  float D = max(1.5, u_dotSize * u_k);
  float a = radians(u_angle);
  if (!u_cmyk) {
    vec4 s = screen(a, D, D * u_spacing, vec2(0.0), 0, 0.0, 1.0);
    vec3 ink = u_color == COLOR_SOURCE ? s.rgb : u_ink;
    fragColor = inkOver(paperColor(), ink, s.a);
    return;
  }
  float k = u_k;
  float cc = u_printC ? screen(a + radians(15.0), D * u_cSize, D * u_cSize * u_spacing, vec2(u_cOffX, u_cOffY) * k, 1, u_cBias, u_cCurve).a : 0.0;
  float cm = u_printM ? screen(a + radians(75.0), D * u_mSize, D * u_mSize * u_spacing, vec2(u_mOffX, u_mOffY) * k, 2, u_mBias, u_mCurve).a : 0.0;
  float cy = u_printY ? screen(a, D * u_ySize, D * u_ySize * u_spacing, vec2(u_yOffX, u_yOffY) * k, 3, u_yBias, u_yCurve).a : 0.0;
  float ck = u_printK ? screen(a + radians(45.0), D * u_kSize, D * u_kSize * u_spacing, vec2(u_kOffX, u_kOffY) * k, 4, u_kBias, u_kCurve).a : 0.0;
  vec3 inkC = vec3(0.0, 0.68, 0.94), inkM = vec3(0.93, 0.0, 0.55), inkY = vec3(1.0, 0.95, 0.0), inkK = vec3(0.08);
  vec3 col = vec3(1.0);
  col = mix(col, col * inkY, cy);
  col = mix(col, col * inkC, cc);
  col = mix(col, col * inkM, cm);
  col = mix(col, col * inkK, ck);
  if (u_clear) {
    float cov = 1.0 - (1.0 - cc) * (1.0 - cm) * (1.0 - cy) * (1.0 - ck);
    fragColor = vec4(clamp((col - (1.0 - cov)) / max(cov, 1e-4), 0.0, 1.0), cov);
  } else {
    fragColor = vec4(col * vec3(0.98, 0.972, 0.94), 1.0);
  }
}`,
  },

  {
    id: 'ascii', name: 'ascii', icon: '░', group: 'print', paper: true,
    desc: 'characters as pixels, with optional edge strokes | - / \\',
    thumb: { density: 34 },
    params: [
      { key: 'charset', label: 'character set', type: 'select', def: 'standard', options: Object.keys(ASCII_CHARSETS), glsl: false },
      { key: 'density', label: 'density', type: 'range', min: 20, max: 300, step: 1, def: 100, fmt: v => `${v} cols`, glsl: false },
      { key: 'font', label: 'font', type: 'select', def: 'Space Mono', options: ASCII_FONTS, glsl: false },
      { key: 'textMode', label: 'preview as', type: 'seg', def: false, options: [[false, 'canvas'], [true, 'text']], glsl: false },
      { key: 'exposure', label: 'luminance exposure', type: 'range', min: 0.1, max: 5, step: 0.05, def: 1, fmt: times },
      { key: 'attenuation', label: 'luminance attenuation', type: 'range', min: 0.2, max: 5, step: 0.05, def: 1, fmt: fixed(2) },
      { key: 'drawFill', label: 'draw fill chars', type: 'toggle', def: true },
      { key: 'drawEdges', label: 'draw edge chars ( | _ / \\ )', type: 'toggle', def: true },
      { key: 'edgeThreshold', label: 'edge threshold', type: 'range', min: 1, max: 64, step: 1, def: 8, fmt: v => `${v}/64`, show: p => p.drawEdges },
      { key: 'dogThreshold', label: 'edge detail', type: 'range', min: 0.001, max: 0.1, step: 0.001, def: 0.02, fmt: fixed(3), show: p => p.drawEdges, glsl: false },
      { key: 'color', label: 'character colour', type: 'seg', def: 'palette', options: [['palette', 'palette'], ['ink', 'ink'], ['source', 'source']] },
      { key: 'blendWithBase', label: 'blend with base', type: 'range', min: 0, max: 1, step: 0.01, def: 0, fmt: pct },
      { key: 'invertBright', label: 'dense chars in dark areas', type: 'toggle', def: true },
      { key: 'bold', label: 'bold characters', type: 'toggle', def: true, glsl: false },
    ],
    run(ctx, p) {
      const fill = Array.from(ASCII_CHARSETS[p.charset] || ASCII_CHARSETS.standard);
      const chars = [...fill, ...EDGE_CHARS];
      const cols = Math.max(1, Math.round(p.density));
      const rows = Math.max(1, Math.round((ctx.h / ctx.w) * cols * 0.5));   // character cells are 1:2
      const small = ctx.downsample(ctx.input, cols, rows);
      const edges = p.drawEdges ? asciiEdges(ctx, p, cols, rows) : null;
      if (p.textMode || ctx.wantAscii) {
        ctx.setAscii(asciiText(ctx.read(small), edges ? ctx.read(edges) : null, cols, rows, fill, p));
      }
      const atlas = ctx.atlas(chars, p.font, p.bold);
      const out = ctx.shader(this, p, {
        u_grid: [cols, rows], u_nfill: fill.length, u_atlasGrid: atlas.grid, u_hasEdges: !!edges,
      }, { u_small: small, u_edges: edges, u_atlas: atlas.tex });
      ctx.release(small);
      if (edges) ctx.release(edges);
      return out;
    },
    frag: `
uniform sampler2D u_small;
uniform sampler2D u_edges;
uniform sampler2D u_atlas;
uniform vec2 u_grid;
uniform vec2 u_atlasGrid;
uniform float u_nfill;
uniform bool u_hasEdges;
void main() {
  vec2 cell = u_res / u_grid;
  vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);          // top-left origin
  vec2 cid = min(floor(p / cell), u_grid - 1.0);
  vec2 local = (p - cid * cell) / cell;                                // 0..1, y down
  ivec2 tp = ivec2(int(cid.x), int(u_grid.y - 1.0 - cid.y));
  vec4 s = texelFetch(u_small, tp, 0);
  float lum = pow(min(1.0, luma(s.rgb) * u_exposure), u_attenuation);
  if (u_invertBright) lum = 1.0 - lum;
  float idx = -1.0;
  float edge = u_hasEdges ? floor(texelFetch(u_edges, tp, 0).r * 255.0 + 0.5) : 0.0;
  if (u_drawEdges && edge > 0.5) idx = u_nfill + edge - 1.0;
  else if (u_drawFill) idx = clamp(floor(lum * (u_nfill - 1.0)), 0.0, u_nfill - 1.0);
  float m = 0.0;
  if (idx >= 0.0) {
    float gx = mod(idx, u_atlasGrid.x), gy = floor(idx / u_atlasGrid.x);
    vec2 auv = vec2((gx + local.x) / u_atlasGrid.x, 1.0 - (gy + local.y) / u_atlasGrid.y);
    vec2 dx = vec2(1.0 / (cell.x * u_atlasGrid.x), 0.0), dy = vec2(0.0, 1.0 / (cell.y * u_atlasGrid.y));
    m = textureGrad(u_atlas, auv, dx, dy).a;
  }
  vec3 ink = u_color == COLOR_SOURCE ? s.rgb : (u_color == COLOR_PALETTE ? nearestPal(s.rgb) : u_ink);
  if (u_blendWithBase > 0.0) {
    vec3 base = texture(u_tex, vec2((cid.x + 0.5) * cell.x, u_res.y - (cid.y + 0.5) * cell.y) / u_res).rgb;
    ink = mix(ink, base, u_blendWithBase);
  }
  fragColor = inkOver(paperColor(), ink, m * s.a);
}`,
  },

  {
    id: 'hatch', name: 'crosshatch', icon: '#', group: 'print', paper: true,
    desc: 'pen hatching or engraved lines that follow tone',
    thumb: { spacing: 9 },
    params: [
      { key: 'style', label: 'style', type: 'seg', def: 'crosshatch', options: [['crosshatch', 'crosshatch'], ['engrave', 'engrave']] },
      { key: 'spacing', label: 'line spacing', type: 'range', min: 3, max: 40, step: 0.5, def: 7, unit: 'px' },
      { key: 'thickness', label: 'thickness', type: 'range', min: 0.1, max: 1, step: 0.01, def: 0.4, fmt: pct },
      { key: 'angle', label: 'angle', type: 'range', min: 0, max: 180, step: 1, def: 45, fmt: deg },
      { key: 'contrast', label: 'contrast', type: 'range', min: 0.5, max: 3, step: 0.05, def: 1.2, fmt: times },
      { key: 'color', label: 'line colour', type: 'seg', def: 'ink', options: [['ink', 'palette ink'], ['source', 'source']] },
      { key: 'invert', label: 'lines for light areas', type: 'toggle', def: false },
    ],
    frag: `
float lines(vec2 p, float ang, float sp, float hw) {
  float d = dot(p, vec2(cos(ang), sin(ang)));
  float f = abs(fract(d / sp) - 0.5) * sp;
  return (1.0 - smoothstep(hw - 0.75, hw + 0.75, f)) * clamp(hw * 2.0, 0.0, 1.0);
}
void main() {
  vec4 s = texture(u_tex, v_uv);
  float l = clamp((luma(s.rgb) - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  float dens = u_invert ? l : 1.0 - l;
  float sp = max(2.0, u_spacing * u_k);
  vec2 p = gl_FragCoord.xy;
  float a = radians(u_angle);
  float m;
  if (u_style == STYLE_CROSSHATCH) {
    float hw = max(0.45, u_thickness * sp * 0.5);
    m = lines(p, a, sp, hw) * smoothstep(0.10, 0.18, dens);
    m = max(m, lines(p, a + PI * 0.5, sp, hw) * smoothstep(0.35, 0.43, dens));
    m = max(m, lines(p, a + PI * 0.25, sp, hw) * smoothstep(0.58, 0.66, dens));
    m = max(m, lines(p, a - PI * 0.25, sp, hw) * smoothstep(0.78, 0.86, dens));
  } else {
    vec2 dir = vec2(cos(a), sin(a));
    vec2 nrm = vec2(-dir.y, dir.x);
    float d = dot(p, dir) + sin(dot(p, nrm) / (sp * 5.0)) * sp * 0.35 + l * sp * 0.6;
    float f = abs(fract(d / sp) - 0.5) * sp;
    float hw = dens * sp * u_thickness;
    m = (1.0 - smoothstep(hw - 0.75, hw + 0.75, f)) * clamp(hw * 2.0, 0.0, 1.0);
  }
  vec3 ink = u_color == COLOR_SOURCE ? s.rgb : u_ink;
  fragColor = inkOver(paperColor(), ink, m * s.a);
}`,
  },

  {
    id: 'dotmatrix', name: 'led / dot matrix', icon: '⁘', group: 'print', paper: true,
    desc: 'scoreboard lights on a dark panel',
    thumb: { size: 7 },
    params: [
      { key: 'size', label: 'cell size', type: 'range', min: 3, max: 40, step: 0.5, def: 9, unit: 'px' },
      { key: 'gap', label: 'gap', type: 'range', min: 0, max: 0.8, step: 0.01, def: 0.2, fmt: pct },
      { key: 'shape', label: 'shape', type: 'seg', def: 'round', options: [['round', 'round'], ['square', 'square']] },
      { key: 'color', label: 'colour', type: 'seg', def: 'source', options: [['source', 'source'], ['palette', 'palette'], ['mono', 'mono']] },
      { key: 'tint', label: 'mono tint', type: 'color', def: '#ff6a1a', show: p => p.color === 'mono' },
      { key: 'levels', label: 'brightness steps', type: 'range', min: 1, max: 8, step: 1, def: 1, fmt: v => v < 2 ? 'smooth' : `${v}` },
      { key: 'glow', label: 'glow', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3, fmt: pct },
    ],
    frag: `
void main() {
  float cell = max(2.0, u_size * u_k);
  vec2 p = gl_FragCoord.xy;
  vec2 id = floor(p / cell);
  vec2 q = (p - (id + 0.5) * cell) / cell;
  vec4 s = texture(u_tex, (id + 0.5) * cell / u_res);
  vec3 col = u_color == COLOR_PALETTE ? nearestPal(s.rgb) : (u_color == COLOR_MONO ? luma(s.rgb) * u_tint : s.rgb);
  if (u_levels >= 2.0) col = floor(col * (u_levels - 1.0) + 0.5) / (u_levels - 1.0);
  float r = 0.5 * (1.0 - u_gap);
  float d = u_shape == SHAPE_ROUND ? length(q) : max(abs(q.x), abs(q.y));
  float aa = 0.8 / cell;
  float dotm = 1.0 - smoothstep(r - aa, r + aa, d);
  float halo = u_glow * exp(-pow(max(d - r, 0.0) / max(r, 0.05), 2.0) * 3.0) * (1.0 - dotm);
  vec4 bg = u_clear ? vec4(0.0) : vec4(u_ink * 0.6, 1.0);
  vec4 o = inkOver(bg, col, dotm * s.a);
  vec3 g = col * halo * s.a;
  fragColor = u_clear ? over(vec4(col, clamp(halo * s.a * max(col.r, max(col.g, col.b)), 0.0, 1.0)), o)
                      : vec4(min(o.rgb + g, 1.0), o.a);
}`,
  },
];

// ---------- ascii helpers ----------

// Difference-of-gaussians edges, voted per character cell into 4 directions.
// Returns a cols x rows target whose red channel holds (direction + 1) / 255, or 0.
function asciiEdges(ctx, p, cols, rows) {
  const W = cols * 8, H = rows * 8;
  const base = ctx.downsample(ctx.input, W, H);
  const a = ctx.blur(base, 1.4);
  const b = ctx.blur(base, 1.4 * 1.6);
  ctx.release(base);
  const dog = ctx.pass('ascii.dog', DOG, { u_thr: p.dogThreshold }, { u_tex: a, u_b: b }, W, H);
  ctx.release(a); ctx.release(b);
  const dir = ctx.pass('ascii.dir', DIRS, {}, { u_tex: dog }, W, H);
  ctx.release(dog);
  const vote = ctx.pass('ascii.vote', VOTE, { u_minVotes: p.edgeThreshold }, { u_tex: dir }, cols, rows);
  ctx.release(dir);
  return vote;
}

const DOG = `
uniform sampler2D u_b;
uniform float u_thr;
void main() {
  float d = luma(texture(u_tex, v_uv).rgb) - luma(texture(u_b, v_uv).rgb);
  fragColor = vec4(vec3(abs(d) > u_thr ? 1.0 : 0.0), 1.0);
}`;

// Sobel over the DoG mask; directions bucketed exactly like the original CPU version
// (gradient measured with rows running top to bottom).
const DIRS = `
float m(ivec2 p) { ivec2 sz = textureSize(u_tex, 0); return texelFetch(u_tex, clamp(p, ivec2(0), sz - 1), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (m(p) < 0.5) { fragColor = vec4(0.0); return; }
  float tl = m(p + ivec2(-1, 1)), t = m(p + ivec2(0, 1)), tr = m(p + ivec2(1, 1));
  float l = m(p + ivec2(-1, 0)), r = m(p + ivec2(1, 0));
  float bl = m(p + ivec2(-1, -1)), b = m(p + ivec2(0, -1)), br = m(p + ivec2(1, -1));
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
  if (gx == 0.0 && gy == 0.0) { fragColor = vec4(0.0); return; }
  float theta = atan(gy, gx);
  float at = abs(theta) / PI;
  float dir;
  if (at < 0.05 || at > 0.9) dir = 0.0;
  else if (at > 0.45 && at < 0.55) dir = 1.0;
  else if (at <= 0.45) dir = theta > 0.0 ? 3.0 : 2.0;
  else dir = theta > 0.0 ? 2.0 : 3.0;
  fragColor = vec4((dir + 1.0) / 255.0, 0.0, 0.0, 1.0);
}`;

const VOTE = `
uniform float u_minVotes;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 8;
  float c0 = 0.0, c1 = 0.0, c2 = 0.0, c3 = 0.0;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
    float d = floor(texelFetch(u_tex, base + ivec2(i, j), 0).r * 255.0 + 0.5);
    c0 += float(d == 1.0); c1 += float(d == 2.0); c2 += float(d == 3.0); c3 += float(d == 4.0);
  }
  float best = c0, dir = 1.0;
  if (c1 > best) { best = c1; dir = 2.0; }
  if (c2 > best) { best = c2; dir = 3.0; }
  if (c3 > best) { best = c3; dir = 4.0; }
  fragColor = vec4(best >= u_minVotes && best > 0.0 ? dir / 255.0 : 0.0, 0.0, 0.0, 1.0);
}`;

function asciiText(small, edges, cols, rows, fill, p) {
  const n = fill.length;
  let out = '';
  for (let r = 0; r < rows; r++) {
    const y = rows - 1 - r;                       // GL rows are bottom-up
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4;
      if (small[i + 3] < 128) { out += ' '; continue; }
      const e = edges ? edges[i] : 0;
      if (p.drawEdges && e > 0) { out += EDGE_CHARS[e - 1]; continue; }
      if (!p.drawFill) { out += ' '; continue; }
      let lum = Math.pow(Math.min(1, (0.299 * small[i] + 0.587 * small[i + 1] + 0.114 * small[i + 2]) / 255 * p.exposure), p.attenuation);
      if (p.invertBright) lum = 1 - lum;
      out += fill[Math.max(0, Math.min(n - 1, Math.floor(lum * (n - 1))))];
    }
    out += '\n';
  }
  return out;
}

