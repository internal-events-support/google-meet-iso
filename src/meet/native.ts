// Typings for the native NDI addon (build/Release/gmeet_iso_ndi.node).

export interface SenderStats {
  connections: number;
  program: boolean;
  preview: boolean;
  slate: boolean;
  dropped: number;
  sent: number;
  /** Frames handed in via sendVideo(). */
  received?: number;
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
  /**
   * Zero-copy send: the sender keeps `data` and reads it on its own thread. Don't write to it until
   * it is returned by a later sendVideoOwned()/reclaim() call (the list of buffers released since).
   */
  sendVideoOwned?(data: ArrayBuffer, w: number, h: number, fmt: string, stride?: number, fpsN?: number, fpsD?: number): ArrayBuffer[];
  reclaim?(): ArrayBuffer[];
  /** fpsN > 0: send the latest submitted frame (repeating it if nothing new) at exactly fpsN/fpsD. 0 = send on submit. */
  setCadence(fpsN: number, fpsD: number): boolean;
  sendAudio(planar: Float32Array, sampleRate: number, channels: number, samplesPerChannel: number): boolean;
  stats(): SenderStats;
  destroy(): void;
}

export interface NativeReceiver {
  read(): { width: number; height: number; format: 'BGRA' | 'BGRX'; data: ArrayBuffer } | null;
  /** Copy the newest frame into `buf` (null: nothing new; bytes 0: buf too small, see `needed`). BGRA receivers only here. */
  readInto?(buf: ArrayBuffer): { width: number; height: number; format: 'BGRA' | 'BGRX'; bytes: number; needed?: number } | null;
  stats(): { connected: boolean; frames: number; width: number; height: number };
  setTally(program: boolean, preview: boolean): void;
  destroy(): void;
}

export interface NativeNdi {
  load(): { ok: boolean; version?: string; error?: string; path?: string };
  Sender: new (name: string, opts?: { idleMs?: number; groups?: string; slateWidth?: number; slateHeight?: number }) => NativeSender;
  Receiver: new (name: string, opts?: { lowBandwidth?: boolean; format?: 'BGRA' | 'UYVY' }) => NativeReceiver;
  Finder: new () => { sources(): string[]; destroy(): void };
}
