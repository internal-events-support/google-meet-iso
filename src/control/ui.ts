// Control UI. Talks to main only through window.gmeetIso (see control/preload.ts).
// Type-only imports: this file runs in a sandboxed page with a tiny CJS shim, so runtime
// values from shared/types are duplicated below.
import type {
  CameraSource,
  Command,
  ControlApi,
  DeviceLists,
  EngineState,
  MeetPhase,
  MeetState,
  OutputConfig,
  OutputEffects,
  OutputFormat,
  OutputState,
  ParticipantState,
  Settings,
  SystemStats,
} from '../shared/types';

const api = (window as unknown as { gmeetIso: ControlApi }).gmeetIso;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BOT_CAM_KEY = '__botcam__';

const FORMATS: { label: string; format: OutputFormat | null }[] = [
  { label: 'Native', format: null },
  { label: '720p25', format: { width: 1280, height: 720, fpsN: 25, fpsD: 1 } },
  { label: '720p29.97', format: { width: 1280, height: 720, fpsN: 30000, fpsD: 1001 } },
  { label: '720p30', format: { width: 1280, height: 720, fpsN: 30, fpsD: 1 } },
  { label: '720p50', format: { width: 1280, height: 720, fpsN: 50, fpsD: 1 } },
  { label: '720p59.94', format: { width: 1280, height: 720, fpsN: 60000, fpsD: 1001 } },
  { label: '1080p25', format: { width: 1920, height: 1080, fpsN: 25, fpsD: 1 } },
  { label: '1080p29.97', format: { width: 1920, height: 1080, fpsN: 30000, fpsD: 1001 } },
  { label: '1080p30', format: { width: 1920, height: 1080, fpsN: 30, fpsD: 1 } },
  { label: '1080p50', format: { width: 1920, height: 1080, fpsN: 50, fpsD: 1 } },
  { label: '1080p59.94', format: { width: 1920, height: 1080, fpsN: 60000, fpsD: 1001 } },
  { label: '2160p29.97', format: { width: 3840, height: 2160, fpsN: 30000, fpsD: 1001 } },
];
const LOSS = [
  ['black', 'Black'],
  ['freeze', 'Freeze'],
  ['transparent', 'Transparent'],
  ['image', 'Image'],
  ['testcard', 'Test card'],
] as const;
const AUDIO = [
  ['iso', 'ISO audio'],
  ['mix', 'Mix audio'],
  ['off', 'No audio'],
] as const;
const DEFAULT_FX: OutputEffects = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  mirror: false,
  nameTag: false,
  nameTagText: '',
  nameTagSubtitle: '',
  nameTagPosition: 'bl',
};

let settings: Settings;
let devices: DeviceLists = { videoInputs: [], audioInputs: [], audioOutputs: [] };
let ndiSources: string[] = [];
let lastState: MeetState | null = null;
let sys: SystemStats | null = null;
let drawerFor: string | null = null;

