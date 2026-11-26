// Shared pieces for the Video Outputs views (grid / list / previews):
// option builders, status readout, quick actions and the output ⋯ menu.

import { EMBEDDED_AUDIO_OPTIONS, FORMAT_PRESETS, OUTPUT_MODE_OPTIONS, type OutputConfig, type OutputMode, type OutputState, type ParticipantState } from '../../shared/types';
import { confirmSheet, h, icon, menu, promptSheet, type OptList } from '../kit';
import { api, inCall, outputState, run, store, updateOutput } from '../store';


// ---------------------------------------------------------------- mode
export const MODE_OPTS: OptList = OUTPUT_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

export function setMode(cfg: OutputConfig, mode: OutputMode): void {
  const patch: Partial<OutputConfig> = { mode };
  const isScreen = !!cfg.selection?.key.endsWith(':screen');
  if (mode === 'participant' && isScreen) patch.selection = null;
  if (mode === 'screenshare' && cfg.selection && !isScreen) patch.selection = null;
  void updateOutput(cfg.id, patch);
}

// ---------------------------------------------------------------- selection
function roster(kind: 'camera' | 'screen'): ParticipantState[] {
  const includeSelf = store.settings.includeSelf;
  return (store.state?.participants ?? []).filter((p) => p.kind === kind && (includeSelf || !p.isSelf));
}

/** Options for the Selection popup (depends on the output's mode). */
export function selectionModel(cfg: OutputConfig, st: OutputState | undefined): { opts: OptList; value: string; disabled: boolean } {
  if (cfg.mode === 'participant' || cfg.mode === 'screenshare') {
    const kind = cfg.mode === 'participant' ? 'camera' : 'screen';
    const list = roster(kind);
    const opts: { value: string; label: string; disabled?: boolean }[] = [
      { value: '', label: kind === 'camera' ? '--' : 'Any screen share' },
    ];
    for (const p of list) opts.push({ value: p.key, label: kind === 'screen' ? p.displayName.replace(/\s*\(presentation\)$/i, '') : p.displayName });
    let value = '';
    const sel = cfg.selection;
    if (sel) {
      const hit = list.find((p) => p.key === sel.key) ?? list.find((p) => p.displayName === sel.name);
      if (hit) value = hit.key;
      else {
        value = sel.key;
        opts.push({ value: sel.key, label: `${sel.name || sel.key} (offline)` });
      }
    }
    return { opts, value, disabled: false };
  }
  // Active speaker / auto: the app decides; show who is on it, read-only.
  const label = st?.sourceName || '--';
  return { opts: [{ value: '', label }], value: '', disabled: true };
}

export function setSelection(cfg: OutputConfig, key: string): void {
  if (!key) void updateOutput(cfg.id, { selection: null });
  else void run({ cmd: 'route', output: cfg.id, participant: key });
}

// ---------------------------------------------------------------- output device / format / audio
export function deviceModel(cfg: OutputConfig): { opts: OptList; value: string } {
  const displays = store.system?.displays ?? [];
  const opts: { value: string; label: string }[] = [{ value: 'ndi', label: 'NDI' }];
  for (const d of displays) opts.push({ value: `d:${d.id}`, label: `NDI + ${d.label}${d.primary ? ' (Main)' : ''}` });
  let value = 'ndi';
  if (cfg.display !== null && cfg.display !== undefined) {
    value = `d:${cfg.display}`;
    if (!displays.some((d) => d.id === cfg.display)) opts.push({ value, label: 'NDI + Display (disconnected)' });
  }
  return { opts, value };
}
export function setDevice(cfg: OutputConfig, v: string): void {
  void updateOutput(cfg.id, { display: v.startsWith('d:') ? Number(v.slice(2)) : null });
}

export const FORMAT_OPTS: OptList = FORMAT_PRESETS.map((p, i) => ({ value: String(i), label: p.label }));
export function formatValue(cfg: OutputConfig): string {
  const f = cfg.format;
  const i = FORMAT_PRESETS.findIndex((p) => (p.format === null ? f === null : !!f && p.format.width === f.width && p.format.height === f.height && p.format.fpsN === f.fpsN && p.format.fpsD === f.fpsD));
  return String(Math.max(0, i));
}
export function setFormat(cfg: OutputConfig, v: string): void {
  const p = FORMAT_PRESETS[Number(v)];
  if (p) void updateOutput(cfg.id, { format: p.format ? { ...p.format } : null });
}

export const AUDIO_OPTS: OptList = EMBEDDED_AUDIO_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

// ---------------------------------------------------------------- status readout
export type StatusKind = 'ok' | 'warn' | 'none';
export function statusModel(cfg: OutputConfig, st: OutputState | undefined): { kind: StatusKind; text: string } {
  if (!cfg.enabled) return { kind: 'none', text: 'Output disabled' };
  if (!st || st.status === 'off') return { kind: 'none', text: store.settings.engine === 'disabled' ? 'Capture disabled' : 'Starting…' };
  const hasIn = st.inWidth > 0 && st.inHeight > 0;
  const res = hasIn ? `${st.inWidth} x ${st.inHeight} - ${st.inFps.toFixed(1)} fps in` : '';
  if (st.status === 'standby') return { kind: 'none', text: res || 'Standby' };
  if (!st.sourceKey) return { kind: 'none', text: cfg.mode === 'screenshare' ? 'No screen share' : 'No source' };
  if (st.status === 'loss' || !hasIn) return { kind: 'warn', text: res ? `${res} (loss)` : 'Video loss' };
  const f = cfg.format;
  const below = !!f && (st.inHeight < f.height || st.inFps < (f.fpsN / f.fpsD) * 0.8);
  return { kind: below ? 'warn' : 'ok', text: res };
}

