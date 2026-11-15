// Meeting tab — changes with the call state:
//   • not in a call: centred join card (link/code, New meeting, recent meetings, account, phase status)
//   • in a call: dashboard (header strip · chat · waiting room · at a glance · meeting options)
//   • signed out: full-window Splash (unchanged behaviour)
// Devices, camera preview and mic/cam toggles live in the Return Feed bar, which shows here too.

import type { ChatMessage, MeetState, ParticipantState } from '../../shared/types';
import { button, confirmSheet, fmtDuration, h, icon, textField, toggle } from '../kit';
import { api, on, run, setSettings, store } from '../store';

const VERSION = __APP_VERSION__;

function footLink(): HTMLElement {
  const a = h('span.link', 'meet.google.com');
  a.addEventListener('click', () => window.open('https://meet.google.com'));
  return a;
}

// Splash (signed out)
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
const CODE_RE = /([a-z]{3}-[a-z]{4}-[a-z]{3})/i;

function meetCode(url: string): string {
  return CODE_RE.exec(url)?.[1]?.toLowerCase() ?? url.replace(/^https?:\/\/(meet\.google\.com\/)?/i, '').split(/[?#]/)[0];
}

/** Turn whatever the user pasted into a Meet URL, or null if it isn't one. */
function normaliseTarget(v: string): string | null {
  v = v.trim();
  if (!v) return null;
  if (/^[a-z]{3}-?[a-z]{4}-?[a-z]{3}$/i.test(v)) {
    const c = v.replace(/-/g, '').toLowerCase();
    return `https://meet.google.com/${c.slice(0, 3)}-${c.slice(3, 7)}-${c.slice(7)}`;
  }
  if (/^(https?:\/\/)?meet\.google\.com\/\S+/i.test(v)) return /^https?:/i.test(v) ? v : `https://${v}`;
  return null;
}

function phaseText(st: MeetState | null): { text: string; cls: string } {
  const phase = st?.phase ?? 'loading';
  const d = st?.phaseDetail?.trim();
  switch (phase) {
    case 'loading': return { text: d || 'Starting Meet…', cls: 'muted' };
    case 'home': return { text: 'Not in a meeting', cls: 'muted' };
    case 'green-room': return { text: d || 'Joining…', cls: 'busy' };
    case 'waiting': return { text: d || 'Waiting to be admitted…', cls: 'busy' };
    case 'denied': return { text: d || 'Denied — someone in the meeting declined the request', cls: 'error' };
    case 'ended': return { text: d || 'Meeting ended', cls: 'muted' };
    case 'signed-out': return { text: 'Signed out', cls: 'muted' };
    default: return { text: d || '', cls: 'muted' };
  }
}

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Not in a call: join view
function joinView() {
  const link = h('input.field.mt-join-input', { placeholder: 'Paste a Meet link or code', spellcheck: 'false' }) as HTMLInputElement;
  const err = h('div.mt-join-err');
  const status = h('div.mt-status');
  const joinBtn = button('Join', () => void join(link.value), 'primary mt-join-btn');
  const newBtn = button(h('span.mt-inl', icon('plus'), 'New meeting'), () => void join('https://meet.google.com/new'), 'mt-new-btn');
  link.addEventListener('keydown', (e) => e.key === 'Enter' && void join(link.value));
  link.addEventListener('input', () => (err.textContent = ''));

  let busy = false;
  async function join(raw: string) {
    const url = normaliseTarget(raw);
    if (!url) {
      err.textContent = raw.trim() ? 'That isn’t a Meet link or code (abc-defg-hij).' : 'Paste a Meet link or code first.';
      link.focus();
      return;
    }
    err.textContent = '';
    busy = true;
    render();
    try {
      await run({ cmd: 'join', url });
    } finally {
      busy = false;
      render();
    }
  }

  const recentList = h('div.mt-recent-list');
  const recent = h('div.mt-recent', h('div.mt-label', 'Recent meetings'), recentList);
  let recentKey = '';

  const account = h('span.mt-account-name');
  const switchBtn = button('Switch account', () => void api.signIn(), 'sm');
  const accountRow = h('div.mt-account', icon('person'), account, switchBtn);

  const card = h('div.mt-join-card.card',
    h('div.mt-brand', h('img.mt-logo', { src: 'icon.png', alt: '' }), h('div', h('div.mt-brand-name', 'GMeet ISO'), h('div.mt-brand-sub', 'Isolated broadcast outputs from Google Meet'))),
    status,
    h('div.mt-join-row', link, joinBtn),
    err,
    newBtn,
    recent,
    h('div.mt-sep'),
    accountRow);
  const el = h('div.mt-join', card);

  function render() {
    const st = store.state;
    const s = store.settings;
    const phase = st?.phase ?? 'loading';
    const joining = busy || phase === 'green-room' || phase === 'waiting';
    joinBtn.disabled = newBtn.disabled = joining;
    joinBtn.textContent = joining ? 'Joining…' : 'Join';
    const p = phaseText(st);
    status.textContent = p.text;
    status.className = `mt-status ${p.cls}`;
    status.hidden = !p.text;
    account.textContent = s.botName || 'Google account';
    account.title = s.botName;

    const urls = s.recentMeetUrls ?? [];
    const key = urls.join('|') + (joining ? '1' : '0');
    if (key === recentKey) return;
    recentKey = key;
    recent.hidden = !urls.length;
    recentList.replaceChildren(...urls.slice(0, 5).map((u) => {
      const rm = h('button.mt-x', { title: 'Remove from recent' }, icon('x')) as HTMLButtonElement;
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        void setSettings({ recentMeetUrls: (store.settings.recentMeetUrls ?? []).filter((x) => x !== u) });
      });
      const row = h('div.mt-recent-row', { title: `Rejoin ${u}`, class: joining ? 'disabled' : '' }, icon('videoCam'), h('span.mt-recent-code', meetCode(u)), h('span.mt-recent-act', 'Rejoin'), rm);
      row.addEventListener('click', () => !joining && void join(u));
      return row;
    }));
  }
  return { el, render };
}

