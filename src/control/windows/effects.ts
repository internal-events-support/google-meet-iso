// Output Effects window. Owned by the effects task.
import { initStore } from '../store';
import { h } from '../kit';

void initStore().then(() => {
  document.getElementById('app')!.append(h('div.empty', 'Output Effects — not built yet'));
});
