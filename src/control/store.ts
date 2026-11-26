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

/** The element each subscriber shows the preview in: the key only counts as wanted while it's visible. */
const previewEls = new Map<unknown, Element>();

/**
 * Subscribe an <img> (or callback) to a preview key. Returns unsubscribe. Pass `el` (the element
 * the callback shows the preview in) so the preview is only produced while that element is visible.
 */
export function bindPreview(key: string, target: HTMLImageElement | ((url: string) => void), el?: Element): () => void {
  const fn = typeof target === 'function' ? target : (url: string) => (target.src = url);
  const shown = typeof target === 'function' ? el : target;
  if (shown) previewEls.set(fn, shown);
  if (!previewSubs.has(key)) previewSubs.set(key, new Set());
  previewSubs.get(key)!.add(fn);
  const cur = previewUrls.get(key);
  if (cur) fn(cur);
  queueSyncPreviewKeys();
  return () => {
    previewSubs.get(key)?.delete(fn);
    previewEls.delete(fn);
    queueSyncPreviewKeys();
  };
}

/**
 * Canvas previews for fast-changing images: each JPEG is decoded off-thread (createImageBitmap)
 * and handed to a 'bitmaprenderer' canvas, which shows it without re-rasterising the page (an
 * <img> src swap per frame made the GPU process re-raster, which at high preview rates slowed
 * the whole video pipeline). `onFrame` runs after each new frame is shown.
 */
interface CanvasSub {
  canvas: HTMLCanvasElement;
  ctx: ImageBitmapRenderingContext;
  onFrame?: () => void;
}
const canvasSubs = new Map<string, Set<CanvasSub>>();
const lastJpeg = new Map<string, ArrayBuffer>();
/** Keys whose decode is in flight / the newest JPEG that arrived meanwhile (latest wins). */
const decoding = new Set<string>();
const queuedJpeg = new Map<string, ArrayBuffer>();

export function bindPreviewCanvas(key: string, canvas: HTMLCanvasElement, onFrame?: () => void): () => void {
  const ctx = canvas.getContext('bitmaprenderer');
  if (!ctx) return () => {};
  const sub: CanvasSub = { canvas, ctx, onFrame };
  if (!canvasSubs.has(key)) canvasSubs.set(key, new Set());
  canvasSubs.get(key)!.add(sub);
  previewEls.set(sub, canvas);
  const last = lastJpeg.get(key);
  if (last) void showOn(key, last, [sub]);
  queueSyncPreviewKeys();
  return () => {
    canvasSubs.get(key)?.delete(sub);
    previewEls.delete(sub);
    queueSyncPreviewKeys();
  };
}

async function showOn(key: string, jpeg: ArrayBuffer, subs: Iterable<CanvasSub>): Promise<void> {
  for (const sub of subs) {
    try {
      const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      if (!canvasSubs.get(key)?.has(sub)) {
        bmp.close();
        continue;
      }
      // The canvas keeps its own size (default 300×150) for layout/object-fit: match the frame.
      if (sub.canvas.width !== bmp.width || sub.canvas.height !== bmp.height) {
        sub.canvas.width = bmp.width;
        sub.canvas.height = bmp.height;
      }
      sub.ctx.transferFromImageBitmap(bmp);
      sub.onFrame?.();
    } catch {
      /* undecodable frame: keep the previous one */
    }
  }
}

function showCanvases(key: string, jpeg: ArrayBuffer): void {
  lastJpeg.set(key, jpeg);
  const subs = canvasSubs.get(key);
  if (!subs?.size) return;
  if (decoding.has(key)) {
    queuedJpeg.set(key, jpeg);
    return;
  }
  decoding.add(key);
  void showOn(key, jpeg, [...subs]).finally(() => {
    decoding.delete(key);
    const next = queuedJpeg.get(key);
    queuedJpeg.delete(key);
    if (next) showCanvases(key, next);
  });
}

function isShown(el: Element | undefined): boolean {
  return !el || (el.isConnected && (el.checkVisibility ? el.checkVisibility() : (el as HTMLElement).offsetParent !== null));
}

/** Keys with a visible subscriber (callbacks always count) while this window is visible. */
function wantedPreviewKeys(): string[] {
  if (document.visibilityState !== 'visible') return [];
  const out: string[] = [];
  for (const key of new Set([...previewSubs.keys(), ...canvasSubs.keys()])) {
    const subs: unknown[] = [...(previewSubs.get(key) ?? []), ...(canvasSubs.get(key) ?? [])];
    if (subs.some((sub) => isShown(previewEls.get(sub)))) out.push(key);
  }
  return out.sort();
}

let sentPreviewKeys: string | null = null;
let previewSyncQueued = false;
function syncPreviewKeys(): void {
  previewSyncQueued = false;
  const keys = wantedPreviewKeys();
  const sig = keys.join('\n');
  if (sig === sentPreviewKeys) return;
  sentPreviewKeys = sig;
  api.setPreviewKeys?.(keys);
}
function queueSyncPreviewKeys(): void {
  if (previewSyncQueued) return;
  previewSyncQueued = true;
  setTimeout(syncPreviewKeys, 50);
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
      showCanvases(key, jpeg);
      // Blob URLs only for <img>/callback subscribers (and previewUrl()).
      if (!previewSubs.get(key)?.size) return;
      const url = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
      const old = previewUrls.get(key);
      previewUrls.set(key, url);
      for (const fn of previewSubs.get(key) ?? []) fn(url);
      if (old) setTimeout(() => URL.revokeObjectURL(old), 1500);
    });
    void refreshNdi();
    setInterval(() => void refreshNdi(), 10000);
    // Tabs/drawers show and hide preview elements without unsubscribing: re-check visibility.
    setInterval(syncPreviewKeys, 500);
    document.addEventListener('visibilitychange', syncPreviewKeys);
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
