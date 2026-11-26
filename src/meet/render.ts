// Per-output video renderer. Runs in the render worker (or in the Meet page when workers are
// unavailable): no DOM, Node or native APIs. Everything it produces goes through RenderHost.
//
// Two render paths:
//   - passthrough (format = native, no effects): copy Meet's decoded frames as-is (I420/NV12)
//   - canvas (fixed format and/or effects): render on the shared GPU compositor (WebGPU, else
//     WebGL2; 2D canvas fallback) only when the content changes (new source frame, config/effects,
//     loss change), pack to UYVY on the GPU and read it back asynchronously (BGRA when alpha is
//     needed). The native sender's cadence clock emits at exactly the configured rate,
//     repeating the last frame.
// When the source has no video, the output renders its loss mode (black/freeze/transparent/
// image/testcard/profilePicture) so downstream switchers always see a stable signal, after
// the global video-loss delay (hold the last frame until then).

import type { EngineState, GlobalVideoLossSettings, OutputConfig, OutputEffects, VideoLossSettings } from '../shared/types';
import { DEFAULT_EFFECTS, DEFAULT_VIDEO_LOSS, VIDEO_LOSS_DELAY_MS } from '../shared/types';
import { fullEffects, isIdentityCurve } from '../control/effects/fxgl';
import { drawOverlays } from '../control/effects/overlays';
import { AutoCropTracker, autoCropSupported } from '../control/effects/autocrop';
import { getCompositor, type OverlaySpec, type PackFormat, type ReadbackResult, type RenderJob, type RenderTarget } from './compositor';
import { PackedThumbnailer, Thumbnailer } from './thumbs';

export const LOSS_FPS = 10;
/** Canvas outputs: housekeeping rate for loss/effects changes (source frames render on arrival). */
const HOUSEKEEPING_HZ = 20;
/** Renders per output allowed in flight on the GPU at once. */
const MAX_GPU_INFLIGHT = 2;

/** Numeric ProcAmp fields that are neutral at their DEFAULT_EFFECTS value. */
const NEUTRAL_KEYS: (keyof OutputEffects)[] = [
  'brightness', 'contrast', 'saturation', 'hue', 'zoom', 'panX', 'panY',
  'exposure', 'vibrance', 'sharpness', 'temperature', 'tint', 'highlights', 'shadows', 'vignette',
  'liftR', 'liftG', 'liftB', 'gammaR', 'gammaG', 'gammaB', 'gainR', 'gainG', 'gainB',
  'cropLeft', 'cropRight', 'cropTop', 'cropBottom', 'whiteBalanceK', 'cropZoom', 'cropPanX', 'cropPanY', 'cropRotation',
];

export function effectsActive(cfg: OutputConfig): boolean {
  const e = fullEffects(cfg.effects);
  for (const k of NEUTRAL_KEYS) {
    const v = e[k] as number | undefined;
    const d = DEFAULT_EFFECTS[k] as number | undefined;
    if (typeof v === 'number' && typeof d === 'number' && Math.abs(v - d) > 1e-6) return true;
  }
  return (
    e.mirror ||
    e.nameTag ||
    (e.padBlack === false && !!cfg.format) ||
    !isIdentityCurve(e.toneCurve) ||
    (e.images ?? []).some((i) => i.visible) ||
    (!!cfg.autoCropEnabled && autoCropSupported())
  );
}

/** Fixed format, or effects that need the canvas path (else Meet's frames pass through untouched). */
export function isCanvasMode(cfg: OutputConfig): boolean {
  return !!cfg.format || effectsActive(cfg);
}

export function outFormatOf(cfg: OutputConfig): { width: number; height: number; fpsN: number; fpsD: number } {
  return cfg.format ?? { width: 1280, height: 720, fpsN: 30000, fpsD: 1001 };
}

/** Meet avatars (profilePicture loss mode): fetched once per URL into an untainted bitmap. */
const avatarCache = new Map<string, ImageBitmap | null | 'loading'>();
function avatarFor(url: string): ImageBitmap | null {
  const hit = avatarCache.get(url);
  if (hit === undefined) {
    avatarCache.set(url, 'loading');
    void (async () => {
      try {
        const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!r.ok) throw new Error(String(r.status));
        avatarCache.set(url, await createImageBitmap(await r.blob()));
      } catch {
        avatarCache.set(url, null);
      }
    })();
    return null;
  }
  return hit === 'loading' ? null : hit;
}

