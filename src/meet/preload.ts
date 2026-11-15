// Preload for the hidden Meet window. Runs in an isolated world on meet.google.com with
// Node access (sandbox: false) so it can load the native NDI addon directly. The Meet page
// itself never sees Node or the addon (contextIsolation: true).
//
// Orchestrates:
//   sources  — one SourceTap per participant tile (camera / screen share)
//   outputs  — ZoomISO-style slots (stable NDI sources) routed to sources by mode
//   audio    — meeting mix + per-participant ISO audio into the slots
//   speaker  — active speaker + CSRC→participant attribution
//   control  — join flow, layout, host tools, bot camera/mic, commands from main

import { contextBridge, ipcRenderer } from 'electron';
import * as path from 'path';
import {
  BOT_CAM_KEY,
  DEFAULT_SETTINGS,
  IPC,
  type Command,
  type DeviceLists,
  type MeetState,
  type OutputConfig,
  type ParticipantState,
  type Settings,
} from '../shared/types';
import { AudioRouter } from './audio';
import { OutputDeviceRouter } from './audioRouting'; // [audio-agent]
import { BotCamera, getCamCanvas, Thumbnailer } from './camsource';
import {
  accountName,
  admitWaiting,
  applyTiledLayout,
  cameraOn,
  clickLeave,
  denyWaiting,
  dismissDeviceDialog,
  dumpDom,
  findTiles,
  inCall,
  meetingPhase,
  micOn,
  muteParticipant,
  sendChat,
  setBotName,
  setDevice,
  tileHandRaised,
  tileMicMuted,
  tryAutoJoin,
  waitingRequests,
  // [participants-agent] People-panel roster + host actions
  ensurePeoplePanel,
  lowerHand,
  muteAll,
  muteRosterParticipant,
  pinParticipant,
  removeParticipant,
  scrapeRoster,
  spotlightParticipant,
  tilePinState,
  type RosterEntry,
} from './dom';
import { installMediaShim } from './inject';
import type { NativeNdi } from './native';
import { OutputPipeline } from './outputs';
import { defaultRecordDir } from './recorder';
import { SourceTap } from './sources';
import { SpeakerTracker } from './speaker';

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
let ndiState: MeetState['ndi'] = { ok: false, error: 'not loaded' };
let ndi: NativeNdi | null = null;
let botCam: BotCamera | null = null;
const botThumb = new Thumbnailer(320);
const sources = new Map<string, SourceTap>();
const outputs = new Map<string, OutputPipeline>();
const speaker = new SpeakerTracker();
let router: AudioRouter | null = null;
let deviceRouter: OutputDeviceRouter | null = null; // [audio-agent]

// ---------------------------------------------------------------------------
// join flow helpers
// ---------------------------------------------------------------------------
let autoJoinAt = 0;
let lastDialogDismiss = 0;
/**
 * Per meeting, make Meet's cam/mic toggles match the operator's config. Clicks right as the
 * green room renders (or in the same tick as Join) can be swallowed, so we verify on later
 * ticks and retry a few times.
 */
const deviceSync = {
  path: '',
  done: { camera: false, microphone: false },
  attempts: { camera: 0, microphone: 0 },
  lastClick: { camera: 0, microphone: 0 },
  startedAt: 0,
};
function syncDevices(): boolean {
  if (deviceSync.path !== location.pathname) {
    deviceSync.path = location.pathname;
    deviceSync.done = { camera: false, microphone: false };
    deviceSync.attempts = { camera: 0, microphone: 0 };
    deviceSync.lastClick = { camera: 0, microphone: 0 };
    deviceSync.startedAt = Date.now();
  }
  const want = { camera: settings.camera.type !== 'none', microphone: !!settings.micLabel };
  for (const kind of ['camera', 'microphone'] as const) {
    if (deviceSync.done[kind]) continue;
    const cur = kind === 'camera' ? cameraOn() : micOn();
    if (cur === null) continue;
    if (cur === want[kind]) {
      deviceSync.done[kind] = true;
      log(`${kind} ${want[kind] ? 'on' : 'off'} in Meet`);
    } else if (Date.now() - deviceSync.lastClick[kind] > 1500) {
      if (deviceSync.attempts[kind]++ >= 5) {
        deviceSync.done[kind] = true;
        log(`could not set ${kind} ${want[kind] ? 'on' : 'off'} in Meet`);
      } else {
        setDevice(kind, want[kind]);
        deviceSync.lastClick[kind] = Date.now();
      }
    }
  }
  return (deviceSync.done.camera && deviceSync.done.microphone) || Date.now() - deviceSync.startedAt > 8000;
}

