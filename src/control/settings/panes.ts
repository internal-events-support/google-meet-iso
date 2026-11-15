// Settings categories: General, In-meeting, Output Effects, Video Loss (RE 01 "Settings window", in order).
import { h, icon, confirmSheet, RE_IMAGES } from '../kit';
import { store, setSettings, api, bindPreview, run } from '../store';
import {
  AUDIO_CHANNEL_MODE_OPTIONS,
  BOT_CAM_KEY,
  DEFAULT_VIDEO_LOSS,
  EMBEDDED_AUDIO_OPTIONS,
  FORMAT_PRESETS,
  GAIN_REDUCTION_OPTIONS,
  LOSS_MODE_OPTIONS,
  PAN_PATTERN_OPTIONS,
  VIDEO_LOSS_DELAY_OPTIONS,
  type OptionItem,
  type OutputFormat,
  type VideoLossSettings,
} from '../../shared/types';
import { colorWell, field, info, localPref, naRow, numField, patchGroup, pick, radios, row, sbtn, section, seg, slider, tog, NOT_IN_MEET } from './ui';

const sameFormat = (a: OutputFormat | null, b: OutputFormat | null) =>
  a === b || (!!a && !!b && a.width === b.width && a.height === b.height && a.fpsN === b.fpsN && a.fpsD === b.fpsD);

export const warnReduceOutputs = localPref('warnReduceOutputs', true);
export const warnDeleteOverlays = localPref('warnDeleteOverlays', true);
export const disableCamPreview = localPref('disableCameraPreview', false);

