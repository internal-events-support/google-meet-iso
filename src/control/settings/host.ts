// Settings (RE ApplicationSettingsWindow): sidebar of categories + the selected pane. Mounted
// either as a dialog in the main window (default, like Presentation Player) or in its own
// window (popped out). `arg` picks the category: e.g. 'logs', 'account', 'remote:commands'.
import { on, store } from '../store';
import { h, icon } from '../kit';
import type { SettingsTab } from '../../shared/types';
import { accountPane, generalPane, inMeetingPane, outputEffectsPane, videoLossPane, setRerender } from './panes';
import { ndiPane, recordingPane, logsPane } from './panes2';
import { shortcutsPane, updatesPane } from './panes3';
import { normalizeSettings } from './ui';
import { oscPane, setOscSubTab, commandStats, type OscSubTab } from './osc';

// Sentence case, in Presentation Player's order: what you set up most, first.
const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'monitor' },
  { id: 'inMeeting', label: 'In meeting', icon: 'videoCam' },
  { id: 'outputEffects', label: 'Output effects', icon: 'sliders' },
  { id: 'videoLoss', label: 'Video loss', icon: 'videoLoss' },
  { id: 'ndiAndSrt', label: 'NDI', icon: 'ndi' },
  { id: 'recording', label: 'Recording', icon: 'record' },
  { id: 'account', label: 'Google account', icon: 'person' },
  { id: 'osc', label: 'Remote control', icon: 'oscGlyph' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard' },
  { id: 'updates', label: 'Updates', icon: 'download' },
  { id: 'logs', label: 'Logs', icon: 'doc' },
];

const ALIASES: Record<string, SettingsTab> = {
  general: 'general', inmeeting: 'inMeeting', 'in-meeting': 'inMeeting', outputeffects: 'outputEffects', effects: 'outputEffects',
  videoloss: 'videoLoss', loss: 'videoLoss', audioinputsandtalkback: 'general', talkback: 'general', audio: 'general',
  ndiandsrt: 'ndiAndSrt', ndi: 'ndiAndSrt', srt: 'ndiAndSrt', osc: 'osc', remote: 'osc', api: 'osc', recording: 'recording',
  account: 'account', google: 'account', shortcuts: 'shortcuts', keys: 'shortcuts', updates: 'updates', update: 'updates', logs: 'logs', log: 'logs',
};

export function parseSettingsArg(arg: string): { tab: SettingsTab; sub?: OscSubTab } {
  const [t, s] = arg.split(':');
  const tab = ALIASES[(t ?? '').toLowerCase()] ?? 'general';
  const sub = tab === 'osc' && (s === 'logs' || s === 'commands' || s === 'settings') ? (s as OscSubTab) : undefined;
  return { tab, sub };
}

export interface SettingsHost {
  el: HTMLElement;
  /** Show a category ('logs', 'remote:commands', …). */
  select(arg: string): void;
  /** Current category (for popping out to the same place). */
  current(): SettingsTab;
}

/** One settings UI per renderer (dialog in the main window, or the Settings window). */
export function mountSettings(arg: string): SettingsHost {
  let current: SettingsTab = 'general';
  let dispose = () => {};
  const scrollPos = new Map<SettingsTab, number>();
  const sidebar = h('nav.s-sidebar', { role: 'tablist', 'aria-label': 'Settings' });
  const content = h('main.s-content');

  function renderSidebar(): void {
    sidebar.replaceChildren(
      ...TABS.map((t) => {
        const b = h('button.s-tab' + (t.id === current ? '.active' : ''), { type: 'button', role: 'tab', dataset: { tab: t.id } }, icon(t.icon), h('span', t.label));
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
      case 'ndiAndSrt': el = ndiPane(); break;
      case 'recording': el = recordingPane(); break;
      case 'account': el = accountPane(); break;
      case 'shortcuts': el = shortcutsPane(); break;
      case 'updates': el = updatesPane(); break;
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

  /** Re-render on external changes, but never while the user is typing in a field. */
  let pending = false;
  function refresh(): void {
    if (!el.isConnected) return;
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

  const el = h('div.s-window', sidebar, content);
  const first = parseSettingsArg(arg);
  if (first.sub) setOscSubTab(first.sub);
  current = first.tab;
  setRerender(renderContent);
  renderSidebar();
  renderContent();

  on('settings', refresh);
  // Account pane follows sign-in / sign-out; Updates and Remote control follow system info.
  let lastPhase = '';
  on('state', () => {
    const p = store.state?.phase === 'signed-out' ? 'out' : 'in';
    if (p !== lastPhase) {
      lastPhase = p;
      if (current === 'account') refresh();
    }
  });
  let lastSys = '';
  on('system', () => {
    const sy = store.system;
    const sig = JSON.stringify([sy?.update, sy?.apiUrls, sy?.restartNeeded]);
    if (sig === lastSys) return;
    lastSys = sig;
    if (current === 'updates' || (current === 'osc' && !content.querySelector('.s-osc-box.logs, .s-osc-box.commands'))) refresh();
  });
  on('devices', () => current === 'inMeeting' && refresh());
  on('ndi', () => current === 'inMeeting' && store.settings.camera.type === 'ndi' && refresh());

  const host: SettingsHost = {
    el,
    select(a: string) {
      const p = parseSettingsArg(a);
      if (p.sub) setOscSubTab(p.sub);
      if (p.tab === current && !p.sub) return;
      current = p.tab;
      renderSidebar();
      renderContent();
    },
    current: () => current,
  };
  // Dev hook for CLI self-checks (eval-win:settings:__settings.select('osc:commands')).
  (window as unknown as Record<string, unknown>).__settings = {
    select: (t: string) => {
      host.select(t);
      return current;
    },
    commandStats,
  };
  return host;
}