// ---------------- helpers ----------------
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function appendLog(line: string): void {
  const el = $('log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.textContent += line + '\n';
  const lines = el.textContent!.split('\n');
  if (lines.length > 600) el.textContent = lines.slice(-600).join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function run(c: Command): Promise<unknown> {
  const r = (await api.command(c)) as { ok: boolean; result?: unknown; error?: string };
  if (!r.ok) appendLog(`✖ ${c.cmd}: ${r.error}`);
  return r.result;
}

function updateOutput(id: string, patch: Partial<OutputConfig>): Promise<unknown> {
  return run({ cmd: 'updateOutput', output: id, patch });
}

function sameFormat(a: OutputFormat | null, b: OutputFormat | null): boolean {
  if (!a || !b) return a === b;
  return a.width === b.width && a.height === b.height && a.fpsN === b.fpsN && a.fpsD === b.fpsD;
}

function setSelect(sel: HTMLSelectElement, html: string, value: string): void {
  if (document.activeElement === sel) return;
  if (sel.dataset.html !== html) {
    sel.innerHTML = html;
    sel.dataset.html = html;
  }
  sel.value = value;
}

// ---------------- previews ----------------
const previewUrls = new Map<string, string>();
function setPreview(key: string, jpeg: ArrayBuffer): void {
  let img: HTMLImageElement | null = null;
  if (key === BOT_CAM_KEY) img = $<HTMLImageElement>('botPreview');
  else if (key.startsWith('src:')) img = rosterRows.get(key.slice(4))?.img ?? null;
  else img = cards.get(key)?.img ?? null;
  if (!img) return;
  const url = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
  const old = previewUrls.get(key);
  img.src = url;
  previewUrls.set(key, url);
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
}

// ---------------- output cards ----------------
interface Card {
  root: HTMLElement;
  img: HTMLImageElement;
  overlay: HTMLElement;
  air: HTMLElement;
  rec: HTMLElement;
  res: HTMLElement;
  meter: HTMLElement;
  num: HTMLElement;
  name: HTMLInputElement;
  enabled: HTMLInputElement;
  src: HTMLSelectElement;
  fmt: HTMLSelectElement;
  loss: HTMLSelectElement;
  aud: HTMLSelectElement;
  srcName: HTMLElement;
  stats: HTMLElement;
  recBtn: HTMLButtonElement;
}
const cards = new Map<string, Card>();

function makeCard(id: string): Card {
  const root = document.createElement('div');
  root.className = 'out';
  root.innerHTML = `
    <div class="media">
      <img alt="" />
      <div class="overlay"></div>
      <span class="badge air" hidden></span>
      <span class="badge rec" hidden>● REC</span>
      <span class="badge res"></span>
      <div class="meter"><i></i></div>
    </div>
    <div class="out-head">
      <span class="num"></span>
      <input class="oname" spellcheck="false" title="NDI source name" />
      <label class="switch" title="Output enabled"><input type="checkbox" /><span></span></label>
    </div>
    <div class="out-body">
      <select class="src" title="What this output shows"></select>
      <div class="out-row">
        <select class="fmt" title="Resolution / frame rate"></select>
        <select class="loss" title="When there is no video"></select>
        <select class="aud" title="Embedded audio"></select>
      </div>
    </div>
    <div class="out-foot">
      <span class="srcname"></span>
      <span class="stats"></span>
      <button class="icon recb" title="Record this output">●</button>
      <button class="icon fx" title="Picture, name tag, audio, display">⚙</button>
    </div>`;
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const c: Card = {
    root,
    img: q('img'),
    overlay: q('.overlay'),
    air: q('.badge.air'),
    rec: q('.badge.rec'),
    res: q('.badge.res'),
    meter: q('.meter i'),
    num: q('.num'),
    name: q('.oname'),
    enabled: q('.switch input'),
    src: q('.src'),
    fmt: q('.fmt'),
    loss: q('.loss'),
    aud: q('.aud'),
    srcName: q('.srcname'),
    stats: q('.stats'),
    recBtn: q('.recb'),
  };
  c.fmt.innerHTML = FORMATS.map((f, i) => `<option value="${i}">${f.label}</option>`).join('');
  c.loss.innerHTML = LOSS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  c.aud.innerHTML = AUDIO.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  c.name.addEventListener('change', () => void updateOutput(id, { name: c.name.value.trim() }));
  c.name.addEventListener('keydown', (e) => e.key === 'Enter' && c.name.blur());
  c.enabled.addEventListener('change', () => void updateOutput(id, { enabled: c.enabled.checked }));
  c.fmt.addEventListener('change', () => void updateOutput(id, { format: FORMATS[Number(c.fmt.value)].format }));
  c.loss.addEventListener('change', () => void updateOutput(id, { lossMode: c.loss.value as OutputConfig['lossMode'] }));
  c.aud.addEventListener('change', () => void updateOutput(id, { audio: c.aud.value as OutputConfig['audio'] }));
  c.src.addEventListener('change', () => {
    const v = c.src.value;
    if (v === 'auto') void updateOutput(id, { mode: 'auto', selection: null });
    else if (v === 'activeSpeaker') void updateOutput(id, { mode: 'activeSpeaker', selection: null });
    else if (v === 'screenshare') void updateOutput(id, { mode: 'screenshare', selection: null });
    else if (v.startsWith('p:')) void run({ cmd: 'route', output: id, participant: v.slice(2) });
    c.src.blur();
  });
  c.recBtn.addEventListener('click', () => {
    const o = settings.outputs.find((x) => x.id === id);
    if (o) void updateOutput(id, { record: !o.record });
  });
  q('.fx').addEventListener('click', () => openDrawer(id));
  return c;
}

function sourceOptions(o: OutputConfig): { html: string; value: string } {
  const roster = (lastState?.participants ?? []).filter((p) => !p.isSelf || settings.includeSelf);
  const cams = roster.filter((p) => p.kind === 'camera');
  const screens = roster.filter((p) => p.kind === 'screen');
  let value: string = o.mode;
  if ((o.mode === 'participant' || o.mode === 'screenshare') && o.selection) value = `p:${o.selection.key}`;
  const opts = [
    `<option value="auto">Auto (next participant)</option>`,
    `<option value="activeSpeaker">Active speaker</option>`,
    `<option value="screenshare">Screen share</option>`,
  ];
  const known = new Set(roster.map((p) => p.key));
  const away = o.selection && !known.has(o.selection.key) ? [`<option value="p:${esc(o.selection.key)}">${esc(o.selection.name)} (not here)</option>`] : [];
  if (cams.length || away.length)
    opts.push(`<optgroup label="Participants">${[...cams.map((p) => `<option value="p:${esc(p.key)}">${esc(p.displayName)}</option>`), ...away].join('')}</optgroup>`);
  if (screens.length)
    opts.push(`<optgroup label="Screen shares">${screens.map((p) => `<option value="p:${esc(p.key)}">${esc(p.displayName)} — screen</option>`).join('')}</optgroup>`);
  return { html: opts.join(''), value };
}

function renderOutputs(): void {
  const wrap = $('outputs');
  wrap.className = `outputs ${settings.outputsView === 'list' ? 'list' : 'grid'}`;
  const ids = settings.outputs.map((o) => o.id);
  for (const [id, c] of cards) {
    if (!ids.includes(id)) {
      c.root.remove();
      cards.delete(id);
    }
  }
  settings.outputs.forEach((o, i) => {
    let c = cards.get(o.id);
    if (!c) {
      c = makeCard(o.id);
      cards.set(o.id, c);
    }
    if (wrap.children[i] !== c.root) wrap.insertBefore(c.root, wrap.children[i] ?? null);
    c.num.textContent = String(i + 1);
    if (document.activeElement !== c.name) c.name.value = o.name;
    if (document.activeElement !== c.enabled) c.enabled.checked = o.enabled;
    if (document.activeElement !== c.fmt) c.fmt.value = String(Math.max(0, FORMATS.findIndex((f) => sameFormat(f.format, o.format))));
    if (document.activeElement !== c.loss) c.loss.value = o.lossMode;
    if (document.activeElement !== c.aud) c.aud.value = o.audio;
    const so = sourceOptions(o);
    setSelect(c.src, so.html, so.value);
    c.recBtn.classList.toggle('on', o.record);
    c.root.classList.toggle('disabled', !o.enabled);
  });
  // "Add output" tile
  let add = wrap.querySelector('.out-add') as HTMLElement | null;
  if (!add) {
    add = document.createElement('button');
    add.className = 'out-add';
    add.innerHTML = '<span>＋</span>Add output';
    add.addEventListener('click', () => void run({ cmd: 'addOutput' }));
  }
  wrap.appendChild(add);
  $('outCount').textContent = String(settings.outputs.length);
  renderOutputLive();
  if (drawerFor) fillDrawer();
}

function renderOutputLive(): void {
  const live = new Map((lastState?.outputs ?? []).map((s) => [s.id, s]));
  for (const o of settings.outputs) {
    const c = cards.get(o.id);
    if (!c) continue;
    const s: OutputState | undefined = live.get(o.id);
    const status = !o.enabled || settings.engine === 'disabled' ? 'off' : (s?.status ?? 'loss');
    c.root.dataset.status = status;
    const overlay =
      status === 'off' ? 'Off' : status === 'standby' ? 'Standby' : status === 'loss' ? (s?.sourceName ? `${s.sourceName} — no video` : 'No participant') : '';
    c.overlay.textContent = overlay;
    c.overlay.hidden = !overlay;
    c.res.textContent = s && s.outWidth && status !== 'off' ? `${s.outWidth}×${s.outHeight} · ${s.outFps}fps` : '';
    c.res.hidden = !c.res.textContent;
    const tally = s?.program ? 'program' : s?.preview ? 'preview' : '';
    c.air.hidden = !tally;
    c.air.textContent = tally === 'program' ? 'ON AIR' : 'PREVIEW';
    c.air.className = `badge air ${tally}`;
    c.root.classList.toggle('onair', tally === 'program');
    c.root.classList.toggle('onpreview', tally === 'preview');
    c.rec.hidden = !s?.recording;
    c.srcName.textContent = s?.sourceName || '—';
    c.stats.textContent = s && s.inWidth ? `in ${s.inWidth}×${s.inHeight} ${s.inFps}fps` : '';
    c.meter.style.width = `${Math.round(Math.min(1, Math.sqrt(s?.audioLevel ?? 0)) * 100)}%`;
    if (status === 'off') c.img.removeAttribute('src');
  }
}

// ---------------- participants ----------------
interface Row {
  root: HTMLElement;
  img: HTMLImageElement;
  name: HTMLElement;
  flags: HTMLElement;
  level: HTMLElement;
  outs: HTMLElement;
  send: HTMLSelectElement;
  mute: HTMLButtonElement;
}
const rosterRows = new Map<string, Row>();

function makeRow(p: ParticipantState): Row {
  const root = document.createElement('div');
  root.className = 'prow';
  root.innerHTML = `
    <div class="pthumb"><img alt="" /></div>
    <div class="pinfo">
      <div class="pname"></div>
      <div class="pflags"></div>
    </div>
    <div class="plevel"><i></i></div>
    <div class="pouts"></div>
    <select class="psend" title="Send to output"></select>
    <button class="pmute" title="Mute in Meet (host only)">Mute</button>`;
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const r: Row = { root, img: q('img'), name: q('.pname'), flags: q('.pflags'), level: q('.plevel i'), outs: q('.pouts'), send: q('.psend'), mute: q('.pmute') };
  r.send.addEventListener('change', () => {
    if (r.send.value) void run({ cmd: 'route', output: r.send.value, participant: p.key });
    r.send.value = '';
    r.send.blur();
  });
  r.mute.addEventListener('click', () => void run({ cmd: 'muteParticipant', participant: p.key }));
  return r;
}

function renderRoster(): void {
  const roster = (lastState?.participants ?? []).filter((p) => !p.isSelf || settings.includeSelf);
  const wrap = $('roster');
  const keys = new Set(roster.map((p) => p.key));
  for (const [k, r] of rosterRows) {
    if (!keys.has(k)) {
      r.root.remove();
      rosterRows.delete(k);
    }
  }
  const outName = new Map(settings.outputs.map((o, i) => [o.id, `${i + 1}`]));
  const sendHtml =
    `<option value="">Send to…</option>` + settings.outputs.map((o, i) => `<option value="${esc(o.id)}">${i + 1} · ${esc(o.name)}</option>`).join('');
  roster.forEach((p, i) => {
    let r = rosterRows.get(p.key);
    if (!r) {
      r = makeRow(p);
      rosterRows.set(p.key, r);
    }
    if (wrap.children[i] !== r.root) wrap.insertBefore(r.root, wrap.children[i] ?? null);
    r.name.textContent = p.displayName;
    const flags: string[] = [];
    if (p.kind === 'screen') flags.push('<span class="flag screen">SCREEN</span>');
    if (p.key === lastState?.activeSpeaker) flags.push('<span class="flag speaker">SPEAKER</span>');
    if (p.handRaised) flags.push('<span class="flag hand">✋ hand</span>');
    if (p.muted) flags.push('<span class="flag muted">muted</span>');
    flags.push(p.hasVideo ? `<span class="muted small">${p.width}×${p.height} · ${p.fps}fps</span>` : '<span class="muted small">camera off</span>');
    r.flags.innerHTML = flags.join(' ');
    r.level.style.width = `${Math.round(Math.min(1, Math.sqrt(p.level)) * 100)}%`;
    r.root.classList.toggle('speaking', p.speaking);
    r.outs.innerHTML = p.outputs.map((id) => `<span class="chip">${esc(outName.get(id) ?? '?')}</span>`).join('');
    setSelect(r.send, sendHtml, '');
    r.mute.hidden = p.kind === 'screen' || p.muted === true;
  });
  $('rosterEmpty').hidden = roster.length > 0;
  $('rosterEmpty').textContent = lastState?.phase === 'in-call' ? 'Nobody else is here yet' : 'Not in a meeting';
  $('partCount').textContent = roster.length ? String(roster.length) : '';
}

// ---------------- drawer (per-output advanced) ----------------
const FX_RANGES = ['brightness', 'contrast', 'saturation', 'hue', 'zoom', 'panX', 'panY'] as const;

function openDrawer(id: string): void {
  drawerFor = id;
  $('drawer').hidden = false;
  fillDrawer();
}

function fillDrawer(): void {
  const o = settings.outputs.find((x) => x.id === drawerFor);
  if (!o) {
    $('drawer').hidden = true;
    drawerFor = null;
    return;
  }
  const idx = settings.outputs.indexOf(o) + 1;
  $('drawerTitle').textContent = `Output ${idx}`;
  const set = (id: string, v: string | number | boolean) => {
    const el = $<HTMLInputElement | HTMLSelectElement>(id);
    if (document.activeElement === el) return;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v;
    else el.value = String(v);
  };
  set('d_name', o.name);
  set('d_failover', o.failover);
  set('d_lossImage', o.lossImage);
  set('d_audioGainDb', o.audioGainDb);
  set('d_audioDelayMs', o.audioDelayMs);
  const fx = { ...DEFAULT_FX, ...o.effects };
  for (const k of FX_RANGES) set(`e_${k}`, fx[k]);
  set('e_mirror', fx.mirror);
  set('e_nameTag', fx.nameTag);
  set('e_nameTagText', fx.nameTagText);
  set('e_nameTagSubtitle', fx.nameTagSubtitle);
  set('e_nameTagPosition', fx.nameTagPosition);
  const displays = sys?.displays ?? [];
  setSelect(
    $<HTMLSelectElement>('d_display'),
    `<option value="">None</option>` + displays.map((d) => `<option value="${d.id}">${esc(d.label)}${d.primary ? ' — primary' : ''}</option>`).join(''),
    o.display === null || o.display === undefined ? '' : String(o.display),
  );
}

function initDrawer(): void {
  $('drawerClose').addEventListener('click', () => {
    $('drawer').hidden = true;
    drawerFor = null;
  });
  const patchCur = (p: Partial<OutputConfig>) => drawerFor && void updateOutput(drawerFor, p);
  const fxPatch = (p: Partial<OutputEffects>) => {
    const o = settings.outputs.find((x) => x.id === drawerFor);
    if (o) patchCur({ effects: { ...DEFAULT_FX, ...o.effects, ...p } });
  };
  $('d_name').addEventListener('change', () => patchCur({ name: $<HTMLInputElement>('d_name').value.trim() }));
  $('d_failover').addEventListener('change', () => patchCur({ failover: $<HTMLSelectElement>('d_failover').value as OutputConfig['failover'] }));
  $('d_lossImage').addEventListener('change', () => patchCur({ lossImage: $<HTMLInputElement>('d_lossImage').value.trim() }));
  $('d_pickImage').addEventListener('click', async () => {
    const f = await api.pickFile('image');
    if (f) patchCur({ lossImage: f, lossMode: 'image' });
  });
  $('d_display').addEventListener('change', () => {
    const v = $<HTMLSelectElement>('d_display').value;
    patchCur({ display: v ? Number(v) : null });
  });
  $('d_audioGainDb').addEventListener('change', () => patchCur({ audioGainDb: Number($<HTMLInputElement>('d_audioGainDb').value) }));
  $('d_audioDelayMs').addEventListener('change', () => patchCur({ audioDelayMs: Number($<HTMLInputElement>('d_audioDelayMs').value) }));
  for (const k of FX_RANGES) {
    const el = $<HTMLInputElement>(`e_${k}`);
    let t = 0;
    el.addEventListener('input', () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => fxPatch({ [k]: Number(el.value) }), 60);
    });
    el.addEventListener('dblclick', () => fxPatch({ [k]: DEFAULT_FX[k] }));
  }
  $('e_mirror').addEventListener('change', () => fxPatch({ mirror: $<HTMLInputElement>('e_mirror').checked }));
  $('e_nameTag').addEventListener('change', () => fxPatch({ nameTag: $<HTMLInputElement>('e_nameTag').checked }));
  $('e_nameTagText').addEventListener('change', () => fxPatch({ nameTagText: $<HTMLInputElement>('e_nameTagText').value }));
  $('e_nameTagSubtitle').addEventListener('change', () => fxPatch({ nameTagSubtitle: $<HTMLInputElement>('e_nameTagSubtitle').value }));
  $('e_nameTagPosition').addEventListener('change', () =>
    fxPatch({ nameTagPosition: $<HTMLSelectElement>('e_nameTagPosition').value as OutputEffects['nameTagPosition'] }),
  );
  $('d_resetFx').addEventListener('click', () => {
    const o = settings.outputs.find((x) => x.id === drawerFor);
    if (o) patchCur({ effects: { ...DEFAULT_FX, nameTag: o.effects.nameTag, nameTagText: o.effects.nameTagText, nameTagSubtitle: o.effects.nameTagSubtitle, nameTagPosition: o.effects.nameTagPosition } });
  });
  $('d_delete').addEventListener('click', () => {
    if (drawerFor) void run({ cmd: 'deleteOutput', output: drawerFor });
    $('drawer').hidden = true;
    drawerFor = null;
  });
}

