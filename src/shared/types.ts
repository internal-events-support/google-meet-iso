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
export type LossMode = 'black' | 'freeze' | 'transparent' | 'image' | 'testcard' | 'profilePicture';
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
  nameTagPosition: 'bl' | 'br' | 'tl' | 'tr' | 'bc' | 'tc';
  // ---- Color tab (ZoomISO v3). Bipolar values are -1..1 (0 = neutral, UI shows 50%). ----
  /** Exposure in -1..1 (= ±2 stops). */
  exposure?: number;
  vibrance?: number;
  /** 0..1 unsharp-mask amount. */
  sharpness?: number;
  /** -1 (cool/blue) .. 1 (warm/orange). */
  temperature?: number;
  /** -1 (green) .. 1 (magenta). */
  tint?: number;
  highlights?: number;
  shadows?: number;
  /** 0..1 vignette strength. */
  vignette?: number;
  /** Master tone curve control points [x, y] in 0..1, sorted by x (first/last x = 0/1). */
  toneCurve?: [number, number][];
  /** Lift / Gamma / Gain per channel, -1..1 each (0 = neutral). */
  liftR?: number;
  liftG?: number;
  liftB?: number;
  gammaR?: number;
  gammaG?: number;
  gammaB?: number;
  gainR?: number;
  gainG?: number;
  gainB?: number;
  // ---- Cropping tab ----
  /** Crop insets as fractions (0..0.95) of the source size. */
  cropLeft?: number;
  cropRight?: number;
  cropTop?: number;
  cropBottom?: number;
  /** true = letterbox / allow black padding; false = fill the output (crop to aspect). */
  padBlack?: boolean;
  // ---- Overlays tab ----
  /** Name tag text size, % of the default (100 = 4.5% of output height). */
  nameTagSize?: number;
  /** PANameTagFont. Old values ('system','serif','mono','rounded','condensed') are migrated by migrateNameTagFont(). */
  nameTagFont?: NameTagFont;
  nameTagColor?: string;
  nameTagBg?: string;
  /** 0..1 */
  nameTagBgOpacity?: number;
  nameTagAccent?: string;
  /** Image overlays, drawn bottom-to-top in array order (below the name tag). */
  images?: OverlayImage[];
  // ---- Phase 0: ProcAmpSettings fields (RE 04) ----
  /** White balance in Kelvin (RE whiteBalanceK). 6500 = neutral. Engine may derive `temperature` from it. */
  whiteBalanceK?: number;
  /** Cropping tab transform (RE cropZoom/cropPanX/cropPanY/cropRotation). zoom 1 = fit; pan -1..1; rotation degrees. */
  cropZoom?: number;
  cropPanX?: number;
  cropPanY?: number;
  cropRotation?: number;
  /** Name tag text source: auto = participant name, manual = nameTagText. */
  nameTagNameMode?: NameTagNameMode;
  /** Horizontal placement of the name tag box. */
  nameTagPlacement?: NameTagPlacement;
  /** Text alignment inside the name tag box. */
  nameTagTextAlignment?: NameTagTextAlignment;
  /** Corner radius in px at 1080p (scaled with output height). */
  nameTagCornerRadius?: number;
  /** RE `nameTagPosition` (Double): vertical position 0 (top) .. 1 (bottom). Our legacy corner enum stays in `nameTagPosition`. */
  nameTagOffset?: number;
  /** Layer order, bottom → top. Entries: 'nameTag' or `image:<OverlayImage.id>`. Missing entries are appended in default order. */
  overlayLayerOrder?: OverlayLayerRef[];
  /** Output Effects window "Auto Apply": push edits to the live output immediately. */
  autoApply?: boolean;
}

export type NameTagFont = 'tahoma' | 'helvetica' | 'arial' | 'verdana' | 'georgia' | 'timesNewRoman' | 'courierNew';
export type NameTagNameMode = 'auto' | 'manual';
export type NameTagPlacement = 'left' | 'center' | 'right';
export type NameTagTextAlignment = 'left' | 'center' | 'right';
/** 'nameTag' or `image:${id}`. */
export type OverlayLayerRef = 'nameTag' | `image:${string}`;

/** CSS font-family stacks for each name tag font (Windows fallbacks included). */
export const NAME_TAG_FONT_CSS: Record<NameTagFont, string> = {
  tahoma: 'Tahoma, Verdana, sans-serif',
  helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  arial: 'Arial, Helvetica, sans-serif',
  verdana: 'Verdana, Tahoma, sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  timesNewRoman: '"Times New Roman", Times, serif',
  courierNew: '"Courier New", Courier, monospace',
};

/** Map pre-v3 font ids onto PANameTagFont. Unknown → 'helvetica'. */
export function migrateNameTagFont(v: unknown): NameTagFont {
  const legacy: Record<string, NameTagFont> = { system: 'helvetica', serif: 'timesNewRoman', mono: 'courierNew', rounded: 'verdana', condensed: 'tahoma' };
  const s = String(v ?? '');
  if (s in NAME_TAG_FONT_CSS) return s as NameTagFont;
  return legacy[s] ?? 'helvetica';
}

