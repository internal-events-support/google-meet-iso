// Auto-crop (RE AutoCropEngine): face tracking via Chromium's Shape Detection API
// (FaceDetector). Optional: when FaceDetector isn't exposed, `autoCropSupported()` is false
// and the engine leaves the manual transform in place.

import type { AutoCropResponsiveness, OutputConfig } from '../../shared/types';
import type { AutoCropView } from './fxgl';

interface DetectedFace {
  boundingBox: DOMRectReadOnly;
}
interface FaceDetectorLike {
  detect(src: ImageBitmapSource): Promise<DetectedFace[]>;
}
type FaceDetectorCtor = new (opts?: { fastMode?: boolean; maxDetectedFaces?: number }) => FaceDetectorLike;

export function autoCropSupported(): boolean {
  return typeof (globalThis as unknown as { FaceDetector?: unknown }).FaceDetector === 'function';
}

export const AUTO_CROP_UNSUPPORTED = 'Face detection (Shape Detection API) is not available in this Chromium build';

const RESP: Record<AutoCropResponsiveness, { every: number; dead: number; ease: number }> = {
  low: { every: 400, dead: 0.12, ease: 0.04 },
  medium: { every: 250, dead: 0.06, ease: 0.08 },
  high: { every: 150, dead: 0.025, ease: 0.16 },
};

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tracks a face on the source frames and eases a crop view towards it. */
export class AutoCropTracker {
  private det: FaceDetectorLike | null = null;
  private busy = false;
  private lastRun = 0;
  private lastFaceAt = 0;
  private target: AutoCropView = { cx: 0.5, cy: 0.5, zoom: 1 };
  view: AutoCropView = { cx: 0.5, cy: 0.5, zoom: 1 };
  face: FaceBox | null = null;

  constructor() {
    const C = (globalThis as unknown as { FaceDetector?: FaceDetectorCtor }).FaceDetector;
    if (C) {
      try {
        this.det = new C({ fastMode: true, maxDetectedFaces: 1 });
      } catch {
        this.det = null;
      }
    }
  }

  get supported(): boolean {
    return !!this.det;
  }

  /** The eased view hasn't reached its target yet (worth re-rendering between source frames). */
  get moving(): boolean {
    const v = this.view;
    const t = this.target;
    return Math.abs(v.cx - t.cx) > 5e-4 || Math.abs(v.cy - t.cy) > 5e-4 || Math.abs(v.zoom - t.zoom) > 1e-3;
  }

  /** Feed a source frame; returns the current eased view (source fractions). */
  update(frame: VideoFrame | ImageBitmap | HTMLImageElement | HTMLCanvasElement, sw: number, sh: number, outAspect: number, cfg: Partial<OutputConfig>): AutoCropView {
    const r = RESP[cfg.autoCropResponsiveness ?? 'medium'];
    const now = performance.now();
    if (this.det && !this.busy && now - this.lastRun > r.every && sw && sh) {
      this.busy = true;
      this.lastRun = now;
      const scale = Math.min(1, 480 / sw);
      void createImageBitmap(frame as ImageBitmapSource, { resizeWidth: Math.round(sw * scale), resizeHeight: Math.round(sh * scale) })
        .then(async (bmp) => {
          try {
            const faces = await this.det!.detect(bmp);
            const f = faces.sort((a, b) => b.boundingBox.width * b.boundingBox.height - a.boundingBox.width * a.boundingBox.height)[0];
            if (f) {
              const bb = f.boundingBox;
              this.face = { x: bb.x / bmp.width, y: bb.y / bmp.height, w: bb.width / bmp.width, h: bb.height / bmp.height };
              this.lastFaceAt = performance.now();
              this.retarget(sw, sh, outAspect, cfg, r.dead);
            }
          } finally {
            bmp.close();
          }
        })
        .catch(() => undefined)
        .finally(() => (this.busy = false));
    }
    if (this.face && now - this.lastFaceAt > 3500) {
      this.face = null;
      if (cfg.autoCropZoomOutOnLostFace !== false) this.target = { cx: 0.5, cy: 0.5, zoom: 1 };
    }
    // Ease: faster when far from the target, slower as it gets close.
    const k = (a: number, b: number, span: number) => {
      const d = b - a;
      const f = Math.min(1, r.ease * (1 + Math.min(3, Math.abs(d) / span)));
      return a + d * f;
    };
    this.view = { cx: k(this.view.cx, this.target.cx, 0.1), cy: k(this.view.cy, this.target.cy, 0.1), zoom: k(this.view.zoom, this.target.zoom, 0.5) };
    return this.view;
  }

  private retarget(sw: number, sh: number, outAspect: number, cfg: Partial<OutputConfig>, dead: number): void {
    const f = this.face!;
    const targetSize = cfg.autoCropTargetSize ?? 0.35;
    const vert = cfg.autoCropTargetVertical ?? 0.4;
    // Fit-scale view height in source fractions at zoom 1.
    const srcAspect = sw / sh;
    const vh0 = srcAspect > outAspect ? srcAspect / outAspect : 1;
    const zoom = Math.min(6, Math.max(1, (targetSize * vh0) / Math.max(0.01, f.h)));
    const vh = vh0 / zoom;
    const vw = (vh * outAspect * sh) / sw;
    let cx = f.x + f.w / 2;
    let cy = f.y + f.h / 2 - (vert - 0.5) * vh;
    const oh = cfg.autoCropExtendHorizontal ? (cfg.autoCropOverscanHorizontal ?? 0.1) : 0;
    const ov = cfg.autoCropExtendVertical ? (cfg.autoCropOverscanVertical ?? 0.1) : 0;
    const clampC = (c: number, half: number, over: number) => (half * 2 >= 1 + over * 2 ? 0.5 : Math.max(half - over, Math.min(1 - half + over, c)));
    cx = clampC(cx, vw / 2, oh);
    cy = clampC(cy, vh / 2, ov);
    const t = this.target;
    if (Math.abs(cx - t.cx) > dead * vw || Math.abs(cy - t.cy) > dead * vh || Math.abs(zoom - t.zoom) / t.zoom > dead * 2) this.target = { cx, cy, zoom };
  }
}
