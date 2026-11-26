// Video engine core: the participants' latest frames + one OutputRenderer per output + source
// thumbnails. Realm-agnostic: it runs in the render worker (frames never touch the Meet page's
// main thread) or, when workers are unavailable, in the page itself. It talks to the main side
// only through messages (EngineIn / EngineOut), so both placements behave the same.

import type { RenderConfig, RenderHost, RenderStats, SourceFrame } from './render';
import { OutputRenderer } from './render';
import { GlCompositor } from './compositor';
import { gpuStats } from './gpucompositor';
import { Thumbnailer } from './thumbs';

/** Per-source stats for the main side (participants list, routing). */
export interface SourceStats {
  width: number;
  height: number;
  fps: number;
  /** ms since the last frame (-1: none yet). */
  ageMs: number;
}

/** main → engine */
export type EngineIn =
  | { t: 'out'; id: string; rc: RenderConfig }
  | { t: 'bind'; id: string; source: string | null }
  | { t: 'remove'; id: string }
  | { t: 'shown'; id: string }
  | { t: 'bufs'; id: string; bufs: ArrayBuffer[] }
  | { t: 'previewKeys'; keys: string[] | null }
  | { t: 'image'; path: string; bitmap: ImageBitmap | null }
  | { t: 'thumbFps'; fps: number }
  /** Encode a preview from an already downscaled image (e.g. the bot camera); the engine closes it. */
  | { t: 'thumbImage'; key: string; bitmap: ImageBitmap };

/** engine → main */
export type EngineOut =
  | { t: 'frame'; id: string; buf: ArrayBuffer; w: number; h: number; fmt: string; stride: number; fpsN?: number; fpsD?: number }
  | { t: 'cadence'; id: string; on: boolean }
  | { t: 'preview'; key: string; jpeg: ArrayBuffer }
  | { t: 'rec'; id: string; frame: VideoFrame; w: number; h: number }
  | { t: 'stats'; outs: Record<string, RenderStats>; sources: Record<string, SourceStats>; gpuLost: number }
  | { t: 'needImage'; path: string }
  | { t: 'log'; s: string };

/** Delivers engine output to the main side; `transfer` lists what can move without a copy. */
export type EnginePost = (m: EngineOut, transfer?: Transferable[]) => void;

interface Src extends SourceFrame {
  times: number[];
  thumb: Thumbnailer;
}

export class EngineCore {
  private sources = new Map<string, Src>();
  private outs = new Map<string, OutputRenderer>();
  private images = new Map<string, ImageBitmap | null | 'loading'>();
  private previewKeys: Set<string> | null = null;
  private thumbFps = 2;
  private imageThumbs = new Map<string, Thumbnailer>();
  private host: RenderHost;
  private statsTimer: ReturnType<typeof setInterval>;

  constructor(private post: EnginePost) {
    this.host = {
      submit: (id, buf, w, h, fmt, stride, fpsN, fpsD) => post({ t: 'frame', id, buf, w, h, fmt, stride, fpsN, fpsD }, [buf]),
      setPassCadence: (id, on) => post({ t: 'cadence', id, on }),
      preview: (key, jpeg) => post({ t: 'preview', key, jpeg }, [jpeg]),
      record: (id, frame, w, h) => post({ t: 'rec', id, frame, w, h }, [frame as unknown as Transferable]),
      log: (s) => post({ t: 'log', s }),
      image: (path) => this.image(path),
      wantsPreview: (key) => !this.previewKeys || this.previewKeys.has(key),
      source: (id) => this.sources.get(id),
    };
    this.statsTimer = setInterval(() => this.postStats(), 250);
  }

  private image(path: string): ImageBitmap | null {
    if (!path) return null;
    const hit = this.images.get(path);
    if (hit === undefined) {
      this.images.set(path, 'loading');
      this.post({ t: 'needImage', path });
      return null;
    }
    return hit === 'loading' ? null : hit;
  }