// ---------------------------------------------------------------------------
// In a call: dashboard
function dashboard() {
  // ---- header strip
  const codeBtn = h('button.mt-code', { title: 'Copy meeting link' }) as HTMLButtonElement;
  const codeText = h('span.mt-code-t');
  const copied = h('span.mt-copied', 'Copied');
  codeBtn.append(codeText, icon('copy'), copied);
  let copyTimer = 0;
  codeBtn.addEventListener('click', () => {
    const url = store.state?.url;
    if (!url) return;
    void navigator.clipboard?.writeText(url);
    codeBtn.classList.add('done');
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => codeBtn.classList.remove('done'), 1500);
  });
  const timer = h('span');
  const count = h('span');
  const role = h('span');
  const roleChip = h('span.mt-chip', { title: 'The bot’s role in this meeting' }, icon('crown'), role);
  const chip = (ico: string, v: HTMLElement, title: string) => h('span.mt-chip', { title }, icon(ico), v);
  const leave = button('Leave', async () => {
    if (await confirmSheet('Leave meeting?', 'The bot will leave the call and every output will lose its source.', 'Leave', true)) void run({ cmd: 'leave' });
  }, 'danger mt-leave');
  const header = h('div.mt-head.card', h('span.mt-live-dot'), codeBtn, chip('record', timer, 'Time in call'), chip('people', count, 'Participants'), roleChip, h('span.mt-flex'), leave);

  // ---- chat
  const chatList = h('div.mt-chat-list');
  const chatEmpty = h('div.mt-empty', icon('chat'), h('span', 'Chat history will appear here'));
  const ta = h('textarea.field.mt-composer', { placeholder: 'Message everyone  (Shift+Enter for a new line)', rows: '1', spellcheck: 'true' }) as HTMLTextAreaElement;
  const sendBtn = button('Send', () => void send(), 'primary mt-send');
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(120, Math.max(32, ta.scrollHeight))}px`;
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  async function send() {
    const text = ta.value.trim();
    if (!text || sendBtn.disabled) return;
    sendBtn.disabled = true;
    try {
      if ((await run({ cmd: 'chat', text })) !== undefined) {
        ta.value = '';
        grow();
        chatList.scrollTop = chatList.scrollHeight;
      }
    } finally {
      sendBtn.disabled = false;
      ta.focus();
    }
  }
  const chatCount = h('span.mt-badge');
  const chatCard = h('section.mt-chat.card', h('div.mt-card-h', icon('chat'), 'Meeting chat', chatCount), h('div.mt-chat-body', chatList, chatEmpty), h('div.mt-compose', ta, sendBtn));
  const renderedIds: string[] = [];
  function renderChat(msgs: ChatMessage[] | undefined) {
    const list = msgs ?? [];
    chatEmpty.hidden = list.length > 0;
    chatList.hidden = list.length === 0;
    chatCount.textContent = String(list.length);
    chatCount.hidden = !list.length;
    // Append-only when the rendered ids are a prefix of the new list; otherwise rebuild.
    const prefix = renderedIds.length <= list.length && renderedIds.every((id, i) => list[i].id === id);
    if (prefix && renderedIds.length === list.length) return;
    const atBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 32;
    if (!prefix) {
      chatList.replaceChildren();
      renderedIds.length = 0;
    }
    for (let i = renderedIds.length; i < list.length; i++) {
      const m = list[i];
      const prev = list[i - 1];
      const cont = !!prev && prev.from === m.from && prev.self === m.self && m.time - prev.time < 5 * 60e3;
      chatList.append(h('div.mt-msg', { class: (m.self ? 'self' : '') + (cont ? ' cont' : '') },
        cont ? null : h('div.mt-msg-meta', h('b', m.self ? 'You' : m.from), h('span', hhmm(m.time))),
        h('div.mt-bubble', m.text)));
      renderedIds.push(m.id);
    }
    if (atBottom || !prefix) chatList.scrollTop = chatList.scrollHeight;
  }

  // ---- waiting room
  const waitList = h('div.mt-wait-list');
  const waitEmpty = h('div.mt-empty.sm', 'No one is waiting');
  const waitHint = h('div.mt-hint', icon('info'), 'The bot must be a host to admit people');
  const admitAll = button('Admit all', () => void run({ cmd: 'admit', who: 'all' }), 'sm');
  const waitBadge = h('span.mt-badge.alert');
  const waitCard = h('section.card.mt-side', h('div.mt-card-h', icon('people'), 'Waiting room', waitBadge, h('span.mt-flex'), admitAll), waitHint, waitList, waitEmpty);
  let waitSig = '';
  function renderWaiting(names: string[], canAdmit: boolean) {
    waitEmpty.hidden = names.length > 0;
    waitList.hidden = !names.length;
    admitAll.hidden = !names.length;
    admitAll.disabled = !canAdmit;
    waitHint.hidden = canAdmit;
    waitBadge.textContent = String(names.length);
    waitBadge.hidden = !names.length;
    const sig = names.join('\n') + canAdmit;
    if (sig === waitSig) return;
    waitSig = sig;
    waitList.replaceChildren(...names.map((n) => {
      const deny = button('Deny', () => void run({ cmd: 'deny', who: n }), 'sm');
      const admit = button('Admit', () => void run({ cmd: 'admit', who: n }), 'sm primary');
      deny.disabled = admit.disabled = !canAdmit;
      return h('div.mt-wait-row', h('span.mt-avatar', (n.trim()[0] ?? '?').toUpperCase()), h('span.mt-wait-name', { title: n }, n), deny, admit);
    }));
  }

  // ---- at a glance
  const speaker = h('span.mt-gl-v');
  const hands = h('span.mt-gl-v');
  const presenting = h('span.mt-gl-v');
  const gl = (ico: string, label: string, v: HTMLElement) => h('div.mt-gl-row', icon(ico), h('span.mt-gl-k', label), v);
  const glanceCard = h('section.card.mt-side', h('div.mt-card-h', icon('eye'), 'At a glance'), gl('waveform', 'Speaking', speaker), gl('hand', 'Raised hands', hands), gl('screen', 'Presenting', presenting));

  // ---- options
  const autoAdmit = toggle(store.settings.autoAdmit, (v) => void setSettings({ autoAdmit: v }));
  const autoLayout = toggle(store.settings.autoLayout, (v) => void setSettings({ autoLayout: v }));
  const notice = textField(store.settings.joinNotice, (v) => void setSettings({ joinNotice: v }), { placeholder: 'Empty = off', cls: 'mt-notice' });
  const opt = (label: string, sub: string, ctl: HTMLElement) => h('label.mt-opt', h('span.mt-opt-t', h('span', label), h('span.caption', sub)), ctl);
  const optsCard = h('section.card.mt-side', h('div.mt-card-h', icon('gear'), 'Meeting options'),
    opt('Admit everyone automatically', 'Let people in as soon as they ask', autoAdmit.el),
    opt('Keep all participants visible', 'Tiled layout so every feed can be captured', autoLayout.el),
    h('div.mt-opt.col', h('span.mt-opt-t', h('span', 'Join notice'), h('span.caption', 'Posted in chat when the bot joins')), notice.el));

  const el = h('div.mt-dash', header, h('div.mt-grid', chatCard, h('div.mt-col', waitCard, glanceCard, optsCard)));

  const nameOf = (ps: ParticipantState[], key: string | null | undefined) => {
    if (!key) return '';
    const p = ps.find((x) => x.key === key || x.participantId === key || x.displayName === key);
    return p ? (p.isSelf ? `${p.displayName} (bot)` : p.displayName) : key;
  };
  const setV = (e: HTMLElement, v: string) => {
    e.textContent = v || '—';
    e.classList.toggle('none', !v);
    e.title = v;
  };

  function tick() {
    const since = store.state?.inCallSince;
    timer.textContent = since ? fmtDuration(Date.now() - since) : '--:--';
  }
  setInterval(tick, 1000);

  function render() {
    const st = store.state;
    const s = store.settings;
    if (!st) return;
    const ps = st.participants ?? [];
    codeText.textContent = meetCode(st.url || '') || 'Meeting';
    tick();
    const cams = ps.filter((p) => p.kind === 'camera');
    count.textContent = `${cams.length} ${cams.length === 1 ? 'participant' : 'participants'}`;
    const self = ps.find((p) => p.isSelf);
    const isHost = !!(self?.isHost || self?.isCohost);
    role.textContent = self?.isHost ? 'Host' : self?.isCohost ? 'Co-host' : 'Participant';
    roleChip.classList.toggle('host', isHost);

    renderChat(st.chat);
    renderWaiting(st.waiting ?? [], isHost);

    setV(speaker, nameOf(ps, st.activeSpeaker));
    setV(hands, ps.filter((p) => p.handRaised && p.kind === 'camera').map((p) => p.displayName).join(', '));
    const pres = st.presenter ? [nameOf(ps, st.presenter)] : ps.filter((p) => p.kind === 'screen').map((p) => p.displayName);
    setV(presenting, [...new Set(pres)].join(', '));

    autoAdmit.set(s.autoAdmit);
    autoLayout.set(s.autoLayout);
    notice.set(s.joinNotice);
  }
  return { el, render };
}

// ---------------------------------------------------------------------------
export function mountMeeting(host: HTMLElement): void {
  host.classList.add('meeting-tab');
  const jv = joinView();
  const db = dashboard();
  const splashEl = splash();
  host.append(jv.el, db.el);
  document.body.append(splashEl);

  function render(): void {
    const st = store.state;
    const live = !!st && (st.inCall || st.phase === 'in-call');
    splashEl.hidden = st?.phase !== 'signed-out';
    jv.el.hidden = live;
    db.el.hidden = !live;
    if (live) db.render();
    else jv.render();
  }
  on('settings', render);
  on('state', render);
  render();
}
