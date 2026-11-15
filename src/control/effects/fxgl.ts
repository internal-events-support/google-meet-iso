// Shared WebGL2 effects renderer (RE ProcAmp pipeline). Used by the output engine in the
// hidden Meet page (src/meet/outputs.ts) AND by the Output Effects window preview, so the
// preview matches the NDI output exactly. Pure DOM/WebGL: no Electron or Node imports.
//
// One pass: geometry (crop insets, fit/fill, zoom, pan, rotation, mirror, auto-crop) +
// colour (sharpen, exposure, white balance/tint, lift/gamma/gain, contrast, highlights/
// shadows, tone curve LUT, hue, saturation/vibrance, brightness, vignette).

import type { OutputEffects } from '../../shared/types';
import { DEFAULT_EFFECTS } from '../../shared/types';

export type FxSource = TexImageSource;

/** Auto-crop (face tracking) override: centre in source fractions, zoom multiplier ≥ 1. */
export interface AutoCropView {
  cx: number;
  cy: number;
  zoom: number;
}

/** Output-pixel ↔ source-pixel transform. */
export interface FxGeometry {
  sw: number;
  sh: number;
  W: number;
  H: number;
  /** View centre in source pixels. */
  cx: number;
  cy: number;
  /** Output px per source px. */
  scale: number;
  /** Radians (clockwise on screen). */
  rot: number;
  mirror: boolean;
  /** Valid source region (crop insets), source px. */
  rect: { x: number; y: number; w: number; h: number };
}

export const WB_MIN_K = 2000;
export const WB_MAX_K = 10500;

export function fullEffects(e: Partial<OutputEffects> | null | undefined): OutputEffects {
  return { ...DEFAULT_EFFECTS, ...(e ?? {}) } as OutputEffects;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Geometry for the output: the full ProcAmp transform. */
export function fxGeometry(eIn: Partial<OutputEffects>, sw: number, sh: number, W: number, H: number, auto?: AutoCropView | null): FxGeometry {
  const e = fullEffects(eIn);
  const cl = clamp(num(e.cropLeft, 0), 0, 0.95);
  const cr = clamp(num(e.cropRight, 0), 0, 0.95 - cl);
  const ct = clamp(num(e.cropTop, 0), 0, 0.95);
  const cb = clamp(num(e.cropBottom, 0), 0, 0.95 - ct);
  const rect = { x: cl * sw, y: ct * sh, w: Math.max(1, sw * (1 - cl - cr)), h: Math.max(1, sh * (1 - ct - cb)) };
  const s0 = e.padBlack === false ? Math.max(W / rect.w, H / rect.h) : Math.min(W / rect.w, H / rect.h);
  const zoom = Math.max(0.1, num(e.zoom, 1)) * (auto ? Math.max(1, auto.zoom) : Math.max(0.1, num(e.cropZoom, 1)));
  const scale = s0 * zoom;
  let cx: number;
  let cy: number;
  if (auto) {
    cx = auto.cx * sw;
    cy = auto.cy * sh;
  } else {
    cx = rect.x + rect.w / 2 + num(e.cropPanX, 0) * (rect.w / 2);
    cy = rect.y + rect.h / 2 + num(e.cropPanY, 0) * (rect.h / 2);
  }
  // Legacy pan: moves within the overflow of the zoomed image.
  const lpx = Math.max(0, (rect.w * scale - W) / 2) / scale;
  const lpy = Math.max(0, (rect.h * scale - H) / 2) / scale;
  cx += num(e.panX, 0) * lpx;
  cy += num(e.panY, 0) * lpy;
  return { sw, sh, W, H, cx, cy, scale, rot: (num(e.cropRotation, 0) * Math.PI) / 180, mirror: !!e.mirror, rect };
}

/** Identity "full view" geometry: the whole source fitted into W×H. */
export function fullViewGeometry(sw: number, sh: number, W: number, H: number): FxGeometry {
  return { sw, sh, W, H, cx: sw / 2, cy: sh / 2, scale: Math.min(W / sw, H / sh), rot: 0, mirror: false, rect: { x: 0, y: 0, w: sw, h: sh } };
}

export function outToSrc(g: FxGeometry, x: number, y: number): [number, number] {
  const mx = g.mirror ? g.W - x : x;
  const ux = (mx - g.W / 2) / g.scale;
  const uy = (y - g.H / 2) / g.scale;
  const c = Math.cos(g.rot);
  const s = Math.sin(g.rot);
  return [g.cx + c * ux + s * uy, g.cy - s * ux + c * uy];
}

export function srcToOut(g: FxGeometry, sx: number, sy: number): [number, number] {
  const vx = sx - g.cx;
  const vy = sy - g.cy;
  const c = Math.cos(g.rot);
  const s = Math.sin(g.rot);
  const x = g.W / 2 + (c * vx - s * vy) * g.scale;
  const y = g.H / 2 + (s * vx + c * vy) * g.scale;
  return [g.mirror ? g.W - x : x, y];
}

/** Monotone cubic (Fritsch–Carlson) through the tone-curve points → 256-entry LUT (0..255). */
export function toneLut(points: [number, number][] | undefined): Uint8Array {
  const lut = new Uint8Array(256);
  const p = (points && points.length >= 2 ? points : DEFAULT_EFFECTS.toneCurve!).map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const t = a * a + b * b;
    if (t > 9) {
      const k = 3 / Math.sqrt(t);
      m[i] = k * a * d[i];
      m[i + 1] = k * b * d[i];
    }
  }
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    let y: number;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      let i = 0;
      while (i < n - 2 && x > xs[i + 1]) i++;
      const h = Math.max(1e-6, xs[i + 1] - xs[i]);
      const t = (x - xs[i]) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    }
    lut[v] = Math.round(clamp(y, 0, 1) * 255);
  }
  return lut;
}

