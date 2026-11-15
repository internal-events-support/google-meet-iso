import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell, type MenuItemConstructorOptions } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_EFFECTS,
  DEFAULT_SETTINGS,
  DEFAULT_VIDEO_LOSS,
  defaultOutputs,
  migrateNameTagFont,
  NESTED_SETTINGS_KEYS,
  OSC_BAUD_MS,
  type OutputEffects,
  type OutputRef,
  findOutput,
  IPC,
  newOutput,
  type Command,
  type DeviceLists,
  type EmbeddedAudio,
  type EngineState,
  type LossMode,
  type MeetState,
  type OutputConfig,
  type OutputMode,
  type PerfSample,
  type Settings,
  type SystemStats,
  type WindowKind,
} from '../shared/types';
import { ApiServer } from './api';
import { applyNdiConfig } from './ndiconfig';
import { OscServer, type OscArg, type OscMessage } from './osc';
import { OscRouter, setActiveRouter } from './osc/router'; // [osc-agent]

// Keep the hidden Meet client rendering/decoding at full rate.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Google blocks sign-in from user agents that look like embedded browsers.
const chromeMajor = process.versions.chrome.split('.')[0];
const platformUA =
  process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64';
const CHROME_UA = `Mozilla/5.0 (${platformUA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
app.userAgentFallback = CHROME_UA;
// Own taskbar identity on Windows (otherwise grouped/iconed as generic "Electron").
if (process.platform === 'win32') app.setAppUserModelId('com.gmeet-iso.app');

const MEET_PARTITION = 'persist:meet';
const MEET_HOME = 'https://meet.google.com/';
const IS_MOCK = process.env.GMEET_ISO_MOCK === '1';
const MOCK_PAGE = path.join(__dirname, '..', '..', 'static', 'mock-meet.html');
const ICON = path.join(__dirname, '..', '..', 'static', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings: Settings = { ...DEFAULT_SETTINGS };

/** Fill in fields added in newer versions so old settings/show files keep working. */
function normalizeOutputs(list: unknown, prefix: string): OutputConfig[] {
  if (!Array.isArray(list) || !list.length) return defaultOutputs(prefix);
  return list.map((o: Partial<OutputConfig>, i) => {
    const base = newOutput(i + 1, prefix);
    const effects = { ...base.effects, ...(o.effects ?? {}) };
    effects.nameTagFont = migrateNameTagFont(effects.nameTagFont);
    const videoLoss = o.videoLoss ? { ...DEFAULT_VIDEO_LOSS, ...o.videoLoss } : null;
    return { ...base, ...o, id: o.id || base.id, effects, videoLoss };
  });
}

type Nested = Record<string, unknown>;
/** Deep-merge the nested settings groups (videoLoss, recording, osc, …) of `patch` onto `base`. */
function mergeNested(base: Settings, patch: Partial<Settings>): Settings {
  const out = { ...base, ...patch } as Settings;
  for (const k of NESTED_SETTINGS_KEYS) {
    const p = patch[k] as Nested | undefined;
    if (p && typeof p === 'object') (out as unknown as Record<string, Nested>)[k] = { ...(base[k] as unknown as Nested), ...p };
  }
  return out;
}

/** Build a full Settings from a (possibly old) settings.json, migrating legacy flat fields into the v3 groups. */
function migrateSettings(raw: Partial<Settings>): Settings {
  const s = mergeNested(DEFAULT_SETTINGS, raw);
  if (!raw.videoLoss) s.videoLoss = { ...s.videoLoss, mode: s.defaultLossMode, image: s.defaultLossImage };
  if (!raw.recording)
    s.recording = {
      ...s.recording,
      selectNewOutputsByDefault: s.recordNewOutputs,
      selectedOutputIds: (s.outputs ?? []).filter((o) => o.record).map((o) => o.id),
    };
  if (!raw.autoAssign) s.autoAssign = { ...s.autoAssign, includeNonVideoParticipants: s.autoAssignCamerasOff };
  if (!raw.embeddedAudio) s.embeddedAudio = { defaultMode: s.defaultAudio, defaultDelayMs: s.defaultDelayMs };
  if (!raw.osc) s.osc = { ...s.osc, enabled: s.oscEnabled, rxPort: s.oscListenPort, host: s.oscReplyHost, txPort: s.oscReplyPort };
  return syncLegacy(s, {});
}

/**
 * Keep legacy flat fields and the v3 groups in step, whichever side `patch` touched
 * (osc ↔ osc*, embeddedAudio ↔ defaultAudio/defaultDelayMs, videoLoss ↔ defaultLoss*, recording ↔ recordNewOutputs,
 * autoAssign ↔ autoAssignCamerasOff).
 */
function syncLegacy(s: Settings, patch: Partial<Settings>): Settings {
  const legacyOsc = patch.oscEnabled !== undefined || patch.oscListenPort !== undefined || patch.oscReplyHost !== undefined || patch.oscReplyPort !== undefined;
  if (legacyOsc && !patch.osc) s.osc = { ...s.osc, enabled: s.oscEnabled, rxPort: s.oscListenPort, host: s.oscReplyHost, txPort: s.oscReplyPort };
  else Object.assign(s, { oscEnabled: s.osc.enabled, oscListenPort: s.osc.rxPort, oscReplyHost: s.osc.host, oscReplyPort: s.osc.txPort });
  if ((patch.defaultAudio !== undefined || patch.defaultDelayMs !== undefined) && !patch.embeddedAudio)
    s.embeddedAudio = { defaultMode: s.defaultAudio, defaultDelayMs: s.defaultDelayMs };
  else Object.assign(s, { defaultAudio: s.embeddedAudio.defaultMode, defaultDelayMs: s.embeddedAudio.defaultDelayMs });
  if ((patch.defaultLossMode !== undefined || patch.defaultLossImage !== undefined) && !patch.videoLoss)
    s.videoLoss = { ...s.videoLoss, mode: s.defaultLossMode, image: s.defaultLossImage };
  else Object.assign(s, { defaultLossMode: s.videoLoss.mode, defaultLossImage: s.videoLoss.image });
  if (patch.recordNewOutputs !== undefined && !patch.recording) s.recording = { ...s.recording, selectNewOutputsByDefault: s.recordNewOutputs };
  else s.recordNewOutputs = s.recording.selectNewOutputsByDefault;
  if (patch.autoAssignCamerasOff !== undefined && !patch.autoAssign) s.autoAssign = { ...s.autoAssign, includeNonVideoParticipants: s.autoAssignCamerasOff };
  else s.autoAssignCamerasOff = s.autoAssign.includeNonVideoParticipants;
  return s;
}

function loadSettings(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<Settings>;
    settings = migrateSettings(raw);
  } catch {
    settings = migrateSettings({});
  }
  settings.outputs = normalizeOutputs(settings.outputs, settings.ndiPrefix || 'GMEET');
}
/** Set by "Clear Cache" so a pending save can't rewrite settings.json before quitting. */
let doNotSave = false;
let saveTimer: NodeJS.Timeout | null = null;
function saveSettings(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (doNotSave) return;
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  }, 200);
}

// ---------- NDI discovery (main process) ----------
interface NdiFinder {
  sources(): string[];
}
let finder: NdiFinder | null = null;
function initFinder(): void {
  const p = path.join(__dirname, '..', '..', 'build', 'Release', 'gmeet_iso_ndi.node');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(p) as { load(): { ok: boolean; error?: string }; Finder: new () => NdiFinder };
    if (mod.load().ok) finder = new mod.Finder();
  } catch (e) {
    log(`NDI finder unavailable: ${(e as Error).message}`);
  }
}

// ---------- windows ----------
let controlWin: BrowserWindow | null = null;
let meetWin: BrowserWindow | null = null;
let signInWin: BrowserWindow | null = null;
const displayWins = new Map<string, { win: BrowserWindow; key: string }>();
let lastDevices: DeviceLists = { videoInputs: [], audioInputs: [], audioOutputs: [] };
let lastState: MeetState | null = null;
let quitting = false;

/** Secondary UI windows (settings, effects, perf) — all share the control preload. */
const uiWindows = new Map<WindowKind, BrowserWindow>();

/** Send to every UI window (main control window + secondary windows). */
function broadcast(channel: string, ...args: unknown[]): void {
  controlWin?.webContents.send(channel, ...args);
  for (const w of uiWindows.values()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

const logRing: string[] = [];
function log(line: string): void {
  const stamped = `${new Date().toLocaleTimeString()}  ${line}`;
  console.log(stamped);
  logRing.push(stamped);
  if (logRing.length > 2000) logRing.shift();
  broadcast(IPC.log, stamped);
}

const WINDOW_SPECS: Record<WindowKind, { title: string; width: number; height: number; minWidth: number; minHeight: number; page: string }> = {
  settings: { title: 'Settings', width: 1000, height: 720, minWidth: 820, minHeight: 520, page: 'settings.html' },
  effects: { title: 'Output Effects', width: 1440, height: 860, minWidth: 1100, minHeight: 640, page: 'effects.html' },
  perf: { title: 'Performance Details', width: 1340, height: 900, minWidth: 980, minHeight: 600, page: 'perf.html' },
};

function openUiWindow(kind: WindowKind, arg = ''): void {
  const existing = uiWindows.get(kind);
  const spec = WINDOW_SPECS[kind];
  const file = path.join(__dirname, '..', '..', 'static', spec.page);
  if (existing && !existing.isDestroyed()) {
    if (arg && (kind === 'effects' || kind === 'settings')) void existing.loadFile(file, { query: { arg } });
    existing.show();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: spec.width,
    height: spec.height,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    title: spec.title,
    icon: ICON,
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#262626', symbolColor: '#e8e8e8', height: 38 },
    webPreferences: { preload: path.join(__dirname, '..', 'control', 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  void win.loadFile(file, { query: arg ? { arg } : {} });
  win.on('closed', () => uiWindows.delete(kind));
  uiWindows.set(kind, win);
}

// ---------- performance history (1 Hz, 30 min) ----------
const perfSamples: PerfSample[] = [];
let perfCapturing = true;
let perfSince = Date.now();
function samplePerf(): void {
  if (!perfCapturing) return;
  const sys = systemStats();
  perfSamples.push({
    t: Date.now(),
    cpu: sys.cpu,
    memMB: sys.memMB,
    rxMbps: sys.rxMbps,
    outputs: (lastState?.outputs ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      inW: o.inWidth,
      inH: o.inHeight,
      inFps: o.inFps,
      outW: o.outWidth,
      outH: o.outHeight,
      outFps: o.outFps,
      latencyMs: o.latencyMs,
      cycleMs: o.cycleMs ?? 0,
    })),
  });
  if (perfSamples.length > 1800) perfSamples.splice(0, perfSamples.length - 1800);
}

function createControlWindow(): void {
  controlWin = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    title: 'GMeet ISO',
    icon: ICON,
    backgroundColor: '#1e1e1e',
    // ZoomISO-style unified toolbar: our top bar is the title bar; Windows caption buttons overlay it.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#262626', symbolColor: '#e8e8e8', height: 48 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'control', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // Keep the application menu attached (accelerators: Ctrl+, / Ctrl+S / Ctrl+O …) but don't draw a menu bar;
  // the UI can show it with gmeetIso.popupAppMenu().
  controlWin.setMenuBarVisibility(false);
  void controlWin.loadFile(path.join(__dirname, '..', '..', 'static', 'control.html'));
  controlWin.on('closed', () => {
    controlWin = null;
    for (const w of uiWindows.values()) if (!w.isDestroyed()) w.close();
    app.quit();
  });
}

function setupMeetSession(): void {
  const ses = session.fromPartition(MEET_PARTITION);
  ses.setUserAgent(CHROME_UA);
  const trusted = (url: string) => url.startsWith('https://meet.google.com/') || (IS_MOCK && url.startsWith('file://'));
  // Camera/mic are granted only to Meet; the media shim decides what Meet actually gets.
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    if (permission === 'media') return cb(trusted(wc.getURL()));
    cb(permission === 'fullscreen' || permission === 'clipboard-sanitized-write' || permission === 'speaker-selection');
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (permission === 'media') return trusted(origin) || origin.startsWith('https://meet.google.com');
    return permission !== 'notifications';
  });
}

/** The Meet client is rendered offscreen: it never appears on screen or in the taskbar. */
function ensureMeetWindow(): BrowserWindow {
  if (meetWin && !meetWin.isDestroyed()) return meetWin;
  meetWin = new BrowserWindow({
    show: false,
    width: settings.meetWindowWidth,
    height: settings.meetWindowHeight,
    useContentSize: true,
    skipTaskbar: true,
    webPreferences: {
      partition: MEET_PARTITION,
      preload: path.join(__dirname, '..', 'meet', 'preload.js'),
      contextIsolation: true,
      sandbox: false, // preload needs Node to load the native NDI addon
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  const wc = meetWin.webContents;
  wc.setFrameRate(30);
  wc.setAudioMuted(settings.muteLocalAudio);
  // Meet asks "Leave site?" on navigation; never let that block us.
  wc.on('will-prevent-unload', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-navigate', (_e, url) => {
    log(`Meet → ${url}`);
    if (/^https:\/\/(workspace\.google\.com|accounts\.google\.com)/.test(url)) log('Google sign-in required');
  });
  wc.on('render-process-gone', (_e, d) => {
    log(`Meet renderer gone: ${d.reason} — reloading`);
    if (!quitting) setTimeout(() => void meetWin?.loadURL(MEET_HOME), 1000);
  });
  return meetWin;
}

function openSignIn(): void {
  if (signInWin && !signInWin.isDestroyed()) {
    signInWin.focus();
    return;
  }
  signInWin = new BrowserWindow({
    width: 520,
    height: 720,
    parent: controlWin ?? undefined,
    modal: false,
    title: 'Sign in to Google',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { partition: MEET_PARTITION, contextIsolation: true, sandbox: true },
  });
  signInWin.removeMenu();
  const done = (url: string) => {
    if (url.startsWith('https://meet.google.com/')) {
      log('Signed in');
      signInWin?.close();
      void ensureMeetWindow().loadURL(MEET_HOME);
    }
  };
  signInWin.webContents.on('did-navigate', (_e, url) => done(url));
  signInWin.on('closed', () => (signInWin = null));
  void signInWin.loadURL(`https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(MEET_HOME)}`);
}

function normalizeMeetUrl(input: string): string | null {
  const s = input.trim();
  const code = s.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  if (/^https?:\/\/meet\.google\.com\//i.test(s)) return s;
  if (code) return `https://meet.google.com/${code[1].toLowerCase()}`;
  return null;
}