/** Once-per-meeting actions after entering the call. */
const meetingOnce = { path: '', layout: '', notice: false, noticeTries: 0, noticeAt: 0, layoutAt: 0 };

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------
function sendPreview(key: string, jpeg: ArrayBuffer): void {
  ipcRenderer.send(IPC.meetPreview, key, new Uint8Array(jpeg));
}

function syncSources(live: boolean): void {
  const seen = new Set<string>();
  if (live) {
    const tiles = findTiles();
    speaker.observe(tiles.map((t) => ({ key: t.key, el: t.el })));
    for (const t of tiles) {
      if (t.isScreen && !settings.screenShare) continue;
      seen.add(t.key);
      let src = sources.get(t.key);
      if (!src) {
        src = new SourceTap(
          { key: t.key, participantId: t.participantId, kind: t.isScreen ? 'screen' : 'camera', displayName: t.displayName },
          log,
          sendPreview,
          () => 2,
        );
        sources.set(t.key, src);
      }
      if (t.hasName && !src.hasName) log(`Participant: ${t.displayName}${t.isScreen ? ' [screen]' : ''}${t.isSelf ? ' (bot)' : ''}`);
      src.displayName = t.displayName;
      src.hasName = t.hasName;
      src.isSelf = t.isSelf;
      src.muted = tileMicMuted(t.el);
      src.handRaised = tileHandRaised(t.el);
      src.bindTile(t.el);
    }
  }
  const now = performance.now();
  for (const [key, src] of sources) {
    if (seen.has(key)) continue;
    src.bindTile(null);
    if (!live || now - src.lastSeen > settings.graceSeconds * 1000) {
      if (src.hasName) log(`Participant left: ${src.displayName}`);
      src.dispose();
      sources.delete(key);
    }
  }
}

