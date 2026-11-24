// Settings categories: NDI, Recording, Logs.
import { h, icon } from '../kit';
import { store, setSettings, api, on } from '../store';
import {
  formatRecordingDate,
  LOG_LEVEL_OPTIONS,
  RECORDING_CODEC_OPTIONS,
  RECORDING_DATE_FORMAT_OPTIONS,
  RECORDING_FORMAT_OPTIONS,
  type OptionItem,
} from '../../shared/types';
import { field, info, numField, patchGroup, pick, row, sbtn, section, seg, tog } from './ui';

// ---------------------------------------------------------------- NDI
export function ndiPane(): HTMLElement {
  const s = store.settings;
  const nics = store.system?.nics ?? [];
  const allowed = s.ndiNicIps.split(',').map((x) => x.trim()).filter(Boolean);

  const nicRows = nics.length
    ? nics.map((n) => {
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = allowed.includes(n.address);
        cb.addEventListener('change', () => {
          const next = cb.checked ? [...new Set([...allowed, n.address])] : allowed.filter((a) => a !== n.address);
          void setSettings({ ndiNicIps: next.join(',') });
        });
        return h('label.s-check', cb, `${n.name} (${n.address})`);
      })
    : [h('div.s-dim', 'No network interfaces detected.')];
  // Addresses configured but not currently present.
  for (const a of allowed.filter((a) => !nics.some((n) => n.address === a))) {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = true;
    cb.addEventListener('change', () => void setSettings({ ndiNicIps: allowed.filter((x) => x !== a).join(',') }));
    nicRows.push(h('label.s-check', cb, `${a} (not present)`));
  }

  const refresh = h('button.s-icon-btn', { type: 'button', title: 'Refresh network interfaces' }, icon('refresh'));
  refresh.addEventListener('click', async () => {
    store.system = await api.system();
    void setSettings({});
  });

  return h(
    'div.s-pane.ndi',
    section('NDI discovery', [
      row('Groups', field(s.ndiGroups, (v) => void setSettings({ ndiGroups: v }), { placeholder: 'Public (default)', cls: 'wide' }), {
        info: 'Comma-separated list of NDI groups this source belongs to. Leave empty to use the default Public group. Max 248 bytes total.',
      }),
    ]),
    h(
      'div.s-group.s-group-gap',
      row('Discovery server', field(s.ndiDiscoveryServer, (v) => void setSettings({ ndiDiscoveryServer: v }), { placeholder: 'None — use mDNS (default)', cls: 'wide' }), {
        info: 'Comma-separated list of Discovery Server addresses (host:port). Default port is 5959. Leave empty to use mDNS discovery.',
      }),
    ),
    section('Network adapters', [
      h('div.s-row.s-nics', h('div.s-nics-head', h('div.s-label', 'Allowed interfaces', info('NDI sends only on the ticked adapters. Leave all unticked to use every adapter.')), refresh), ...nicRows),
    ]),
  );
}

// ---------------------------------------------------------------- Recording
export function recordingPane(): HTMLElement {
  const s = store.settings;
  const r = s.recording;
  const disk = store.system?.disk ?? null;
  const dir = s.recordDir || disk?.path || 'Videos\\Google Meet ISO';
  const low = disk ? (disk.freeGB / Math.max(1, disk.totalGB)) * 100 < r.lowDiskWarningPercent : false;

  const ext = r.format;
  const parts = [r.fileNamePrefix, formatRecordingDate(new Date(), r.fileNameDateFormat).replace(/ /g, '_'), s.outputs[0]?.name ?? 'Output 1', r.fileNameSuffix].filter(Boolean);
  const previewName = `${parts.join('-')}.${ext}`;

  const refresh = h('button.s-icon-btn.plain', { type: 'button', title: 'Refresh available space' }, icon('refresh'));
  refresh.addEventListener('click', async () => {
    store.system = await api.system();
    void setSettings({});
  });

  return h(
    'div.s-pane',
    section('Selection', [
      row('Auto-select newly added outputs for recording', tog(r.selectNewOutputsByDefault, (v) => void patchGroup('recording', { selectNewOutputsByDefault: v }))),
    ]),
    section('Save location', [
      row(h('span.s-path', { title: dir }, dir), [
        sbtn('Browse...', async () => {
          const p = await api.pickFile('folder');
          if (p) void setSettings({ recordDir: p });
        }),
        h('button.s-icon-btn.s-btn', { type: 'button', title: 'Show in Explorer', on: { click: () => void api.openPath('recordings') } }, icon('folder')),
      ]),
      row(
        'Available space',
        disk
          ? [refresh, h('span' + (low ? '.s-warn' : '.s-good'), `${disk.freeGB.toFixed(1)} GB`), h('span.s-dim', ' of '), h('span.s-dim', `${disk.totalGB.toFixed(1)} GB`)]
          : [refresh, h('span.s-dim', 'Unknown')],
      ),
      row('Low disk warning at', numField(r.lowDiskWarningPercent, (v) => void patchGroup('recording', { lowDiskWarningPercent: v }), { min: 1, max: 50, suffix: '% free' })),
    ]),
    section('File naming', [
      row('Prefix', field(r.fileNamePrefix, (v) => void patchGroup('recording', { fileNamePrefix: v }), { cls: 'wide' })),
      row('Suffix', field(r.fileNameSuffix, (v) => void patchGroup('recording', { fileNameSuffix: v }), { cls: 'wide' })),
      row('Date format', pick(RECORDING_DATE_FORMAT_OPTIONS, r.fileNameDateFormat, (v) => void patchGroup('recording', { fileNameDateFormat: v }))),
      h('div.s-row.s-fname', h('div', h('div.s-cap', 'Preview:'), h('div.s-mono', previewName))),
    ]),
    section('Recording format', [
      row('Container Format', pick(RECORDING_FORMAT_OPTIONS, r.format, (v) => void patchGroup('recording', { format: v }))),
      row('Video codec', pick(RECORDING_CODEC_OPTIONS, r.videoCodec, (v) => void patchGroup('recording', { videoCodec: v }))),
      row('Video bitrate', numField(r.videoBitrateMbps, (v) => void patchGroup('recording', { videoBitrateMbps: v }), { min: 1, max: 200, suffix: 'Mbps' })),
    ]),
  );
}

