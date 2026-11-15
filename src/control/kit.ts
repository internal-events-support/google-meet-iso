// UI kit: DOM helpers, macOS-style controls and SF-Symbols-like icons.
// All control windows build their UI from these so every page matches.

export type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>>;
};

/** h('div.card.big', {title:'x'}, child, ...) — tag with optional .classes / #id. */
export function h<K extends keyof HTMLElementTagNameMap>(sel: K | string, attrs?: Attrs | Child, ...children: Child[]): HTMLElementTagNameMap[K] {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel) ?? [];
  const el = document.createElement((m[1] || 'div') as K);
  for (const part of (m[2] ?? '').match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node)) {
    children.unshift(attrs as Child);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + String(v);
      else if (k === 'style') typeof v === 'string' ? el.setAttribute('style', v) : Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
      else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) el.addEventListener(ev, fn);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------------------
// Icons (SF Symbols look-alikes, 16×16 viewBox, currentColor)
// ---------------------------------------------------------------------------
const S = (d: string, extra = '') => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const F = (d: string) => `<svg viewBox="0 0 16 16" fill="currentColor">${d}</svg>`;
export const ICONS: Record<string, string> = {
  gear: S('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4"/><circle cx="8" cy="8" r="4.6"/>'),
  gearFill: F('<path d="M9.4 1.2l.4 1.6c.4.1.8.3 1.1.5l1.5-.8 1.2 1.2-.8 1.5c.2.3.4.7.5 1.1l1.6.4v1.7l-1.6.4c-.1.4-.3.8-.5 1.1l.8 1.5-1.2 1.2-1.5-.8c-.3.2-.7.4-1.1.5l-.4 1.6H7.7l-.4-1.6c-.4-.1-.8-.3-1.1-.5l-1.5.8-1.2-1.2.8-1.5c-.2-.3-.4-.7-.5-1.1l-1.6-.4V7.4l1.6-.4c.1-.4.3-.8.5-1.1l-.8-1.5 1.2-1.2 1.5.8c.3-.2.7-.4 1.1-.5l.4-1.6h1.7zM8.5 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"/>'),
  record: S('<circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>'),
  sliders: S('<path d="M2 4h12M2 8h12M2 12h12"/><circle cx="10.5" cy="4" r="1.4" fill="var(--panel,#2b2b2b)"/><circle cx="5.5" cy="8" r="1.4" fill="var(--panel,#2b2b2b)"/><circle cx="9" cy="12" r="1.4" fill="var(--panel,#2b2b2b)"/>'),
  ellipsis: F('<circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/>'),
  plus: S('<path d="M8 3v10M3 8h10"/>'),
  minus: S('<path d="M3 8h10"/>'),
  x: S('<path d="M4 4l8 8M12 4l-8 8"/>'),
  check: S('<path d="m3.5 8.5 3 3 6-7"/>'),
  checkCircle: F('<path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm3.1 4.3a.7.7 0 0 0-1 .1L7.2 9.2 5.8 7.8a.7.7 0 1 0-1 1l2 2a.7.7 0 0 0 1-.1l3.4-4.4a.7.7 0 0 0-.1-1z"/>'),
  warn: F('<path d="M8.9 1.9a1 1 0 0 0-1.8 0L1.2 12.5A1 1 0 0 0 2.1 14h11.8a1 1 0 0 0 .9-1.5L8.9 1.9zM8 5c.4 0 .7.3.7.7v3.6a.7.7 0 0 1-1.4 0V5.7c0-.4.3-.7.7-.7zm0 7.4a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8z"/>'),
  info: S('<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4M8 4.8v.1"/>'),
  mic: S('<rect x="5.8" y="1.8" width="4.4" height="8" rx="2.2"/><path d="M3.5 7.8a4.5 4.5 0 0 0 9 0M8 12.3v2"/>'),
  micSlash: S('<rect x="5.8" y="1.8" width="4.4" height="8" rx="2.2"/><path d="M3.5 7.8a4.5 4.5 0 0 0 9 0M8 12.3v2M2 2l12 12" />'),
  video: S('<rect x="1.6" y="4" width="9" height="8" rx="1.6"/><path d="m10.6 7 3.8-2.2v6.4L10.6 9"/>'),
  videoSlash: S('<rect x="1.6" y="4" width="9" height="8" rx="1.6"/><path d="m10.6 7 3.8-2.2v6.4L10.6 9M1.5 2l12 12"/>'),
  chat: S('<path d="M2.2 3.5c0-.8.7-1.5 1.5-1.5h8.6c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5H6.5L3.5 13.8V11h.2c-.8 0-1.5-.7-1.5-1.5v-6z"/>'),
  headset: S('<path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2"/><rect x="2" y="9" width="3" height="4.5" rx="1"/><rect x="11" y="9" width="3" height="4.5" rx="1"/>'),
  grid: F('<rect x="2" y="2" width="5.3" height="5.3" rx="1"/><rect x="8.7" y="2" width="5.3" height="5.3" rx="1"/><rect x="2" y="8.7" width="5.3" height="5.3" rx="1"/><rect x="8.7" y="8.7" width="5.3" height="5.3" rx="1"/>'),
  list: S('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.6" cy="4" r=".6" fill="currentColor"/><circle cx="2.6" cy="8" r=".6" fill="currentColor"/><circle cx="2.6" cy="12" r=".6" fill="currentColor"/>'),
  previews: S('<rect x="1.8" y="3" width="12.4" height="10" rx="1.5"/><path d="M8 3v10M1.8 8h12.4"/>'),
  preview: S('<rect x="1.8" y="3" width="12.4" height="10" rx="1.5"/><path d="m6.5 6 3.5 2-3.5 2z" fill="currentColor"/>'),
  person: F('<circle cx="8" cy="5" r="3"/><path d="M2.5 14c0-3 2.5-5 5.5-5s5.5 2 5.5 5z"/>'),
  personSquare: F('<path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm5 2.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM4.5 12.5h7c0-2-1.6-3-3.5-3s-3.5 1-3.5 3z"/>'),
  people: F('<circle cx="5.5" cy="5" r="2.3"/><circle cx="11" cy="5.6" r="1.9"/><path d="M1 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4zM10.6 13.5c0-1.4-.5-2.6-1.4-3.4.6-.3 1.2-.4 1.8-.4 2.1 0 3.9 1.3 3.9 3.8z"/>'),
  screen: S('<rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.2"/><path d="M5.5 14h5M8 11v3"/>'),
  share: S('<rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.2"/><path d="M8 9V5M6 7l2-2 2 2M5.5 14h5"/>'),
  speaker: S('<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/>'),
  waveform: S('<path d="M2 8h1M4.5 5v6M7 3v10M9.5 5.5v5M12 6.5v3M14 8h.5"/>'),
  chevronDown: S('<path d="m4 6 4 4 4-4"/>'),
  chevronRight: S('<path d="m6 4 4 4-4 4"/>'),
  chevronUpDown: S('<path d="m5 6 3-3 3 3M5 10l3 3 3-3"/>'),
  eye: S('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  eyeSlash: S('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2 2l12 12"/>'),
  folder: S('<path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/>'),
  refresh: S('<path d="M13.5 8A5.5 5.5 0 1 1 11.8 4M13.5 2v3.3h-3.3"/>'),
  search: S('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>'),
  monitor: S('<rect x="1.5" y="2.5" width="13" height="9" rx="1.2"/><path d="M5 14h6"/>'),
  videoCam: F('<path d="M2.5 4h7a1.5 1.5 0 0 1 1.5 1.5V6l3-1.8v7.6L11 10v.5A1.5 1.5 0 0 1 9.5 12h-7A1.5 1.5 0 0 1 1 10.5v-5A1.5 1.5 0 0 1 2.5 4z"/>'),
  plusSquare: F('<path d="M3.5 1.5h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM8 4.5a.8.8 0 0 0-.8.8v1.9H5.3a.8.8 0 0 0 0 1.6h1.9v1.9a.8.8 0 0 0 1.6 0V8.8h1.9a.8.8 0 0 0 0-1.6H8.8V5.3A.8.8 0 0 0 8 4.5z"/>'),
  calendarStar: F('<path d="M2 4a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 14 4v8.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5zm6 2.2-.9 1.8-2 .3 1.5 1.4-.4 2 1.8-1 1.8 1-.4-2 1.5-1.4-2-.3z"/>'),
  ndi: S('<path d="M2 12V4l5 8V4M9.5 4v8h2a3 3 0 0 0 0-6h-2"/>'),
  osc: S('<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M10 4.5 6 11.5"/>'),
  doc: S('<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5M6 8h4.5M6 10.5h4.5"/>'),
  videoLoss: S('<rect x="1.6" y="4" width="9" height="8" rx="1.6"/><path d="m10.6 7 3.8-2.2v6.4L10.6 9M4 8.5l1.5-1.5 1.5 1.5 1.5-1.5"/>'),
  crop: S('<path d="M4 1.5V12h10.5M1.5 4H12v10.5"/>'),
  layers: S('<path d="m8 2 6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3"/>'),
  palette: S('<path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.3-.7 1-1.4-.3-.9.2-1.6 1.1-1.6h1.6c1.6 0 2.5-1 2.5-2.6C14.2 4.6 11.4 1.8 8 1.8z"/><circle cx="5" cy="7" r=".8" fill="currentColor"/><circle cx="7.5" cy="4.6" r=".8" fill="currentColor"/><circle cx="10.6" cy="5.3" r=".8" fill="currentColor"/>'),
  inbox: S('<path d="M2 9.5 3.5 3h9L14 9.5V13H2zM2 9.5h3.5l1 1.5h3l1-1.5H14"/>'),
  latch: S('<path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2"/><rect x="2" y="9" width="3" height="4.5" rx="1"/><rect x="11" y="9" width="3" height="4.5" rx="1"/>'),
  hand: S('<path d="M5 8V3.5a1 1 0 0 1 2 0V7M7 7V2.5a1 1 0 0 1 2 0V7M9 7V3.5a1 1 0 0 1 2 0V8.5M11 6.5a1 1 0 0 1 2 0V10a4.5 4.5 0 0 1-4.5 4.5h-.8A4.5 4.5 0 0 1 4 12.2L2.5 9.5a1 1 0 0 1 1.7-1L5 9.5"/>'),
  crown: F('<path d="M2 5l3 2.5L8 3l3 4.5L14 5l-1.2 7H3.2z"/>'),
  externalLink: S('<path d="M9 2.5h4.5V7M13.5 2.5 7 9M12 9.5V13H3V4h3.5"/>'),
  trash: S('<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>'),
  copy: S('<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/>'),
  pencil: S('<path d="m10.5 2.5 3 3L6 13H3v-3z"/>'),
  stop: F('<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/>'),
  play: F('<path d="M4.5 2.8v10.4L13 8z"/>'),
  ndiSource: S('<circle cx="8" cy="8" r="1.5" fill="currentColor"/><path d="M5 5a4.2 4.2 0 0 0 0 6M11 5a4.2 4.2 0 0 1 0 6M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10"/>'),
};

// ---------------------------------------------------------------------------
// RE icons (ZoomISO v3 asset catalogue, static/re-assets/icons). Rendered as a CSS mask
// so they take currentColor. Outline icons use the SVG; `.fill` icons use the @2x PNG
// (the SF-Symbols SVG exports draw every layer solid in browsers).
// ---------------------------------------------------------------------------
export const RE_ASSET_BASE = 're-assets';
export const RE_ICON_FILES: Record<string, string> = {
  audio: 'audio.svg',
  'camera.outline': 'camera.outline.svg',
  'camera.slash.outline': 'camera.slash.outline.svg',
  'chat.outline': 'chat.outline.svg',
  'mic.outline': 'mic.outline.svg',
  'mic.slash.outline': 'mic.slash.outline.svg',
  osc: 'osc.svg',
  'slash.commands': 'slash.commands.svg',
  'speaker.outline': 'speaker.outline.svg',
  'headset.fill': 'headset.fill@2x.png',
  'profile.small.fill': 'profile.small.fill@2x.png',
  'record.large.fill': 'record.large.fill@2x.png',
  'screenshare.fill': 'screenshare.fill@2x.png',
  'speaker.fill': 'speaker.fill@2x.png',
  'spotlight.fill': 'spotlight.fill@2x.png',
  'events.fill': 'zoom.events.fill@2x.png',
  'video.fill': 'zoom.video.fill@2x.png',
};
/** Full-colour RE images (use as <img src>): test card, watermark, placeholders, frame guide. */
export const RE_IMAGES = {
  testcard: `${RE_ASSET_BASE}/images/testcard.png`,
  colourbars: `${RE_ASSET_BASE}/images/colourbars.png`,
  watermark: `${RE_ASSET_BASE}/images/watermark.png`,
  profilePlaceholder: `${RE_ASSET_BASE}/images/profile-placeholder.png`,
  videoLoss: `${RE_ASSET_BASE}/images/video-loss.png`,
  frameGuide: `${RE_ASSET_BASE}/images/frame-guide.png`,
} as const;

export function reIconUrl(name: string): string | null {
  const f = RE_ICON_FILES[name];
  return f ? `${RE_ASSET_BASE}/icons/${f}` : null;
}

// The 'osc' key existed as a hand-drawn glyph; the RE asset replaces it (keep the old one as 'oscGlyph').
ICONS.oscGlyph = ICONS.osc;
for (const name of Object.keys(RE_ICON_FILES)) ICONS[name] = `<i style="-webkit-mask-image:url('${reIconUrl(name)}')"></i>`;

/** Icon by name: kit glyphs (gear, plus, …) or RE icons ('mic.outline', 'speaker.fill', …). Size with font-size. */
export function icon(name: string, cls = ''): HTMLSpanElement {
  const s = h('span.ico');
  if (RE_ICON_FILES[name]) s.className += ' re-ico';
  if (cls) s.className += ' ' + cls;
  s.innerHTML = ICONS[name] ?? '';
  return s;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
export interface Opt {
  value: string;
  label: string;
  disabled?: boolean;
}
export type OptList = (Opt | { group: string; options: Opt[] })[];

/** NSPopUpButton look-alike wrapping a native <select>. */
export function popup(opts: OptList, value: string, onChange: (v: string) => void, extra: { cls?: string; title?: string; disabled?: boolean } = {}) {
  const sel = h('select', { title: extra.title });
  const wrap = h('label.popup', sel);
  if (extra.cls) wrap.className += ' ' + extra.cls;
  sel.addEventListener('change', () => onChange(sel.value));
  const api = {
    el: wrap,
    select: sel,
    set(options: OptList, v: string, disabled = false) {
      if (document.activeElement !== sel) {
        const html = renderOpts(options);
        if (sel.dataset.html !== html) {
          sel.innerHTML = html;
          sel.dataset.html = html;
        }
        sel.value = v;
        if (sel.value !== v && sel.options.length) sel.selectedIndex = 0;
      }
      sel.disabled = disabled;
      wrap.classList.toggle('disabled', disabled);
    },
  };
  api.set(opts, value, !!extra.disabled);
  return api;
}

function renderOpts(options: OptList): string {
  return options
    .map((o) =>
      'group' in o
        ? `<optgroup label="${esc(o.group)}">${o.options.map(renderOpt).join('')}</optgroup>`
        : renderOpt(o),
    )
    .join('');
}
function renderOpt(o: Opt): string {
  return `<option value="${esc(o.value)}"${o.disabled ? ' disabled' : ''}>${esc(o.label)}</option>`;
}

export function toggle(checked: boolean, onChange: (v: boolean) => void, extra: { cls?: string; title?: string; disabled?: boolean } = {}) {
  const input = h('input', { type: 'checkbox', title: extra.title }) as HTMLInputElement;
  input.checked = checked;
  input.disabled = !!extra.disabled;
  const el = h('label.switch', input, h('span'));
  if (extra.cls) el.className += ' ' + extra.cls;
  input.addEventListener('change', () => onChange(input.checked));
  return {
    el,
    input,
    set(v: boolean, disabled = false) {
      if (document.activeElement !== input) input.checked = v;
      input.disabled = disabled;
    },
  };
}

export function checkbox(checked: boolean, onChange: (v: boolean) => void, label?: string) {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const el = h('label.check', input, label ?? null);
  return { el, input, set: (v: boolean) => (input.checked = v) };
}

export function button(label: Child, onClick: (e: MouseEvent) => void, cls = '', title = '') {
  const b = h('button.btn', { title: title || undefined }, label) as HTMLButtonElement;
  if (cls) b.className += ' ' + cls;
  b.addEventListener('click', onClick);
  return b;
}

export function iconButton(name: string, onClick: (e: MouseEvent) => void, title = '', cls = '') {
  const b = h('button.icon-btn', { title: title || undefined }, icon(name)) as HTMLButtonElement;
  if (cls) b.className += ' ' + cls;
  b.addEventListener('click', onClick);
  return b;
}

export function textField(value: string, onChange: (v: string) => void, extra: { placeholder?: string; cls?: string; live?: boolean; type?: string } = {}) {
  const input = h('input.field', { type: extra.type ?? 'text', placeholder: extra.placeholder, spellcheck: 'false' }) as HTMLInputElement;
  if (extra.cls) input.className += ' ' + extra.cls;
  input.value = value;
  input.addEventListener(extra.live ? 'input' : 'change', () => onChange(input.value));
  input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
  return { el: input, set: (v: string) => document.activeElement !== input && (input.value = v) };
}

/** Number field with −/+ segmented buttons ("Number of Outputs  [7] [−|+]"). */
export function stepper(value: number, onChange: (v: number) => void, min = 0, max = 99) {
  const input = h('input.field', { type: 'text', inputmode: 'numeric' }) as HTMLInputElement;
  input.value = String(value);
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));
  const commit = (n: number) => {
    const v = clamp(n);
    input.value = String(v);
    onChange(v);
  };
  input.addEventListener('change', () => commit(Number(input.value) || 0));
  const dec = h('button', { title: 'Remove' }, '−');
  const inc = h('button', { title: 'Add' }, '+');
  dec.addEventListener('click', () => commit(Number(input.value) - 1));
  inc.addEventListener('click', () => commit(Number(input.value) + 1));
  const el = h('span.stepper', input, h('span.seg', dec, inc));
  return { el, set: (v: number) => document.activeElement !== input && (input.value = String(v)) };
}

