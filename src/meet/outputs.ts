// Output slots: a stable NDI source each, fed from whichever participant the slot is
// routed to. Two render paths:
//   - passthrough (format = native, no effects): copy Meet's decoded frames as-is (I420/NV12)
//   - canvas (fixed format and/or effects): draw into an OffscreenCanvas (letterbox/scale,
//     colour, crop/zoom, mirror, name tag) only when the content changes (new source frame,
//     config/effects/loss change), convert to UYVY on the GPU and read it back
//     asynchronously (gpureadback.ts; BGRA when alpha is needed). The native sender's
//     cadence clock emits at exactly the configured rate, repeating the last frame.
// When the source has no video, the slot renders its loss mode (black/freeze/transparent/
// image/testcard/profilePicture) so downstream switchers always see a stable signal, after
// the global video-loss delay (hold the last frame until then).
// Effects (RE ProcAmp) render through the shared WebGL2 pipeline in control/effects/fxgl.ts
// (the same code the Output Effects preview uses); overlays through control/effects/overlays.ts.

import * as fs from 'fs';
import type { EngineState, GlobalVideoLossSettings, OutputConfig, OutputEffects, OutputState, VideoLossSettings } from '../shared/types';
import { DEFAULT_EFFECTS, DEFAULT_VIDEO_LOSS, VIDEO_LOSS_DELAY_MS } from '../shared/types';
import { FxRenderer, fullEffects, isIdentityCurve } from '../control/effects/fxgl';
import { drawOverlays } from '../control/effects/overlays';
import { AutoCropTracker, autoCropSupported } from '../control/effects/autocrop';
import { Thumbnailer } from './camsource';
import type { NativeNdi, NativeSender } from './native';
import type { SourceTap } from './sources';
import { Recorder } from './recorder';
import { GpuReadback, type PackFormat } from './gpureadback';

const LOSS_FPS = 10;
/** Canvas outputs: housekeeping rate for loss/effects changes (source frames render on arrival). */
const HOUSEKEEPING_HZ = 20;

/** Numeric ProcAmp fields that are neutral at their DEFAULT_EFFECTS value. */
const NEUTRAL_KEYS: (keyof OutputEffects)[] = [
  'brightness', 'contrast', 'saturation', 'hue', 'zoom', 'panX', 'panY',
  'exposure', 'vibrance', 'sharpness', 'temperature', 'tint', 'highlights', 'shadows', 'vignette',
  'liftR', 'liftG', 'liftB', 'gammaR', 'gammaG', 'gammaB', 'gainR', 'gainG', 'gainB',
  'cropLeft', 'cropRight', 'cropTop', 'cropBottom', 'whiteBalanceK', 'cropZoom', 'cropPanX', 'cropPanY', 'cropRotation',
];

