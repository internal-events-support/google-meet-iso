// Audio Outputs routing (ZoomISO v3 AudioOutputsTable on Google Meet).
//
// Every local output device enrolled in Settings.audioOutputDevices gets its own AudioContext
// whose sink is that device (AudioContext.setSinkId). A ScriptProcessor pulls one queue per
// device channel; each queue is filled every router tick (10 ms, 48 kHz) from the channel's
// mode/selection (participant ISO, video output's audio, mix, …) with pan, gain reduction and
// delay applied. Per-participant audio is best effort: Meet only receives the 3 loudest streams.

import type { AudioOutputChannelConfig, AudioOutputDeviceConfig, Settings } from '../shared/types';

const SR = 48000;
const MAX_DELAY_MS = 1000;
const CAP = SR * 2; // 2 s per channel queue
const HIGH_WATER = SR * 0.25;
const LOW_WATER = SR * 0.06;

/** Stereo planar buffers (L then R, n samples each) the routing pulls from on each tick. */
export interface RouteSources {
  n: number;
  mix: Float32Array;
  perTrack: Map<string, Float32Array>;
  /** Final audio of each video output (by output id), as embedded in its NDI stream. */
  outputs: Map<string, Float32Array>;
  /** ISO audio of a participant (null = not attributed right now). */
  participant(key: string, name?: string): Float32Array | null;
  /** Track ids attributed to a participant shown on some output. */
  assignedTracks: Set<string>;
  /** Track id of the active speaker, if attributed. */
  speakerTrack: string | null;
}

class ChannelQueue {
  private buf = new Float32Array(CAP);
  private rd = 0;
  private len = 0;
  private delay = 0; // samples currently inserted for the delay
  peak = 0;

  setDelay(ms: number): void {
    const want = Math.round((Math.max(0, Math.min(MAX_DELAY_MS, ms)) * SR) / 1000);
    if (want > this.delay) this.pushZeros(want - this.delay);
    else if (want < this.delay) this.drop(Math.min(this.len, this.delay - want));
    this.delay = want;
  }
  private pushZeros(k: number): void {
    for (let i = 0; i < k && this.len < CAP; i++) {
      this.buf[(this.rd + this.len) % CAP] = 0;
      this.len++;
    }
  }
  private drop(k: number): void {
    this.rd = (this.rd + k) % CAP;
    this.len -= k;
  }
  push(src: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      if (this.len >= CAP) this.drop(1);
      this.buf[(this.rd + this.len) % CAP] = src[i];
      this.len++;
    }
    // Clock drift between the 10 ms producer and the device: keep latency bounded.
    if (this.len > this.delay + HIGH_WATER) this.drop(this.len - (this.delay + LOW_WATER));
  }
  pull(out: Float32Array): void {
    const k = Math.min(out.length, this.len);
    let peak = 0;
    for (let i = 0; i < k; i++) {
      const v = this.buf[(this.rd + i) % CAP];
      out[i] = v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    out.fill(0, k);
    this.drop(k);
    this.peak = Math.max(peak, this.peak * 0.85);
  }
}

type SinkCtx = AudioContext & { setSinkId(id: string): Promise<void> };

class DevicePlayer {
  ctx: SinkCtx | null = null;
  node: ScriptProcessorNode | null = null;
  queues: ChannelQueue[] = [];
  /** Real channel count of the device (destination.maxChannelCount, capped at 32). */
  deviceChannels = 0;
  error = '';
  disposed = false;

  constructor(
    readonly label: string,
    private log: (s: string) => void,
  ) {}

  async start(): Promise<void> {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const dev = devs.find((d) => d.kind === 'audiooutput' && d.label === this.label);
      if (!dev) throw new Error('device not found');
      const ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' }) as SinkCtx;
      await ctx.setSinkId(dev.deviceId);
      if (this.disposed) {
        void ctx.close();
        return;
      }
      const ch = Math.max(1, Math.min(32, ctx.destination.maxChannelCount || 2));
      ctx.destination.channelCount = ch;
      ctx.destination.channelCountMode = 'explicit';
      ctx.destination.channelInterpretation = 'discrete';
      const node = ctx.createScriptProcessor(1024, 1, ch);
      node.channelInterpretation = 'discrete';
      node.onaudioprocess = (e) => {
        const ob = e.outputBuffer;
        for (let c = 0; c < ob.numberOfChannels; c++) {
          const q = this.queues[c];
          const data = ob.getChannelData(c);
          if (q) q.pull(data);
          else data.fill(0);
        }
      };
      node.connect(ctx.destination);
      void ctx.resume().catch(() => {});
      this.ctx = ctx;
      this.node = node;
      this.deviceChannels = ch;
      this.log(`Audio output ${this.label}: ${ch} channel(s)`);
    } catch (e) {
      this.error = (e as Error).message;
      this.log(`Audio output ${this.label}: ${this.error}`);
    }
  }

  ensureQueues(n: number): void {
    while (this.queues.length < n) this.queues.push(new ChannelQueue());
    if (this.queues.length > n) this.queues.length = n;
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.node?.disconnect();
    } catch {
      /* ignore */
    }
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