// ---------------- header: meeting bar, engine, system ----------------
let inCallSince = 0;

function meetingCode(url: string): string {
  return url.match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/)?.[0] ?? '';
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderMeetingBar(phase: MeetPhase, url: string, detail: string, since: number): void {
  const bar = $('meetingBar');
  const onMeetingPage = !!meetingCode(url);
  const state =
    phase === 'in-call' ? 'live' : phase === 'waiting' ? 'waiting' : phase === 'green-room' || (phase === 'loading' && onMeetingPage) ? 'joining' : 'idle';
  inCallSince = state === 'live' ? since || inCallSince || Date.now() : 0;
  bar.dataset.state = state;
  $('callLabel').textContent = state === 'live' ? 'Live' : state === 'waiting' ? 'Waiting for host to admit' : 'Joining';
  $('callCode').textContent = meetingCode(url);
  $('callTimer').textContent = state === 'live' ? fmtDuration(Date.now() - inCallSince) : '';
  $('leaveBtn').textContent = state === 'live' ? 'Leave' : 'Cancel';

  const signedOut = phase === 'signed-out';
  $('signInBtn').hidden = !signedOut;
  $('joinBtn').hidden = signedOut;
  $<HTMLInputElement>('meetUrl').disabled = signedOut;

  const notice = $('notice');
  const msg = phase === 'denied' ? detail || 'The meeting refused the bot' : phase === 'ended' ? 'Call ended' : signedOut ? 'Sign in with the bot account' : '';
  notice.hidden = !msg;
  notice.textContent = msg;
  notice.className = `notice ${phase === 'denied' || signedOut ? 'bad' : ''}`;
}