export interface OverlayImage {
  id: string;
  path: string;
  /** Centre position, 0..1 of the output. */
  x: number;
  y: number;
  /** Width as a fraction of the output width. */
  scale: number;
  opacity: number;
  visible: boolean;
  /** Degrees (RE CodableImageOverlay.rotation). */
  rotation?: number;
  /** Stacking index (RE zIndex). overlayLayerOrder is authoritative when present. */
  zIndex?: number;
  /** Display name for the layer list (defaults to the path's basename). */
  filename?: string;
  /** width / height of the source image, cached for handles. */
  aspect?: number;
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
  exposure: 0,
  vibrance: 0,
  sharpness: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  vignette: 0,
  toneCurve: [
    [0, 0],
    [0.25, 0.25],
    [0.5, 0.5],
    [0.75, 0.75],
    [1, 1],
  ],
  liftR: 0,
  liftG: 0,
  liftB: 0,
  gammaR: 0,
  gammaG: 0,
  gammaB: 0,
  gainR: 0,
  gainG: 0,
  gainB: 0,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
  padBlack: true,
  nameTagSize: 100,
  nameTagFont: 'helvetica',
  nameTagColor: '#ffffff',
  nameTagBg: '#0a0c10',
  nameTagBgOpacity: 0.78,
  nameTagAccent: '#3b82f6',
  images: [],
  whiteBalanceK: 6500,
  cropZoom: 1,
  cropPanX: 0,
  cropPanY: 0,
  cropRotation: 0,
  nameTagNameMode: 'auto',
  nameTagPlacement: 'left',
  nameTagTextAlignment: 'left',
  nameTagCornerRadius: 6,
  nameTagOffset: 0.85,
  overlayLayerOrder: ['nameTag'],
  autoApply: true,
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
  // ---- Phase 0: ZISOStream fields (RE 03 ZISOStream.CodingKeys) ----
  /** Mode 'auto' slots that the auto-assigner may fill (RE isAutoAssign). */
  isAutoAssign?: boolean;
  /** Follow Settings.embeddedAudio.defaultMode instead of `audio` (RE useDefaultAudioMode). */
  useDefaultAudioMode?: boolean;
  /** Per-output video loss override; used only when Settings.videoLoss.perOutputVideoLossEnabled. null = use global. */
  videoLoss?: VideoLossSettings | null;
  /** Face-tracking auto crop (RE autoCrop*). Optional engine feature. */
  autoCropEnabled?: boolean;
  autoCropShowGuides?: boolean;
  autoCropShowFaceGuides?: boolean;
  autoCropShowTargetSizeGuide?: boolean;
  autoCropShowOverscanHorizontalGuide?: boolean;
  autoCropShowOverscanVerticalGuide?: boolean;
  /** 0..1 face box height as a fraction of the frame. */
  autoCropTargetSize?: number;
  /** 0..1 (0 = top, 0.5 = centre, 1 = bottom). */
  autoCropTargetVertical?: number;
  autoCropResponsiveness?: AutoCropResponsiveness;
  autoCropExtendHorizontal?: boolean;
  autoCropExtendVertical?: boolean;
  /** 0..1 */
  autoCropOverscanHorizontal?: number;
  autoCropOverscanVertical?: number;
  autoCropZoomOutOnLostFace?: boolean;
}

export type AutoCropResponsiveness = 'low' | 'medium' | 'high';

export const DEFAULT_AUTO_CROP: Required<Pick<OutputConfig,
  | 'autoCropEnabled' | 'autoCropShowGuides' | 'autoCropShowFaceGuides' | 'autoCropShowTargetSizeGuide'
  | 'autoCropShowOverscanHorizontalGuide' | 'autoCropShowOverscanVerticalGuide' | 'autoCropTargetSize' | 'autoCropTargetVertical'
  | 'autoCropResponsiveness' | 'autoCropExtendHorizontal' | 'autoCropExtendVertical' | 'autoCropOverscanHorizontal'
  | 'autoCropOverscanVertical' | 'autoCropZoomOutOnLostFace'>> = {
  autoCropEnabled: false,
  autoCropShowGuides: false,
  autoCropShowFaceGuides: false,
  autoCropShowTargetSizeGuide: false,
  autoCropShowOverscanHorizontalGuide: false,
  autoCropShowOverscanVerticalGuide: false,
  autoCropTargetSize: 0.35,
  autoCropTargetVertical: 0.4,
  autoCropResponsiveness: 'medium',
  autoCropExtendHorizontal: false,
  autoCropExtendVertical: false,
  autoCropOverscanHorizontal: 0.1,
  autoCropOverscanVertical: 0.1,
  autoCropZoomOutOnLostFace: true,
};

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
    isAutoAssign: true,
    useDefaultAudioMode: false,
    videoLoss: null,
    ...DEFAULT_AUTO_CROP,
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
  | { cmd: 'loadShow'; path?: string; merge?: boolean }
  // ---- Phase 0 additions ----
  /** Patch video loss settings: global (no output) or one output's override (also enables it for that output). */
  | { cmd: 'setVideoLoss'; output?: OutputRef; patch: Partial<VideoLossSettings> | null }
  /** Start recording the given outputs (ids/refs). Omitted = Settings.recording.selectedOutputIds. */
  | { cmd: 'startRecording'; outputs?: OutputRef[] }
  /** Stop recording (all, or just the listed outputs). */
  | { cmd: 'stopRecording'; outputs?: OutputRef[] }
  /** Participant Management matrix: put a participant on an output (null participant = clear that output). */
  | { cmd: 'assignParticipant'; participant: string | null; output: OutputRef }
  /** Remove a participant from every output showing them. */
  | { cmd: 'unassignParticipant'; participant: string }
  | { cmd: 'setAutoAssign'; output: OutputRef; on: boolean }
  /** Reset an output's effects (one tab or everything) to DEFAULT_EFFECTS. */
  | { cmd: 'resetEffects'; output: OutputRef; section?: 'color' | 'crop' | 'overlays' | 'all' }
  /** Copy one output's effects onto others. */
  | { cmd: 'copyEffects'; from: OutputRef; to: OutputRef[] }
  /** Meet spotlight/pin (best effort, forwarded to the Meet page). */
  | { cmd: 'spotlight'; participant: string; on: boolean }
  | { cmd: 'pin'; participant: string; on: boolean }
  | { cmd: 'lowerHand'; participant?: string }
  | { cmd: 'muteAll' }
  | { cmd: 'removeParticipant'; participant: string }
  /** OSC Command Browser: enable/disable a command address. */
  | { cmd: 'setOscCommandEnabled'; address: string; enabled: boolean }
  /** Sign the bot's Google account out of Meet. */
  | { cmd: 'signOut' }
  /** Menu "Clear Cache (app will close)": wipe settings + Meet cache, then quit. `confirm: false` skips the dialog. */
  | { cmd: 'clearCache'; confirm?: boolean }
  // ---- [osc-agent] ZoomOSC/ZoomISO OSC coverage ----
  /** Raise/lower the bot's own hand in Meet (forwarded to the Meet page). */
  | { cmd: 'raiseHand'; on: boolean }
  /** OSC /subscribe: set Settings.osc.subscribeMode. */
  | { cmd: 'setOscSubscribe'; mode: OscSubscribeMode };