export class OutputDeviceRouter {
  private players = new Map<string, DevicePlayer>();
  private configs: Record<string, AudioOutputDeviceConfig> = {};
  private scratch = new Float32Array(0);

  constructor(private log: (s: string) => void) {}

  /** Start/stop device players to match the enrolled devices. */
  sync(settings: Settings): void {
    this.configs = settings.audioOutputConfig ?? {};
    const want = new Set(settings.audioOutputDevices ?? []);
    for (const [label, p] of this.players) {
      if (!want.has(label)) {
        p.dispose();
        this.players.delete(label);
      }
    }
    for (const label of want) {
      if (this.players.has(label)) continue;
      const p = new DevicePlayer(label, this.log);
      this.players.set(label, p);
      void p.start();
    }
    for (const [label, p] of this.players) {
      const chans = this.configs[label]?.channels ?? [];
      p.ensureQueues(Math.min(chans.length, p.deviceChannels || chans.length));
      chans.forEach((c, i) => p.queues[i]?.setDelay(c.delayMs || 0));
    }
  }

  /** Called on every router tick. */
  process(src: RouteSources): void {
    if (!this.players.size) return;
    const n = src.n;
    if (this.scratch.length < n) this.scratch = new Float32Array(n);
    const out = this.scratch.subarray(0, n);
    let mixOutputs: Float32Array | null = null;
    let unassigned: Float32Array | null = null;
    for (const [label, p] of this.players) {
      if (!p.ctx) continue;
      const chans = this.configs[label]?.channels ?? [];
      if (p.queues.length !== Math.min(chans.length, p.deviceChannels)) p.ensureQueues(Math.min(chans.length, p.deviceChannels));
      for (let c = 0; c < p.queues.length; c++) {
        const cfg = chans[c];
        let buf: Float32Array | null = null;
        switch (cfg.mode) {
          case 'participant':
            buf = cfg.selection ? src.participant(cfg.selection, cfg.selectionName) : null;
            break;
          case 'output':
            buf = src.outputs.get(cfg.selection) ?? null;
            break;
          case 'mixAll':
          case 'screenshare': // Meet doesn't separate shared-screen audio: best effort = the meeting mix
            buf = src.mix;
            break;
          case 'activeSpeaker':
            buf = src.speakerTrack ? (src.perTrack.get(src.speakerTrack) ?? null) : null;
            break;
          case 'mixOutputs':
            buf = mixOutputs ??= sumDistinct([...src.outputs.values()], n);
            break;
          case 'mixUnassigned':
            buf = unassigned ??= sumDistinct(
              [...src.perTrack].filter(([t]) => !src.assignedTracks.has(t)).map(([, b]) => b),
              n,
            );
            break;
          default:
            buf = null;
        }
        renderChannel(buf, cfg, n, out);
        p.queues[c].push(out, n);
      }
    }
  }

  meters(): Record<string, number[]> {
    const r: Record<string, number[]> = {};
    for (const [label, p] of this.players) r[label] = p.queues.map((q) => Math.round(q.peak * 1000) / 1000);
    return r;
  }

  channelCounts(): Record<string, number> {
    const r: Record<string, number> = {};
    for (const [label, p] of this.players) if (p.deviceChannels) r[label] = p.deviceChannels;
    return r;
  }

  dispose(): void {
    for (const p of this.players.values()) p.dispose();
    this.players.clear();
  }
}

function sumDistinct(bufs: Float32Array[], n: number): Float32Array {
  const out = new Float32Array(n * 2);
  for (const b of new Set(bufs)) for (let i = 0; i < out.length && i < b.length; i++) out[i] += b[i];
  for (let i = 0; i < out.length; i++) out[i] = out[i] > 1 ? 1 : out[i] < -1 ? -1 : out[i];
  return out;
}

/** Stereo planar source → one device channel, with pan and gain reduction. */
function renderChannel(src: Float32Array | null, cfg: AudioOutputChannelConfig, n: number, out: Float32Array): void {
  if (!src || src.length < n * 2) {
    out.fill(0);
    return;
  }
  const g = Math.pow(10, Math.min(0, cfg.gainDb || 0) / 20);
  if (cfg.pan === 'left') for (let i = 0; i < n; i++) out[i] = src[i] * g;
  else if (cfg.pan === 'right') for (let i = 0; i < n; i++) out[i] = src[n + i] * g;
  else for (let i = 0; i < n; i++) out[i] = (src[i] + src[n + i]) * 0.5 * g;
}
