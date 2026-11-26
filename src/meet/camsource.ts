// Isolated-world side of the bot camera: paints the hidden canvas that the main-world
// shim turns into Meet's camera track. Source = NDI receiver or a local webcam.

import type { CameraSource } from '../shared/types';

const CANVAS_ID = '__gmeet_iso_cam';
const OUT_W = 1280;
const OUT_H = 720;

interface NdiReceiver {
  read(): { width: number; height: number; format: 'BGRA' | 'BGRX'; data: ArrayBuffer } | null;
  /** Copy the newest frame into `buf` (reused: no per-frame allocation). bytes = 0: buf too small. */
  readInto?(buf: ArrayBuffer): { width: number; height: number; format: 'BGRA' | 'BGRX'; bytes: number; needed?: number } | null;
  stats(): { connected: boolean; frames: number; width: number; height: number };
  destroy(): void;
}
type ReceiverCtor = new (name: string, opts?: { lowBandwidth?: boolean }) => NdiReceiver;

export function getCamCanvas(): HTMLCanvasElement {
  let c = document.getElementById(CANVAS_ID) as HTMLCanvasElement | null;
  if (!c) {
    c = document.createElement('canvas');
    c.id = CANVAS_ID;
    c.width = OUT_W;
    c.height = OUT_H;
    c.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;pointer-events:none';
    (document.documentElement || document).appendChild(c);
  }
  return c;
}

/** Draw `src` letterboxed into the 16:9 output canvas. */
function drawFit(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  if (!sw || !sh) return;
  const s = Math.min(OUT_W / sw, OUT_H / sh);
  const dw = Math.round(sw * s);
  const dh = Math.round(sh * s);
  ctx.drawImage(src, (OUT_W - dw) / 2, (OUT_H - dh) / 2, dw, dh);
}

export class BotCamera {
  private source: CameraSource = { type: 'none', name: '' };
  private receiver: NdiReceiver | null = null;
  /** Reused NDI receive buffer. */
  private rxBuf: ArrayBuffer | null = null;
  private webcamStream: MediaStream | null = null;
  private webcamVideo: HTMLVideoElement | null = null;
  private timer: number;
  private lastFrameAt = 0;
  private lastSlateAt = 0;
  private token = 0;
  private fpsTimes: number[] = [];
  status = 'off';
  /** Bumped whenever the camera canvas is repainted (new frame or slate): previews skip unchanged content. */
  paints = 0;
  width = 0;
  height = 0;

  constructor(
    private Receiver: ReceiverCtor | null,
    private log: (s: string) => void,
  ) {
    this.timer = window.setInterval(() => this.paint(), 1000 / 30);
  }

  async setSource(src: CameraSource): Promise<void> {
    if (src.type === this.source.type && src.name === this.source.name) return;
    this.teardown();
    const token = ++this.token;
    this.source = { ...src };
    this.status = 'starting';
    if (src.type === 'ndi' && src.name) {
      if (!this.Receiver) {
        this.status = 'NDI unavailable';
        return;
      }
      try {
        this.receiver = new this.Receiver(src.name);
        this.log(`Bot camera ← NDI "${src.name}"`);
        this.status = 'connecting';
      } catch (e) {
        this.status = `error: ${(e as Error).message}`;
      }
    } else if (src.type === 'device' && src.name) {
      try {
        // Isolated world: this is the real (unpatched) getUserMedia.
        const devs = await navigator.mediaDevices.enumerateDevices();
        const dev = devs.find((d) => d.kind === 'videoinput' && d.label === src.name);
        if (!dev) throw new Error(`webcam "${src.name}" not found`);
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: dev.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        });
        if (token !== this.token) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.webcamStream = stream;
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.srcObject = stream;
        await v.play().catch(() => {});
        this.webcamVideo = v;
        this.log(`Bot camera ← webcam "${src.name}"`);
        this.status = 'live';
      } catch (e) {
        this.status = `error: ${(e as Error).message}`;
        this.log(`Bot camera webcam failed: ${(e as Error).message}`);
      }
    } else {
      this.status = 'off';
    }
  }

  private teardown(): void {
    this.receiver?.destroy();
    this.receiver = null;
    this.webcamStream?.getTracks().forEach((t) => t.stop());
    this.webcamStream = null;
    if (this.webcamVideo) this.webcamVideo.srcObject = null;
    this.webcamVideo = null;
  }

  /** Newest NDI frame: into the reused buffer when the addon supports it. */
  private readFrame(rx: NdiReceiver): { width: number; height: number; format: 'BGRA' | 'BGRX'; data: ArrayBuffer | Uint8Array } | null {
    if (typeof rx.readInto !== 'function') return rx.read();
    this.rxBuf ??= new ArrayBuffer(1920 * 1080 * 4);
    let f = rx.readInto(this.rxBuf);
    if (f && !f.bytes && f.needed) {
      this.rxBuf = new ArrayBuffer(f.needed);
      f = rx.readInto(this.rxBuf);
    }
    if (!f || !f.bytes) return null;
    return { width: f.width, height: f.height, format: f.format, data: new Uint8Array(this.rxBuf, 0, f.bytes) };
  }

  private paint(): void {
    const canvas = getCamCanvas();
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const now = performance.now();
    let drew = false;
    if (this.receiver) {
      const f = this.readFrame(this.receiver);
      if (f) {
        const vf = new VideoFrame(f.data, { format: f.format, codedWidth: f.width, codedHeight: f.height, timestamp: Math.round(now * 1000) });
        drawFit(ctx, vf, f.width, f.height);
        vf.close();
        this.width = f.width;
        this.height = f.height;
        drew = true;
        this.status = 'live';
      } else if (now - this.lastFrameAt > 2000 && this.status === 'live') {
        this.status = 'no signal';
      }
    } else if (this.webcamVideo && this.webcamVideo.readyState >= 2) {
      const v = this.webcamVideo;
      drawFit(ctx, v, v.videoWidth, v.videoHeight);
      this.width = v.videoWidth;
      this.height = v.videoHeight;
      drew = true;
    }
    if (drew) this.paints++;
    if (drew) {
      this.lastFrameAt = now;
      this.fpsTimes.push(now);
    } else if (now - this.lastFrameAt > 1000 && now - this.lastSlateAt > 500) {
      // Keep the track alive with a slate so Meet doesn't treat it as frozen.
      this.lastSlateAt = now;
      this.paints++;
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, OUT_W, OUT_H);
      ctx.fillStyle = '#666';
      ctx.font = '36px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(this.source.type === 'none' ? 'No camera source' : `Waiting for ${this.source.name}`, OUT_W / 2, OUT_H / 2);
    }
  }

  fps(): number {
    const now = performance.now();
    this.fpsTimes = this.fpsTimes.filter((t) => now - t < 1000);
    return this.fpsTimes.length;
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.teardown();
  }
}

export { Thumbnailer } from './thumbs';