// =====================================================================
// Phase 0: global settings groups (RE 04 view models / 03 CodingKeys)
// =====================================================================

/** RE VideoLossDelayMode: how long to wait before switching to loss content. */
export type VideoLossDelay = 'low' | 'medium' | 'high';
/** Milliseconds for each VideoLossDelay. TODO(engine): confirm against ZoomISO timings. */
export const VIDEO_LOSS_DELAY_MS: Record<VideoLossDelay, number> = { low: 500, medium: 2000, high: 5000 };

/** RE VideoLossSettings (global, and per-output override). Colours are CSS hex. */
export interface VideoLossSettings {
  mode: LossMode;
  /** Image file for mode 'image' (RE videoOffImageURL). */
  image: string;
  displayOutputNameOnImage: boolean;
  /** Profile picture diameter as a fraction of output height (0.1..0.9). */
  profilePictureSize: number;
  profilePictureForceInitials: boolean;
  profilePictureBackgroundColor: string;
  profilePictureOverrideInitialsBgColor: boolean;
  profilePictureInitialsBgColor: string;
  profilePictureInitialsColor: string;
  profilePictureShowName: boolean;
}

export const DEFAULT_VIDEO_LOSS: VideoLossSettings = {
  mode: 'black',
  image: '',
  displayOutputNameOnImage: false,
  profilePictureSize: 0.4,
  profilePictureForceInitials: false,
  profilePictureBackgroundColor: '#222222',
  profilePictureOverrideInitialsBgColor: false,
  profilePictureInitialsBgColor: '#4793F1',
  profilePictureInitialsColor: '#FFFFFF',
  profilePictureShowName: true,
};

/** Global video-loss block on Settings (VideoLossSettings + StreamManagerSwifter extras). */
export interface GlobalVideoLossSettings extends VideoLossSettings {
  /** RE videoLossTime (VideoLossDelayMode). */
  delay: VideoLossDelay;
  /** RE perOutputVideoLossEnabled: honour OutputConfig.videoLoss overrides. */
  perOutputVideoLossEnabled: boolean;
}

export const DEFAULT_GLOBAL_VIDEO_LOSS: GlobalVideoLossSettings = { ...DEFAULT_VIDEO_LOSS, delay: 'medium', perOutputVideoLossEnabled: false };

/** The loss settings that apply to an output right now. */
export function effectiveVideoLoss(s: Pick<Settings, 'videoLoss'>, o: Pick<OutputConfig, 'videoLoss' | 'lossMode' | 'lossImage'>): VideoLossSettings {
  if (s.videoLoss.perOutputVideoLossEnabled && o.videoLoss) return { ...DEFAULT_VIDEO_LOSS, ...o.videoLoss };
  return s.videoLoss;
}

export type RecordingFormat = 'mov' | 'mp4' | 'mkv' | 'mxf';
export type RecordingVideoCodec = 'h264' | 'hevc' | 'proRes422LT';
export type RecordingDateFormat = 'standard' | 'compact' | 'compactNoSeconds' | 'shortYear' | 'shortYearNoSeconds' | 'dateOnly' | 'timeOnly' | 'none';

