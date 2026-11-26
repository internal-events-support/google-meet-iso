// Configure Recording popover (RE RecordingButton → RecordingPopoverContent · RecordingOutputToggle)
// and the stop confirmation. The top-bar button itself lives in shell.ts and calls openRecordingPopover().

import { button, confirmSheet, h, icon, popover } from './kit';
import { DEFAULT_RECORDING, type RecordingSettings } from '../shared/types';
import { api, on, run, setSettings, store, updateOutput } from './store';

/** settings.recording merged with defaults (older main processes don't send it yet). */
function rec(): RecordingSettings {
  return { ...DEFAULT_RECORDING, ...(store.settings.recording ?? {}) };
}

function isRecording(): boolean {
  return (store.state?.outputs ?? []).some((o) => o.recording) || store.settings.outputs.some((o) => o.record);
}

/** Open the "Select outputs for recording" popover, or the stop confirmation while recording. */
export function openRecordingPopover(anchor: HTMLElement): void {
  if (isRecording()) {
    void confirmStop();
    return;
  }
  const list = h('div.rec-list');
  const warn = h('div.rec-warn');
  const startBtn = button('Start recording', () => void start(), 'rec-start');
  const selected = () => new Set(rec().selectedOutputIds);
  const save = (ids: Set<string>) =>
    void setSettings({ recording: { ...rec(), selectedOutputIds: store.settings.outputs.map((o) => o.id).filter((id) => ids.has(id)) } });

  const render = () => {
    const sel = selected();
    list.replaceChildren(
      ...(store.settings.outputs.length
        ? store.settings.outputs.map((o) => {
            const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
            input.checked = sel.has(o.id);
            input.addEventListener('change', () => {
              const s = selected();
              if (input.checked) s.add(o.id);
              else s.delete(o.id);
              save(s);
            });
            const el = h('label.check.rec-toggle', input, h('span', o.name));
            if (!o.enabled) el.title = 'Output is disabled; it records once enabled.';
            return el;
          })
        : [h('div.rec-empty', 'No outputs')]),
    );
    const any = store.settings.outputs.some((o) => sel.has(o.id));
    startBtn.disabled = !any || store.settings.engine === 'disabled';
    startBtn.title = !any ? 'No outputs selected for recording.' : store.settings.engine === 'disabled' ? 'Enable capture to record.' : '';
    const d = store.system?.disk;
    const lowPct = rec().lowDiskWarningPercent;
    const free = d && d.totalGB ? (d.freeGB / d.totalGB) * 100 : 100;
    warn.textContent = free < lowPct ? `Low disk space (${d!.freeGB.toFixed(1)} GB free)` : '';
    warn.hidden = !warn.textContent;
  };

  const start = async () => {
    const ids = store.settings.outputs.map((o) => o.id).filter((id) => selected().has(id));
    if (!ids.length) return;
    close();
    const r = await run({ cmd: 'startRecording', outputs: ids });
    // Older main processes lack startRecording: arm the outputs directly.
    if (r === undefined) for (const o of store.settings.outputs) await updateOutput(o.id, { record: ids.includes(o.id) && o.enabled });
  };

  const content = h('div.rec-pop',
    h('div.rec-title', 'Select outputs for recording'),
    h('div.rec-row', button('Select all', () => save(new Set(store.settings.outputs.map((o) => o.id))), 'rec-sm'), button('Deselect all', () => save(new Set()), 'rec-sm')),
    list,
    h('hr.rec-div'),
    warn,
    h('div.rec-row', button('Open folder', () => void api.openPath('recordings'), 'rec-md'), button('Recording settings', () => {
      close();
      void api.openWindow('settings', 'recording');
    }, 'rec-md')),
    startBtn);
  const close = popover(anchor, content, { width: 260, align: 'center' });
  const offs = [on('settings', render), on('system', render)];
  const obs = new MutationObserver(() => {
    if (!content.isConnected) {
      offs.forEach((f) => f());
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });
  render();
}

async function confirmStop(): Promise<void> {
  const n = (store.state?.outputs ?? []).filter((o) => o.recording).length || store.settings.outputs.filter((o) => o.record).length;
  const ok = await confirmSheet('Stop recording?', `Are you sure you want to stop recording all ${n} output${n === 1 ? '' : 's'}?`, 'Stop recording', true);
  if (!ok) return;
  const r = await run({ cmd: 'stopRecording' });
  if (r === undefined) for (const o of store.settings.outputs) if (o.record) await updateOutput(o.id, { record: false });
}

/** Small helper for the running pill (icon kept for shell parity). */
export function recordIcon(): HTMLElement {
  return icon('record');
}
