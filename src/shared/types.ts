// Types and IPC channel names shared by main, the Meet preload and the control UI.

export type CameraSourceType = 'none' | 'ndi' | 'device';

export interface CameraSource {
  type: CameraSourceType;
  /** NDI full source name ("MACHINE (Source)") or the webcam's device label. */
  name: string;
}

// ---------------- outputs (ZoomISO-style slots) ----------------

/** What an output shows. */
export type OutputMode = 'participant' | 'activeSpeaker' | 'screenshare' | 'auto';
/** What an output shows when its source has no video. */
export type LossMode = 'black' | 'freeze' | 'transparent' | 'image' | 'testcard';
/** Audio embedded in an output's NDI stream. */
export type EmbeddedAudio = 'off' | 'iso' | 'mix';
export type EngineState = 'disabled' | 'standby' | 'enabled';

export interface OutputFormat {
  width: number;
  height: number;
  /** Frame rate as a rational, e.g. 30000/1001. */
  fpsN: number;
  fpsD: number;
}

export interface OutputEffects {
  brightness: number; // 1 = unchanged
  contrast: number;
  saturation: number;
  hue: number; // degrees
  zoom: number; // 1 = fit
  panX: number; // -1..1
  panY: number;
  mirror: boolean;
  nameTag: boolean;
  /** '' = participant's display name. */
  nameTagText: string;
  nameTagSubtitle: string;
  nameTagPosition: 'bl' | 'br' | 'tl' | 'tr';
}

export const DEFAULT_EFFECTS: OutputEffects = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  mirror: false,
  nameTag: false,
  nameTagText: '',
  nameTagSubtitle: '',
  nameTagPosition: 'bl',
};

export interface OutputSelection {
  /** Feed key (participant id, + ':screen'). */
  key: string;
  /** Display name, used to re-find someone who rejoined with a new id. */
  name: string;
}

export interface OutputConfig {
  id: string;
  /** Also the NDI source name. */
  name: string;
  enabled: boolean;
  mode: OutputMode;
  selection: OutputSelection | null;
  /** null = pass Meet's native resolution through untouched. */
  format: OutputFormat | null;
  lossMode: LossMode;
  /** Image file for lossMode 'image'. */
  lossImage: string;
  /** When the selected participant is gone: keep loss mode, or fall back to the active speaker. */
  failover: 'loss' | 'activeSpeaker';
  audio: EmbeddedAudio;
  /** Audio delay in ms (lip-sync). */
  audioDelayMs: number;
  /** Audio gain in dB. */
  audioGainDb: number;
  effects: OutputEffects;
  record: boolean;
  /** Electron display id to show this output full-screen on (null = none). */
  display: number | null;
}

export const FORMAT_PRESETS: { label: string; format: OutputFormat | null }[] = [
  { label: 'Native (from Meet)', format: null },
  { label: '720p 25', format: { width: 1280, height: 720, fpsN: 25, fpsD: 1 } },
  { label: '720p 29.97', format: { width: 1280, height: 720, fpsN: 30000, fpsD: 1001 } },
  { label: '720p 30', format: { width: 1280, height: 720, fpsN: 30, fpsD: 1 } },
  { label: '720p 50', format: { width: 1280, height: 720, fpsN: 50, fpsD: 1 } },
  { label: '720p 59.94', format: { width: 1280, height: 720, fpsN: 60000, fpsD: 1001 } },
  { label: '1080p 25', format: { width: 1920, height: 1080, fpsN: 25, fpsD: 1 } },
  { label: '1080p 29.97', format: { width: 1920, height: 1080, fpsN: 30000, fpsD: 1001 } },
  { label: '1080p 30', format: { width: 1920, height: 1080, fpsN: 30, fpsD: 1 } },
  { label: '1080p 50', format: { width: 1920, height: 1080, fpsN: 50, fpsD: 1 } },
  { label: '1080p 59.94', format: { width: 1920, height: 1080, fpsN: 60000, fpsD: 1001 } },
  { label: '2160p 29.97', format: { width: 3840, height: 2160, fpsN: 30000, fpsD: 1001 } },
];

export function formatLabel(f: OutputFormat | null): string {
  if (!f) return FORMAT_PRESETS[0].label;
  const hit = FORMAT_PRESETS.find((p) => p.format && p.format.width === f.width && p.format.height === f.height && p.format.fpsN === f.fpsN && p.format.fpsD === f.fpsD);
  return hit ? hit.label : `${f.width}×${f.height} ${(f.fpsN / f.fpsD).toFixed(2)}`;
}

