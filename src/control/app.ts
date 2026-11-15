// Main control window entry (bundled by scripts/build-ui.js → dist/ui/app.js).
import { buildShell, showTab, type TabId } from './shell';
import { initStore, inCall, on } from './store';

void initStore().then(() => {
  buildShell(document.getElementById('app')!);
  // Dev hook used by `--cmd=snap-ui:<name>:<tab>`.
  (window as unknown as { __showTab: (t: string) => void }).__showTab = (t) => showTab(t as TabId);
  // Jump to Video Outputs the first time we're in a call (unless the user already navigated).
  let jumped = inCall();
  on('state', () => {
    if (!jumped && inCall()) {
      jumped = true;
      if (document.body.dataset.tab === 'meeting') showTab('video');
    }
  });
});