async function joinMeeting(input: string): Promise<void> {
  const url = normalizeMeetUrl(input);
  if (!url) throw new Error('Enter a Meet link or code like abc-defg-hij');
  settings.lastMeetUrl = url;
  saveSettings();
  log(`Joining ${url}`);
  await ensureMeetWindow().loadURL(url);
}

async function leaveMeeting(): Promise<void> {
  if (!meetWin || meetWin.isDestroyed()) return;
  meetWin.webContents.send(IPC.meetLeave);
  await new Promise((r) => setTimeout(r, 1500));
  await meetWin.loadURL(IS_MOCK ? `file://${MOCK_PAGE}` : MEET_HOME);
}

async function dumpMeetDom(): Promise<string> {
  if (!meetWin || meetWin.isDestroyed()) return 'Meet window not open';
  const result = await new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve('timed out (is the Meet page loaded?)'), 3000);
    ipcMain.once(IPC.meetDumpResult, (_e, out: string) => {
      clearTimeout(t);
      resolve(out);
    });
    meetWin!.webContents.send(IPC.meetDumpRequest);
  });
  const file = path.join(app.getPath('userData'), `meet-dom-${Date.now()}.txt`);
  fs.writeFileSync(file, result);
  log(`DOM dump saved: ${file}`);
  return result;
}

