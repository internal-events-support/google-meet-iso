// Preload for the hidden Meet window. Runs in an isolated world on meet.google.com with
// Node access (sandbox: false) so it can load the native NDI addon directly. The Meet page
// itself never sees Node or the addon (contextIsolation: true).

import { contextBridge, ipcRenderer } from 'electron';
import * as path from 'path';
import { BOT_CAM_KEY, DEFAULT_SETTINGS, IPC, type DeviceLists, type MeetState, type Settings } from '../shared/types';
import { BotCamera, getCamCanvas, Thumbnailer } from './camsource';
import { FeedCapture, type NativeNdi } from './capture';
import {
  cameraOn,
  clickLeave,
  dismissDeviceDialog,
  dumpDom,
  findTiles,
  inCall,
  meetingPhase,
  micOn,
  setDevice,
  tryAutoJoin,
} from './dom';
import { installMediaShim } from './inject';

type NativeWithReceiver = NativeNdi & {
  Receiver: ConstructorParameters<typeof BotCamera>[0];
};

function log(line: string): void {
  ipcRenderer.send(IPC.meetLog, line);
}

function loadNdi(): { ndi: NativeWithReceiver | null; status: MeetState['ndi'] } {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'Release', 'gmeet_iso_ndi.node'),
    // Packaged app: native modules are unpacked next to app.asar.
    path.join(__dirname, '..', '..', '..', 'app.asar.unpacked', 'build', 'Release', 'gmeet_iso_ndi.node'),
  ];
  let lastErr = 'addon not found';
  for (const p of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(p) as NativeWithReceiver;
      const st = mod.load();
      if (!st.ok) return { ndi: null, status: { ok: false, error: st.error } };
      log(`NDI loaded: ${st.version}`);
      return { ndi: mod, status: { ok: true, version: st.version } };
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  return { ndi: null, status: { ok: false, error: lastErr } };
}

// GMEET_ISO_MOCK=1 also activates on the local mock page (static/mock-meet.html) for testing.
const isMock = process.env.GMEET_ISO_MOCK === '1' && location.pathname.endsWith('mock-meet.html');
const isMeet = location.hostname === 'meet.google.com' || isMock;
const isGoogle = isMeet || /(^|\.)google\.com$/.test(location.hostname);

let settings: Settings = { ...DEFAULT_SETTINGS };
const feeds = new Map<string, FeedCapture>();
const disabledKeys = new Set<string>();
let ndiState: MeetState['ndi'] = { ok: false, error: 'not loaded' };
let ndi: NativeWithReceiver | null = null;
let botCam: BotCamera | null = null;
const botThumb = new Thumbnailer(320);
let autoJoinAt = 0;
let greenRoomPrepared = '';
let lastDialogDismiss = 0;

function ndiNameFor(feed: FeedCapture): string {
  const base = `${settings.ndiPrefix.trim() || 'GMEET'} - ${feed.displayName}`;
  const suffix = feed.kind === 'screen' ? ' (Screen)' : '';
  let name = `${base}${suffix}`.slice(0, 120);
  // Disambiguate two participants with the same display name.
  let n = 2;
  const taken = new Set(
    Array.from(feeds.values())
      .filter((f) => f !== feed && f.ndiName)
      .map((f) => f.ndiName),
  );
  while (taken.has(name)) name = `${base} #${n++}${suffix}`;
  return name;
}

function sendPreview(key: string, jpeg: ArrayBuffer): void {
  ipcRenderer.send(IPC.meetPreview, key, new Uint8Array(jpeg));
}

function applyMediaSettings(): void {
  const root = document.documentElement;
  if (root) root.dataset.gmeetIsoMic = settings.micLabel || '';
  void botCam?.setSource(settings.camera);
}

function tick(): void {
  const { phase } = meetingPhase();

  if (settings.autoJoin && phase !== 'in-call' && Date.now() - lastDialogDismiss > 2000 && dismissDeviceDialog()) {
    lastDialogDismiss = Date.now();
    log('Dismissed camera/mic prompt');
  }
  if (phase === 'green-room') {
    // Before joining, make Meet's cam/mic toggles match what the operator configured.
    if (greenRoomPrepared !== location.pathname) {
      greenRoomPrepared = location.pathname;
      setDevice('camera', settings.camera.type !== 'none');
      setDevice('microphone', !!settings.micLabel);
    }
    if (settings.autoJoin && Date.now() - autoJoinAt > 8000 && tryAutoJoin()) {
      autoJoinAt = Date.now();
      log('Clicked join');
    }
  }

  const live = phase === 'in-call';
  const seen = new Set<string>();
  if (live && ndi) {
    for (const t of findTiles()) {
      if (t.isSelf && !settings.includeSelf) continue;
      if (t.isScreen && !settings.screenShare) continue;
      seen.add(t.key);
      let feed = feeds.get(t.key);
      if (!feed) {
        feed = new FeedCapture(
          ndi,
          { key: t.key, participantId: t.participantId, kind: t.isScreen ? 'screen' : 'camera', displayName: t.displayName },
          () => ({ maxFps: settings.maxFps, groups: settings.ndiGroups, previewFps: settings.previewFps }),
          log,
          sendPreview,
        );
        feed.enabled = !disabledKeys.has(t.key);
        feeds.set(t.key, feed);
        log(`Participant found: ${t.displayName} [${t.isScreen ? 'screen' : 'camera'}]`);
      }
      // Names sometimes render a beat after the tile; rename while nobody is connected.
      if (t.displayName && t.displayName !== feed.displayName) {
        feed.displayName = t.displayName;
        if (feed.published && feed.state().connections === 0) feed.publish(ndiNameFor(feed));
      }
      feed.bindTile(t.el);
      if (feed.enabled && !feed.published) feed.publish(ndiNameFor(feed));
      if (!feed.enabled && feed.published) feed.unpublish();
    }
  }

  // Tiles that vanished: keep the source alive (black) for the grace period.
  const now = performance.now();
  for (const [key, feed] of feeds) {
    if (seen.has(key)) continue;
    feed.bindTile(null);
    const excluded = feed.kind === 'screen' && !settings.screenShare;
    if (!live || excluded || now - feed.lastSeen > settings.graceSeconds * 1000) {
      log(`Participant gone: ${feed.displayName}`);
      feed.dispose();
      feeds.delete(key);
    }
  }
}

