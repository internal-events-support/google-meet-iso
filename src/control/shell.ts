// App shell: unified top bar (tabs, recording, settings; the Google account is in Settings),
// tab host and the bottom Return Feed / system bar. Tabs mount lazily into the host.

import type { CameraSource } from '../shared/types';
import { button, confirmSheet, h, icon, popup, segmented, type OptList } from './kit';
import { openSettingsDialog, windowButtons } from './chrome';
import { openRecordingPopover } from './recording';
import { api, bindPreviewCanvas, inCall, on, run, setSettings, store } from './store';
import { mountAudio } from './tabs/audio';
import { mountMeeting } from './tabs/meeting';
import { mountParticipants } from './tabs/participants';
import { mountVideo } from './tabs/video';

export type TabId = 'meeting' | 'video' | 'audio' | 'participants';
const TABS: { id: TabId; label: string; mount: (host: HTMLElement) => void }[] = [
  { id: 'meeting', label: 'Meeting', mount: mountMeeting },
  { id: 'video', label: 'Video outputs', mount: mountVideo },
  { id: 'audio', label: 'Audio outputs', mount: mountAudio },
  { id: 'participants', label: 'Participants', mount: mountParticipants },
];

const hosts = new Map<TabId, HTMLElement>();
const mounted = new Set<TabId>();
let current: TabId = 'meeting';
let nav: ReturnType<typeof segmented>;

/** Switch tabs (also used by tabs, e.g. Meeting → Video after joining). */
export function showTab(id: TabId): void {
  current = id;
  nav?.set(id);
  for (const [tid, host] of hosts) host.hidden = tid !== id;
  if (!mounted.has(id)) {
    mounted.add(id);
    TABS.find((t) => t.id === id)!.mount(hosts.get(id)!);
  }
  document.body.dataset.tab = id;
}

export function currentTab(): TabId {
  return current;
}

// ---------------------------------------------------------------------------
/** Pill button: icon + label (the label hides in narrow windows, see shell.css). */
function pill(ic: string, label: string, cls = ''): HTMLButtonElement {
  return h('button.btn.pill' + cls, { type: 'button', title: label }, icon(ic), h('span.pill-label', label)) as HTMLButtonElement;
}

/** Meeting code from a Meet URL ("abc-defg-hij"), or ''. */
function meetingCode(url: string | undefined): string {
  const m = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(url ?? '');
  return m ? m[1] : '';
}

/**
 * Top bar, like Presentation Player's: app name · what's going on (meeting code + status
 * caption) · warning pills for things that need you, Recording, Settings, window buttons.
 * The tabs sit in their own row below, so nothing collides in narrow windows.
 */
