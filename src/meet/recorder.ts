// Per-output recording (RE ZISOFileRecorder + RecordingSettings): WebCodecs (H.264 / HEVC + AAC)
// → fragmented MP4 written incrementally to disk, so the file is usable while still growing and
// survives a crash up to the last fragment.
//
// Honours settings.recording: format (only MP4 here; MOV/MKV/MXF fall back to MP4), videoCodec
// (h264 | hevc; ProRes falls back to H.264), videoBitrateMbps, fileNamePrefix/Suffix and
// fileNameDateFormat. Settings are read when a recording starts (RE: changing them needs a stop).

import { ipcRenderer } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_RECORDING, formatRecordingDate, IPC, type RecordingSettings, type Settings } from '../shared/types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Muxer, StreamTarget } = require('mp4-muxer') as typeof import('mp4-muxer');

// ---------------------------------------------------------------------------
// Live copy of settings.recording (the preload also receives meet:settings; we listen independently
// so outputs.ts doesn't need to thread it through).
let recSettings: RecordingSettings = { ...DEFAULT_RECORDING };
export function setRecordingSettings(r: Partial<RecordingSettings> | undefined): void {
  if (r) recSettings = { ...DEFAULT_RECORDING, ...r };
}
try {
  ipcRenderer.on(IPC.meetSettings, (_e, s: Settings) => setRecordingSettings(s?.recording));
  void ipcRenderer
    .invoke(IPC.meetGetSettings)
    .then((s: Settings) => setRecordingSettings(s?.recording))
    .catch(() => {});
} catch {
  /* not in an Electron renderer (tests) */
}

export function defaultRecordDir(): string {
  return path.join(os.homedir(), 'Videos', 'Google Meet ISO');
}

/** RE RecordingSettings.generateFileName: prefix · output name · suffix · date. */
export function recordingFileName(name: string, r: RecordingSettings, when = new Date()): string {
  const clean = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim();
  const date = formatRecordingDate(when, r.fileNameDateFormat);
  const parts = [clean(r.fileNamePrefix), clean(name) || 'output', clean(r.fileNameSuffix), date].filter(Boolean);
  return parts.join(' ');
}

function uniquePath(folder: string, base: string, ext: string): string {
  let p = path.join(folder, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(p) && i < 1000; i++) p = path.join(folder, `${base} (${i}).${ext}`);
  return p;
}

type Codec = 'h264' | 'hevc';
function codecString(codec: Codec, w: number, h: number): string {
  const big = w * h > 1920 * 1088;
  return codec === 'hevc' ? (big ? 'hvc1.1.6.L153.B0' : 'hvc1.1.6.L123.B0') : big ? 'avc1.640033' : 'avc1.640028';
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
  private starting = false;
  private audioReady = false;
  private readonly cfg: RecordingSettings;
  private codec: Codec;

  constructor(
    private name: string,
    dir: string,
    private log: (s: string) => void,
    private withAudio: boolean,
  ) {
    this.cfg = { ...recSettings };
    if (this.cfg.format !== 'mp4') this.log(`[rec ${name}] ${this.cfg.format.toUpperCase()} isn't available in Google Meet ISO; recording MP4`);
    this.codec = this.cfg.videoCodec === 'hevc' ? 'hevc' : 'h264';
    if (this.cfg.videoCodec === 'proRes422LT') this.log(`[rec ${name}] ProRes isn't available on Windows; recording H.264`);
    const folder = dir || defaultRecordDir();
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      /* reported on open */
    }
    this.file = uniquePath(folder, recordingFileName(name, this.cfg), 'mp4');
  }

  /** Pick the codec (HEVC falls back to H.264 when the GPU/OS has no encoder), then open the muxer. */
  private async start(w: number, h: number): Promise<void> {
    this.starting = true;
    this.w = w - (w % 2);
    this.h = h - (h % 2);
    const bitrate = Math.max(1, this.cfg.videoBitrateMbps || DEFAULT_RECORDING.videoBitrateMbps) * 1_000_000;
    const base = { width: this.w, height: this.h, bitrate, framerate: 30, latencyMode: 'realtime' as const };
    const configFor = (c: Codec): VideoEncoderConfig =>
      c === 'hevc'
        ? ({ ...base, codec: codecString('hevc', this.w, this.h), hardwareAcceleration: 'prefer-hardware', hevc: { format: 'hevc' } } as VideoEncoderConfig)
        : { ...base, codec: codecString('h264', this.w, this.h), hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } };
    let vcfg = configFor(this.codec);
    try {
      const sup = await VideoEncoder.isConfigSupported(vcfg);
      if (!sup.supported && this.codec === 'hevc') {
        this.log(`[rec ${this.name}] HEVC encoder unavailable; recording H.264`);
        this.codec = 'h264';
        vcfg = configFor('h264');
      }
    } catch {
      if (this.codec === 'hevc') {
        this.codec = 'h264';
        vcfg = configFor('h264');
      }
    }
    if (this.stopped) return;
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
      video: { codec: this.codec === 'hevc' ? 'hevc' : 'avc', width: this.w, height: this.h },
      ...(this.withAudio ? { audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 2 } } : {}),
      fastStart: 'fragmented',
      firstTimestampBehavior: 'offset',
    });
    this.venc = new VideoEncoder({
      output: (chunk, meta) => this.muxer?.addVideoChunk(chunk, meta),
      error: (e) => this.log(`[rec ${this.name}] video encoder: ${e.message}`),
    });
    this.venc.configure(vcfg);
    if (this.withAudio) {
      this.aenc = new AudioEncoder({
        output: (chunk, meta) => this.muxer?.addAudioChunk(chunk, meta),
        error: (e) => this.log(`[rec ${this.name}] audio encoder: ${e.message}`),
      });
      this.aenc.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
      this.audioReady = true;
    }
    this.t0 = performance.now();
    this.starting = false;
    this.log(`Recording started for ${this.name} → ${this.file} (${this.codec === 'hevc' ? 'HEVC' : 'H.264'}, ${bitrate / 1e6} Mb/s)`);
  }

  /** Accepts a VideoFrame (not closed here). Scales if the source size changed. */
  video(frame: VideoFrame, w: number, h: number): void {
    if (this.stopped) return;
    if (!this.venc) {
      if (!this.starting) void this.start(w, h);
      return; // drop frames until the encoder is configured
    }
    const enc = this.venc;
    if (enc.state !== 'configured' || enc.encodeQueueSize > 6) return; // drop under load
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
    const stereo =
      channels >= 2
        ? planar.subarray(0, samples * 2)
        : (() => {
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
    if (this.fd !== null) this.log(`Recording stopped and files finalized: ${this.file}`);
    this.fd = null;
  }
}
