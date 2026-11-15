// Control UI. Talks to main only through window.gmeetIso (see control/preload.ts).
import type { CameraSource, ControlApi, DeviceLists, FeedState, MeetPhase, MeetState, Settings } from '../shared/types';

const api = (window as unknown as { gmeetIso: ControlApi }).gmeetIso;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BOT_CAM_KEY = '__botcam__';

let settings: Settings;
let devices: DeviceLists = { videoInputs: [], audioInputs: [] };
let ndiSources: string[] = [];
let lastState: MeetState | null = null;

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

// ---------------- previews ----------------
const previewUrls = new Map<string, string>();
function setPreview(key: string, jpeg: ArrayBuffer): void {
  const img = key === BOT_CAM_KEY ? $<HTMLImageElement>('botPreview') : (tiles.get(key)?.img ?? null);
  if (!img) return;
  const url = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
  const old = previewUrls.get(key);
  img.src = url;
  previewUrls.set(key, url);
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
}

// ---------------- participant tiles ----------------
interface TileEls {
  root: HTMLElement;
  img: HTMLImageElement;
  overlay: HTMLElement;
  res: HTMLElement;
  air: HTMLElement;
  kind: HTMLElement;
  pname: HTMLElement;
  ndiname: HTMLElement;
  status: HTMLElement;
  toggle: HTMLInputElement;
}
const tiles = new Map<string, TileEls>();

function makeTile(f: FeedState): TileEls {
  const root = document.createElement('div');
  root.className = 'tile';
  root.innerHTML = `
    <div class="media">
      <img alt="" />
      <div class="overlay"></div>
      <span class="badge air" hidden>ON AIR</span>
      <span class="badge kind" hidden>SCREEN</span>
      <span class="badge res"></span>
    </div>
    <div class="meta">
      <div class="names"><div class="pname"></div><div class="ndiname"></div></div>
      <span class="status small"></span>
      <label class="switch" title="Publish to NDI"><input type="checkbox" /><span></span></label>
    </div>`;
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const els: TileEls = {
    root,
    img: q('img'),
    overlay: q('.overlay'),
    res: q('.badge.res'),
    air: q('.badge.air'),
    kind: q('.badge.kind'),
    pname: q('.pname'),
    ndiname: q('.ndiname'),
    status: q('.status'),
    toggle: q('input'),
  };
  els.toggle.addEventListener('change', () => void api.setFeedEnabled(f.key, els.toggle.checked));
  return els;
}

function feedStatus(f: FeedState): { cls: string; text: string; overlay: string } {
  if (!f.enabled) return { cls: 'off', text: 'off', overlay: 'Not published' };
  if (!f.present) return { cls: 'gone', text: 'left', overlay: 'Participant left — holding source' };
  if (!f.hasVideo || f.slate) return { cls: 'slate', text: 'no video', overlay: 'Camera off' };
  return { cls: 'live', text: 'live', overlay: '' };
}

function renderFeeds(feeds: FeedState[]): void {
  const sorted = [...feeds].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.kind.localeCompare(b.kind));
  const grid = $('grid');
  const keep = new Set(sorted.map((f) => f.key));
  for (const [key, t] of tiles) {
    if (!keep.has(key)) {
      t.root.remove();
      tiles.delete(key);
      const u = previewUrls.get(key);
      if (u) URL.revokeObjectURL(u);
      previewUrls.delete(key);
    }
  }
  sorted.forEach((f, i) => {
    let t = tiles.get(f.key);
    if (!t) {
      t = makeTile(f);
      tiles.set(f.key, t);
    }
    if (grid.children[i] !== t.root) grid.insertBefore(t.root, grid.children[i] ?? null);
    const st = feedStatus(f);
    t.pname.textContent = f.displayName;
    t.ndiname.textContent = f.ndiName ?? '—';
    t.res.textContent = f.width ? `${f.width}×${f.height} · ${f.fps}fps` : '—';
    t.status.innerHTML = `<span class="status-dot ${st.cls}"></span>${esc(st.text)}`;
    t.overlay.textContent = st.overlay;
    t.overlay.hidden = !st.overlay;
    t.kind.hidden = f.kind !== 'screen';
    // Tally from downstream switchers; plain receivers (monitors) only show "Connected".
    const tally = f.program ? 'program' : f.preview ? 'preview' : f.connections > 0 ? 'connected' : '';
    t.air.hidden = !tally;
    t.air.textContent = tally === 'program' ? 'ON AIR' : tally === 'preview' ? 'PREVIEW' : 'Connected';
    t.air.className = `badge air ${tally}`;
    t.root.classList.toggle('onair', tally === 'program');
    t.root.classList.toggle('onpreview', tally === 'preview');
    t.root.classList.toggle('disabled', !f.enabled);
    if (document.activeElement !== t.toggle) t.toggle.checked = f.enabled;
  });
}

// ---------------- meeting bar ----------------
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
    phase === 'in-call'
      ? 'live'
      : phase === 'waiting'
        ? 'waiting'
        : phase === 'green-room' || (phase === 'loading' && onMeetingPage)
          ? 'joining'
          : 'idle';
  // Start time comes from the Meet client, so the timer survives UI reloads.
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

  // Short notice only for outcomes the operator must act on.
  const notice = $('notice');
  const msg =
    phase === 'denied' ? detail || 'The meeting refused the bot' : phase === 'ended' ? 'Call ended' : signedOut ? 'Sign in with the bot account' : '';
  notice.hidden = !msg;
  notice.textContent = msg;
  notice.className = `notice ${phase === 'denied' || signedOut ? 'bad' : ''}`;
}

