// Participant sources: one tap per Meet tile. Reads the tile's live video track with
// MediaStreamTrackProcessor (independent of the offscreen paint rate) and keeps the latest
// VideoFrame for any number of outputs to render from. Reading runs in a worker on a clone of the
// track (see trackworker.ts); main-thread MSTP is the fallback.

import type { FeedKind } from '../shared/types';
import { pickVideo } from './dom';
import { Thumbnailer } from './camsource';
import { readInWorker } from './trackworker';

// Chrome-only Insertable Streams API (not in TS's DOM lib).
declare const MediaStreamTrackProcessor: {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> };
};

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

/** Listener gets a frame it must NOT close or keep (clone it if needed). */
export type FrameListener = (frame: VideoFrame, arrivedAt: number) => void;

export class SourceTap {
  readonly key: string;
  readonly participantId: string;
  readonly kind: FeedKind;
  readonly createdAt = performance.now();
  displayName: string;
  hasName = false;
  isSelf = false;
  tile: HTMLElement | null = null;
  lastSeen = performance.now();
  muted: boolean | null = null;
  handRaised = false;

  width = 0;
  height = 0;
  lastFrameAt = 0;
  private latest: VideoFrame | null = null;
  private latestAt = 0;
  private listeners = new Set<FrameListener>();
  private frameTimes: number[] = [];
  private video: RVFCVideo | null = null;
  private trackId = '';
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private readerToken = 0;
  private stopWorker: (() => void) | null = null;
  /** 'worker' | 'main' | 'element' | '' — which capture path is active (diagnostics). */
  capturePath = '';
  private rvfcHandle: number | null = null;
  private fallbackTimer = 0;
  private thumb = new Thumbnailer(240);

  constructor(
    init: { key: string; participantId: string; kind: FeedKind; displayName: string },
    private log: (s: string) => void,
    private onThumb: (key: string, jpeg: ArrayBuffer) => void,
    private thumbFps: () => number,
  ) {
    this.key = init.key;
    this.participantId = init.participantId;
    this.kind = init.kind;
    this.displayName = init.displayName;
  }

  get videoTrackId(): string {
    return this.trackId;
  }

  /** Latest frame (owned by the tap; valid until the next frame arrives). */
  current(): { frame: VideoFrame; at: number } | null {
    return this.latest ? { frame: this.latest, at: this.latestAt } : null;
  }

  /** Has video arrived recently? */
  get live(): boolean {
    return !!this.latest && performance.now() - this.lastFrameAt < 1000;
  }

  fps(): number {
    const now = performance.now();
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    return this.frameTimes.length;
  }

  subscribe(l: FrameListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  bindTile(tile: HTMLElement | null): void {
    this.tile = tile;
    if (tile) this.lastSeen = performance.now();
    const v = tile ? (pickVideo(tile) as RVFCVideo | null) : null;
    const src = v?.srcObject;
    const track = src instanceof MediaStream ? (src.getVideoTracks()[0] ?? null) : null;
    const newTrackId = track && track.readyState === 'live' ? track.id : '';
    if (v !== this.video || newTrackId !== this.trackId) {
      this.detach();
      this.video = v;
      if (track && newTrackId && typeof MediaStreamTrackProcessor === 'function') {
        this.trackId = newTrackId;
        if (!this.readInWorker(track)) void this.readTrack(track);
      } else if (v) {
        this.capturePath = 'element';
        // Fallback: snapshot the element at ~30 fps.
        this.fallbackTimer = window.setInterval(() => {
          if (!this.video || this.video.readyState < 2) return;
          try {
            this.accept(new VideoFrame(this.video));
          } catch {
            /* not ready */
          }
        }, 33);
      }
    }
    // Drop the held frame when the camera goes away so outputs switch to loss mode.
    if (!v && this.latest && performance.now() - this.lastFrameAt > 1500) {
      this.latest.close();
      this.latest = null;
    }
  }

  private detach(): void {
    this.readerToken++;
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.stopWorker?.();
    this.stopWorker = null;
    this.trackId = '';
    this.capturePath = '';
    if (this.fallbackTimer) window.clearInterval(this.fallbackTimer);
    this.fallbackTimer = 0;
    if (this.video && this.rvfcHandle != null) this.video.cancelVideoFrameCallback?.(this.rvfcHandle);
    this.rvfcHandle = null;
    this.video = null;
  }

  private readInWorker(track: MediaStreamTrack): boolean {
    const token = ++this.readerToken;
    const stop = readInWorker(
      track,
      {
        onFrame: (f) => {
          if (token !== this.readerToken) f.close();
          else this.accept(f);
        },
        onEnd: (err) => {
          if (token !== this.readerToken) return;
          if (err) this.log(`worker track reader [${this.displayName}]: ${err}`);
          this.stopWorker = null;
          this.trackId = ''; // next bindTile re-reads if the track is still live
        },
      },
      this.log,
    );
    if (!stop) return false;
    this.stopWorker = stop;
    this.capturePath = 'worker';
    this.log(`capture [${this.displayName}]: worker ${track.id.slice(0, 8)}`);
    return true;
  }

  private async readTrack(track: MediaStreamTrack): Promise<void> {
    const token = ++this.readerToken;
    this.capturePath = 'main';
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
        this.accept(value);
      }
    } catch (e) {
      if (token === this.readerToken) this.log(`track reader [${this.displayName}]: ${(e as Error).message}`);
    }
    if (token === this.readerToken) this.trackId = '';
  }

  /** Takes ownership of `frame`. */
  private accept(frame: VideoFrame): void {
    const now = performance.now();
    const rect = frame.visibleRect;
    this.width = rect?.width ?? frame.displayWidth;
    this.height = rect?.height ?? frame.displayHeight;
    this.lastFrameAt = now;
    this.frameTimes.push(now);
    for (const l of this.listeners) {
      try {
        l(frame, now);
      } catch (e) {
        this.log(`frame listener error: ${(e as Error).message}`);
      }
    }
    void this.thumb.maybe(frame, this.width, this.height, this.thumbFps()).then((j) => j && this.onThumb(`src:${this.key}`, j));
    this.latest?.close();
    this.latest = frame;
    this.latestAt = now;
  }

  dispose(): void {
    this.detach();
    this.latest?.close();
    this.latest = null;
    this.listeners.clear();
  }
}
