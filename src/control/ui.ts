// Control window UI. Talks to main only through window.gmeetIso (see control/preload.ts).
import type { ControlApi, FeedState, MeetState, Settings } from '../shared/types';

const api = (window as unknown as { gmeetIso: ControlApi }).gmeetIso;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SETTING_KEYS: (keyof Settings)[] = [
  'ndiPrefix', 'ndiGroups', 'maxFps', 'graceSeconds', 'meetWindowWidth', 'meetWindowHeight',
  'screenShare', 'includeSelf', 'autoJoin', 'muteLocalAudio',
];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function appendLog(line: string): void {
  const el = $('log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.textContent += line + '\n';
  const lines = el.textContent!.split('\n');
  if (lines.length > 500) el.textContent = lines.slice(-500).join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function initSettings(): Promise<void> {
  const s = await api.getSettings();
  for (const k of SETTING_KEYS) {
    const input = $<HTMLInputElement>(`s_${k}`);
    const v = s[k];
    if (typeof v === 'boolean') input.checked = v;
    else input.value = String(v);
    input.addEventListener('change', async () => {
      const patch: Partial<Settings> = {};
      if (input.type === 'checkbox') (patch as Record<string, unknown>)[k] = input.checked;
      else if (input.type === 'number') (patch as Record<string, unknown>)[k] = Number(input.value);
      else (patch as Record<string, unknown>)[k] = input.value;
      await api.setSettings(patch);
    });
  }
}

function statusCell(f: FeedState): string {
  if (!f.enabled) return '<span class="dot off"></span>off';
  if (!f.present) return '<span class="dot gone"></span>tile gone (holding)';
  if (!f.hasVideo || f.slate) return '<span class="dot slate"></span>no video (black)';
  return '<span class="dot live"></span>live';
}

function renderState(s: MeetState): void {
  const ndi = $('ndiStatus');
  ndi.textContent = s.ndi.ok ? `NDI ${(s.ndi.version ?? '').match(/\d+\.\d+\.\d+/)?.[0] ?? 'ok'}` : `NDI: ${s.ndi.error ?? 'unavailable'}`;
  ndi.className = `pill ${s.ndi.ok ? 'ok' : 'bad'}`;
  const call = $('callStatus');
  call.textContent = s.inCall ? 'In call' : 'Not in a call';
  call.className = `pill ${s.inCall ? 'ok' : ''}`;

  const feeds = [...s.feeds].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.kind.localeCompare(b.kind));
  $('feedCount').textContent = feeds.length ? `(${feeds.length})` : '';
  const body = $('feedRows');
  if (!feeds.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted">${s.inCall ? 'In call — waiting for participant tiles…' : 'Join a call. Every participant tile visible in the Meet window becomes an NDI source.'}</td></tr>`;
    return;
  }
  body.innerHTML = feeds
    .map(
      (f) => `<tr>
      <td><input type="checkbox" data-key="${esc(f.key)}" ${f.enabled ? 'checked' : ''} /></td>
      <td>${esc(f.displayName)}${f.kind === 'screen' ? ' <span class="muted">(screen)</span>' : ''}</td>
      <td class="mono">${f.ndiName ? esc(f.ndiName) : '<span class="muted">—</span>'}</td>
      <td class="mono">${f.width ? `${f.width}×${f.height}` : '—'}</td>
      <td class="mono">${f.fps}</td>
      <td>${f.connections ? `<span class="tally">${f.connections}</span>` : '<span class="muted">0</span>'}</td>
      <td>${statusCell(f)}</td>
    </tr>`,
    )
    .join('');
}

function wire(): void {
  $('feedRows').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.key) void api.setFeedEnabled(t.dataset.key, t.checked);
  });
  const join = async () => {
    $('joinError').textContent = '';
    try {
      await api.join($<HTMLInputElement>('meetUrl').value);
    } catch (e) {
      $('joinError').textContent = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };
  $('joinBtn').addEventListener('click', join);
  $('meetUrl').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && void join());
  $('leaveBtn').addEventListener('click', () => void api.leave());
  $('showBtn').addEventListener('click', () => void api.showMeetWindow());
  $('signInBtn').addEventListener('click', () => void api.signIn());
  $('dumpBtn').addEventListener('click', async () => {
    const out = await api.dumpDom();
    appendLog('---- Meet DOM dump ----\n' + out + '\n-----------------------');
  });
  api.onState(renderState);
  api.onLog(appendLog);
}

wire();
void initSettings();