function initialsOf(name: string): string {
  const parts = name.replace(/\(.*?\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const a = parts[0][0] ?? '';
  const b = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (a + b).toUpperCase();
}

/** Stable per-name colour (Meet-like palette) for initials when not overridden. */
function colourFor(name: string): string {
  const pal = ['#1a73e8', '#e8710a', '#188038', '#d93025', '#9334e6', '#12b5cb', '#e52592', '#f9ab00', '#5f6368', '#a142f4'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return pal[h % pal.length];
}

/** Latest frame of a source, as kept by the engine. */
export interface SourceFrame {
  frame: VideoFrame;
  /** performance.now() of this realm when it arrived. */
  at: number;
  lastFrameAt: number;
  width: number;
  height: number;
}

/** Everything a renderer needs from its realm (the engine core). */
export interface RenderHost {
  /** Hand a packed frame to the output's NDI sender (ownership moves; it comes back via returnBuffers). */
  submit(id: string, buf: ArrayBuffer, w: number, h: number, fmt: string, stride: number, fpsN?: number, fpsD?: number): void;
  /** Passthrough: native clock repeats the last frame (freeze / static loss content) or not. */
  setPassCadence(id: string, on: boolean): void;
  preview(key: string, jpeg: ArrayBuffer): void;
  /** MP4 recorder frame (ownership moves to the host). */
  record(id: string, frame: VideoFrame, w: number, h: number): void;
  log(s: string): void;
  /** Decoded overlay / loss image (null while loading or missing; the host loads it). */
  image(path: string): ImageBitmap | null;
  wantsPreview(key: string): boolean;
  source(id: string): SourceFrame | undefined;
}

/** Per-output settings from the main side. */
export interface RenderConfig {
  cfg: OutputConfig;
  engine: EngineState;
  sourceName: string;
  /** Meet avatar of the routed participant (profilePicture loss mode). */
  avatarUrl: string;
  previewFps: number;
  videoLoss: GlobalVideoLossSettings | null;
  recording: boolean;
  /** The NDI sender exists (otherwise nothing is rendered). */
  senderReady: boolean;
}

export interface RenderStats {
  outW: number;
  outH: number;
  latencyMs: number;
  cycleMs: number;
  /** Frames handed to NDI in the last second (passthrough; clocked outputs report native counts). */
  outFps: number;
  /** Live (or holding the last frame inside the loss delay). */
  live: boolean;
}

/** Frame buffers given back by the native sender, reused so steady state allocates nothing. */
class FramePool {
  private free = new Map<number, ArrayBuffer[]>();
  take(size: number): ArrayBuffer {
    return this.free.get(size)?.pop() ?? new ArrayBuffer(size);
  }
  give(bufs: ArrayBuffer[] | undefined): void {
    for (const b of bufs ?? []) {
      if (!b.byteLength) continue;
      const list = this.free.get(b.byteLength) ?? [];
      if (list.length < 3) list.push(b);
      this.free.set(b.byteLength, list);
    }
  }
}

export class OutputRenderer {
  private rc: RenderConfig;
  private sourceId: string | null = null;

  // canvas path
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private timer: ReturnType<typeof setInterval> | 0 = 0;
  /** 2D fallback readback in progress. */
  private readbackBusy = false;
  /** GPU renders submitted but not yet read back (pipelined: GPU-process latency doesn't cost frames). */
  private gpuInFlight = 0;
  private renderSeq = 0;
  private deliveredSeq = 0;
  private hasDrawnSource = false;
  /** Content key of the last frame drawn; nothing is redrawn until it changes. */
  private renderedKey = '';
  /** A render was requested while a readback was in flight. */
  private renderPending = false;
  /** Surfaces in the shared GPU compositor (null: no WebGPU/WebGL2 → 2D canvas fallback). */
  private gl: RenderTarget | null = null;
  /** The compositor is still initialising: wait instead of using the 2D fallback. */
  private gpuPending = false;
  private cfgVersion = 0;
  /** Passthrough cadence state last requested (null: unknown, e.g. the main side just reconfigured the sender). */
  private passCad: boolean | null = null;
  /** Cache key of the content last sent as a preview thumbnail. */
  private previewKey = '';
  private drawMs = 0;

  // passthrough path
  private inFlight = 0;
  private pool = new FramePool();
  /** Size/format of the last passthrough frame sent (its bytes stay in the native sender). */
  private lastPass: { w: number; h: number; fmt: string; stride: number } | null = null;
  private lossTimer: ReturnType<typeof setInterval> | 0 = 0;
  private lastSentAt = 0;

  // stats
  private outTimes: number[] = [];
  private outW = 0;
  private outH = 0;
  private latency = 0;
  /** Cycle time (ms, EMA): draw + readback for canvas outputs, copy + send for passthrough. */
  private cycle = 0;
  private thumb = new Thumbnailer(320);
  /** Preview from the NDI readback buffer (compositor path). */
  private packedThumb = new PackedThumbnailer(320);
  /** Unprocessed source preview (`raw:<id>`) for the Output Effects window's live preview. */
  private rawThumb = new Thumbnailer(640);
  private tracker: AutoCropTracker | null = null;

  /** Per-config caches (hot paths run per frame and on 20 Hz ticks). */
  private memo = { v: -1, canvasMode: false, effects: null as OutputEffects | null };
  private lossMemo: { v: number; g: unknown; ls: VideoLossSettings & { delayMs: number }; json: string } | null = null;

  constructor(
    readonly id: string,
    rc: RenderConfig,
    private host: RenderHost,
  ) {
    this.rc = rc;
    this.reconfigure();
  }

  private get cfg(): OutputConfig {
    return this.rc.cfg;
  }

  private get engine(): EngineState {
    return this.rc.engine;
  }

  private get sourceName(): string {
    return this.rc.sourceName;
  }

  private refreshMemo(): void {
    if (this.memo.v === this.cfgVersion) return;
    this.memo = { v: this.cfgVersion, canvasMode: isCanvasMode(this.cfg), effects: fullEffects(this.cfg.effects) };
  }

  private get canvasMode(): boolean {
    this.refreshMemo();
    return this.memo.canvasMode;
  }

  /** The config's effects with defaults filled in. */
  private get effects(): OutputEffects {
    this.refreshMemo();
    return this.memo.effects!;
  }

  private get active(): boolean {
    return this.cfg.enabled && this.engine !== 'disabled';
  }

  configure(rc: RenderConfig): void {
    const prev = this.rc;
    this.rc = rc;
    // The main side may have recreated/reset the sender: re-request the passthrough cadence.
    this.passCad = null;
    const cfgChanged = JSON.stringify(prev.cfg) !== JSON.stringify(rc.cfg);
    if (cfgChanged || prev.sourceName !== rc.sourceName || prev.avatarUrl !== rc.avatarUrl || JSON.stringify(prev.videoLoss) !== JSON.stringify(rc.videoLoss)) {
      this.cfgVersion++;
      this.memo.v = -1;
    }
    if (
      prev.engine !== rc.engine ||
      prev.senderReady !== rc.senderReady ||
      prev.cfg.enabled !== rc.cfg.enabled ||
      JSON.stringify(prev.cfg.format) !== JSON.stringify(rc.cfg.format) ||
      isCanvasMode(prev.cfg) !== isCanvasMode(rc.cfg)
    ) {
      this.reconfigure();
    }
  }

  /** Route a source (engine source id) or nothing into this output. */
  bind(sourceId: string | null): void {
    if (sourceId === this.sourceId) return;
    this.sourceId = sourceId;
    this.hasDrawnSource = false;
  }

  get boundSource(): string | null {
    return this.sourceId;
  }

  private wants(key: string): boolean {
    return this.host.wantsPreview(key);
  }

  /** The UI started showing this output's preview: re-render static content once so it appears. */
  previewShown(): void {
    this.renderedKey = '';
    this.previewKey = '';
  }

  /** Buffers the native sender released (back from the main side). */
  returnBuffers(bufs: ArrayBuffer[]): void {
    this.pool.give(bufs);
  }

  /** Passthrough: ask the main side to let the native clock repeat the last frame (or stop). */
  private setPassCadence(on: boolean): void {
    if (this.passCad === on) return;
    this.passCad = on;
    this.host.setPassCadence(this.id, on);
  }

  private reconfigure(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.lossTimer) clearInterval(this.lossTimer);
    this.timer = 0;
    this.lossTimer = 0;
    this.renderedKey = '';
    if (!this.active) return;
    if (this.canvasMode) {
      const f = outFormatOf(this.cfg);
      this.setupCanvas(f.width, f.height);
      this.timer = setInterval(() => this.canvasTick(), 1000 / HOUSEKEEPING_HZ);
      this.canvasTick();
    } else {
      // Passthrough: only render loss content when the source stops.
      this.lossTimer = setInterval(() => this.passthroughLossTick(), 1000 / LOSS_FPS);
    }
  }

  private setupCanvas(w: number, h: number): void {
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = new OffscreenCanvas(w, h);
      this.ctx = this.canvas.getContext('2d', { alpha: true, willReadFrequently: false }) as OffscreenCanvasRenderingContext2D;
    }
  }

  private current(): SourceFrame | undefined {
    return this.sourceId ? this.host.source(this.sourceId) : undefined;
  }

  // ---------------- passthrough ----------------
  /** A new frame arrived on the bound source (the engine keeps it; clone to hold on to it). */
  onSourceFrame(frame: VideoFrame, arrivedAt: number): void {
    if (this.active && this.canvasMode) {
      // Render on arrival (latest frame wins while a readback is in flight).
      if (this.engine === 'enabled') this.canvasTick();
      return;
    }
    if (!this.active || this.canvasMode || this.engine !== 'enabled' || !this.rc.senderReady || this.inFlight >= 2) return;
    const now = performance.now();
    if (now - this.lastSentAt < 1000 / 61) return;
    this.lastSentAt = now;
    let clone: VideoFrame;
    try {
      clone = frame.clone();
    } catch {
      return;
    }
    void this.sendPassthrough(clone, arrivedAt);
  }

  private async sendPassthrough(frame: VideoFrame, arrivedAt: number): Promise<void> {
    this.inFlight++;
    let buf: ArrayBuffer | null = null;
    try {
      const rect = frame.visibleRect!;
      const w = rect.width;
      const h = rect.height;
      if (!w || !h) return;
      const even = w % 2 === 0 && h % 2 === 0 && rect.x % 2 === 0 && rect.y % 2 === 0;
      const fmt = frame.format;
      let ndiFmt = 'BGRA';
      let size = w * h * 4;
      let layout: PlaneLayout[] = [{ offset: 0, stride: w * 4 }];
      let opts: Record<string, unknown> = { rect, layout, format: 'BGRA' };
      if (even && fmt === 'I420') {
        ndiFmt = 'I420';
        size = (w * h * 3) / 2;
        layout = [
          { offset: 0, stride: w },
          { offset: w * h, stride: w / 2 },
          { offset: (w * h * 5) / 4, stride: w / 2 },
        ];
        opts = { rect, layout };
      } else if (even && fmt === 'NV12') {
        ndiFmt = 'NV12';
        size = (w * h * 3) / 2;
        layout = [
          { offset: 0, stride: w },
          { offset: w * h, stride: w },
        ];
        opts = { rect, layout };
      }
      buf = this.pool.take(size);
      const ct0 = performance.now();
      await frame.copyTo(buf, opts as VideoFrameCopyToOptions);
      this.setPassCadence(false);
      this.host.submit(this.id, buf, w, h, ndiFmt, layout[0].stride);
      buf = null; // owned by the sender now
      this.noteCycle(performance.now() - ct0);
      this.lastPass = { w, h, fmt: ndiFmt, stride: layout[0].stride };
      this.noteOut(w, h, arrivedAt);
      if (this.rc.recording) {
        try {
          this.host.record(this.id, frame.clone(), w, h);
        } catch {
          /* recorder drops this frame */
        }
      }
      if (this.wants(`raw:${this.id}`)) void this.rawThumb.maybe(frame, w, h, Math.min(15, this.rc.previewFps)).then((j) => j && this.host.preview(`raw:${this.id}`, j));
      if (this.wants(this.id)) void this.thumb.maybe(frame, w, h, this.rc.previewFps).then((j) => j && this.host.preview(this.id, j));
    } catch (e) {
      this.host.log(`[${this.cfg.name}] passthrough error: ${(e as Error).message}`);
    } finally {
      frame.close();
      if (buf) this.pool.give([buf]);
      this.inFlight--;
    }
  }

  private passthroughLossTick(): void {
    if (!this.rc.senderReady) return;
    const sourceLive = this.sourceLive() && this.engine === 'enabled';
    if (sourceLive) return;
    // Inside the video-loss delay: send nothing, so receivers hold the last frame.
    if (this.engine === 'enabled' && this.inLossDelay() && this.lastPass) return;
    // Freeze: the native clock repeats the last good frame (no copy kept in JS).
    if (this.cfg.lossMode === 'freeze' && this.lastPass && this.engine === 'enabled') {
      this.setPassCadence(true);
      return;
    }
    const src = this.current();
    const w = this.lastPass?.w || src?.width || 1280;
    const h = this.lastPass?.h || src?.height || 720;
    this.setupCanvas(w - (w % 2), h - (h % 2));
    const key = `p${this.lossKey()}`;
    // Loss content already sent: the native clock repeats it.
    if (this.renderedKey === key) {
      this.refreshPreview();
      return;
    }
    if (this.busyRendering) return;
    const gl = this.glTarget();
    if (!gl && this.gpuPending) return;
    this.renderedKey = key;
    this.drawLoss();
    const alpha = this.cfg.lossMode === 'transparent';
    if (gl) this.renderGpu(gl, { kind: 'image', src: this.canvas! }, null, performance.now(), key, alpha, true, true);
    else void this.readbackLegacy(performance.now(), key, true, true);
  }

  // ---------------- canvas path ----------------
  /** This output's surfaces in the shared compositor (recreated after a context loss). */
  private glTarget(): RenderTarget | null {
    if (this.gl && !this.gl.lost) return this.gl;
    this.gl = null;
    const c = getCompositor();
    this.gpuPending = c === undefined;
    if (!c) return null;
    this.gl = c.createTarget();
    this.host.log(`[${this.cfg.name}] compositor: ${c.kind}`);
    return this.gl;
  }

  /**
   * Draw + read back only when the content changes (new source frame, config/effects,
   * loss state); otherwise the native cadence clock keeps repeating the last frame.
   */
  private canvasTick(): void {
    if (!this.active || !this.canvasMode || !this.rc.senderReady) return;
    if (!this.canvas) return;
    const cur = this.engine === 'enabled' ? this.current() : undefined;
    const live = !!cur && this.sourceLive();
    // Freeze mode, or still inside the video-loss delay: hold the last source frame.
    const hold = !live && this.hasDrawnSource && this.engine === 'enabled' && (this.cfg.lossMode === 'freeze' || this.inLossDelay());
    // Auto-crop eases between source frames: re-render on housekeeping ticks only while the view
    // is still moving, and at most once per output frame interval.
    const easing = live && !!this.tracker?.moving;
    const f = outFormatOf(this.cfg);
    const key = live
      ? `src:${cur!.at}:${this.sourceName}:${this.cfgVersion}:${easing ? Math.floor((performance.now() * f.fpsN) / (1000 * f.fpsD)) : 0}`
      : hold
        ? this.renderedKey || 'freeze'
        : this.lossKey();
    if (key === this.renderedKey) {
      this.refreshPreview();
      return;
    }
    if (this.busyRendering) {
      // Picked up as soon as an in-flight readback completes.
      this.renderPending = true;
      return;
    }
    const t0 = performance.now();
    let arrivedAt = t0;
    let alpha = false;
    let still = false;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const gl = this.glTarget();
    if (!gl && this.gpuPending) return; // housekeeping retries shortly
    if (gl?.busy) {
      this.renderPending = true;
      return;
    }
    this.renderPending = false;
    let job: RenderJob = { kind: 'repeat' };
    let overlay: OverlaySpec | null = null;
    if (live && cur) {
      if (gl) {
        const e = this.effects;
        job = { kind: 'source', frame: cur.frame, e, auto: this.autoView(cur.frame, W, H) };
        overlay = this.overlaySpec(e, W, H);
      } else this.drawSource2d(cur.frame);
      this.hasDrawnSource = true;
      arrivedAt = cur.at;
      this.rawPreview(cur.frame);
    } else if (!hold) {
      this.drawLoss();
      job = { kind: 'image', src: this.canvas };
      alpha = this.cfg.lossMode === 'transparent';
      still = true;
    }
    this.renderedKey = key;
    this.drawMs = performance.now() - t0;
    if (!gl && this.wants(this.id)) {
      // 2D fallback: preview straight from the canvas.
      void this.thumb.maybe(this.canvas, W, H, this.rc.previewFps).then((j) => {
        if (!j) return;
        this.host.preview(this.id, j);
        this.previewKey = key;
      });
    }
    if (gl) {
      this.renderGpu(gl, job, overlay, arrivedAt, key, alpha, false, still);
      this.recordFrame(gl);
      return;
    }
    this.recordFrame(null);
    void this.readbackLegacy(arrivedAt, key, false, still);
  }

  private recordFrame(gl: RenderTarget | null): void {
    if (!this.rc.recording || !this.canvas) return;
    try {
      const ts = Math.round(performance.now() * 1000);
      const vf = gl ? gl.videoFrame(ts) : new VideoFrame(this.canvas, { timestamp: ts });
      if (vf) this.host.record(this.id, vf, this.canvas.width, this.canvas.height);
    } catch {
      /* recorder drops this frame */
    }
  }

  /** Auto-crop (face tracking) view for this frame, when enabled and supported. */
  private autoView(frame: VideoFrame, W: number, H: number) {
    const wantTrack = !!this.cfg.autoCropEnabled && autoCropSupported();
    if (wantTrack && !this.tracker) this.tracker = new AutoCropTracker();
    if (!wantTrack) this.tracker = null;
    return this.tracker?.supported ? this.tracker.update(frame, frame.displayWidth, frame.displayHeight, W / H, this.cfg) : null;
  }

  /** Overlay layer key: redrawn only when config, participant name or overlay images change. */
  private overlayKey(e: OutputEffects): string {
    const imgs = (e.images ?? []).map((i) => (i.visible ? (this.host.image(i.path) ? 1 : 0) : '-')).join('');
    return `${this.cfgVersion}:${this.sourceName}:${imgs}`;
  }

  private overlaySpec(e: OutputEffects, W: number, H: number): OverlaySpec | null {
    if (!e.nameTag && !(e.images ?? []).some((i) => i.visible)) return null;
    return {
      key: this.overlayKey(e),
      draw: (ctx) => {
        drawOverlays(ctx, W, H, e, this.sourceName, (img) => this.host.image(img.path));
        return true;
      },
    };
  }

  /** 2D fallback (no WebGL2): fit/zoom/pan/mirror + CSS colour filters only. */
  private drawSource2d(frame: VideoFrame): void {
    const ctx = this.ctx!;
    const W = this.canvas!.width;
    const H = this.canvas!.height;
    const e = this.effects;
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const fit = Math.min(W / sw, H / sh) * Math.max(0.1, e.zoom) * Math.max(0.1, e.cropZoom ?? 1);
    const dw = sw * fit;
    const dh = sh * fit;
    const maxPanX = Math.max(0, (dw - W) / 2);
    const maxPanY = Math.max(0, (dh - H) / 2);
    const dx = (W - dw) / 2 - e.panX * maxPanX - (e.cropPanX ?? 0) * (dw / 2);
    const dy = (H - dh) / 2 - e.panY * maxPanY - (e.cropPanY ?? 0) * (dh / 2);
    const filters: string[] = [];
    const b = e.brightness * Math.pow(2, (e.exposure ?? 0) * 2);
    if (b !== 1) filters.push(`brightness(${b})`);
    if (e.contrast !== 1) filters.push(`contrast(${e.contrast})`);
    if (e.saturation !== 1) filters.push(`saturate(${e.saturation})`);
    if (e.hue !== 0) filters.push(`hue-rotate(${e.hue}deg)`);
    ctx.filter = filters.length ? filters.join(' ') : 'none';
    if (e.mirror) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(frame, e.mirror ? W - dx - dw : dx, dy, dw, dh);
    ctx.restore();
    drawOverlays(ctx, W, H, e, this.sourceName, (img) => this.host.image(img.path));
  }

  // ---------------- video loss ----------------
  /** Loss settings in force for this output (global, or the per-output override). */
  private lossSettings(): VideoLossSettings & { delayMs: number } {
    return this.lossMemoFor().ls;
  }

  /** Loss settings + their JSON, recomputed only when the config or the global settings change. */
  private lossMemoFor(): NonNullable<OutputRenderer['lossMemo']> {
    const g = this.rc.videoLoss;
    const m = this.lossMemo;
    if (m && m.v === this.cfgVersion && m.g === g) return m;
    const base: VideoLossSettings = g ? (g.perOutputVideoLossEnabled && this.cfg.videoLoss ? { ...DEFAULT_VIDEO_LOSS, ...this.cfg.videoLoss } : g) : DEFAULT_VIDEO_LOSS;
    const ls = { ...DEFAULT_VIDEO_LOSS, ...base, delayMs: g ? (VIDEO_LOSS_DELAY_MS[g.delay] ?? 1000) : 1000 };
    this.lossMemo = { v: this.cfgVersion, g, ls, json: JSON.stringify(ls) };
    return this.lossMemo;
  }

  /** Source delivering frames, within the loss delay (capped at 1 s staleness). */
  private sourceLive(): boolean {
    const src = this.current();
    if (!src) return false;
    const age = performance.now() - src.lastFrameAt;
    return age < Math.min(1000, this.lossSettings().delayMs);
  }

  /** Video stopped, but not for longer than the configured video-loss delay. */
  private inLossDelay(): boolean {
    const src = this.current();
    if (!src || !src.lastFrameAt) return false;
    return performance.now() - src.lastFrameAt < this.lossSettings().delayMs;
  }

  private lossKey(): string {
    const mode = this.cfg.lossMode;
    let extra = '';
    if (mode === 'image') extra = this.host.image(this.cfg.lossImage) ? 'ok' : 'pending';
    if (mode === 'profilePicture') {
      const url = this.rc.avatarUrl;
      extra = `${this.sourceName}:${url}:${url && avatarFor(url) ? 'ok' : 'pending'}`;
    }
    return `loss:${mode}:${this.cfg.lossImage}:${this.cfgVersion}:${mode === 'testcard' ? Math.floor(Date.now() / 1000) : 0}:${extra}:${this.lossMemoFor().json}`;
  }

  /** Send the unprocessed source to the Output Effects window (key `raw:<id>`). */
  private rawPreview(frame: VideoFrame): void {
    if (!this.wants(`raw:${this.id}`)) return;
    void this.rawThumb
      .maybe(frame, frame.displayWidth, frame.displayHeight, Math.min(15, this.rc.previewFps))
      .then((j) => j && this.host.preview(`raw:${this.id}`, j));
  }

  private drawLoss(): void {
    const ctx = this.ctx!;
    const W = this.canvas!.width;
    const H = this.canvas!.height;
    ctx.save();
    ctx.filter = 'none';
    switch (this.cfg.lossMode) {
      case 'transparent':
        ctx.clearRect(0, 0, W, H);
        break;
      case 'image': {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        const img = this.cfg.lossImage ? this.host.image(this.cfg.lossImage) : null;
        if (img) {
          const s = Math.min(W / img.width, H / img.height);
          ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
        }
        break;
      }
      case 'testcard':
        this.drawTestcard();
        break;
      case 'profilePicture':
        this.drawProfilePicture();
        break;
      default:
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
    const vl = this.lossSettings();
    if (vl.displayOutputNameOnImage && (this.cfg.lossMode === 'image' || this.cfg.lossMode === 'profilePicture' || this.cfg.lossMode === 'black')) {
      ctx.save();
      const size = Math.round(H * 0.04);
      ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const pad = size * 0.5;
      const tw = ctx.measureText(this.cfg.name).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(H * 0.03, H * 0.03, tw + pad * 2, size + pad * 1.4);
      ctx.fillStyle = '#fff';
      ctx.fillText(this.cfg.name, H * 0.03 + pad, H * 0.03 + pad * 0.7);
      ctx.restore();
    }
  }

  /** RE profilePicture loss mode: avatar (or initials) in a circle on a coloured background. */
  private drawProfilePicture(): void {
    const ctx = this.ctx!;
    const W = this.canvas!.width;
    const H = this.canvas!.height;
    const vl = this.lossSettings();
    const name = this.sourceName || this.cfg.name;
    ctx.fillStyle = vl.profilePictureBackgroundColor || '#222222';
    ctx.fillRect(0, 0, W, H);
    const d = Math.round(H * Math.max(0.05, Math.min(0.95, vl.profilePictureSize || 0.4)));
    const cx = W / 2;
    const cy = H / 2 - (vl.profilePictureShowName ? H * 0.05 : 0);
    const url = vl.profilePictureForceInitials ? '' : this.rc.avatarUrl;
    const bmp = url ? avatarFor(url) : null;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.closePath();
    if (bmp) {
      ctx.clip();
      const s = Math.max(d / bmp.width, d / bmp.height);
      ctx.drawImage(bmp, cx - (bmp.width * s) / 2, cy - (bmp.height * s) / 2, bmp.width * s, bmp.height * s);
    } else {
      ctx.fillStyle = vl.profilePictureOverrideInitialsBgColor ? vl.profilePictureInitialsBgColor : colourFor(name);
      ctx.fill();
      ctx.fillStyle = vl.profilePictureInitialsColor || '#ffffff';
      ctx.font = `500 ${Math.round(d * 0.4)}px "Segoe UI", "Google Sans", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initialsOf(name), cx, cy + d * 0.02);
    }
    ctx.restore();
    if (vl.profilePictureShowName && name) {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.font = `500 ${Math.round(H * 0.045)}px "Segoe UI", "Google Sans", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(name, cx, cy + d / 2 + H * 0.04);
      ctx.restore();
    }
  }

  private drawTestcard(): void {
    const ctx = this.ctx!;
    const W = this.canvas!.width;
    const H = this.canvas!.height;
    const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    const bw = W / bars.length;
    bars.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(Math.floor(i * bw), 0, Math.ceil(bw), H * 0.67);
    });
    const low = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
    low.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(Math.floor(i * bw), H * 0.67, Math.ceil(bw), H * 0.08);
    });
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, H * 0.75, W, H * 0.25);
    const size = Math.round(H * 0.06);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${size}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.cfg.name, W / 2, H * 0.83);
    ctx.font = `400 ${Math.round(size * 0.6)}px Consolas, monospace`;
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(new Date().toLocaleTimeString(), W / 2, H * 0.92);
    ctx.textAlign = 'start';
  }

  /** Render on the GPU compositor, pack (UYVY, or BGRA for alpha), read back async, then submit to NDI. */
  private renderGpu(gl: RenderTarget, job: RenderJob, overlay: OverlaySpec | null, arrivedAt: number, key: string, alpha: boolean, cacheIt: boolean, still: boolean): void {
    if (!this.rc.senderReady || !this.canvas) return;
    const fmt: PackFormat = alpha ? 'BGRA' : 'UYVY';
    const p = gl.render(job, this.canvas.width, this.canvas.height, overlay, fmt, (size) => this.pool.take(size));
    if (!p) {
      this.renderedKey = ''; // retry on the next tick
      return;
    }
    this.gpuInFlight++;
    const seq = ++this.renderSeq;
    p.then(
      (r) => {
        this.gpuInFlight--;
        if (!r) return;
        // Never send an older frame after a newer one.
        if (seq < this.deliveredSeq) return this.pool.give([r.buf]);
        this.deliveredSeq = seq;
        this.deliver(r, arrivedAt, key, cacheIt, still, this.drawMs + r.cpuMs);
      },
      (e) => {
        this.gpuInFlight--;
        this.host.log(`[${this.cfg.name}] readback error: ${(e as Error).message}`);
      },
    );
  }

  private deliver(r: ReadbackResult, arrivedAt: number, key: string, cacheIt: boolean, still: boolean, cpuMs: number): void {
    const f = outFormatOf(this.cfg);
    const { buf, width: W, height: H, fmt, stride } = r;
    try {
      // Thumbnail first: the buffer belongs to the sender once submitted.
      const thumb = this.glTargetReady() && this.wants(this.id) ? this.packedThumb.maybe(r, this.rc.previewFps, still || !this.previewKey) : null;
      this.host.submit(this.id, buf, W, H, fmt, stride, cacheIt ? LOSS_FPS : f.fpsN, cacheIt ? 1 : f.fpsD);
      // Passthrough loss content: sent once, then repeated by the native clock.
      if (cacheIt) this.setPassCadence(true);
      this.noteCycle(cpuMs);
      this.noteOut(W, H, arrivedAt);
      // Preview from the readback itself (already on the CPU): no second GPU readback.
      thumb?.then((j) => {
        if (!j) return;
        this.host.preview(this.id, j);
        this.previewKey = key;
      });
    } catch (e) {
      this.host.log(`[${this.cfg.name}] send error: ${(e as Error).message}`);
    } finally {
      this.readbackBusy = false;
    }
    // A newer frame arrived while this one was being read back.
    if (this.renderPending && this.canvasMode) this.canvasTick();
  }

  private get busyRendering(): boolean {
    return this.readbackBusy || this.gpuInFlight >= MAX_GPU_INFLIGHT;
  }

  private glTargetReady(): boolean {
    return !!this.gl && !this.gl.lost;
  }

  /** Fallback without WebGL2: VideoFrame.copyTo BGRA from the 2D canvas. */
  private async readbackLegacy(arrivedAt: number, key: string, cacheIt: boolean, still: boolean): Promise<void> {
    if (!this.rc.senderReady || !this.canvas || this.readbackBusy) return;
    this.readbackBusy = true;
    const t0 = performance.now();
    let vf: VideoFrame | null = null;
    try {
      const W = this.canvas.width;
      const H = this.canvas.height;
      vf = new VideoFrame(this.canvas, { timestamp: Math.round(performance.now() * 1000), alpha: 'keep' });
      const buf = this.pool.take(W * H * 4);
      await vf.copyTo(buf, { format: 'BGRA', layout: [{ offset: 0, stride: W * 4 }] } as unknown as VideoFrameCopyToOptions);
      vf.close();
      vf = null;
      this.deliver({ buf, width: W, height: H, fmt: 'BGRA', stride: W * 4, cpuMs: 0 }, arrivedAt, key, cacheIt, still, this.drawMs + performance.now() - t0);
    } catch (e) {
      this.host.log(`[${this.cfg.name}] render error: ${(e as Error).message}`);
      this.readbackBusy = false;
    } finally {
      vf?.close();
    }
  }

  /** 2D fallback: static content (loss/freeze) may have missed the preview throttle — thumbnail it once. */
  private refreshPreview(): void {
    const key = this.renderedKey;
    if (this.glTargetReady() || !key || !this.canvas || this.previewKey === key || this.busyRendering || !this.wants(this.id)) return;
    void this.thumb.maybe(this.canvas, this.canvas.width, this.canvas.height, this.rc.previewFps).then((j) => {
      if (j) {
        this.host.preview(this.id, j);
        this.previewKey = key;
      }
    });
  }

  private noteCycle(ms: number): void {
    this.cycle = this.cycle ? this.cycle * 0.9 + ms * 0.1 : ms;
  }

  private noteOut(w: number, h: number, arrivedAt: number): void {
    const now = performance.now();
    this.outW = w;
    this.outH = h;
    this.outTimes.push(now);
    this.latency = this.latency * 0.9 + Math.max(0, now - arrivedAt) * 0.1;
  }

  stats(): RenderStats {
    const now = performance.now();
    while (this.outTimes.length && now - this.outTimes[0] > 1000) this.outTimes.shift();
    return {
      outW: this.outW,
      outH: this.outH,
      latencyMs: Math.round(this.latency),
      cycleMs: Math.round(this.cycle * 10) / 10,
      outFps: this.outTimes.length,
      live: this.sourceLive() || (this.inLossDelay() && (this.hasDrawnSource || !!this.lastPass)),
    };
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.lossTimer) clearInterval(this.lossTimer);
    this.timer = 0;
    this.lossTimer = 0;
    this.gl?.dispose();
    this.gl = null;
  }
}
