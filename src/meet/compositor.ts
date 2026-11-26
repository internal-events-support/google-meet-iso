// Shared WebGL2 compositor for every output in this realm (the Meet page, or the render worker).
//
// Chromium allows only ~16 live WebGL contexts per renderer, and Meet uses some itself. Before,
// every canvas output had two (effects + readback) and copied each frame between them through a
// 2D canvas, so ~8 outputs started losing contexts. Now there is ONE context; each output is a
// GlTarget that owns only textures/framebuffers/PBOs in it:
//
//   VideoFrame ──FxProgram──▶ compose FBO (W×H RGBA, bottom-up like a canvas)
//   overlay 2D canvas ──(uploaded only when the name tag / images change)──▶ blended on top
//   loss content (2D canvas, drawn only when it changes) ──▶ blitted into compose
//   compose ──pack pass (UYVY 4:2:2 BT.709 limited, or BGRA for alpha)──▶ PBO ──fence──▶ CPU
//
// Readbacks are asynchronous (fence + one shared poll loop), so the thread never stalls on the GPU.
// No DOM or Node APIs: this runs in a DedicatedWorker too.

import type { OutputEffects } from '../shared/types';
import { FxProgram, type AutoCropView } from '../control/effects/fxgl';

export type PackFormat = 'UYVY' | 'BGRA';

export interface ReadbackResult {
  buf: ArrayBuffer;
  fmt: PackFormat;
  width: number;
  height: number;
  stride: number;
  /** Thread ms spent on this frame (issue + final copy). */
  cpuMs: number;
}

/** What a target renders before packing: a source frame with effects, top-down loss content, or nothing new. */
export type RenderJob =
  | { kind: 'source'; frame: VideoFrame; e: OutputEffects; auto: AutoCropView | null }
  | { kind: 'image'; src: OffscreenCanvas }
  | { kind: 'repeat' };

/** Name tag / image overlay layer: `draw` paints a transparent W×H canvas; it runs only when `key` changes. */
export interface OverlaySpec {
  key: string;
  draw: ((ctx: OffscreenCanvasRenderingContext2D) => boolean) | null;
}

/** One output's surfaces in a shared compositor (WebGPU or WebGL2). */
export interface RenderTarget {
  readonly lost: boolean;
  /** No free readback slot: rendering now would have nowhere to go. */
  readonly busy: boolean;
  /**
   * Render `job` at W×H, blend `overlay` (source jobs), pack to `fmt` and read it back
   * asynchronously. `dst(size)` may supply the destination buffer. Null when busy/lost.
   */
  render(job: RenderJob, W: number, H: number, overlay: OverlaySpec | null, fmt: PackFormat, dst?: (size: number) => ArrayBuffer | null): Promise<ReadbackResult | null> | null;
  /** The last composed frame as a VideoFrame (MP4 recorder). */
  videoFrame(timestamp: number): VideoFrame | null;
  dispose(): void;
}

export interface Compositor {
  readonly kind: 'webgpu' | 'webgl';
  readonly lost: boolean;
  createTarget(): RenderTarget;
}

type GpuFactory = { state(): 'pending' | 'ready' | 'unavailable'; get(): Compositor | null };
let gpuFactory: GpuFactory | null = null;
/** Registered by gpucompositor.ts (kept separate so the WebGL path has no WebGPU dependency). */
export function registerWebGpu(f: GpuFactory): void {
  gpuFactory = f;
}

/**
 * The shared compositor: WebGPU when available (async readback never blocks the thread),
 * else WebGL2. Undefined while WebGPU is still initialising (callers retry shortly);
 * null when neither is available (2D canvas fallback).
 */
