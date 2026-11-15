// Grid view: one card per output with live preview, meters and output controls
// (ZoomISO v3 "Grid View").

import type { OutputConfig, OutputState } from '../../shared/types';
import { h, icon, iconButton, meterV, popup, toggle } from '../kit';
import { bindPreview, updateOutput } from '../store';
import {
  addOutput, AUDIO_OPTS, cfgById, deviceModel, FORMAT_OPTS, formatValue, MODE_OPTS, openEffects, outputMenu,
  quickActions, selectionModel, setDevice, setFormat, setMode, setSelection, statusLine,
} from './common';

export interface OutputView {
  el: HTMLElement;
  update(cfg: OutputConfig, st: OutputState | undefined): void;
  destroy(): void;
}

/** Live preview well bound to an output id (shared by grid + previews views). */
export function previewWell(id: string) {
  const img = h('img', { alt: '', draggable: false }) as HTMLImageElement;
  const msg = h('div.well-msg');
  const el = h('div.well.vo-well', img, msg);
  let got = false;
  const unbind = bindPreview(id, (url) => {
    if (img.hidden) return;
    img.src = url;
    if (!got) {
      got = true;
      el.classList.add('has-frame');
    }
  });
  return {
    el,
    set(cfg: OutputConfig, st: OutputState | undefined) {
      const off = !cfg.enabled || !st || st.status === 'off';
      img.hidden = off;
      if (off) {
        img.removeAttribute('src');
        got = false;
        el.classList.remove('has-frame');
      }
      const text = !cfg.enabled ? 'Output disabled' : off ? '' : got ? '' : 'Waiting for video…';
      if (msg.textContent !== text) msg.textContent = text;
      msg.hidden = !text;
      el.classList.toggle('pgm', !!st?.program);
      el.classList.toggle('pvw', !st?.program && !!st?.preview);
    },
    destroy: unbind,
  };
}

function field(control: HTMLElement, caption: string): HTMLElement {
  return h('div.vo-field', control, h('span.caption', caption));
}

export function gridCard(cfg0: OutputConfig): OutputView {
  const id = cfg0.id;
  const cfg = () => cfgById(id);
  const name = h('span.vo-name');
  const enabled = toggle(cfg0.enabled, (v) => void updateOutput(id, { enabled: v }), { title: 'Output enabled' });
  const fx = iconButton('sliders', () => openEffects(id), 'Output Effects', 'vo-fx');
  const more = iconButton('ellipsis', () => outputMenu(more, cfg), 'More', 'vo-more');
  const header = h('div.vo-head', name, h('span.vo-head-r', enabled.el, fx, more));

  const well = previewWell(id);
  well.el.title = 'Double-click for Output Effects';
  well.el.addEventListener('dblclick', () => openEffects(id));
  const mL = meterV();
  const mR = meterV();
  const prev = h('div.vo-prev', well.el, h('div.vo-meters', mL.el, mR.el));

  const mode = popup(MODE_OPTS, cfg0.mode, (v) => {
    const c = cfg();
    if (c) setMode(c, v as OutputConfig['mode']);
  }, { title: 'Output Mode' });
  const sel = popup([], '', (v) => {
    const c = cfg();
    if (c) setSelection(c, v);
  }, { title: 'Selection' });
  const status = statusLine();
  const qa = quickActions(() => id, { talk: true });

  const device = popup([], 'ndi', (v) => {
    const c = cfg();
    if (c) setDevice(c, v);
  });
  const format = popup(FORMAT_OPTS, formatValue(cfg0), (v) => {
    const c = cfg();
    if (c) setFormat(c, v);
  });
  const audio = popup(AUDIO_OPTS, cfg0.audio, (v) => void updateOutput(id, { audio: v as OutputConfig['audio'] }));

  const el = h('div.vo-card', { dataset: { id } },
    header,
    prev,
    h('div.vo-row.two', mode.el, sel.el),
    h('div.vo-row.status', status.el, qa.el),
    h('div.vo-row.three', field(device.el, 'Output Device'), field(format.el, 'Format'), field(audio.el, 'Embedded Audio')));

  return {
    el,
    update(c, st) {
      if (name.textContent !== c.name) name.textContent = c.name;
      el.classList.toggle('disabled', !c.enabled);
      enabled.set(c.enabled);
      well.set(c, st);
      const lvl = c.enabled ? (st?.audioLevel ?? 0) : 0;
      mL.set(lvl);
      mR.set(lvl);
      mode.set(MODE_OPTS, c.mode);
      const sm = selectionModel(c, st);
      sel.set(sm.opts, sm.value, sm.disabled);
      status.set(c, st);
      qa.set(st);
      const dm = deviceModel(c);
      device.set(dm.opts, dm.value);
      format.set(FORMAT_OPTS, formatValue(c));
      audio.set(AUDIO_OPTS, c.audio);
    },
    destroy: well.destroy,
  };
}

export function addTile(): HTMLElement {
  const b = h('button.vo-add-btn', { title: 'Add Output' }, icon('plus'));
  b.addEventListener('click', addOutput);
  return h('div.vo-add', b);
}
