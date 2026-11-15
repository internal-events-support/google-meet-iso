// Meeting audio router.
//
// Reads every remote audio track Meet plays (via the <audio> elements' srcObject) with
// MediaStreamTrackProcessor, resamples to 48 kHz stereo, and runs a 10 ms clock that emits:
//   - one chunk per track (for per-participant ISO audio), and
//   - the sum of all tracks (the meeting mix; excludes the bot's own mic by construction).
// Optionally plays the meeting on a chosen local output device instead of the default.

declare const MediaStreamTrackProcessor: {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<AudioData> };
};

const SR = 48000;
const MAX_BUFFER = SR * 0.2; // 200 ms
const TARGET_BUFFER = SR * 0.06;

/** Stereo ring buffer (planar). */
class Fifo {
  private cap = Math.ceil(MAX_BUFFER) + SR / 10;
  private L = new Float32Array(this.cap);
  private R = new Float32Array(this.cap);
  private rd = 0;
  private n = 0;
  get length(): number {
    return this.n;
  }
  push(L: Float32Array, R: Float32Array): void {
    for (let i = 0; i < L.length; i++) {
      const w = (this.rd + this.n) % this.cap;
      this.L[w] = L[i];
      this.R[w] = R[i];
      if (this.n < this.cap) this.n++;
      else this.rd = (this.rd + 1) % this.cap;
    }
    if (this.n > MAX_BUFFER) {
      const drop = this.n - TARGET_BUFFER;
      this.rd = (this.rd + drop) % this.cap;
      this.n -= drop;
    }
  }
  /** Pull n samples into out (planar L then R), zero-filling on underrun. */
  pull(n: number, out: Float32Array): void {
    const k = Math.min(n, this.n);
    for (let i = 0; i < k; i++) {
      const p = (this.rd + i) % this.cap;
      out[i] = this.L[p];
      out[n + i] = this.R[p];
    }
    for (let i = k; i < n; i++) {
      out[i] = 0;
      out[n + i] = 0;
    }
    this.rd = (this.rd + k) % this.cap;
    this.n -= k;
  }
}

interface Tap {
  trackId: string;
  fifo: Fifo;
  token: number;
  peak: number;
}

export type AudioSink = (mix: Float32Array, perTrack: Map<string, Float32Array>, samples: number) => void;

export class AudioRouter {
  private taps = new Map<string, Tap>();
  private timer = 0;
  private start = 0;
  private emitted = 0;
  private token = 0;
  mixPeak = 0;
  private monitorCtx: AudioContext | null = null;
  private monitorSources = new Map<string, MediaStreamAudioSourceNode>();
  private monitorDevice = '';

  constructor(
    private sink: AudioSink,
    private log: (s: string) => void,
  ) {}

  /** Discover Meet's remote audio tracks from its <audio> elements. */
  remoteTracks(): MediaStreamTrack[] {
    const out: MediaStreamTrack[] = [];
    for (const a of Array.from(document.querySelectorAll('audio'))) {
      const s = a.srcObject;
      if (s instanceof MediaStream) for (const t of s.getAudioTracks()) if (t.readyState === 'live') out.push(t);
    }
    return out;
  }

  sync(): void {
    const tracks = this.remoteTracks();
    const ids = new Set(tracks.map((t) => t.id));
    for (const [id, tap] of this.taps) {
      if (!ids.has(id)) {
        tap.token = -1;
        this.taps.delete(id);
      }
    }
    for (const t of tracks) if (!this.taps.has(t.id)) void this.readTrack(t);
    if (!this.timer && this.taps.size) this.startClock();
    this.syncMonitor(tracks);
  }