export function getCompositor(): Compositor | null | undefined {
  if (gpuFactory) {
    const st = gpuFactory.state();
    if (st === 'pending') return undefined;
    if (st === 'ready') {
      const c = gpuFactory.get();
      if (c) return c;
      if (gpuFactory.state() === 'pending') return undefined;
    }
  }
  return GlCompositor.get();
}

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Compose is bottom-up; NDI wants top-down rows, so output row y reads compose row H-1-y.
const PACK_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform int u_mode;   // 0 = UYVY, 1 = BGRA
uniform int u_h;
uniform vec3 u_k;     // Kr, Kg, Kb
uniform vec2 u_den;   // 2(1-Kb), 2(1-Kr)
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int sy = u_h - 1 - p.y;
  if (u_mode == 1) {
    vec4 c = texelFetch(u_tex, ivec2(p.x, sy), 0);
    o = vec4(c.b, c.g, c.r, c.a);
    return;
  }
  vec3 a = texelFetch(u_tex, ivec2(p.x * 2, sy), 0).rgb;
  vec3 b = texelFetch(u_tex, ivec2(p.x * 2 + 1, sy), 0).rgb;
  float ya = dot(a, u_k);
  float yb = dot(b, u_k);
  vec3 m = (a + b) * 0.5;
  float ym = dot(m, u_k);
  float cb = (m.b - ym) / u_den.x;
  float cr = (m.r - ym) / u_den.y;
  o = clamp(vec4(128.0 + 224.0 * cb, 16.0 + 219.0 * ya, 128.0 + 224.0 * cr, 16.0 + 219.0 * yb) / 255.0, 0.0, 1.0);
}`;

// Same-size copy. u_flip = 1: the source is top-down (an uploaded 2D canvas).
const BLIT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform int u_flip;
uniform int u_h;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (u_flip == 1) p.y = u_h - 1 - p.y;
  o = texelFetch(u_tex, p, 0);
}`;

function compile(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const sh = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  return p;
}

function texture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** Texture + framebuffer pair, (re)allocated on size change. */
class Surface {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w = 0;
  h = 0;
  constructor(private gl: WebGL2RenderingContext) {
    this.tex = texture(gl);
    this.fbo = gl.createFramebuffer()!;
  }
  ensure(w: number, h: number): void {
    if (this.w === w && this.h === h) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    this.w = w;
    this.h = h;
  }
  dispose(): void {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteFramebuffer(this.fbo);
  }
}

interface Slot {
  pbo: WebGLBuffer;
  size: number;
  sync: WebGLSync | null;
  fmt: PackFormat;
  width: number;
  height: number;
  stride: number;
  cpuMs: number;
}

export class GlCompositor implements Compositor {
  readonly kind = 'webgl' as const;
  private static inst: GlCompositor | null = null;
  private static retryAt = 0;
  /** Contexts lost so far (diagnostics). */
  static lostCount = 0;

  readonly canvas = new OffscreenCanvas(16, 16);
  readonly gl: WebGL2RenderingContext;
  readonly fx: FxProgram;
  private pack: WebGLProgram;
  private blit: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private lostFlag = false;
  private waiters = new Set<() => boolean>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  /** The shared compositor, created on first use (null when WebGL2 is unavailable). */
  static get(): GlCompositor | null {
    const cur = GlCompositor.inst;
    if (cur && !cur.lost) return cur;
    if (cur) {
      GlCompositor.inst = null;
      GlCompositor.lostCount++;
    }
    if (performance.now() < GlCompositor.retryAt) return null;
    try {
      GlCompositor.inst = new GlCompositor();
    } catch {
      GlCompositor.retryAt = performance.now() + 5000;
    }
    return GlCompositor.inst;
  }

  private constructor() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    this.fx = new FxProgram(gl);
    this.pack = compile(gl, PACK_FS);
    this.blit = compile(gl, BLIT_FS);
    this.vao = gl.createVertexArray()!;
    for (const [p, names] of [
      [this.pack, ['u_tex', 'u_mode', 'u_h', 'u_k', 'u_den']],
      [this.blit, ['u_tex', 'u_flip', 'u_h']],
    ] as const) {
      for (const n of names) this.u[`${p === this.pack ? 'p' : 'b'}.${n}`] = gl.getUniformLocation(p, n);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    this.canvas.addEventListener('webglcontextlost', () => (this.lostFlag = true));
  }

