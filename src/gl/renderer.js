// WebGL2 render pipeline: compose (media + text + adjustments) -> effect stack -> overlay text.
// Every pass renders into pooled RGBA8 targets holding straight (non-premultiplied) alpha.

import { VERT, HEADER, paramDecls, paramUniforms } from './glsl.js';
import { COMPOSE, PRESENT, COPY, NEAREST, DOWNSAMPLE, BLUR1D, MIX, OVER, BLENDS } from './core.js';
import { EFFECTS } from '../effects/index.js';
import { drawTextLayers } from '../text.js';
import { fontState, ensureFont } from '../fonts.js';
import { blueNoise } from '../cpu/bluenoise.js';

// Thrown while an effect's shader is still compiling in the background; the effect is
// skipped for that frame and the caller re-renders until everything is ready.
export const NOT_READY = new Error('shader compiling');

export class Renderer {
  constructor(canvas, { preserve = false, sync = false } = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: preserve, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.canvas = canvas;
    this.programs = new Map();
    this.pool = [];
    this.persist = new Map();
    this.usedPersist = new Set();
    this.atlases = new Map();
    this.customTextures = new Map();
    this.vao = gl.createVertexArray();
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    this.dummy = this.makeTexture(1, 1, new Uint8Array(4));
    this.text = {
      under: { canvas: document.createElement('canvas'), key: '', tex: null },
      over: { canvas: document.createElement('canvas'), key: '', tex: null },
    };
    this.mediaTex = null;
    this.mediaKey = null;
    this.result = null;
    this.frame = {};
    this.asciiText = null;
    this.vs = null;
    this.parallel = sync ? null : gl.getExtension('KHR_parallel_shader_compile');
    this.compiling = false;
    this.tracked = null;
  }

