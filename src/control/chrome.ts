// Window chrome shared by every UI window: our own minimise / maximise / close buttons in the
// title bar (frameless windows, as in Presentation Player), and the Settings dialog of the
// main window (Settings can be popped out into its own window).
import { h, icon } from './kit';
import { api } from './store';
import { mountSettings, type SettingsHost } from './settings/host';

let stateWired = false;

/** Caption buttons; the window's maximised state toggles `is-maximized` on <html>. */
export function windowButtons(): HTMLElement {
  if (!stateWired) {
    stateWired = true;
    api.onWindowState?.((s) => document.documentElement.classList.toggle('is-maximized', s.maximized));
  }
  const b = (a: 'minimize' | 'maximize' | 'close', label: string, svg: string, cls = '') => {
    const el = h('button' + cls, { type: 'button', title: label, 'aria-label': label, tabindex: '-1' }) as HTMLButtonElement;
    el.innerHTML = svg;
    el.addEventListener('click', () => api.windowAction?.(a));
    return el;
  };
  return h(
    'div.win-buttons',
    b('minimize', 'Minimise', '<svg viewBox="0 0 10 10"><path d="M0 5.5h10"/></svg>'),
    b(
      'maximize',
      'Maximise',
      '<svg class="i-max" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" rx="1"/></svg><svg class="i-restore" viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7" rx="1"/><path d="M2.5 2.5v-1a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"/></svg>',
    ),
    b('close', 'Close', '<svg viewBox="0 0 10 10"><path d="m0 0 10 10M10 0 0 10"/></svg>', '.win-close'),
  );
}

/** Secondary windows (Settings, Output effects, Performance details): buttons on their title bar. */
export function installWindowChrome(): void {
  const bar = document.querySelector('.titlebar');
  if (bar && !bar.querySelector('.win-buttons')) bar.append(h('div.titlebar-spacer'), windowButtons());
}

// ---------------------------------------------------------------- Settings dialog
let dialog: HTMLDialogElement | null = null;
let host: SettingsHost | null = null;

/** Open Settings in the main window (at `arg`, e.g. 'logs', 'account', 'remote:commands'). */
export function openSettingsDialog(arg = ''): void {
  if (!dialog || !host) {
    host = mountSettings(arg);
    const popOut = h('button.btn.btn-plain.icon-only', { type: 'button', title: 'Open in its own window', 'aria-label': 'Open in its own window' }, icon('popOut')) as HTMLButtonElement;
    const close = h('button.btn.btn-plain.icon-only', { type: 'button', title: 'Close (Esc)', 'aria-label': 'Close' }, icon('x')) as HTMLButtonElement;
    dialog = h(
      'dialog.modal.settings-modal',
      { 'aria-label': 'Settings' },
      h('div.modal-card', h('header.modal-head', h('h2', 'Settings'), h('div.modal-actions', popOut, close)), host.el),
    ) as HTMLDialogElement;
    popOut.addEventListener('click', () => {
      const at = host!.current();
      dialog!.close();
      void api.popOutSettings?.(at);
    });
    close.addEventListener('click', () => dialog!.close());
    // Click on the backdrop closes it, like Presentation Player's dialogs.
    dialog.addEventListener('mousedown', (e) => e.target === dialog && dialog!.close());
    document.body.append(dialog);
  } else if (arg) host.select(arg);
  if (!dialog.open) {
    dialog.showModal();
    // Don't start with a focus ring on the first header button.
    (document.activeElement as HTMLElement | null)?.blur();
  }
}
