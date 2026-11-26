// Main-thread side of the video engine. Runs the EngineCore in a DedicatedWorker (preferred:
// participant frames, compositing, readback and preview encoding never touch the Meet page's
// busy main thread) or, if the worker can't start, in-process. Either way the main thread only
// sees finished NDI buffers (transferred, no copy), previews, recorder frames and stats.
//
// Meet enforces Trusted Types, so the worker's blob URL goes through a TT policy. Each track is
// read in the worker from a clone (Meet's own <video> keeps the original) whose
// MediaStreamTrackProcessor readable is transferred; if that fails the page reads it and
// transfers the frames instead.

import * as fs from 'fs';
import * as path from 'path';
import { EngineCore, type EngineIn, type EngineOut, type SourceStats } from './engine';
import { initWebGpu } from './gpucompositor';
import type { RenderConfig, RenderStats } from './render';

declare const MediaStreamTrackProcessor: {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> };
};

export interface EngineSink {
  frame(m: Extract<EngineOut, { t: 'frame' }>): void;
  cadence(id: string, on: boolean): void;
  preview(key: string, jpeg: ArrayBuffer): void;
  rec(id: string, frame: VideoFrame, w: number, h: number): void;
  stats(outs: Record<string, RenderStats>, sources: Record<string, SourceStats>, gpuLost: number): void;
  /** A worker-side track read ended (the source re-reads on the next tile scan). */
  trackEnd(id: string): void;
  log(s: string): void;
}

type Out = EngineOut | { t: 'ready'; webgpu: boolean; mstp: boolean } | { t: 'trackEnd'; id: string; read: number };

let nextRead = 1;

export class EngineClient {
  /** 'worker' | 'local' — where the engine runs (diagnostics). */
  mode: 'starting' | 'worker' | 'local' = 'starting';
  private worker: Worker | null = null;
  private local: EngineCore | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: [EngineIn, Transferable[]][] = [];
  /** Replayed into the local engine if the worker fails after outputs were configured. */
  private outs = new Map<string, { rc?: RenderConfig; source?: string | null }>();
  private previewKeys: string[] | null = null;

  constructor(private sink: EngineSink) {
    try {
      this.worker = this.spawn();
    } catch (e) {
      sink.log(`render worker unavailable (${(e as Error).message}); rendering in the page`);
      this.goLocal();
    }
  }

  private spawn(): Worker {
    if (process.env.GMEET_ISO_RENDER_WORKER === '0') throw new Error('disabled by GMEET_ISO_RENDER_WORKER=0');
    // Env switches the worker can't read itself (no `process` there).
    const env = { GMEET_ISO_WEBGPU: process.env.GMEET_ISO_WEBGPU ?? '' };
    const src = `self.__gmeetIsoEnv = ${JSON.stringify(env)};
` + fs.readFileSync(path.join(__dirname, 'engine-worker.js'), 'utf8');
    const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    let url: unknown = blobUrl;
    const tt = (globalThis as { trustedTypes?: { createPolicy(n: string, p: object): { createScriptURL(s: string): unknown } } }).trustedTypes;
    if (tt) {
      try {
        url = tt.createPolicy('gmeetIsoRenderWorker', { createScriptURL: (s: string) => s }).createScriptURL(blobUrl);
      } catch (e) {
        this.sink.log(`render worker: TT policy failed (${(e as Error).message}); trying raw URL`);
      }
    }
    const w = new Worker(url as string, { name: 'gmeet-iso-render' });
    w.onmessage = (e: MessageEvent) => this.onOut(e.data as Out);
    w.onerror = (e) => {
      this.sink.log(`render worker error: ${e.message}`);
      if (this.mode === 'starting') this.goLocal();
    };
    this.readyTimer = setTimeout(() => {
      if (this.mode === 'starting') {
        this.sink.log('render worker did not start; rendering in the page');
        this.goLocal();
      }
    }, 5000);
    return w;
  }

