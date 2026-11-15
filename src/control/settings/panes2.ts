// Settings categories: Audio Inputs and Talkback, NDI and SRT, Recording, Logs.
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
import { field, info, naRow, numField, patchGroup, pick, radios, row, sbtn, section, seg, slider, tog, colorWell, NOT_IN_MEET } from './ui';

// ---------------------------------------------------------------- Audio Inputs and Talkback (not possible in Meet)
export function talkbackPane(): HTMLElement {
  const outs = store.settings.outputs.length ? store.settings.outputs.map((o) => o.name) : ['GMEET 1', 'GMEET 2', 'GMEET 3', 'GMEET 4'];
  const duck = (name: string, first: boolean) =>
    h(
      'div.s-duck' + (first ? '' : '.dim'),
      h('span.s-duck-name', name),
      h('span.s-duck-cap', 'Full interrupt'),
      slider(40, 0, 100, 1, () => {}, { disabled: true }),
      h('span.s-duck-cap', 'No ducking'),
      h('span.s-duck-val', '40%'),
    );
  const pane = h(
    'div.s-pane.na-pane',
    { title: NOT_IN_MEET },
    section(
      'Audio Inputs',
      [
        naRow(
          'Audio Management Mode',
          pick([{ value: 'meet', label: 'Google Meet Managed (default)' }, { value: 'iso', label: 'GMeet ISO Managed' }], 'meet', () => {}, true),
          { info: 'GMeet ISO Managed mode is required for routing Audio Input channels to the meeting mic.' },
        ),
      ],
      { icon: 'mic.outline', subtitle: "Select whether to have your microphone in Google Meet managed by Google Meet's audio device selectors or instead via GMeet ISO's audio input routing table." },
    ),
    section(
      'Talkback',
      [
        naRow('Enable Talkback', tog(false, () => {}, true)),
        naRow('Suppress meeting mic while Talkback is active', tog(false, () => {}, true), {
          info: 'Automatically interrupt the meeting mic return feed when audio is present on at least one Talkback channel. Recommended when Talkback and Meeting audio sources are the same to avoid doubled audio.',
        }),
        naRow('Noise Suppression', [slider(50, 0, 100, 1, () => {}, { disabled: true, cls: 'short' }), h('span.s-duck-val', '50%'), tog(false, () => {}, true)], {
          info: 'Runs noise removal processing on Talkback audio channels before transmitting to Google Meet.',
        }),
        naRow('Echo Cancellation', tog(false, () => {}, true), {
          info: 'Removes audio coming from computer speakers from Talkback audio channels. Only use if Talkback channels may contain feedback from open speakers (e.g., producers are not wearing headphones).',
        }),
        naRow('Enable Ducking', tog(false, () => {}, true), {
          info: 'When ducking is applied, participants in Talkback channels will hear other participants in the meeting at a lower volume. Set to 0% for full interrupt and 100% for no change in volume',
        }),
        naRow('Apply ducking when', pick([{ value: 'audio', label: 'there is audio on an open channel' }, { value: 'open', label: 'the channel is open' }], 'audio', () => {}, true), { sub: true }),
        h('div.s-row.sub.na.s-ducks', ...outs.map((n, i) => duck(n, i === 0))),
      ],
      { icon: 'headset', subtitle: 'Send unique one-way audio from GMeet ISO directly to individual participants who are assigned to outputs.' },
    ),
  );
  return pane;
}

