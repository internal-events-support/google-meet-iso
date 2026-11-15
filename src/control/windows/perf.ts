// Performance Details window. Owned by the perf task.
import { initStore } from '../store';
import { h } from '../kit';

void initStore().then(() => {
  document.getElementById('app')!.append(h('div.empty', 'Performance Details — not built yet'));
});