function report(): void {
  const { phase, detail } = meetingPhase();
  const state: MeetState = {
    url: location.href,
    phase,
    phaseDetail: detail,
    inCall: inCall(),
    camOn: cameraOn(),
    micOn: micOn(),
    botCam: {
      source: settings.camera,
      status: botCam?.status ?? 'off',
      width: botCam?.width ?? 0,
      height: botCam?.height ?? 0,
      fps: botCam?.fps() ?? 0,
    },
    micActive: document.documentElement?.dataset.gmeetIsoMicActive ?? '',
    ndi: ndiState,
    feeds: Array.from(feeds.values()).map((f) => f.state()),
    updatedAt: Date.now(),
  };
  ipcRenderer.send(IPC.meetState, state);
}

async function reportDevices(): Promise<void> {
  try {
    let devs = await navigator.mediaDevices.enumerateDevices(); // isolated world: real devices
    // Chromium hides device labels until getUserMedia has succeeded once in this document.
    const needsUnlock = (k: MediaDeviceKind) => devs.some((d) => d.kind === k) && !devs.some((d) => d.kind === k && d.label);
    if (needsUnlock('audioinput') || needsUnlock('videoinput')) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: needsUnlock('audioinput'), video: needsUnlock('videoinput') });
        s.getTracks().forEach((t) => t.stop());
        devs = await navigator.mediaDevices.enumerateDevices();
      } catch (e) {
        log(`device label unlock failed: ${(e as Error).message}`);
      }
    }
    const lists: DeviceLists = {
      videoInputs: devs.filter((d) => d.kind === 'videoinput' && d.label).map((d) => d.label),
      audioInputs: devs.filter((d) => d.kind === 'audioinput' && d.label).map((d) => d.label),
    };
    ipcRenderer.send(IPC.meetDevices, lists);
  } catch (e) {
    log(`device enumeration failed: ${(e as Error).message}`);
  }
}

function disposeAll(): void {
  for (const f of feeds.values()) f.dispose();
  feeds.clear();
  botCam?.dispose();
}

if (isMeet) {
  // Replace getUserMedia/enumerateDevices in the page before Meet's scripts run.
  try {
    contextBridge.executeInMainWorld({ func: installMediaShim });
  } catch (e) {
    log(`media shim injection failed: ${(e as Error).message}`);
  }

  ipcRenderer.on(IPC.meetSettings, (_e, s: Settings) => {
    const prefixChanged = s.ndiPrefix !== settings.ndiPrefix || s.ndiGroups !== settings.ndiGroups;
    settings = s;
    applyMediaSettings();
    if (prefixChanged) for (const f of feeds.values()) if (f.published) f.publish(ndiNameFor(f));
  });
  ipcRenderer.on(IPC.meetFeedEnabled, (_e, key: string, enabled: boolean) => {
    if (enabled) disabledKeys.delete(key);
    else disabledKeys.add(key);
    const f = feeds.get(key);
    if (f) f.enabled = enabled;
  });
  ipcRenderer.on(IPC.meetSetCam, (_e, on: boolean) => setDevice('camera', on));
  ipcRenderer.on(IPC.meetSetMic, (_e, on: boolean) => setDevice('microphone', on));
  ipcRenderer.on(IPC.meetLeave, () => {
    if (clickLeave()) log('Left the call');
  });
  ipcRenderer.on(IPC.meetDumpRequest, () => {
    let out: string;
    try {
      out = dumpDom();
    } catch (e) {
      out = `dump failed: ${(e as Error).message}`;
    }
    ipcRenderer.send(IPC.meetDumpResult, out);
  });

  const loaded = loadNdi();
  ndi = loaded.ndi;
  ndiState = loaded.status;
  if (!ndi) log(`NDI unavailable: ${ndiState.error}`);

  window.addEventListener('DOMContentLoaded', () => {
    getCamCanvas();
    botCam = new BotCamera(ndi?.Receiver ?? null, log);
    void ipcRenderer.invoke(IPC.meetGetSettings).then((s: Settings) => {
      settings = s;
      applyMediaSettings();
    });
    window.setInterval(() => {
      try {
        tick();
      } catch (e) {
        log(`tick error: ${(e as Error).message}`);
      }
    }, 500);
    window.setInterval(report, 1000);
    // Bot camera preview for the control UI.
    window.setInterval(() => {
      const c = getCamCanvas();
      void botThumb.maybe(c, c.width, c.height, settings.previewFps).then((j) => j && sendPreview(BOT_CAM_KEY, j));
    }, 1000 / 15);
    void reportDevices();
    navigator.mediaDevices.addEventListener('devicechange', () => void reportDevices());
  });
  window.addEventListener('pagehide', disposeAll);
} else if (isGoogle) {
  // accounts.google.com etc.: nothing to do, but report so the UI knows we're signed out.
  window.addEventListener('DOMContentLoaded', () => {
    window.setInterval(report, 1000);
  });
}
