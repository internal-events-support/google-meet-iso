// Per-feed capture: follows a Meet tile's live <video>, grabs frames as WebCodecs
// VideoFrames and pushes them straight into the native NDI sender (no IPC hop).
//
// Primary path: MediaStreamTrackProcessor on the tile's video track — delivers every
// decoded frame independent of page painting (the Meet page is rendered offscreen, where
// requestVideoFrameCallback only fires at the paint rate). Fallback: element snapshots.

import type { FeedKind, FeedState } from '../shared/types';
import { pickVideo } from './dom';
import { Thumbnailer } from './camsource';

export interface NativeSender {
  sendVideo(data: ArrayBuffer | Uint8Array, w: number, h: number, fmt: string, stride?: number): boolean;
  stats(): { connections: number; slate: boolean; dropped: number; sent: number; width: number; height: number };
  destroy(): void;
}

export interface NativeNdi {
  load(): { ok: boolean; version?: string; error?: string; path?: string };
  Sender: new (name: string, opts?: { idleMs?: number; groups?: string; slateWidth?: number; slateHeight?: number }) => NativeSender;
}

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

// Chrome-only Insertable Streams API (not in TS's DOM lib).
declare const MediaStreamTrackProcessor: {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> };
};

export class FeedCapture {
  readonly key: string;
  readonly participantId: string;
  readonly kind: FeedKind;
  displayName: string;
  ndiName: string | null = null;
  enabled = true;

  tile: HTMLElement | null = null;
  lastSeen = performance.now();

  private sender: NativeSender | null = null;
  private video: RVFCVideo | null = null;
  private rvfcHandle: number | null = null;
  /** Up to 2 frame readbacks in flight; GPU-backed frames need an async copy. */
  private inFlight = 0;
  private bufPool: ArrayBuffer[] = [];
  private seq = 0;
  private lastSentSeq = 0;
  private copyMs = 0;
  private lastCapture = 0;
  private frameTimes: number[] = [];
  private lastW = 0;
  private lastH = 0;
  private lastFmt = '';
  private thumb = new Thumbnailer(320);
  private watchdog: number;
  private trackId = '';
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private readerToken = 0;

  constructor(
    private ndi: NativeNdi,
    init: { key: string; participantId: string; kind: FeedKind; displayName: string },
    private opts: () => { maxFps: number; groups: string; previewFps: number },
    private log: (s: string) => void,
    private onPreview: (key: string, jpeg: ArrayBuffer) => void = () => {},
  ) {
    this.key = init.key;
    this.participantId = init.participantId;
    this.kind = init.kind;
    this.displayName = init.displayName;
    // Fallback driver for when requestVideoFrameCallback stalls (e.g. window occluded).
    this.watchdog = window.setInterval(() => this.onWatchdog(), 50);
  }

  /** Create (or re-create under a new name) the NDI source. */
  private nextPublishAttempt = 0;

  publish(ndiName: string): void {
    if (this.sender && this.ndiName === ndiName) return;
    // Back off after a failure (e.g. name already taken by another process) instead of
    // retrying every scanner tick.
    if (!this.sender && performance.now() < this.nextPublishAttempt) return;
    this.unpublish();
    this.nextPublishAttempt = performance.now() + 5000;
    try {
      const groups = this.opts().groups.trim();
      this.sender = new this.ndi.Sender(ndiName, { idleMs: 1000, ...(groups ? { groups } : {}) });
      this.ndiName = ndiName;
      this.log(`NDI source up: "${ndiName}"`);
    } catch (e) {
      this.log(`NDI sender create failed for "${ndiName}": ${(e as Error).message}`);
      this.sender = null;
      this.ndiName = null;
    }
  }

  unpublish(): void {
    if (this.sender) {
      this.sender.destroy();
      this.log(`NDI source down: "${this.ndiName}"`);
    }
    this.sender = null;
    this.ndiName = null;
  }

  get published(): boolean {
    return !!this.sender;
  }

  /** Called by the scanner every tick with the tile's current element (or null if gone). */
  bindTile(tile: HTMLElement | null): void {
    this.tile = tile;
    if (tile) this.lastSeen = performance.now();
    const v = tile ? (pickVideo(tile) as RVFCVideo | null) : null;
    const src = v?.srcObject;
    const track = src instanceof MediaStream ? (src.getVideoTracks()[0] ?? null) : null;
    const newTrackId = track && track.readyState === 'live' ? track.id : '';
    if (v !== this.video || newTrackId !== this.trackId) {
      this.detachVideo();
      this.video = v;
      if (track && newTrackId && typeof MediaStreamTrackProcessor === 'function') {
        this.trackId = newTrackId;
        void this.readTrack(track);
      } else if (v) {
        this.scheduleRvfc();
      }
    }
  }

  private detachVideo(): void {
    if (this.video && this.rvfcHandle != null) this.video.cancelVideoFrameCallback?.(this.rvfcHandle);
    this.rvfcHandle = null;
    this.video = null;
    this.trackId = '';
    this.readerToken++;
    this.reader?.cancel().catch(() => {});
    this.reader = null;
  }