  /** A participant frame arrived (the engine takes ownership). */
  onFrame(sourceId: string, frame: VideoFrame): void {
    const now = performance.now();
    let s = this.sources.get(sourceId);
    const rect = frame.visibleRect;
    const width = rect?.width ?? frame.displayWidth;
    const height = rect?.height ?? frame.displayHeight;
    if (!s) {
      s = { frame, at: now, lastFrameAt: now, width, height, times: [], thumb: new Thumbnailer(240) };
      this.sources.set(sourceId, s);
    } else {
      s.frame.close();
      Object.assign(s, { frame, at: now, lastFrameAt: now, width, height });
    }
    s.times.push(now);
    for (const o of this.outs.values()) {
      if (o.boundSource !== sourceId) continue;
      try {
        o.onSourceFrame(frame, now);
      } catch (e) {
        this.post({ t: 'log', s: `frame listener error: ${(e as Error).message}` });
      }
    }
    const key = `src:${sourceId}`;
    if (!this.previewKeys || this.previewKeys.has(key)) {
      void s.thumb.maybe(frame, width, height, this.thumbFps).then((j) => j && this.post({ t: 'preview', key, jpeg: j }, [j]));
    }
  }

  /** The source's reader stopped: forget its frame (outputs fall back to loss mode). */
  endSource(sourceId: string): void {
    const s = this.sources.get(sourceId);
    if (!s) return;
    s.frame.close();
    this.sources.delete(sourceId);
  }

  handle(m: EngineIn): void {
    switch (m.t) {
      case 'out': {
        const o = this.outs.get(m.id);
        if (o) o.configure(m.rc);
        else this.outs.set(m.id, new OutputRenderer(m.id, m.rc, this.host));
        break;
      }
      case 'bind':
        this.outs.get(m.id)?.bind(m.source);
        break;
      case 'remove':
        this.outs.get(m.id)?.dispose();
        this.outs.delete(m.id);
        break;
      case 'shown':
        this.outs.get(m.id)?.previewShown();
        break;
      case 'bufs':
        this.outs.get(m.id)?.returnBuffers(m.bufs);
        break;
      case 'previewKeys': {
        const prev = this.previewKeys;
        this.previewKeys = m.keys ? new Set(m.keys) : null;
        // Newly shown: static outputs (loss content, freeze) re-render once so the preview fills in.
        if (this.previewKeys) for (const [id, o] of this.outs) if (this.previewKeys.has(id) && (!prev || !prev.has(id))) o.previewShown();
        break;
      }
      case 'image':
        this.images.set(m.path, m.bitmap);
        break;
      case 'thumbFps':
        this.thumbFps = m.fps;
        break;
      case 'thumbImage': {
        let t = this.imageThumbs.get(m.key);
        if (!t) this.imageThumbs.set(m.key, (t = new Thumbnailer(m.bitmap.width)));
        const bmp = m.bitmap;
        void t
          .maybe(bmp, bmp.width, bmp.height, 1000)
          .then((j) => j && this.post({ t: 'preview', key: m.key, jpeg: j }, [j]))
          .finally(() => bmp.close());
        break;
      }
    }
  }

  private postStats(): void {
    const now = performance.now();
    const sources: Record<string, SourceStats> = {};
    for (const [id, s] of this.sources) {
      while (s.times.length && now - s.times[0] > 1000) s.times.shift();
      sources[id] = { width: s.width, height: s.height, fps: s.times.length, ageMs: Math.round(now - s.lastFrameAt) };
    }
    const outs: Record<string, RenderStats> = {};
    for (const [id, o] of this.outs) outs[id] = o.stats();
    this.post({ t: 'stats', outs, sources, gpuLost: GlCompositor.lostCount + gpuStats.lost });
  }

  dispose(): void {
    clearInterval(this.statsTimer);
    for (const o of this.outs.values()) o.dispose();
    this.outs.clear();
    for (const s of this.sources.values()) s.frame.close();
    this.sources.clear();
  }
}
