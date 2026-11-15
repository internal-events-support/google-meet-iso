// Typings for the native NDI addon (build/Release/gmeet_iso_ndi.node).

export interface SenderStats {
  connections: number;
  program: boolean;
  preview: boolean;
  slate: boolean;
  dropped: number;
  sent: number;
  width: number;
  height: number;
}

export interface NativeSender {
  sendVideo(data: ArrayBuffer | Uint8Array, w: number, h: number, fmt: string, stride?: number, fpsN?: number, fpsD?: number): boolean;
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
