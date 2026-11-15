// Audio tab (RE AudioTab): output device sheet (CombinedAudioDeviceSheet) and
// AudioOutputsView (EmbeddedAudioOutputsTable + AudioOutputsTable per device).
// Routing runs in the Meet page (src/meet/audioRouting.ts); this file edits Settings only.
import { button, checkbox, h, icon, iconButton, popup, promptSheet, type OptList } from '../kit';
import { on, outputState, participants, setSettings, store, updateOutput } from '../store';
import {
  DEFAULT_ADVANCED_AUDIO,
  EMBEDDED_AUDIO_OPTIONS,
  type AudioChannelMode,
  type AudioOutputChannelConfig,
  type AudioOutputDeviceConfig,
  type AudioPan,
  type DeviceSortOrder,
  type OutputConfig,
} from '../../shared/types';

/** Mode labels as shown in the ZoomISO v3 Outputs table (page14). */
const MODE_OPTIONS: { value: AudioChannelMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'participant', label: 'Participant' },
  { value: 'output', label: 'Output' },
  { value: 'mixAll', label: 'Mix' },
  { value: 'mixOutputs', label: 'Mix of all outputs' },
  { value: 'mixUnassigned', label: 'Mix of all unassigned participants' },
  { value: 'screenshare', label: 'Active Share' },
  { value: 'activeSpeaker', label: 'Unique Speaker' },
];
const PAN_OPTIONS: { value: AudioPan; label: string }[] = [
  { value: 'both', label: 'Mono' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];
const GAIN_STEPS = [0, -3, -6, -9, -12, -18, -24];
const gainOptions = (cur: number): OptList => {
  const steps = GAIN_STEPS.includes(cur) ? GAIN_STEPS : [...GAIN_STEPS, cur].sort((a, b) => b - a);
  return steps.map((db) => ({ value: String(db), label: db === 0 ? '-0' : String(db) }));
};
const SORT_OPTIONS: { value: DeviceSortOrder; label: string }[] = [
  { value: 'alphabetical', label: 'A → Z' },
  { value: 'reverseAlphabetical', label: 'Z → A' },
  { value: 'manual', label: 'Manual' },
];
const MAX_DELAY_MS = 1000;

const collapsedEmbedded = new Set<string>();
const channelCountCache = new Map<string, number>();
/** Live meter elements, refreshed on every state update without re-rendering. */
let meters: { el: HTMLElement; get(): number }[] = [];

// Settings from an older main process may lack the Audio-tab fields.
const outDevs = (): string[] => store.settings.audioOutputDevices ?? [];

export function mountAudio(host: HTMLElement): void {
  host.classList.add('audio-tab');
  const toolbar = h('div.audio-toolbar');
  const body = h('div.audio-body');
  host.append(toolbar, body);

  let pending = false;
  const render = () => {
    // Don't rebuild under a field the operator is typing in / a slider being dragged.
    const ae = document.activeElement;
    if (ae && host.contains(ae) && ae instanceof HTMLInputElement && (ae.type === 'range' || ae.type === 'text')) {
      if (!pending) {
        pending = true;
        ae.addEventListener('blur', () => ((pending = false), render()), { once: true });
      }
      return;
    }
    renderToolbar(toolbar, render);
    const st = body.scrollTop;
    meters = [];
    try {
      body.replaceChildren(outputsView(render));
    } catch (e) {
      console.error('[audio]', e);
      body.replaceChildren(h('pre.au-empty', String((e as Error).stack ?? e)));
    }
    body.scrollTop = st;
    tickMeters();
  };
  on('settings', render);
  on('devices', render);
  let lastSig = '';
  on('state', () => {
    // Re-render when the participant list / device channel counts change; otherwise just meters.
    const s = store.state;
    const sig = JSON.stringify([participants().map((p) => p.key + p.displayName), s?.audioOutputChannels ?? {}]);
    if (sig !== lastSig) {
      lastSig = sig;
      growChannelsFromState();
      render();
    }
    tickMeters();
  });
  render();
}

function tickMeters(): void {
  for (const m of meters) {
    const l = Math.min(1, Math.sqrt(Math.max(0, m.get())));
    (m.el.firstElementChild as HTMLElement).style.width = `${Math.round(l * 100)}%`;
  }
}
function meter(get: () => number): HTMLElement {
  const el = h('div.au-meter', h('i'));
  meters.push({ el, get });
  return el;
}

// ---------------------------------------------------------------------------
// toolbar
// ---------------------------------------------------------------------------
function renderToolbar(el: HTMLElement, render: () => void): void {
  const add = button(h('span.bl', icon('plus'), 'Update Output Devices'), openDeviceSheet);
  const collapse = button(h('span.bl', icon('chevronDown', 'flip'), 'Collapse All'), () => void setAllCollapsed(true, render));
  const expand = button(h('span.bl', icon('chevronDown'), 'Expand All'), () => void setAllCollapsed(false, render));
  el.replaceChildren(h('div.l', add), h('div.r', collapse, expand));
}

async function setAllCollapsed(c: boolean, render: () => void): Promise<void> {
  for (const o of store.settings.outputs) c ? collapsedEmbedded.add(o.id) : collapsedEmbedded.delete(o.id);
  const cfg = { ...(store.settings.audioOutputConfig ?? {}) };
  for (const d of outDevs()) if (cfg[d]) cfg[d] = { ...cfg[d], collapsed: c };
  await setSettings({ audioOutputConfig: cfg });
  render();
}

// ---------------------------------------------------------------------------
// channel counts / defaults
// ---------------------------------------------------------------------------
async function probeChannels(label: string): Promise<number> {
  const live = store.state?.audioOutputChannels?.[label];
  if (live) return live;
  if (channelCountCache.has(label)) return channelCountCache.get(label)!;
  let n = 2;
  try {
    const dev = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audiooutput' && d.label === label);
    if (dev) {
      const ctx = new AudioContext() as AudioContext & { setSinkId(id: string): Promise<void> };
      await ctx.setSinkId(dev.deviceId);
      n = Math.max(1, Math.min(32, ctx.destination.maxChannelCount || 2));
      void ctx.close();
    }
  } catch {
    /* fall back to stereo */
  }
  channelCountCache.set(label, n);
  return n;
}

function defaultChannel(i: number): AudioOutputChannelConfig {
  const a = { ...DEFAULT_ADVANCED_AUDIO, ...(store.settings.advancedAudio ?? {}) };
  // Older settings may still carry the removed 'interpretation' mode.
  const mode: AudioChannelMode = MODE_OPTIONS.some((m) => m.value === a.defaultChannelMode) ? a.defaultChannelMode : 'none';
  return {
    name: '',
    mode,
    selection: '',
    pan: a.defaultPanPattern === 'stereo' ? (i % 2 === 0 ? 'left' : 'right') : 'both',
    gainDb: a.defaultGainDb,
    delayMs: Math.round((a.defaultDelaySeconds || 0) * 1000),
    visible: true,
  };
}

function deviceConfig(label: string, channels: number): AudioOutputDeviceConfig {
  const cur = store.settings.audioOutputConfig?.[label];
  const list = [...(cur?.channels ?? [])];
  while (list.length < channels) list.push(defaultChannel(list.length));
  return { collapsed: cur?.collapsed ?? false, channels: list };
}

/** Once the Meet page reports a device's real channel count, extend its channel list. */
function growChannelsFromState(): void {
  const live = store.state?.audioOutputChannels ?? {};
  const cfg = store.settings.audioOutputConfig ?? {};
  const patch: Record<string, AudioOutputDeviceConfig> = {};
  for (const [label, n] of Object.entries(live)) {
    if (!outDevs().includes(label)) continue;
    if ((cfg[label]?.channels.length ?? 0) < n) patch[label] = deviceConfig(label, n);
  }
  if (Object.keys(patch).length) void setSettings({ audioOutputConfig: { ...cfg, ...patch } });
}

function patchChannel(label: string, idx: number, patch: Partial<AudioOutputChannelConfig>): Promise<void> {
  const cfg = { ...(store.settings.audioOutputConfig ?? {}) };
  const dev = deviceConfig(label, idx + 1);
  dev.channels[idx] = { ...dev.channels[idx], ...patch };
  cfg[label] = dev;
  return setSettings({ audioOutputConfig: cfg });
}
function patchDevice(label: string, patch: Partial<AudioOutputDeviceConfig>): Promise<void> {
  const cfg = { ...(store.settings.audioOutputConfig ?? {}) };
  cfg[label] = { ...deviceConfig(label, 0), ...patch };
  return setSettings({ audioOutputConfig: cfg });
}

// ---------------------------------------------------------------------------
// Outputs view (AudioOutputsView)
// ---------------------------------------------------------------------------
function colHeader(): HTMLElement {
  return h('div.au-row.au-cols', ...['Channel', 'Mode', 'Selection', 'Pan', 'Gain Reduction', 'Delay', '', 'Meters'].map((t) => h('div', t)));
}

function sectionHeader(title: string, sub: string, collapsed: boolean, onToggle: () => void, right: Node[] = []): HTMLElement {
  const tri = h('button.au-tri', { title: collapsed ? `Expand ${title}` : `Collapse ${title}` }, collapsed ? '▶' : '▼');
  tri.addEventListener('click', onToggle);
  return h('div.au-head', tri, h('b', title), sub ? h('span.sub', sub) : null, h('div.sp'), ...right);
}

function embeddedMode(o: OutputConfig) {
  return o.useDefaultAudioMode ? (store.settings.embeddedAudio?.defaultMode ?? store.settings.defaultAudio ?? 'iso') : o.audio;
}

function delayCell(value: number, onCommit: (v: number) => void, disabled = false): HTMLElement[] {
  const range = h('input.au-slider', { type: 'range', min: '0', max: String(MAX_DELAY_MS), step: '1' }) as HTMLInputElement;
  range.value = String(value);
  const field = h('input.au-ms', { type: 'text', spellcheck: 'false' }) as HTMLInputElement;
  const show = (v: number) => {
    field.value = `${Math.round(v)} ms`;
    range.style.setProperty('--fill', `${(v / MAX_DELAY_MS) * 100}%`);
  };
  show(value);
  field.disabled = disabled;
  range.disabled = disabled;
  range.addEventListener('input', () => show(Number(range.value)));
  range.addEventListener('change', () => {
    onCommit(Number(range.value));
    range.blur();
  });
  field.addEventListener('focus', () => (field.value = String(parseInt(field.value) || 0)));
  field.addEventListener('keydown', (e) => e.key === 'Enter' && field.blur());
  field.addEventListener('change', () => {
    const v = Math.max(0, Math.min(MAX_DELAY_MS, parseInt(field.value) || 0));
    show(v);
    onCommit(v);
  });
  field.addEventListener('blur', () => show(parseInt(field.value) || 0));
  return [h('div', range), h('div', field)];
}

function embeddedTable(o: OutputConfig, render: () => void): HTMLElement {
  const collapsed = collapsedEmbedded.has(o.id);
  const sel = EMBEDDED_AUDIO_OPTIONS.find((x) => x.value === embeddedMode(o))?.label ?? '';
  const t = h(
    'div.au-table',
    sectionHeader(`${o.name} - NDI`, '(Embedded Audio)', collapsed, () => {
      collapsed ? collapsedEmbedded.delete(o.id) : collapsedEmbedded.add(o.id);
      render();
    }),
  );
  if (collapsed) return t;
  t.append(colHeader());
  const gainDb = Math.min(0, Math.round(o.audioGainDb || 0));
  (['Left', 'Right'] as const).forEach((pan, i) => {
    const gain = popup(gainOptions(gainDb), String(gainDb), (v) => void updateOutput(o.id, { audioGainDb: Number(v) }), { cls: 'sm au-gain' });
    t.append(
      h(
        'div.au-row',
        h('div', `Channel ${i + 1}`),
        h('div', 'Embedded Audio'),
        h('div', sel),
        h('div', pan),
        h('div', gain.el),
        ...delayCell(o.audioDelayMs || 0, (v) => void updateOutput(o.id, { audioDelayMs: v }), i === 1),
        h('div', meter(() => outputState(o.id)?.audioLevel ?? 0)),
      ),
    );
  });
  return t;
}

function selectionCell(label: string, idx: number, c: AudioOutputChannelConfig): HTMLElement {
  if (c.mode === 'participant') {
    const ps = participants().filter((p) => p.kind === 'camera');
    const opts: OptList = [{ value: '', label: 'Select Participant' }, ...ps.map((p) => ({ value: p.key, label: p.displayName || p.key }))];
    if (c.selection && !ps.some((p) => p.key === c.selection)) opts.push({ value: c.selection, label: `${c.selectionName || c.selection} (offline)` });
    return popup(opts, c.selection, (v) => void patchChannel(label, idx, { selection: v, selectionName: ps.find((p) => p.key === v)?.displayName ?? '' }), { cls: 'sm au-sel' }).el;
  }
  if (c.mode === 'output') {
    const opts: OptList = [{ value: '', label: 'Select Output' }, ...store.settings.outputs.map((o) => ({ value: o.id, label: o.name }))];
    return popup(opts, c.selection, (v) => void patchChannel(label, idx, { selection: v }), { cls: 'sm au-sel short' }).el;
  }
  return h('div');
}

function deviceTable(label: string): HTMLElement {
  const known = store.settings.audioOutputConfig?.[label];
  const dev = deviceConfig(label, known?.channels.length || channelCountCache.get(label) || store.state?.audioOutputChannels?.[label] || 2);
  if (!known) void patchDevice(label, dev);
  const missing = !store.devices.audioOutputs.includes(label);
  const eye = iconButton('eye', (e) => channelVisibilityMenu(e.currentTarget as HTMLElement, label, dev), 'Show or hide channels', 'au-ib');
  const x = iconButton('x', () => void setSettings({ audioOutputDevices: outDevs().filter((d) => d !== label) }), 'Remove', 'au-ib');
  const t = h(
    'div.au-table',
    sectionHeader(label, missing ? 'Device disconnected' : '', !!dev.collapsed, () => void patchDevice(label, { collapsed: !dev.collapsed }), [eye, x]),
  );
  if (dev.collapsed) return t;
  t.append(colHeader());
  const live = store.state?.audioOutputMeters?.[label];
  dev.channels.forEach((c, i) => {
    if (c.visible === false) return;
    const mode = popup(MODE_OPTIONS, c.mode, (v) => void patchChannel(label, i, { mode: v as AudioChannelMode, selection: '' }), { cls: 'sm au-mode' });
    const pan = popup(PAN_OPTIONS, c.pan, (v) => void patchChannel(label, i, { pan: v as AudioPan }), { cls: 'sm au-pan' });
    const gain = popup(gainOptions(c.gainDb), String(c.gainDb), (v) => void patchChannel(label, i, { gainDb: Number(v) }), { cls: 'sm au-gain' });
    const name = h('div.au-name', { title: 'Edit channel name (double-click)' }, c.name || `Channel ${i + 1}`);
    name.addEventListener('dblclick', async () => {
      const v = await promptSheet('Edit channel name', c.name || `Channel ${i + 1}`, 'Rename');
      if (v !== null) void patchChannel(label, i, { name: v.trim() === `Channel ${i + 1}` ? '' : v.trim() });
    });
    const inactive = live ? i >= live.length : false;
    t.append(
      h(
        'div.au-row',
        { class: inactive ? 'inactive' : '', title: inactive ? 'The device has fewer channels than this row' : undefined },
        name,
        h('div', mode.el),
        h('div', selectionCell(label, i, c)),
        h('div', pan.el),
        h('div', gain.el),
        ...delayCell(c.delayMs || 0, (v) => void patchChannel(label, i, { delayMs: v })),
        h('div', meter(() => store.state?.audioOutputMeters?.[label]?.[i] ?? 0)),
      ),
    );
  });
  return t;
}

/** RE DeviceChannelSelectionModal: choose which channels are shown. */
function channelVisibilityMenu(anchor: HTMLElement, label: string, dev: AudioOutputDeviceConfig): void {
  const r = anchor.getBoundingClientRect();
  const close = () => {
    layer.remove();
    pop.remove();
  };
  const layer = h('div.popover-layer');
  layer.addEventListener('mousedown', close);
  const rows = dev.channels.map((c, i) => checkbox(c.visible !== false, (v) => void patchChannel(label, i, { visible: v }), c.name || `Channel ${i + 1}`).el);
  const all = (v: boolean) => {
    close();
    void patchDevice(label, { channels: dev.channels.map((c) => ({ ...c, visible: v })) });
  };
  const pop = h(
    'div.au-pop',
    h('div.t', 'Device Channel'),
    h('div.list', ...rows),
    h('div.actions', button('Select All', () => all(true), 'sm'), button('Deselect All', () => all(false), 'sm')),
  );
  pop.style.top = `${r.bottom + 4}px`;
  pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  document.body.append(layer, pop);
}

function outputsView(render: () => void): HTMLElement {
  const wrap = h('div.au-view');
  const emb = store.settings.outputs.filter((o) => embeddedMode(o) !== 'off');
  for (const o of emb) wrap.append(embeddedTable(o, render));
  for (const d of outDevs()) wrap.append(deviceTable(d));
  if (!emb.length && !outDevs().length) wrap.append(h('div.au-empty', 'No audio devices configured'));
  wrap.append(
    h('div.au-foot', icon('info'), 'Per-participant audio is best effort: the Meet web client only receives the three loudest speakers. Active Share plays the meeting mix.'),
  );
  return wrap;
}

// ---------------------------------------------------------------------------
// CombinedAudioDeviceSheet
// ---------------------------------------------------------------------------
function openDeviceSheet(): void {
  const available = store.devices.audioOutputs;
  const enrolled = outDevs();
  let sort: DeviceSortOrder = store.settings.audioDeviceSortOrder ?? 'manual';
  const checked = new Set(enrolled);
  // Manual order: enrolled first (in table order), then the rest as Windows lists them.
  let order = [...enrolled.filter((d) => available.includes(d)), ...available.filter((d) => !enrolled.includes(d)), ...enrolled.filter((d) => !available.includes(d))];

  const list = h('div.ds-list');
  const counts = new Map<string, string>();
  const sorted = () =>
    sort === 'alphabetical' ? [...order].sort((a, b) => a.localeCompare(b)) : sort === 'reverseAlphabetical' ? [...order].sort((a, b) => b.localeCompare(a)) : order;
  let drag: string | null = null;
  const draw = () => {
    list.replaceChildren(
      ...sorted().map((d) => {
        const cb = checkbox(checked.has(d), (v) => (v ? checked.add(d) : checked.delete(d))).el;
        const row = h(
          'div.ds-row',
          { draggable: sort === 'manual' ? 'true' : 'false', class: available.includes(d) ? '' : 'missing' },
          h('span.grip', { title: sort === 'manual' ? 'Drag to reorder' : 'Set Sort by: Manual to reorder' }, '≡'),
          cb,
          h('span.nm', d, available.includes(d) ? null : h('span.sub', ' (disconnected)')),
          h('span.cnt', { dataset: { dev: d } }, counts.get(d) ?? ''),
        );
        row.addEventListener('dragstart', () => (drag = d));
        row.addEventListener('dragover', (e) => {
          if (!drag || drag === d) return;
          e.preventDefault();
          order.splice(order.indexOf(drag), 1);
          order.splice(order.indexOf(d), 0, drag);
          draw();
        });
        row.addEventListener('dragend', () => (drag = null));
        return row;
      }),
    );
  };
  draw();
  for (const d of order)
      void probeChannels(d).then((n) => {
        counts.set(d, `${n} output channel${n === 1 ? '' : 's'}`);
        for (const el of Array.from(list.querySelectorAll<HTMLElement>('.cnt'))) if (el.dataset.dev === d) el.textContent = counts.get(d)!;
      });

  const sortPop = popup(
    SORT_OPTIONS,
    sort,
    (v) => {
      sort = v as DeviceSortOrder;
      if (sort !== 'manual') order = sorted();
      draw();
    },
    { cls: 'ds-sort' },
  );
  const done = async (ok: boolean) => {
    layer.remove();
    if (!ok) return;
    const next = sorted().filter((d) => checked.has(d));
    const cfg = { ...(store.settings.audioOutputConfig ?? {}) };
    for (const d of next) if (!cfg[d]) cfg[d] = deviceConfig(d, await probeChannels(d));
    await setSettings({ audioOutputDevices: next, audioOutputConfig: cfg, audioDeviceSortOrder: sort });
  };
  const sheet = h(
    'div.sheet.ds-sheet',
    h('div.ds-title', h('h3', 'Select Output Audio Devices'), h('span.lbl', 'Sort by:'), sortPop.el),
    h('div.ds-cat', 'Windows Audio Devices'),
    available.length || order.length ? list : h('div.au-empty', 'No devices found'),
    h('div.actions', button('Cancel', () => void done(false)), button('Update', () => void done(true), 'primary')),
  );
  const layer = h('div.sheet-layer', sheet);
  layer.tabIndex = -1;
  layer.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Escape' && void done(false));
  document.body.append(layer);
  layer.focus();
}