function topBar(): HTMLElement {
  // Centre: meeting context
  const title = h('h1.ctx-title');
  const meta = h('span.caption.ctx-meta');
  const copyBtn = h('button.btn.btn-plain.icon-only.ctx-copy', { type: 'button', title: 'Copy meeting link', 'aria-label': 'Copy meeting link' }, icon('copy')) as HTMLButtonElement;
  copyBtn.addEventListener('click', () => {
    const url = store.state?.url;
    if (!url) return;
    void navigator.clipboard?.writeText(url);
    copyBtn.title = 'Copied';
    setTimeout(() => (copyBtn.title = 'Copy meeting link'), 1500);
  });
  const ctx = h('div.ctx', h('div.ctx-row', title, copyBtn), meta);
  const renderCtx = () => {
    const st = store.state;
    const phase = st?.phase ?? 'loading';
    const code = meetingCode(st?.url);
    const inMeeting = !!code && ['in-call', 'waiting', 'green-room'].includes(phase);
    const active = ['in-call', 'waiting', 'green-room'].includes(phase);
    title.textContent = inMeeting ? code : active ? 'In a meeting' : 'No meeting';
    copyBtn.hidden = !inMeeting;
    const people = (st?.participants ?? []).filter((p) => !p.isSelf).length;
    const since = st?.inCallSince ?? 0;
    const parts: string[] = [];
    switch (phase) {
      case 'in-call':
        parts.push('In call');
        if (since) parts.push(fmt(Date.now() - since));
        parts.push(`${people} participant${people === 1 ? '' : 's'}`);
        break;
      case 'waiting': parts.push('Waiting to be let in'); break;
      case 'green-room': parts.push('Joining…'); break;
      case 'signed-out': parts.push('Signed out'); break;
      case 'denied': parts.push('Not let in'); break;
      case 'ended': parts.push('Call ended'); break;
      case 'loading': parts.push('Starting…'); break;
      default: parts.push('Ready to join');
    }
    meta.textContent = parts.join(' · ');
  };
  on('state', renderCtx);
  setInterval(renderCtx, 1000);

  // Warning pills (only when something needs you), as in Presentation Player.
  const signInAgain = pill('warn', 'Sign in again', '.warn');
  signInAgain.addEventListener('click', () => void api.signIn());
  const ndiWarn = pill('warn', 'NDI not available', '.warn.chip');
  ndiWarn.addEventListener('click', () => openSettingsDialog('ndi'));
  const restartDue = pill('refresh', 'Restart to apply', '.warn');
  restartDue.addEventListener('click', async () => {
    const inMeeting = ['in-call', 'waiting', 'green-room'].includes(store.state?.phase ?? '');
    const ok = await confirmSheet('Restart now?', `NDI network changes apply after a restart.${inMeeting ? ' The bot leaves the meeting and you need to join again.' : ''}`, 'Restart', inMeeting);
    if (ok) void api.restartApp?.();
  });
  const updateReady = pill('download', 'Update');
  updateReady.addEventListener('click', () => openSettingsDialog('updates'));
  const renderPills = () => {
    const st = store.state;
    const sy = store.system;
    signInAgain.hidden = st?.phase !== 'signed-out' || !store.settings.botName;
    ndiWarn.hidden = !st || st.ndi?.ok !== false;
    ndiWarn.title = st?.ndi?.error ? `NDI not available: ${st.ndi.error}` : 'NDI not available';
    restartDue.hidden = !sy?.restartNeeded;
    restartDue.title = 'Some saved settings (NDI network) take effect after a restart';
    updateReady.hidden = sy?.update?.status !== 'available';
    updateReady.title = sy?.update?.latest ? `Version ${sy.update.latest} is available` : 'A new version is available';
  };
  on('state', renderPills);
  on('system', renderPills);
  on('settings', renderPills);

  // Recording button: "Configure recording" ↔ red running pill with timer.
  const recBtn = pill('record', 'Configure recording', '.rec-pill');
  const recLabel = recBtn.querySelector('.pill-label') as HTMLElement;
  recBtn.addEventListener('click', () => openRecordingPopover(recBtn));
  const renderRec = () => {
    const recs = (store.state?.outputs ?? []).filter((o) => o.recording);
    recBtn.classList.toggle('running', recs.length > 0);
    if (!recs.length) recLabel.textContent = 'Configure recording';
  };
  on('state', renderRec);
  setInterval(() => {
    const since = recordingSince();
    if (since) recLabel.innerHTML = `<span class="timer">${fmt(Date.now() - since)}</span>`;
  }, 500);

  const settingsBtn = pill('gear', 'Settings');
  settingsBtn.title = 'Settings (Ctrl ,)';
  settingsBtn.addEventListener('click', () => void api.openWindow('settings'));

  renderCtx();
  renderPills();
  return h('header.topbar',
    h('div.topbar-left', h('span.app-title', 'Google Meet ISO')),
    ctx,
    h('div.topbar-right', h('div.pills', signInAgain, ndiWarn, restartDue, updateReady), recBtn, settingsBtn, windowButtons()));
}