  private async readTrack(track: MediaStreamTrack): Promise<void> {
    const token = ++this.readerToken;
    try {
      const proc = new MediaStreamTrackProcessor({ track, maxBufferSize: 2 });
      const reader = proc.readable.getReader();
      this.reader = reader;
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        if (token !== this.readerToken) {
          value.close();
          break;
        }
        void this.handleFrame(value);
      }
    } catch (e) {
      if (token === this.readerToken) this.log(`track reader [${this.displayName}]: ${(e as Error).message}`);
    }
    // Track ended: next bindTile() tick re-binds (possibly via the element fallback).
    if (token === this.readerToken) this.trackId = '';
  }

  private scheduleRvfc(): void {
    const v = this.video;
    if (!v?.requestVideoFrameCallback) return;
    this.rvfcHandle = v.requestVideoFrameCallback(() => {
      if (v !== this.video) return;
      void this.capture();
      this.scheduleRvfc();
    });
  }

  private onWatchdog(): void {
    const v = this.video;
    if (!v || v.readyState < 2 || this.trackId) return;
    // Only kick in if the primary rVFC path has gone quiet.
    if (performance.now() - this.lastCapture > 150) void this.capture();
  }

  /** Element-snapshot fallback path. */
  private async capture(): Promise<void> {
    const v = this.video;
    if (!v || !this.sender || !this.enabled || this.inFlight >= 2) return;
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(v);
    } catch {
      return;
    }
    await this.handleFrame(frame);
  }

  /** Takes ownership of `frame` (always closes it). */
  private async handleFrame(frame: VideoFrame): Promise<void> {
    if (!this.sender || !this.enabled || this.inFlight >= 2) {
      frame.close();
      return;
    }
    const now = performance.now();
    // Rolling-window rate cap: tolerant of source jitter (a strict min-interval gate
    // throws away ~1/3 of frames from a jittery 30 fps source).
    const maxFps = Math.max(1, this.opts().maxFps);
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    if (now - this.lastCapture < 500 / maxFps || this.frameTimes.length >= maxFps) {
      frame.close();
      return;
    }
    this.inFlight++;
    this.lastCapture = now;
    const mySeq = ++this.seq;
    let buf: ArrayBuffer | null = null;
    try {
      const rect = frame.visibleRect!;
      const w = rect.width;
      const h = rect.height;
      if (w === 0 || h === 0) return;
      const even = w % 2 === 0 && h % 2 === 0 && rect.x % 2 === 0 && rect.y % 2 === 0;
      const fmt = frame.format;
      let ndiFmt: string;
      let size: number;
      let layout: PlaneLayout[];
      let copyOpts: Record<string, unknown>;
      if (even && fmt === 'I420') {
        // Tightly packed planar I420 — NDI takes it natively, no colour conversion.
        ndiFmt = 'I420';
        size = (w * h * 3) / 2;
        layout = [
          { offset: 0, stride: w },
          { offset: w * h, stride: w / 2 },
          { offset: (w * h * 5) / 4, stride: w / 2 },
        ];
        copyOpts = { rect, layout };
      } else if (even && fmt === 'NV12') {
        ndiFmt = 'NV12';
        size = (w * h * 3) / 2;
        layout = [
          { offset: 0, stride: w },
          { offset: w * h, stride: w },
        ];
        copyOpts = { rect, layout };
      } else {
        // GPU-backed frames (format null) or exotic formats: let Chrome convert to BGRA.
        ndiFmt = 'BGRA';
        size = w * h * 4;
        layout = [{ offset: 0, stride: w * 4 }];
        copyOpts = { rect, layout, format: 'BGRA' };
      }
      buf = this.bufPool.pop() ?? null;
      if (!buf || buf.byteLength !== size) buf = new ArrayBuffer(size);
      const t0 = performance.now();
      await frame.copyTo(buf, copyOpts as VideoFrameCopyToOptions);
      this.copyMs = this.copyMs * 0.9 + (performance.now() - t0) * 0.1;
      // Never send a frame older than one already sent.
      if (mySeq < this.lastSentSeq) return;
      this.lastSentSeq = mySeq;
      this.sender?.sendVideo(buf, w, h, ndiFmt, layout[0].stride); // native side memcpy's
      // Thumbnail draws synchronously before its first await, so `frame` is still open.
      void this.thumb.maybe(frame, w, h, this.opts().previewFps).then((jpg) => jpg && this.onPreview(this.key, jpg));
      this.lastFmt = `${fmt ?? 'gpu'}->${ndiFmt}`;
      this.lastW = w;
      this.lastH = h;
      this.frameTimes.push(now);
    } catch (e) {
      this.log(`capture error [${this.displayName}]: ${(e as Error).message}`);
    } finally {
      frame.close();
      if (buf && this.bufPool.length < 2) this.bufPool.push(buf);
      this.inFlight--;
    }
  }

  state(): FeedState {
    const now = performance.now();
    this.frameTimes = this.frameTimes.filter((t) => now - t < 1000);
    const st = this.sender?.stats();
    return {
      key: this.key,
      participantId: this.participantId,
      displayName: this.displayName,
      ndiName: this.ndiName,
      kind: this.kind,
      enabled: this.enabled,
      present: !!this.tile,
      hasVideo: !!this.video,
      width: this.lastW,
      height: this.lastH,
      fps: this.frameTimes.length,
      connections: st?.connections ?? 0,
      slate: st?.slate ?? true,
      dropped: st?.dropped ?? 0,
      copyMs: Math.round(this.copyMs * 10) / 10,
      format: this.lastFmt,
    };
  }

  dispose(): void {
    window.clearInterval(this.watchdog);
    this.detachVideo();
    this.unpublish();
  }
}
