// Per-output recording: WebCodecs (hardware H.264 + AAC) → fragmented MP4 written
// incrementally to disk, so the file is usable while still growing and survives a crash
// up to the last fragment.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Muxer, StreamTarget } = require('mp4-muxer') as typeof import('mp4-muxer');

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function defaultRecordDir(): string {
  return path.join(os.homedir(), 'Videos', 'GMeet ISO');
}

export class Recorder {
  file = '';
  private fd: number | null = null;
  private muxer: InstanceType<typeof Muxer> | null = null;
  private venc: VideoEncoder | null = null;
  private aenc: AudioEncoder | null = null;
  private w = 0;
  private h = 0;
  private t0 = 0;
  private frames = 0;
  private scaler: OffscreenCanvas | null = null;
  private stopped = false;
  private audioReady = false;

  constructor(
    private name: string,
    dir: string,
    private log: (s: string) => void,
    private withAudio: boolean,
  ) {
    const folder = dir || defaultRecordDir();
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      /* reported on open */
    }
    const safe = name.replace(/[^\w\- ]+/g, '_').trim() || 'output';
    this.file = path.join(folder, `${safe}_${stamp()}.mp4`);
  }

  private start(w: number, h: number): void {
    this.w = w - (w % 2);
    this.h = h - (h % 2);
    try {
      this.fd = fs.openSync(this.file, 'w');
    } catch (e) {
      this.log(`[rec ${this.name}] cannot open ${this.file}: ${(e as Error).message}`);
      this.stopped = true;
      return;
    }
    const fd = this.fd;
    this.muxer = new Muxer({
      target: new StreamTarget({
        onData: (data: Uint8Array, position: number) => {
          try {
            fs.writeSync(fd, data, 0, data.byteLength, position);
          } catch (e) {
            this.log(`[rec ${this.name}] write failed: ${(e as Error).message}`);
          }
        },
      }),
      video: { codec: 'avc', width: this.w, height: this.h },
      ...(this.withAudio ? { audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 2 } } : {}),
      fastStart: 'fragmented',
      firstTimestampBehavior: 'offset',
    });
    this.venc = new VideoEncoder({
      output: (chunk, meta) => this.muxer?.addVideoChunk(chunk, meta),
      error: (e) => this.log(`[rec ${this.name}] video encoder: ${e.message}`),
    });
    const bitrate = Math.round(this.w * this.h * 30 * 0.12); // ~7.5 Mb/s at 1080p30
    this.venc.configure({
      codec: this.w * this.h > 1920 * 1088 ? 'avc1.640033' : 'avc1.640028',
      width: this.w,
      height: this.h,
      bitrate,
      framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'realtime',
      avc: { format: 'avc' },
    });
    if (this.withAudio) {
      this.aenc = new AudioEncoder({
        output: (chunk, meta) => this.muxer?.addAudioChunk(chunk, meta),
        error: (e) => this.log(`[rec ${this.name}] audio encoder: ${e.message}`),
      });
      this.aenc.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
      this.audioReady = true;
    }
    this.t0 = performance.now();
    this.log(`Recording ${this.name} → ${this.file}`);
  }

  /** Accepts a VideoFrame (not closed here). Scales if the source size changed. */
  video(frame: VideoFrame, w: number, h: number): void {
    if (this.stopped) return;
    if (!this.venc) this.start(w, h);
    const enc = this.venc;
    if (!enc || enc.state !== 'configured' || enc.encodeQueueSize > 6) return; // drop under load
    const ts = Math.round((performance.now() - this.t0) * 1000);
    let vf: VideoFrame;
    if (frame.displayWidth !== this.w || frame.displayHeight !== this.h) {
      this.scaler ??= new OffscreenCanvas(this.w, this.h);
      const ctx = this.scaler.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.w, this.h);
      const s = Math.min(this.w / frame.displayWidth, this.h / frame.displayHeight);
      const dw = frame.displayWidth * s;
      const dh = frame.displayHeight * s;
      ctx.drawImage(frame, (this.w - dw) / 2, (this.h - dh) / 2, dw, dh);
      vf = new VideoFrame(this.scaler, { timestamp: ts });
    } else {
      vf = new VideoFrame(frame, { timestamp: ts });
    }
    enc.encode(vf, { keyFrame: this.frames++ % 60 === 0 });
    vf.close();
  }

  /** Planar float32 stereo/mono at any rate (expects 48 kHz from the audio router). */
  audio(planar: Float32Array, sampleRate: number, channels: number, samples: number): void {
    if (this.stopped || !this.audioReady || !this.aenc || this.aenc.state !== 'configured') return;
    const ts = Math.round((performance.now() - this.t0) * 1000);
    const stereo = channels >= 2 ? planar.subarray(0, samples * 2) : (() => {
      const s = new Float32Array(samples * 2);
      s.set(planar.subarray(0, samples), 0);
      s.set(planar.subarray(0, samples), samples);
      return s;
    })();
    const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: samples, numberOfChannels: 2, timestamp: ts, data: stereo as unknown as BufferSource });
    this.aenc.encode(ad);
    ad.close();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.venc?.flush();
      await this.aenc?.flush();
      this.muxer?.finalize();
    } catch (e) {
      this.log(`[rec ${this.name}] finalize: ${(e as Error).message}`);
    }
    this.venc?.close();
    this.aenc?.close();
    if (this.fd !== null) fs.closeSync(this.fd);
    if (this.fd !== null) this.log(`Recording saved: ${this.file}`);
    this.fd = null;
  }
}