function renderEngine(): void {
  for (const b of Array.from($('engine').querySelectorAll<HTMLButtonElement>('button'))) b.classList.toggle('active', b.dataset.engine === settings.engine);
  $('engine').dataset.state = settings.engine;
  const anyRec = settings.outputs.some((o) => o.record && o.enabled);
  $('recAllBtn').classList.toggle('on', anyRec);
  $('recAllBtn').lastChild!.textContent = anyRec ? 'Stop rec' : 'Rec';
}

function renderSystem(): void {
  if (!sys) return;
  const parts = [`CPU ${Math.round(sys.cpu)}%`, `${sys.memMB} MB`];
  if (lastState?.rxMbps) parts.push(`↓ ${lastState.rxMbps.toFixed(1)} Mb/s`);
  $('sysStats').textContent = parts.join(' · ');
  const remote: string[] = [];
  if (sys.oscPort) remote.push(`OSC udp/${sys.oscPort}`);
  if (sys.apiUrl) remote.push(sys.apiUrl);
  $('remoteInfo').textContent = remote.length ? `Listening: ${remote.join(' · ')}` : '';
}

function renderState(s: MeetState): void {
  lastState = s;
  const ndi = $('ndiStatus');
  ndi.hidden = s.ndi.ok;
  ndi.textContent = s.ndi.ok ? '' : `NDI unavailable: ${s.ndi.error ?? 'unknown error'}`;
  renderMeetingBar(s.phase, s.url, s.phaseDetail, s.inCallSince);
  renderOutputs();
  renderRoster();

  // waiting room
  const waiting = s.waiting ?? [];
  $('waitingBox').hidden = !waiting.length;
  $('waitingText').textContent = waiting.length === 1 ? `${waiting[0]} wants to join` : `${waiting.join(', ')} want to join`;
  const inCall = s.phase === 'in-call';
  $<HTMLButtonElement>('chatBtn').disabled = !inCall;
  $<HTMLButtonElement>('layoutBtn').disabled = !inCall;

  // bot output
  const bc = s.botCam;
  $('botCamStatus').textContent = bc.source.type === 'none' ? 'No camera source' : `${bc.status}${bc.width ? ` · ${bc.width}×${bc.height} · ${bc.fps}fps` : ''}`;
  $('micActive').textContent = s.micActive.startsWith('error') ? `Mic ${s.micActive}` : '';
  setToggle($<HTMLButtonElement>('camToggle'), 'Camera', s.camOn, inCall || s.phase === 'green-room');
  setToggle($<HTMLButtonElement>('micToggle'), 'Mic', s.micOn, inCall || s.phase === 'green-room');
  renderSystem();
}

