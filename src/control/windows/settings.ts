// Settings window: the popped-out form of the Settings dialog (see ../settings/host.ts).
// Opened with ?arg=<category> (e.g. 'logs'); 'remote:commands' / 'remote:logs' pick a Remote control sub-tab.
import { initStore, windowArg } from '../store';
import { mountSettings } from '../settings/host';
import { installWindowChrome } from '../chrome';

void initStore().then(() => {
  window.addEventListener('error', (e) => console.error('[settings]', e.message));
  installWindowChrome();
  document.getElementById('app')!.append(mountSettings(windowArg()).el);
});