/** RE RecordingSettings. The folder stays in Settings.recordDir (RE outputDirectory). */
export interface RecordingSettings {
  format: RecordingFormat;
  videoCodec: RecordingVideoCodec;
  videoBitrateMbps: number;
  fileNamePrefix: string;
  fileNameSuffix: string;
  fileNameDateFormat: RecordingDateFormat;
  /** Output ids ticked in "Select outputs for recording". */
  selectedOutputIds: string[];
  /** Warn when free space drops below this % of the drive. */
  lowDiskWarningPercent: number;
  /** RE selectNewOutputsByDefault ("Auto-select newly added outputs for recording"). */
  selectNewOutputsByDefault: boolean;
}

export const DEFAULT_RECORDING: RecordingSettings = {
  format: 'mp4',
  videoCodec: 'h264',
  videoBitrateMbps: 10,
  fileNamePrefix: '',
  fileNameSuffix: '',
  fileNameDateFormat: 'standard',
  selectedOutputIds: [],
  lowDiskWarningPercent: 10,
  selectNewOutputsByDefault: false,
};

export type OfflineParticipantMatching = 'off' | 'matchByID' | 'matchByIDOrName';

/** RE AutoAssignSettings. */
export interface AutoAssignSettings {
  includeHostsAndCoHosts: boolean;
  includeNonVideoParticipants: boolean;
  includeSelfCamera: boolean;
  continuouslyEvaluateEligibility: boolean;
  offlineParticipantMatching: OfflineParticipantMatching;
}

export const DEFAULT_AUTO_ASSIGN: AutoAssignSettings = {
  includeHostsAndCoHosts: true,
  includeNonVideoParticipants: true,
  includeSelfCamera: false,
  continuouslyEvaluateEligibility: true,
  offlineParticipantMatching: 'matchByIDOrName',
};

/** RE InterfaceSettings. */
export interface InterfaceSettings {
  showSystemPerformanceSummary: boolean;
  compactMode: boolean;
  /** Image used by the Output Effects "Custom Framing Guide" ('' = none). */
  customFramingGuidePath: string;
}

export const DEFAULT_INTERFACE: InterfaceSettings = { showSystemPerformanceSummary: true, compactMode: false, customFramingGuidePath: '' };

/** RE ZISOAudioChannelMode (audio output channel content). Labels: see AUDIO_CHANNEL_MODE_OPTIONS. */
export type AudioChannelMode =
  | 'none'
  | 'participant'
  | 'output'
  | 'activeSpeaker'
  | 'screenshare'
  | 'mixAll'
  | 'mixOutputs'
  | 'mixUnassigned'
  | 'interpretation';
export type PanPattern = 'mono' | 'stereo';

/** RE AdvancedAudioSettingsViewModel: defaults for new audio-output channels. */
export interface AdvancedAudioSettings {
  defaultChannelMode: AudioChannelMode;
  defaultPanPattern: PanPattern;
  /** Gain reduction in dB (0, -3, -6 …). RE stores an index into GAIN_REDUCTION_OPTIONS. */
  defaultGainDb: number;
  /** Seconds. */
  defaultDelaySeconds: number;
}

export const DEFAULT_ADVANCED_AUDIO: AdvancedAudioSettings = { defaultChannelMode: 'none', defaultPanPattern: 'stereo', defaultGainDb: 0, defaultDelaySeconds: 0 };

/** RE EmbeddedAudioSettingsViewModel. Kept in sync with legacy defaultAudio/defaultDelayMs by main. */
export interface EmbeddedAudioSettings {
  defaultMode: EmbeddedAudio;
  defaultDelayMs: number;
}

export const DEFAULT_EMBEDDED_AUDIO: EmbeddedAudioSettings = { defaultMode: 'iso', defaultDelayMs: 0 };

/** RE ZOSCBaudRate: minimum gap between outgoing OSC messages. */
export type OscBaudRate = 'fastest' | 'ms500' | 'ms1000' | 'ms2000' | 'ms5000' | 'ms10000' | 'ms25000';
export const OSC_BAUD_MS: Record<OscBaudRate, number> = { fastest: 0, ms500: 500, ms1000: 1000, ms2000: 2000, ms5000: 5000, ms10000: 10000, ms25000: 25000 };
/** RE ZOSCSubscribeMode (case names not in the RE dump; ZoomOSC semantics). */
export type OscSubscribeMode = 'none' | 'targetList' | 'all' | 'panelists' | 'gallery';

/**
 * RE ZOSCManager. main.ts mirrors enabled/rxPort/host/txPort ↔ legacy oscEnabled/oscListenPort/
 * oscReplyHost/oscReplyPort, so either form can be patched.
 */
export interface OscSettings {
  enabled: boolean;
  /** Where replies/events go ('' = sender of the last command). */
  host: string;
  rxPort: number;
  txPort: number;
  /** Local interface IP to listen on ('' = all). */
  interface: string;
  enableAllowList: boolean;
  /** Allowed sender IPs. */
  allowList: string[];
  /** File the allow list was loaded from ("Upload OSC allow list"). */
  allowListPath: string;
  baudRate: OscBaudRate;
  /** "OSC address header": prefix for outgoing messages, e.g. '/gmeetosc'. */
  prepend: string;
  subscribeMode: OscSubscribeMode;
  /** Command addresses disabled in the Command Browser. */
  disabledCommands: string[];
}

export const DEFAULT_OSC: OscSettings = {
  enabled: true,
  host: '127.0.0.1',
  rxPort: 9099,
  txPort: 9098,
  interface: '',
  enableAllowList: false,
  allowList: [],
  allowListPath: '',
  baudRate: 'fastest',
  prepend: '/gmeetosc',
  subscribeMode: 'all',
  disabledCommands: [],
};

