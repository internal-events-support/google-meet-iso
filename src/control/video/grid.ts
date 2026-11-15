// VideoOutputGrid / OutputCard (ZoomISO v3 "Grid" arrangement, page09_img01/img02).
// Card: StreamTitle + RecordingBadge | StreamToggleView, OpenOutputEffectsButton, OutputStreamOptions (⋯)
//       VideoPreviewAndAudioIndicators
//       OutputCardControls: Mode | Selection, StreamStatusView | ParticipantControls (+Talk),
//                           Output Device | Format | Embedded Audio (captions underneath).

import type { OutputConfig, OutputState } from '../../shared/types';
import { h, icon, iconButton, meterV, popup, toggle } from '../kit';
import { bindPreview, updateOutput } from '../store';
import {
  addOutput, AUDIO_OPTS, cfgById, deviceModel, FORMAT_OPTS, formatValue, MODE_OPTS, openEffects, outputMenu,
  quickActions, renameOutput, selectionModel, setDevice, setFormat, setMode, setSelection, statusLine,
} from './common';

export interface OutputView {
  el: HTMLElement;
  update(cfg: OutputConfig, st: OutputState | undefined): void;
  destroy(): void;
}

/** ZISOStreamVideoView: live preview well bound to an output id. */
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
      msg.hidden = true;
    }
  });
  return {
    el,
    set(cfg: OutputConfig, st: OutputState | undefined) {
      const off = !cfg.enabled || !st || st.status === 'off';
      img.hidden = off;
      if (off && got) {
        img.removeAttribute('src');
        got = false;
        el.classList.remove('has-frame');
      }
      const text = !cfg.enabled ? 'Preview off' : off ? 'ENGINE PAUSED OR STOPPED' : got ? '' : 'No incoming video';
      if (msg.textContent !== text) msg.textContent = text;
      msg.hidden = !text;
    },
    destroy: unbind,
  };
}

/** RecordingBadge: red dot while this output records. */
export function recordingBadge() {
  const el = h('span.vo-rec', { title: 'Recording' }, icon('record.large.fill'));
  el.hidden = true;
  return { el, set: (on: boolean) => void (el.hidden = !on) };
}

/** EmbeddedAudioIndicators: stereo pair of vertical gauges. */
export function audioIndicators() {
  const l = meterV();
  const r = meterV();
  const el = h('div.vo-meters', l.el, r.el);
  return {
    el,
    set(cfg: OutputConfig, st: OutputState | undefined) {
      const lvl = cfg.enabled ? (st?.audioLevel ?? 0) : 0;
      l.set(lvl);
      r.set(lvl);
    },
  };
}

/** Tally classes (program red / preview green) on any element. */
export function setTally(el: HTMLElement, st: OutputState | undefined): void {
  el.classList.toggle('pgm', !!st?.program);
  el.classList.toggle('pvw', !st?.program && !!st?.preview);
}

function field(control: HTMLElement, caption: string): HTMLElement {
  return h('div.vo-field', control, h('span.caption', caption));
}

export function gridCard(cfg0: OutputConfig): OutputView {
  const id = cfg0.id;
  const cfg = () => cfgById(id);
  const name = h('span.vo-name', { title: 'Double-click to rename' });
  name.addEventListener('dblclick', () => {
    const c = cfg();
    if (c) void renameOutput(c);
  });
  const rec = recordingBadge();
  const enabled = toggle(cfg0.enabled, (v) => void updateOutput(id, { enabled: v }), { cls: 'sm', title: 'Video Output is enabled' });
  const fx = iconButton('sliders', () => openEffects(id), 'Output Effects', 'vo-fx');
  const more = iconButton('ellipsis', () => outputMenu(more, cfg), 'Options', 'vo-more');
  const header = h('div.vo-head', h('span.vo-title', name, rec.el), h('span.vo-head-r', enabled.el, fx, more));

  const well = previewWell(id);
  well.el.title = 'Double-click for Output Effects';
  well.el.addEventListener('dblclick', () => openEffects(id));
  const meters = audioIndicators();
  const prev = h('div.vo-prev', well.el, meters.el);

  const mode = popup(MODE_OPTS, cfg0.mode, (v) => {
    const c = cfg();
    if (c) setMode(c, v as OutputConfig['mode']);
  }, { title: 'Mode' });
  const sel = popup([], '', (v) => {
    const c = cfg();
    if (c) setSelection(c, v);
  }, { title: 'Selection' });
  const status = statusLine();
  const qa = quickActions(() => id, { talk: true });

  const device = popup([], 'ndi', (v) => {
    const c = cfg();
    if (c) setDevice(c, v);
  }, { title: 'Output Device' });
  const format = popup(FORMAT_OPTS, formatValue(cfg0), (v) => {
    const c = cfg();
    if (c) setFormat(c, v);
  }, { title: 'Format' });
  const audio = popup(AUDIO_OPTS, cfg0.audio, (v) => void updateOutput(id, { audio: v as OutputConfig['audio'] }), { title: 'Embedded Audio' });

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
      setTally(prev, st);
      rec.set(!!st?.recording);
      enabled.set(c.enabled);
      well.set(c, st);
      meters.set(c, st);
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

/** Empty grid slot with a big "+" (Add Output). */
export function addTile(): HTMLElement {
  const b = h('button.vo-add-btn', { title: 'Add Output' }, icon('plus'));
  b.addEventListener('click', addOutput);
  return h('div.vo-add', b);
}