  createTarget(): RenderTarget {
    return new GlTarget(this);
  }

  get lost(): boolean {
    return this.lostFlag || this.gl.isContextLost();
  }

  /** Draw `tex` (same size as the bound framebuffer) with the blit program. */
  drawBlit(tex: WebGLTexture, w: number, h: number, flip: boolean, blend: boolean): void {
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.blit);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.u['b.u_tex'], 0);
    gl.uniform1i(this.u['b.u_flip'], flip ? 1 : 0);
    gl.uniform1i(this.u['b.u_h'], h);
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /** Pack `tex` (W×H compose) into the bound framebuffer (W/2×H for UYVY, W×H for BGRA). */
  drawPack(tex: WebGLTexture, tw: number, h: number, fmt: PackFormat): void {
    const gl = this.gl;
    gl.viewport(0, 0, tw, h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pack);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.u['p.u_tex'], 0);
    gl.uniform1i(this.u['p.u_mode'], fmt === 'UYVY' ? 0 : 1);
    gl.uniform1i(this.u['p.u_h'], h);
    // BT.709 limited range at every size: the NDI 6 runtime decodes UYVY as BT.709 even
    // for SD (verified at 640x480 and 720x576 — BT.601 there turned 75% green into 162).
    const kr = 0.2126;
    const kb = 0.0722;
    gl.uniform3f(this.u['p.u_k'], kr, 1 - kr - kb, kb);
    gl.uniform2f(this.u['p.u_den'], 2 * (1 - kb), 2 * (1 - kr));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /**
   * Run `check` from a later task until it returns true. One poll loop serves every output
   * (fences only signal across task boundaries).
   */
  whenReady(check: () => boolean): void {
    this.waiters.add(check);
    if (!this.pollTimer) this.pollTimer = setTimeout(() => this.pollAll(), 1);
  }

  private pollAll(): void {
    this.pollTimer = null;
    for (const w of [...this.waiters]) {
      let done = true;
      try {
        done = w();
      } catch {
        done = true;
      }
      if (done) this.waiters.delete(w);
    }
    if (this.waiters.size) this.pollTimer = setTimeout(() => this.pollAll(), 1);
  }
}

/** One output's surfaces inside the shared compositor. */
export class GlTarget implements RenderTarget {
  readonly c: GlCompositor;
  private gl: WebGL2RenderingContext;
  private compose: Surface;
  private packed: Surface;
  private upload: WebGLTexture;
  private overlayTex: WebGLTexture;
  private overlayCanvas: OffscreenCanvas | null = null;
  private overlayKey = '';
  private hasOverlay = false;
  private slots: Slot[] = [];
  private queue: Slot[] = [];
  private out: ArrayBuffer | null = null;
  W = 0;
  H = 0;

  constructor(c: GlCompositor) {
    this.c = c;
    const gl = (this.gl = c.gl);
    this.compose = new Surface(gl);
    this.packed = new Surface(gl);
    this.upload = texture(gl);
    this.overlayTex = texture(gl);
    for (let i = 0; i < 2; i++) this.slots.push({ pbo: gl.createBuffer()!, size: 0, sync: null, fmt: 'UYVY', width: 0, height: 0, stride: 0, cpuMs: 0 });
  }

  get lost(): boolean {
    return this.c.lost;
  }

  /** Frames converted but not yet collected. */
  get pending(): number {
    return this.queue.length;
  }

  /** Both readback slots busy: rendering now would have nowhere to go. */
  get busy(): boolean {
    return this.slots.every((s) => !!s.sync);
  }

