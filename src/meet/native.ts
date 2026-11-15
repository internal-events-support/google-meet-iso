// Typings for the native NDI addon (build/Release/gmeet_iso_ndi.node).

export interface SenderStats {
  connections: number;
  program: boolean;
  preview: boolean;
  slate: boolean;
  dropped: number;
  sent: number;
  /** Frames re-sent by the cadence clock because nothing new was submitted. */
  repeated?: number;
  /** Cadence ticks that ran late. */
  late?: number;
  /** setCadence() is active. */
  clocked?: boolean;
  width: number;
  height: number;
}

export interface NativeSender {
  sendVideo(data: ArrayBuffer | Uint8Array, w: number, h: number, fmt: string, stride?: number, fpsN?: number, fpsD?: number): boolean;
  /** fpsN > 0: send the latest submitted frame (repeating it if nothing new) at exactly fpsN/fpsD. 0 = send on submit. */
  setCadence(fpsN: number, fpsD: number): boolean;
  sendAudio(planar: Float32Array, sampleRate: number, channels: number, samplesPerChannel: number): boolean;
  stats(): SenderStats;
  destroy(): void;
}

export interface NativeReceiver {
  read(): { width: number; height: number; format: 'BGRA' | 'BGRX'; data: ArrayBuffer } | null;
  stats(): { connected: boolean; frames: number; width: number; height: number };
  setTally(program: boolean, preview: boolean): void;
  destroy(): void;
}

export interface NativeNdi {
  load(): { ok: boolean; version?: string; error?: string; path?: string };
  Sender: new (name: string, opts?: { idleMs?: number; groups?: string; slateWidth?: number; slateHeight?: number }) => NativeSender;
  Receiver: new (name: string, opts?: { lowBandwidth?: boolean }) => NativeReceiver;
  Finder: new () => { sources(): string[]; destroy(): void };
}