/** Participants eligible for routing (named, not the bot unless allowed). */
function eligible(kind: 'camera' | 'screen'): SourceTap[] {
  return [...sources.values()]
    .filter((s) => s.kind === kind && (s.hasName || performance.now() - s.createdAt > 3000) && (!s.isSelf || settings.includeSelf) && s.tile)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function findSourceFor(sel: { key: string; name: string } | null, kind?: 'camera' | 'screen'): SourceTap | null {
  if (!sel) return null;
  const direct = sources.get(sel.key);
  if (direct && (!kind || direct.kind === kind)) return direct;
  // Rejoined with a new device id: match by display name.
  const byName = [...sources.values()].find((s) => s.displayName === sel.name && (!kind || s.kind === kind) && s.tile);
  return byName ?? null;
}

// ---------------------------------------------------------------------------
// outputs
// ---------------------------------------------------------------------------
function syncOutputs(): void {
  if (!ndi) return;
  const wanted = new Set(settings.outputs.map((o) => o.id));
  for (const [id, p] of outputs) {
    if (!wanted.has(id)) {
      p.dispose();
      outputs.delete(id);
    }
  }
  for (const cfg of settings.outputs) {
    let p = outputs.get(cfg.id);
    if (!p) {
      p = new OutputPipeline(cfg, {
        ndi,
        groups: () => settings.ndiGroups,
        previewFps: () => settings.previewFps,
        recordDir: () => settings.recordDir || defaultRecordDir(),
        log,
        onPreview: sendPreview,
        videoLoss: () => settings.videoLoss, // [effects-agent] loss delay + profile picture style
      });
      outputs.set(cfg.id, p);
    } else {
      p.setConfig(cfg);
    }
    p.setEngine(settings.engine);
  }
}

/** Decide which source each output shows. */
function routeOutputs(): void {
  const cams = eligible('camera');
  const screens = eligible('screen');
  const claimed = new Set<string>();
  const decided = new Map<string, SourceTap | null>();

  // 1) explicit participant selections (these claim the participant from auto slots)
  for (const cfg of settings.outputs) {
    if (cfg.mode !== 'participant') continue;
    let src = findSourceFor(cfg.selection, undefined);
    if (src) claimed.add(src.key);
    else if (cfg.failover === 'activeSpeaker' && speaker.activeSpeaker) src = sources.get(speaker.activeSpeaker) ?? null;
    decided.set(cfg.id, src);
  }
  // 2) screen shares
  for (const cfg of settings.outputs) {
    if (cfg.mode !== 'screenshare') continue;
    const chosen = findSourceFor(cfg.selection, 'screen') ?? screens[0] ?? null;
    decided.set(cfg.id, chosen);
  }
  // 3) active speaker
  for (const cfg of settings.outputs) {
    if (cfg.mode !== 'activeSpeaker') continue;
    const k = speaker.activeSpeaker;
    decided.set(cfg.id, (k && sources.get(k)) || cams[0] || null);
  }
  // 4) auto: keep current assignment while valid, else take the next unclaimed participant
  const autoCfgs = settings.outputs.filter((o) => o.mode === 'auto');
  for (const cfg of autoCfgs) {
    const cur = outputs.get(cfg.id)?.boundKey;
    const src = cur ? sources.get(cur) : undefined;
    if (src && src.tile && src.kind === 'camera' && !claimed.has(src.key) && cams.includes(src)) {
      decided.set(cfg.id, src);
      claimed.add(src.key);
    }
  }
  for (const cfg of autoCfgs) {
    if (decided.get(cfg.id)) continue;
    const next = cams.find((s) => !claimed.has(s.key)) ?? null;
    decided.set(cfg.id, next);
    if (next) claimed.add(next.key);
  }
  for (const [id, src] of decided) {
    const p = outputs.get(id);
    if (!p) continue;
    p.bind(src);
  }
}

/** Route meeting audio into the outputs (called every ~10 ms by the router). */
function onAudio(mix: Float32Array, perTrack: Map<string, Float32Array>, n: number): void {
  const outBufs = new Map<string, Float32Array>(); // [audio-agent]
  const assigned = new Set<string>(); // [audio-agent]
  for (const cfg of settings.outputs) {
    if (cfg.audio === 'off') continue;
    const p = outputs.get(cfg.id);
    if (!p) continue;
    let buf: Float32Array | null = null;
    if (cfg.audio === 'mix' || cfg.mode === 'screenshare') buf = mix;
    else {
      const key = p.boundKey;
      const base = key?.replace(/:screen$/, '') ?? null;
      const track = base ? speaker.audioTrackFor(base) : null;
      buf = track ? (perTrack.get(track) ?? null) : null;
      // Single remote participant: their audio is the mix, attribution or not.
      if (!buf && eligible('camera').length === 1 && key) buf = mix;
      if (!buf) buf = new Float32Array(n * 2); // silence keeps the stream continuous
      if (track) assigned.add(track); // [audio-agent]
    }
    outBufs.set(cfg.id, buf); // [audio-agent]
    p.pushAudio(buf, 48000, 2, n);
  }
  // [audio-agent] Audio tab → local output devices
  deviceRouter?.process({
    n,
    mix,
    perTrack,
    outputs: outBufs,
    assignedTracks: assigned,
    speakerTrack: speaker.activeSpeaker ? speaker.audioTrackFor(speaker.activeSpeaker) : null,
    participant: (key, name) => {
      let k = key;
      if (!sources.has(k) && name) k = [...sources.values()].find((s) => s.kind === 'camera' && s.displayName === name)?.key ?? key;
      const t = speaker.audioTrackFor(k);
      const b = t ? (perTrack.get(t) ?? null) : null;
      if (!b && eligible('camera').length === 1 && eligible('camera')[0].key === k) return mix;
      return b;
    },
  });
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------
function applySettings(): void {
  setBotName(settings.botName);
  const root = document.documentElement;
  if (root) root.dataset.gmeetIsoMic = settings.micLabel || '';
  void botCam?.setSource(settings.camera);
  void router?.setMonitorDevice(settings.monitorDevice);
  deviceRouter?.sync(settings); // [audio-agent]
  syncOutputs();
}

async function onceInCall(): Promise<void> {
  if (meetingOnce.path !== location.pathname) {
    meetingOnce.path = location.pathname;
    meetingOnce.layout = '';
    meetingOnce.notice = false;
    meetingOnce.noticeTries = 0;
    meetingOnce.noticeAt = 0;
    meetingOnce.layoutAt = performance.now();
  }
  const layoutKey = `${settings.autoLayout}:${settings.maxTiles}`;
  if (settings.autoLayout && meetingOnce.layout !== layoutKey && performance.now() - meetingOnce.layoutAt > 2500) {
    meetingOnce.layout = layoutKey;
    const r = await applyTiledLayout(settings.maxTiles);
    log(`Layout: ${r}`);
  }
  // Chat isn't usable for a few seconds after joining: retry a few times.
  const now = performance.now();
  if (!meetingOnce.notice && settings.joinNotice.trim() && now - meetingOnce.layoutAt > 6000 && now - meetingOnce.noticeAt > 5000) {
    meetingOnce.noticeAt = now;
    const ok = await sendChat(settings.joinNotice.trim());
    if (ok) log(`Posted notice: "${settings.joinNotice.trim()}"`);
    if (ok || ++meetingOnce.noticeTries >= 4) meetingOnce.notice = true;
    if (!ok && meetingOnce.notice) log('Could not post join notice');
  }
}

let busy = false;
async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const { phase } = meetingPhase();
    const acct = accountName();
    if (acct && acct !== settings.botName) {
      settings = { ...settings, botName: acct };
      setBotName(acct);
      ipcRenderer.send(IPC.meetBotName, acct);
      log(`Bot account: ${acct}`);
    }
    if (settings.autoJoin && phase !== 'in-call' && Date.now() - lastDialogDismiss > 2000 && dismissDeviceDialog()) {
      lastDialogDismiss = Date.now();
      log('Dismissed camera/mic prompt');
    }
    let devicesReady = true;
    if (phase === 'green-room' || phase === 'waiting' || phase === 'in-call') devicesReady = syncDevices();
    if (phase === 'green-room' && devicesReady && settings.autoJoin && Date.now() - autoJoinAt > 8000 && tryAutoJoin()) {
      autoJoinAt = Date.now();
      log('Clicked join');
    }

    const live = phase === 'in-call';
    syncSources(live);
    syncRoster(live); // [participants-agent]
    speaker.readRtc();
    speaker.update(eligible('camera').map((s) => s.key));
    if (ndi) routeOutputs();
    if (live) {
      router?.sync();
      await onceInCall();
      if (settings.autoAdmit && waitingRequests().length) {
        const n = await admitWaiting('all');
        if (n) log('Auto-admitted waiting participant(s)');
      }
    }
  } finally {
    busy = false;
  }
}

