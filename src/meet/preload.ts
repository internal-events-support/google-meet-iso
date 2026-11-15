// Preload for the Meet window. Runs in an isolated world on meet.google.com with Node
// access (sandbox: false) so it can load the native NDI addon directly. The Meet page
// itself never sees Node or the addon (contextIsolation: true).

import { ipcRenderer } from 'electron';
import * as path from 'path';
import { DEFAULT_SETTINGS, IPC, type MeetState, type Settings } from '../shared/types';
import { FeedCapture, type NativeNdi } from './capture';
import { dumpDom, findTiles, inCall, tryAutoJoin } from './dom';

function log(line: string): void {
  ipcRenderer.send(IPC.meetLog, line);
}

function loadNdi(): { ndi: NativeNdi | null; status: MeetState['ndi'] } {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'Release', 'gmeet_iso_ndi.node'),
    // Packaged app: native modules are unpacked next to app.asar.
    path.join(__dirname, '..', '..', '..', 'app.asar.unpacked', 'build', 'Release', 'gmeet_iso_ndi.node'),
  ];
  let lastErr = 'addon not found';
  for (const p of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(p) as NativeNdi;
      const st = mod.load();
      if (!st.ok) return { ndi: null, status: { ok: false, error: st.error } };
      log(`NDI loaded: ${st.version} (${st.path})`);
      return { ndi: mod, status: { ok: true, version: st.version } };
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  return { ndi: null, status: { ok: false, error: lastErr } };
}

// GMEET_ISO_MOCK=1 also activates on the local mock page (static/mock-meet.html) for testing.
const isMeet =
  location.hostname === 'meet.google.com' ||
  (process.env.GMEET_ISO_MOCK === '1' && location.pathname.endsWith('mock-meet.html'));
let settings: Settings = { ...DEFAULT_SETTINGS };
const feeds = new Map<string, FeedCapture>();
const disabledKeys = new Set<string>();
let ndiState: MeetState['ndi'] = { ok: false, error: 'not loaded' };
let ndi: NativeNdi | null = null;
let autoJoinAttempted = '';

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

function tick(): void {
  if (settings.autoJoin && !inCall() && autoJoinAttempted !== location.pathname && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.pathname)) {
    if (tryAutoJoin()) {
      autoJoinAttempted = location.pathname;
      log('Auto-join clicked');
    }
  }

  const live = inCall();
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
          () => ({ maxFps: settings.maxFps, groups: settings.ndiGroups }),
          log,
        );
        feed.enabled = !disabledKeys.has(t.key);
        feeds.set(t.key, feed);
        log(`Tile found: ${t.displayName} [${t.isScreen ? 'screen' : 'camera'}]`);
      }
      // Names sometimes render a beat after the tile; rename while unconnected.
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
    const settingsExclude = (feed.kind === 'screen' && !settings.screenShare);
    if (!live || settingsExclude || now - feed.lastSeen > settings.graceSeconds * 1000) {
      log(`Feed removed: ${feed.displayName}`);
      feed.dispose();
      feeds.delete(key);
    }
  }
}

function report(): void {
  const state: MeetState = {
    url: location.href,
    inCall: inCall(),
    ndi: ndiState,
    feeds: Array.from(feeds.values()).map((f) => f.state()),
    updatedAt: Date.now(),
  };
  ipcRenderer.send(IPC.meetState, state);
}

function disposeAll(): void {
  for (const f of feeds.values()) f.dispose();
  feeds.clear();
}

if (isMeet) {
  ipcRenderer.on(IPC.meetSettings, (_e, s: Settings) => {
    const prefixChanged = s.ndiPrefix !== settings.ndiPrefix || s.ndiGroups !== settings.ndiGroups;
    settings = s;
    if (prefixChanged) for (const f of feeds.values()) if (f.published) f.publish(ndiNameFor(f));
  });
  ipcRenderer.on(IPC.meetFeedEnabled, (_e, key: string, enabled: boolean) => {
    if (enabled) disabledKeys.delete(key);
    else disabledKeys.add(key);
    const f = feeds.get(key);
    if (f) f.enabled = enabled;
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

  void ipcRenderer.invoke(IPC.meetGetSettings).then((s: Settings) => {
    settings = s;
  });

  const loaded = loadNdi();
  ndi = loaded.ndi;
  ndiState = loaded.status;
  if (!ndi) log(`NDI unavailable: ${ndiState.error}`);

  window.addEventListener('DOMContentLoaded', () => {
    window.setInterval(() => {
      try {
        tick();
      } catch (e) {
        log(`tick error: ${(e as Error).message}`);
      }
    }, 500);
    window.setInterval(report, 1000);
  });
  window.addEventListener('pagehide', disposeAll);
}