export function segmented(items: { value: string; label: Child; icon?: string; title?: string }[], value: string, onChange: (v: string) => void, cls = '') {
  const el = h('div.segmented');
  if (cls) el.className += ' ' + cls;
  const btns = items.map((it) => {
    const b = h('button', { title: it.title, dataset: { value: it.value } }, it.icon ? icon(it.icon) : null, it.label);
    b.addEventListener('click', () => onChange(it.value));
    el.append(b);
    return b;
  });
  const set = (v: string) => btns.forEach((b) => b.classList.toggle('active', b.dataset.value === v));
  set(value);
  return { el, set };
}

export function slider(value: number, min: number, max: number, step: number, onInput: (v: number) => void, cls = '') {
  const input = h('input.slider', { type: 'range', min: String(min), max: String(max), step: String(step) }) as HTMLInputElement;
  if (cls) input.className += ' ' + cls;
  input.value = String(value);
  input.addEventListener('input', () => onInput(Number(input.value)));
  return { el: input, set: (v: number) => document.activeElement !== input && (input.value = String(v)) };
}

export function meterV(): { el: HTMLElement; set(level: number): void } {
  const i = h('i');
  const el = h('div.meter-v', i);
  return { el, set: (l) => (i.style.height = `${Math.round(Math.min(1, Math.sqrt(Math.max(0, l))) * 100)}%`) };
}
export function meterH(): { el: HTMLElement; set(level: number): void } {
  const i = h('i');
  const el = h('div.meter-h', i);
  return { el, set: (l) => (i.style.width = `${Math.round(Math.min(1, Math.sqrt(Math.max(0, l))) * 100)}%`) };
}