/** Status line element with in-place update. */
export function statusLine() {
  const ico = icon('checkCircle');
  ico.classList.add('vo-st-ico');
  const txt = h('span');
  const el = h('span.status-line.vo-status', ico, txt);
  let lastKind = '';
  return {
    el,
    set(cfg: OutputConfig, st: OutputState | undefined) {
      const m = statusModel(cfg, st);
      if (m.kind !== lastKind) {
        lastKind = m.kind;
        el.dataset.kind = m.kind;
        ico.innerHTML = icon(m.kind === 'warn' ? 'warn' : m.kind === 'ok' ? 'checkCircle' : 'info').innerHTML;
      }
      if (txt.textContent !== m.text) txt.textContent = m.text;
      el.title = st?.sourceName ? `Source: ${st.sourceName}${st.latencyMs ? ` · ${st.latencyMs.toFixed(0)} ms` : ''}` : '';
    },
  };
}

// ---------------------------------------------------------------- quick actions (mic mute)
export function sourceParticipant(st: OutputState | undefined): ParticipantState | undefined {
  if (!st?.sourceKey) return undefined;
  const ps = store.state?.participants ?? [];
  const p = ps.find((x) => x.key === st.sourceKey);
  if (p && p.kind === 'screen') return ps.find((x) => x.participantId === p.participantId && x.kind === 'camera') ?? p;
  return p;
}

export function quickActions(getId: () => string) {
  const mk = (name: string, title: string) => h('button.icon-btn.vo-qa', { title }, icon(name)) as HTMLButtonElement;
  const mic = mk('mic.outline', 'Mute participant');
  mic.addEventListener('click', () => {
    const p = sourceParticipant(outputState(getId()));
    if (p) void run({ cmd: 'muteParticipant', participant: p.key });
  });
  const el = h('span.vo-qas', mic);
  return {
    el,
    set(st: OutputState | undefined) {
      const p = sourceParticipant(st);
      const muted = p?.muted === true;
      mic.disabled = !inCall() || !p || p.isSelf || p.muted !== false;
      mic.title = !p
        ? 'Please assign a participant to the stream'
        : muted
          ? `${p.displayName} is muted`
          : p.muted === null ? 'Mic state unknown' : `Mute ${p.displayName} (requires host)`;
      const want = muted ? 'mic.slash.outline' : 'mic.outline';
      if (mic.dataset.ico !== want) {
        mic.dataset.ico = want;
        mic.replaceChildren(icon(want));
      }
      mic.classList.toggle('muted', muted);
    },
  };
}

// ---------------------------------------------------------------- output actions
export function openEffects(id: string): void {
  void api.openWindow('effects', id);
}

export async function duplicateOutput(cfg: OutputConfig): Promise<void> {
  const { id: _id, ...rest } = structuredClone(cfg);
  const names = new Set(store.settings.outputs.map((o) => o.name));
  let name = `${cfg.name} copy`;
  for (let i = 2; names.has(name); i++) name = `${cfg.name} copy ${i}`;
  await run({ cmd: 'addOutput', patch: { ...rest, name, record: false } });
}

export async function renameOutput(cfg: OutputConfig): Promise<void> {
  const v = await promptSheet('Rename output', cfg.name, 'Rename');
  const name = v?.trim();
  if (name && name !== cfg.name) await updateOutput(cfg.id, { name });
}

export async function deleteOutput(cfg: OutputConfig): Promise<void> {
  if (await confirmSheet(`Are you sure you want to delete "${cfg.name}"?`, 'The NDI source will stop and this output’s settings will be removed.', 'Delete', true)) {
    await run({ cmd: 'deleteOutput', output: cfg.id });
  }
}

export function outputMenu(anchor: HTMLElement, getCfg: () => OutputConfig | undefined): void {
  const cfg = getCfg();
  if (!cfg) return;
  menu(anchor, [
    { label: 'Duplicate', icon: 'copy', onClick: () => void duplicateOutput(cfg) },
    { label: 'Rename', icon: 'pencil', onClick: () => void renameOutput(cfg) },
    { label: 'Output effects', icon: 'sliders', onClick: () => openEffects(cfg.id) },
    null,
    { label: 'Delete output', icon: 'trash', destructive: true, onClick: () => void deleteOutput(cfg) },
  ]);
}

export function addOutput(): void {
  void run({ cmd: 'addOutput' });
}

export function cfgById(id: string): OutputConfig | undefined {
  return store.settings.outputs.find((o) => o.id === id);
}

/** Generic keyed reconciler: keeps one view object per output id, in settings order. */
export function reconcile<T extends { el: HTMLElement; destroy(): void }>(
  parent: HTMLElement,
  views: Map<string, T>,
  outputs: OutputConfig[],
  create: (cfg: OutputConfig, index: number) => T,
  before: Node | null = null,
): void {
  const want = new Set(outputs.map((o) => o.id));
  for (const [id, v] of views) {
    if (!want.has(id)) {
      v.destroy();
      v.el.remove();
      views.delete(id);
    }
  }
  outputs.forEach((cfg, i) => {
    let v = views.get(cfg.id);
    if (!v) {
      v = create(cfg, i);
      views.set(cfg.id, v);
    }
    const at = parent.children[i] ?? null;
    if (at !== v.el) parent.insertBefore(v.el, at ?? before);
  });
  if (before && before.parentNode === parent && parent.lastChild !== before) parent.append(before);
}
