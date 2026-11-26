// Video Outputs tab (ZoomISO v3 VideoOutputsTab).
// Toolbar: "Number of Outputs" CustomStepper (+ "Show Overlays" in Previews) | ViewArrangementSelection
// (Previews / Grid / List). Body: VideoOutputMultiview | VideoOutputGrid | VideoOutputTable.

import { OUTPUT_ARRANGEMENT_OPTIONS, type OutputConfig, type Settings } from '../../shared/types';
import { confirmSheet, h, segmented, stepper, toggle } from '../kit';
import { on, outputState, run, setSettings, store } from '../store';
import { reconcile } from '../video/common';
import { addTile, gridCard, type OutputView } from '../video/grid';
import { listRow, listShell } from '../video/list';
import { multiviewColumns, multiviewTile } from '../video/multiview';

type Arrangement = Settings['outputsView'];
const ARR_ICON: Record<Arrangement, string> = { multiview: 'previews', grid: 'grid', list: 'list' };
const OVERLAYS_KEY = 'vo.showOverlays';
const MAX_OUTPUTS = 32;

export function mountVideo(host: HTMLElement): void {
  host.classList.add('vo-tab');

  // ---------------- toolbar
  let pending: number | null = null;
  const count = stepper(store.settings.outputs.length, (n) => void setCount(n), 0, MAX_OUTPUTS);
  async function setCount(n: number): Promise<void> {
    const cur = store.settings.outputs.length;
    if (n === cur) return;
    if (n < cur) {
      const gone = store.settings.outputs.slice(n).map((o) => o.name);
      const ok = await confirmSheet(
        'Delete output' + (gone.length > 1 ? 's' : ''),
        `Are you sure you want to delete ${gone.map((g) => `"${g}"`).join(', ')}?`,
        'Delete', true);
      if (!ok) {
        count.set(cur);
        return;
      }
    }
    pending = n;
    await run({ cmd: 'setOutputCount', count: n });
    pending = null;
  }

  const showOv = toggle(localStorage.getItem(OVERLAYS_KEY) === '1', (v) => {
    localStorage.setItem(OVERLAYS_KEY, v ? '1' : '0');
    body.classList.toggle('show-overlays', v);
  }, { cls: 'sm', title: 'Show overlays' });
  const ovWrap = h('label.vo-ov-toggle', 'Show overlays', showOv.el);

  const arr = segmented(
    OUTPUT_ARRANGEMENT_OPTIONS.map((o) => ({ value: o.value, label: o.label, icon: ARR_ICON[o.value] })),
    store.settings.outputsView,
    (v) => {
      show(v as Arrangement);
      void setSettings({ outputsView: v as Arrangement });
    },
    'sm vo-arr');

  const bar = h('div.vo-bar',
    h('div.vo-bar-l', h('span.vo-count-label', 'Number of outputs'), count.el, ovWrap),
    h('div.vo-bar-r', arr.el));

  // ---------------- views
  const body = h('div.vo-body');
  body.classList.toggle('show-overlays', showOv.input.checked);

  const gridEl = h('div.vo-grid');
  const add = addTile();
  const gridViews = new Map<string, OutputView>();

  const list = listShell();
  const rowViews = new Map<string, ReturnType<typeof listRow>>();

  const mvEl = h('div.vo-mv');
  const mvViews = new Map<string, OutputView>();

  const empty = h('div.empty.vo-empty', 'No outputs');
  body.append(mvEl, gridEl, list.el, empty);
  host.append(bar, body);

  let current: Arrangement = store.settings.outputsView;

  function layoutMultiview(): void {
    const n = mvViews.size;
    if (!n || current !== 'multiview') return;
    const r = body.getBoundingClientRect();
    const pad = 12;
    const { cols, tileW } = multiviewColumns(n, Math.max(0, r.width - pad * 2), Math.max(0, r.height - pad * 2));
    mvEl.style.setProperty('--mv-w', `${Math.floor(tileW)}px`);
    mvEl.style.maxWidth = `${Math.floor(tileW) * cols + 1}px`;
  }
  new ResizeObserver(layoutMultiview).observe(body);

  function render(): void {
    const outs: OutputConfig[] = store.settings.outputs;
    if (pending === null) count.set(outs.length);
    empty.hidden = outs.length > 0 || current === 'grid' || current === 'list';
    if (current === 'grid') {
      if (add.parentNode !== gridEl) gridEl.append(add);
      reconcile(gridEl, gridViews, outs, (c) => gridCard(c), add);
      for (const c of outs) gridViews.get(c.id)?.update(c, outputState(c.id));
    } else if (current === 'list') {
      reconcile(list.tbody, rowViews, outs, (c, i) => listRow(c, i));
      outs.forEach((c, i) => {
        const v = rowViews.get(c.id)!;
        v.setIndex(i);
        v.update(c, outputState(c.id));
      });
    } else {
      const before = mvViews.size;
      reconcile(mvEl, mvViews, outs, (c) => multiviewTile(c));
      for (const c of outs) mvViews.get(c.id)?.update(c, outputState(c.id));
      if (before !== mvViews.size) layoutMultiview();
    }
  }

  function clear(views: Map<string, { el: HTMLElement; destroy(): void }>): void {
    for (const v of views.values()) {
      v.destroy();
      v.el.remove();
    }
    views.clear();
  }

  function show(v: Arrangement): void {
    if (!['multiview', 'grid', 'list'].includes(v)) v = 'grid';
    current = v;
    arr.set(v);
    body.dataset.view = v;
    ovWrap.hidden = v !== 'multiview';
    // Only the visible arrangement holds preview subscriptions.
    if (v !== 'grid') clear(gridViews);
    if (v !== 'list') clear(rowViews);
    if (v !== 'multiview') clear(mvViews);
    gridEl.hidden = v !== 'grid';
    list.el.hidden = v !== 'list';
    mvEl.hidden = v !== 'multiview';
    render();
    layoutMultiview();
  }

  on('settings', () => {
    if (store.settings.outputsView !== current) show(store.settings.outputsView);
    else render();
  });
  on('state', render);
  show(current);
}