/** Tab strip under the top bar. */
function tabBar(): HTMLElement {
  nav = segmented(TABS.map((t) => ({ value: t.id, label: t.label })), current, (v) => showTab(v as TabId));
  nav.el.querySelectorAll('button').forEach((b, i) => b.setAttribute('title', `${TABS[i]?.label ?? ''} (Ctrl ${i + 1})`));
  return h('nav.tabbar', nav.el);
}

/** Earliest start among running recordings (state carries only a flag; track locally). */
const recStarted = new Map<string, number>();
function recordingSince(): number {
  const now = Date.now();
  const running = new Set((store.state?.outputs ?? []).filter((o) => o.recording).map((o) => o.id));
  for (const id of running) if (!recStarted.has(id)) recStarted.set(id, now);
  for (const id of [...recStarted.keys()]) if (!running.has(id)) recStarted.delete(id);
  return recStarted.size ? Math.min(...recStarted.values()) : 0;
}
function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
function camOpts(): { type: OptList; device: OptList } {
  const c = store.settings.camera;
  const type: OptList = [
    { value: 'device', label: 'Webcam' },
    { value: 'ndi', label: 'NDI' },
    { value: 'none', label: 'None' },
  ];
  let list: string[] = [];
  if (c.type === 'ndi') list = [...store.ndiSources];
  if (c.type === 'device') list = [...store.devices.videoInputs];
  if (c.name && !list.includes(c.name)) list.unshift(c.name);
  const device: OptList = c.type === 'none' ? [{ value: '', label: '--' }] : list.length ? list.map((n) => ({ value: n, label: n })) : [{ value: '', label: c.type === 'ndi' ? 'No NDI sources' : 'No cameras' }];
  return { type, device };
}

