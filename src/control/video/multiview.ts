// VideoOutputMultiview / MultiviewTile (ZoomISO v3 "Previews" arrangement, page11_img01).
// Edge-to-edge 16:9 tiles, rows centred. Overlay (on hover, or always with "Show Overlays"):
// output name (top-left), Output Effects (top-right), EmbeddedAudioIndicators (right edge),
// Mode | Selection | ParticipantControls along the bottom.

import type { OutputConfig } from '../../shared/types';
import { h, iconButton, popup } from '../kit';
import { cfgById, MODE_OPTS, openEffects, quickActions, selectionModel, setMode, setSelection } from './common';
import { audioIndicators, previewWell, recordingBadge, setTally, type OutputView } from './grid';

export function multiviewTile(cfg0: OutputConfig): OutputView {
  const id = cfg0.id;
  const cfg = () => cfgById(id);
  const well = previewWell(id);
  well.el.addEventListener('dblclick', () => openEffects(id));
  const name = h('span.mv-name');
  const rec = recordingBadge();
  const fx = iconButton('sliders', () => openEffects(id), 'Output effects', 'mv-fx');
  const meters = audioIndicators();
  const mode = popup(MODE_OPTS, cfg0.mode, (v) => {
    const c = cfg();
    if (c) setMode(c, v as OutputConfig['mode']);
  }, { cls: 'sm mv-pop', title: 'Mode' });
  const sel = popup([], '', (v) => {
    const c = cfg();
    if (c) setSelection(c, v);
  }, { cls: 'sm mv-pop', title: 'Selection' });
  const qa = quickActions(() => id);
  const overlay = h('div.mv-ov',
    h('div.mv-top', h('span.mv-label', name, rec.el), fx),
    meters.el,
    h('div.mv-bottom', mode.el, sel.el, qa.el));
  const el = h('div.mv-tile', { dataset: { id } }, well.el, overlay);
  return {
    el,
    update(c, st) {
      if (name.textContent !== c.name) name.textContent = c.name;
      el.classList.toggle('disabled', !c.enabled);
      setTally(el, st);
      rec.set(!!st?.recording);
      well.set(c, st);
      meters.set(c, st);
      mode.set(MODE_OPTS, c.mode);
      const sm = selectionModel(c, st);
      sel.set(sm.opts, sm.value, sm.disabled);
      qa.set(st);
    },
    destroy: well.destroy,
  };
}

/** Pick the column count that gives the largest 16:9 tile inside w×h. */
export function multiviewColumns(n: number, w: number, hgt: number): { cols: number; tileW: number } {
  let best = { cols: 1, tileW: 0 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    const tw = Math.min(w / cols, (hgt / rows) * (16 / 9));
    if (tw > best.tileW + 0.5) best = { cols, tileW: tw };
  }
  return best;
}