function setToggle(b: HTMLButtonElement, label: string, on: boolean | null, enabled: boolean): void {
  b.disabled = !enabled || on === null;
  b.className = `toggle ${on === null ? '' : on ? 'on' : 'off'}`;
  b.textContent = on === null ? label : `${label} ${on ? 'on' : 'off'}`;
  b.dataset.on = String(!!on);
}

// ---------------- source pickers ----------------
function camValue(c: CameraSource): string {
  return c.type === 'none' ? 'none' : `${c.type}:${c.name}`;
}

function renderCamSelect(): void {
  const sel = $<HTMLSelectElement>('camSource');
  const opts: string[] = ['<option value="none">None</option>'];
  const ndi = [...ndiSources];
  if (settings.camera.type === 'ndi' && !ndi.includes(settings.camera.name)) ndi.unshift(settings.camera.name);
  if (ndi.length) opts.push(`<optgroup label="NDI sources">${ndi.map((n) => `<option value="ndi:${esc(n)}">${esc(n)}</option>`).join('')}</optgroup>`);
  const cams = [...devices.videoInputs];
  if (settings.camera.type === 'device' && !cams.includes(settings.camera.name)) cams.unshift(settings.camera.name);
  if (cams.length) opts.push(`<optgroup label="Webcams">${cams.map((n) => `<option value="device:${esc(n)}">${esc(n)}</option>`).join('')}</optgroup>`);
  setSelect(sel, opts.join(''), camValue(settings.camera));
}

