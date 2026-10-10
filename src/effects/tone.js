import { pct, deg, times } from './fmt.js';

export default [
  {
    id: 'posterize', name: 'posterize', icon: '▢', group: 'tone',
    desc: 'crush colour into flat bands',
    params: [
      { key: 'levels', label: 'levels', type: 'range', min: 2, max: 16, step: 1, def: 3 },
      { key: 'usePalette', label: 'snap to palette', type: 'toggle', def: true },
    ],
    frag: `
void main() {
  vec4 c = texture(u_tex, v_uv);
  float n = u_levels - 1.0;
  vec3 q = floor(c.rgb * n + 0.5) / n;
  if (u_usePalette) q = nearestPal(q);
  fragColor = vec4(q, c.a);
}`,
  },

  {
    id: 'threshold', name: 'threshold', icon: '◐', group: 'tone', paper: true,
    desc: 'two tones: palette ink on paper',
    params: [
      { key: 'level', label: 'threshold', type: 'range', min: 0, max: 255, step: 1, def: 128 },
      { key: 'smooth', label: 'softness', type: 'range', min: 0, max: 100, step: 1, def: 0 },
      { key: 'invert', label: 'invert', type: 'toggle', def: false },
    ],
    frag: `
void main() {
  vec4 c = texture(u_tex, v_uv);
  float l = luma(c.rgb);
  float lv = u_level / 255.0;
  float s = max(u_smooth / 255.0, 0.002);
  float light = smoothstep(lv - s, lv + s, l);
  if (u_invert) light = 1.0 - light;
  fragColor = inkOver(paperColor(), u_ink, (1.0 - light) * c.a);
}`,
  },

  {
    id: 'gradmap', name: 'gradient map', icon: '▤', group: 'tone',
    desc: 'brightness mapped across the palette — repeat it for psychedelic bands',
    params: [
      { key: 'cycles', label: 'palette repeats', type: 'range', min: 1, max: 16, step: 0.5, def: 1, fmt: v => `${v}×` },
      { key: 'mirror', label: 'mirror repeats (no seams)', type: 'toggle', def: true },
      { key: 'speed', label: 'cycle speed', type: 'range', min: 0, max: 2, step: 0.01, def: 0, fmt: v => v ? `${v.toFixed(2)}/s` : 'off' },
      { key: 'steps', label: 'steps', type: 'range', min: 1, max: 16, step: 1, def: 1, fmt: v => v < 2 ? 'smooth' : `${v}` },
      { key: 'contrast', label: 'contrast', type: 'range', min: 0.2, max: 3, step: 0.05, def: 1, fmt: times },
      { key: 'offset', label: 'offset', type: 'range', min: -0.5, max: 0.5, step: 0.01, def: 0, fmt: pct },
      { key: 'reverse', label: 'reverse ramp', type: 'toggle', def: false },
    ],
    animated: p => p.speed > 0,
    frag: `
void main() {
  vec4 c = texture(u_tex, v_uv);
  float l = clamp((luma(c.rgb) - 0.5) * u_contrast + 0.5 + u_offset, 0.0, 1.0);
  if (u_reverse) l = 1.0 - l;
  if (u_cycles > 1.0 || u_speed > 0.0) {
    float f = l * u_cycles - u_time * u_speed;
    l = u_mirror ? 1.0 - abs(fract(f * 0.5) * 2.0 - 1.0) : fract(f);
  }
  if (u_steps >= 2.0) l = min(floor(l * u_steps), u_steps - 1.0) / (u_steps - 1.0);
  fragColor = vec4(palRamp(l), c.a);
}`,
  },

  {
    id: 'hue', name: 'colour shift', icon: '◑', group: 'tone',
    desc: 'rotate hue, push saturation, or cycle colours over time',
    params: [
      { key: 'hue', label: 'hue', type: 'range', min: -180, max: 180, step: 1, def: 90, fmt: deg },
      { key: 'sat', label: 'saturation', type: 'range', min: 0, max: 2.5, step: 0.01, def: 1.2, fmt: times },
      { key: 'speed', label: 'cycle speed', type: 'range', min: 0, max: 1, step: 0.01, def: 0, fmt: v => v ? `${v.toFixed(2)} rev/s` : 'off' },
    ],
    animated: p => p.speed > 0,
    frag: `
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 h = rgb2hsv(c.rgb);
  h.x = fract(h.x + u_hue / 360.0 + u_time * u_speed);
  h.y = clamp(h.y * u_sat, 0.0, 1.0);
  fragColor = vec4(hsv2rgb(h), c.a);
}`,
  },
];