export function newOutput(n: number, prefix = 'GMEET', patch: Partial<OutputConfig> = {}): OutputConfig {
  return {
    id: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: `${prefix} ${n}`,
    enabled: true,
    mode: 'auto',
    selection: null,
    format: { width: 1280, height: 720, fpsN: 30000, fpsD: 1001 },
    lossMode: 'black',
    lossImage: '',
    failover: 'loss',
    audio: 'iso',
    audioDelayMs: 0,
    audioGainDb: 0,
    effects: { ...DEFAULT_EFFECTS },
    record: false,
    display: null,
    ...patch,
  };
}

export function defaultOutputs(prefix = 'GMEET'): OutputConfig[] {
  return [
    newOutput(1, prefix),
    newOutput(2, prefix),
    newOutput(3, prefix),
    newOutput(4, prefix),
    newOutput(5, prefix, { name: `${prefix} Screen`, mode: 'screenshare', audio: 'mix' }),
    newOutput(6, prefix, { name: `${prefix} Speaker`, mode: 'activeSpeaker', audio: 'mix' }),
  ];
}

/** Output reference used by commands/OSC: 1-based index, id, or name. */
export type OutputRef = number | string;

export function findOutput(outputs: OutputConfig[], ref: OutputRef): OutputConfig | undefined {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) return outputs[Number(ref) - 1];
  return outputs.find((o) => o.id === ref) ?? outputs.find((o) => o.name.toLowerCase() === String(ref).toLowerCase());
}

/** Every operator action. Sent by the UI, OSC, HTTP/WebSocket API and the dev CLI. */
export type Command =
  | { cmd: 'engine'; state: EngineState }
  | { cmd: 'setOutputCount'; count: number }
  | { cmd: 'addOutput'; patch?: Partial<OutputConfig> }
  | { cmd: 'deleteOutput'; output: OutputRef }
  | { cmd: 'updateOutput'; output: OutputRef; patch: Partial<OutputConfig> }
  | { cmd: 'route'; output: OutputRef; participant: string | null }
  | { cmd: 'join'; url: string }
  | { cmd: 'leave' }
  | { cmd: 'chat'; text: string }
  | { cmd: 'admit'; who?: string }
  | { cmd: 'deny'; who?: string }
  | { cmd: 'muteParticipant'; participant: string }
  | { cmd: 'applyLayout' }
  | { cmd: 'setCam'; on: boolean }
  | { cmd: 'setMic'; on: boolean }
  | { cmd: 'recordAll'; on: boolean }
  | { cmd: 'saveShow'; path?: string }
  | { cmd: 'loadShow'; path?: string; merge?: boolean };