  private async readTrack(track: MediaStreamTrack): Promise<void> {
    if (typeof MediaStreamTrackProcessor !== 'function') return;
    const tap: Tap = { trackId: track.id, fifo: new Fifo(), token: ++this.token, peak: 0 };
    this.taps.set(track.id, tap);
    const myToken = tap.token;
    try {
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        if (tap.token !== myToken) {
          value.close();
          void reader.cancel().catch(() => {});
          break;
        }
        this.accept(tap, value);
      }
    } catch (e) {
      this.log(`audio reader: ${(e as Error).message}`);
    }
    if (this.taps.get(track.id) === tap) this.taps.delete(track.id);
  }

  private accept(tap: Tap, ad: AudioData): void {
    try {
      const n = ad.numberOfFrames;
      const ch = ad.numberOfChannels;
      const planes: Float32Array[] = [];
      for (let c = 0; c < Math.min(ch, 2); c++) {
        const p = new Float32Array(n);
        ad.copyTo(p, { planeIndex: c, format: 'f32-planar' });
        planes.push(p);
      }
      let L = planes[0];
      let R = planes[1] ?? planes[0];
      if (ad.sampleRate !== SR) {
        L = resample(L, ad.sampleRate, SR);
        R = planes[1] ? resample(R, ad.sampleRate, SR) : L;
      }
      let peak = 0;
      for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]));
      tap.peak = Math.max(peak, tap.peak * 0.9);
      tap.fifo.push(L, R);
    } finally {
      ad.close();
    }
  }

  private startClock(): void {
    this.start = performance.now();
    this.emitted = 0;
    this.timer = window.setInterval(() => this.tick(), 10);
  }

  private tick(): void {
    const due = Math.floor(((performance.now() - this.start) * SR) / 1000) - this.emitted;
    if (due < 240) return;
    const n = Math.min(due, SR / 10);
    this.emitted += due; // never try to catch up beyond 100 ms
    const mix = new Float32Array(n * 2);
    const per = new Map<string, Float32Array>();
    for (const tap of this.taps.values()) {
      const buf = new Float32Array(n * 2);
      tap.fifo.pull(n, buf);
      per.set(tap.trackId, buf);
      for (let i = 0; i < buf.length; i++) mix[i] += buf[i];
    }
    let peak = 0;
    for (let i = 0; i < mix.length; i++) {
      if (mix[i] > 1) mix[i] = 1;
      else if (mix[i] < -1) mix[i] = -1;
      const a = Math.abs(mix[i]);
      if (a > peak) peak = a;
    }
    this.mixPeak = Math.max(peak, this.mixPeak * 0.85);
    this.sink(mix, per, n);
  }

  trackPeak(trackId: string): number {
    return this.taps.get(trackId)?.peak ?? 0;
  }

  // ----- monitor on a chosen output device -----
  async setMonitorDevice(label: string): Promise<void> {
    if (label === this.monitorDevice) return;
    this.monitorDevice = label;
    if (!label) {
      this.monitorCtx?.close().catch(() => {});
      this.monitorCtx = null;
      this.monitorSources.clear();
      for (const a of Array.from(document.querySelectorAll('audio'))) a.muted = false;
      return;
    }
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const dev = devs.find((d) => d.kind === 'audiooutput' && d.label === label);
      if (!dev) throw new Error(`output "${label}" not found`);
      this.monitorCtx ??= new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
      await (this.monitorCtx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(dev.deviceId);
      this.log(`Meeting audio → ${label}`);
    } catch (e) {
      this.log(`monitor device: ${(e as Error).message}`);
    }
  }

  private syncMonitor(tracks: MediaStreamTrack[]): void {
    if (!this.monitorCtx) return;
    // Meet's own elements would also play to the default device: mute them.
    for (const a of Array.from(document.querySelectorAll('audio'))) a.muted = true;
    const ids = new Set(tracks.map((t) => t.id));
    for (const [id, node] of this.monitorSources) {
      if (!ids.has(id)) {
        node.disconnect();
        this.monitorSources.delete(id);
      }
    }
    for (const t of tracks) {
      if (this.monitorSources.has(t.id)) continue;
      const node = this.monitorCtx.createMediaStreamSource(new MediaStream([t]));
      node.connect(this.monitorCtx.destination);
      this.monitorSources.set(t.id, node);
    }
  }

  dispose(): void {
    window.clearInterval(this.timer);
    for (const tap of this.taps.values()) tap.token = -1;
    this.taps.clear();
    void this.monitorCtx?.close().catch(() => {});
  }
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  const n = Math.round((input.length * to) / from);
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = x - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}