// [participants-agent] Full roster from Meet's People panel (people without a tile, host/co-host, hands).
let roster: RosterEntry[] = [];
let rosterOpenTriedAt = 0;
function syncRoster(live: boolean): void {
  if (!live) {
    roster = [];
    return;
  }
  roster = scrapeRoster();
  // Keep the People panel open so off-screen participants are listed (retry if e.g. chat replaced it).
  if (!roster.length && Date.now() - rosterOpenTriedAt > 15000) {
    rosterOpenTriedAt = Date.now();
    if (ensurePeoplePanel()) log('Opened the People panel for the participant roster');
  }
}
function rosterRef(ref: string): RosterEntry | null {
  const base = ref.replace(/:screen$/, '');
  return roster.find((r) => r.participantId === base) ?? roster.find((r) => r.displayName.toLowerCase() === ref.toLowerCase()) ?? null;
}
/** Resolve a Command participant ref (key or name) to Meet's participant id + name. */
function personRef(ref: string): { id: string; name: string } | null {
  const s = sourceByRef(ref);
  if (s) return { id: s.participantId, name: s.displayName };
  const r = rosterRef(ref);
  return r ? { id: r.participantId, name: r.displayName } : null;
}
// [/participants-agent]

let inCallSince = 0;
function participants(): ParticipantState[] {
  const shownBy = new Map<string, string[]>();
  for (const p of outputs.values()) {
    const k = p.boundKey;
    if (k) shownBy.set(k, [...(shownBy.get(k) ?? []), p.id]);
  }
  return [...sources.values()]
    .filter((s) => s.hasName || s.tile)
    .map((s) => {
      const base = s.key.replace(/:screen$/, '');
      return {
        key: s.key,
        participantId: s.participantId,
        displayName: s.displayName,
        kind: s.kind,
        isSelf: s.isSelf,
        hasVideo: s.live,
        width: s.width,
        height: s.height,
        fps: s.fps(),
        muted: s.muted,
        handRaised: s.handRaised,
        level: speaker.level(base),
        speaking: speaker.speaking(base),
        outputs: shownBy.get(s.key) ?? [],
        // [participants-agent]
        ...rosterExtras(s.kind === 'camera' ? rosterRef(s.participantId) : null, s.tile),
      };
    })
    .map((p) => (p.kind === 'camera' ? withRosterState(p) : p))
    .concat(rosterOnly()); // [participants-agent]
}