// ---------------------------------------------------------------- General
export function generalPane(): HTMLElement {
  const s = store.settings;
  const fmtOpts: OptionItem[] = FORMAT_PRESETS.map((p, i) => ({ value: String(i), label: p.label }));
  const fmtIdx = Math.max(0, FORMAT_PRESETS.findIndex((p) => sameFormat(p.format, s.defaultFormat)));

  const delayMs = Math.round(s.advancedAudio.defaultDelaySeconds * 1000);
  const delayField = field(`${delayMs} ms`, (v) => {
    const n = Math.max(0, Math.min(1000, Math.round(Number(v.replace(/[^\d.]/g, '')) || 0)));
    void patchGroup('advancedAudio', { defaultDelaySeconds: n / 1000 });
  }, { cls: 'ms' });
  const delaySlider = slider(delayMs, 0, 1000, 10, (v) => void patchGroup('advancedAudio', { defaultDelaySeconds: v / 1000 }), {
    live: (v) => (delayField.value = `${v} ms`),
  });

  const offlineOpts: OptionItem[] = [
    { value: 'off', label: 'Off' },
    { value: 'matchByID', label: "Keep '(offline)' and auto-reassign using persistent ID only" },
    { value: 'matchByIDOrName', label: "Keep '(offline)' and auto-reassign by persistent ID, then name" },
  ];

  return h(
    'div.s-pane',
    section('Capture settings', [
      naRow('Capture permissions mode', pick([{ value: 'record', label: 'Record' }, { value: 'live', label: 'Live Stream' }], 'record', () => {}, true)),
      row('Auto-start capture engine on meeting join', tog(s.autoStartEngine, (v) => void setSettings({ autoStartEngine: v }))),
      naRow('Always request permission from the host', tog(false, () => {}, true)),
    ]),
    section('Render settings', [
      row(
        'Rendering engine',
        radios([{ value: 'legacy', label: 'Canvas 2D (Legacy)', disabled: true }, { value: 'webgl', label: 'WebGL (Recommended)' }], 'webgl', () => {}),
        { info: 'Some features may be disabled in Canvas 2D rendering mode' },
      ),
      row('Default format', pick(fmtOpts, String(fmtIdx), (v) => void setSettings({ defaultFormat: FORMAT_PRESETS[Number(v)].format }))),
      naRow(
        'Colorspace',
        pick([{ value: 'auto', label: 'Auto' }, { value: 'rec601', label: 'Rec. 601' }, { value: 'rec709', label: 'Rec. 709' }, { value: 'rec2020', label: 'Rec. 2020' }], 'rec709', () => {}, true),
        { info: 'In auto mode, colorspace is set automatically based on output format: rec601 is used for 360p and 480p, rec709 is used for 720p and 1080p, and rec2020 is used for 2160p' },
      ),
      naRow('Display mouse cursor on content share outputs', tog(false, () => {}, true)),
    ]),
    section('Audio settings', [
      row('Default channel mode', pick(AUDIO_CHANNEL_MODE_OPTIONS, s.advancedAudio.defaultChannelMode, (v) => void patchGroup('advancedAudio', { defaultChannelMode: v }))),
      row('Default pan pattern', pick(PAN_PATTERN_OPTIONS, s.advancedAudio.defaultPanPattern, (v) => void patchGroup('advancedAudio', { defaultPanPattern: v }))),
      row('Default gain reduction', pick(GAIN_REDUCTION_OPTIONS, String(s.advancedAudio.defaultGainDb), (v) => void patchGroup('advancedAudio', { defaultGainDb: Number(v) }))),
      row('Default delay', [delaySlider, delayField], { cls: 'slider-row' }),
      row('Default embedded audio mode', pick(EMBEDDED_AUDIO_OPTIONS, s.embeddedAudio.defaultMode, (v) => void patchGroup('embeddedAudio', { defaultMode: v }))),
      row('Default embedded audio delay', numField(s.embeddedAudio.defaultDelayMs, (v) => void patchGroup('embeddedAudio', { defaultDelayMs: v }), { min: 0, max: 5000, suffix: 'ms' })),
    ]),
    section('Auto assign settings', [
      row('Include hosts and co-hosts', tog(s.autoAssign.includeHostsAndCoHosts, (v) => void patchGroup('autoAssign', { includeHostsAndCoHosts: v }))),
      row('Include non-video participants', tog(s.autoAssign.includeNonVideoParticipants, (v) => void patchGroup('autoAssign', { includeNonVideoParticipants: v }))),
      row('Include self camera', tog(s.autoAssign.includeSelfCamera, (v) => void patchGroup('autoAssign', { includeSelfCamera: v }))),
      row('Continuously evaluate eligibility', tog(s.autoAssign.continuouslyEvaluateEligibility, (v) => void patchGroup('autoAssign', { continuouslyEvaluateEligibility: v }))),
      row('Offline participant auto-reassignment', pick(offlineOpts, s.autoAssign.offlineParticipantMatching, (v) => void patchGroup('autoAssign', { offlineParticipantMatching: v as typeof s.autoAssign.offlineParticipantMatching }))),
    ]),
    section('Interface settings', [
      row(
        'Show system performance summary',
        tog(s.interface.showSystemPerformanceSummary, async (v) => {
          if (!v) {
            const ok = await confirmSheet(
              'Hide system performance summary?',
              'Are you sure you want to hide the system performance summary? Hiding the system performance summary will stop system logs from being captured.',
              'Hide',
            );
            if (!ok) return void setSettings({});
          }
          void patchGroup('interface', { showSystemPerformanceSummary: v });
        }),
      ),
      row('Warn when reducing output count', tog(warnReduceOutputs.get(), (v) => warnReduceOutputs.set(v)), { title: 'Reducing the output count will delete outputs.' }),
      naRow('Warn when Talkback requires Host/Co-host role', tog(false, () => {}, true)),
      naRow('Warn when mic is muted during Talkback', tog(false, () => {}, true)),
      naRow('Warn when no audio input is routed to Talkback output', tog(false, () => {}, true)),
      naRow('Bring GMeet ISO to front shortcut', h('span.s-shortcut', 'Press shortcut…'), {
        info: 'Brings the GMeet ISO window above screen outputs that cover the display. Press it again to put the outputs back on top.',
        title: 'Not available in GMeet ISO',
      }),
      naRow('Show new update available notice', tog(false, () => {}, true), { title: 'Not available in GMeet ISO' }),
    ]),
  );
}