  private goLocal(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.worker?.terminate();
    this.worker = null;
    this.mode = 'local';
    initWebGpu();
    this.local = new EngineCore((m) => this.onOut(m));
    this.queue = [];
    // Replay outputs / bindings / preview keys (frames and buffers in flight are simply lost).
    if (this.previewKeys) this.local.handle({ t: 'previewKeys', keys: this.previewKeys });
    for (const [id, o] of this.outs) {
      if (o.rc) this.local.handle({ t: 'out', id, rc: o.rc });
      if (o.source !== undefined) this.local.handle({ t: 'bind', id, source: o.source });
    }
  }

  private onOut(m: Out): void {
    switch (m.t) {
      case 'ready':
        if (this.readyTimer) clearTimeout(this.readyTimer);
        if (this.mode !== 'starting') return;
        this.mode = 'worker';
        this.sink.log(`render worker up (WebGPU ${m.webgpu ? 'yes' : 'no'})`);
        for (const [msg, tr] of this.queue) this.worker!.postMessage(msg, tr);
        this.queue = [];
        return;
      case 'frame':
        return this.sink.frame(m);
      case 'cadence':
        return this.sink.cadence(m.id, m.on);
      case 'preview':
        return this.sink.preview(m.key, m.jpeg);
      case 'rec':
        return this.sink.rec(m.id, m.frame, m.w, m.h);
      case 'stats':
        return this.sink.stats(m.outs, m.sources, m.gpuLost);
      case 'needImage':
        return void this.loadImage(m.path);
      case 'trackEnd':
        return this.sink.trackEnd(m.id);
      case 'log':
        return this.sink.log(m.s);
    }
  }

  /** Overlay / loss images are files: decode them here and hand the bitmap to the engine. */
  private async loadImage(p: string): Promise<void> {
    let bitmap: ImageBitmap | null = null;
    try {
      const data = fs.readFileSync(p);
      const ext = p.toLowerCase().split('.').pop() ?? 'png';
      const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
      bitmap = await createImageBitmap(new Blob([data], { type }));
    } catch {
      bitmap = null;
    }
    this.send({ t: 'image', path: p, bitmap }, bitmap ? [bitmap] : []);
  }

  send(m: EngineIn, transfer: Transferable[] = []): void {
    if (m.t === 'out') this.outs.set(m.id, { ...this.outs.get(m.id), rc: m.rc });
    else if (m.t === 'bind') this.outs.set(m.id, { ...this.outs.get(m.id), source: m.source });
    else if (m.t === 'remove') this.outs.delete(m.id);
    else if (m.t === 'previewKeys') this.previewKeys = m.keys;
    if (this.local) this.local.handle(m);
    else if (this.mode === 'worker') this.worker!.postMessage(m, transfer);
    else this.queue.push([m, transfer]);
  }

  /**
   * Read `track` in the worker (frames never come to this thread). Returns a stop function,
   * or null when the caller must read it here and pushFrame() (local engine / transfer failed).
   */
  startTrack(id: string, track: MediaStreamTrack): (() => void) | null {
    if (this.mode !== 'worker' || typeof MediaStreamTrackProcessor !== 'function') return null;
    let clone: MediaStreamTrack | null = null;
    const read = nextRead++;
    try {
      clone = track.clone();
      const { readable } = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 4 });
      this.worker!.postMessage({ t: 'track', id, read, readable }, [readable as unknown as Transferable]);
    } catch (e) {
      clone?.stop();
      this.sink.log(`render worker: stream transfer failed, reading in the page: ${(e as Error).message}`);
      return null;
    }
    const c = clone;
    return () => {
      c.stop(); // ends the stream in the worker too
      this.worker?.postMessage({ t: 'trackStop', read });
    };
  }

  /** A frame read on this thread (fallback paths): hand it to the engine (ownership moves). */
  pushFrame(id: string, frame: VideoFrame): void {
    if (this.local) this.local.onFrame(id, frame);
    else if (this.mode === 'worker') this.worker!.postMessage({ t: 'pushFrame', id, frame }, [frame as unknown as Transferable]);
    else frame.close();
  }

  /** The source has no video any more: drop its held frame so outputs switch to loss mode. */
  endSource(id: string): void {
    if (this.local) this.local.endSource(id);
    else if (this.mode === 'worker') this.worker!.postMessage({ t: 'endSource', id });
  }

  dispose(): void {
    this.local?.dispose();
    this.worker?.terminate();
  }
}