// [participants-agent] roster → ParticipantState
function rosterExtras(r: RosterEntry | null, tile: HTMLElement | null): Partial<ParticipantState> {
  return {
    isHost: r?.isHost ?? false,
    isCohost: r?.isCohost ?? false,
    avatarUrl: r?.avatarUrl || undefined,
    ...(tile ? tilePinState(tile) : { pinned: false, spotlit: false }),
  };
}
function withRosterState(p: ParticipantState): ParticipantState {
  const r = rosterRef(p.participantId);
  if (!r) return p;
  return { ...p, muted: p.muted ?? r.muted, handRaised: p.handRaised || r.handRaised, isSelf: p.isSelf || r.isSelf };
}
function rosterOnly(): ParticipantState[] {
  const have = new Set([...sources.values()].filter((s) => s.kind === 'camera').map((s) => s.participantId));
  return roster
    .filter((r) => !have.has(r.participantId))
    .map((r) => ({
      key: r.participantId,
      participantId: r.participantId,
      displayName: r.displayName,
      kind: 'camera' as const,
      isSelf: r.isSelf,
      hasVideo: false,
      width: 0,
      height: 0,
      fps: 0,
      muted: r.muted,
      handRaised: r.handRaised,
      level: speaker.level(r.participantId),
      speaking: speaker.speaking(r.participantId),
      outputs: [],
      isHost: r.isHost,
      isCohost: r.isCohost,
      avatarUrl: r.avatarUrl || undefined,
      pinned: false,
      spotlit: false,
    }));
}
// [/participants-agent]