/** RE ParticipantManagementFilters. */
export type ParticipantFilter = 'hostOrCohost' | 'videoOn' | 'audioOn' | 'handRaised';

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
  /** Settings window: start the output engine (enabled) when the bot enters a call. */
  autoStartEngine: boolean;
  /** Defaults applied to newly created outputs (addOutput / setOutputCount). */
  defaultFormat: OutputFormat | null;
  defaultAudio: EmbeddedAudio;
  defaultGainDb: number;
  defaultDelayMs: number;
  defaultLossMode: LossMode;
  defaultLossImage: string;
  defaultNameTag: boolean;
  defaultNameTagPosition: OutputEffects['nameTagPosition'];
  /** New outputs are armed for recording. */
  recordNewOutputs: boolean;
  /** Auto-assign: route participants whose camera is off (no live video) to auto outputs. */
  autoAssignCamerasOff: boolean;
  /** Minimum log level shown. */
  logLevel: 'error' | 'warn' | 'info' | 'verbose';
  /** Control UI layout for outputs. */
  outputsView: 'grid' | 'list' | 'multiview';
  /** Audio tab: local output devices enrolled in the Outputs table (in display order). */
  audioOutputDevices: string[];
  /** Audio tab: local input devices enrolled in the Inputs routing table (in display order). */
  audioInputDevices: string[];
  /** [audio-agent] Audio tab: per-device channel routing, keyed by output-device label. */
  audioOutputConfig?: Record<string, AudioOutputDeviceConfig>;
  /** [audio-agent] CombinedAudioDeviceSheet sort order (RE DeviceSortOrder). */
  audioDeviceSortOrder?: DeviceSortOrder;
  // ---- Phase 0 groups (deep-merged with defaults on load by main.ts) ----
  videoLoss: GlobalVideoLossSettings;
  recording: RecordingSettings;
  autoAssign: AutoAssignSettings;
  interface: InterfaceSettings;
  advancedAudio: AdvancedAudioSettings;
  embeddedAudio: EmbeddedAudioSettings;
  osc: OscSettings;
}

/** Settings keys holding nested objects that must be deep-merged with their defaults. */
export const NESTED_SETTINGS_KEYS = ['videoLoss', 'recording', 'autoAssign', 'interface', 'advancedAudio', 'embeddedAudio', 'osc'] as const;

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
  autoStartEngine: false,
  defaultFormat: { width: 1280, height: 720, fpsN: 30000, fpsD: 1001 },
  defaultAudio: 'iso',
  defaultGainDb: 0,
  defaultDelayMs: 0,
  defaultLossMode: 'black',
  defaultLossImage: '',
  defaultNameTag: false,
  defaultNameTagPosition: 'bl',
  recordNewOutputs: false,
  autoAssignCamerasOff: true,
  logLevel: 'info',
  outputsView: 'grid',
  audioOutputDevices: [],
  audioInputDevices: [],
  videoLoss: { ...DEFAULT_GLOBAL_VIDEO_LOSS },
  recording: { ...DEFAULT_RECORDING },
  autoAssign: { ...DEFAULT_AUTO_ASSIGN },
  interface: { ...DEFAULT_INTERFACE },
  advancedAudio: { ...DEFAULT_ADVANCED_AUDIO },
  embeddedAudio: { ...DEFAULT_EMBEDDED_AUDIO },
  osc: { ...DEFAULT_OSC },
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
  /** Meeting role, when the Meet DOM exposes it. */
  isHost?: boolean;
  isCohost?: boolean;
  /** Meet profile picture URL (for loss mode 'profilePicture'). */
  avatarUrl?: string;
  /** Spotlit / pinned in Meet (best effort). */
  spotlit?: boolean;
  pinned?: boolean;
}

/** Does a participant pass every active Participant Management filter? */
export function participantMatches(p: ParticipantState, filters: ParticipantFilter[]): boolean {
  return filters.every((f) =>
    f === 'hostOrCohost' ? !!(p.isHost || p.isCohost) : f === 'videoOn' ? p.hasVideo : f === 'audioOn' ? p.muted === false : p.handRaised,
  );
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
  /** ms spent rendering one output frame (draw + readback); 0 for passthrough. */
  cycleMs?: number;
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
  /** [audio-agent] Audio Outputs: per-device channel peaks (0..1) and the device's real channel count. */
  audioOutputMeters?: Record<string, number[]>;
  audioOutputChannels?: Record<string, number>;
  updatedAt: number;
}

