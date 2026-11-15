// Meeting tab — replica of ZoomISO v3 MeetingTab (RE 01: TrialBanner · MeetingButtonGroup ·
// MeetingPreviewAndControls · Footer) plus the signed-out Splash (AuthenticatedRoot → Splash).
// Zoom → Meet mapping: Join sheet = Meet link / code; New Meeting / Join Meeting only; Google sign-in.

import type { CameraSource } from '../../shared/types';
import { button, h, icon, popup, type OptList } from '../kit';
import { api, bindPreview, inCall, on, refreshNdi, run, setSettings, store } from '../store';

const VERSION = __APP_VERSION__;

// ---------------------------------------------------------------------------
// MeetingButton (80×80 rounded tile + caption)
function meetingButton(title: string, iconEl: HTMLElement, color: 'orange' | 'blue', onClick: () => void) {
  const tile = h('span.mt-tile', { class: color }, iconEl);
  const b = h('button.mt-button', tile, h('span.mt-title', title)) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}

// ---------------------------------------------------------------------------
// JoinMeetingSheet (JoinMeetingSheetTabs: meetingInfo / url)
type JoinTab = 'meetingInfo' | 'url';
let joinTab: JoinTab = 'meetingInfo';

function openJoinSheet(): void {
  const codeInput = h('input.field', { placeholder: 'abc-defg-hij', spellcheck: 'false' }) as HTMLInputElement;
  const linkInput = h('input.field', { placeholder: 'https://meet.google.com/abc-defg-hij', spellcheck: 'false' }) as HTMLInputElement;
  const last = store.settings.lastMeetUrl || '';
  codeInput.value = /([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(last)?.[1] ?? '';
  linkInput.value = last;
  const err = h('div.mt-sheet-error');

  const panes: Record<JoinTab, HTMLElement> = {
    meetingInfo: h('div.mt-form',
      h('label.mt-form-row', h('span', 'Meeting code'), codeInput),
      h('div.mt-form-row', h('span', 'Display name'), h('span.secondary', store.settings.botName || 'Signed-in Google account'))),
    url: h('div.mt-form', h('label.mt-form-row', h('span', 'Meeting link'), linkInput)),
  };
  const labels: Record<JoinTab, string> = { meetingInfo: 'Meeting Info', url: 'URL' };
  const tabs = h('div.segmented.mt-sheet-tabs');
  const body = h('div.mt-sheet-body');
  const joinBtn = button('Join', () => void submit(), 'primary');
  const select = (t: JoinTab) => {
    joinTab = t;
    for (const b of tabs.children) (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.value === t);
    body.replaceChildren(panes[t]);
    err.textContent = '';
    setTimeout(() => (t === 'url' ? linkInput : codeInput).focus(), 0);
  };
  for (const t of Object.keys(labels) as JoinTab[]) {
    const b = h('button', { dataset: { value: t } }, labels[t]) as HTMLButtonElement;
    b.addEventListener('click', () => select(t));
    tabs.append(b);
  }

  const close = () => layer.remove();
  const submit = async () => {
    let target = '';
    if (joinTab === 'meetingInfo') {
      const v = codeInput.value.trim();
      if (!/^[a-z]{3}-?[a-z]{4}-?[a-z]{3}$/i.test(v)) {
        err.textContent = 'Check the meeting code. It should look like abc-defg-hij.';
        return;
      }
      const c = v.replace(/-/g, '').toLowerCase();
      target = `${c.slice(0, 3)}-${c.slice(3, 7)}-${c.slice(7)}`;
    } else if (joinTab === 'url') {
      const v = linkInput.value.trim();
      if (!/^(https?:\/\/)?meet\.google\.com\/\S+/i.test(v)) {
        err.textContent = 'That is not a valid Google Meet link. Paste a meet.google.com invite URL.';
        return;
      }
      target = /^https?:/i.test(v) ? v : `https://${v}`;
    }
    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining…';
    try {
      await api.join(target);
      close();
    } catch (e) {
      err.textContent = `Failed to join meeting: ${(e as Error).message}`;
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join';
    }
  };
  for (const inp of [codeInput, linkInput])
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit();
      if (e.key === 'Escape') close();
    });

  const layer = h('div.sheet-layer', h('div.sheet.mt-join-sheet', h('h3', 'Join Meeting'), tabs, body, err, h('div.actions', button('Cancel', close), joinBtn)));
  document.body.append(layer);
  select(joinTab);
}