function renderMicSelect(): void {
  const mics = [...devices.audioInputs];
  if (settings.micLabel && !mics.includes(settings.micLabel)) mics.unshift(settings.micLabel);
  setSelect(
    $<HTMLSelectElement>('micSource'),
    ['<option value="">None (muted)</option>', ...mics.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)].join(''),
    settings.micLabel,
  );
  const outs = [...(devices.audioOutputs ?? [])];
  if (settings.monitorDevice && !outs.includes(settings.monitorDevice)) outs.unshift(settings.monitorDevice);
  setSelect(
    $<HTMLSelectElement>('s_monitorDevice'),
    ['<option value="">System default</option>', ...outs.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)].join(''),
    settings.monitorDevice,
  );
}

async function refreshNdi(): Promise<void> {
  ndiSources = await api.ndiSources();
  renderCamSelect();
}

// ---------------- settings form ----------------
const SETTING_KEYS = [
  'botName', 'ndiPrefix', 'ndiGroups', 'graceSeconds', 'meetWindowWidth', 'meetWindowHeight', 'previewFps',
  'screenShare', 'includeSelf', 'autoJoin', 'muteLocalAudio', 'joinNotice', 'autoAdmit', 'autoLayout', 'maxTiles',
  'recordDir', 'ndiDiscoveryServer', 'ndiNicIps', 'oscEnabled', 'oscListenPort', 'oscReplyHost', 'oscReplyPort',
  'apiEnabled', 'apiPort', 'monitorDevice',
] as const;