export interface SystemStats {
  cpu: number;
  memMB: number;
  rxMbps: number;
  displays: { id: number; label: string; primary: boolean }[];
  oscPort: number | null;
  apiUrl: string | null;
  /** IPv4 network adapters (Settings → NDI network adapters). */
  nics?: { name: string; address: string }[];
  /** Free/total space on the recording drive. */
  disk?: { freeGB: number; totalGB: number; path: string } | null;
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
  /** Open (or focus) a secondary window. `arg` is passed as ?arg= (e.g. output id). */
  openWindow(kind: WindowKind, arg?: string): Promise<void>;
  /** Recent log lines (for windows opened later). */
  logs(): Promise<string[]>;
  /** Performance samples recorded by main (1 Hz, last 30 min). */
  perfHistory(): Promise<PerfSample[]>;
  /** Clear perf history; `capture` false pauses sampling. */
  perfControl(action: 'clear' | 'stop' | 'start'): Promise<{ capturing: boolean; since: number }>;
  openPath(kind: 'recordings' | 'logs' | 'userData'): Promise<void>;
  /** Show/hide the (normally hidden) Meet window for troubleshooting. */
  setMeetWindowVisible(visible: boolean): Promise<boolean>;
  /** Pop up the application menu (GMeet ISO / File / Edit / Window / Help) at window coords. */
  popupAppMenu(x?: number, y?: number): Promise<void>;
}

export type WindowKind = 'settings' | 'effects' | 'perf';