function report(): void {
  const { phase, detail } = meetingPhase();
  if (phase === 'in-call' && !inCallSince) inCallSince = Date.now();
  if (phase !== 'in-call') inCallSince = 0;
  const state: MeetState = {
    url: location.href,
    phase,
    phaseDetail: detail,
    inCall: inCall(),
    inCallSince,
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
    feeds: [],
    participants: phase === 'in-call' ? participants() : [],
    outputs: settings.outputs.map((c) => outputs.get(c.id)?.state()).filter((x): x is NonNullable<typeof x> => !!x),
    engine: settings.engine,
    activeSpeaker: speaker.activeSpeaker,
    waiting: phase === 'in-call' ? waitingRequests() : [],
    rxMbps: Number(document.documentElement?.dataset.gmeetIsoRxMbps ?? 0),
    mixLevel: router?.mixPeak ?? 0,
    audioOutputMeters: deviceRouter?.meters(), // [audio-agent]
    audioOutputChannels: deviceRouter?.channelCounts(), // [audio-agent]
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
      audioOutputs: devs.filter((d) => d.kind === 'audiooutput' && d.label).map((d) => d.label),
    };
    ipcRenderer.send(IPC.meetDevices, lists);
  } catch (e) {
    log(`device enumeration failed: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// commands (runtime-only; config changes arrive as settings)
// ---------------------------------------------------------------------------
function sourceByRef(ref: string): SourceTap | null {
  return sources.get(ref) ?? [...sources.values()].find((s) => s.displayName.toLowerCase() === ref.toLowerCase()) ?? null;
}

async function runCommand(c: Command): Promise<unknown> {
  switch (c.cmd) {
    case 'chat':
      return sendChat(c.text);
    case 'admit':
      return admitWaiting(c.who);
    case 'deny':
      return denyWaiting(c.who);
    case 'muteParticipant': {
      const s = sourceByRef(c.participant);
      if (s?.tile && (await muteParticipant(s.tile))) return true;
      const r = personRef(c.participant); // [participants-agent] roster fallback
      return r ? muteRosterParticipant(r.id) : false;
    }
    // [participants-agent] host / view actions (Meet DOM automation)
    case 'pin':
    case 'spotlight':
    case 'removeParticipant': {
      const r = personRef(c.participant);
      if (!r) throw new Error(`Could not find participant: ${c.participant}`);
      if (c.cmd === 'pin') return pinParticipant(r.id, r.name, c.on);
      if (c.cmd === 'spotlight') return spotlightParticipant(r.id, r.name, c.on);
      return removeParticipant(r.id, r.name);
    }
    case 'lowerHand': {
      if (!c.participant) return lowerHand();
      const r = personRef(c.participant);
      if (!r) throw new Error(`Could not find participant: ${c.participant}`);
      return lowerHand(r.id, r.name);
    }
    case 'muteAll':
      return muteAll();
    // [/participants-agent]
    case 'applyLayout':
      return applyTiledLayout(settings.maxTiles);
    case 'setCam':
      return setDevice('camera', c.on);
    case 'setMic':
      return setDevice('microphone', c.on);
    default:
      return null;
  }
}

function disposeAll(): void {
  for (const p of outputs.values()) p.dispose();
  outputs.clear();
  for (const s of sources.values()) s.dispose();
  sources.clear();
  router?.dispose();
  deviceRouter?.dispose(); // [audio-agent]
  botCam?.dispose();
}

export type { OutputConfig };

if (isMeet) {
  // Replace getUserMedia/enumerateDevices and observe RTC before Meet's scripts run.
  try {
    contextBridge.executeInMainWorld({ func: installMediaShim });
  } catch (e) {
    log(`media shim injection failed: ${(e as Error).message}`);
  }

  ipcRenderer.on(IPC.meetSettings, (_e, s: Settings) => {
    settings = s;
    applySettings();
  });
  ipcRenderer.on(IPC.meetCommand, async (_e, id: number, c: Command) => {
    let result: unknown = null;
    try {
      result = await runCommand(c);
    } catch (e) {
      result = { error: (e as Error).message };
    }
    ipcRenderer.send(IPC.meetCommand, id, result);
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
    router = new AudioRouter(onAudio, log);
    deviceRouter = new OutputDeviceRouter(log); // [audio-agent]
    void ipcRenderer.invoke(IPC.meetGetSettings).then((s: Settings) => {
      settings = s;
      applySettings();
    });
    window.setInterval(() => {
      tick().catch((e) => log(`tick error: ${(e as Error).message}`));
    }, 400);
    window.setInterval(report, 500);
    window.setInterval(() => {
      const c = getCamCanvas();
      void botThumb.maybe(c, c.width, c.height, settings.previewFps).then((j) => j && sendPreview(BOT_CAM_KEY, j));
    }, 1000 / 15);
    void reportDevices();
    navigator.mediaDevices.addEventListener('devicechange', () => void reportDevices());
  });
  window.addEventListener('pagehide', disposeAll);
} else if (isGoogle) {
  // accounts.google.com etc.: report so the UI knows we're signed out.
  window.addEventListener('DOMContentLoaded', () => {
    window.setInterval(report, 1000);
  });
}