// ---------------------------------------------------------------------------
// Popovers, menus, sheets
// ---------------------------------------------------------------------------
let closeCurrent: (() => void) | null = null;

/** Anchored popover with arrow (NSPopover). Returns a close function. */
export function popover(anchor: HTMLElement, content: HTMLElement, opts: { width?: number; align?: 'center' | 'start' | 'end' } = {}): () => void {
  closeCurrent?.();
  const layer = h('div.popover-layer');
  const pop = h('div.popover', content);
  if (opts.width) pop.style.width = `${opts.width}px`;
  document.body.append(layer, pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  let left = opts.align === 'start' ? r.left : opts.align === 'end' ? r.right - pw : r.left + r.width / 2 - pw / 2;
  left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
  pop.style.left = `${left}px`;
  pop.style.top = `${r.bottom + 10}px`;
  pop.style.setProperty('--arrow-x', `${r.left + r.width / 2 - left}px`);
  const close = () => {
    layer.remove();
    pop.remove();
    document.removeEventListener('keydown', onKey);
    if (closeCurrent === close) closeCurrent = null;
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  layer.addEventListener('mousedown', close);
  document.addEventListener('keydown', onKey);
  closeCurrent = close;
  return close;
}

export interface MenuItem {
  label: string;
  icon?: string;
  onClick?: () => void;
  disabled?: boolean;
  destructive?: boolean;
}
/** Context menu under an anchor (or at x/y). `null` = separator. */
export function menu(anchor: HTMLElement | { x: number; y: number }, items: (MenuItem | null)[]): void {
  closeCurrent?.();
  const layer = h('div.popover-layer');
  const m = h('div.menu');
  for (const it of items) {
    if (!it) {
      m.append(h('hr'));
      continue;
    }
    const b = h('button', { disabled: it.disabled }, it.icon ? icon(it.icon) : null, it.label);
    if (it.destructive) b.classList.add('destructive');
    b.addEventListener('click', () => {
      close();
      it.onClick?.();
    });
    m.append(b);
  }
  document.body.append(layer, m);
  let x: number;
  let y: number;
  if (anchor instanceof HTMLElement) {
    const r = anchor.getBoundingClientRect();
    x = r.right - m.offsetWidth;
    y = r.bottom + 4;
  } else {
    x = anchor.x;
    y = anchor.y;
  }
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, x))}px`;
  m.style.top = `${Math.max(8, Math.min(window.innerHeight - m.offsetHeight - 8, y))}px`;
  const close = () => {
    layer.remove();
    m.remove();
    if (closeCurrent === close) closeCurrent = null;
  };
  layer.addEventListener('mousedown', close);
  closeCurrent = close;
}

/** Centered confirmation sheet. Resolves true on confirm. */
export function confirmSheet(title: string, message: string, confirmLabel = 'OK', destructive = false): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      layer.remove();
      resolve(v);
    };
    const ok = button(confirmLabel, () => done(true), destructive ? 'danger' : 'primary');
    const layer = h('div.sheet-layer', h('div.sheet', h('h3', title), h('p', message), h('div.actions', button('Cancel', () => done(false)), ok)));
    document.body.append(layer);
    ok.focus();
  });
}

/** Prompt sheet with a text field. Resolves null on cancel. */
export function promptSheet(title: string, value: string, confirmLabel = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    const field = h('input.field', { style: 'width:100%;margin-bottom:14px' }) as HTMLInputElement;
    field.value = value;
    const done = (v: string | null) => {
      layer.remove();
      resolve(v);
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(field.value);
      if (e.key === 'Escape') done(null);
    });
    const layer = h('div.sheet-layer', h('div.sheet', h('h3', { style: 'margin-bottom:12px' }, title), field, h('div.actions', button('Cancel', () => done(null)), button(confirmLabel, () => done(field.value), 'primary'))));
    document.body.append(layer);
    field.focus();
    field.select();
  });
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fpsLabel(n: number, d: number): string {
  const f = n / d;
  return Number.isInteger(f) ? String(f) : f.toFixed(2);
}
