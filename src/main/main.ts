import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_SETTINGS, IPC, type MeetState, type Settings } from '../shared/types';

// Keep Meet rendering/decoding when the window is hidden, minimized or covered —
// otherwise Chromium throttles it and the NDI feeds freeze.
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

// ---------- windows ----------
let controlWin: BrowserWindow | null = null;
let meetWin: BrowserWindow | null = null;
let lastState: MeetState | null = null;

function log(line: string): void {
  const stamped = `${new Date().toLocaleTimeString()}  ${line}`;
  console.log(stamped);
  controlWin?.webContents.send(IPC.log, stamped);
}

function createControlWindow(): void {
  controlWin = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'GMeet ISO',
    backgroundColor: '#111317',
    webPreferences: {
      preload: path.join(__dirname, '..', 'control', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  controlWin.removeMenu();
  controlWin.loadFile(path.join(__dirname, '..', '..', 'static', 'control.html'));
  controlWin.on('closed', () => {
    controlWin = null;
    app.quit();
  });
}

function ensureMeetWindow(): BrowserWindow {
  if (meetWin && !meetWin.isDestroyed()) return meetWin;
  const ses = session.fromPartition(MEET_PARTITION);
  ses.setUserAgent(CHROME_UA);

  // The bot never sends camera or mic. Denying here makes Meet join devices-off.
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission !== 'media' && permission !== 'notifications');

  meetWin = new BrowserWindow({
    width: settings.meetWindowWidth,
    height: settings.meetWindowHeight,
    title: 'GMeet ISO — Meet',
    backgroundColor: '#202124',
    webPreferences: {
      partition: MEET_PARTITION,
      preload: path.join(__dirname, '..', 'meet', 'preload.js'),
      contextIsolation: true,
      sandbox: false, // preload needs Node to load the native NDI addon
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  meetWin.removeMenu();
  meetWin.webContents.setAudioMuted(settings.muteLocalAudio);
  // Open external links (help pages etc.) in the real browser, keep Google auth in-app.
  meetWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(accounts|meet)\.google\.com\//.test(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  meetWin.webContents.on('did-navigate', (_e, url) => log(`Meet window → ${url}`));
  meetWin.webContents.on('render-process-gone', (_e, d) => log(`Meet renderer gone: ${d.reason}`));
  meetWin.on('close', (e) => {
    // Hide instead of close so the session and call survive.
    if (!quitting) {
      e.preventDefault();
      meetWin?.hide();
    }
  });
  return meetWin;
}

function normalizeMeetUrl(input: string): string | null {
  const s = input.trim();
  const code = s.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  if (/^https?:\/\/meet\.google\.com\//i.test(s)) return s;
  if (code) return `https://meet.google.com/${code[1].toLowerCase()}`;
  return null;
}

let quitting = false;

// ---------- IPC ----------
function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => settings);
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    saveSettings();
    if (meetWin && !meetWin.isDestroyed()) {
      meetWin.webContents.setAudioMuted(settings.muteLocalAudio);
      if (patch.meetWindowWidth || patch.meetWindowHeight)
        meetWin.setSize(settings.meetWindowWidth, settings.meetWindowHeight);
      meetWin.webContents.send(IPC.meetSettings, settings);
    }
    return settings;
  });
  ipcMain.handle(IPC.join, async (_e, input: string) => {
    const url = normalizeMeetUrl(input);
    if (!url) throw new Error('Enter a Meet link or code like abc-defg-hij');
    const w = ensureMeetWindow();
    w.show();
    log(`Joining ${url}`);
    await w.loadURL(url);
  });
  ipcMain.handle(IPC.leave, async () => {
    if (!meetWin || meetWin.isDestroyed()) return;
    log('Leaving call');
    await meetWin.loadURL('https://meet.google.com/');
  });
  ipcMain.handle(IPC.signIn, async () => {
    const w = ensureMeetWindow();
    w.show();
    await w.loadURL('https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/');
  });
  ipcMain.handle(IPC.showMeet, () => {
    const w = ensureMeetWindow();
    if (!w.webContents.getURL()) void w.loadURL('https://meet.google.com/');
    w.show();
    w.focus();
  });
  ipcMain.handle(IPC.setFeedEnabled, (_e, key: string, enabled: boolean) => {
    meetWin?.webContents.send(IPC.meetFeedEnabled, key, enabled);
  });
  ipcMain.handle(IPC.dumpDom, async () => {
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
  });

  ipcMain.handle(IPC.meetGetSettings, () => settings);
  ipcMain.on(IPC.meetState, (_e, s: MeetState) => {
    lastState = s;
    controlWin?.webContents.send(IPC.state, s);
    if (process.env.GMEET_ISO_MOCK === '1' && Math.floor(s.updatedAt / 1000) % 5 === 0)
      console.log(
        `STATE inCall=${s.inCall} ` +
          s.feeds.map((f) => `[${f.ndiName} ${f.width}x${f.height} ${f.fps}fps ${f.format} copy=${f.copyMs}ms present=${f.present} slate=${f.slate} rx=${f.connections}]`).join(' '),
      );
  });
  ipcMain.on(IPC.meetLog, (_e, line: string) => log(`[meet] ${line}`));

  // Dev hook: GMEET_ISO_SNAPSHOT=<file.png> saves the control window after 10 s.
  const snap = process.env.GMEET_ISO_SNAPSHOT;
  if (snap)
    setTimeout(async () => {
      const img = await controlWin?.webContents.capturePage();
      if (img) fs.writeFileSync(snap, img.toPNG());
      console.log(`SNAPSHOT ${snap}`);
    }, 10000);
}

app.whenReady().then(() => {
  loadSettings();
  registerIpc();
  createControlWindow();
  // Open Meet in the background so the signed-in session is warm.
  const w = ensureMeetWindow();
  if (process.env.GMEET_ISO_MOCK === '1') {
    log('MOCK MODE: loading static/mock-meet.html');
    w.show();
    void w.loadFile(path.join(__dirname, '..', '..', 'static', 'mock-meet.html'));
  } else {
    w.hide();
    void w.loadURL('https://meet.google.com/');
  }
  void lastState;
});

app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => app.quit());