// ---------- settings propagation ----------
function pushSettings(): void {
  saveSettings();
  if (meetWin && !meetWin.isDestroyed()) {
    meetWin.webContents.setAudioMuted(settings.muteLocalAudio);
    meetWin.webContents.send(IPC.meetSettings, settings);
  }
  broadcast(IPC.meetSettings, settings);
  syncDisplays();
}

function applySettingsPatch(patch: Partial<Settings>): Settings {
  const prev = settings;
  settings = syncLegacy(mergeNested(settings, patch), patch);
  if (patch.outputs) settings.outputs = normalizeOutputs(patch.outputs, settings.ndiPrefix || 'GMEET');
  if ((patch.meetWindowWidth || patch.meetWindowHeight) && meetWin && !meetWin.isDestroyed())
    meetWin.setContentSize(settings.meetWindowWidth, settings.meetWindowHeight);
  if (patch.osc || patch.oscEnabled !== undefined || patch.oscListenPort !== undefined) {
    const a = prev.osc;
    const b = settings.osc;
    if (a.enabled !== b.enabled || a.rxPort !== b.rxPort || a.interface !== b.interface) restartOsc();
    if (osc) osc.minGapMs = OSC_BAUD_MS[b.baudRate] ?? 0;
  }
  if (patch.apiEnabled !== undefined || patch.apiPort !== undefined) restartApi();
  if (
    (patch.ndiDiscoveryServer !== undefined && patch.ndiDiscoveryServer !== prev.ndiDiscoveryServer) ||
    (patch.ndiNicIps !== undefined && patch.ndiNicIps !== prev.ndiNicIps)
  ) {
    applyNdiConfig(app.getPath('userData'), settings.ndiDiscoveryServer, settings.ndiNicIps);
    log('NDI network settings saved — restart GMeet ISO to apply');
  }
  pushSettings();
  return settings;
}

// ---------- commands (UI, OSC, HTTP/WS, CLI all land here) ----------
let meetCmdSeq = 0;
const meetCmdWaiters = new Map<number, (r: unknown) => void>();

function forwardToMeet(c: Command): Promise<unknown> {
  if (!meetWin || meetWin.isDestroyed()) return Promise.resolve(null);
  const id = ++meetCmdSeq;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      meetCmdWaiters.delete(id);
      resolve({ error: 'timeout' });
    }, 8000);
    meetCmdWaiters.set(id, (r) => {
      clearTimeout(t);
      resolve(r);
    });
    meetWin!.webContents.send(IPC.meetCommand, id, c);
  });
}

function outputOrThrow(ref: number | string): OutputConfig {
  const o = findOutput(settings.outputs, ref);
  if (!o) throw new Error(`no output "${ref}"`);
  return o;
}

function updateOutputs(fn: (list: OutputConfig[]) => OutputConfig[]): void {
  applySettingsPatch({ outputs: fn(settings.outputs.map((o) => ({ ...o }))) });
}

/** Resolve a participant reference (key, exact name, or 1-based roster index). */
function participantRef(ref: string | null): { key: string; name: string } | null {
  if (ref === null || ref === '') return null;
  const roster = lastState?.participants ?? [];
  const byKey = roster.find((p) => p.key === ref);
  const byName = roster.find((p) => p.displayName.toLowerCase() === ref.toLowerCase());
  const byIdx = /^\d+$/.test(ref) ? roster.filter((p) => !p.isSelf)[Number(ref) - 1] : undefined;
  const p = byKey ?? byName ?? byIdx;
  return p ? { key: p.key, name: p.displayName } : { key: ref, name: ref };
}

function routeOutput(ref: OutputRef, participant: string | null): { key: string; name: string } | null {
  const o = outputOrThrow(ref);
  const sel = participantRef(participant);
  const isScreen = sel?.key.endsWith(':screen');
  updateOutputs((list) =>
    list.map((x) =>
      x.id === o.id ? { ...x, selection: sel, mode: sel ? (isScreen ? 'screenshare' : 'participant') : x.mode === 'participant' ? 'auto' : x.mode } : x,
    ),
  );
  return sel;
}

/** Effect keys per Output Effects tab, for resetEffects. */
const EFFECT_SECTIONS: Record<'color' | 'crop' | 'overlays' | 'all', (keyof OutputEffects)[]> = (() => {
  const color: (keyof OutputEffects)[] = [
    'brightness', 'contrast', 'saturation', 'hue', 'exposure', 'vibrance', 'sharpness', 'temperature', 'whiteBalanceK', 'tint',
    'highlights', 'shadows', 'vignette', 'toneCurve', 'liftR', 'liftG', 'liftB', 'gammaR', 'gammaG', 'gammaB', 'gainR', 'gainG', 'gainB',
  ];
  const crop: (keyof OutputEffects)[] = ['zoom', 'panX', 'panY', 'mirror', 'cropLeft', 'cropRight', 'cropTop', 'cropBottom', 'padBlack', 'cropZoom', 'cropPanX', 'cropPanY', 'cropRotation'];
  const overlays: (keyof OutputEffects)[] = [
    'nameTag', 'nameTagText', 'nameTagSubtitle', 'nameTagPosition', 'nameTagSize', 'nameTagFont', 'nameTagColor', 'nameTagBg', 'nameTagBgOpacity',
    'nameTagAccent', 'images', 'nameTagNameMode', 'nameTagPlacement', 'nameTagTextAlignment', 'nameTagCornerRadius', 'nameTagOffset', 'overlayLayerOrder',
  ];
  return { color, crop, overlays, all: Object.keys(DEFAULT_EFFECTS) as (keyof OutputEffects)[] };
})();

