// Settings window building blocks: SettingHeader sections, grouped rows, info popovers and
// small bound controls. Every control commits straight to setSettings (the RE view models save on change).
import { h, icon, popup, toggle, popover, type Child } from '../kit';
import { store, setSettings } from '../store';
import { DEFAULT_SETTINGS, NESTED_SETTINGS_KEYS, NOT_IN_MEET, type OptionItem, type Settings } from '../../shared/types';

export { NOT_IN_MEET };

type Group = 'videoLoss' | 'recording' | 'autoAssign' | 'interface' | 'advancedAudio' | 'embeddedAudio' | 'osc';

/**
 * Fill groups/fields missing from an older main process (settings.json written before Phase 0) with
 * their defaults, so every category renders. main.ts does the same merge on load after a restart.
 */
export function normalizeSettings(): void {
  const cur = store.settings as unknown as Record<string, unknown>;
  const def = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  for (const k of Object.keys(def)) if (cur[k] === undefined) cur[k] = def[k];
  for (const k of NESTED_SETTINGS_KEYS) cur[k] = { ...(def[k] as object), ...((cur[k] as object) ?? {}) };
}

/** Patch one nested settings group (merged with its current value). */
export function patchGroup<K extends Group>(key: K, patch: Partial<Settings[K]>): Promise<void> {
  return setSettings({ [key]: { ...store.settings[key], ...patch } } as Partial<Settings>);
}

/** InfoPopover: ⓘ that shows a help sentence on hover (title) and click (popover). */
export function info(text: string): HTMLElement {
  const b = h('button.s-info', { title: text, type: 'button' }, icon('info'));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    popover(b, h('div.s-info-pop', text), { width: 280 });
  });
  return b;
}

export interface RowOpts {
  info?: string;
  disabled?: boolean;
  /** Tooltip; defaults to NOT_IN_MEET for disabled rows. */
  title?: string;
  cls?: string;
  /** Sub-row (indented, like "Apply ducking when"). */
  sub?: boolean;
}

/** One line of a grouped list: label (+ⓘ) on the left, control(s) on the right. */
export function row(label: Child, control: Child | Child[], o: RowOpts = {}): HTMLElement {
  const ctrls = Array.isArray(control) ? control : [control];
  const el = h('div.s-row', h('div.s-label', label, o.info ? info(o.info) : null), h('div.s-ctrl', ...ctrls));
  if (o.cls) el.className += ' ' + o.cls;
  if (o.sub) el.classList.add('sub');
  if (o.disabled) {
    el.classList.add('na');
    el.title = o.title ?? NOT_IN_MEET;
    el.querySelectorAll('input,select,button:not(.s-info),textarea').forEach((c) => ((c as HTMLInputElement).disabled = true));
  } else if (o.title) el.title = o.title;
  return el;
}

/** Same as row() but disabled with the standard "Not available in Google Meet" tooltip. */
export function naRow(label: Child, control: Child | Child[], o: Omit<RowOpts, 'disabled'> = {}): HTMLElement {
  return row(label, control, { ...o, disabled: true });
}

/** SettingHeaderViewModifier: bold section title (optional icon + subtitle) above a rounded group. */
export function section(title: string, rows: Child[], o: { icon?: string; subtitle?: string; cls?: string } = {}): HTMLElement {
  const head = o.icon
    ? h('div.s-head.with-icon', icon(o.icon), h('div', h('h2', title), o.subtitle ? h('p', o.subtitle) : null))
    : h('div.s-head', h('h2', title), o.subtitle ? h('p', o.subtitle) : null);
  const el = h('section.s-section', head, h('div.s-group', ...rows));
  if (o.cls) el.className += ' ' + o.cls;
  return el;
}

/** Inline (borderless, right-aligned) popup like the macOS settings pickers. */
export function pick<T extends string>(opts: OptionItem<T>[], value: T | string, onChange: (v: T) => void, disabled = false): HTMLElement {
  const p = popup(opts.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled })), String(value), (v) => onChange(v as T), { cls: 'inline', disabled });
  opts.forEach((o, i) => o.title && p.select.options[i] && (p.select.options[i].title = o.title));
  return p.el;
}

export function tog(value: boolean, onChange: (v: boolean) => void, disabled = false): HTMLElement {
  return toggle(value, onChange, { cls: 's-switch', disabled }).el;
}