export interface Settings {
  /** Default prefix for new output names (and NDI sources), e.g. "GMEET 1". */
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
  /** Output engine: disabled (no sources), standby (sources up, loss content), enabled (live). */
  engine: EngineState;
  outputs: OutputConfig[];
  /** Force Meet's Tiled layout with the max tile count so every participant renders. */
  autoLayout: boolean;
  /** Meet's tile count in Tiled layout (6–49). */
  maxTiles: number;
  /** Admit everyone who asks to join (when the bot is a host). */
  autoAdmit: boolean;
  /** Post a chat notice when the bot joins. '' = off. */
  joinNotice: string;
  /** Label of a local audio output to play the meeting mix on ('' = system default via Meet). */
  monitorDevice: string;
  /** OSC control. */
  oscEnabled: boolean;
  oscListenPort: number;
  oscReplyHost: string;
  oscReplyPort: number;
  /** HTTP + WebSocket API on localhost. */
  apiEnabled: boolean;
  apiPort: number;
  /** NDI network: discovery server ("host:port", '' = mDNS) and NIC IPs (comma separated). */
  ndiDiscoveryServer: string;
  ndiNicIps: string;
  /** Recording folder; '' = Videos/GMeet ISO. */
  recordDir: string;
  /** Minimum log level shown. */
  logLevel: 'error' | 'warn' | 'info' | 'verbose';
  /** Control UI layout for outputs. */
  outputsView: 'grid' | 'list' | 'multiview';
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
  // Tiled layout gives each tile a share of this; 1440p keeps tiles big enough that Meet
  // sends 720p streams (1080p viewport → 640×360 with 3 tiles).
  meetWindowWidth: 2560,
  meetWindowHeight: 1440,
  camera: { type: 'none', name: '' },
  micLabel: '',
  previewFps: 8,
  lastMeetUrl: '',
  botName: '',
  engine: 'enabled',
  outputs: defaultOutputs('GMEET'),
  autoLayout: true,
  maxTiles: 49,
  autoAdmit: false,
  joinNotice: 'This meeting is being captured for broadcast.',
  monitorDevice: '',
  oscEnabled: true,
  oscListenPort: 9099,
  oscReplyHost: '127.0.0.1',
  oscReplyPort: 9098,
  apiEnabled: true,
  apiPort: 8787,
  ndiDiscoveryServer: '',
  ndiNicIps: '',
  recordDir: '',
  logLevel: 'info',
  outputsView: 'grid',
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

export interface ParticipantState {
  key: string;
  participantId: string;
  displayName: string;
  kind: FeedKind;
  isSelf: boolean;
  hasVideo: boolean;
  width: number;
  height: number;
  fps: number;
  /** Mic muted in Meet (null = unknown). */
  muted: boolean | null;
  handRaised: boolean;
  /** 0..1 audio level when attributed. */
  level: number;
  speaking: boolean;
  /** Output ids currently showing this participant. */
  outputs: string[];
}

export interface OutputState {
  id: string;
  name: string;
  live: boolean;
  /** Key/name of the participant currently shown, if any. */
  sourceKey: string | null;
  sourceName: string;
  /** 'live' | 'loss' | 'standby' | 'off' */
  status: string;
  inWidth: number;
  inHeight: number;
  inFps: number;
  outWidth: number;
  outHeight: number;
  outFps: number;
  connections: number;
  program: boolean;
  preview: boolean;
  /** ms from frame arrival to NDI hand-off. */
  latencyMs: number;
  audioLevel: number;
  recording: boolean;
  recordFile: string;
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
  participants: ParticipantState[];
  outputs: OutputState[];
  engine: EngineState;
  activeSpeaker: string | null;
  /** People asking to join (names), when visible to the bot. */
  waiting: string[];
  rxMbps: number;
  mixLevel: number;
  updatedAt: number;
}

export interface SystemStats {
  cpu: number;
  memMB: number;
  rxMbps: number;
  displays: { id: number; label: string; primary: boolean }[];
  oscPort: number | null;
  apiUrl: string | null;
}

export interface DeviceLists {
  videoInputs: string[];
  audioInputs: string[];
  audioOutputs: string[];
}

export interface ControlApi {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  join(url: string): Promise<void>;
  leave(): Promise<void>;
  signIn(): Promise<void>;
  setMeetCamera(on: boolean): Promise<void>;
  setMeetMic(on: boolean): Promise<void>;
  ndiSources(): Promise<string[]>;
  devices(): Promise<DeviceLists>;
  dumpDom(): Promise<string>;
  onState(cb: (s: MeetState) => void): void;
  onLog(cb: (line: string) => void): void;
  onPreview(cb: (key: string, jpeg: ArrayBuffer) => void): void;
  onDevices(cb: (d: DeviceLists) => void): void;
  command(c: Command): Promise<unknown>;
  pickFile(kind: 'image' | 'show-open' | 'show-save' | 'folder'): Promise<string | null>;
  onSystem(cb: (s: SystemStats) => void): void;
  system(): Promise<SystemStats>;
  /** Settings changed elsewhere (OSC, API, show file). */
  onSettings(cb: (s: Settings) => void): void;
}

export const IPC = {
  // control -> main (invoke)
  getSettings: 'ctl:getSettings',
  setSettings: 'ctl:setSettings',
  join: 'ctl:join',
  leave: 'ctl:leave',
  signIn: 'ctl:signIn',
  setMeetCamera: 'ctl:setMeetCamera',
  setMeetMic: 'ctl:setMeetMic',
  ndiSources: 'ctl:ndiSources',
  devices: 'ctl:devices',
  dumpDom: 'ctl:dumpDom',
  command: 'ctl:command',
  pickFile: 'ctl:pickFile',
  system: 'ctl:system',
  // main -> control
  state: 'ctl:state',
  log: 'ctl:log',
  preview: 'ctl:preview',
  devicesChanged: 'ctl:devicesChanged',
  // meet preload <-> main
  meetState: 'meet:state',
  meetLog: 'meet:log',
  meetSettings: 'meet:settings',
  meetDumpRequest: 'meet:dumpRequest',
  meetDumpResult: 'meet:dumpResult',
  meetGetSettings: 'meet:getSettings',
  meetPreview: 'meet:preview',
  meetDevices: 'meet:devices',
  meetSetCam: 'meet:setCam',
  meetSetMic: 'meet:setMic',
  meetLeave: 'meet:leave',
  meetBotName: 'meet:botName',
  meetCommand: 'meet:command',
} as const;

/** Preview key used for the bot's own outgoing camera. */
export const BOT_CAM_KEY = '__botcam__';
