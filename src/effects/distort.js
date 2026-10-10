import { pct, deg, times } from './fmt.js';

export default [
  {
    id: 'wave', name: 'wave distort', icon: '≈', group: 'distort',
    desc: 'sine ripples across the image',
    params: [
      { key: 'amplitude', label: 'amplitude', type: 'range', min: 0, max: 80, step: 0.5, def: 10, unit: 'px' },
      { key: 'frequency', label: 'frequency', type: 'range', min: 1, max: 80, step: 0.5, def: 10, fmt: v => `${v} waves` },
      { key: 'direction', label: 'direction', type: 'seg', def: 'horizontal', options: [['horizontal', 'horiz'], ['vertical', 'vert'], ['both', 'both']] },
      { key: 'speed', label: 'speed', type: 'range', min: 0, max: 10, step: 0.1, def: 2, show: p => p.animate },
      { key: 'animate', label: 'animate', type: 'toggle', def: true },
    ],
    frag: `
void main() {
  float t = u_animate ? u_time * u_speed : 0.0;
  vec2 o = vec2(0.0);
  float amp = u_amplitude * u_k;
  if (u_direction != DIRECTION_VERTICAL) o.x = sin(v_uv.y * u_frequency * TAU + t) * amp;
  if (u_direction != DIRECTION_HORIZONTAL) o.y = sin(v_uv.x * u_frequency * TAU + t * 1.13) * amp;
  fragColor = texture(u_tex, v_uv + o / u_res);
}`,
  },

  {
    id: 'liquid', name: 'liquid warp', icon: '∿', group: 'distort',
    desc: 'domain-warped noise melts the image',
    params: [
      { key: 'amount', label: 'amount', type: 'range', min: 0, max: 200, step: 1, def: 40, unit: 'px' },
      { key: 'scale', label: 'scale', type: 'range', min: 0.5, max: 12, step: 0.1, def: 3 },
      { key: 'speed', label: 'flow speed', type: 'range', min: 0, max: 2, step: 0.01, def: 0.3 },
    ],
    animated: p => p.speed > 0,
    frag: `
void main() {
  float t = u_time * u_speed;
  vec2 asp = vec2(u_res.x / u_res.y, 1.0);
  vec2 p = v_uv * asp * u_scale;
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t * 0.7));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + t * 0.3), fbm(p + 4.0 * q + vec2(8.3, 2.8) - t * 0.2));
  fragColor = texture(u_tex, v_uv + (r - 0.5) * 2.0 * u_amount * u_k / u_res);
}`,
  },

  {
    id: 'kaleido', name: 'kaleidoscope', icon: '✱', group: 'distort',
    desc: 'mirror the image into rotating segments',
    params: [
      { key: 'segments', label: 'segments', type: 'range', min: 2, max: 24, step: 1, def: 6 },
      { key: 'rotation', label: 'rotation', type: 'range', min: 0, max: 360, step: 1, def: 0, fmt: deg },
      { key: 'zoom', label: 'zoom', type: 'range', min: 0.3, max: 4, step: 0.01, def: 1, fmt: times },
      { key: 'cx', label: 'centre x', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct },
      { key: 'cy', label: 'centre y', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, fmt: pct },
      { key: 'spin', label: 'spin', type: 'range', min: 0, max: 1, step: 0.01, def: 0, fmt: v => v ? `${v.toFixed(2)} rad/s` : 'off' },
    ],
    animated: p => p.spin > 0,
    frag: `
void main() {
  vec2 asp = vec2(u_res.x / u_res.y, 1.0);
  vec2 c = vec2(u_cx, 1.0 - u_cy);
  vec2 p = (v_uv - c) * asp;
  float r = length(p);
  float a = atan(p.y, p.x) + radians(u_rotation) + u_time * u_spin;
  float seg = TAU / u_segments;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  vec2 uv = vec2(cos(a), sin(a)) * r / u_zoom / asp + c;
  uv = 1.0 - abs(1.0 - mod(uv, 2.0));
  fragColor = texture(u_tex, uv);
}`,
  },

  {
    id: 'pixel', name: 'pixelate', icon: '▪', group: 'distort',
    desc: 'chunky square or hex pixels',
    params: [
      { key: 'size', label: 'pixel size', type: 'range', min: 2, max: 80, step: 1, def: 8, unit: 'px' },
      { key: 'shape', label: 'grid', type: 'seg', def: 'square', options: [['square', 'square'], ['hex', 'hex']] },
      { key: 'usePalette', label: 'snap to palette', type: 'toggle', def: false },
    ],
    frag: `
vec4 cellAvg(vec2 centre, float cell) {
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i), float(j)) + 0.5) / 4.0 - 0.5;
    vec4 s = texture(u_tex, (centre + o * cell * 0.9) / u_res);
    acc += vec4(s.rgb * s.a, s.a);
  }
  return unpremul(acc / 16.0);
}
void main() {
  float cell = max(1.0, u_size * u_k);
  vec2 p = gl_FragCoord.xy;
  vec2 centre;
  if (u_shape == SHAPE_HEX) {
    vec2 g = p / cell;
    vec2 r = vec2(1.0, 1.7320508), h = r * 0.5;
    vec2 a = mod(g, r) - h, b = mod(g - h, r) - h;
    centre = (g - (dot(a, a) < dot(b, b) ? a : b)) * cell;
  } else {
    centre = (floor(p / cell) + 0.5) * cell;
  }
  vec4 c = cellAvg(centre, cell);
  if (u_usePalette) c.rgb = nearestPal(c.rgb);
  fragColor = c;
}`,
  },
];