function fillSettingsForm(): void {
  for (const k of SETTING_KEYS) {
    const input = $<HTMLInputElement>(`s_${k}`);
    if (!input || document.activeElement === input || k === 'monitorDevice') continue;
    const v = settings[k];
    if (typeof v === 'boolean') input.checked = v;
    else input.value = String(v);
  }
}

function initSettingsForm(): void {
  for (const k of SETTING_KEYS) {
    const input = $<HTMLInputElement>(`s_${k}`);
    if (!input) continue;
    input.addEventListener('change', async () => {
      const num = input.type === 'number' || k === 'maxTiles';
      const val = input.type === 'checkbox' ? input.checked : num ? Number(input.value) : input.value;
      onSettings(await api.setSettings({ [k]: val } as Partial<Settings>));
    });
  }
  fillSettingsForm();
}

function onSettings(s: Settings): void {
  settings = s;
  fillSettingsForm();
  renderCamSelect();
  renderMicSelect();
  renderEngine();
  renderOutputs();
  renderRoster();
  for (const b of Array.from($('viewToggle').querySelectorAll<HTMLButtonElement>('button'))) b.classList.toggle('active', b.dataset.view === settings.outputsView);
}

// ---------------- wiring ----------------
async function init(): Promise<void> {
  settings = await api.getSettings();
  devices = await api.devices();
  sys = await api.system();
  $<HTMLInputElement>('meetUrl').value = settings.lastMeetUrl;
  initSettingsForm();
  initDrawer();
  await refreshNdi();
  onSettings(settings);

  const join = async () => {
    try {
      await api.join($<HTMLInputElement>('meetUrl').value);
    } catch (e) {
      appendLog(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      const n = $('notice');
      n.hidden = false;
      n.className = 'notice bad';
      n.textContent = 'Not a valid Meet link or code';
    }
  };
  $('joinBtn').addEventListener('click', join);
  $('meetUrl').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && void join());
  $('leaveBtn').addEventListener('click', () => void api.leave());
  $('signInBtn').addEventListener('click', () => void api.signIn());
  $('refreshNdi').addEventListener('click', () => void refreshNdi());
  $('camSource').addEventListener('focus', () => void refreshNdi());
  $('camSource').addEventListener('change', async () => {
    const v = $<HTMLSelectElement>('camSource').value;
    const i = v.indexOf(':');
    const camera: CameraSource = v === 'none' ? { type: 'none', name: '' } : { type: v.slice(0, i) as CameraSource['type'], name: v.slice(i + 1) };
    onSettings(await api.setSettings({ camera }));
    if (lastState?.phase === 'in-call') void api.setMeetCamera(camera.type !== 'none');
  });
  $('micSource').addEventListener('change', async () => {
    const micLabel = $<HTMLSelectElement>('micSource').value;
    onSettings(await api.setSettings({ micLabel }));
    if (lastState?.phase === 'in-call') void api.setMeetMic(!!micLabel);
  });
  $('s_monitorDevice').addEventListener('change', async () => onSettings(await api.setSettings({ monitorDevice: $<HTMLSelectElement>('s_monitorDevice').value })));
  $('camToggle').addEventListener('click', () => void api.setMeetCamera($('camToggle').dataset.on !== 'true'));
  $('micToggle').addEventListener('click', () => void api.setMeetMic($('micToggle').dataset.on !== 'true'));

  // engine + recording + show
  for (const b of Array.from($('engine').querySelectorAll<HTMLButtonElement>('button')))
    b.addEventListener('click', () => void run({ cmd: 'engine', state: b.dataset.engine as EngineState }));
  $('recAllBtn').addEventListener('click', () => void run({ cmd: 'recordAll', on: !settings.outputs.some((o) => o.record && o.enabled) }));
  $('showBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('showMenu').hidden = !$('showMenu').hidden;
  });
  document.addEventListener('click', () => ($('showMenu').hidden = true));
  for (const b of Array.from($('showMenu').querySelectorAll<HTMLButtonElement>('button')))
    b.addEventListener('click', () => {
      const a = b.dataset.show;
      void run(a === 'save' ? { cmd: 'saveShow' } : { cmd: 'loadShow', merge: a === 'merge' });
    });

  // tabs + view
  for (const t of Array.from(document.querySelectorAll<HTMLButtonElement>('.tab')))
    t.addEventListener('click', () => {
      for (const x of Array.from(document.querySelectorAll('.tab'))) x.classList.toggle('active', x === t);
      $('tab-outputs').hidden = t.dataset.tab !== 'outputs';
      $('tab-participants').hidden = t.dataset.tab !== 'participants';
      $('viewToggle').hidden = t.dataset.tab !== 'outputs';
    });
  for (const b of Array.from($('viewToggle').querySelectorAll<HTMLButtonElement>('button')))
    b.addEventListener('click', async () => onSettings(await api.setSettings({ outputsView: b.dataset.view as Settings['outputsView'] })));

  // meeting tools
  const sendChat = async () => {
    const box = $<HTMLInputElement>('chatText');
    const text = box.value.trim();
    if (!text) return;
    const ok = await run({ cmd: 'chat', text });
    if (ok) box.value = '';
  };
  $('chatBtn').addEventListener('click', () => void sendChat());
  $('chatText').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && void sendChat());
  $('admitAllBtn').addEventListener('click', () => void run({ cmd: 'admit', who: 'all' }));
  $('layoutBtn').addEventListener('click', () => void run({ cmd: 'applyLayout' }));
  $('pickRecordDir').addEventListener('click', async () => {
    const d = await api.pickFile('folder');
    if (d) onSettings(await api.setSettings({ recordDir: d }));
  });
  $('dumpBtn').addEventListener('click', async () => {
    const out = await api.dumpDom();
    ($('logDrawer') as HTMLDetailsElement).open = true;
    appendLog('---- Meet DOM dump ----\n' + out + '\n-----------------------');
  });

  api.onState(renderState);
  api.onLog(appendLog);
  api.onPreview(setPreview);
  api.onSettings(onSettings);
  api.onSystem((s) => {
    sys = s;
    renderSystem();
  });
  api.onDevices((d) => {
    devices = d;
    renderCamSelect();
    renderMicSelect();
  });
  setInterval(() => void refreshNdi(), 10000);
  setInterval(() => {
    if (inCallSince) $('callTimer').textContent = fmtDuration(Date.now() - inCallSince);
  }, 1000);
}

void init();