  private bindCompose(W: number, H: number): void {
    this.compose.ensure(W, H);
    this.W = W;
    this.H = H;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.compose.fbo);
  }

  /** Effects-render a source frame into the compose surface. */
  drawSource(src: TexImageSource, sw: number, sh: number, W: number, H: number, e: Partial<OutputEffects>, auto: AutoCropView | null): boolean {
    this.bindCompose(W, H);
    return this.c.fx.render(src, sw, sh, W, H, e, { auto });
  }

  /** Copy a top-down image (a 2D canvas with loss content) into the compose surface. */
  drawImage(src: TexImageSource, W: number, H: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.upload);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.bindCompose(W, H);
    this.c.drawBlit(this.upload, W, H, true, false);
  }

  /**
   * Overlay layer (name tag, images). `draw` paints it on a transparent W×H 2D canvas and
   * returns whether anything was drawn; it only runs when `key` changes.
   */
  setOverlay(key: string, W: number, H: number, draw: ((ctx: OffscreenCanvasRenderingContext2D) => boolean) | null): void {
    if (!draw) {
      this.hasOverlay = false;
      this.overlayKey = '';
      this.overlayCanvas = null;
      return;
    }
    const k = `${W}x${H}:${key}`;
    if (k === this.overlayKey) return;
    this.overlayKey = k;
    if (!this.overlayCanvas || this.overlayCanvas.width !== W || this.overlayCanvas.height !== H) this.overlayCanvas = new OffscreenCanvas(W, H);
    const ctx = this.overlayCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.clearRect(0, 0, W, H);
    this.hasOverlay = draw(ctx);
    if (!this.hasOverlay) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.overlayCanvas);
  }

  /** Blend the current overlay layer over the compose surface. */
  applyOverlay(): void {
    if (!this.hasOverlay || !this.W) return;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.compose.fbo);
    this.c.drawBlit(this.overlayTex, this.W, this.H, true, true);
  }

  /** Pack the compose surface and start an async readback. False if both slots are busy. */
  startReadback(fmt: PackFormat): boolean {
    if (this.lost || !this.W) return false;
    const slot = this.slots.find((s) => !s.sync);
    if (!slot) return false;
    const t0 = performance.now();
    const gl = this.gl;
    const W = this.W;
    const H = this.H;
    if (fmt === 'UYVY' && W % 2) fmt = 'BGRA';
    const tw = fmt === 'UYVY' ? W / 2 : W;
    this.packed.ensure(tw, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.packed.fbo);
    this.c.drawPack(this.compose.tex, tw, H, fmt);
    const size = tw * 4 * H;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    if (slot.size !== size) {
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
      slot.size = size;
    }
    gl.readPixels(0, 0, tw, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    slot.fmt = fmt;
    slot.width = W;
    slot.height = H;
    slot.stride = tw * 4;
    slot.cpuMs = performance.now() - t0;
    this.queue.push(slot);
    return true;
  }

  /**
   * Oldest finished readback, or null if it isn't ready yet. Reads into `dst` when it is the
   * right size (caller-owned buffer); otherwise into an internal buffer reused by the next poll.
   */
  poll(dst?: ArrayBuffer | null): ReadbackResult | null {
    const slot = this.queue[0];
    if (!slot?.sync) return null;
    const gl = this.gl;
    const st = gl.clientWaitSync(slot.sync, 0, 0);
    if (st === gl.TIMEOUT_EXPIRED) return null;
    const t0 = performance.now();
    this.queue.shift();
    gl.deleteSync(slot.sync);
    slot.sync = null;
    if (st === gl.WAIT_FAILED) return null;
    let buf: ArrayBuffer;
    if (dst && dst.byteLength === slot.size) buf = dst;
    else {
      if (!this.out || this.out.byteLength !== slot.size) this.out = new ArrayBuffer(slot.size);
      buf = this.out;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, new Uint8Array(buf));
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return { buf, fmt: slot.fmt, width: slot.width, height: slot.height, stride: slot.stride, cpuMs: slot.cpuMs + performance.now() - t0 };
  }

  render(job: RenderJob, W: number, H: number, overlay: OverlaySpec | null, fmt: PackFormat, dst?: (size: number) => ArrayBuffer | null): Promise<ReadbackResult | null> | null {
    if (this.lost || this.busy) return null;
    if (job.kind === 'source') {
      if (!this.drawSource(job.frame, job.frame.displayWidth, job.frame.displayHeight, W, H, job.e, job.auto)) return null;
      this.setOverlay(overlay?.key ?? '', W, H, overlay?.draw ?? null);
      this.applyOverlay();
    } else if (job.kind === 'image') this.drawImage(job.src, W, H);
    else if (!this.W) return null;
    if (!this.startReadback(fmt)) return null;
    const size = this.readbackSize(fmt);
    return new Promise((resolve) => {
      this.c.whenReady(() => {
        let r: ReadbackResult | null;
        try {
          r = this.poll(dst?.(size));
        } catch {
          resolve(null);
          return true;
        }
        if (r) {
          resolve(r);
          return true;
        }
        if (this.pending && !this.lost) return false;
        resolve(null);
        return true;
      });
    });
  }

  /** Byte size the next readback of the current compose surface will need. */
  readbackSize(fmt: PackFormat): number {
    const f = fmt === 'UYVY' && this.W % 2 ? 'BGRA' : fmt;
    return (f === 'UYVY' ? this.W / 2 : this.W) * 4 * this.H;
  }

  /** The compose surface as a VideoFrame (for the MP4 recorder). */
  videoFrame(timestamp: number): VideoFrame | null {
    if (!this.W || this.lost) return null;
    const cv = this.c.canvas;
    if (cv.width !== this.W || cv.height !== this.H) {
      cv.width = this.W;
      cv.height = this.H;
    }
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.c.drawBlit(this.compose.tex, this.W, this.H, false, false);
    try {
      return new VideoFrame(cv, { timestamp });
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.lost) return;
    const gl = this.gl;
    for (const s of this.slots) {
      if (s.sync) gl.deleteSync(s.sync);
      gl.deleteBuffer(s.pbo);
    }
    this.queue = [];
    this.compose.dispose();
    this.packed.dispose();
    gl.deleteTexture(this.upload);
    gl.deleteTexture(this.overlayTex);
  }
}

