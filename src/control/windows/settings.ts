// Settings window. Owned by the settings task.
import { initStore } from '../store';
import { h } from '../kit';

void initStore().then(() => {
  document.getElementById('app')!.append(h('div.empty', 'Settings — not built yet'));
});
