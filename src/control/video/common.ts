// Shared pieces for the Video Outputs views (grid / list / previews):
// option builders, status readout, quick actions and the output ⋯ menu.

import { FORMAT_PRESETS, type OutputConfig, type OutputMode, type OutputState, type ParticipantState } from '../../shared/types';
import { button, confirmSheet, h, icon, menu, popover, promptSheet, textField, type OptList } from '../kit';
import { api, inCall, outputState, run, store, updateOutput } from '../store';

export const UNSUPPORTED = 'Not available with Google Meet';

// ---------------------------------------------------------------- mode
export const MODE_OPTS: OptList = [
  { value: 'participant', label: 'Participant' },
  { value: 'activeSpeaker', label: 'Active Speaker' },
  { value: 'screenshare', label: 'Screen Share' },
  { value: 'auto', label: 'Auto' },
];

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
      { value: '', label: kind === 'camera' ? '--' : 'Any Screen Share' },
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
  for (const d of displays) opts.push({ value: `d:${d.id}`, label: `NDI + ${d.label}${d.primary ? ' – Main' : ''}` });
  let value = 'ndi';
  if (cfg.display !== null && cfg.display !== undefined) {
    value = `d:${cfg.display}`;
    if (!displays.some((d) => d.id === cfg.display)) opts.push({ value, label: 'NDI + Display (disconnected)' });
  }
  return { opts: [...opts, { group: 'Not available with Google Meet', options: [
    { value: 'x-syphon', label: 'Syphon', disabled: true },
    { value: 'x-srt', label: 'SRT', disabled: true },
    { value: 'x-bmd', label: 'Blackmagic Desktop Video', disabled: true },
    { value: 'x-aja', label: 'AJA', disabled: true },
  ] }], value };
}
export function setDevice(cfg: OutputConfig, v: string): void {
  void updateOutput(cfg.id, { display: v.startsWith('d:') ? Number(v.slice(2)) : null });
}

export const FORMAT_OPTS: OptList = FORMAT_PRESETS.map((p, i) => ({ value: String(i), label: p.format ? p.label : 'Native' }));
export function formatValue(cfg: OutputConfig): string {
  const f = cfg.format;
  const i = FORMAT_PRESETS.findIndex((p) => (p.format === null ? f === null : !!f && p.format.width === f.width && p.format.height === f.height && p.format.fpsN === f.fpsN && p.format.fpsD === f.fpsD));
  return String(Math.max(0, i));
}
export function setFormat(cfg: OutputConfig, v: string): void {
  const p = FORMAT_PRESETS[Number(v)];
  if (p) void updateOutput(cfg.id, { format: p.format ? { ...p.format } : null });
}

export const AUDIO_OPTS: OptList = [
  { value: 'off', label: 'Off' },
  { value: 'iso', label: 'ISO' },
  { value: 'mix', label: 'Mix' },
];

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

// ---------------------------------------------------------------- quick actions (mic / video / chat / talk)
export function sourceParticipant(st: OutputState | undefined): ParticipantState | undefined {
  if (!st?.sourceKey) return undefined;
  const ps = store.state?.participants ?? [];
  const p = ps.find((x) => x.key === st.sourceKey);
  if (p && p.kind === 'screen') return ps.find((x) => x.participantId === p.participantId && x.kind === 'camera') ?? p;
  return p;
}

export function quickActions(getId: () => string, opts: { talk?: boolean; plain?: boolean } = {}) {
  const mk = (name: string, title: string) => {
    const b = h('button.icon-btn.vo-qa', { title }, icon(name)) as HTMLButtonElement;
    if (opts.plain) b.classList.add('plain');
    return b;
  };
  const mic = mk('mic', 'Mute participant');
  const cam = mk('video', 'Turning video off for others is not available with Google Meet');
  cam.disabled = true;
  const chat = mk('chat', 'Send chat message');
  mic.addEventListener('click', () => {
    const p = sourceParticipant(outputState(getId()));
    if (p) void run({ cmd: 'muteParticipant', participant: p.key });
  });
  chat.addEventListener('click', () => openChat(chat, sourceParticipant(outputState(getId()))));
  const talk = opts.talk ? (h('button.btn.sm.vo-talk', { title: `Talkback — ${UNSUPPORTED}`, disabled: true }, icon('headset'), 'Talk') as HTMLButtonElement) : null;
  const el = h('span.vo-qas', mic, cam, chat, talk);
  return {
    el,
    set(st: OutputState | undefined) {
      const p = sourceParticipant(st);
      const live = inCall();
      const muted = p?.muted === true;
      mic.disabled = !live || !p || p.isSelf || p.muted !== false;
      mic.title = !p ? 'No participant on this output' : muted ? `${p.displayName} is muted (Meet can't unmute others)` : p.muted === null ? 'Mic state unknown' : `Mute ${p.displayName} (requires host)`;
      const want = muted ? 'micSlash' : 'mic';
      if (mic.dataset.ico !== want) {
        mic.dataset.ico = want;
        mic.querySelector('.ico')!.innerHTML = icon(want).innerHTML;
      }
      mic.classList.toggle('muted', muted);
      const vidOff = !!p && p.kind === 'camera' && !p.hasVideo;
      cam.classList.toggle('muted', vidOff);
      chat.disabled = !live;
    },
  };
}

function openChat(anchor: HTMLElement, p: ParticipantState | undefined): void {
  const tf = textField('', () => {}, { placeholder: 'Message everyone' });
  tf.el.style.width = '100%';
  const send = async () => {
    const text = tf.el.value.trim();
    if (!text) return;
    const ok = await run({ cmd: 'chat', text });
    if (ok) close();
  };
  tf.el.addEventListener('keydown', (e) => e.key === 'Enter' && void send());
  const body = h('div.vo-chat',
    h('div', { style: 'font-weight:600' }, 'Send to everyone'),
    h('div.caption', p ? `Google Meet can't send private messages; ${p.displayName} and everyone else in the call will see this.` : 'Google Meet only supports messages to everyone in the call.'),
    tf.el,
    h('div', { style: 'display:flex;justify-content:flex-end' }, button('Send', () => void send(), 'primary')));
  const close = popover(anchor, body, { width: 280 });
  setTimeout(() => tf.el.focus(), 0);
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
  const v = await promptSheet('Rename Output', cfg.name, 'Rename');
  const name = v?.trim();
  if (name && name !== cfg.name) await updateOutput(cfg.id, { name });
}

export async function deleteOutput(cfg: OutputConfig): Promise<void> {
  if (await confirmSheet(`Delete “${cfg.name}”?`, 'The NDI source will stop and this output’s settings will be removed.', 'Delete', true)) {
    await run({ cmd: 'deleteOutput', output: cfg.id });
  }
}

export function outputMenu(anchor: HTMLElement, getCfg: () => OutputConfig | undefined): void {
  const cfg = getCfg();
  if (!cfg) return;
  menu(anchor, [
    { label: 'Duplicate', icon: 'copy', onClick: () => void duplicateOutput(cfg) },
    { label: 'Rename…', icon: 'pencil', onClick: () => void renameOutput(cfg) },
    { label: 'Output Effects…', icon: 'sliders', onClick: () => openEffects(cfg.id) },
    null,
    { label: 'Delete', icon: 'trash', destructive: true, onClick: () => void deleteOutput(cfg) },
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
