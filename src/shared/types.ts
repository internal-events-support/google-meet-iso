// Types and IPC channel names shared by main, the Meet preload and the control UI.

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
  /** Click "Join now" / "Ask to join" automatically on the green room page. */
  autoJoin: boolean;
  /** Mute the Meet window's local audio playback. */
  muteLocalAudio: boolean;
  /** Meet window size; Meet requests higher resolution for bigger tiles. */
  meetWindowWidth: number;
  meetWindowHeight: number;
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
};

export type FeedKind = 'camera' | 'screen';

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
  connections: number;
  slate: boolean;
  dropped: number;
  /** Average ms for VideoFrame readback (diagnostics). */
  copyMs: number;
  /** Pixel format of captured frames handed to NDI. */
  format: string;
}

export interface MeetState {
  url: string;
  inCall: boolean;
  ndi: { ok: boolean; version?: string; error?: string };
  feeds: FeedState[];
  updatedAt: number;
}

export interface ControlApi {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  join(url: string): Promise<void>;
  leave(): Promise<void>;
  signIn(): Promise<void>;
  showMeetWindow(): Promise<void>;
  setFeedEnabled(key: string, enabled: boolean): Promise<void>;
  dumpDom(): Promise<string>;
  onState(cb: (s: MeetState) => void): void;
  onLog(cb: (line: string) => void): void;
}

export const IPC = {
  // control -> main (invoke)
  getSettings: 'ctl:getSettings',
  setSettings: 'ctl:setSettings',
  join: 'ctl:join',
  leave: 'ctl:leave',
  signIn: 'ctl:signIn',
  showMeet: 'ctl:showMeet',
  setFeedEnabled: 'ctl:setFeedEnabled',
  dumpDom: 'ctl:dumpDom',
  // main -> control
  state: 'ctl:state',
  log: 'ctl:log',
  // meet preload <-> main
  meetState: 'meet:state',
  meetLog: 'meet:log',
  meetSettings: 'meet:settings',
  meetFeedEnabled: 'meet:feedEnabled',
  meetDumpRequest: 'meet:dumpRequest',
  meetDumpResult: 'meet:dumpResult',
  meetGetSettings: 'meet:getSettings',
} as const;