async function executeCommand(c: Command): Promise<unknown> {
  switch (c.cmd) {
    case 'engine':
      applySettingsPatch({ engine: c.state });
      log(`ISO engine: ${c.state}`);
      return c.state;
    case 'setOutputCount': {
      const n = Math.max(0, Math.min(64, Math.round(c.count)));
      updateOutputs((list) => {
        const prefix = settings.ndiPrefix || 'GMEET';
        while (list.length < n) list.push(newOutput(list.length + 1, prefix));
        return list.slice(0, n);
      });
      return n;
    }
    case 'addOutput': {
      const o = newOutput(settings.outputs.length + 1, settings.ndiPrefix || 'GMEET', c.patch);
      updateOutputs((list) => [...list, o]);
      if (settings.recording.selectNewOutputsByDefault)
        applySettingsPatch({ recording: { ...settings.recording, selectedOutputIds: [...settings.recording.selectedOutputIds, o.id] } });
      return o.id;
    }
    case 'deleteOutput': {
      const o = outputOrThrow(c.output);
      updateOutputs((list) => list.filter((x) => x.id !== o.id));
      return o.id;
    }
    case 'updateOutput': {
      const o = outputOrThrow(c.output);
      const patch = { ...c.patch };
      if (patch.name !== undefined && settings.outputs.some((x) => x.id !== o.id && x.name === patch.name)) throw new Error(`output name "${patch.name}" already used`);
      updateOutputs((list) =>
        list.map((x) => (x.id === o.id ? { ...x, ...patch, effects: { ...x.effects, ...(patch.effects ?? {}) } } : x)),
      );
      return o.id;
    }
    case 'route':
    case 'assignParticipant':
      return routeOutput(c.output, c.participant);
    case 'unassignParticipant': {
      const sel = participantRef(c.participant);
      const hit = (x: OutputConfig) => !!x.selection && !!sel && (x.selection.key === sel.key || x.selection.name.toLowerCase() === sel.name.toLowerCase());
      const ids = settings.outputs.filter(hit).map((x) => x.id);
      updateOutputs((list) => list.map((x) => (hit(x) ? { ...x, selection: null, mode: x.mode === 'participant' ? 'auto' : x.mode } : x)));
      return ids;
    }
    case 'setAutoAssign': {
      const o = outputOrThrow(c.output);
      updateOutputs((list) => list.map((x) => (x.id === o.id ? { ...x, isAutoAssign: c.on } : x)));
      return c.on;
    }
    case 'setVideoLoss': {
      if (c.output === undefined) {
        const videoLoss = { ...settings.videoLoss, ...(c.patch ?? {}) };
        applySettingsPatch({ videoLoss });
        // The engine still reads OutputConfig.lossMode/lossImage: mirror the global mode onto outputs without an active override.
        updateOutputs((list) =>
          list.map((x) => (videoLoss.perOutputVideoLossEnabled && x.videoLoss ? x : { ...x, lossMode: videoLoss.mode, lossImage: videoLoss.image })),
        );
        // TODO(engine): honour delay, displayOutputNameOnImage and profilePicture* in src/meet/outputs.ts.
        return videoLoss;
      }
      const o = outputOrThrow(c.output);
      const vl = c.patch === null ? null : { ...DEFAULT_VIDEO_LOSS, ...(o.videoLoss ?? settings.videoLoss), ...c.patch };
      const eff = vl ?? settings.videoLoss;
      updateOutputs((list) => list.map((x) => (x.id === o.id ? { ...x, videoLoss: vl, lossMode: eff.mode, lossImage: eff.image } : x)));
      return vl;
    }
    case 'startRecording':
    case 'stopRecording': {
      const on = c.cmd === 'startRecording';
      const refs = c.outputs ?? (on ? settings.recording.selectedOutputIds : undefined);
      const ids = refs ? new Set(refs.map((r) => findOutput(settings.outputs, r)?.id).filter(Boolean) as string[]) : null;
      if (on && ids) applySettingsPatch({ recording: { ...settings.recording, selectedOutputIds: [...ids] } });
      // TODO(recording): format/codec/bitrate/file naming/low-disk are read by src/meet/recorder.ts (later agent).
      updateOutputs((list) => list.map((x) => (ids && !ids.has(x.id) ? (on ? { ...x, record: false } : x) : { ...x, record: on && x.enabled })));
      return ids ? [...ids] : 'all';
    }
    case 'resetEffects': {
      const o = outputOrThrow(c.output);
      const keys = EFFECT_SECTIONS[c.section ?? 'all'];
      const reset: Partial<OutputEffects> = {};
      for (const k of keys) (reset as Record<string, unknown>)[k] = structuredClone(DEFAULT_EFFECTS[k]);
      updateOutputs((list) => list.map((x) => (x.id === o.id ? { ...x, effects: { ...x.effects, ...reset } } : x)));
      return keys.length;
    }
    case 'copyEffects': {
      const from = outputOrThrow(c.from);
      const to = new Set(c.to.map((r) => outputOrThrow(r).id));
      to.delete(from.id);
      updateOutputs((list) => list.map((x) => (to.has(x.id) ? { ...x, effects: structuredClone(from.effects) } : x)));
      return [...to];
    }
    case 'setOscCommandEnabled': {
      const addr = c.address.toLowerCase();
      const set = new Set(settings.osc.disabledCommands.map((a) => a.toLowerCase()));
      if (c.enabled) set.delete(addr);
      else set.add(addr);
      applySettingsPatch({ osc: { ...settings.osc, disabledCommands: [...set] } });
      return c.enabled;
    }
    case 'signOut':
      await signOut();
      return true;
    case 'clearCache':
      return clearCache(c.confirm !== false);
    // [osc-agent]
    case 'raiseHand':
      return forwardToMeet(c);
    // [osc-agent]
    case 'setOscSubscribe':
      applySettingsPatch({ osc: { ...settings.osc, subscribeMode: c.mode } });
      return c.mode;
    case 'spotlight':
    case 'pin':
    case 'lowerHand':
    case 'muteAll':
    case 'removeParticipant':
      // TODO(meet): implement in src/meet/preload.ts runCommand (Meet DOM automation). Unknown commands return an error there today.
      return forwardToMeet(c);
    case 'recordAll':
      updateOutputs((list) => list.map((x) => ({ ...x, record: c.on && x.enabled })));
      return c.on;
    case 'join':
      await joinMeeting(c.url);
      return true;
    case 'leave':
      await leaveMeeting();
      return true;
    case 'saveShow':
      return saveShow(c.path);
    case 'loadShow':
      return loadShow(c.path, c.merge);
    case 'chat':
    case 'admit':
    case 'deny':
    case 'muteParticipant':
    case 'applyLayout':
    case 'setCam':
    case 'setMic':
      return forwardToMeet(c);
    default:
      throw new Error(`unknown command ${(c as { cmd: string }).cmd}`);
  }
}

// ---------- show files ----------
const SHOW_KEYS: (keyof Settings)[] = [
  'outputs',
  'ndiPrefix',
  'ndiGroups',
  'camera',
  'micLabel',
  'screenShare',
  'includeSelf',
  'graceSeconds',
  'autoLayout',
  'maxTiles',
  'autoAdmit',
  'joinNotice',
  'monitorDevice',
  'lastMeetUrl',
  'recordDir',
  'videoLoss',
  'recording',
  'autoAssign',
  'interface',
  'advancedAudio',
  'embeddedAudio',
  'osc',
  'audioOutputDevices', // [audio-agent]
  'audioOutputConfig', // [audio-agent]
];

async function saveShow(file?: string): Promise<string | null> {
  if (!file) {
    const r = await dialog.showSaveDialog(controlWin!, { title: 'Save show', defaultPath: 'show.gmiso', filters: [{ name: 'GMeet ISO show', extensions: ['gmiso'] }] });
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
  }
  const show: Record<string, unknown> = { app: 'gmeet-iso', version: 1, savedAt: new Date().toISOString() };
  for (const k of SHOW_KEYS) show[k] = settings[k];
  fs.writeFileSync(file, JSON.stringify(show, null, 2));
  log(`Show saved: ${file}`);
  return file;
}