// ---------------------------------------------------------------- Logs (LogsView)
type Level = 'error' | 'warn' | 'info' | 'verbose';
const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, verbose: 3 };
const LEVEL_LABEL: Record<Level, string> = { error: 'Error', warn: 'Warning', info: 'Info', verbose: 'Verbose' };

export interface LogEntry {
  time: string;
  group: 'General' | 'OSC';
  level: Level;
  text: string;
}

export function parseLog(line: string): LogEntry {
  const m = /^(\d{1,2}:\d{2}:\d{2}(?:\s?[AP]M)?)\s+(.*)$/i.exec(line);
  const time = m ? m[1] : '';
  const text = m ? m[2] : line;
  const level: Level = /^command: |^eval/i.test(text)
    ? 'verbose'
    : /✖|\berror\b|\bfailed\b|exception/i.test(text)
    ? 'error'
    : /\bwarn(ing)?\b|⚠|not on allow list|unknown|disabled in the Command Browser/i.test(text)
      ? 'warn'
      : /^\[meet\]|^command:|^eval|snapshot saved/i.test(text)
        ? 'verbose'
        : 'info';
  const group = /\bOSC\b/.test(text) ? 'OSC' : 'General';
  return { time, group, level, text };
}

let logGroup: 'all' | 'General' | 'OSC' = 'all';
let scrollLatest = true;
let clearedAt = 0;

/** The log list + bottom bar. `fixedGroup` = 'OSC' for the OSC → Logs sub-tab. */
export function logsPane(fixedGroup?: 'OSC'): { el: HTMLElement; dispose(): void } {
  const list = h('div.s-log-list');
  const render = () => {
    const min = RANK[(store.settings.logLevel as Level) ?? 'info'];
    const grp = fixedGroup ?? logGroup;
    const rows = store.log.slice(clearedAt).map(parseLog).filter((e) => RANK[e.level] <= min && (grp === 'all' || e.group === grp));
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
    list.replaceChildren(
      ...rows.map((e) => h('div.s-log-row.lv-' + e.level, h('span.t', e.time), h('span.g', e.group), h('span.l', LEVEL_LABEL[e.level]), h('span.m', e.text))),
    );
    if (scrollLatest || atBottom) list.scrollTop = list.scrollHeight;
  };
  const levelOpts: OptionItem[] = LOG_LEVEL_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
  const scrollCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  scrollCb.checked = scrollLatest;
  scrollCb.addEventListener('change', () => {
    scrollLatest = scrollCb.checked;
    render();
  });
  const save = () => {
    const blob = new Blob([store.log.join('\r\n') + '\r\n'], { type: 'text/plain' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `google-meet-iso-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt` }) as HTMLAnchorElement;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const bar = h(
    'div.s-log-bar',
    h('span.s-cap', 'Logging Level'),
    pick(levelOpts, store.settings.logLevel, (v) => void setSettings({ logLevel: v as Level })),
    fixedGroup
      ? null
      : h(
          'span.s-log-group',
          h('span.s-cap', 'Log Group'),
          seg(
            [
              { value: 'all', label: 'All' },
              { value: 'General', label: 'General' },
              { value: 'OSC', label: 'OSC' },
            ],
            logGroup,
            (v) => {
              logGroup = v;
              render();
            },
            'sm',
          ),
        ),
    h('label.s-check', scrollCb, 'Scroll to latest'),
    h('span.s-spacer'),
    sbtn('Save Logs...', save),
    info('Saves verbose-level logs for application and OSC'),
    h('span.s-spacer'),
    sbtn('Clear Log', () => {
      clearedAt = store.log.length;
      render();
    }),
  );
  const el = h('div.s-logs', list, bar);
  const offs = [on('log', render), on('settings', render)];
  queueMicrotask(render);
  return { el, dispose: () => offs.forEach((f) => f()) };
}