export interface PerfSample {
  t: number;
  cpu: number;
  memMB: number;
  rxMbps: number;
  outputs: { id: string; name: string; inW: number; inH: number; inFps: number; outW: number; outH: number; outFps: number; latencyMs: number; cycleMs: number }[];
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
  openWindow: 'ctl:openWindow',
  logs: 'ctl:logs',
  perfHistory: 'ctl:perfHistory',
  perfControl: 'ctl:perfControl',
  openPath: 'ctl:openPath',
  setMeetWindowVisible: 'ctl:setMeetWindowVisible',
  popupAppMenu: 'ctl:popupAppMenu',
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


// =====================================================================
// Phase 0: option lists for UI pickers. Labels from RE 05-UI-Strings /
// data/ui-labels.txt where the RE has them (Zoom → Meet); others marked
// "(label inferred)" in docs/phase0-contract.md.
// =====================================================================

export interface OptionItem<T extends string = string> {
  value: T;
  label: string;
  /** Platform-impossible options stay listed but disabled (rule 2). */
  disabled?: boolean;
  /** Tooltip, e.g. NOT_IN_MEET. */
  title?: string;
}

/** Standard tooltip for features Google Meet can't support. */
export const NOT_IN_MEET = 'Not available in Google Meet';

/** AppScreen: main window tabs. */
export const APP_SCREEN_OPTIONS: OptionItem<'meeting' | 'video' | 'audio' | 'participantManagement' | 'osc'>[] = [
  { value: 'meeting', label: 'Meeting' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'participantManagement', label: 'Participants' },
  { value: 'osc', label: 'OSC' },
];

/** ApplicationSettingsTab: Settings window sidebar (openWindow('settings', <value>) selects one). */
export type SettingsTab = 'general' | 'inMeeting' | 'outputEffects' | 'videoLoss' | 'audioInputsAndTalkback' | 'ndiAndSrt' | 'osc' | 'recording' | 'logs';
export const SETTINGS_TAB_OPTIONS: OptionItem<SettingsTab>[] = [
  { value: 'general', label: 'General Settings' },
  { value: 'inMeeting', label: 'In Meeting' },
  { value: 'outputEffects', label: 'Output Effects' },
  { value: 'videoLoss', label: 'Video loss settings' },
  { value: 'ndiAndSrt', label: 'NDI' },
  { value: 'osc', label: 'OSC settings' },
  { value: 'recording', label: 'Recording Settings' },
  { value: 'logs', label: 'Logs' },
];

/** ZISOStreamInputMode → OutputMode. */
export const OUTPUT_MODE_OPTIONS: OptionItem<OutputMode>[] = [
  { value: 'participant', label: 'Participant' },
  { value: 'activeSpeaker', label: 'Speaker' },
  { value: 'screenshare', label: 'Active Screenshare' },
  { value: 'auto', label: 'Auto' },
];

/** ZISOVideoLossMode. */
export const LOSS_MODE_OPTIONS: OptionItem<LossMode>[] = [
  { value: 'black', label: 'Black' },
  { value: 'freeze', label: 'Freeze' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'image', label: 'Image' },
  { value: 'testcard', label: 'Color Bars' },
  { value: 'profilePicture', label: 'Profile Picture' },
];

export const VIDEO_LOSS_DELAY_OPTIONS: OptionItem<VideoLossDelay>[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** ZISOAudioMode → EmbeddedAudio. */
export const EMBEDDED_AUDIO_OPTIONS: OptionItem<EmbeddedAudio>[] = [
  { value: 'off', label: 'None' },
  { value: 'iso', label: 'Isolated Participant' },
  { value: 'mix', label: 'Mix of all outputs' },
];

export const AUDIO_CHANNEL_MODE_OPTIONS: OptionItem<AudioChannelMode>[] = [
  { value: 'none', label: 'None' },
  { value: 'participant', label: 'Participant' },
  { value: 'output', label: 'Output' },
  { value: 'activeSpeaker', label: 'Speaker' },
  { value: 'screenshare', label: 'Shared screen' },
  { value: 'mixAll', label: 'All participants' },
  { value: 'mixOutputs', label: 'Mix of all outputs' },
  { value: 'mixUnassigned', label: 'Mix of all unassigned participants' },
];

export const PAN_PATTERN_OPTIONS: OptionItem<PanPattern>[] = [
  { value: 'mono', label: 'Mono' },
  { value: 'stereo', label: 'Stereo' },
];

/** Per-channel pan (ZISOLibAudioChannelPan). */
export type AudioPan = 'both' | 'left' | 'right';
export const AUDIO_PAN_OPTIONS: OptionItem<AudioPan>[] = [
  { value: 'both', label: 'L+R' },
  { value: 'left', label: 'L-only' },
  { value: 'right', label: 'R-only' },
];

/** Gain reduction steps (dB as string values; parse with Number()). */
export const GAIN_REDUCTION_OPTIONS: OptionItem[] = [0, -3, -6, -9, -12, -18, -24].map((db) => ({ value: String(db), label: db === 0 ? '0 dB' : `${db} dB` }));

export const RECORDING_FORMAT_OPTIONS: OptionItem<RecordingFormat>[] = [
  { value: 'mp4', label: 'MPEG-4 (.mp4)' },
];

export const RECORDING_CODEC_OPTIONS: OptionItem<RecordingVideoCodec>[] = [
  { value: 'h264', label: 'H.264' },
  { value: 'hevc', label: 'H.265 (HEVC)' },
];

/** RecordingDateFormat; `pattern` is the file-name date pattern (date-fns style tokens). */
export const RECORDING_DATE_FORMAT_OPTIONS: (OptionItem<RecordingDateFormat> & { pattern: string })[] = [
  { value: 'standard', label: 'yyyy-MM-dd HH-mm-ss', pattern: 'yyyy-MM-dd HH-mm-ss' },
  { value: 'compact', label: 'yyyyMMdd-HHmmss', pattern: 'yyyyMMdd-HHmmss' },
  { value: 'compactNoSeconds', label: 'yyyyMMdd-HHmm', pattern: 'yyyyMMdd-HHmm' },
  { value: 'shortYear', label: 'yyMMdd-HHmmss', pattern: 'yyMMdd-HHmmss' },
  { value: 'shortYearNoSeconds', label: 'yyMMdd-HHmm', pattern: 'yyMMdd-HHmm' },
  { value: 'dateOnly', label: 'yyyy-MM-dd', pattern: 'yyyy-MM-dd' },
  { value: 'timeOnly', label: 'HH-mm-ss', pattern: 'HH-mm-ss' },
  { value: 'none', label: 'None', pattern: '' },
];

/** Format a Date with a RECORDING_DATE_FORMAT_OPTIONS pattern. */
export function formatRecordingDate(d: Date, f: RecordingDateFormat): string {
  const pat = RECORDING_DATE_FORMAT_OPTIONS.find((o) => o.value === f)?.pattern ?? '';
  const p2 = (n: number) => String(n).padStart(2, '0');
  const map: Record<string, string> = {
    yyyy: String(d.getFullYear()),
    yy: String(d.getFullYear()).slice(2),
    MM: p2(d.getMonth() + 1),
    dd: p2(d.getDate()),
    HH: p2(d.getHours()),
    mm: p2(d.getMinutes()),
    ss: p2(d.getSeconds()),
  };
  return pat.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (t) => map[t]);
}

export const OFFLINE_MATCHING_OPTIONS: OptionItem<OfflineParticipantMatching>[] = [
  { value: 'off', label: 'Off' },
  { value: 'matchByID', label: 'Match by ID' },
  { value: 'matchByIDOrName', label: 'Match by ID or name' },
];

export const OSC_BAUD_RATE_OPTIONS: OptionItem<OscBaudRate>[] = [
  { value: 'fastest', label: 'Fastest possible' },
  { value: 'ms500', label: '500 ms' },
  { value: 'ms1000', label: '1 second' },
  { value: 'ms2000', label: '2 seconds' },
  { value: 'ms5000', label: '5 seconds' },
  { value: 'ms10000', label: '10 seconds' },
  { value: 'ms25000', label: '25 seconds' },
];

export const OSC_SUBSCRIBE_MODE_OPTIONS: OptionItem<OscSubscribeMode>[] = [
  { value: 'none', label: 'None' },
  { value: 'targetList', label: 'Target List' },
  { value: 'all', label: 'All participants' },
  { value: 'gallery', label: 'Gallery' },
];

export const NAME_TAG_FONT_OPTIONS: OptionItem<NameTagFont>[] = [
  { value: 'tahoma', label: 'Tahoma' },
  { value: 'helvetica', label: 'Helvetica' },
  { value: 'arial', label: 'Arial' },
  { value: 'verdana', label: 'Verdana' },
  { value: 'georgia', label: 'Georgia' },
  { value: 'timesNewRoman', label: 'Times New Roman' },
  { value: 'courierNew', label: 'Courier New' },
];

export const NAME_TAG_NAME_MODE_OPTIONS: OptionItem<NameTagNameMode>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'manual', label: 'Manual' },
];

