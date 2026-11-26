// Preview thumbnails for the control UI (JPEG). No DOM or Node APIs: also used in the render worker.
//
// The render thread only prepares a small image: an async GPU-side downscale (createImageBitmap)
// for frames/canvases, or a CPU downscale of the packed NDI readback that's already in memory.
// JPEG encoding — the expensive part — runs in a dedicated encoder worker when one can be
// started (setJpegEncoder), so previews at a high rate don't steal time from rendering.

import { packedToRgba, type ReadbackResult } from './compositor';

/** Encodes a small image to JPEG; takes ownership of `src` (closes / transfers it). */
export type JpegEncoder = (src: ImageBitmap | ImageData) => Promise<ArrayBuffer | null>;

/** Encode on the calling thread (fallback). */
export function inlineEncoder(): JpegEncoder {
  const canvases = new Map<string, OffscreenCanvas>();
  return async (src) => {
    try {
      const k = `${src.width}x${src.height}`;
      let c = canvases.get(k);
      if (!c) canvases.set(k, (c = new OffscreenCanvas(src.width, src.height)));
      const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      if (src instanceof ImageData) ctx.putImageData(src, 0, 0);
      else {
        ctx.drawImage(src, 0, 0);
        src.close();
      }
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
      return await blob.arrayBuffer();
    } catch {
      return null;
    }
  };
}

const ENCODER_SRC = `
const canvases = new Map();
onmessage = async (e) => {
  const { id, bitmap, rgba, w, h } = e.data;
  try {
    const W = bitmap ? bitmap.width : w, H = bitmap ? bitmap.height : h, k = W + 'x' + H;
    let c = canvases.get(k);
    if (!c) { c = new OffscreenCanvas(W, H); canvases.set(k, c); }
    const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
    if (bitmap) { ctx.drawImage(bitmap, 0, 0); bitmap.close(); }
    else ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    const jpeg = await blob.arrayBuffer();
    postMessage({ id, jpeg }, [jpeg]);
  } catch (err) {
    postMessage({ id, jpeg: null });
  }
};`;

/** A JPEG encoder in its own worker, or null where workers can't be created (e.g. Trusted Types). */
export function workerEncoder(): JpegEncoder | null {
  let w: Worker;
  try {
    w = new Worker(URL.createObjectURL(new Blob([ENCODER_SRC], { type: 'text/javascript' })), { name: 'gmeet-iso-jpeg' });
  } catch {
    return null;
  }
  let next = 1;
  const pending = new Map<number, (j: ArrayBuffer | null) => void>();
  w.onmessage = (e: MessageEvent) => {
    const { id, jpeg } = e.data as { id: number; jpeg: ArrayBuffer | null };
    pending.get(id)?.(jpeg);
    pending.delete(id);
  };
  return (src) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      if (src instanceof ImageData) {
        const rgba = src.data.buffer as ArrayBuffer;
        w.postMessage({ id, rgba, w: src.width, h: src.height }, [rgba]);
      } else w.postMessage({ id, bitmap: src }, [src]);
    });
}

let encoder: JpegEncoder = inlineEncoder();
/** Use `e` for every thumbnail encoded in this realm. */
export function setJpegEncoder(e: JpegEncoder): void {
  encoder = e;
}

/** Downscaled JPEG thumbnails for the control UI. */
export class Thumbnailer {
  private busy = false;
  private last = 0;

  constructor(private width = 320) {}

  /** Returns a JPEG if the rate limit allows, else null. */
  async maybe(src: ImageBitmapSource, sw: number, sh: number, fps: number): Promise<ArrayBuffer | null> {
    const now = performance.now();
    if (this.busy || now - this.last < 1000 / Math.max(1, fps) || !sw || !sh) return null;
    this.busy = true;
    this.last = now;
    try {
      const h = Math.max(2, Math.round((this.width * sh) / sw));
      // GPU-side downscale; resolves without blocking this thread on a readback.
      const bmp = await createImageBitmap(src, { resizeWidth: this.width, resizeHeight: h, resizeQuality: 'low' });
      return await encoder(bmp);
    } catch {
      return null;
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Thumbnails from a packed NDI readback (UYVY/BGRA) already on the CPU: no extra GPU readback.
 * The RGBA downscale is synchronous (the readback buffer may be reused right after); the JPEG
 * encode is async (encoder worker).
 */
export class PackedThumbnailer {
  private busy = false;
  private last = 0;

  constructor(private width = 320) {}

  /** `force` skips the rate limit (static content rendered once, e.g. loss images). */
  maybe(r: ReadbackResult, fps: number, force = false): Promise<ArrayBuffer | null> | null {
    const now = performance.now();
    if (this.busy || (!force && now - this.last < 1000 / Math.max(1, fps)) || !r.width || !r.height) return null;
    this.busy = true;
    this.last = now;
    const tw = this.width;
    const th = Math.max(2, Math.round((tw * r.height) / r.width));
    const img = new ImageData(tw, th); // transferred to the encoder
    packedToRgba(r, tw, th, img.data);
    return encoder(img).finally(() => (this.busy = false));
  }
}
