import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_SETTINGS, IPC, type DeviceLists, type MeetState, type Settings } from '../shared/types';

// Keep the hidden Meet client rendering/decoding at full rate.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Google blocks sign-in from user agents that look like embedded browsers.
const chromeMajor = process.versions.chrome.split('.')[0];
const platformUA =
  process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'linux'
      ? 'X11; Linux x86_64'
      : 'Windows NT 10.0; Win64; x64';
const CHROME_UA = `Mozilla/5.0 (${platformUA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
app.userAgentFallback = CHROME_UA;

const MEET_PARTITION = 'persist:meet';
const MEET_HOME = 'https://meet.google.com/';
const IS_MOCK = process.env.GMEET_ISO_MOCK === '1';
const MOCK_PAGE = path.join(__dirname, '..', '..', 'static', 'mock-meet.html');

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings: Settings = { ...DEFAULT_SETTINGS };
function loadSettings(): void {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
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
let lastDevices: DeviceLists = { videoInputs: [], audioInputs: [] };
let quitting = false;

function log(line: string): void {
  const stamped = `${new Date().toLocaleTimeString()}  ${line}`;
  console.log(stamped);
  controlWin?.webContents.send(IPC.log, stamped);
}

function createControlWindow(): void {
  controlWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'GMeet ISO',
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: path.join(__dirname, '..', 'control', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  controlWin.removeMenu();
  void controlWin.loadFile(path.join(__dirname, '..', '..', 'static', 'control.html'));
  controlWin.on('closed', () => {
    controlWin = null;
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
    cb(permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
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

// ---------- IPC ----------
function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => settings);
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    saveSettings();
    if (meetWin && !meetWin.isDestroyed()) {
      meetWin.webContents.setAudioMuted(settings.muteLocalAudio);
      if (patch.meetWindowWidth || patch.meetWindowHeight) meetWin.setContentSize(settings.meetWindowWidth, settings.meetWindowHeight);
      meetWin.webContents.send(IPC.meetSettings, settings);
    }
    return settings;
  });
  ipcMain.handle(IPC.join, (_e, input: string) => joinMeeting(input));
  ipcMain.handle(IPC.leave, () => leaveMeeting());
  ipcMain.handle(IPC.signIn, () => openSignIn());
  ipcMain.handle(IPC.setFeedEnabled, (_e, key: string, enabled: boolean) => meetWin?.webContents.send(IPC.meetFeedEnabled, key, enabled));
  ipcMain.handle(IPC.setMeetCamera, (_e, on: boolean) => meetWin?.webContents.send(IPC.meetSetCam, on));
  ipcMain.handle(IPC.setMeetMic, (_e, on: boolean) => meetWin?.webContents.send(IPC.meetSetMic, on));
  ipcMain.handle(IPC.ndiSources, () => {
    const own = `(${settings.ndiPrefix.trim() || 'GMEET'} - `;
    return (finder?.sources() ?? []).filter((s) => !s.includes(own)).sort();
  });
  ipcMain.handle(IPC.devices, () => lastDevices);
  ipcMain.handle(IPC.dumpDom, () => dumpMeetDom());

  ipcMain.handle(IPC.meetGetSettings, () => settings);
  ipcMain.on(IPC.meetState, (_e, s: MeetState) => {
    controlWin?.webContents.send(IPC.state, s);
    fs.writeFile(path.join(app.getPath('userData'), 'state.json'), JSON.stringify(s, null, 2), () => {});
    if (IS_MOCK && Math.floor(s.updatedAt / 1000) % 5 === 0)
      console.log(
        `STATE phase=${s.phase} cam=${s.camOn} mic=${s.micOn} botcam=${s.botCam.status} ${s.botCam.width}x${s.botCam.height}@${s.botCam.fps} micActive="${s.micActive}" ` +
          s.feeds.map((f) => `[${f.ndiName} ${f.width}x${f.height} ${f.fps}fps present=${f.present} slate=${f.slate}]`).join(' '),
      );
  });
  ipcMain.on(IPC.meetPreview, (_e, key: string, jpeg: Uint8Array) => controlWin?.webContents.send(IPC.preview, key, jpeg));
  ipcMain.on(IPC.meetDevices, (_e, d: DeviceLists) => {
    lastDevices = d;
    controlWin?.webContents.send(IPC.devicesChanged, d);
    fs.writeFile(path.join(app.getPath('userData'), 'devices.json'), JSON.stringify(d, null, 2), () => {});
  });
  ipcMain.on(IPC.meetLog, (_e, line: string) => log(`[meet] ${line}`));
}

// ---------- dev/automation commands ----------
/**
 * Sent by launching a second instance:
 *   electron . --cmd=join:<url> | leave | dump | snap | snap-ui | eval:<js>
 * Results land in the userData folder (meet-dom-*.txt, *.png, eval-result.txt, state.json).
 */
async function runCommand(cmd: string): Promise<void> {
  log(`command: ${cmd.slice(0, 80)}`);
  const ud = app.getPath('userData');
  try {
    if (cmd.startsWith('join:')) await joinMeeting(cmd.slice(5));
    else if (cmd === 'leave') await leaveMeeting();
    else if (cmd === 'dump') await dumpMeetDom();
    else if (cmd === 'snap') {
      const img = await meetWin?.webContents.capturePage();
      if (img) fs.writeFileSync(path.join(ud, 'meet-snap.png'), img.toPNG());
      log('snapshot saved: meet-snap.png');
    } else if (cmd === 'snap-ui') {
      const img = await controlWin?.webContents.capturePage();
      if (img) fs.writeFileSync(path.join(ud, 'ui-snap.png'), img.toPNG());
      log('snapshot saved: ui-snap.png');
    } else if (cmd.startsWith('eval:')) {
      const res = await meetWin?.webContents.executeJavaScript(cmd.slice(5), true);
      const out = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
      fs.writeFileSync(path.join(ud, 'eval-result.txt'), out ?? 'undefined');
      log(`eval done (${(out ?? '').length} chars)`);
    } else if (cmd.startsWith('set:')) {
      // set:{"camera":{"type":"ndi","name":"..."}}
      const patch = JSON.parse(cmd.slice(4)) as Partial<Settings>;
      settings = { ...settings, ...patch };
      saveSettings();
      meetWin?.webContents.send(IPC.meetSettings, settings);
      controlWin?.webContents.reload();
    }
  } catch (e) {
    log(`command failed: ${(e as Error).message}`);
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
    if (cmd) void runCommand(cmd);
    else {
      if (controlWin?.isMinimized()) controlWin.restore();
      controlWin?.focus();
    }
  });

  app.whenReady().then(() => {
    loadSettings();
    registerIpc();
    setupMeetSession();
    initFinder();
    createControlWindow();
    const w = ensureMeetWindow();
    if (IS_MOCK) {
      log('MOCK MODE: loading static/mock-meet.html');
      void w.loadFile(MOCK_PAGE);
    } else {
      void w.loadURL(MEET_HOME);
    }
    const startCmd = cmdFromArgv(process.argv);
    if (startCmd) setTimeout(() => void runCommand(startCmd), 3000);
  });
}

app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => app.quit());