function renderState(s: MeetState): void {
  lastState = s;
  // Only shown when NDI is broken.
  const ndi = $('ndiStatus');
  ndi.hidden = s.ndi.ok;
  ndi.textContent = s.ndi.ok ? '' : `NDI unavailable: ${s.ndi.error ?? 'unknown error'}`;
  ndi.className = 'pill bad';

  renderMeetingBar(s.phase, s.url, s.phaseDetail, s.inCallSince);

  renderFeeds(s.feeds);
  const empty = $('empty');
  empty.hidden = s.feeds.length > 0;
  $('emptyTitle').textContent =
    s.phase === 'in-call'
      ? 'Waiting for participants'
      : s.phase === 'waiting'
        ? 'Waiting to be admitted'
        : s.phase === 'signed-out'
          ? 'Sign in required'
          : s.phase === 'denied'
            ? 'Could not join'
            : 'Not in a meeting';

  // Bot output
  const bc = s.botCam;
  $('botCamStatus').textContent =
    bc.source.type === 'none' ? 'No camera source' : `${bc.status}${bc.width ? ` · ${bc.width}×${bc.height} · ${bc.fps}fps` : ''}`;
  // Only surface mic problems; the select already shows the chosen device.
  $('micActive').textContent = s.micActive.startsWith('error') ? `Mic ${s.micActive}` : '';
  setToggle($<HTMLButtonElement>('camToggle'), 'Camera', s.camOn, s.phase === 'in-call' || s.phase === 'green-room');
  setToggle($<HTMLButtonElement>('micToggle'), 'Mic', s.micOn, s.phase === 'in-call' || s.phase === 'green-room');
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
  const cur = camValue(settings.camera);
  const opts: string[] = ['<option value="none">None</option>'];
  const ndi = [...ndiSources];
  if (settings.camera.type === 'ndi' && !ndi.includes(settings.camera.name)) ndi.unshift(settings.camera.name);
  if (ndi.length) opts.push(`<optgroup label="NDI sources">${ndi.map((n) => `<option value="ndi:${esc(n)}">${esc(n)}</option>`).join('')}</optgroup>`);
  const cams = [...devices.videoInputs];
  if (settings.camera.type === 'device' && !cams.includes(settings.camera.name)) cams.unshift(settings.camera.name);
  if (cams.length) opts.push(`<optgroup label="Webcams">${cams.map((n) => `<option value="device:${esc(n)}">${esc(n)}</option>`).join('')}</optgroup>`);
  sel.innerHTML = opts.join('');
  sel.value = cur;
}

function renderMicSelect(): void {
  const sel = $<HTMLSelectElement>('micSource');
  const mics = [...devices.audioInputs];
  if (settings.micLabel && !mics.includes(settings.micLabel)) mics.unshift(settings.micLabel);
  sel.innerHTML = ['<option value="">None (muted)</option>', ...mics.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)].join('');
  sel.value = settings.micLabel;
}

async function refreshNdi(): Promise<void> {
  ndiSources = await api.ndiSources();
  renderCamSelect();
}

// ---------------- settings form ----------------
const SETTING_KEYS = [
  'botName', 'ndiPrefix', 'ndiGroups', 'maxFps', 'graceSeconds', 'meetWindowWidth', 'meetWindowHeight', 'previewFps',
  'screenShare', 'includeSelf', 'autoJoin', 'muteLocalAudio',
] as const;

function initSettingsForm(): void {
  for (const k of SETTING_KEYS) {
    const input = $<HTMLInputElement>(`s_${k}`);
    const v = settings[k];
    if (typeof v === 'boolean') input.checked = v;
    else input.value = String(v);
    input.addEventListener('change', async () => {
      const val = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
      settings = await api.setSettings({ [k]: val } as Partial<Settings>);
    });
  }
}

// ---------------- wiring ----------------
async function init(): Promise<void> {
  settings = await api.getSettings();
  devices = await api.devices();
  $<HTMLInputElement>('meetUrl').value = settings.lastMeetUrl;
  initSettingsForm();
  renderMicSelect();
  await refreshNdi();

  const join = async () => {
    try {
      await api.join($<HTMLInputElement>('meetUrl').value);
    } catch (e) {
      const msg = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      appendLog(msg);
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
    settings = await api.setSettings({ camera });
    // Turning a source on/off also flips Meet's camera toggle.
    if (lastState?.phase === 'in-call') void api.setMeetCamera(camera.type !== 'none');
  });
  $('micSource').addEventListener('change', async () => {
    const micLabel = $<HTMLSelectElement>('micSource').value;
    settings = await api.setSettings({ micLabel });
    if (lastState?.phase === 'in-call') void api.setMeetMic(!!micLabel);
  });
  $('camToggle').addEventListener('click', () => void api.setMeetCamera($('camToggle').dataset.on !== 'true'));
  $('micToggle').addEventListener('click', () => void api.setMeetMic($('micToggle').dataset.on !== 'true'));
  $('dumpBtn').addEventListener('click', async () => {
    const out = await api.dumpDom();
    ($('logDrawer') as HTMLDetailsElement).open = true;
    appendLog('---- Meet DOM dump ----\n' + out + '\n-----------------------');
  });

  api.onState(renderState);
  api.onLog(appendLog);
  api.onPreview(setPreview);
  api.onDevices((d) => {
    devices = d;
    renderCamSelect();
    renderMicSelect();
  });
  setInterval(() => void refreshNdi(), 10000);
  // Keep the call timer ticking between state updates.
  setInterval(() => {
    if (inCallSince) $('callTimer').textContent = fmtDuration(Date.now() - inCallSince);
  }, 1000);
}

void init();