// ---------------------------------------------------------------- In-meeting
export function inMeetingPane(): HTMLElement {
  const s = store.settings;
  const d = store.devices;
  const cam = s.camera;

  // ViewfinderView: the bot's outgoing camera (as sent to Meet).
  const img = h('img.s-viewfinder-img') as HTMLImageElement;
  const finder = h('div.s-viewfinder', h('div.s-viewfinder-empty', icon('videoSlash')), img);
  if (!disableCamPreview.get() && cam.type !== 'none') {
    bindPreview(BOT_CAM_KEY, (url) => {
      img.src = url;
      finder.classList.add('live');
    });
  }
  finder.classList.toggle('off', disableCamPreview.get());

  const inputSources: OptionItem[] = [
    { value: 'none', label: 'None' },
    { value: 'device', label: 'Webcam' },
    { value: 'ndi', label: 'NDI Source' },
    { value: 'sdi', label: 'Blackmagic Desktop Video', disabled: true, title: NOT_IN_MEET },
    { value: 'aja', label: 'AJA', disabled: true, title: NOT_IN_MEET },
  ];
  const withCurrent = (list: string[], cur: string): OptionItem[] => {
    const l = list.map((x) => ({ value: x, label: x }));
    if (cur && !list.includes(cur)) l.unshift({ value: cur, label: `${cur} (unavailable)` });
    if (!l.length) l.push({ value: '', label: 'No devices' });
    return l;
  };

  let sourceRow: HTMLElement;
  if (cam.type === 'device') {
    sourceRow = row('Camera', pick(withCurrent(d.videoInputs, cam.name), cam.name, (v) => void setSettings({ camera: { type: 'device', name: v } })));
  } else if (cam.type === 'ndi') {
    sourceRow = row('NDI Source', pick(withCurrent(store.ndiSources, cam.name), cam.name, (v) => void setSettings({ camera: { type: 'ndi', name: v } })));
  } else {
    sourceRow = naRow('Camera', pick([{ value: '', label: 'None' }], '', () => {}, true), { title: 'Select an input source first' });
  }

  const mics: OptionItem[] = [{ value: '', label: 'None' }, ...withCurrent(d.audioInputs, s.micLabel).filter((o) => o.value)];
  const speakers: OptionItem[] = [{ value: '', label: 'Same as system' }, ...withCurrent(d.audioOutputs, s.monitorDevice).filter((o) => o.value)];

  return h(
    'div.s-pane',
    section('Video', [
      h('div.s-row.s-preview-row', finder),
      row('Disable in-app camera preview', tog(disableCamPreview.get(), (v) => {
        disableCamPreview.set(v);
        rerender();
      })),
      row('Input Source', pick(inputSources, cam.type, (v) => {
        const type = v as typeof cam.type;
        const name = type === 'device' ? (d.videoInputs[0] ?? '') : type === 'ndi' ? (store.ndiSources[0] ?? '') : '';
        void setSettings({ camera: { type, name } });
      })),
      sourceRow,
      naRow('Reset raw video input', sbtn('Reset', () => {}, { disabled: true }), {
        info: 'Reset the raw video input — rebuilds the capture session and the virtual camera without changing the selected source',
      }),
    ]),
    section('Audio', [
      row('Microphone', pick(mics, s.micLabel, (v) => void setSettings({ micLabel: v }))),
      row('Speaker', pick(speakers, s.monitorDevice, (v) => void setSettings({ monitorDevice: v }))),
    ]),
    section('Additional', [
      row('Return to Gallery View after Spotlight', tog(s.autoLayout, (v) => void setSettings({ autoLayout: v })), {
        info: "Keeps Google Meet in Tiled layout with the maximum tile count so every participant can be captured.",
      }),
      row('Gallery tile count', numField(s.maxTiles, (v) => void setSettings({ maxTiles: v }), { min: 6, max: 49 })),
      row('Join automatically', tog(s.autoJoin, (v) => void setSettings({ autoJoin: v })), { info: 'Click "Join now" / "Ask to join" automatically.' }),
      row('Admit everyone who asks to join', tog(s.autoAdmit, (v) => void setSettings({ autoAdmit: v })), { info: 'Requires GMeet ISO to be a host or co-host.' }),
      row('Join notice', field(s.joinNotice, (v) => void setSettings({ joinNotice: v }), { placeholder: 'Off', cls: 'wide' }), { info: 'Chat message posted when GMeet ISO joins. Leave empty to turn off.' }),
    ]),
    h('div.s-footer-actions', h('button.s-btn.s-open-meet', { type: 'button', disabled: true, title: NOT_IN_MEET }, icon('gear'), 'Open Google Meet Settings')),
  );
}