export function returnFeedBar(): HTMLElement {
  const img = h('canvas') as HTMLCanvasElement;
  const msg = h('div.well-msg', 'No camera');
  bindPreviewCanvas('__botcam__', img);
  const preview = h('div.well.rf-preview', img, msg);

  const micBtn = h('button.rf-toggle', icon('mic'), 'Audio') as HTMLButtonElement;
  const camBtn = h('button.rf-toggle', icon('video'), 'Video') as HTMLButtonElement;
  micBtn.addEventListener('click', () => void api.setMeetMic(!store.state?.micOn));
  camBtn.addEventListener('click', () => void api.setMeetCamera(!store.state?.camOn));

  const setCamera = async (camera: CameraSource) => {
    await setSettings({ camera });
    if (inCall()) void api.setMeetCamera(camera.type !== 'none');
  };
  const inputSource = popup([], '', (v) => {
    const type = v as CameraSource['type'];
    const first = type === 'ndi' ? store.ndiSources[0] : type === 'device' ? store.devices.videoInputs[0] : '';
    void setCamera({ type, name: first ?? '' });
  });
  const camera = popup([], '', (v) => void setCamera({ type: store.settings.camera.type, name: v }));
  const mic = popup([], '', async (v) => {
    await setSettings({ micLabel: v });
    if (inCall()) void api.setMeetMic(!!v);
  });
  const speaker = popup([], '', (v) => void setSettings({ monitorDevice: v }));

  const field = (control: HTMLElement, caption: string) => h('div.rf-field', control, h('span.caption', caption));
  const render = () => {
    const s = store.settings;
    const o = camOpts();
    inputSource.set(o.type, s.camera.type);
    camera.set(o.device, s.camera.name, s.camera.type === 'none');
    const mics = [...store.devices.audioInputs];
    if (s.micLabel && !mics.includes(s.micLabel)) mics.unshift(s.micLabel);
    mic.set([{ value: '', label: 'None (muted)' }, ...mics.map((m) => ({ value: m, label: m }))], s.micLabel);
    const outs = [...(store.devices.audioOutputs ?? [])];
    if (s.monitorDevice && !outs.includes(s.monitorDevice)) outs.unshift(s.monitorDevice);
    speaker.set([{ value: '', label: 'Same as system' }, ...outs.map((m) => ({ value: m, label: m }))], s.monitorDevice);
    const st = store.state;
    const live = st?.phase === 'in-call' || st?.phase === 'green-room';
    micBtn.disabled = !live || st?.micOn === null;
    camBtn.disabled = !live || st?.camOn === null;
    micBtn.classList.toggle('off', st?.micOn === false);
    camBtn.classList.toggle('off', st?.camOn === false);
    micBtn.querySelector('.ico')!.innerHTML = icon(st?.micOn === false ? 'micSlash' : 'mic').innerHTML;
    camBtn.querySelector('.ico')!.innerHTML = icon(st?.camOn === false ? 'videoSlash' : 'video').innerHTML;
    const bc = st?.botCam;
    const status = s.camera.type === 'none' ? 'No camera' : bc && bc.status !== 'live' ? bc.status : '';
    const isErr = /^error/i.test(status);
    // Errors read "error: …" from the camera source: show the reason, full text on hover.
    msg.textContent = isErr ? status.replace(/^error:\s*/i, '') : status;
    msg.title = status;
    msg.classList.toggle('err', isErr);
    msg.hidden = !msg.textContent;
    if (s.camera.type === 'none') img.removeAttribute('src');
  };
  on('settings', render);
  on('state', render);
  on('devices', render);
  on('ndi', render);

  // System stats
  const cpu = h('span');
  const ram = h('span');
  const net = h('span');
  const outs = h('span');
  const perfBtn = button('Performance details', () => void api.openWindow('perf'), 'sm');
  const renderSys = () => {
    const sy = store.system;
    if (!sy) return;
    cpu.textContent = `CPU ${Math.round(sy.cpu)}%`;
    ram.textContent = `RAM ${(sy.memMB / 1024).toFixed(1)} GB`;
    net.textContent = `Network in ${(store.state?.rxMbps ?? 0).toFixed(0)} Mb/s`;
    const live = (store.state?.outputs ?? []).filter((o) => o.status === 'live').length;
    outs.textContent = `Outputs live ${live}/${store.settings.outputs.filter((o) => o.enabled).length}`;
  };
  on('system', renderSys);
  on('state', renderSys);

  const meetLink = h('span.link', 'meet.google.com');
  meetLink.addEventListener('click', () => store.state?.url && navigator.clipboard?.writeText(store.state.url));

  const bar = h('footer.bottombar',
    preview,
    h('div.rf-title', h('h2', 'Return feed'), h('div.rf-toggles', micBtn, camBtn)),
    h('div.rf-fields', field(inputSource.el, 'Input source'), field(camera.el, 'Camera'), field(mic.el, 'Microphone'), field(speaker.el, 'Speaker')),
    h('div.rf-spacer'),
    h('div.rf-stats', h('div.col', cpu, ram), h('div.col', outs, net), perfBtn),
    h('div.rf-right', h('div.version', meetLink, h('span', __APP_VERSION__))));
  render();
  renderSys();
  return bar;
}

// ---------------------------------------------------------------------------
export function buildShell(root: HTMLElement): void {
  const tabhost = h('main.tabhost');
  for (const t of TABS) {
    const host = h('section.tab', { dataset: { tab: t.id } });
    host.hidden = true;
    hosts.set(t.id, host);
    tabhost.append(host);
  }
  root.append(topBar(), tabBar(), tabhost, returnFeedBar());
  // Settings opens here as a dialog (menu, Ctrl+, and other windows route through main).
  api.onOpenSettings?.((arg) => openSettingsDialog(arg));
  // Ctrl+1…4: tabs.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const t = TABS[Number(e.key) - 1];
    if (t && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      showTab(t.id);
    }
  });
  // Start on Video once in a call, otherwise Meeting.
  showTab(inCall() ? 'video' : 'meeting');
}
