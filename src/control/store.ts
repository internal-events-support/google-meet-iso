// Shared client-side store for every control window (main app, settings, effects, perf).
// Wraps window.gmeetIso (control/preload.ts) with pub/sub so tabs stay decoupled.

import type { Command, ControlApi, DeviceLists, MeetState, OutputConfig, Settings, SystemStats } from '../shared/types';

export const api = (window as unknown as { gmeetIso: ControlApi }).gmeetIso;

type Topic = 'settings' | 'state' | 'devices' | 'system' | 'log' | 'ndi';
const subs = new Map<Topic, Set<() => void>>();

export const store = {
  settings: null as unknown as Settings,
  state: null as MeetState | null,
  devices: { videoInputs: [], audioInputs: [], audioOutputs: [] } as DeviceLists,
  system: null as SystemStats | null,
  ndiSources: [] as string[],
  log: [] as string[],
};

export function on(topic: Topic, fn: () => void): () => void {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic)!.add(fn);
  return () => subs.get(topic)?.delete(fn);
}

function emit(topic: Topic): void {
  for (const fn of subs.get(topic) ?? []) {
    try {
      fn();
    } catch (e) {
      console.error(`[${topic}]`, e);
    }
  }
}

// ---------------- previews (JPEG blobs keyed by output id / src:<key> / __botcam__) ----------------
const previewUrls = new Map<string, string>();
const previewSubs = new Map<string, Set<(url: string) => void>>();

/** Subscribe an <img> (or callback) to a preview key. Returns unsubscribe. */
export function bindPreview(key: string, target: HTMLImageElement | ((url: string) => void)): () => void {
  const fn = typeof target === 'function' ? target : (url: string) => (target.src = url);
  if (!previewSubs.has(key)) previewSubs.set(key, new Set());
  previewSubs.get(key)!.add(fn);
  const cur = previewUrls.get(key);
  if (cur) fn(cur);
  return () => previewSubs.get(key)?.delete(fn);
}

export function previewUrl(key: string): string | undefined {
  return previewUrls.get(key);
}

// ---------------- commands ----------------
/** Run a Command (same set as OSC/HTTP). Logs failures; returns the result. */
export async function run(c: Command): Promise<unknown> {
  const r = (await api.command(c)) as { ok: boolean; result?: unknown; error?: string };
  if (!r.ok) {
    pushLog(`✖ ${c.cmd}: ${r.error}`);
    return undefined;
  }
  return r.result;
}

export function updateOutput(id: string, patch: Partial<OutputConfig>): Promise<unknown> {
  return run({ cmd: 'updateOutput', output: id, patch });
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  store.settings = await api.setSettings(patch);
  emit('settings');
}

export async function refreshNdi(): Promise<void> {
  store.ndiSources = await api.ndiSources();
  emit('ndi');
}

function pushLog(line: string): void {
  store.log.push(line);
  if (store.log.length > 2000) store.log.splice(0, store.log.length - 2000);
  emit('log');
}

/** Query-string argument a secondary window was opened with (e.g. the output id for Effects). */
export function windowArg(): string {
  return new URLSearchParams(location.search).get('arg') ?? '';
}

// ---------------- init ----------------
let started: Promise<void> | null = null;
export function initStore(): Promise<void> {
  if (started) return started;
  started = (async () => {
    store.settings = await api.getSettings();
    store.devices = await api.devices();
    store.system = await api.system();
    store.log = await api.logs();
    api.onSettings((s) => {
      store.settings = s;
      emit('settings');
    });
    api.onState((s) => {
      store.state = s;
      emit('state');
    });
    api.onDevices((d) => {
      store.devices = d;
      emit('devices');
    });
    api.onSystem((s) => {
      store.system = s;
      emit('system');
    });
    api.onLog(pushLog);
    api.onPreview((key, jpeg) => {
      const url = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
      const old = previewUrls.get(key);
      previewUrls.set(key, url);
      for (const fn of previewSubs.get(key) ?? []) fn(url);
      if (old) setTimeout(() => URL.revokeObjectURL(old), 1500);
    });
    void refreshNdi();
    setInterval(() => void refreshNdi(), 10000);
  })();
  return started;
}

// ---------------- derived helpers ----------------
export function outputState(id: string) {
  return store.state?.outputs.find((o) => o.id === id);
}

export function participants(includeSelf = store.settings?.includeSelf ?? false) {
  return (store.state?.participants ?? []).filter((p) => includeSelf || !p.isSelf);
}

export function inCall(): boolean {
  return store.state?.phase === 'in-call';
}
