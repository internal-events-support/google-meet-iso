// WebGPU compositor backend (preferred; falls back to the WebGL2 one in compositor.ts).
//
// Why: WebGL readback ends in getBufferSubData, a synchronous round trip to the GPU process
// that (in one shared context) also waits for every other output's queued work. Profiled at
// ~65% of the Meet page's main thread with 10 × 1080p outputs. WebGPU's mapAsync is truly
// asynchronous: the thread only pays for encoding commands and one memcpy out of the mapping.
//
// Per output frame, one command buffer:
//   importExternalTexture(VideoFrame) ─fx render pass─▶ compose (W×H rgba8, top-down)
//   overlay texture (uploaded only when it changes) ─blend pass─▶ compose
//   compose ─pack compute pass─▶ storage buffer (tightly packed UYVY / BGRA u32s)
//   ─copyBufferToBuffer─▶ MAP_READ ring buffer ─mapAsync─▶ caller's ArrayBuffer
// Loss content (2D canvas) goes straight into compose with copyExternalImageToTexture.
// No DOM or Node APIs: runs in the Meet page or a DedicatedWorker.

import type { OutputEffects } from '../shared/types';
import { fxGeometry, isIdentityCurve, toneLut, type AutoCropView } from '../control/effects/fxgl';
import { registerWebGpu, type Compositor, type OverlaySpec, type PackFormat, type ReadbackResult, type RenderJob, type RenderTarget } from './compositor';

const FX_WGSL = /* wgsl */ `
struct Fx {
  srcSize: vec2f, outSize: vec2f, center: vec2f, rot: vec2f,
  rect: vec4f,
  wb: vec4f, lift: vec4f, gamma: vec4f, gain: vec4f,
  scale: f32, mirror: f32, color: f32, exposure: f32,
  contrast: f32, sat: f32, vib: f32, sharp: f32,
  hi: f32, sh: f32, vig: f32, bright: f32,
  hue: f32, useLut: f32, p0: f32, p1: f32,
};
@group(0) @binding(0) var src: texture_external;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var lut: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: Fx;
const LW = vec3f(0.2126, 0.7152, 0.0722);

fn tap(sp: vec2f) -> vec3f { return textureSampleBaseClampToEdge(src, smp, sp / u.srcSize).rgb; }

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  var p = fc.xy;
  if (u.mirror > 0.5) { p.x = u.outSize.x - p.x; }
  let q = (p - u.outSize * 0.5) / u.scale;
  let sp = u.center + vec2f(u.rot.x * q.x + u.rot.y * q.y, -u.rot.y * q.x + u.rot.x * q.y);
  if (sp.x < u.rect.x || sp.y < u.rect.y || sp.x > u.rect.x + u.rect.z || sp.y > u.rect.y + u.rect.w) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  var c = tap(sp);
  if (u.color < 0.5) { return vec4f(c, 1.0); }
  if (u.sharp > 0.001) {
    let r = max(1.0, 1.0 / u.scale);
    let b = (tap(sp + vec2f(r, 0.0)) + tap(sp - vec2f(r, 0.0)) + tap(sp + vec2f(0.0, r)) + tap(sp - vec2f(0.0, r))) * 0.25;
    c = c + (c - b) * u.sharp * 2.5;
  }
  c *= exp2(u.exposure * 2.0);
  c *= u.wb.xyz;
  c = u.gain.xyz * (c + u.lift.xyz * (1.0 - c));
  c = pow(max(c, vec3f(0.0)), 1.0 / u.gamma.xyz);
  c = (c - 0.5) * u.contrast + 0.5;
  var l = dot(clamp(c, vec3f(0.0), vec3f(1.0)), LW);
  c += u.sh * 0.35 * (1.0 - smoothstep(0.0, 0.55, l));
  c += u.hi * 0.35 * smoothstep(0.45, 1.0, l);
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  if (u.useLut > 0.5) {
    c = vec3f(textureSampleLevel(lut, smp, vec2f(c.r, 0.5), 0.0).r, textureSampleLevel(lut, smp, vec2f(c.g, 0.5), 0.0).r, textureSampleLevel(lut, smp, vec2f(c.b, 0.5), 0.0).r);
  }
  if (abs(u.hue) > 0.001) {
    let cs = cos(u.hue);
    let sn = sin(u.hue);
    let m = mat3x3f(
      0.213 + cs * 0.787 - sn * 0.213, 0.213 - cs * 0.213 + sn * 0.143, 0.213 - cs * 0.213 - sn * 0.787,
      0.715 - cs * 0.715 - sn * 0.715, 0.715 + cs * 0.285 + sn * 0.140, 0.715 - cs * 0.715 + sn * 0.715,
      0.072 - cs * 0.072 + sn * 0.928, 0.072 - cs * 0.072 - sn * 0.283, 0.072 + cs * 0.928 + sn * 0.072);
    c = clamp(m * c, vec3f(0.0), vec3f(1.0));
  }
  l = dot(c, LW);
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let s = u.sat * (1.0 + u.vib * (1.0 - (mx - mn)));
  c = mix(vec3f(l), c, max(s, 0.0));
  c *= u.bright;
  if (u.vig > 0.001) {
    let a = vec2f(u.outSize.x / u.outSize.y, 1.0);
    let d = length((fc.xy / u.outSize - 0.5) * a) / length(a * 0.5);
    c *= 1.0 - u.vig * smoothstep(0.35, 1.0, d);
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}`;