async function loadShow(file?: string, merge = false): Promise<string | null> {
  if (!file) {
    const r = await dialog.showOpenDialog(controlWin!, { title: 'Open show', properties: ['openFile'], filters: [{ name: 'GMeet ISO show', extensions: ['gmiso', 'json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    file = r.filePaths[0];
  }
  const show = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
  const patch: Partial<Settings> = {};
  // Older show files lack the v3 groups; mergeNested() in applySettingsPatch keeps defaults for missing fields.
  for (const k of SHOW_KEYS) if (show[k] !== undefined) (patch as Record<string, unknown>)[k] = show[k];
  if (merge && Array.isArray(show.outputs)) {
    const fresh = normalizeOutputs(show.outputs, settings.ndiPrefix).map((o) => ({ ...o, id: newOutput(0).id }));
    patch.outputs = [...settings.outputs, ...fresh];
  }
  applySettingsPatch(patch);
  log(`Show ${merge ? 'merged' : 'loaded'}: ${file}`);
  return file;
}

// ---------- OSC ----------
const MODE_NAMES: Record<string, OutputMode> = {
  participant: 'participant',
  activespeaker: 'activeSpeaker',
  speaker: 'activeSpeaker',
  screenshare: 'screenshare',
  screen: 'screenshare',
  auto: 'auto',
};
const LOSS_NAMES: Record<string, LossMode> = {
  black: 'black',
  freeze: 'freeze',
  transparent: 'transparent',
  image: 'image',
  testcard: 'testcard',
  bars: 'testcard',
  colorbars: 'testcard',
  profilepicture: 'profilePicture',
  profile: 'profilePicture',
};
const norm = (v: OscArg) => String(v ?? '').toLowerCase().replace(/[\s_-]+/g, '');

let osc: OscServer | null = null;
let oscSender: { host: string; port: number } | null = null;
// [osc-agent] ZoomOSC/ZoomISO-compatible router (src/main/osc/router.ts); legacy onOsc below handles the rest.
const oscRouter = new OscRouter({
  settings: () => settings,
  state: () => lastState,
  exec: (c) => executeCommand(c),
  send: (a, args, key) => osc?.send(a, args, key),
  log: (s) => log(s),
  version: app.getVersion(),
});
setActiveRouter(oscRouter);

function oscReplies(cmd: string, reply: (a: string, args: OscArg[]) => void): boolean {
  const st = lastState;
  switch (cmd) {
    case 'getengine':
    case 'getenginestate':
      reply('/gmeetosc/engineState', [settings.engine === 'enabled' ? 2 : settings.engine === 'standby' ? 1 : 0, settings.engine]);
      return true;
    case 'getoutputrouting':
    case 'getoutputs':
      settings.outputs.forEach((o, i) => {
        const live = st?.outputs.find((x) => x.id === o.id);
        reply('/gmeetosc/outputRouting', [settings.outputs.length, i + 1, o.enabled ? 1 : 0, o.name, o.mode, live?.sourceName ?? '', o.format ? `${o.format.width}x${o.format.height}` : 'native', o.audio]);
      });
      return true;
    case 'getparticipants':
    case 'listusers': {
      const roster = st?.participants ?? [];
      reply('/gmeetosc/participantCount', [roster.length]);
      roster.forEach((p, i) => reply('/gmeetosc/participant', [i + 1, p.displayName, p.hasVideo ? 1 : 0, p.muted ? 1 : 0, p.kind, p.key]));
      return true;
    }
    case 'getaudiolevels':
      (st?.participants ?? []).forEach((p, i) => reply('/gmeetosc/audioLevels', [i + 1, p.displayName, Math.round(Math.min(1, p.level) * 255)]));
      return true;
    case 'getactivespeaker': {
      const p = st?.participants.find((x) => x.key === st.activeSpeaker);
      reply('/gmeetosc/activeSpeaker', [p?.displayName ?? '']);
      return true;
    }
    case 'ping':
      reply('/gmeetosc/pong', ['gmeet-iso']);
      return true;
  }
  return false;
}

/**
 * Address forms (prefix /gmeet or ZoomOSC-style /zoom, case-insensitive):
 *   /gmeet/startISOEngine | standbyISOEngine | stopISOEngine
 *   /gmeet/setOutputCount <n> · addOutput · deleteOutput <out>
 *   /gmeet/enableOutput <out> · disableOutput <out>
 *   /gmeet/setOutputMode <out> <participant|activeSpeaker|screenshare|auto>
 *   /gmeet/setOutputName <out> <name> · setOutputLossMode <out> <mode> · setVideoLossMode <mode>
 *   /gmeet/setOutputAudio <out> <off|iso|mix> · setOutputSelection <out> <name|index|key>
 *   /gmeet/userName/outputISO <name> <out> · /gmeet/galIndex/outputISO <index> <out>
 *   /gmeet/joinMeeting <url> · leaveMeeting · chat <text> · admitAll · admit <name>
 *   /gmeet/userName/mute <name> · applyLayout · startRecording [out] · stopRecording [out]
 *   /gmeet/saveShow <path> · loadShow <path>
 *   /gmeet/get{EngineState,OutputRouting,Participants,AudioLevels,ActiveSpeaker} · ping
 */
async function onOsc(m: OscMessage, rawReply: (a: string, args: OscArg[]) => void, from: { address: string }): Promise<void> {
  // [osc-agent]
  if (/^\/(gmeet|gmeetiso|zoom|zoomosc)(\/|$)/i.test(m.address)) oscSender = { host: from.address, port: settings.oscReplyPort };
  if (await oscRouter.handle(m, rawReply, from)) return;
  const parts = m.address.split('/').filter(Boolean);
  if (!parts.length || !/^(gmeet|zoom|gmeetiso)$/i.test(parts[0])) return;
  const o = settings.osc;
  if (o.enableAllowList && o.allowList.length && !o.allowList.includes(from.address.replace(/^::ffff:/, ''))) {
    log(`OSC: ignored ${m.address} from ${from.address} (not on allow list)`);
    return;
  }
  const lower = m.address.toLowerCase();
  const tail = '/' + parts.slice(1).join('/').toLowerCase();
  if (o.disabledCommands.some((d) => d.toLowerCase() === lower || d.toLowerCase().replace(/^\/(gmeet|zoom)/, '') === tail)) {
    log(`OSC: ${m.address} is disabled in the Command Browser`);
    return;
  }
  // "OSC address header": rewrite our /gmeetosc reply prefix.
  const prefix = (o.prepend || '/gmeetosc').replace(/\/+$/, '');
  const reply = (a: string, args: OscArg[]) => rawReply(a.replace(/^\/gmeetosc/, prefix), args);
  oscSender = { host: from.address, port: settings.oscReplyPort };
  const path2 = parts.slice(1).map((p) => p.toLowerCase());
  const cmd = path2.join('/');
  const a = m.args;
  const out = (i: number) => (typeof a[i] === 'number' ? (a[i] as number) : String(a[i] ?? ''));
  try {
    if (oscReplies(cmd, reply)) return;
    let c: Command | null = null;
    switch (cmd) {
      case 'startisoengine':
      case 'enableisoengine':
        c = { cmd: 'engine', state: 'enabled' };
        break;
      case 'standbyisoengine':
        c = { cmd: 'engine', state: 'standby' };
        break;
      case 'stopisoengine':
      case 'disableisoengine':
        c = { cmd: 'engine', state: 'disabled' };
        break;
      case 'setoutputcount':
        c = { cmd: 'setOutputCount', count: Number(a[0]) };
        break;
      case 'addoutput':
        c = { cmd: 'addOutput', patch: a[0] ? { name: String(a[0]) } : undefined };
        break;
      case 'deleteoutput':
        c = { cmd: 'deleteOutput', output: out(0) };
        break;
      case 'enableoutput':
        c = { cmd: 'updateOutput', output: out(0), patch: { enabled: true } };
        break;
      case 'disableoutput':
        c = { cmd: 'updateOutput', output: out(0), patch: { enabled: false } };
        break;
      case 'setoutputmode': {
        const mode = MODE_NAMES[norm(a[1])];
        if (!mode) throw new Error(`bad mode ${a[1]}`);
        c = { cmd: 'updateOutput', output: out(0), patch: { mode } };
        break;
      }
      case 'setoutputname':
        c = { cmd: 'updateOutput', output: out(0), patch: { name: String(a[1]) } };
        break;
      case 'setoutputlossmode': {
        const lossMode = LOSS_NAMES[norm(a[1])];
        if (!lossMode) throw new Error(`bad loss mode ${a[1]}`);
        c = { cmd: 'updateOutput', output: out(0), patch: { lossMode } };
        break;
      }
      case 'setvideolossmode': {
        const lossMode = LOSS_NAMES[norm(a[0])];
        if (!lossMode) throw new Error(`bad loss mode ${a[0]}`);
        c = { cmd: 'setVideoLoss', patch: { mode: lossMode } };
        break;
      }
      case 'setoutputaudio': {
        const audio = norm(a[1]) as EmbeddedAudio;
        if (!['off', 'iso', 'mix'].includes(audio)) throw new Error(`bad audio ${a[1]}`);
        c = { cmd: 'updateOutput', output: out(0), patch: { audio } };
        break;
      }
      case 'setoutputselection':
        c = { cmd: 'route', output: out(0), participant: a[1] === undefined || a[1] === '' ? null : String(a[1]) };
        break;
      case 'username/outputiso':
      case 'targetid/outputiso':
        c = { cmd: 'route', output: out(1), participant: String(a[0]) };
        break;
      case 'galindex/outputiso':
        c = { cmd: 'route', output: out(1), participant: String(Number(a[0]) + (Number(a[0]) === 0 ? 1 : 0)) };
        break;
      case 'joinmeeting':
      case 'join':
        c = { cmd: 'join', url: String(a[0] ?? settings.lastMeetUrl) };
        break;
      case 'leavemeeting':
      case 'leave':
        c = { cmd: 'leave' };
        break;
      case 'chat':
      case 'chatall':
        c = { cmd: 'chat', text: String(a[0] ?? '') };
        break;
      case 'admitall':
        c = { cmd: 'admit', who: 'all' };
        break;
      case 'admit':
        c = { cmd: 'admit', who: a[0] ? String(a[0]) : 'all' };
        break;
      case 'username/mute':
        c = { cmd: 'muteParticipant', participant: String(a[0]) };
        break;
      case 'applylayout':
        c = { cmd: 'applyLayout' };
        break;
      case 'startrecording':
      case 'stoprecording': {
        const on = cmd === 'startrecording';
        const outs = a.length ? a.map((_, i) => out(i)) : undefined;
        c = on ? { cmd: 'startRecording', outputs: outs } : { cmd: 'stopRecording', outputs: outs };
        break;
      }
      case 'saveshow':
        c = { cmd: 'saveShow', path: String(a[0]) };
        break;
      case 'loadshow':
        c = { cmd: 'loadShow', path: String(a[0]), merge: !!a[1] };
        break;
    }
    if (!c) {
      log(`OSC: unknown ${m.address}`);
      return;
    }
    await executeCommand(c);
    reply('/gmeetosc/ok', [m.address]);
  } catch (e) {
    log(`OSC ${m.address} failed: ${(e as Error).message}`);
    reply('/gmeetosc/error', [m.address, (e as Error).message]);
  }
}

function restartOsc(): void {
  osc?.stop();
  osc = null;
  if (!settings.oscEnabled) return;
  osc = new OscServer(
    (m, reply, from) => void onOsc(m, reply, from),
    () => ({ host: settings.oscReplyHost || oscSender?.host || '', port: settings.oscReplyPort }),
    log,
  );
  osc.minGapMs = OSC_BAUD_MS[settings.osc.baudRate] ?? 0;
  osc.start(settings.osc.rxPort, settings.osc.interface);
}

// ---------- account / cache ----------
function msgBox(opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return controlWin && !controlWin.isDestroyed() ? dialog.showMessageBox(controlWin, opts) : dialog.showMessageBox(opts);
}

async function signOut(): Promise<void> {
  const phase = lastState?.phase ?? '';
  if (phase === 'in-call' || phase === 'waiting') await leaveMeeting();
  const ses = session.fromPartition(MEET_PARTITION);
  await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
  settings = { ...settings, botName: '' };
  saveSettings();
  log('Signed out');
  if (meetWin && !meetWin.isDestroyed() && !IS_MOCK) void meetWin.loadURL(MEET_HOME);
}

/** Menu "Clear Cache (app will close)": RE clearSettings — wipe settings.json + the Meet HTTP cache, then quit. Sign-in is kept. */
async function clearCache(ask: boolean): Promise<boolean> {
  if (ask) {
    const r = await msgBox({
      type: 'warning',
      buttons: ['Cancel', 'Clear Cache'],
      defaultId: 0,
      cancelId: 0,
      title: 'Clear Cache',
      message: 'Clear Cache (app will close)',
      detail: 'All GMeet ISO settings and outputs are reset to defaults and the app quits. Export your configuration first if you want to keep it.',
    });
    if (r.response !== 1) return false;
  }
  doNotSave = true;
  if (saveTimer) clearTimeout(saveTimer);
  try {
    fs.rmSync(settingsPath(), { force: true });
    await session.fromPartition(MEET_PARTITION).clearCache();
  } catch (e) {
    log(`clear cache: ${(e as Error).message}`);
  }
  log('Cache cleared — quitting');
  app.quit();
  return true;
}

// ---------- application menu (RE 07-Menu-Bar, adapted to Windows) ----------
function buildAppMenu(): Menu {
  const tpl: MenuItemConstructorOptions[] = [
    {
      label: 'GMeet ISO',
      submenu: [
        {
          label: 'About GMeet ISO',
          click: () =>
            void msgBox({
              type: 'info',
              title: 'About GMeet ISO',
              message: `GMeet ISO ${app.getVersion()}`,
              detail: `Isolated NDI outputs from Google Meet.\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
              icon: ICON,
            }),
        },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openUiWindow('settings') },
        { type: 'separator' },
        { label: 'Sign in with embedded browser', click: () => openSignIn() },
        { label: 'Sign Out', click: () => void signOut().catch((e) => log(`sign out failed: ${(e as Error).message}`)) },
        { type: 'separator' },
        { label: 'Quit GMeet ISO', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Export Configuration', accelerator: 'CmdOrCtrl+S', click: () => void saveShow().catch((e) => log(`export failed: ${(e as Error).message}`)) },
        { label: 'Load Configuration', accelerator: 'CmdOrCtrl+O', click: () => void loadShow().catch((e) => log(`load failed: ${(e as Error).message}`)) },
        { type: 'separator' },
        { label: 'Clear Cache (app will close)', click: () => void clearCache(true) },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Show Logging', click: () => openUiWindow('settings', 'logs') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'GMeet ISO Help',
          accelerator: 'F1',
          click: () => {
            const readme = path.join(__dirname, '..', '..', 'README.md');
            if (fs.existsSync(readme)) void shell.openPath(readme);
            else void shell.openExternal('https://support.google.com/meet');
          },
        },
        { label: 'Check for Updates', enabled: false },
      ],
    },
  ];
  return Menu.buildFromTemplate(tpl);
}

// ---------- HTTP / WebSocket API ----------
let api: ApiServer | null = null;
function snapshot(): Record<string, unknown> {
  return {
    meet: lastState,
    engine: settings.engine,
    outputs: settings.outputs.map((o) => ({ ...o, live: lastState?.outputs.find((x) => x.id === o.id) ?? null })),
  };
}
function restartApi(): void {
  api?.stop();
  api = null;
  if (!settings.apiEnabled) return;
  api = new ApiServer(executeCommand, snapshot, log);
  api.start(settings.apiPort);
}

// ---------- display outputs ----------
function syncDisplays(): void {
  const displays = screen.getAllDisplays();
  const wanted = new Map<string, { name: string; display: Electron.Display }>();
  for (const o of settings.outputs) {
    if (o.display === null || o.display === undefined || !o.enabled) continue;
    const d = displays.find((x) => x.id === o.display);
    if (d) wanted.set(o.id, { name: o.name, display: d });
  }
  for (const [id, w] of displayWins) {
    const want = wanted.get(id);
    if (!want || w.key !== `${want.name}@${want.display.id}`) {
      if (!w.win.isDestroyed()) w.win.close();
      displayWins.delete(id);
    }
  }
  for (const [id, want] of wanted) {
    if (displayWins.has(id)) continue;
    const b = want.display.bounds;
    const win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      fullscreen: true,
      skipTaskbar: true,
      backgroundColor: '#000000',
      title: `GMeet ISO — ${want.name}`,
      webPreferences: { preload: path.join(__dirname, '..', 'display', 'preload.js'), contextIsolation: true, sandbox: false },
    });
    win.setMenuBarVisibility(false);
    void win.loadFile(path.join(__dirname, '..', '..', 'static', 'display.html'), { query: { source: want.name } });
    win.on('closed', () => {
      if (displayWins.get(id)?.win === win) displayWins.delete(id);
    });
    displayWins.set(id, { win, key: `${want.name}@${want.display.id}` });
    log(`Display output: ${want.name} → display ${want.display.id}`);
  }
}

// ---------- system stats ----------
function systemStats(): SystemStats {
  const metrics = app.getAppMetrics();
  const cpu = metrics.reduce((s, m) => s + m.cpu.percentCPUUsage, 0);
  const mem = metrics.reduce((s, m) => s + (m.memory.workingSetSize ?? 0), 0) / 1024;
  const primary = screen.getPrimaryDisplay().id;
  return {
    cpu: Math.round(cpu * 10) / 10,
    memMB: Math.round(mem),
    rxMbps: lastState?.rxMbps ?? 0,
    displays: screen.getAllDisplays().map((d, i) => ({ id: d.id, label: `Display ${i + 1} (${d.size.width}×${d.size.height})`, primary: d.id === primary })),
    oscPort: settings.oscEnabled ? settings.oscListenPort : null,
    apiUrl: settings.apiEnabled ? `http://127.0.0.1:${settings.apiPort}` : null,
  };
}

// ---------- IPC ----------
function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => settings);
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<Settings>) => applySettingsPatch(patch));
  ipcMain.handle(IPC.join, (_e, input: string) => joinMeeting(input));
  ipcMain.handle(IPC.leave, () => leaveMeeting());
  ipcMain.handle(IPC.signIn, () => openSignIn());
  ipcMain.handle(IPC.setMeetCamera, (_e, on: boolean) => meetWin?.webContents.send(IPC.meetSetCam, on));
  ipcMain.handle(IPC.setMeetMic, (_e, on: boolean) => meetWin?.webContents.send(IPC.meetSetMic, on));
  ipcMain.handle(IPC.ndiSources, () => {
    const own = new Set(settings.outputs.map((o) => `(${o.name})`));
    return (finder?.sources() ?? []).filter((s) => ![...own].some((n) => s.endsWith(n))).sort();
  });
  ipcMain.handle(IPC.devices, () => lastDevices);
  ipcMain.handle(IPC.dumpDom, () => dumpMeetDom());
  ipcMain.handle(IPC.command, async (_e, c: Command) => {
    try {
      return { ok: true, result: await executeCommand(c) };
    } catch (e) {
      log(`command ${c.cmd} failed: ${(e as Error).message}`);
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle(IPC.pickFile, async (_e, kind: 'image' | 'show-open' | 'show-save' | 'folder') => {
    if (!controlWin) return null;
    if (kind === 'folder') {
      const r = await dialog.showOpenDialog(controlWin, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    }
    if (kind === 'image') {
      const r = await dialog.showOpenDialog(controlWin, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    }
    if (kind === 'show-save') {
      const r = await dialog.showSaveDialog(controlWin, { defaultPath: 'show.gmiso', filters: [{ name: 'GMeet ISO show', extensions: ['gmiso'] }] });
      return r.canceled ? null : (r.filePath ?? null);
    }
    const r = await dialog.showOpenDialog(controlWin, { properties: ['openFile'], filters: [{ name: 'GMeet ISO show', extensions: ['gmiso', 'json'] }] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.system, () => systemStats());
  ipcMain.handle(IPC.openWindow, (_e, kind: WindowKind, arg?: string) => openUiWindow(kind, arg ?? ''));
  ipcMain.handle(IPC.logs, () => logRing.slice());
  ipcMain.handle(IPC.perfHistory, () => perfSamples);
  ipcMain.handle(IPC.perfControl, (_e, action: 'clear' | 'stop' | 'start') => {
    if (action === 'clear') {
      perfSamples.length = 0;
      perfSince = Date.now();
    } else if (action === 'stop') perfCapturing = false;
    else if (action === 'start') {
      perfCapturing = true;
      perfSince = Date.now();
    }
    return { capturing: perfCapturing, since: perfSince };
  });
  ipcMain.handle(IPC.openPath, (_e, kind: 'recordings' | 'logs' | 'userData') => {
    const dir =
      kind === 'recordings' ? settings.recordDir || path.join(app.getPath('videos'), 'GMeet ISO') : app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  });
  ipcMain.handle(IPC.setMeetWindowVisible, () => false); // offscreen windows can't be shown
  ipcMain.handle(IPC.popupAppMenu, (e, x?: number, y?: number) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    Menu.getApplicationMenu()?.popup({ window: win, x: x === undefined ? undefined : Math.round(x), y: y === undefined ? undefined : Math.round(y) });
  });

  ipcMain.handle(IPC.meetGetSettings, () => settings);
  ipcMain.on(IPC.meetCommand, (_e, id: number, result: unknown) => {
    meetCmdWaiters.get(id)?.(result);
    meetCmdWaiters.delete(id);
  });
  let lastStateWrite = 0;
  ipcMain.on(IPC.meetState, (_e, s: MeetState) => {
    lastState = s;
    oscRouter.onState(s); // [osc-agent]
    broadcast(IPC.state, s);
    if (Date.now() - lastStateWrite > 1000) {
      lastStateWrite = Date.now();
      fs.writeFile(path.join(app.getPath('userData'), 'state.json'), JSON.stringify(s, null, 2), () => {});
    }
  });
  ipcMain.on(IPC.meetPreview, (_e, key: string, jpeg: Uint8Array) => broadcast(IPC.preview, key, jpeg));
  ipcMain.on(IPC.meetDevices, (_e, d: DeviceLists) => {
    lastDevices = d;
    broadcast(IPC.devicesChanged, d);
    fs.writeFile(path.join(app.getPath('userData'), 'devices.json'), JSON.stringify(d, null, 2), () => {});
  });
  ipcMain.on(IPC.meetLog, (_e, line: string) => log(`[meet] ${line}`));
  ipcMain.on(IPC.meetBotName, (_e, name: string) => {
    if (!name || name === settings.botName) return;
    settings = { ...settings, botName: name };
    saveSettings();
  });
}

// ---------- dev/automation commands ----------
/**
 * Sent by launching a second instance:
 *   electron . --cmd=join:<url> | leave | dump | snap | snap-ui | eval:<js> | set:<json> | do:<Command json> | quit
 * Results land in the userData folder (meet-dom-*.txt, *.png, eval-result.txt, state.json, cmd-result.txt).
 */
async function runCliCommand(cmd: string): Promise<void> {
  log(`command: ${cmd.slice(0, 80)}`);
  const ud = app.getPath('userData');
  try {
    if (cmd.startsWith('join:')) await joinMeeting(cmd.slice(5));
    else if (cmd === 'quit') app.quit();
    else if (cmd === 'leave') await leaveMeeting();
    else if (cmd === 'dump') await dumpMeetDom();
    else if (cmd === 'snap') {
      const img = await meetWin?.webContents.capturePage();
      if (img) fs.writeFileSync(path.join(ud, 'meet-snap.png'), img.toPNG());
      log('snapshot saved: meet-snap.png');
    } else if (cmd === 'snap-ui' || cmd.startsWith('snap-ui:')) {
      // snap-ui[:<name>[:<tab>]] — optionally switch the main window's tab first (atomic).
      const [, name = 'ui-snap', tab = ''] = cmd.split(':');
      if (tab) {
        await controlWin?.webContents.executeJavaScript(`window.__showTab && window.__showTab(${JSON.stringify(tab)})`, true);
        await new Promise((r) => setTimeout(r, 700));
      }
      const img = await controlWin?.webContents.capturePage();
      if (img) fs.writeFileSync(path.join(ud, `${name}.png`), img.toPNG());
      log(`snapshot saved: ${name}.png`);
    } else if (cmd === 'reload-ui') {
      // Reload every UI window after `npm run build:ui` (no app restart, call stays up).
      controlWin?.webContents.reloadIgnoringCache();
      for (const w of uiWindows.values()) if (!w.isDestroyed()) w.webContents.reloadIgnoringCache();
    } else if (cmd.startsWith('open:')) {
      // open:<settings|effects|perf>[:<arg>]
      const [, kind, ...rest] = cmd.split(':');
      openUiWindow(kind as WindowKind, rest.join(':'));
    } else if (cmd.startsWith('close:')) {
      const w = uiWindows.get(cmd.slice(6) as WindowKind);
      if (w && !w.isDestroyed()) w.close();
    } else if (cmd.startsWith('snap-win:')) {
      // snap-win:<kind>:<name>
      const [, kind, name = `${kind}-snap`] = cmd.split(':');
      const w = uiWindows.get(kind as WindowKind);
      const img = w && !w.isDestroyed() ? await w.webContents.capturePage() : null;
      if (img) fs.writeFileSync(path.join(ud, `${name}.png`), img.toPNG());
      log(img ? `snapshot saved: ${name}.png` : `snap-win: ${kind} window not open`);
    } else if (cmd.startsWith('eval-win:')) {
      // eval-win:<kind>:<js> → eval-<kind>.txt
      const rest = cmd.slice(9);
      const i = rest.indexOf(':');
      const kind = rest.slice(0, i) as WindowKind;
      const w = uiWindows.get(kind);
      const res = w && !w.isDestroyed() ? await w.webContents.executeJavaScript(rest.slice(i + 1), true) : 'window not open';
      const out = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
      fs.writeFileSync(path.join(ud, `eval-${kind}.txt`), out ?? 'undefined');
    } else if (cmd.startsWith('eval:')) {
      const res = await meetWin?.webContents.executeJavaScript(cmd.slice(5), true);
      const out = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
      fs.writeFileSync(path.join(ud, 'eval-result.txt'), out ?? 'undefined');
      log(`eval done (${(out ?? '').length} chars)`);
    } else if (cmd.startsWith('eval-ui:')) {
      const res = await controlWin?.webContents.executeJavaScript(cmd.slice(8), true);
      const out = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
      fs.writeFileSync(path.join(ud, 'eval-ui-result.txt'), out ?? 'undefined');
      log(`eval-ui done (${(out ?? '').length} chars)`);
    } else if (cmd.startsWith('set:')) {
      applySettingsPatch(JSON.parse(cmd.slice(4)) as Partial<Settings>);
    } else if (cmd.startsWith('do:')) {
      const r = await executeCommand(JSON.parse(cmd.slice(3)) as Command);
      fs.writeFileSync(path.join(ud, 'cmd-result.txt'), JSON.stringify(r ?? null, null, 2));
    }
  } catch (e) {
    log(`command failed: ${(e as Error).message}`);
    fs.writeFileSync(path.join(ud, 'cmd-result.txt'), JSON.stringify({ error: (e as Error).message }));
  }
}

function cmdFromArgv(argv: string[]): string | null {
  const a = argv.find((x) => x.startsWith('--cmd='));
  return a ? a.slice(6) : null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const cmd = cmdFromArgv(argv);
    if (cmd) void runCliCommand(cmd);
    else {
      if (controlWin?.isMinimized()) controlWin.restore();
      controlWin?.focus();
    }
  });

  app.whenReady().then(() => {
    loadSettings();
    // Must precede any NDI load (finder here, senders in the Meet renderer).
    const ndiDir = applyNdiConfig(app.getPath('userData'), settings.ndiDiscoveryServer, settings.ndiNicIps);
    if (ndiDir) log(`NDI config: ${ndiDir}`);
    registerIpc();
    Menu.setApplicationMenu(buildAppMenu());
    setupMeetSession();
    initFinder();
    createControlWindow();
    restartOsc();
    restartApi();
    const w = ensureMeetWindow();
    if (IS_MOCK) {
      log('MOCK MODE: loading static/mock-meet.html');
      void w.loadFile(MOCK_PAGE);
    } else {
      void w.loadURL(MEET_HOME);
    }
    syncDisplays();
    screen.on('display-added', syncDisplays);
    screen.on('display-removed', syncDisplays);
    setInterval(() => {
      broadcast(IPC.system, systemStats());
      samplePerf();
    }, 1000);
    const startCmd = cmdFromArgv(process.argv);
    if (startCmd) setTimeout(() => void runCliCommand(startCmd), 3000);
  });
}

// Leave the call cleanly on quit so the account isn't left as a ghost participant
// (which makes the next join show "Switch here" instead of "Join now").
let leftOnQuit = false;
app.on('before-quit', (e) => {
  quitting = true;
  const phase = lastState?.phase ?? '';
  if (!leftOnQuit && meetWin && !meetWin.isDestroyed() && (phase === 'in-call' || phase === 'waiting')) {
    e.preventDefault();
    leftOnQuit = true;
    meetWin.webContents.send(IPC.meetLeave);
    setTimeout(() => app.quit(), 1500); // let outputs finalize recordings + leave
  }
});
app.on('window-all-closed', () => app.quit());

export type { EngineState };
