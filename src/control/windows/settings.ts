// Settings window (RE ApplicationSettingsWindow): sidebar of SettingsTabButtons + the selected category.
// Opened with ?arg=<SettingsTab> (e.g. 'logs' from Window → Show Logging); 'osc:commands' / 'osc:logs' pick an OSC sub-tab.
import { initStore, on, windowArg, store } from '../store';
import { h, icon } from '../kit';
import type { SettingsTab } from '../../shared/types';
import { generalPane, inMeetingPane, outputEffectsPane, videoLossPane, setRerender } from '../settings/panes';
import { talkbackPane, ndiPane, recordingPane, logsPane } from '../settings/panes2';
import { normalizeSettings } from '../settings/ui';
import { oscPane, setOscSubTab, commandStats, type OscSubTab } from '../settings/osc';

// Sidebar labels/icons as in the ZoomISO screenshots (page18…28).
const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'general', label: 'General Settings', icon: 'monitor' },
  { id: 'inMeeting', label: 'In-meeting', icon: 'videoCam' },
  { id: 'outputEffects', label: 'Output Effects', icon: 'sliders' },
  { id: 'videoLoss', label: 'Video Loss', icon: 'videoLoss' },
  { id: 'audioInputsAndTalkback', label: 'Audio Inputs and Talkback', icon: 'headset' },
  { id: 'ndiAndSrt', label: 'NDI and SRT', icon: 'ndi' },
  { id: 'osc', label: 'OSC', icon: 'oscGlyph' },
  { id: 'recording', label: 'Recording', icon: 'record' },
  { id: 'logs', label: 'Logs', icon: 'doc' },
];

const ALIASES: Record<string, SettingsTab> = {
  general: 'general', inmeeting: 'inMeeting', 'in-meeting': 'inMeeting', outputeffects: 'outputEffects', effects: 'outputEffects',
  videoloss: 'videoLoss', loss: 'videoLoss', audioinputsandtalkback: 'audioInputsAndTalkback', talkback: 'audioInputsAndTalkback', audio: 'audioInputsAndTalkback',
  ndiandsrt: 'ndiAndSrt', ndi: 'ndiAndSrt', srt: 'ndiAndSrt', osc: 'osc', recording: 'recording', logs: 'logs', log: 'logs',
};

function parseArg(arg: string): { tab: SettingsTab; sub?: OscSubTab } {
  const [t, s] = arg.split(':');
  const tab = ALIASES[(t ?? '').toLowerCase()] ?? 'general';
  const sub = tab === 'osc' && (s === 'logs' || s === 'commands' || s === 'settings') ? (s as OscSubTab) : undefined;
  return { tab, sub };
}

let current: SettingsTab = 'general';
let dispose = () => {};
const scrollPos = new Map<SettingsTab, number>();

const sidebar = h('nav.s-sidebar');
const content = h('main.s-content');

function renderSidebar(): void {
  sidebar.replaceChildren(
    ...TABS.map((t) => {
      const b = h('button.s-tab' + (t.id === current ? '.active' : ''), { type: 'button', dataset: { tab: t.id } }, icon(t.icon), h('span', t.label));
      b.addEventListener('click', () => select(t.id));
      return b;
    }),
  );
}

function renderContent(): void {
  const scroller = content.querySelector('.s-scroll');
  if (scroller) scrollPos.set(current, scroller.scrollTop);
  dispose();
  dispose = () => {};
  normalizeSettings();
  let el: HTMLElement;
  let fill = false;
  switch (current) {
    case 'inMeeting': el = inMeetingPane(); break;
    case 'outputEffects': el = outputEffectsPane(); break;
    case 'videoLoss': el = videoLossPane(); break;
    case 'audioInputsAndTalkback': el = talkbackPane(); break;
    case 'ndiAndSrt': el = ndiPane(); break;
    case 'recording': el = recordingPane(); break;
    case 'osc': {
      const o = oscPane(renderContent);
      el = o.el;
      dispose = o.dispose;
      fill = true;
      break;
    }
    case 'logs': {
      const l = logsPane();
      el = l.el;
      dispose = l.dispose;
      fill = true;
      break;
    }
    default: el = generalPane();
  }
  const wrap = fill ? h('div.s-fill', el) : h('div.s-scroll', el);
  content.replaceChildren(wrap);
  content.dataset.tab = current;
  if (!fill) wrap.scrollTop = scrollPos.get(current) ?? 0;
}

function select(tab: SettingsTab): void {
  if (tab === current && content.firstChild) return;
  const scroller = content.querySelector('.s-scroll');
  if (scroller) scrollPos.set(current, scroller.scrollTop);
  current = tab;
  renderSidebar();
  renderContent();
}

/** Re-render on external changes, but never while the user is typing in a field of this window. */
let pending = false;
function refresh(): void {
  const a = document.activeElement as HTMLElement | null;
  const typing = !!a && content.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|number)$/.test((a as HTMLInputElement).type)));
  if (typing) {
    if (!pending) {
      pending = true;
      a!.addEventListener('blur', () => {
        pending = false;
        setTimeout(refresh, 0);
      }, { once: true });
    }
    return;
  }
  // The log lists update themselves; a rebuild would only reset their scroll.
  if (current === 'logs' || (current === 'osc' && content.querySelector('.s-osc-box.logs'))) return;
  renderContent();
}

void initStore().then(() => {
  window.addEventListener('error', (e) => console.error('[settings]', e.message));
  const { tab, sub } = parseArg(windowArg());
  if (sub) setOscSubTab(sub);
  current = tab;
  setRerender(renderContent);
  document.getElementById('app')!.append(h('div.s-window', sidebar, content));
  renderSidebar();
  renderContent();
  on('settings', refresh);
  on('devices', () => current === 'inMeeting' && refresh());
  on('ndi', () => current === 'inMeeting' && store.settings.camera.type === 'ndi' && refresh());
  // Dev hook for CLI self-checks (eval-win:settings:__settings.select('osc:commands')).
  (window as unknown as Record<string, unknown>).__settings = {
    select: (t: string) => {
      const p = parseArg(t);
      if (p.sub) setOscSubTab(p.sub);
      current = p.tab;
      renderSidebar();
      renderContent();
      return current;
    },
    commandStats,
  };
});
