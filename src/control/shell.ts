// App shell: unified top bar (capture engine, tabs, recording, settings, account),
// tab host and the bottom Return Feed / system bar. Tabs mount lazily into the host.

import type { CameraSource } from '../shared/types';
import { button, h, icon, popover, popup, segmented, textField, toggle, type OptList } from './kit';
import { openRecordingPopover } from './recording';
import { api, bindPreview, inCall, on, run, setSettings, store } from './store';
import { mountAudio } from './tabs/audio';
import { mountMeeting } from './tabs/meeting';
import { mountParticipants } from './tabs/participants';
import { mountVideo } from './tabs/video';

export type TabId = 'meeting' | 'video' | 'audio' | 'participants';
const TABS: { id: TabId; label: string; mount: (host: HTMLElement) => void }[] = [
  { id: 'meeting', label: 'Meeting', mount: mountMeeting },
  { id: 'video', label: 'Video Outputs', mount: mountVideo },
  { id: 'audio', label: 'Audio Outputs', mount: mountAudio },
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
function topBar(): HTMLElement {
  // Capture engine pill (Off ↔ Live; Standby is reachable via OSC/API and shows amber).
  const pillLabel = h('span', 'Capture Disabled');
  const sw = toggle(false, (v) => void run({ cmd: 'engine', state: v ? 'enabled' : 'disabled' }));
  const pill = h('div.capture-pill', icon('gearFill'), pillLabel, sw.el);
  const renderPill = () => {
    const e = store.settings.engine;
    pill.classList.toggle('on', e === 'enabled');
    pill.classList.toggle('standby', e === 'standby');
    pillLabel.textContent = e === 'enabled' ? 'Capture Enabled' : e === 'standby' ? 'Capture Standby' : 'Capture Disabled';
    sw.set(e !== 'disabled');
  };
  on('settings', renderPill);
  renderPill();

  nav = segmented(TABS.map((t) => ({ value: t.id, label: t.label })), current, (v) => showTab(v as TabId));

  // Recording button: "Configure Recording" ↔ red running pill with timer.
  const recLabel = h('span', 'Configure Recording');
  const recBtn = h('button.btn.pill.rec-pill', icon('record'), recLabel) as HTMLButtonElement;
  recBtn.addEventListener('click', () => openRecordingPopover(recBtn));
  const renderRec = () => {
    const recs = (store.state?.outputs ?? []).filter((o) => o.recording);
    recBtn.classList.toggle('running', recs.length > 0);
    if (!recs.length) recLabel.textContent = 'Configure Recording';
  };
  on('state', renderRec);
  setInterval(() => {
    const since = recordingSince();
    if (since) recLabel.innerHTML = `<span class="timer">${fmt(Date.now() - since)}</span>`;
  }, 500);

  const settingsBtn = h('button.btn.pill', icon('gear'), 'Settings') as HTMLButtonElement;
  settingsBtn.addEventListener('click', () => void api.openWindow('settings'));

  const avatar = h('div.avatar', { title: '' });
  const renderAvatar = () => {
    const name = store.settings.botName || '';
    avatar.textContent = name ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '';
    avatar.title = name ? `Signed in as ${name}` : 'Not signed in';
    avatar.style.background = name ? 'var(--blue)' : 'var(--control)';
  };
  avatar.addEventListener('click', () => {
    const name = store.settings.botName;
    const body = h('div', { style: 'display:flex;flex-direction:column;gap:10px;min-width:200px' },
      h('div', { style: 'font-weight:600' }, name || 'Not signed in'),
      h('div.caption', 'Google account used by the hidden Meet client'),
      button(name ? 'Switch account…' : 'Sign in…', () => void api.signIn(), 'block'));
    popover(avatar, body, { align: 'end' });
  });
  on('settings', renderAvatar);
  renderAvatar();

  return h('header.topbar',
    h('div.left', pill, h('span.app-title', 'GMeet ISO')),
    h('div.center', nav.el),
    h('div.right', recBtn, settingsBtn, avatar));
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
  const img = h('img', { alt: '' }) as HTMLImageElement;
  const msg = h('div.well-msg', 'No camera');
  bindPreview('__botcam__', (url) => {
    img.src = url;
  });
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
    msg.textContent = s.camera.type === 'none' ? 'No camera' : bc && bc.status !== 'live' ? bc.status : '';
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
  const perfBtn = button('Open Performance Details', () => void api.openWindow('perf'), 'sm');
  const renderSys = () => {
    const sy = store.system;
    if (!sy) return;
    cpu.textContent = `CPU: ${Math.round(sy.cpu)}%`;
    ram.textContent = `RAM: ${(sy.memMB / 1024).toFixed(1)} GB`;
    net.textContent = `Network in: ${(store.state?.rxMbps ?? 0).toFixed(0)}Mbps`;
    const live = (store.state?.outputs ?? []).filter((o) => o.status === 'live').length;
    outs.textContent = `Outputs live: ${live}/${store.settings.outputs.filter((o) => o.enabled).length}`;
  };
  on('system', renderSys);
  on('state', renderSys);

  // Chat with group
  const chatBtn = h('button.btn', icon('chat'), h('span', 'Chat with group')) as HTMLButtonElement;
  chatBtn.addEventListener('click', () => {
    const tf = textField('', () => {}, { placeholder: 'Message everyone', cls: '' });
    tf.el.style.width = '100%';
    const send = async () => {
      const text = tf.el.value.trim();
      if (!text) return;
      const ok = await run({ cmd: 'chat', text });
      if (ok) close();
    };
    tf.el.addEventListener('keydown', (e) => e.key === 'Enter' && void send());
    const body = h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, h('div', { style: 'font-weight:600' }, 'Send to everyone'), tf.el, h('div', { style: 'display:flex;justify-content:flex-end' }, button('Send', () => void send(), 'primary')));
    const close = popover(chatBtn, body, { width: 300, align: 'end' });
    setTimeout(() => tf.el.focus(), 0);
  });
  const renderChat = () => {
    const n = (store.state?.participants ?? []).filter((p) => p.kind === 'camera').length;
    (chatBtn.lastChild as HTMLElement).textContent = `Chat with group (${n})`;
    chatBtn.disabled = !inCall();
  };
  on('state', renderChat);

  const meetLink = h('span.link', 'meet.google.com');
  meetLink.addEventListener('click', () => store.state?.url && navigator.clipboard?.writeText(store.state.url));

  const bar = h('footer.bottombar',
    preview,
    h('div.rf-title', h('h2', 'Return Feed'), h('div.rf-toggles', micBtn, camBtn)),
    h('div.rf-fields', field(inputSource.el, 'Input Source'), field(camera.el, 'Camera'), field(mic.el, 'Microphone'), field(speaker.el, 'Speaker')),
    h('div.rf-spacer'),
    h('div.rf-stats', h('div.col', cpu, ram), h('div.col', outs, net), perfBtn),
    h('div.rf-right', chatBtn, h('div.version', meetLink, h('span', 'v0.2.0 (beta)'))));
  render();
  renderSys();
  renderChat();
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
  root.append(topBar(), tabhost, returnFeedBar());
  // Start on Video once in a call, otherwise Meeting.
  showTab(inCall() ? 'video' : 'meeting');
}
