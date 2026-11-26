// Settings panes added to match Presentation Player: Keyboard shortcuts and Updates.
import { h, icon } from '../kit';
import { api, setSettings, store } from '../store';
import { row, sbtn, section, tog } from './ui';

const keys = (...k: string[]) => h('span.s-keys', ...k.flatMap((x, i) => (i ? ['+', h('kbd', x)] : [h('kbd', x)])));
const alt = (...groups: HTMLElement[]) => h('span.s-keys', ...groups.flatMap((g, i) => (i ? [' or ', g] : [g])));

// ---------------------------------------------------------------- Keyboard shortcuts
export function shortcutsPane(): HTMLElement {
  return h(
    'div.s-pane',
    section('Anywhere', [
      row('Settings', keys('Ctrl', ',')),
      row('Meeting · Video outputs · Audio outputs · Participants', alt(keys('Ctrl', '1'), keys('Ctrl', '4')), { hint: 'Ctrl 1 to Ctrl 4, in tab order' }),
      row('Close a dialog or menu', keys('Esc')),
      row('Help', keys('F1')),
      row('Quit', keys('Ctrl', 'Q'), { hint: 'Leaves the meeting cleanly first' }),
    ]),
    section('Configuration', [
      row('Export configuration', keys('Ctrl', 'S'), { hint: 'Outputs, routing and settings, as a show file' }),
      row('Load configuration', keys('Ctrl', 'O')),
    ]),
    section('Meeting', [
      row('Join the meeting link you typed', keys('Enter')),
      row('Send a chat message', keys('Enter')),
      row('New line in a chat message', keys('Shift', 'Enter')),
    ]),
    section('Output effects window', [row('Apply changes (when Auto apply is off)', keys('Ctrl', 'Enter'))]),
  );
}

// ---------------------------------------------------------------- Updates
export function updatesPane(): HTMLElement {
  const u = store.system?.update;
  const current = u?.current || __APP_VERSION__.replace(/^v/, '');
  const when = u?.checkedAt ? new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  let status: HTMLElement;
  switch (u?.status) {
    case 'checking':
      status = h('span.s-status', 'Checking…');
      break;
    case 'current':
      status = h('span.s-status.ok', icon('checkCircle'), `Up to date${when ? ` · checked ${when}` : ''}`);
      break;
    case 'available':
      status = h('span.s-status.warn', icon('download'), `Version ${u.latest} is available`);
      break;
    case 'unavailable':
    case 'error':
      status = h('span.s-status.warn', icon('warn'), u.message ?? "Couldn't check for updates");
      break;
    default:
      status = h('span.s-status', 'Not checked yet');
  }
  const check = sbtn('Check now', async () => {
    check.disabled = true;
    await api.checkUpdates?.();
  }, { disabled: u?.status === 'checking' });
  const open = sbtn(u?.status === 'available' ? 'Download' : 'Open releases page', () => u?.url && void api.openExternal?.(u.url), {
    cls: u?.status === 'available' ? 'primary' : '',
    disabled: !u?.url,
  });

  return h(
    'div.s-pane',
    section(
      'Updates',
      [
        row('Version', h('span.s-dim', current)),
        row('Status', status),
        row('', [check, open]),
        row('Check automatically', tog(store.settings.checkForUpdates, (v) => void setSettings({ checkForUpdates: v })), {
          hint: 'When the app starts and every 6 hours. Only asks GitHub for the latest version.',
        }),
      ],
      { subtitle: 'New versions are installed with the installer from the releases page. The app never updates or restarts by itself during a show.' },
    ),
  );
}