export function isIdentityCurve(points: [number, number][] | undefined): boolean {
  return !points || points.every(([x, y]) => Math.abs(x - y) < 1e-3);
}

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uLut;
uniform vec2 uSrcSize;
uniform vec2 uOutSize;
uniform vec2 uCenter;
uniform float uScale;
uniform vec2 uRot;
uniform float uMirror;
uniform vec4 uRect;
uniform float uColor;
uniform float uExposure, uContrast, uSat, uVib, uSharp, uHi, uSh, uVig, uBright, uHue, uUseLut;
uniform vec3 uWB, uLift, uGamma, uGain;
out vec4 o;
vec3 lumaW = vec3(0.2126, 0.7152, 0.0722);
vec3 tap(vec2 sp) { return texture(uTex, sp / uSrcSize).rgb; }
void main() {
  vec2 p = vec2(gl_FragCoord.x, uOutSize.y - gl_FragCoord.y);
  if (uMirror > 0.5) p.x = uOutSize.x - p.x;
  vec2 u = (p - uOutSize * 0.5) / uScale;
  vec2 sp = uCenter + vec2(uRot.x * u.x + uRot.y * u.y, -uRot.y * u.x + uRot.x * u.y);
  if (sp.x < uRect.x || sp.y < uRect.y || sp.x > uRect.x + uRect.z || sp.y > uRect.y + uRect.w) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 c = tap(sp);
  if (uColor < 0.5) { o = vec4(c, 1.0); return; }
  if (uSharp > 0.001) {
    float r = max(1.0, 1.0 / uScale);
    vec3 b = (tap(sp + vec2(r, 0.0)) + tap(sp - vec2(r, 0.0)) + tap(sp + vec2(0.0, r)) + tap(sp - vec2(0.0, r))) * 0.25;
    c = c + (c - b) * uSharp * 2.5;
  }
  c *= exp2(uExposure * 2.0);
  c *= uWB;
  c = uGain * (c + uLift * (1.0 - c));
  c = pow(max(c, 0.0), 1.0 / uGamma);
  c = (c - 0.5) * uContrast + 0.5;
  float l = dot(clamp(c, 0.0, 1.0), lumaW);
  c += uSh * 0.35 * (1.0 - smoothstep(0.0, 0.55, l));
  c += uHi * 0.35 * smoothstep(0.45, 1.0, l);
  c = clamp(c, 0.0, 1.0);
  if (uUseLut > 0.5) c = vec3(texture(uLut, vec2(c.r, 0.5)).r, texture(uLut, vec2(c.g, 0.5)).r, texture(uLut, vec2(c.b, 0.5)).r);
  if (abs(uHue) > 0.001) {
    float cs = cos(uHue), sn = sin(uHue);
    mat3 m = mat3(
      0.213 + cs * 0.787 - sn * 0.213, 0.213 - cs * 0.213 + sn * 0.143, 0.213 - cs * 0.213 - sn * 0.787,
      0.715 - cs * 0.715 - sn * 0.715, 0.715 + cs * 0.285 + sn * 0.140, 0.715 - cs * 0.715 + sn * 0.715,
      0.072 - cs * 0.072 + sn * 0.928, 0.072 - cs * 0.072 - sn * 0.283, 0.072 + cs * 0.928 + sn * 0.072);
    c = clamp(m * c, 0.0, 1.0);
  }
  l = dot(c, lumaW);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float s = uSat * (1.0 + uVib * (1.0 - (mx - mn)));
  c = mix(vec3(l), c, max(s, 0.0));
  c *= uBright;
  if (uVig > 0.001) {
    vec2 q = (vec2(gl_FragCoord.x, gl_FragCoord.y) / uOutSize - 0.5) * vec2(uOutSize.x / uOutSize.y, 1.0);
    float d = length(q) / length(vec2(uOutSize.x / uOutSize.y, 1.0) * 0.5);
    c *= 1.0 - uVig * smoothstep(0.35, 1.0, d);
  }
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

type Canvas = OffscreenCanvas | HTMLCanvasElement;

/** WebGL2 ProcAmp renderer. `render()` draws into `canvas`; callers drawImage() it into their 2D compositor. */
export class FxRenderer {
  readonly canvas: Canvas;
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private lut: WebGLTexture | null = null;
  private lutKey = '';
  private loc = new Map<string, WebGLUniformLocation | null>();
  failed = false;

  constructor(canvas?: Canvas) {
    this.canvas = canvas ?? (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : document.createElement('canvas'));
    this.init();
  }

  private init(): void {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) {
      this.failed = true;
      return;
    }
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
      gl.useProgram(p);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const a = gl.getAttribLocation(p, 'aPos');
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      const mk = (unit: number) => {
        const t = gl.createTexture()!;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this.tex = mk(0);
      this.lut = mk(1);
      gl.uniform1i(gl.getUniformLocation(p, 'uTex'), 0);
      gl.uniform1i(gl.getUniformLocation(p, 'uLut'), 1);
      this.gl = gl;
      this.prog = p;
      if ('addEventListener' in this.canvas) {
        (this.canvas as HTMLCanvasElement).addEventListener('webglcontextlost', () => {
          this.gl = null;
          this.failed = true;
        });
      }
    } catch (err) {
      console.error('FxRenderer init failed', err);
      this.failed = true;
    }
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.loc.has(name)) this.loc.set(name, this.gl!.getUniformLocation(this.prog!, name));
    return this.loc.get(name)!;
  }

  /**
   * Render `src` (sw×sh) into the W×H canvas.
   * `color=false` skips the colour pipeline (bypass); `geometry` overrides the transform (e.g. full view).
   */
  render(src: FxSource, sw: number, sh: number, W: number, H: number, eIn: Partial<OutputEffects>, opts: { color?: boolean; geometry?: FxGeometry; auto?: AutoCropView | null } = {}): boolean {
    const gl = this.gl;
    if (!gl || this.failed || gl.isContextLost()) {
      this.failed = true;
      return false;
    }
    const e = fullEffects(eIn);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch (err) {
      return false;
    }
    const g = opts.geometry ?? fxGeometry(e, sw, sh, W, H, opts.auto);
    gl.uniform2f(this.u('uSrcSize'), sw, sh);
    gl.uniform2f(this.u('uOutSize'), W, H);
    gl.uniform2f(this.u('uCenter'), g.cx, g.cy);
    gl.uniform1f(this.u('uScale'), g.scale);
    gl.uniform2f(this.u('uRot'), Math.cos(g.rot), Math.sin(g.rot));
    gl.uniform1f(this.u('uMirror'), g.mirror ? 1 : 0);
    gl.uniform4f(this.u('uRect'), g.rect.x, g.rect.y, g.rect.w, g.rect.h);
    const color = opts.color !== false;
    gl.uniform1f(this.u('uColor'), color ? 1 : 0);
    // White balance: Kelvin (RE whiteBalanceK) + legacy temperature, plus tint (green ↔ magenta).
    const warm = clamp((num(e.whiteBalanceK, 6500) - 6500) / 4000, -1.2, 1.2) + num(e.temperature, 0);
    const tint = num(e.tint, 0);
    gl.uniform3f(this.u('uWB'), (1 + 0.22 * warm) * (1 + 0.08 * tint), (1 + 0.03 * warm) * (1 - 0.16 * tint), (1 - 0.22 * warm) * (1 + 0.08 * tint));
    gl.uniform3f(this.u('uLift'), num(e.liftR, 0) * 0.25, num(e.liftG, 0) * 0.25, num(e.liftB, 0) * 0.25);
    gl.uniform3f(this.u('uGamma'), Math.pow(2, num(e.gammaR, 0)), Math.pow(2, num(e.gammaG, 0)), Math.pow(2, num(e.gammaB, 0)));
    gl.uniform3f(this.u('uGain'), 1 + num(e.gainR, 0), 1 + num(e.gainG, 0), 1 + num(e.gainB, 0));
    gl.uniform1f(this.u('uExposure'), num(e.exposure, 0));
    gl.uniform1f(this.u('uContrast'), Math.max(0, num(e.contrast, 1)));
    gl.uniform1f(this.u('uSat'), Math.max(0, num(e.saturation, 1)));
    gl.uniform1f(this.u('uVib'), num(e.vibrance, 0));
    gl.uniform1f(this.u('uSharp'), clamp(num(e.sharpness, 0), 0, 1));
    gl.uniform1f(this.u('uHi'), num(e.highlights, 0));
    gl.uniform1f(this.u('uSh'), num(e.shadows, 0));
    gl.uniform1f(this.u('uVig'), clamp(num(e.vignette, 0), 0, 1));
    gl.uniform1f(this.u('uBright'), Math.max(0, num(e.brightness, 1)));
    gl.uniform1f(this.u('uHue'), (num(e.hue, 0) * Math.PI) / 180);
    const ident = isIdentityCurve(e.toneCurve);
    gl.uniform1f(this.u('uUseLut'), ident ? 0 : 1);
    if (!ident) {
      const key = JSON.stringify(e.toneCurve);
      if (key !== this.lutKey) {
        this.lutKey = key;
        const l = toneLut(e.toneCurve);
        const rgba = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = l[i];
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.lut);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }
}