const OVERLAY_WGSL = /* wgsl */ `
@group(0) @binding(0) var ov: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  return textureLoad(ov, vec2i(fc.xy), 0);
}`;

// UYVY: BT.709 limited range at every size (what the NDI 6 runtime assumes, SD included).
const PACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var img: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outb: array<u32>;
@group(0) @binding(2) var<uniform> P: vec4u; // texels per row, rows, mode (0 UYVY, 1 BGRA)
const K = vec3f(0.2126, 0.7152, 0.0722);
@compute @workgroup_size(16, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.x || g.y >= P.y) { return; }
  let o = g.y * P.x + g.x;
  if (P.z == 1u) {
    let c = textureLoad(img, vec2u(g.x, g.y), 0);
    outb[o] = pack4x8unorm(vec4f(c.b, c.g, c.r, c.a));
    return;
  }
  let a = textureLoad(img, vec2u(g.x * 2u, g.y), 0).rgb;
  let b = textureLoad(img, vec2u(g.x * 2u + 1u, g.y), 0).rgb;
  let m = (a + b) * 0.5;
  let ym = dot(m, K);
  let cb = (m.b - ym) / 1.8556;
  let cr = (m.r - ym) / 1.5748;
  outb[o] = pack4x8unorm(clamp(vec4f(128.0 + 224.0 * cb, 16.0 + 219.0 * dot(a, K), 128.0 + 224.0 * cr, 16.0 + 219.0 * dot(b, K)) / 255.0, vec4f(0.0), vec4f(1.0)));
}`;

// WebGPU flag constants (spec values; the TS DOM lib types the API but doesn't declare these).
const GPUBufferUsage = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const GPUTextureUsage = { COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, RENDER_ATTACHMENT: 0x10 } as const;
const GPUMapMode = { READ: 0x1 } as const;

const FX_UNIFORM_BYTES = 176;
const RING = 3;

class GpuCompositor implements Compositor {
  readonly kind = 'webgpu' as const;
  lostFlag = false;
  readonly fxPipe: GPURenderPipeline;
  readonly ovPipe: GPURenderPipeline;
  readonly packPipe: GPUComputePipeline;
  readonly sampler: GPUSampler;
  /** 256×1 tone-curve LUTs by curve JSON (identity when unused). */
  private luts = new Map<string, GPUTexture>();

  constructor(readonly device: GPUDevice) {
    const fx = device.createShaderModule({ code: FX_WGSL });
    const ov = device.createShaderModule({ code: OVERLAY_WGSL });
    const pk = device.createShaderModule({ code: PACK_WGSL });
    this.fxPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: fx, entryPoint: 'vs' },
      fragment: { module: fx, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.ovPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: ov, entryPoint: 'vs' },
      fragment: {
        module: ov,
        entryPoint: 'fs',
        targets: [
          {
            format: 'rgba8unorm',
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.packPipe = device.createComputePipeline({ layout: 'auto', compute: { module: pk, entryPoint: 'main' } });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    void device.lost.then(() => (this.lostFlag = true));
  }

  get lost(): boolean {
    return this.lostFlag;
  }

  lut(curve: [number, number][] | undefined): GPUTexture {
    const key = isIdentityCurve(curve) ? 'id' : JSON.stringify(curve);
    let t = this.luts.get(key);
    if (t) return t;
    if (this.luts.size > 16) {
      for (const v of this.luts.values()) v.destroy();
      this.luts.clear();
    }
    const l = toneLut(key === 'id' ? undefined : curve);
    const rgba = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = l[i];
      rgba[i * 4 + 3] = 255;
    }
    t = this.device.createTexture({ size: [256, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: t }, rgba, { bytesPerRow: 1024 }, [256, 1]);
    this.luts.set(key, t);
    return t;
  }

  createTarget(): RenderTarget {
    return new GpuTarget(this);
  }
}

class GpuTarget implements RenderTarget {
  private device: GPUDevice;
  private compose: GPUTexture | null = null;
  private W = 0;
  private H = 0;
  private fxUniform: GPUBuffer;
  private fxData = new Float32Array(FX_UNIFORM_BYTES / 4);
  private packUniform: GPUBuffer;
  private packed: GPUBuffer | null = null;
  private packedSize = 0;
  private ring: { buf: GPUBuffer; size: number; busy: boolean }[] = [];
  private overlayTex: GPUTexture | null = null;
  private overlayCanvas: OffscreenCanvas | null = null;
  private overlayKey = '';
  private hasOverlay = false;
  private recCanvas: OffscreenCanvas | null = null;
  private recCtx: GPUCanvasContext | null = null;
  private disposed = false;

  constructor(private c: GpuCompositor) {
    this.device = c.device;
    this.fxUniform = this.device.createBuffer({ size: FX_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.packUniform = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  get lost(): boolean {
    return this.c.lost;
  }

  get busy(): boolean {
    return this.ring.length >= RING && this.ring.every((r) => r.busy);
  }

  private ensureCompose(W: number, H: number): GPUTexture {
    if (!this.compose || this.W !== W || this.H !== H) {
      this.compose?.destroy();
      this.compose = this.device.createTexture({
        size: [W, H],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      this.W = W;
      this.H = H;
    }
    return this.compose;
  }

  private writeFx(frame: VideoFrame, W: number, H: number, e: OutputEffects, auto: AutoCropView | null): void {
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    const g = fxGeometry(e, sw, sh, W, H, auto);
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    const warm = clamp((num(e.whiteBalanceK, 6500) - 6500) / 4000, -1.2, 1.2) + num(e.temperature, 0);
    const tint = num(e.tint, 0);
    const d = this.fxData;
    d.set([sw, sh, W, H, g.cx, g.cy, Math.cos(g.rot), Math.sin(g.rot)], 0);
    d.set([g.rect.x, g.rect.y, g.rect.w, g.rect.h], 8);
    d.set([(1 + 0.22 * warm) * (1 + 0.08 * tint), (1 + 0.03 * warm) * (1 - 0.16 * tint), (1 - 0.22 * warm) * (1 + 0.08 * tint), 0], 12);
    d.set([num(e.liftR, 0) * 0.25, num(e.liftG, 0) * 0.25, num(e.liftB, 0) * 0.25, 0], 16);
    d.set([Math.pow(2, num(e.gammaR, 0)), Math.pow(2, num(e.gammaG, 0)), Math.pow(2, num(e.gammaB, 0)), 0], 20);
    d.set([1 + num(e.gainR, 0), 1 + num(e.gainG, 0), 1 + num(e.gainB, 0), 0], 24);
    d.set(
      [
        g.scale,
        g.mirror ? 1 : 0,
        1,
        num(e.exposure, 0),
        Math.max(0, num(e.contrast, 1)),
        Math.max(0, num(e.saturation, 1)),
        num(e.vibrance, 0),
        clamp(num(e.sharpness, 0), 0, 1),
        num(e.highlights, 0),
        num(e.shadows, 0),
        clamp(num(e.vignette, 0), 0, 1),
        Math.max(0, num(e.brightness, 1)),
        (num(e.hue, 0) * Math.PI) / 180,
        isIdentityCurve(e.toneCurve) ? 0 : 1,
        0,
        0,
      ],
      28,
    );
    this.device.queue.writeBuffer(this.fxUniform, 0, d);
  }

  private updateOverlay(spec: OverlaySpec | null, W: number, H: number): void {
    if (!spec?.draw) {
      this.hasOverlay = false;
      this.overlayKey = '';
      return;
    }
    const k = `${W}x${H}:${spec.key}`;
    if (k === this.overlayKey) return;
    this.overlayKey = k;
    if (!this.overlayCanvas || this.overlayCanvas.width !== W || this.overlayCanvas.height !== H) this.overlayCanvas = new OffscreenCanvas(W, H);
    const ctx = this.overlayCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.clearRect(0, 0, W, H);
    this.hasOverlay = spec.draw(ctx);
    if (!this.hasOverlay) return;
    if (!this.overlayTex || this.overlayTex.width !== W || this.overlayTex.height !== H) {
      this.overlayTex?.destroy();
      this.overlayTex = this.device.createTexture({
        size: [W, H],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    this.device.queue.copyExternalImageToTexture({ source: this.overlayCanvas }, { texture: this.overlayTex, premultipliedAlpha: false }, [W, H]);
  }

  render(job: RenderJob, W: number, H: number, overlay: OverlaySpec | null, fmt: PackFormat, dst?: (size: number) => ArrayBuffer | null): Promise<ReadbackResult | null> | null {
    if (this.lost || this.disposed || this.busy) return null;
    const t0 = performance.now();
    const dev = this.device;
    if (fmt === 'UYVY' && W % 2) fmt = 'BGRA';
    const tw = fmt === 'UYVY' ? W / 2 : W;
    const size = tw * 4 * H;
    const enc = dev.createCommandEncoder();
    if (job.kind === 'source') {
      const compose = this.ensureCompose(W, H);
      let ext: GPUExternalTexture;
      try {
        ext = dev.importExternalTexture({ source: job.frame });
      } catch {
        return null;
      }
      this.writeFx(job.frame, W, H, job.e, job.auto);
      const bg = dev.createBindGroup({
        layout: this.c.fxPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: ext },
          { binding: 1, resource: this.c.sampler },
          { binding: 2, resource: this.c.lut(job.e.toneCurve).createView() },
          { binding: 3, resource: { buffer: this.fxUniform } },
        ],
      });
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: compose.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      pass.setPipeline(this.c.fxPipe);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
      this.updateOverlay(overlay, W, H);
      if (this.hasOverlay && this.overlayTex) {
        const obg = dev.createBindGroup({ layout: this.c.ovPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.overlayTex.createView() }] });
        const op = enc.beginRenderPass({ colorAttachments: [{ view: compose.createView(), loadOp: 'load', storeOp: 'store' }] });
        op.setPipeline(this.c.ovPipe);
        op.setBindGroup(0, obg);
        op.draw(3);
        op.end();
      }
    } else if (job.kind === 'image') {
      const compose = this.ensureCompose(W, H);
      dev.queue.copyExternalImageToTexture({ source: job.src }, { texture: compose, premultipliedAlpha: false }, [W, H]);
    } else if (!this.compose || this.W !== W || this.H !== H) return null;
    // pack
    if (!this.packed || this.packedSize !== size) {
      this.packed?.destroy();
      this.packed = dev.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this.packedSize = size;
    }
    dev.queue.writeBuffer(this.packUniform, 0, new Uint32Array([tw, H, fmt === 'UYVY' ? 0 : 1, 0]));
    const pbg = dev.createBindGroup({
      layout: this.c.packPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.compose!.createView() },
        { binding: 1, resource: { buffer: this.packed } },
        { binding: 2, resource: { buffer: this.packUniform } },
      ],
    });
    const cp = enc.beginComputePass();
    cp.setPipeline(this.c.packPipe);
    cp.setBindGroup(0, pbg);
    cp.dispatchWorkgroups(Math.ceil(tw / 16), Math.ceil(H / 8));
    cp.end();
    let slot = this.ring.find((r) => !r.busy && r.size === size);
    if (!slot) {
      const stale = this.ring.findIndex((r) => !r.busy);
      if (stale >= 0) {
        this.ring[stale].buf.destroy();
        this.ring.splice(stale, 1);
      }
      slot = { buf: dev.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), size, busy: false };
      this.ring.push(slot);
    }
    enc.copyBufferToBuffer(this.packed, 0, slot.buf, 0, size);
    dev.queue.submit([enc.finish()]);
    slot.busy = true;
    const issueMs = performance.now() - t0;
    const s = slot;
    return s.buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const c0 = performance.now();
        let out = dst?.(size) ?? null;
        if (!out || out.byteLength !== size) out = new ArrayBuffer(size);
        new Uint8Array(out).set(new Uint8Array(s.buf.getMappedRange()));
        s.buf.unmap();
        s.busy = false;
        return { buf: out, fmt, width: W, height: H, stride: tw * 4, cpuMs: issueMs + performance.now() - c0 };
      },
      () => {
        s.busy = false;
        return null;
      },
    );
  }

  videoFrame(timestamp: number): VideoFrame | null {
    if (!this.compose || this.lost) return null;
    try {
      if (!this.recCanvas || this.recCanvas.width !== this.W || this.recCanvas.height !== this.H) {
        this.recCanvas = new OffscreenCanvas(this.W, this.H);
        this.recCtx = this.recCanvas.getContext('webgpu') as GPUCanvasContext;
        this.recCtx.configure({ device: this.device, format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT, alphaMode: 'opaque' });
      }
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToTexture({ texture: this.compose }, { texture: this.recCtx!.getCurrentTexture() }, [this.W, this.H]);
      this.device.queue.submit([enc.finish()]);
      return new VideoFrame(this.recCanvas, { timestamp });
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.compose?.destroy();
    this.overlayTex?.destroy();
    this.packed?.destroy();
    this.fxUniform.destroy();
    this.packUniform.destroy();
    for (const r of this.ring) if (!r.busy) r.buf.destroy();
  }
}

// ---- factory: one device per realm, created asynchronously; recreated after a device loss ----
let state: 'idle' | 'pending' | 'ready' | 'unavailable' = 'idle';
let inst: GpuCompositor | null = null;
/** Devices lost so far (diagnostics). */
export const gpuStats = { lost: 0 };

async function init(): Promise<void> {
  state = 'pending';
  try {
    const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
    const env = (globalThis as { __gmeetIsoEnv?: Record<string, string> }).__gmeetIsoEnv ?? (typeof process !== 'undefined' ? process.env : {});
    if (!gpu || env.GMEET_ISO_WEBGPU === '0') throw new Error('no WebGPU');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no adapter');
    const device = await adapter.requestDevice();
    inst = new GpuCompositor(device);
    state = 'ready';
  } catch {
    inst = null;
    state = 'unavailable';
  }
}

/** Start initialising WebGPU (idempotent) and register it as the preferred compositor. */
export function initWebGpu(): void {
  if (state === 'idle') void init();
  registerWebGpu({
    state: () => (state === 'idle' ? 'pending' : state === 'ready' || state === 'pending' ? state : 'unavailable'),
    get: () => {
      if (inst && inst.lost) {
        gpuStats.lost++;
        inst = null;
        void init();
        return null;
      }
      return inst;
    },
  });
}