// ---------------------------------------------------------------------------
function footLink(): HTMLElement {
  const a = h('span.link', 'meet.google.com');
  a.addEventListener('click', () => window.open('https://meet.google.com'));
  return a;
}

// Splash (signed out): same structure as ZoomISO's (logo · name + BETA · tagline · Sign in · footer).
function splash(): HTMLElement {
  const signIn = h('button.splash-btn', h('span.ico'), 'Sign in') as HTMLButtonElement;
  signIn.firstElementChild!.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.6"/><path d="M5 8h5.5M8.3 5.6 10.7 8l-2.4 2.4"/></svg>';
  signIn.addEventListener('click', () => void api.signIn());
  return h('div.splash',
    h('div.splash-deco.l'),
    h('div.splash-deco.r'),
    h('div.splash-center',
      h('img.splash-logo', { src: 'icon.png', alt: '' }),
      h('div.splash-name', 'GMeet ISO', h('span.beta-badge', 'BETA')),
      h('div.splash-sub', 'Isolated broadcast outputs from', h('br'), 'Google Meet meetings'),
      signIn),
    h('div.mt-footer', footLink(), h('span', VERSION)));
}

// ---------------------------------------------------------------------------
export function mountMeeting(host: HTMLElement): void {
  host.classList.add('meeting-tab');

  // ---- MeetingButtonGroup
  const newBtn = meetingButton('New Meeting', icon('video.fill'), 'orange', () => void api.join('https://meet.google.com/new'));
  const joinBtn = meetingButton('Join Meeting', icon('plusSquare'), 'blue', openJoinSheet);
  const group = h('div.mt-buttons', newBtn, joinBtn);

  // ---- MeetingPreviewAndControls
  const status = h('div.mt-status');
  const settingsBtn = button(h('span.mt-btn-inner', icon('gear'), 'Open Meet Settings'), () => void api.openWindow('settings', 'inMeeting'), 'mt-small');

  const img = h('img', { alt: '' }) as HTMLImageElement;
  const pvMsg = h('div.mt-preview-msg');
  let hasFrame = false;
  bindPreview('__botcam__', (url) => {
    img.src = url;
    if (!hasFrame) {
      hasFrame = true;
      queueMicrotask(render);
    }
  });
  const preview = h('div.mt-preview', img, pvMsg);

  const setCamera = async (camera: CameraSource) => {
    await setSettings({ camera });
    if (inCall()) void api.setMeetCamera(camera.type !== 'none');
  };
  const inputSource = popup([], '', (v) => {
    const type = v as CameraSource['type'];
    const first = type === 'ndi' ? store.ndiSources[0] : type === 'device' ? store.devices.videoInputs[0] : '';
    void setCamera({ type, name: first ?? '' });
  });
  const source = popup([], '', (v) => void setCamera({ type: store.settings.camera.type, name: v }));
  const refresh = h('button.mt-refresh', { title: 'Refresh NDI sources' }, icon('refresh')) as HTMLButtonElement;
  refresh.addEventListener('click', () => void refreshNdi());
  const sourceLabel = h('span.mt-row-label', 'Camera');

  const mic = popup([], '', async (v) => {
    await setSettings({ micLabel: v });
    if (inCall()) void api.setMeetMic(!!v);
  });
  const speaker = popup([], '', (v) => void setSettings({ monitorDevice: v }));

  // In-meeting: InMeetingAudioButton / InMeetingVideoButton / InMeetingExitMeetingButton, ChatwithGroup
  const audioBtn = h('button.mt-inbtn') as HTMLButtonElement;
  const videoBtn = h('button.mt-inbtn') as HTMLButtonElement;
  const leaveBtn = h('button.mt-inbtn.leave', h('span', 'Leave Meeting')) as HTMLButtonElement;
  audioBtn.addEventListener('click', () => void api.setMeetMic(!store.state?.micOn));
  videoBtn.addEventListener('click', () => void api.setMeetCamera(!store.state?.camOn));
  leaveBtn.addEventListener('click', () => void api.leave());
  const chatField = h('input.field', { placeholder: 'Message everyone', spellcheck: 'false' }) as HTMLInputElement;
  const sendChat = async () => {
    const text = chatField.value.trim();
    if (text && (await run({ cmd: 'chat', text }))) chatField.value = '';
  };
  chatField.addEventListener('keydown', (e) => e.key === 'Enter' && void sendChat());
  const chatBtn = h('button.btn.mt-small', icon('chat.outline'), h('span', 'Chat with group (0)')) as HTMLButtonElement;
  chatBtn.addEventListener('click', () => void sendChat());
  const inMeeting = h('div.mt-inmeeting', h('div.mt-inbtns', audioBtn, videoBtn, leaveBtn), h('div.mt-chat', chatField, chatBtn));

  const row = (label: HTMLElement | string, ...ctl: HTMLElement[]) => h('div.mt-row', typeof label === 'string' ? h('span.mt-row-label', label) : label, ...ctl);
  const panel = h('div.mt-panel',
    status,
    h('div.mt-panel-btns', settingsBtn),
    preview,
    row('Input Source', inputSource.el),
    row(sourceLabel, source.el, refresh),
    row('Microphone', mic.el),
    row('Speaker', speaker.el),
    inMeeting);

  const splashEl = splash();
  host.append(h('div.mt-body', group, panel), h('div.mt-footer', footLink(), h('span', VERSION)));
  document.body.append(splashEl);

  function render(): void {
    const s = store.settings;
    const st = store.state;
    const phase = st?.phase ?? 'loading';
    const live = phase === 'in-call';
    const joining = phase === 'green-room' || phase === 'waiting';
    splashEl.hidden = phase !== 'signed-out';

    status.textContent = live ? 'In Meeting' : joining ? (phase === 'waiting' ? 'Waiting to be admitted' : 'Joining…') : 'Not in Meeting';
    status.className = 'mt-status ' + (live ? 'in' : joining ? 'joining' : 'out');
    newBtn.disabled = live || joining;
    joinBtn.disabled = live || joining;

    const types: OptList = [
      { value: 'device', label: 'Webcam' },
      { value: 'ndi', label: 'NDI' },
      { value: 'none', label: 'None' },
    ];
    inputSource.set(types, s.camera.type);
    let list: string[] = s.camera.type === 'ndi' ? [...store.ndiSources] : s.camera.type === 'device' ? [...store.devices.videoInputs] : [];
    if (s.camera.name && !list.includes(s.camera.name)) list = [s.camera.name, ...list];
    const opts: OptList =
      s.camera.type === 'none' ? [{ value: '', label: '--' }] : list.length ? list.map((n) => ({ value: n, label: n })) : [{ value: '', label: s.camera.type === 'ndi' ? 'Scanning...' : 'No cameras' }];
    source.set(opts, s.camera.name, s.camera.type === 'none' || !list.length);
    sourceLabel.textContent = s.camera.type === 'ndi' ? 'NDI Source' : 'Camera';
    refresh.hidden = s.camera.type !== 'ndi';

    const mics = [...store.devices.audioInputs];
    if (s.micLabel && !mics.includes(s.micLabel)) mics.unshift(s.micLabel);
    mic.set([{ value: '', label: 'None (muted)' }, ...mics.map((m) => ({ value: m, label: m }))], s.micLabel);
    const outs = [...(store.devices.audioOutputs ?? [])];
    if (s.monitorDevice && !outs.includes(s.monitorDevice)) outs.unshift(s.monitorDevice);
    speaker.set([{ value: '', label: 'Same as system' }, ...outs.map((m) => ({ value: m, label: m }))], s.monitorDevice);

    const bc = st?.botCam;
    const label = s.camera.type === 'ndi' ? s.camera.name || 'NDI Input' : s.camera.type === 'device' ? s.camera.name || 'Camera' : 'No Input';
    pvMsg.textContent = s.camera.type === 'none' ? 'No Input' : bc && bc.status !== 'live' ? `${label}\n${bc.status}` : hasFrame ? '' : label;
    pvMsg.hidden = !pvMsg.textContent;
    img.hidden = s.camera.type === 'none' || !hasFrame;

    inMeeting.hidden = !live;
    audioBtn.disabled = st?.micOn == null;
    videoBtn.disabled = st?.camOn == null;
    audioBtn.classList.toggle('off', st?.micOn === false);
    videoBtn.classList.toggle('off', st?.camOn === false);
    audioBtn.replaceChildren(icon(st?.micOn === false ? 'mic.slash.outline' : 'mic.outline'), h('span', st?.micOn === false ? 'Unmute' : 'Mute'));
    videoBtn.replaceChildren(icon(st?.camOn === false ? 'camera.slash.outline' : 'camera.outline'), h('span', st?.camOn === false ? 'Start Video' : 'Stop Video'));
    const n = (st?.participants ?? []).filter((p) => p.kind === 'camera' && !p.isSelf).length;
    (chatBtn.lastChild as HTMLElement).textContent = `Chat with group (${n})`;
  }
  on('settings', render);
  on('state', render);
  on('devices', render);
  on('ndi', render);
  render();
}