  // ---------- GL resources ----------
  makeTexture(w, h, data = null, filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.texParams(filter ?? gl.LINEAR);
    return t;
  }
  texParams(minFilter, magFilter = this.gl.LINEAR) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  createTarget(w, h) {
    const gl = this.gl;
    const tex = this.makeTexture(w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }
  destroyTarget(t) {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }
  acquire(w, h) {
    const i = this.pool.findIndex(t => t.w === w && t.h === h);
    const t = i >= 0 ? this.pool.splice(i, 1)[0] : this.createTarget(w, h);
    this.tracked?.push(t);
    return t;
  }
  release(t) {
    if (!t || !t.fbo) return;
    if (this.pool.includes(t)) return;
    this.pool.push(t);
    while (this.pool.length > 14) this.destroyTarget(this.pool.shift());
  }

  // Core passes compile synchronously; effect shaders compile in the background when
  // KHR_parallel_shader_compile is available, so adding a heavy effect never freezes the UI.
  program(key, body) {
    let p = this.programs.get(key);
    if (p && !p.pending) return p;
    const gl = this.gl;
    if (!p) {
      if (!this.vs) {
        this.vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(this.vs, VERT);
        gl.compileShader(this.vs);
      }
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, HEADER + body);
      gl.compileShader(fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, this.vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      p = { prog, fs, pending: true };
      this.programs.set(key, p);
    }
    const background = this.parallel && !this.forceSync && !key.startsWith('core.');
    if (background && !gl.getProgramParameter(p.prog, this.parallel.COMPLETION_STATUS_KHR)) {
      this.compiling = true;
      throw NOT_READY;
    }
    const prog = p.prog;
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getShaderInfoLog(p.fs) || gl.getProgramInfoLog(prog);
      this.programs.delete(key);
      throw new Error(`shader "${key}": ${log}`);
    }
    const uniforms = {};
    const samplers = [];
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      const name = info.name.replace(/\[0\]$/, '');
      const sampler = info.type === gl.SAMPLER_2D;
      uniforms[name] = { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size, sampler };
      if (sampler) samplers.push(name);
    }
    Object.assign(p, { uniforms, samplers, pending: false });
    return p;
  }

  setUniform(u, v) {
    const gl = this.gl;
    switch (u.type) {
      case gl.FLOAT: u.size > 1 ? gl.uniform1fv(u.loc, v) : gl.uniform1f(u.loc, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
      case gl.INT: case gl.BOOL:
        if (u.size > 1) gl.uniform1iv(u.loc, v);
        else gl.uniform1i(u.loc, typeof v === 'boolean' ? (v ? 1 : 0) : (v | 0));
        break;
    }
  }

  draw(prog, uniforms, textures, target, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.prog);
    let unit = 0;
    for (const name of prog.samplers) {
      const t = textures[name];
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t ? (t.tex || t) : this.dummy);
      gl.uniform1i(prog.uniforms[name].loc, unit);
      unit++;
    }
    const all = { ...this.frame, u_res: [w, h], ...uniforms };
    for (const name in all) {
      const u = prog.uniforms[name];
      if (u && !u.sampler && all[name] !== undefined) this.setUniform(u, all[name]);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  runPass(key, body, uniforms, textures, w, h, target = null) {
    const prog = this.program(key, body);
    const out = target || this.acquire(w, h);
    this.draw(prog, uniforms, textures, out, w, h);
    return out;
  }

  read(t) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    const out = new Uint8Array(t.w * t.h * 4);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }
  // GL rows are bottom-up; flip into a top-down buffer for 2D canvases / encoders.
  readTopDown(t) {
    const src = this.read(t);
    const row = t.w * 4;
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < t.h; y++) out.set(src.subarray((t.h - 1 - y) * row, (t.h - y) * row), y * row);
    return out;
  }
  uploadTarget(data, w, h) {
    const gl = this.gl;
    const t = this.acquire(w, h);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return t;
  }
  downsample(t, w, h) {
    return this.runPass('core.downsample', DOWNSAMPLE, { u_srcRes: [t.w, t.h] }, { u_tex: t }, w, h);
  }
  copy(t, w = t.w, h = t.h) {
    return this.runPass('core.copy', COPY, {}, { u_tex: t }, w, h);
  }
  copyInto(src, dst) {
    this.runPass('core.copy', COPY, {}, { u_tex: src }, dst.w, dst.h, dst);
  }
  // Separable gaussian. Large radii run on a downsampled copy so the kernel stays short.
  blur(src, sigma) {
    const { w, h } = src;
    if (sigma < 0.35) return this.copy(src);
    let ds = 1;
    while (sigma / ds > 6 && ds < 32) ds *= 2;
    const bw = Math.max(1, Math.round(w / ds)), bh = Math.max(1, Math.round(h / ds));
    const s = sigma / ds;
    const a = ds > 1 ? this.downsample(src, bw, bh) : src;
    const b = this.runPass('core.blur', BLUR1D, { u_dir: [1, 0], u_sigma: s }, { u_tex: a }, bw, bh);
    if (a !== src) this.release(a);
    const c = this.runPass('core.blur', BLUR1D, { u_dir: [0, 1], u_sigma: s }, { u_tex: b }, bw, bh);
    this.release(b);
    if (ds === 1) return c;
    const up = this.copy(c, w, h);
    this.release(c);
    return up;
  }
  history(key, w, h) {
    this.usedPersist.add(key);
    let t = this.persist.get(key);
    let fresh = false;
    if (!t || t.w !== w || t.h !== h) {
      if (t) this.destroyTarget(t);
      t = this.createTarget(w, h);
      this.persist.set(key, t);
      fresh = true;
    }
    return { rt: t, fresh };
  }
  gcPersist() {
    for (const [k, t] of this.persist) {
      if (!this.usedPersist.has(k)) { this.destroyTarget(t); this.persist.delete(k); }
    }
  }

  // Glyph atlas for the ascii effect: 16 glyphs per row, 48x96 cells, white on transparent.
  // Small static lookup textures (blue noise etc.), built once per context.
  customTexture(key, build) {
    let t = this.customTextures.get(key);
    if (t) return t;
    const gl = this.gl;
    const { data, w, h, nearest = true, repeat = true } = build();
    const tex = this.makeTexture(w, h, data, nearest ? gl.NEAREST : gl.LINEAR);
    if (nearest) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    if (repeat) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }
    t = { tex, w, h };
    this.customTextures.set(key, t);
    return t;
  }
  blueNoise() {
    return this.customTexture('bluenoise', () => {
      const n = blueNoise(64);
      const data = new Uint8Array(64 * 64 * 4);
      for (let i = 0; i < n.length; i++) { const v = n[i]; data[i * 4] = v; data[i * 4 + 1] = n[(i + 1999) % n.length]; data[i * 4 + 2] = n[(i + 3001) % n.length]; data[i * 4 + 3] = 255; }
      return { data, w: 64, h: 64 };
    });
  }

  atlas(chars, font, bold) {
    const gl = this.gl;
    const ready = ensureFont(font, bold ? 700 : 400);
    const key = `${chars.join('')}|${font}|${bold}|${ready ? fontState.gen : 'x'}`;
    let a = this.atlases.get(key);
    if (a) return a;
    const GW = 48, GH = 96, COLS = 16;
    const rows = Math.ceil(chars.length / COLS);
    const c = document.createElement('canvas');
    c.width = COLS * GW; c.height = rows * GH;
    const ctx = c.getContext('2d');
    const fam = `"${font}", "Space Mono", monospace`;
    ctx.font = `${bold ? 700 : 400} 100px ${fam}`;
    const adv = Math.max(1, ctx.measureText('M').width) / 100;
    const size = Math.min(GH * 0.84, (GW * 0.98) / adv);
    ctx.font = `${bold ? 700 : 400} ${size}px ${fam}`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    chars.forEach((ch, i) => ctx.fillText(ch, (i % COLS + 0.5) * GW, (Math.floor(i / COLS) + 0.5) * GH + size * 0.04));
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.texParams(gl.LINEAR_MIPMAP_LINEAR);
    a = { tex, grid: [COLS, rows] };
    this.atlases.set(key, a);
    if (this.atlases.size > 6) {
      const [k0, old] = this.atlases.entries().next().value;
      gl.deleteTexture(old.tex);
      this.atlases.delete(k0);
    }
    return a;
  }

  // ---------- inputs ----------
  syncMedia(scene) {
    const m = scene.media;
    if (!m) return null;
    const gl = this.gl;
    const isVideo = typeof HTMLVideoElement !== 'undefined' && m instanceof HTMLVideoElement;
    if (isVideo && m.readyState < 2) return this.mediaKey != null ? { tex: this.mediaTex } : null;
    if (m instanceof HTMLImageElement && !m.complete) return null;
    if (!this.mediaTex) this.mediaTex = gl.createTexture();
    if (scene.mediaLive || this.mediaKey !== scene.mediaKey) {
      gl.bindTexture(gl.TEXTURE_2D, this.mediaTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      const mip = !scene.mediaLive;
      if (mip) gl.generateMipmap(gl.TEXTURE_2D);
      this.texParams(mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      this.mediaKey = scene.mediaKey;
    }
    return { tex: this.mediaTex };
  }

  syncText(scene, w, h, which) {
    const filtered = which === 'under';
    const layers = (scene.texts || []).filter(L => L.visible && L.text && (!!L.filtered === filtered));
    if (!layers.length) return null;
    const st = this.text[which];
    const key = `${JSON.stringify(layers)}|${w}x${h}|${scene.docW}x${scene.docH}|${fontState.gen}`;
    if (key !== st.key || !st.tex) {
      const gl = this.gl;
      const c = st.canvas;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      drawTextLayers(c.getContext('2d'), layers, scene.docW, scene.docH, w, h);
      if (!st.tex) st.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, st.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.texParams(gl.LINEAR);
      st.key = key;
    }
    return st.tex;
  }

  // ---------- pipeline ----------
  // opts: { w, h, k, time, clear, wantAscii, isolated, sync }
  // sync: block on any shader still compiling, for one-shot renders that need a complete result.
  render(scene, opts) {
    const { w, h } = opts;
    this.forceSync = !!opts.sync;
    const t0 = performance.now();
    this.frame = {
      u_time: opts.time || 0,
      u_k: opts.k,
      u_pal: scene.palFlat,
      u_palN: scene.palN,
      u_ink: scene.ink,
      u_paper: scene.paper,
      u_clear: !!opts.clear,
    };
    this.asciiText = null;
    this.compiling = false;
    this.usedPersist = new Set();
    const media = this.syncMedia(scene);
    const under = this.syncText(scene, w, h, 'under');
    const over = this.syncText(scene, w, h, 'over');
    const a = scene.adjust;
    let cur = this.runPass('core.compose', COMPOSE, {
      u_hasMedia: !!media,
      u_mrect: scene.mediaRect,
      u_bg: opts.clear ? [0, 0, 0, 0] : [...scene.bg, 1],
      u_bright: a.brightness / 100 * 0.5,
      u_contrast: (a.contrast + 100) / 100,
      u_sat: (a.saturation + 100) / 100,
      u_hue: a.hue || 0,
      u_invert: !!a.invert,
      u_gray: !!a.grayscale,
    }, { u_media: media, u_text: under }, w, h);

    const ctx = this.effectContext(scene, opts);
    for (const fx of scene.effects) {
      const def = EFFECTS[fx.type];
      if (!def || !fx.enabled) continue;
      ctx.input = cur;
      ctx.fx = fx;
      let out;
      this.tracked = [];
      try {
        out = def.run ? def.run(ctx, fx.params, fx) : ctx.shader(def, fx.params);
        fx._err = null;
      } catch (e) {
        // give back whatever the half-finished effect grabbed from the pool
        this.tracked.forEach(t => { if (t !== cur) this.release(t); });
        this.tracked = null;
        if (e !== NOT_READY) {
          console.error(`[${fx.type}]`, e);
          fx._err = String(e.message || e);
        }
        continue;
      }
      this.tracked = null;
      if (!out || out === cur) continue;
      const mix = fx.mix ?? 1;
      const blend = fx.blend || 'normal';
      if (mix < 0.999 || blend !== 'normal') {
        const m = this.runPass('core.mix', MIX, { u_mix: mix, u_blend: Math.max(0, BLENDS.indexOf(blend)) }, { u_tex: out, u_base: cur }, w, h);
        this.release(out);
        out = m;
      }
      this.release(cur);
      cur = out;
    }
    if (over) {
      const o = this.runPass('core.over', OVER, {}, { u_tex: cur, u_top: over }, w, h);
      this.release(cur);
      cur = o;
    }
    if (!opts.isolated) this.gcPersist();
    if (this.result && this.result !== cur) this.release(this.result);
    this.result = cur;
    this.lastMs = performance.now() - t0;
    return cur;
  }

  effectContext(scene, opts) {
    const r = this;
    const { w, h, k } = opts;
    const ctx = {
      w, h, k,
      time: opts.time || 0,
      clear: !!opts.clear,
      wantAscii: !!opts.wantAscii,
      palette: scene.palBytes,
      input: null,
      fx: null,
      uniforms: (def, p) => paramUniforms(def.params, p),
      shader: (def, p, extra = {}, textures = {}, tw = w, th = h) =>
        r.runPass(def.id, paramDecls(def.params) + def.frag, { ...paramUniforms(def.params, p), ...extra }, { u_tex: ctx.input, ...textures }, tw, th),
      pass: (key, body, uniforms, textures, tw = w, th = h) => r.runPass(key, body, uniforms, textures, tw, th),
      release: t => r.release(t),
      read: t => r.read(t),
      upload: (data, tw, th) => r.uploadTarget(data, tw, th),
      downsample: (t, tw, th) => r.downsample(t, tw, th),
      nearest: (t, tw = w, th = h) => r.runPass('core.nearest', NEAREST, {}, { u_tex: t }, tw, th),
      copy: (t, tw, th) => r.copy(t, tw, th),
      copyInto: (src, dst) => r.copyInto(src, dst),
      blur: (t, sigma) => r.blur(t, sigma),
      history: key => r.history(key, w, h),
      atlas: (chars, font, bold) => r.atlas(chars, font, bold),
      blueNoise: () => r.blueNoise().tex,
      setAscii: txt => { r.asciiText = txt; },
    };
    return ctx;
  }

  // Draw the last result to the visible canvas.
  present(bg = null) {
    if (!this.result) return;
    const { w, h } = this.result;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const prog = this.program('core.present', PRESENT);
    this.draw(prog, { u_bg: bg ? [...bg, 1] : [0, 0, 0, 0], u_premul: true }, { u_tex: this.result }, null, w, h);
  }

  // Final pixels as straight-alpha, top-down RGBA (for export). bg = [r,g,b] composites onto a colour.
  readResult(bg = null) {
    const src = this.result;
    const t = this.runPass('core.present', PRESENT, { u_bg: bg ? [...bg, 1] : [0, 0, 0, 0], u_premul: false }, { u_tex: src }, src.w, src.h);
    const data = this.readTopDown(t);
    this.release(t);
    return data;
  }

  destroy() {
    try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
  }
}
