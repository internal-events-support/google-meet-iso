// Participant sources: one tap per Meet tile. The tile's live video track is read with
// MediaStreamTrackProcessor (independent of the offscreen paint rate) by the video engine:
// in the render worker when possible (a clone of the track, so Meet's own <video> keeps
// playing), so frames never reach this thread. Fallbacks read here and hand frames over:
// main-thread MSTP, then snapshots of the <video> element. Size/fps/liveness come back from
// the engine's stats.

import type { FeedKind } from '../shared/types';
import { pickVideo } from './dom';
import type { EngineClient } from './engineclient';
import type { SourceStats } from './engine';

// Chrome-only Insertable Streams API (not in TS's DOM lib).
declare const MediaStreamTrackProcessor: {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> };
};

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
  private statFps = 0;
  /** performance.now() (this thread) of the last frame, from engine stats. */
  lastFrameAt = 0;
  private video: HTMLVideoElement | null = null;
  private trackId = '';
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private readerToken = 0;
  private stopWorker: (() => void) | null = null;
  /** 'worker' | 'main' | 'element' | '' — which capture path is active (diagnostics). */
  capturePath = '';
  private fallbackTimer = 0;

  constructor(
    init: { key: string; participantId: string; kind: FeedKind; displayName: string },
    private log: (s: string) => void,
    private engine: EngineClient,
  ) {
    this.key = init.key;
    this.participantId = init.participantId;
    this.kind = init.kind;
    this.displayName = init.displayName;
  }

  get videoTrackId(): string {
    return this.trackId;
  }

  /** Has video arrived recently? */
  get live(): boolean {
    return !!this.lastFrameAt && performance.now() - this.lastFrameAt < 1000;
  }

  fps(): number {
    return this.live ? this.statFps : 0;
  }

  /** Engine stats for this source (every 250 ms). */
  setStats(s: SourceStats | undefined): void {
    if (!s || s.ageMs < 0) return;
    this.width = s.width;
    this.height = s.height;
    this.statFps = s.fps;
    this.lastFrameAt = performance.now() - s.ageMs;
  }

  /** The worker-side read ended: re-read on the next tile scan if the track is still live. */
  readEnded(): void {
    if (this.capturePath === 'worker') {
      this.stopWorker = null;
      this.trackId = '';
    }
  }

  bindTile(tile: HTMLElement | null): void {
    this.tile = tile;
    if (tile) this.lastSeen = performance.now();
    const v = tile ? pickVideo(tile) : null;
    const src = v?.srcObject;
    const track = src instanceof MediaStream ? (src.getVideoTracks()[0] ?? null) : null;
    const newTrackId = track && track.readyState === 'live' ? track.id : '';
    if (v !== this.video || newTrackId !== this.trackId) {
      this.detach();
      this.video = v;
      if (track && newTrackId) {
        this.trackId = newTrackId;
        const stop = this.engine.startTrack(this.key, track);
        if (stop) {
          this.stopWorker = stop;
          this.capturePath = 'worker';
          this.log(`capture [${this.displayName}]: worker ${track.id.slice(0, 8)}`);
        } else if (typeof MediaStreamTrackProcessor === 'function') void this.readTrack(track);
        else this.snapshotElement();
      } else if (v) this.snapshotElement();
    }
    // Drop the held frame when the camera goes away so outputs switch to loss mode.
    if (!v && this.lastFrameAt && performance.now() - this.lastFrameAt > 1500) {
      this.engine.endSource(this.key);
      this.lastFrameAt = 0;
    }
  }

  /** Fallback: snapshot the element at ~30 fps. */
  private snapshotElement(): void {
    this.capturePath = 'element';
    this.fallbackTimer = window.setInterval(() => {
      if (!this.video || this.video.readyState < 2) return;
      try {
        this.engine.pushFrame(this.key, new VideoFrame(this.video));
      } catch {
        /* not ready */
      }
    }, 33);
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
    this.video = null;
  }

  /** Fallback: read the track on this thread and hand each frame to the engine. */
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
        this.engine.pushFrame(this.key, value);
      }
    } catch (e) {
      if (token === this.readerToken) this.log(`track reader [${this.displayName}]: ${(e as Error).message}`);
    }
    if (token === this.readerToken) this.trackId = '';
  }

  dispose(): void {
    this.detach();
    this.engine.endSource(this.key);
  }
}
