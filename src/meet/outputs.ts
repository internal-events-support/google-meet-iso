// Output slots (main-thread side): a stable NDI source each, fed from whichever participant the
// slot is routed to. The video itself is rendered by the engine (render.ts via engine.ts, in the
// render worker when available): this side owns the native NDI sender (zero-copy hand-off of the
// engine's finished buffers + the cadence clock), embedded audio, the MP4 recorder and the
// output's state for the UI.

import type { EngineState, GlobalVideoLossSettings, OutputConfig, OutputState } from '../shared/types';
import type { NativeNdi, NativeSender } from './native';
import type { SourceTap } from './sources';
import type { EngineClient } from './engineclient';
import { isCanvasMode, LOSS_FPS, outFormatOf, type RenderConfig, type RenderStats } from './render';
import { Recorder } from './recorder';

export interface OutputEnv {
  ndi: NativeNdi;
  groups: () => string;
  previewFps: () => number;
  recordDir: () => string;
  log: (s: string) => void;
  engine: EngineClient;
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
  /** Passthrough: the native clock is repeating the last frame (freeze / loss content). */
  private passCadence = false;
  /** Last render config sent to the engine (JSON), to send only changes. */
  private sentRc = '';
  private lastAvatar = '';
  private timer: number;
  private stats: RenderStats | null = null;

  /** Native (clocked) send rate, from sender.stats().sent deltas. */
  private nativeSent = { n: -1, t: 0, fps: 0 };
  private audioPeak = 0;
  private recorder: Recorder | null = null;

  // audio delay line
  private audioQueue: { at: number; data: Float32Array; sr: number; ch: number; n: number }[] = [];

  constructor(
    cfg: OutputConfig,
    private env: OutputEnv,
  ) {
    this.cfg = cfg;
    this.reconfigure();
    // Sender retry, avatar refresh (profilePicture loss mode).
    this.timer = window.setInterval(() => {
      if (this.active && !this.sender) this.reconfigure();
      else if (this.cfg.lossMode === 'profilePicture') this.pushConfig();
    }, 1000);
  }

  get id(): string {
    return this.cfg.id;
  }

  private get active(): boolean {
    return this.cfg.enabled && this.engine !== 'disabled';
  }

  setConfig(cfg: OutputConfig): void {
    const prev = this.cfg;
    this.cfg = cfg;
    if (prev.name !== cfg.name || prev.enabled !== cfg.enabled || JSON.stringify(prev.format) !== JSON.stringify(cfg.format) || isCanvasMode(prev) !== isCanvasMode(cfg)) {
      this.reconfigure();
    }
    if (prev.record !== cfg.record) this.updateRecorder();
    this.pushConfig();
  }

  setEngine(state: EngineState): void {
    if (state === this.engine) return;
    this.engine = state;
    this.reconfigure();
    this.updateRecorder();
    this.pushConfig();
  }

  /** Route a source (or nothing) into this output. */
  bind(src: SourceTap | null): void {
    if (src === this.source) {
      if (src && src.displayName !== this.sourceName) {
        this.sourceName = src.displayName;
        this.pushConfig();
      }
      return;
    }
    this.source = src;
    this.sourceName = src?.displayName ?? '';
    this.env.engine.send({ t: 'bind', id: this.id, source: src?.key ?? null });
    this.pushConfig();
  }

  get boundKey(): string | null {
    return this.source?.key ?? null;
  }

  /** Send the render config to the engine when anything in it changed. */
  private pushConfig(): void {
    const rc: RenderConfig = {
      cfg: this.cfg,
      engine: this.engine,
      sourceName: this.sourceName,
      avatarUrl: this.cfg.lossMode === 'profilePicture' ? this.avatarUrl() : '',
      previewFps: this.env.previewFps(),
      videoLoss: this.env.videoLoss?.() ?? null,
      recording: !!this.recorder,
      senderReady: !!this.sender,
    };
    const json = JSON.stringify(rc);
    if (json === this.sentRc) return;
    this.sentRc = json;
    this.env.engine.send({ t: 'out', id: this.id, rc });
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

  /** Canvas outputs are clocked natively at the configured rate; passthrough sends on arrival. */
  private applyCadence(): void {
    const s = this.sender;
    this.passCadence = false;
    if (!s || typeof s.setCadence !== 'function') return;
    if (this.active && isCanvasMode(this.cfg)) {
      const f = outFormatOf(this.cfg);
      s.setCadence(f.fpsN, f.fpsD);
    } else {
      s.setCadence(0, 0);
    }
  }

  private reconfigure(): void {
    this.ensureSender();
    this.applyCadence();
    this.pushConfig();
  }

  // ---------------- from the engine ----------------
  /** A finished frame: hand it to NDI without a copy; buffers the sender released go back to the engine. */
  submit(buf: ArrayBuffer, w: number, h: number, fmt: string, stride: number, fpsN?: number, fpsD?: number): void {
    const s = this.sender;
    let back: ArrayBuffer[];
    if (!s) back = [buf];
    else if (typeof s.sendVideoOwned === 'function') back = s.sendVideoOwned(buf, w, h, fmt, stride, fpsN, fpsD);
    else {
      s.sendVideo(buf, w, h, fmt, stride, fpsN, fpsD);
      back = [buf];
    }
    if (back.length) this.env.engine.send({ t: 'bufs', id: this.id, bufs: back }, back);
  }

  /** Passthrough: let the native clock repeat the last frame (on) or send on arrival again (off). */
  setPassCadence(on: boolean): void {
    if (on === this.passCadence || !this.sender || typeof this.sender.setCadence !== 'function' || isCanvasMode(this.cfg)) return;
    this.passCadence = on;
    this.sender.setCadence(on ? LOSS_FPS : 0, on ? 1 : 0);
  }

  /** A composed frame for the MP4 recorder (closed here). */
  record(frame: VideoFrame, w: number, h: number): void {
    try {
      this.recorder?.video(frame, w, h);
    } finally {
      frame.close();
    }
  }

  setStats(st: RenderStats | undefined): void {
    if (st) this.stats = st;
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
    const r = this.stats;
    const live = !!r?.live;
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
      outWidth: r?.outW ?? 0,
      outHeight: r?.outH ?? 0,
      outFps: st?.clocked ? Math.round(this.nativeSent.fps * 100) / 100 : (r?.outFps ?? 0),
      connections: st?.connections ?? 0,
      program: st?.program ?? false,
      preview: st?.preview ?? false,
      latencyMs: r?.latencyMs ?? 0,
      cycleMs: r?.cycleMs ?? 0,
      nativeSubmitted: st?.received,
      nativeSent: st?.sent,
      nativeLate: st?.late,
      nativeDropped: st?.dropped,
      audioLevel: Math.round(this.audioPeak * 1000) / 1000,
      recording: !!this.recorder,
      recordFile: this.recorder?.file ?? '',
    };
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.env.engine.send({ t: 'remove', id: this.id });
    void this.recorder?.stop();
    this.recorder = null;
    this.sender?.destroy();
    if (this.sender) this.env.log(`NDI source down: "${this.senderName}"`);
    this.sender = null;
  }
}