export const NAME_TAG_PLACEMENT_OPTIONS: OptionItem<NameTagPlacement>[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

export const NAME_TAG_ALIGNMENT_OPTIONS: OptionItem<NameTagTextAlignment>[] = NAME_TAG_PLACEMENT_OPTIONS.map((o) => ({ ...o })) as OptionItem<NameTagTextAlignment>[];

export const AUTO_CROP_RESPONSIVENESS_OPTIONS: OptionItem<AutoCropResponsiveness>[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** PAControlsTab: Output Effects tabs. */
export const EFFECTS_TAB_OPTIONS: OptionItem<'color' | 'cropping' | 'overlays'>[] = [
  { value: 'color', label: 'Color' },
  { value: 'cropping', label: 'Cropping' },
  { value: 'overlays', label: 'Overlays' },
];

/** PACropPreviewMode. */
export const CROP_PREVIEW_MODE_OPTIONS: OptionItem<'croppedOutput' | 'fullView'>[] = [
  { value: 'croppedOutput', label: 'Cropped Output' },
  { value: 'fullView', label: 'Full View' },
];

/** GuideOverlay (Output Effects preview guides). */
export const GUIDE_OVERLAY_OPTIONS: OptionItem<'thirdsGrid' | 'centerLines' | 'crosshair' | 'personSilhouette' | 'safeAreas'>[] = [
  { value: 'thirdsGrid', label: 'Thirds Grid' },
  { value: 'centerLines', label: 'Center Lines' },
  { value: 'crosshair', label: 'Crosshair' },
  { value: 'personSilhouette', label: 'Person Silhouette' },
  { value: 'safeAreas', label: 'Safe Areas' },
];

/** AspectRatioOverlay. */
export const ASPECT_OVERLAY_OPTIONS: OptionItem<'none' | 'fourThree' | 'oneOne' | 'nineSixteen'>[] = [
  { value: 'none', label: 'None' },
  { value: 'fourThree', label: '4:3' },
  { value: 'oneOne', label: '1:1' },
  { value: 'nineSixteen', label: '9:16' },
];

/** ProcAmpScopeType. */
export const SCOPE_OPTIONS: OptionItem<'histogram' | 'vectorscope' | 'waveform'>[] = [
  { value: 'histogram', label: 'Histogram' },
  { value: 'vectorscope', label: 'Vectorscope' },
  { value: 'waveform', label: 'Waveform' },
];

/** VideoOutputArrangement (Settings.outputsView uses 'multiview' for 'previews'). */
export const OUTPUT_ARRANGEMENT_OPTIONS: OptionItem<Settings['outputsView']>[] = [
  { value: 'multiview', label: 'Previews' },
  { value: 'grid', label: 'Grid' },
  { value: 'list', label: 'List' },
];

export const PARTICIPANT_FILTER_OPTIONS: OptionItem<ParticipantFilter>[] = [
  { value: 'hostOrCohost', label: 'HOST / CO-HOST' },
  { value: 'videoOn', label: 'Video On' },
  { value: 'audioOn', label: 'Audio On' },
  { value: 'handRaised', label: 'Raised Hand' },
];

/** PerformanceDetailsSection / OutputMetric / SystemMetric. */
export const PERF_SECTION_OPTIONS: OptionItem<'outputs' | 'system'>[] = [
  { value: 'outputs', label: 'Outputs' },
  { value: 'system', label: 'System' },
];
export const OUTPUT_METRIC_OPTIONS: OptionItem<'incomingResolution' | 'incomingFrameRate' | 'engineCycleTime' | 'engineLatency' | 'outgoingResolution' | 'outgoingFrameRate'>[] = [
  { value: 'incomingResolution', label: 'Incoming resolution' },
  { value: 'incomingFrameRate', label: 'Incoming frame rate' },
  { value: 'engineCycleTime', label: 'Engine cycle time' },
  { value: 'engineLatency', label: 'Engine latency' },
  { value: 'outgoingResolution', label: 'Outgoing resolution' },
  { value: 'outgoingFrameRate', label: 'Outgoing frame rate' },
];
export const SYSTEM_METRIC_OPTIONS: OptionItem<'cpu' | 'gpu' | 'ram' | 'diskWrite' | 'networkOut' | 'networkIn'>[] = [
  { value: 'cpu', label: 'CPU' },
  { value: 'gpu', label: 'GPU' },
  { value: 'ram', label: 'RAM' },
  { value: 'diskWrite', label: 'Disk Write' },
  { value: 'networkOut', label: 'Network Out' },
  { value: 'networkIn', label: 'Network In' },
];

export const LOG_LEVEL_OPTIONS: OptionItem<Settings['logLevel']>[] = [
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warning' },
  { value: 'info', label: 'Info' },
  { value: 'verbose', label: 'Verbose' },
];

// ---------------------------------------------------------------------------
// [audio-agent] Audio Outputs routing (RE ZISOAudioDevice / ZISOAudioOutputNode)
// ---------------------------------------------------------------------------
/** RE DeviceSortOrder. */
export type DeviceSortOrder = 'alphabetical' | 'reverseAlphabetical' | 'manual';
/** RE ZISOAudioOutputNode: one channel of a local output device. */
export interface AudioOutputChannelConfig {
  /** Custom channel name ('' = "Channel N"). */
  name?: string;
  mode: AudioChannelMode;
  /** participant key (mode participant) or output id (mode output). */
  selection: string;
  /** Display name of the selected participant (re-match across calls). */
  selectionName?: string;
  /** Mono = (L+R)/2, left, right. */
  pan: AudioPan;
  /** Gain reduction, dB (<= 0). */
  gainDb: number;
  delayMs: number;
  /** Shown in the table (eye button / DeviceChannelSelectionModal). */
  visible?: boolean;
}
export interface AudioOutputDeviceConfig {
  channels: AudioOutputChannelConfig[];
  collapsed?: boolean;
}