/**
 * Downscale a packed readback (UYVY BT.709 limited, or BGRA) to an RGBA thumbnail on the CPU,
 * so previews need no extra GPU readback. Nearest-neighbour; ~0.3 ms for 320×180.
 */
export function packedToRgba(r: ReadbackResult, tw: number, th: number, out: Uint8ClampedArray): void {
  const src = new Uint8Array(r.buf);
  const W = r.width;
  const H = r.height;
  let o = 0;
  for (let ty = 0; ty < th; ty++) {
    const row = Math.min(H - 1, Math.floor(((ty + 0.5) * H) / th)) * r.stride;
    for (let tx = 0; tx < tw; tx++) {
      const x = Math.min(W - 1, Math.floor(((tx + 0.5) * W) / tw));
      if (r.fmt === 'BGRA') {
        const i = row + x * 4;
        out[o] = src[i + 2];
        out[o + 1] = src[i + 1];
        out[o + 2] = src[i];
        out[o + 3] = 255;
      } else {
        const i = row + (x >> 1) * 4;
        const y = 1.164384 * (src[i + (x & 1 ? 3 : 1)] - 16);
        const u = src[i] - 128;
        const v = src[i + 2] - 128;
        out[o] = y + 1.792741 * v;
        out[o + 1] = y - 0.213249 * u - 0.532909 * v;
        out[o + 2] = y + 2.112402 * u;
        out[o + 3] = 255;
      }
      o += 4;
    }
  }
}
