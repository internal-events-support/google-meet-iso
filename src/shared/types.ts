// Types and IPC channel names shared by main, the Meet preload and the control UI.

export type CameraSourceType = 'none' | 'ndi' | 'device';

export interface CameraSource {
  type: CameraSourceType;
  /** NDI full source name ("MACHINE (Source)") or the webcam's device label. */
  name: string;
}

export interface Settings {
  /** Prefix for NDI source names, e.g. "GMEET" -> "GMEET - Alice". */
  ndiPrefix: string;
  /** Optional comma-separated NDI groups. Empty = default group. */
  ndiGroups: string;
  /** Upper bound on frames captured per participant per second. */
  maxFps: number;
  /** Seconds an NDI source stays up (black) after its tile disappears. */
  graceSeconds: number;
  /** Publish screen-share tiles as their own NDI source. */
  screenShare: boolean;
  /** Publish the bot's own tile (normally off). */
  includeSelf: boolean;
  /** Click "Join now" / "Ask to join" automatically. */
  autoJoin: boolean;
  /** Mute the hidden Meet page's local audio playback. */
  muteLocalAudio: boolean;
  /** Size of the hidden Meet viewport; Meet requests higher resolution for bigger tiles. */
  meetWindowWidth: number;
  meetWindowHeight: number;
  /** What the bot sends as its camera. */
  camera: CameraSource;
  /** Label of the local audio input the bot sends as its mic ('' = none). */
  micLabel: string;
  /** Preview thumbnails per second in the control UI. */
  previewFps: number;
  /** Last meeting link entered. */
  lastMeetUrl: string;
  /** Bot's Google account display name; used to exclude its own tile. Auto-learned. */
  botName: string;
}

export const DEFAULT_SETTINGS: Settings = {
  ndiPrefix: 'GMEET',
  ndiGroups: '',
  maxFps: 30,
  graceSeconds: 15,
  screenShare: true,
  includeSelf: false,
  autoJoin: true,
  muteLocalAudio: false,
  meetWindowWidth: 1920,
  meetWindowHeight: 1080,
  camera: { type: 'none', name: '' },
  micLabel: '',
  previewFps: 8,
  lastMeetUrl: '',
  botName: '',
};

export type FeedKind = 'camera' | 'screen';

/** Where the hidden Meet client is in the join flow. */
export type MeetPhase = 'loading' | 'signed-out' | 'home' | 'green-room' | 'waiting' | 'in-call' | 'denied' | 'ended';

export interface FeedState {
  key: string;
  participantId: string;
  displayName: string;
  ndiName: string | null;
  kind: FeedKind;
  enabled: boolean;
  /** Tile currently present in the Meet DOM. */
  present: boolean;
  /** A playing <video> is bound to the tile. */
  hasVideo: boolean;
  width: number;
  height: number;
  fps: number;
  /** Raw NDI connection count (one receiver usually opens 2 — don't show as a viewer count). */
  connections: number;
  /** Downstream tally: source is on a switcher's program / preview bus. */
  program: boolean;
  preview: boolean;
  slate: boolean;
  dropped: number;
  /** Average ms for VideoFrame readback (diagnostics). */
  copyMs: number;
  /** Pixel format of captured frames handed to NDI. */
  format: string;
}

export interface BotCamState {
  source: CameraSource;
  status: string;
  width: number;
  height: number;
  fps: number;
}

export interface MeetState {
  url: string;
  phase: MeetPhase;
  /** Human-readable detail for the phase (e.g. Meet's own message). */
  phaseDetail: string;
  inCall: boolean;
  /** Epoch ms when the bot entered the current call (0 if not in a call). */
  inCallSince: number;
  camOn: boolean | null;
  micOn: boolean | null;
  botCam: BotCamState;
  micActive: string;
  ndi: { ok: boolean; version?: string; error?: string };
  feeds: FeedState[];
  updatedAt: number;
}

export interface DeviceLists {
  videoInputs: string[];
  audioInputs: string[];
}

export interface ControlApi {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  join(url: string): Promise<void>;
  leave(): Promise<void>;
  signIn(): Promise<void>;
  setFeedEnabled(key: string, enabled: boolean): Promise<void>;
  setMeetCamera(on: boolean): Promise<void>;
  setMeetMic(on: boolean): Promise<void>;
  ndiSources(): Promise<string[]>;
  devices(): Promise<DeviceLists>;
  dumpDom(): Promise<string>;
  onState(cb: (s: MeetState) => void): void;
  onLog(cb: (line: string) => void): void;
  onPreview(cb: (key: string, jpeg: ArrayBuffer) => void): void;
  onDevices(cb: (d: DeviceLists) => void): void;
}

export const IPC = {
  // control -> main (invoke)
  getSettings: 'ctl:getSettings',
  setSettings: 'ctl:setSettings',
  join: 'ctl:join',
  leave: 'ctl:leave',
  signIn: 'ctl:signIn',
  setFeedEnabled: 'ctl:setFeedEnabled',
  setMeetCamera: 'ctl:setMeetCamera',
  setMeetMic: 'ctl:setMeetMic',
  ndiSources: 'ctl:ndiSources',
  devices: 'ctl:devices',
  dumpDom: 'ctl:dumpDom',
  // main -> control
  state: 'ctl:state',
  log: 'ctl:log',
  preview: 'ctl:preview',
  devicesChanged: 'ctl:devicesChanged',
  // meet preload <-> main
  meetState: 'meet:state',
  meetLog: 'meet:log',
  meetSettings: 'meet:settings',
  meetFeedEnabled: 'meet:feedEnabled',
  meetDumpRequest: 'meet:dumpRequest',
  meetDumpResult: 'meet:dumpResult',
  meetGetSettings: 'meet:getSettings',
  meetPreview: 'meet:preview',
  meetDevices: 'meet:devices',
  meetSetCam: 'meet:setCam',
  meetSetMic: 'meet:setMic',
  meetLeave: 'meet:leave',
  meetBotName: 'meet:botName',
} as const;

/** Preview key used for the bot's own outgoing camera. */
export const BOT_CAM_KEY = '__botcam__';