function effectsActive(cfg: OutputConfig): boolean {
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

/** Loss-mode images: decoded once, then drawn synchronously. */
const imageCache = new Map<string, ImageBitmap | null | 'loading'>();
function imageFor(path: string): ImageBitmap | null {
  const hit = imageCache.get(path);
  if (hit === undefined) {
    imageCache.set(path, 'loading');
    void (async () => {
      try {
        const data = fs.readFileSync(path);
        const ext = path.toLowerCase().split('.').pop() ?? 'png';
        const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
        imageCache.set(path, await createImageBitmap(new Blob([data], { type })));
      } catch {
        imageCache.set(path, null);
      }
    })();
    return null;
  }
  return hit === 'loading' ? null : hit;
}

export interface OutputEnv {
  ndi: NativeNdi;
  groups: () => string;
  previewFps: () => number;
  recordDir: () => string;
  log: (s: string) => void;
  onPreview: (key: string, jpeg: ArrayBuffer) => void;
  /** [effects-agent] Global video-loss settings (delay, profile picture style, per-output overrides). */
  videoLoss?: () => GlobalVideoLossSettings;
}

export class OutputPipeline {
  cfg: OutputConfig;
  private engine: EngineState = 'enabled';
  private sender: NativeSender | null = null;
  private senderName = '';
  private nextSenderAttempt = 0;
  private source: SourceTap | null = null;
  sourceName = '';
  private unsubscribe: (() => void) | null = null;

  // canvas path
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private timer = 0;
  private readbackBusy = false;
  private hasDrawnSource = false;
  /** Content key of the last frame drawn; nothing is redrawn until it changes. */
  private renderedKey = '';
  /** A render was requested while a readback was in flight. */
  private renderPending = false;
  private pollTimer = 0;
  private gpu: GpuReadback | null = null;
  private gpuFailed = false;
  /** Passthrough loss content (re-sent at LOSS_FPS; passthrough senders aren't clocked). */
  private cache: { buf: ArrayBuffer; key: string; w: number; h: number; fmt: string; stride: number } | null = null;
  private cfgVersion = 0;
  /** Cache key of the content last sent as a preview thumbnail. */
  private previewKey = '';

  // passthrough path
  private inFlight = 0;
  private bufPool: ArrayBuffer[] = [];
  private lastPass: { buf: ArrayBuffer; w: number; h: number; fmt: string; stride: number } | null = null;
  private lossTimer = 0;
  private lastSentAt = 0;

  // stats
  private outTimes: number[] = [];
  /** Native (clocked) send rate, from sender.stats().sent deltas. */
  private nativeSent = { n: -1, t: 0, fps: 0 };
  private outW = 0;
  private outH = 0;
  private latency = 0;
  private audioPeak = 0;
  /** Engine cycle time (ms, EMA): draw + readback for canvas outputs, copy + send for passthrough. */
  private cycle = 0;
  private cycleT0 = 0;
  private thumb = new Thumbnailer(320);
  /** Unprocessed source preview (`raw:<id>`) for the Output Effects window's live preview. */
  private rawThumb = new Thumbnailer(640);
  private fx: FxRenderer | null = null;
  private fxFailed = false;
  private tracker: AutoCropTracker | null = null;
  private recorder: Recorder | null = null;

  // audio delay line
  private audioQueue: { at: number; data: Float32Array; sr: number; ch: number; n: number }[] = [];

  constructor(
    cfg: OutputConfig,
    private env: OutputEnv,
  ) {
    this.cfg = cfg;
    this.reconfigure();
  }

  get id(): string {
    return this.cfg.id;
  }

  private get canvasMode(): boolean {
    return !!this.cfg.format || effectsActive(this.cfg);
  }

  private get active(): boolean {
    return this.cfg.enabled && this.engine !== 'disabled';
  }

  setConfig(cfg: OutputConfig): void {
    const prev = this.cfg;
    this.cfg = cfg;
    if (JSON.stringify(prev) !== JSON.stringify(cfg)) this.cfgVersion++;
    if (
      prev.name !== cfg.name ||
      prev.enabled !== cfg.enabled ||
      JSON.stringify(prev.format) !== JSON.stringify(cfg.format) ||
      effectsActive(prev) !== effectsActive(cfg)
    ) {
      this.reconfigure();
    }
    if (prev.record !== cfg.record) this.updateRecorder();
  }

  setEngine(state: EngineState): void {
    if (state === this.engine) return;
    this.engine = state;
    this.reconfigure();
    this.updateRecorder();
  }

  /** Route a source (or nothing) into this output. */
  bind(src: SourceTap | null): void {
    if (src === this.source) {
      if (src) this.sourceName = src.displayName;
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.source = src;
    this.sourceName = src?.displayName ?? '';
    this.hasDrawnSource = false;
    if (src) this.unsubscribe = src.subscribe((f, at) => this.onSourceFrame(f, at));
  }

  get boundKey(): string | null {
    return this.source?.key ?? null;
  }

  // ---------------- sender ----------------
  private ensureSender(): void {
    const want = this.active ? this.cfg.name.trim() || 'GMEET' : '';
    if (this.sender && this.senderName === want) return;
    if (this.sender) {
      this.sender.destroy();
      this.env.log(`NDI source down: "${this.senderName}"`);
      this.sender = null;
      this.senderName = '';
    }
    if (!want || performance.now() < this.nextSenderAttempt) return;
    try {
      const groups = this.env.groups().trim();
      this.sender = new this.env.ndi.Sender(want, { idleMs: 0, ...(groups ? { groups } : {}) });
      this.senderName = want;
      this.env.log(`NDI source up: "${want}"`);
      this.applyCadence();
    } catch (e) {
      this.nextSenderAttempt = performance.now() + 5000;
      this.env.log(`NDI sender create failed for "${want}": ${(e as Error).message}`);
    }
  }

  private get outFormat(): { width: number; height: number; fpsN: number; fpsD: number } {
    return this.cfg.format ?? { width: 1280, height: 720, fpsN: 30000, fpsD: 1001 };
  }

  /** Canvas outputs are clocked natively at the configured rate; passthrough sends on arrival. */
  private applyCadence(): void {
    const s = this.sender;
    if (!s || typeof s.setCadence !== 'function') return;
    if (this.active && this.canvasMode) {
      const f = this.outFormat;
      s.setCadence(f.fpsN, f.fpsD);
    } else {
      s.setCadence(0, 0);
    }
  }

  private reconfigure(): void {
    window.clearInterval(this.timer);
    window.clearInterval(this.lossTimer);
    this.timer = 0;
    this.lossTimer = 0;
    this.ensureSender();
    this.applyCadence();
    this.renderedKey = '';
    if (!this.active) return;
    if (this.canvasMode) {
      const f = this.outFormat;
      this.setupCanvas(f.width, f.height);
      this.timer = window.setInterval(() => this.canvasTick(), 1000 / HOUSEKEEPING_HZ);
      this.canvasTick();
    } else {
      // Passthrough: only render loss content when the source stops.
      this.lossTimer = window.setInterval(() => this.passthroughLossTick(), 1000 / LOSS_FPS);
    }
  }

  private setupCanvas(w: number, h: number): void {
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = new OffscreenCanvas(w, h);
      this.ctx = this.canvas.getContext('2d', { alpha: true, willReadFrequently: false }) as OffscreenCanvasRenderingContext2D;
    }
  }

  // ---------------- passthrough ----------------
  private onSourceFrame(frame: VideoFrame, arrivedAt: number): void {
    if (this.active && this.canvasMode) {
      // Render on arrival (latest frame wins while a readback is in flight).
      if (this.engine === 'enabled') this.canvasTick();
      return;
    }
    if (!this.active || this.canvasMode || this.engine !== 'enabled' || !this.sender || this.inFlight >= 2) return;
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
      buf = this.bufPool.pop() ?? null;
      if (!buf || buf.byteLength !== size) buf = new ArrayBuffer(size);
      const ct0 = performance.now();
      await frame.copyTo(buf, opts as VideoFrameCopyToOptions);
      this.sender?.sendVideo(buf, w, h, ndiFmt, layout[0].stride);
      this.noteCycle(performance.now() - ct0);
      if (this.cfg.lossMode === 'freeze') this.lastPass = { buf: buf.slice(0), w, h, fmt: ndiFmt, stride: layout[0].stride };
      else this.lastPass = { buf: this.lastPass?.buf ?? new ArrayBuffer(0), w, h, fmt: ndiFmt, stride: layout[0].stride };
      this.noteOut(w, h, arrivedAt);
      this.recorder?.video(frame, w, h);
      void this.rawThumb.maybe(frame, w, h, Math.min(15, this.env.previewFps())).then((j) => j && this.env.onPreview(`raw:${this.cfg.id}`, j));
      void this.thumb.maybe(frame, w, h, this.env.previewFps()).then((j) => j && this.env.onPreview(this.cfg.id, j));
    } catch (e) {
      this.env.log(`[${this.cfg.name}] passthrough error: ${(e as Error).message}`);
    } finally {
      frame.close();
      if (buf && this.bufPool.length < 2) this.bufPool.push(buf);
      this.inFlight--;
    }
  }

  private passthroughLossTick(): void {
    if (!this.sender) return this.ensureSender();
    const sourceLive = this.sourceLive() && this.engine === 'enabled';
    if (sourceLive) return;
    // Inside the video-loss delay: send nothing, so receivers hold the last frame.
    if (this.engine === 'enabled' && this.inLossDelay() && this.lastPass) return;
    // Freeze: keep re-sending the last good frame.
    if (this.cfg.lossMode === 'freeze' && this.lastPass?.buf.byteLength && this.engine === 'enabled') {
      const p = this.lastPass;
      this.sender.sendVideo(p.buf, p.w, p.h, p.fmt, p.stride);
      this.noteOut(p.w, p.h, performance.now());
      return;
    }
    const w = this.lastPass?.w || this.source?.width || 1280;
    const h = this.lastPass?.h || this.source?.height || 720;
    this.setupCanvas(w - (w % 2), h - (h % 2));
    const key = `p${this.lossKey()}`;
    const W = this.canvas!.width;
    const H = this.canvas!.height;
    if (this.cache && this.cache.key === key && this.cache.w === W && this.cache.h === H) {
      this.sender.sendVideo(this.cache.buf, W, H, this.cache.fmt, this.cache.stride, LOSS_FPS, 1);
      this.noteOut(W, H, performance.now());
      this.refreshPreview();
      return;
    }
    if (this.readbackBusy || this.renderedKey === key) return;
    this.renderedKey = key;
    this.drawLoss();
    this.startReadback(performance.now(), key, this.cfg.lossMode === 'transparent', true);
  }

  // ---------------- canvas path ----------------
  /**
   * Draw + read back only when the content changes (new source frame, config/effects,
   * loss state); otherwise the native cadence clock keeps repeating the last frame.
   */
  private canvasTick(): void {
    if (!this.active || !this.canvasMode) return;
    if (!this.sender) this.ensureSender();
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;
    const cur = this.engine === 'enabled' ? this.source?.current() : null;
    const live = !!cur && this.sourceLive();
    // Freeze mode, or still inside the video-loss delay: hold the last source frame.
    const hold = !live && this.hasDrawnSource && this.engine === 'enabled' && (this.cfg.lossMode === 'freeze' || this.inLossDelay());
    const tracking = live && !!this.tracker;
    const key = live
      ? `src:${cur!.at}:${this.sourceName}:${this.cfgVersion}:${tracking ? performance.now() : 0}`
      : hold
        ? this.renderedKey || 'freeze'
        : this.lossKey();
    if (key === this.renderedKey) {
      this.refreshPreview();
      return;
    }
    if (this.readbackBusy) {
      // Picked up as soon as the in-flight readback completes.
      this.renderPending = true;
      return;
    }
    this.renderPending = false;
    const t0 = performance.now();
    let arrivedAt = t0;
    let alpha = false;
    if (live && cur) {
      this.drawSource(cur.frame);
      this.hasDrawnSource = true;
      arrivedAt = cur.at;
      this.rawPreview(cur.frame);
    } else if (!hold) {
      this.drawLoss();
      alpha = this.cfg.lossMode === 'transparent';
    }
    this.renderedKey = key;
    this.drawMs = performance.now() - t0;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // Preview + recording consume the composed canvas directly (no CPU readback).
    void this.thumb.maybe(this.canvas, W, H, this.env.previewFps()).then((j) => {
      if (!j) return;
      this.env.onPreview(this.cfg.id, j);
      this.previewKey = key;
    });
    if (this.recorder) {
      try {
        const vf = new VideoFrame(this.canvas, { timestamp: Math.round(performance.now() * 1000) });
        this.recorder.video(vf, W, H);
        vf.close();
      } catch {
        /* recorder drops this frame */
      }
    }
    this.startReadback(arrivedAt, key, alpha, false);
  }
  private drawMs = 0;

  private drawSource(frame: VideoFrame): void {
    const ctx = this.ctx!;
    const W = this.canvas!.width;
    const H = this.canvas!.height;
    const e = fullEffects(this.cfg.effects);
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    // Auto-crop (face tracking), when the Shape Detection API is available.
    const wantTrack = !!this.cfg.autoCropEnabled && autoCropSupported();
    if (wantTrack && !this.tracker) this.tracker = new AutoCropTracker();
    if (!wantTrack) this.tracker = null;
    const auto = this.tracker?.supported ? this.tracker.update(frame, sw, sh, W / H, this.cfg) : null;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    let ok = false;
    if (!this.fxFailed) {
      try {
        this.fx ??= new FxRenderer();
        ok = this.fx.render(frame, sw, sh, W, H, e, { auto });
        if (ok) ctx.drawImage(this.fx.canvas, 0, 0);
        else if (this.fx.failed) {
          this.fxFailed = true;
          this.env.log(`[${this.cfg.name}] WebGL effects unavailable; using the 2D fallback`);
        }
      } catch (err) {
        this.fxFailed = true;
        this.env.log(`[${this.cfg.name}] WebGL effects error: ${(err as Error).message}`);
      }
    }
    if (!ok) this.drawSource2d(frame, e);
    ctx.restore();
    drawOverlays(ctx, W, H, e, this.sourceName, (img) => imageFor(img.path));
  }

  /** 2D fallback (no WebGL2): fit/zoom/pan/mirror + CSS colour filters only. */
  private drawSource2d(frame: VideoFrame, e: OutputEffects): void {
    const ctx = this.ctx!;
    const W = this.canvas!.width;
    const H = this.canvas!.height;
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
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
    ctx.filter = 'none';
  }

  // ---------------- video loss ----------------
  /** Loss settings in force for this output (global, or the per-output override). */
  private lossSettings(): VideoLossSettings & { delayMs: number } {
    const g = this.env.videoLoss?.();
    const base: VideoLossSettings = g ? (g.perOutputVideoLossEnabled && this.cfg.videoLoss ? { ...DEFAULT_VIDEO_LOSS, ...this.cfg.videoLoss } : g) : DEFAULT_VIDEO_LOSS;
    return { ...DEFAULT_VIDEO_LOSS, ...base, delayMs: g ? (VIDEO_LOSS_DELAY_MS[g.delay] ?? 1000) : 1000 };
  }

  /** Source delivering frames, within the loss delay (capped at the tap's own 1 s staleness). */
  private sourceLive(): boolean {
    const src = this.source;
    if (!src || !src.current()) return false;
    const age = performance.now() - src.lastFrameAt;
    return age < Math.min(1000, this.lossSettings().delayMs);
  }

  /** Video stopped, but not for longer than the configured video-loss delay. */
  private inLossDelay(): boolean {
    const src = this.source;
    if (!src || !src.lastFrameAt) return false;
    return performance.now() - src.lastFrameAt < this.lossSettings().delayMs;
  }

  private lossKey(): string {
    const vl = this.lossSettings();
    const mode = this.cfg.lossMode;
    let extra = '';
    if (mode === 'image') extra = imageFor(this.cfg.lossImage) ? 'ok' : 'pending';
    if (mode === 'profilePicture') {
      const url = this.avatarUrl();
      extra = `${this.sourceName}:${url}:${url && avatarFor(url) ? 'ok' : 'pending'}`;
    }
    return `loss:${mode}:${this.cfg.lossImage}:${this.cfgVersion}:${mode === 'testcard' ? Math.floor(Date.now() / 1000) : 0}:${extra}:${JSON.stringify(vl)}`;
  }

  /** The participant's Meet avatar <img> in their tile, if any. */
  private avatarUrl(): string {
    const tile = this.source?.tile;
    if (!tile) return this.lastAvatar;
    for (const img of Array.from(tile.querySelectorAll('img'))) {
      const src = (img as HTMLImageElement).src;
      if (/googleusercontent\.com|\/photo/.test(src) && (img as HTMLImageElement).naturalWidth >= 32) {
        this.lastAvatar = src;
        return src;
      }
    }
    return this.lastAvatar;
  }
  private lastAvatar = '';

  /** Send the unprocessed source to the Output Effects window (key `raw:<id>`). */
  private rawPreview(frame: VideoFrame): void {
    void this.rawThumb
      .maybe(frame, frame.displayWidth, frame.displayHeight, Math.min(15, this.env.previewFps()))
      .then((j) => j && this.env.onPreview(`raw:${this.cfg.id}`, j));
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
        const img = this.cfg.lossImage ? imageFor(this.cfg.lossImage) : null;
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
    const url = vl.profilePictureForceInitials ? '' : this.avatarUrl();
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

  /** Convert + read back the canvas (GPU UYVY/BGRA, async), then submit it to NDI. */
  private startReadback(arrivedAt: number, key: string, alpha: boolean, cacheIt: boolean): void {
    if (!this.sender || !this.canvas) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!this.gpu && !this.gpuFailed) {
      this.gpu = GpuReadback.create();
      if (!this.gpu) {
        this.gpuFailed = true;
        this.env.log(`[${this.cfg.name}] WebGL2 readback unavailable; using VideoFrame.copyTo BGRA`);
      }
    }
    const fmt: PackFormat = alpha ? 'BGRA' : 'UYVY';
    if (this.gpu && !this.gpu.lost && this.gpu.start(this.canvas, W, H, fmt)) {
      this.readbackBusy = true;
      const poll = (): void => {
        this.pollTimer = 0;
        const gpu = this.gpu;
        if (!gpu) return void (this.readbackBusy = false);
        let r;
        try {
          r = gpu.poll();
        } catch (e) {
          this.env.log(`[${this.cfg.name}] readback error: ${(e as Error).message}`);
          this.readbackBusy = false;
          return;
        }
        if (!r) {
          if (gpu.pending) this.pollTimer = window.setTimeout(poll, 1);
          else this.readbackBusy = false;
          return;
        }
        this.deliver(r.buf, r.width, r.height, r.fmt, r.stride, arrivedAt, key, cacheIt, this.drawMs + r.cpuMs);
      };
      this.pollTimer = window.setTimeout(poll, 1);
      return;
    }
    if (this.gpu?.lost) {
      this.gpu = null;
      this.env.log(`[${this.cfg.name}] WebGL readback context lost; recreating`);
    }
    void this.readbackLegacy(arrivedAt, key, cacheIt);
  }

  private deliver(buf: ArrayBuffer, W: number, H: number, fmt: string, stride: number, arrivedAt: number, key: string, cacheIt: boolean, cpuMs: number): void {
    const f = this.outFormat;
    try {
      this.sender?.sendVideo(buf, W, H, fmt, stride, cacheIt ? LOSS_FPS : f.fpsN, cacheIt ? 1 : f.fpsD);
      this.noteCycle(cpuMs);
      this.noteOut(W, H, arrivedAt);
      if (cacheIt) this.cache = { buf: buf.slice(0), key, w: W, h: H, fmt, stride };
    } catch (e) {
      this.env.log(`[${this.cfg.name}] send error: ${(e as Error).message}`);
    } finally {
      this.readbackBusy = false;
    }
    // A newer frame arrived while this one was being read back.
    if (this.renderPending && this.canvasMode) this.canvasTick();
  }

  /** Fallback without WebGL2: synchronous-ish VideoFrame.copyTo BGRA. */
  private async readbackLegacy(arrivedAt: number, key: string, cacheIt: boolean): Promise<void> {
    if (!this.sender || !this.canvas || this.readbackBusy) return;
    this.readbackBusy = true;
    const t0 = performance.now();
    let vf: VideoFrame | null = null;
    try {
      const W = this.canvas.width;
      const H = this.canvas.height;
      vf = new VideoFrame(this.canvas, { timestamp: Math.round(performance.now() * 1000), alpha: 'keep' });
      let buf = this.bufPool.pop() ?? null;
      if (!buf || buf.byteLength !== W * H * 4) buf = new ArrayBuffer(W * H * 4);
      await vf.copyTo(buf, { format: 'BGRA', layout: [{ offset: 0, stride: W * 4 }] } as unknown as VideoFrameCopyToOptions);
      vf.close();
      vf = null;
      this.deliver(buf, W, H, 'BGRA', W * 4, arrivedAt, key, cacheIt, this.drawMs + performance.now() - t0);
      if (this.bufPool.length < 2) this.bufPool.push(buf);
    } catch (e) {
      this.env.log(`[${this.cfg.name}] render error: ${(e as Error).message}`);
      this.readbackBusy = false;
    } finally {
      vf?.close();
    }
  }

  /** Static content (loss/freeze) may have missed the preview throttle: thumbnail it once. */
  private refreshPreview(): void {
    const key = this.renderedKey;
    if (!key || !this.canvas || this.previewKey === key || this.readbackBusy) return;
    void this.thumb.maybe(this.canvas, this.canvas.width, this.canvas.height, this.env.previewFps()).then((j) => {
      if (j) {
        this.env.onPreview(this.cfg.id, j);
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

  // ---------------- audio ----------------
  /** Planar float32 (ch0 then ch1...). Applies gain + delay, then sends to NDI (and the recorder). */
  pushAudio(planar: Float32Array, sampleRate: number, channels: number, samples: number): void {
    if (!this.sender || !this.active || this.cfg.audio === 'off') return;
    const gain = Math.pow(10, (this.cfg.audioGainDb || 0) / 20);
    const data = this.engine === 'enabled' ? new Float32Array(planar) : new Float32Array(planar.length);
    let peak = 0;
    if (gain !== 1 || this.engine === 'enabled') {
      for (let i = 0; i < data.length; i++) {
        data[i] *= gain;
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
    }
    this.audioPeak = Math.max(peak, this.audioPeak * 0.85);
    const now = performance.now();
    this.audioQueue.push({ at: now, data, sr: sampleRate, ch: channels, n: samples });
    const delay = Math.max(0, this.cfg.audioDelayMs || 0);
    while (this.audioQueue.length && now - this.audioQueue[0].at >= delay) {
      const a = this.audioQueue.shift()!;
      this.sender.sendAudio(a.data, a.sr, a.ch, a.n);
      this.recorder?.audio(a.data, a.sr, a.ch, a.n);
    }
    if (this.audioQueue.length > 400) this.audioQueue.splice(0, this.audioQueue.length - 400);
  }

  // ---------------- recording ----------------
  private updateRecorder(): void {
    const want = this.cfg.record && this.active && this.engine === 'enabled';
    if (want && !this.recorder) {
      this.recorder = new Recorder(this.cfg.name, this.env.recordDir(), this.env.log, this.cfg.audio !== 'off');
    } else if (!want && this.recorder) {
      void this.recorder.stop();
      this.recorder = null;
    }
  }

  // ---------------- state ----------------
  state(): OutputState {
    const now = performance.now();
    while (this.outTimes.length && now - this.outTimes[0] > 1000) this.outTimes.shift();
    const st = this.sender?.stats();
    // Clocked outputs: report what NDI actually emits (incl. repeated frames).
    if (st && st.clocked) {
      const ns = this.nativeSent;
      if (ns.n >= 0 && now - ns.t >= 500) {
        ns.fps = ((st.sent - ns.n) * 1000) / (now - ns.t);
        ns.n = st.sent;
        ns.t = now;
      } else if (ns.n < 0 || st.sent < ns.n) {
        ns.n = st.sent;
        ns.t = now;
      }
    } else {
      this.nativeSent = { n: -1, t: 0, fps: 0 };
    }
    const live = this.sourceLive() || (this.inLossDelay() && (this.hasDrawnSource || !!this.lastPass));
    const status = !this.active ? 'off' : this.engine === 'standby' ? 'standby' : live ? 'live' : 'loss';
    return {
      id: this.cfg.id,
      name: this.cfg.name,
      live: status === 'live',
      sourceKey: this.source?.key ?? null,
      sourceName: this.sourceName,
      status,
      inWidth: live ? (this.source?.width ?? 0) : 0,
      inHeight: live ? (this.source?.height ?? 0) : 0,
      inFps: live ? (this.source?.fps() ?? 0) : 0,
      outWidth: this.outW,
      outHeight: this.outH,
      outFps: st?.clocked ? Math.round(this.nativeSent.fps * 100) / 100 : this.outTimes.length,
      connections: st?.connections ?? 0,
      program: st?.program ?? false,
      preview: st?.preview ?? false,
      latencyMs: Math.round(this.latency),
      cycleMs: Math.round(this.cycle * 10) / 10,
      audioLevel: Math.round(this.audioPeak * 1000) / 1000,
      recording: !!this.recorder,
      recordFile: this.recorder?.file ?? '',
    };
  }

  dispose(): void {
    window.clearInterval(this.timer);
    window.clearTimeout(this.pollTimer);
    this.gpu?.dispose();
    this.gpu = null;
    window.clearInterval(this.lossTimer);
    this.unsubscribe?.();
    void this.recorder?.stop();
    this.recorder = null;
    this.sender?.destroy();
    if (this.sender) this.env.log(`NDI source down: "${this.senderName}"`);
    this.sender = null;
  }
}
