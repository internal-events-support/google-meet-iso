// VideoOutputTable (ZoomISO v3 "List" arrangement, page10_img01).
// Columns: Enabled | Index | Rec | Output Name | Mode | Selection | Participant Controls | Output Device |
//          Format | Audio | Status | Preview | Meters | Options. TallyLeftEdge on the row; Add Output below.

import type { OutputConfig } from '../../shared/types';
import { h, icon, iconButton, meterH, popover, popup, textField, toggle } from '../kit';
import { outputState, updateOutput } from '../store';
import {
  addOutput, AUDIO_OPTS, cfgById, deviceModel, FORMAT_OPTS, formatValue, MODE_OPTS, openEffects, outputMenu,
  quickActions, selectionModel, setDevice, setFormat, setMode, setSelection, statusLine,
} from './common';
import { previewWell, recordingBadge, setTally, type OutputView } from './grid';

export const LIST_COLUMNS = [
  'Enabled', 'Index', 'Rec', 'Output name', 'Mode', 'Selection', 'Participant controls', 'Output device',
  'Format', 'Audio', 'Status', 'Preview', 'Meters', 'Options',
];

const MODE_ICON: Record<string, string> = { participant: 'person', activeSpeaker: 'speaker', screenshare: 'screen', auto: 'people' };

function openVideoPreview(anchor: HTMLElement, id: string): void {
  const well = previewWell(id);
  const body = h('div.vo-pop-prev', well.el);
  const tick = () => {
    const c = cfgById(id);
    if (!c || !body.isConnected) {
      well.destroy();
      return;
    }
    well.set(c, outputState(id));
    setTimeout(tick, 250);
  };
  popover(anchor, body, { width: 360 });
  tick();
}

export function listRow(cfg0: OutputConfig, index: number): OutputView & { setIndex(i: number): void } {
  const id = cfg0.id;
  const cfg = () => cfgById(id);
  const enabled = toggle(cfg0.enabled, (v) => void updateOutput(id, { enabled: v }), { cls: 'sm', title: 'Video output is enabled' });
  const idx = h('span.vo-idx', String(index + 1));
  const rec = recordingBadge();
  const name = textField(cfg0.name, (v) => {
    const n = v.trim();
    if (n) void updateOutput(id, { name: n });
    else name.set(cfg()?.name ?? '');
  }, { cls: 'vo-name-field' });
  name.el.title = 'Output name';
  const modeIco = icon(MODE_ICON[cfg0.mode] ?? 'person', 'vo-mode-ico');
  const mode = popup(MODE_OPTS, cfg0.mode, (v) => {
    const c = cfg();
    if (c) setMode(c, v as OutputConfig['mode']);
  }, { cls: 'sm vo-mode', title: 'Mode' });
  mode.el.prepend(modeIco);
  const sel = popup([], '', (v) => {
    const c = cfg();
    if (c) setSelection(c, v);
  }, { cls: 'sm', title: 'Selection' });
  const qa = quickActions(() => id);
  const device = popup([], 'ndi', (v) => {
    const c = cfg();
    if (c) setDevice(c, v);
  }, { cls: 'sm', title: 'Output device' });
  const format = popup(FORMAT_OPTS, formatValue(cfg0), (v) => {
    const c = cfg();
    if (c) setFormat(c, v);
  }, { cls: 'sm', title: 'Format' });
  const audio = popup(AUDIO_OPTS, cfg0.audio, (v) => void updateOutput(id, { audio: v as OutputConfig['audio'] }), { cls: 'sm', title: 'Embedded audio' });
  const status = statusLine();
  const prevBtn = iconButton('preview', () => openVideoPreview(prevBtn, id), 'Open video preview', 'plain vo-prev-btn');
  const meterL = meterH();
  const meterR = meterH();
  const fx = iconButton('sliders', () => openEffects(id), 'Output effects', 'vo-fx');
  const more = iconButton('ellipsis', () => outputMenu(more, cfg), 'Options', 'plain vo-more');

  const td = (cls: string, ...c: (Node | null)[]) => h(`td.${cls}`, ...c);
  const el = h('tr.vo-tr', { dataset: { id } },
    td('c-en', enabled.el),
    td('c-idx', idx),
    td('c-rec', rec.el),
    td('c-name', name.el),
    td('c-mode', mode.el),
    td('c-sel', sel.el),
    td('c-qa', qa.el),
    td('c-dev', device.el),
    td('c-fmt', format.el),
    td('c-aud', audio.el),
    td('c-status', status.el),
    td('c-prev', prevBtn),
    td('c-meters', h('div.vo-hmeters', meterL.el, meterR.el)),
    td('c-opts', h('span.vo-opts', fx, more)));

  return {
    el,
    setIndex(i) {
      const t = String(i + 1);
      if (idx.textContent !== t) idx.textContent = t;
    },
    update(c, st) {
      el.classList.toggle('disabled', !c.enabled);
      setTally(el, st);
      enabled.set(c.enabled);
      rec.set(!!st?.recording);
      name.set(c.name);
      if (modeIco.dataset.m !== c.mode) {
        modeIco.dataset.m = c.mode;
        modeIco.replaceChildren(...icon(MODE_ICON[c.mode] ?? 'person').childNodes);
      }
      mode.set(MODE_OPTS, c.mode);
      const sm = selectionModel(c, st);
      sel.set(sm.opts, sm.value, sm.disabled);
      qa.set(st);
      const dm = deviceModel(c);
      device.set(dm.opts, dm.value);
      format.set(FORMAT_OPTS, formatValue(c));
      audio.set(AUDIO_OPTS, c.audio);
      status.set(c, st);
      const lvl = c.enabled ? (st?.audioLevel ?? 0) : 0;
      meterL.set(lvl);
      meterR.set(lvl);
    },
    destroy() {},
  };
}

export function listShell() {
  const tbody = h('tbody');
  const table = h('table.table.vo-table',
    h('thead', h('tr', ...LIST_COLUMNS.map((c) => h('th', c)))),
    tbody);
  const add = h('button.btn.sm.vo-add-row', { title: 'Add output' }, icon('plus'), 'Add output');
  add.addEventListener('click', addOutput);
  const el = h('div.vo-list', h('div.vo-table-wrap', table), h('div.vo-list-foot', add));
  return { el, tbody };
}
