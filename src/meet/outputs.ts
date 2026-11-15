// Output slots: a stable NDI source each, fed from whichever participant the slot is
// routed to. Two render paths:
//   - passthrough (format = native, no effects): copy Meet's decoded frames as-is (I420/NV12)
//   - canvas (fixed format and/or effects): draw at a fixed cadence into an OffscreenCanvas
//     (letterbox/scale, colour, crop/zoom, mirror, name tag) and read back BGRA.
// When the source has no video, the slot renders its loss mode (black/freeze/transparent/
// image/testcard) so downstream switchers always see a stable signal.

import * as fs from 'fs';
import type { EngineState, OutputConfig, OutputState } from '../shared/types';
import { DEFAULT_EFFECTS } from '../shared/types';
import { Thumbnailer } from './camsource';
import type { NativeNdi, NativeSender } from './native';
import type { SourceTap } from './sources';
import { Recorder } from './recorder';

const LOSS_FPS = 10;

function effectsActive(cfg: OutputConfig): boolean {
  const e = cfg.effects ?? DEFAULT_EFFECTS;
  return (
    e.brightness !== 1 ||
    e.contrast !== 1 ||
    e.saturation !== 1 ||
    e.hue !== 0 ||
    e.zoom !== 1 ||
    e.panX !== 0 ||
    e.panY !== 0 ||
    e.mirror ||
    e.nameTag
  );
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
  private tickCount = 0;
  private tickStart = 0;
  private readbackBusy = false;
  private hasDrawnSource = false;
  /** Last rendered BGRA frame + what it showed; re-sent when nothing changed (cheap ticks). */
  private cache: { buf: ArrayBuffer; key: string; w: number; h: number } | null = null;
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
  private outW = 0;
  private outH = 0;
  private latency = 0;
  private audioPeak = 0;
  private thumb = new Thumbnailer(320);
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
    } catch (e) {
      this.nextSenderAttempt = performance.now() + 5000;
      this.env.log(`NDI sender create failed for "${want}": ${(e as Error).message}`);
    }
  }

  private reconfigure(): void {
    window.clearTimeout(this.timer);
    window.clearInterval(this.lossTimer);
    this.timer = 0;
    this.lossTimer = 0;
    this.ensureSender();
    if (!this.active) return;
    if (this.canvasMode) {
      const f = this.cfg.format ?? { width: 1280, height: 720, fpsN: 30000, fpsD: 1001 };
      this.setupCanvas(f.width, f.height);
      this.tickStart = performance.now();
      this.tickCount = 0;
      this.scheduleTick();
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
      await frame.copyTo(buf, opts as VideoFrameCopyToOptions);
      this.sender?.sendVideo(buf, w, h, ndiFmt, layout[0].stride);
      if (this.cfg.lossMode === 'freeze') this.lastPass = { buf: buf.slice(0), w, h, fmt: ndiFmt, stride: layout[0].stride };
      else this.lastPass = { buf: this.lastPass?.buf ?? new ArrayBuffer(0), w, h, fmt: ndiFmt, stride: layout[0].stride };
      this.noteOut(w, h, arrivedAt);
      this.recorder?.video(frame, w, h);
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
    const sourceLive = this.source?.live && this.engine === 'enabled';
    if (sourceLive) return;
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
    const key = `ploss:${this.cfg.lossMode}:${this.cfg.lossImage}:${this.cfgVersion}:${this.cfg.lossMode === 'testcard' ? Math.floor(Date.now() / 1000) : 0}`;
    const W = this.canvas!.width;
    const H = this.canvas!.height;
    if (this.cache && this.cache.key === key && this.cache.w === W && this.cache.h === H) {
      this.sender.sendVideo(this.cache.buf, W, H, 'BGRA', W * 4, 10, 1);
      this.noteOut(W, H, performance.now());
      this.refreshPreview();
      return;
    }
    this.drawLoss();
    void this.readbackAndSend(performance.now(), 10, 1, key);
  }

  // ---------------- canvas path ----------------
  private scheduleTick(): void {
    const f = this.cfg.format ?? { width: 1280, height: 720, fpsN: 30000, fpsD: 1001 };
    const interval = (1000 * f.fpsD) / f.fpsN;
    this.tickCount++;
    const due = this.tickStart + this.tickCount * interval;
    const delay = Math.max(0, due - performance.now());
    // If we fell far behind (e.g. a GC pause), resync instead of bursting.
    if (performance.now() - due > interval * 4) {
      this.tickStart = performance.now();
      this.tickCount = 0;
    }
    this.timer = window.setTimeout(() => {
      this.canvasTick();
      if (this.active && this.canvasMode) this.scheduleTick();
    }, delay);
  }

  private canvasTick(): void {
    if (!this.sender) this.ensureSender();
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;
    const cur = this.engine === 'enabled' ? this.source?.current() : null;
    const live = !!cur && !!this.source?.live;
    const f = this.cfg.format ?? { width: this.canvas.width, height: this.canvas.height, fpsN: 30000, fpsD: 1001 };
    const W = this.canvas.width;
    const H = this.canvas.height;
    // What would this tick show? If identical to the cached frame, just re-send it: sources
    // usually arrive slower than the output rate, and loss content is static.
    const freeze = !live && this.cfg.lossMode === 'freeze' && this.hasDrawnSource && this.engine === 'enabled';
    const key = live
      ? `src:${cur!.at}:${this.sourceName}:${this.cfgVersion}`
      : freeze
        ? (this.cache?.key ?? 'freeze')
        : `loss:${this.cfg.lossMode}:${this.cfg.lossImage}:${this.cfgVersion}:${this.cfg.lossMode === 'testcard' ? Math.floor(Date.now() / 1000) : 0}:${this.cfg.lossMode === 'image' && !imageFor(this.cfg.lossImage) ? 'pending' : 'ok'}`;
    // A readback still in flight will send this slot's frame when it completes.
    if (this.readbackBusy) return;
    if (this.cache && this.cache.key === key && this.cache.w === W && this.cache.h === H) {
      this.sender?.sendVideo(this.cache.buf, W, H, 'BGRA', W * 4, f.fpsN, f.fpsD);
      this.noteOut(W, H, live ? cur!.at : performance.now());
      this.refreshPreview();
      return;
    }
    let arrivedAt = performance.now();
    if (live && cur) {
      this.drawSource(cur.frame);
      this.hasDrawnSource = true;
      arrivedAt = cur.at;
    } else if (!freeze) {
      this.drawLoss();
    }
    void this.readbackAndSend(arrivedAt, f.fpsN, f.fpsD, key);
  }

  private drawSource(frame: VideoFrame): void {
    const ctx = this.ctx!;
    const W = this.canvas!.width;
    const H = this.canvas!.height;
    const e = { ...DEFAULT_EFFECTS, ...(this.cfg.effects ?? {}) };
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    // Fit (contain), then zoom about the centre and pan.
    const fit = Math.min(W / sw, H / sh) * Math.max(0.1, e.zoom);
    const dw = sw * fit;
    const dh = sh * fit;
    const maxPanX = Math.max(0, (dw - W) / 2);
    const maxPanY = Math.max(0, (dh - H) / 2);
    const dx = (W - dw) / 2 - e.panX * maxPanX;
    const dy = (H - dh) / 2 - e.panY * maxPanY;
    const filters: string[] = [];
    if (e.brightness !== 1) filters.push(`brightness(${e.brightness})`);
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
    if (e.nameTag) this.drawNameTag(e.nameTagText || this.sourceName, e.nameTagSubtitle, e.nameTagPosition);
  }

  private drawNameTag(title: string, subtitle: string, pos: string): void {
    if (!title) return;
    const ctx = this.ctx!;
    const W = this.canvas!.width;
    const H = this.canvas!.height;
    const size = Math.round(H * 0.045);
    const sub = Math.round(size * 0.7);
    ctx.save();
    ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
    const tw = ctx.measureText(title).width;
    ctx.font = `400 ${sub}px "Segoe UI", system-ui, sans-serif`;
    const sw = subtitle ? ctx.measureText(subtitle).width : 0;
    const pad = Math.round(size * 0.55);
    const boxW = Math.max(tw, sw) + pad * 2;
    const boxH = size + (subtitle ? sub + size * 0.25 : 0) + pad * 1.2;
    const margin = Math.round(H * 0.05);
    const x = pos.endsWith('r') ? W - margin - boxW : margin;
    const y = pos.startsWith('t') ? margin : H - margin - boxH;
    ctx.fillStyle = 'rgba(10,12,16,0.78)';
    ctx.fillRect(x, y, boxW, boxH);
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(x, y, Math.max(4, size * 0.12), boxH);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'top';
    ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(title, x + pad, y + pad * 0.6);
    if (subtitle) {
      ctx.fillStyle = '#c9d1dc';
      ctx.font = `400 ${sub}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(subtitle, x + pad, y + pad * 0.6 + size * 1.15);
    }
    ctx.restore();
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
      default:
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
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

  private async readbackAndSend(arrivedAt: number, fpsN: number, fpsD: number, key = ''): Promise<void> {
    if (!this.sender || !this.canvas || this.readbackBusy) return;
    this.readbackBusy = true;
    let vf: VideoFrame | null = null;
    try {
      const W = this.canvas.width;
      const H = this.canvas.height;
      vf = new VideoFrame(this.canvas, { timestamp: Math.round(performance.now() * 1000), alpha: 'keep' });
      // Alternate between two buffers: one is the cache being re-sent, the other is filled.
      let buf = this.bufPool.pop() ?? null;
      if (!buf || buf.byteLength !== W * H * 4) buf = new ArrayBuffer(W * H * 4);
      await vf.copyTo(buf, { format: 'BGRA', layout: [{ offset: 0, stride: W * 4 }] } as unknown as VideoFrameCopyToOptions);
      this.sender?.sendVideo(buf, W, H, 'BGRA', W * 4, fpsN, fpsD);
      if (this.cache && this.cache.buf.byteLength === W * H * 4 && this.bufPool.length < 2) this.bufPool.push(this.cache.buf);
      this.cache = { buf, key, w: W, h: H };
      this.noteOut(W, H, arrivedAt);
      this.recorder?.video(vf, W, H);
      const shownKey = key;
      void this.thumb.maybe(vf, W, H, this.env.previewFps()).then((j) => {
        if (!j) return;
        this.env.onPreview(this.cfg.id, j);
        this.previewKey = shownKey;
      });
    } catch (e) {
      this.env.log(`[${this.cfg.name}] render error: ${(e as Error).message}`);
    } finally {
      vf?.close();
      this.readbackBusy = false;
    }
  }

  /** Static content (loss/freeze) may have missed the preview throttle: thumbnail it once. */
  private refreshPreview(): void {
    if (!this.cache || !this.canvas || this.previewKey === this.cache.key) return;
    const key = this.cache.key;
    let vf: VideoFrame;
    try {
      vf = new VideoFrame(this.canvas, { timestamp: 0 });
    } catch {
      return;
    }
    void this.thumb
      .maybe(vf, this.canvas.width, this.canvas.height, this.env.previewFps())
      .then((j) => {
        if (j) {
          this.env.onPreview(this.cfg.id, j);
          this.previewKey = key;
        }
      })
      .finally(() => vf.close());
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
    const live = !!this.source?.live;
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
      outFps: this.outTimes.length,
      connections: st?.connections ?? 0,
      program: st?.program ?? false,
      preview: st?.preview ?? false,
      latencyMs: Math.round(this.latency),
      audioLevel: Math.round(this.audioPeak * 1000) / 1000,
      recording: !!this.recorder,
      recordFile: this.recorder?.file ?? '',
    };
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    window.clearInterval(this.lossTimer);
    this.unsubscribe?.();
    void this.recorder?.stop();
    this.recorder = null;
    this.sender?.destroy();
    if (this.sender) this.env.log(`NDI source down: "${this.senderName}"`);
    this.sender = null;
  }
}