// ---------------------------------------------------------------- NDI and SRT
const NDI_ONLY = 'Not available in GMeet ISO (NDI Full Bandwidth only)';

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

  const srtCols = ['Channel Name', 'BMD Stream Key', 'Destination IP', 'Port', 'Mode', 'Latency (ms)'];
  const srtTable = h(
    'div.s-srt-table',
    h('div.s-srt-head', ...srtCols.map((c) => h('span', c)), h('span')),
    h(
      'div.s-srt-row',
      h('input.s-field', { value: 'SRT Device', disabled: true }),
      h('input.s-field', { placeholder: 'BMD Stream Key', disabled: true }),
      h('input.s-field', { value: '0.0.0.0', disabled: true }),
      h('input.s-field', { value: '2000', disabled: true }),
      pick([{ value: 'caller', label: 'Caller' }, { value: 'listener', label: 'Listener' }, { value: 'rendezvous', label: 'Rendezvous' }], 'caller', () => {}, true),
      h('input.s-field', { value: '1000', disabled: true }),
      h('button.s-icon-btn', { type: 'button', disabled: true }, icon('x')),
    ),
  );

  return h(
    'div.s-pane.ndi',
    section('NDI output mode', [
      row('NDI mode', radios([{ value: 'full', label: 'NDI Full Bandwidth' }, { value: 'hx3', label: 'NDI HX3', disabled: true }], 'full', () => {}), {}),
      naRow('Enable proxy stream', tog(false, () => {}, true), { title: NDI_ONLY }),
      naRow('Video codec', radios([{ value: 'h264', label: 'H.264' }, { value: 'hevc', label: 'H.265 (HEVC)' }], 'h264', () => {}, true), { title: NDI_ONLY }),
      naRow('Encoding profile', radios([{ value: 'baseline', label: 'Baseline' }, { value: 'main', label: 'Main' }, { value: 'high', label: 'High' }], 'main', () => {}, true), { title: NDI_ONLY }),
      naRow('Bandwidth control', radios([{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual' }], 'auto', () => {}, true), { title: NDI_ONLY }),
      naRow('Target bitrate', [field(20, () => {}, { cls: 'num', disabled: true }), h('span.s-suffix', 'Mbps (1–100)')], { title: NDI_ONLY }),
    ]),
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
    section('Multicast', [naRow(h('label.s-check', h('input', { type: 'checkbox', disabled: true }), 'Enable multicast sending'), null, { title: 'Not available in GMeet ISO' })]),
    section('Tally', [
      naRow(h('label.s-check', h('input', { type: 'checkbox', disabled: true }), 'Show tally border'), null, {
        info: 'Displays a border indicating that an NDI receiver has signaled that a GMeet ISO output is on its program or preview buses.',
        title: 'Not available in GMeet ISO',
      }),
      naRow('Program border color', colorWell('#FF0000', () => {}, true), { title: 'Not available in GMeet ISO' }),
      naRow('Preview border color', colorWell('#00FF00', () => {}, true), { title: 'Not available in GMeet ISO' }),
    ]),
    h(
      'section.s-section.s-srt.na',
      { title: NOT_IN_MEET },
      h('div.s-head', h('h2', 'SRT Outputs Settings')),
      h(
        'div.s-srt-bar',
        h('span', 'Encoding Profile:'),
        pick([{ value: 'bmd', label: 'H264 Blackmagic Design Compatible' }, { value: 'h264', label: 'H.264' }, { value: 'hevc', label: 'H.265 (HEVC)' }], 'bmd', () => {}, true),
        info('You must use the exact resolution and framerate set on your receiver to avoid compatibility issues.'),
        h('span.s-spacer'),
        h('label.s-check', h('input', { type: 'checkbox', disabled: true }), 'Auto-accept caller connections'),
      ),
      srtTable,
      sbtn(h('span.s-btn-inner', icon('plus'), 'Add Channel'), () => {}, { disabled: true, cls: 's-add' }),
    ),
  );
}

// ---------------------------------------------------------------- Recording
export function recordingPane(): HTMLElement {
  const s = store.settings;
  const r = s.recording;
  const disk = store.system?.disk ?? null;
  const dir = s.recordDir || disk?.path || 'Videos\\GMeet ISO';
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
    const a = h('a', { href: URL.createObjectURL(blob), download: `gmeet-iso-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt` }) as HTMLAnchorElement;
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