// ---------------------------------------------------------------- Output Effects
export function outputEffectsPane(): HTMLElement {
  const s = store.settings;
  const path = s.interface.customFramingGuidePath;
  const name = path ? path.split(/[\\/]/).pop()! : 'Default';
  return h(
    'div.s-pane',
    section('Preview Overlays', [
      row('Custom Framing Guide', [
        h('span.s-dim', { title: path || 'Default' }, name),
        path ? sbtn('Reset', () => void patchGroup('interface', { customFramingGuidePath: '' })) : null,
        sbtn('Browse', async () => {
          const p = await api.pickFile('image');
          if (p) void patchGroup('interface', { customFramingGuidePath: p });
        }, { title: 'Browse for the replacement image' }),
      ]),
      row('Warn when deleting overlay images', tog(warnDeleteOverlays.get(), (v) => warnDeleteOverlays.set(v))),
    ]),
  );
}

// ---------------------------------------------------------------- Video Loss
let lossTarget = ''; // '' = global; otherwise output id (per-output override)

export function videoLossPane(): HTMLElement {
  const s = store.settings;
  const g = s.videoLoss;
  const outputs = s.outputs;
  if (lossTarget && (!g.perOutputVideoLossEnabled || !outputs.some((o) => o.id === lossTarget))) lossTarget = '';
  const out = outputs.find((o) => o.id === lossTarget);
  const v: VideoLossSettings = out ? { ...DEFAULT_VIDEO_LOSS, ...g, ...(out.videoLoss ?? {}) } : g;

  const set = (patch: Partial<VideoLossSettings>) => {
    if (out) void run({ cmd: 'setVideoLoss', output: out.id, patch: { ...v, ...patch } });
    else void run({ cmd: 'setVideoLoss', patch });
  };

  // VideoLossPreviewView
  const preview = h('div.s-loss-preview');
  const paintPreview = (vv: VideoLossSettings) => {
    preview.replaceChildren();
    preview.className = 's-loss-preview mode-' + vv.mode;
    const label = out?.name ?? outputs[0]?.name ?? 'Output 1';
    if (vv.mode === 'testcard') preview.append(h('img', { src: RE_IMAGES.colourbars, alt: '' }));
    else if (vv.mode === 'image') preview.append(vv.image ? h('div.s-loss-file', icon('doc'), vv.image.split(/[\\/]/).pop()!) : h('img', { src: RE_IMAGES.videoLoss, alt: '' }));
    else if (vv.mode === 'freeze') preview.append(h('img.frozen', { src: RE_IMAGES.testcard, alt: '' }), h('span.s-loss-tag', 'Last frame'));
    else if (vv.mode === 'profilePicture') {
      preview.style.background = vv.profilePictureBackgroundColor;
      const size = `${Math.round(vv.profilePictureSize * 100)}%`;
      const pic = vv.profilePictureForceInitials
        ? h('div.s-pp-initials', 'PN')
        : h('div.s-pp-photo', h('img', { src: RE_IMAGES.profilePlaceholder, alt: '' }));
      pic.style.height = size;
      if (vv.profilePictureForceInitials) {
        pic.style.color = vv.profilePictureInitialsColor;
        pic.style.background = vv.profilePictureOverrideInitialsBgColor ? vv.profilePictureInitialsBgColor : '#5A5A5A';
        pic.style.fontSize = `calc(${vv.profilePictureSize} * 90px)`;
      }
      preview.append(h('div.s-pp', pic, vv.profilePictureShowName ? h('div.s-pp-name', 'Participant Name') : null));
    }
    if (vv.mode !== 'profilePicture') preview.style.background = '';
    if (vv.displayOutputNameOnImage) preview.append(h('div.s-loss-outname', label));
  };
  paintPreview(v);

  const delayIdx = VIDEO_LOSS_DELAY_OPTIONS.findIndex((o) => o.value === g.delay);
  const rows: HTMLElement[] = [
    h('div.s-row.s-preview-row', preview),
    row('Video loss delay time', seg(VIDEO_LOSS_DELAY_OPTIONS, VIDEO_LOSS_DELAY_OPTIONS[Math.max(0, delayIdx)].value, (d) => void patchGroup('videoLoss', { delay: d })), {
      info: 'How long GMeet ISO waits for live video to return before switching to the Video Loss Mode content. Skipped when video stops for a known reason, such as a participant turning off their camera or leaving.',
    }),
    row('Per-output video loss settings', tog(g.perOutputVideoLossEnabled, (on) => void patchGroup('videoLoss', { perOutputVideoLossEnabled: on }))),
  ];
  if (g.perOutputVideoLossEnabled) {
    const opts: OptionItem[] = [{ value: '', label: 'All outputs (default)' }, ...outputs.map((o) => ({ value: o.id, label: o.name + (o.videoLoss ? ' •' : '') }))];
    rows.push(
      row('Output', [
        out?.videoLoss ? h('button.s-link', { type: 'button', on: { click: () => void run({ cmd: 'setVideoLoss', output: out.id, patch: null }) } }, 'Use default') : null,
        pick(opts, lossTarget, (id) => {
          lossTarget = id;
          rerender();
        }),
      ]),
    );
  }
  rows.push(
    row('Video loss mode', pick(LOSS_MODE_OPTIONS, v.mode, (mode) => set({ mode })), {
      info: v.mode === 'transparent' ? 'Transparent may appear black on outputs that do not support transparency.' : undefined,
    }),
  );
  if (v.mode === 'image') {
    rows.push(
      row('Video loss image', [
        h('span.s-dim.s-path', { title: v.image }, v.image ? v.image.split(/[\\/]/).pop()! : 'None'),
        sbtn('Browse…', async () => {
          const p = await api.pickFile('image');
          if (p) set({ image: p });
        }),
      ]),
    );
  }
  if (v.mode === 'profilePicture') {
    const sizeSl = slider(v.profilePictureSize, 0.1, 0.9, 0.05, (n) => set({ profilePictureSize: n }), {
      cls: 'ticks',
      live: (n) => paintPreview({ ...v, profilePictureSize: n }),
    });
    rows.push(
      row('Profile picture size', sizeSl, { cls: 'slider-row wide' }),
      row('Force initials for all participants', tog(v.profilePictureForceInitials, (b) => set({ profilePictureForceInitials: b }))),
      row('Background color', colorWell(v.profilePictureBackgroundColor, (c) => set({ profilePictureBackgroundColor: c }))),
      row('Initials color', colorWell(v.profilePictureInitialsColor, (c) => set({ profilePictureInitialsColor: c }))),
      row('Override initials background color', tog(v.profilePictureOverrideInitialsBgColor, (b) => set({ profilePictureOverrideInitialsBgColor: b }))),
      row('Initials background color', colorWell(v.profilePictureInitialsBgColor, (c) => set({ profilePictureInitialsBgColor: c }), !v.profilePictureOverrideInitialsBgColor)),
      row('Show participant name', tog(v.profilePictureShowName, (b) => set({ profilePictureShowName: b }))),
    );
  }
  rows.push(row('Display output name on image', tog(v.displayOutputNameOnImage, (b) => set({ displayOutputNameOnImage: b }))));

  return h('div.s-pane', section('Video loss settings', rows));
}

// Set by settings.ts so panes can ask for a rebuild after local-only state changes.
let rerender: () => void = () => {};
export function setRerender(fn: () => void): void {
  rerender = fn;
}
export { info };