/** macOS radio group ("○ vImage (Legacy)  ● Metal (Recommended)"). */
export function radios<T extends string>(items: { value: T; label: string; disabled?: boolean }[], value: T | string, onChange: (v: T) => void, disabled = false): HTMLElement {
  const name = 'r' + Math.random().toString(36).slice(2);
  return h(
    'div.s-radios',
    ...items.map((it) => {
      const inp = h('input', { type: 'radio', name }) as HTMLInputElement;
      inp.checked = it.value === value;
      inp.disabled = disabled || !!it.disabled;
      inp.addEventListener('change', () => inp.checked && onChange(it.value));
      return h('label.s-radio', inp, h('span', it.label));
    }),
  );
}

/** Right-aligned text field (OSC IP/ports, recording prefix …). Commits on change/Enter. */
export function field(value: string | number, onChange: (v: string) => void, o: { placeholder?: string; cls?: string; disabled?: boolean; mono?: boolean; live?: boolean } = {}): HTMLInputElement {
  const inp = h('input.s-field', { type: 'text', spellcheck: 'false', placeholder: o.placeholder }) as HTMLInputElement;
  if (o.cls) inp.className += ' ' + o.cls;
  inp.value = String(value);
  inp.disabled = !!o.disabled;
  inp.addEventListener(o.live ? 'input' : 'change', () => onChange(inp.value));
  inp.addEventListener('keydown', (e) => e.key === 'Enter' && inp.blur());
  return inp;
}

/** Small numeric field with clamping (e.g. "Low disk warning at [5] % free"). */
export function numField(value: number, onChange: (v: number) => void, o: { min?: number; max?: number; step?: number; suffix?: string; cls?: string; disabled?: boolean } = {}): HTMLElement {
  const inp = field(value, (v) => {
    let n = Number(v.replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n)) n = value;
    if (o.min !== undefined) n = Math.max(o.min, n);
    if (o.max !== undefined) n = Math.min(o.max, n);
    if (o.step) n = Math.round(n / o.step) * o.step;
    inp.value = String(n);
    onChange(n);
  }, { cls: 'num ' + (o.cls ?? ''), disabled: o.disabled });
  return o.suffix ? h('span.s-num', inp, h('span.s-suffix', o.suffix)) : inp;
}

/** ColorPicker well (capsule swatch over a native colour input). */
export function colorWell(value: string, onChange: (v: string) => void, disabled = false): HTMLElement {
  const inp = h('input', { type: 'color' }) as HTMLInputElement;
  inp.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  inp.disabled = disabled;
  const sw = h('span.s-swatch');
  sw.style.background = inp.value;
  inp.addEventListener('input', () => (sw.style.background = inp.value));
  inp.addEventListener('change', () => onChange(inp.value.toUpperCase()));
  return h('label.s-color' + (disabled ? '.na' : ''), inp, sw);
}

export function slider(value: number, min: number, max: number, step: number, onChange: (v: number) => void, o: { live?: (v: number) => void; ticks?: number; disabled?: boolean; cls?: string } = {}): HTMLInputElement {
  const inp = h('input.s-slider', { type: 'range', min: String(min), max: String(max), step: String(step) }) as HTMLInputElement;
  if (o.cls) inp.className += ' ' + o.cls;
  inp.value = String(value);
  inp.disabled = !!o.disabled;
  const paint = () => inp.style.setProperty('--p', `${((Number(inp.value) - min) / (max - min || 1)) * 100}%`);
  paint();
  inp.addEventListener('input', () => {
    paint();
    o.live?.(Number(inp.value));
  });
  inp.addEventListener('change', () => onChange(Number(inp.value)));
  return inp;
}

/** Segmented control (Low | Medium | High). */
export function seg<T extends string>(items: { value: T; label: string }[], value: T | string, onChange: (v: T) => void, cls = ''): HTMLElement {
  const el = h('div.s-seg' + (cls ? '.' + cls : ''));
  for (const it of items) {
    const b = h('button', { type: 'button' }, it.label);
    if (it.value === value) b.classList.add('active');
    b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      onChange(it.value);
    });
    el.append(b);
  }
  return el;
}

export function sbtn(label: Child, onClick: (e: MouseEvent) => void, o: { title?: string; disabled?: boolean; cls?: string } = {}): HTMLButtonElement {
  const b = h('button.s-btn', { type: 'button', title: o.title }, label) as HTMLButtonElement;
  if (o.cls) b.className += ' ' + o.cls;
  b.disabled = !!o.disabled;
  b.addEventListener('click', onClick);
  return b;
}

/** Local-only UI preferences that have no Settings field (kept in localStorage). */
export function localPref(key: string, def: boolean): { get(): boolean; set(v: boolean): void } {
  const k = 'gmeetIso.settings.' + key;
  return {
    get: () => (localStorage.getItem(k) ?? String(def)) === 'true',
    set: (v) => localStorage.setItem(k, String(v)),
  };
}
