// Participants tab (ZoomISO v3 ParticipantManagementTab, page17_img01.png).
//
// ParticipantManagementTab
//   ├ toolbar: search field + ParticipantFilterToggle × 4 (ParticipantManagementFilters:
//   │          hostOrCohost / videoOn / audioOn / handRaised — checkbox + icon, tooltip = label)
//   └ ParticipantManagementTable (CustomTableStyle)
//       Name (ParticipantInfoView = ProfilePicture + name) | Meet ID | Role |
//       Video/Audio | Status (ParticipantStreamStatusCell → AssignedStreamStatus/StreamStatusView) |
//       Output Assignment | 1 … N (OutputAssignmentToggle per ZISOStream)
// Right-click a row for Meet actions (pin, lower hand, mute, remove), or the header for Mute All /
// Lower All Hands. They run in the Meet page (best effort).

import {
  PARTICIPANT_FILTER_OPTIONS,
  participantMatches,
  type OutputConfig,
  type ParticipantFilter,
  type ParticipantState,
} from '../../shared/types';
import { confirmSheet, h, icon, menu, type MenuItem } from '../kit';
import { on, outputState, run, store } from '../store';

const FILTERS_KEY = 'pm.filters';
const FILTER_ICON: Record<ParticipantFilter, string> = {
  hostOrCohost: 'crown',
  videoOn: 'camera.outline',
  audioOn: 'mic.outline',
  handRaised: 'hand',
};
/** ProfilePicture initials palette (sampled from the reference screenshot). */
const AVATAR_COLORS = ['#0A84FF', '#64C2DB', '#32D74B', '#FF453A', '#BF5AF2', '#FF9F0A', '#5E5CE6', '#FF375F', '#30B0C7', '#AC8E68'];

function loadFilters(): Set<ParticipantFilter> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '[]') as ParticipantFilter[]);
  } catch {
    return new Set();
  }
}

function initials(name: string): string {
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '')).toUpperCase();
}

function colorFor(id: string): string {
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

/** ProfilePicture: Meet avatar when known, otherwise initials on a coloured rounded square. */
function profilePicture(p: ParticipantState): HTMLElement {
  const box = h('div.pm-avatar', { style: { background: colorFor(p.participantId) } }, initials(p.displayName));
  if (p.avatarUrl) {
    const img = h('img', { src: p.avatarUrl, alt: '', referrerpolicy: 'no-referrer', draggable: 'false' }) as HTMLImageElement;
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

/** Meet's participant id ("spaces/…/devices/146") → short id, like ZoomISO's "Zoom ID". */
function meetId(p: ParticipantState): string {
  return p.participantId.split('/').pop() ?? p.participantId;
}

function role(p: ParticipantState): string {
  if (p.kind === 'screen') return 'Screen share';
  return p.isHost ? 'Host' : p.isCohost ? 'Co-Host' : 'Participant';
}

/** The bot's own entry tells us whether host actions are possible. */
function botIsHost(): boolean {
  return (store.state?.participants ?? []).some((p) => p.isSelf && (p.isHost || p.isCohost));
}

function selected(o: OutputConfig, p: ParticipantState): boolean {
  return !!o.selection && o.mode === 'participant' && o.selection.key === p.key;
}

export function mountParticipants(host: HTMLElement): void {
  host.classList.add('pm-tab');
  const filters = loadFilters();
  let query = '';

  // ---------------- toolbar: search + ParticipantFilterToggle ×4
  const search = h('input.field.pm-search', { type: 'text', placeholder: 'Search...', spellcheck: 'false' }) as HTMLInputElement;
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    render(true);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      query = '';
      render(true);
    }
  });
  const toggles = PARTICIPANT_FILTER_OPTIONS.map((opt) => {
    const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
    input.checked = filters.has(opt.value);
    input.addEventListener('change', () => {
      if (input.checked) filters.add(opt.value);
      else filters.delete(opt.value);
      localStorage.setItem(FILTERS_KEY, JSON.stringify([...filters]));
      render(true);
    });
    return h('label.check.pm-filter', { title: opt.title ?? opt.label, dataset: { filter: opt.value } }, input, icon(FILTER_ICON[opt.value]));
  });
  const toolbar = h('div.pm-toolbar', h('span.pm-search-ico', icon('search')), search, h('div.pm-filters', ...toggles));

  // ---------------- ParticipantManagementTable
  const colgroup = h('colgroup');
  const thead = h('thead');
  const tbody = h('tbody');
  const table = h('table.pm-table', colgroup, thead, tbody);
  const empty = h('div.pm-empty');
  const scroller = h('div.pm-scroll', table, empty);
  host.append(toolbar, h('div.pm-card', scroller));

  let headSig = '';
  function renderHead(outs: OutputConfig[]): void {
    const sig = outs.map((o) => `${o.id}:${o.name}`).join(',');
    if (sig === headSig) return;
    headSig = sig;
    colgroup.replaceChildren(
      h('col.c-name'),
      h('col.c-id'),
      h('col.c-role'),
      h('col.c-av'),
      h('col.c-status'),
      h('col.c-assign'),
      ...outs.map(() => h('col.c-out')),
      h('col.c-fill'),
    );
    thead.replaceChildren(
      h(
        'tr',
        h('th', 'Name'),
        h('th', 'Meet ID'),
        h('th', 'Role'),
        h('th', 'Video/Audio'),
        h('th', 'Status'),
        h('th', 'Output assignment'),
        ...outs.map((o, i) => h('th.c-out', { title: o.name }, String(i + 1))),
        h('th'),
      ),
    );
  }

  /** AssignedStreamStatus → StreamStatusView: "1920 x 1080 - 25.6 fps in" per assigned output. */
  function statusCell(p: ParticipantState, outs: OutputConfig[]): HTMLElement {
    const td = h('td.pm-status');
    for (const o of outs.filter((x) => selected(x, p))) {
      const st = outputState(o.id);
      const w = st?.inWidth || p.width;
      const hh = st?.inHeight || p.height;
      const fps = st?.inFps || p.fps;
      const live = !!w && !!hh && st?.status !== 'loss' && st?.status !== 'off';
      td.append(
        h(
          'div.pm-stream' + (live ? '.ok' : '.lost'),
          { title: o.name },
          icon(live ? 'checkCircle' : 'warn'),
          live ? `${w} x ${hh} - ${fps.toFixed(1)} fps in` : 'No incoming video',
        ),
      );
    }
    return td;
  }

  function avCell(p: ParticipantState): HTMLElement {
    const mic = p.muted === true ? 'mic.slash.outline' : 'mic.outline';
    const cam = p.hasVideo ? 'camera.outline' : 'camera.slash.outline';
    const micTitle = p.muted === true ? 'Muted' : p.muted === false ? 'Unmuted' : 'Audio state unknown';
    return h(
      'td.pm-av',
      h('span' + (p.muted === null ? '.unknown' : ''), { title: micTitle }, icon(mic)),
      h('span', { title: p.hasVideo ? 'Video on' : 'Video off' }, icon(cam)),
      p.handRaised ? h('span.pm-hand', { title: 'Raised hand' }, icon('hand')) : null,
    );
  }

  /** OutputAssignmentToggle: one checkbox per output (an output shows one participant at a time). */
  function assignCell(p: ParticipantState, o: OutputConfig): HTMLElement {
    const input = h('input', { type: 'checkbox', title: o.name }) as HTMLInputElement;
    input.checked = selected(o, p);
    input.addEventListener('change', () => {
      void run({ cmd: 'assignParticipant', participant: input.checked ? p.key : null, output: o.id });
    });
    return h('td.c-out', h('label.check.pm-assign', input));
  }

  function rowMenu(e: MouseEvent, p: ParticipantState): void {
    e.preventDefault();
    const isHost = botIsHost();
    const needHost = isHost ? '' : ' (requires host)';
    const cam = p.kind === 'camera';
    const items: (MenuItem | null)[] = [
      { label: p.pinned ? 'Un-pin' : 'Pin', disabled: !cam, onClick: () => void run({ cmd: 'pin', participant: p.key, on: !p.pinned }) },
      // Spotlight = Meet "Pin to the screen › For everyone" (host / co-host only).
      {
        label: (p.spotlit ? 'Remove spotlight' : 'Spotlight') + needHost,
        disabled: !cam || !isHost,
        onClick: () => void run({ cmd: 'spotlight', participant: p.key, on: !p.spotlit }),
      },
      null,
      {
        label: 'Lower hand' + (p.isSelf ? '' : needHost),
        disabled: !cam || !p.handRaised || (!isHost && !p.isSelf),
        onClick: () => void run({ cmd: 'lowerHand', participant: p.key }),
      },
      { label: 'Mute' + needHost, disabled: !cam || p.isSelf || p.muted === true || !isHost, onClick: () => void run({ cmd: 'muteParticipant', participant: p.key }) },
      null,
      {
        label: 'Unassign from all outputs',
        disabled: !store.settings.outputs.some((o) => selected(o, p)),
        onClick: () => void run({ cmd: 'unassignParticipant', participant: p.key }),
      },
      null,
      {
        label: 'Remove from the call' + needHost,
        destructive: true,
        disabled: !cam || !isHost || p.isSelf,
        onClick: () =>
          void confirmSheet('Remove participant', `Remove ${p.displayName} from the call?`, 'Remove', true).then(
            (ok) => ok && run({ cmd: 'removeParticipant', participant: p.key }),
          ),
      },
    ];
    menu({ x: e.clientX, y: e.clientY }, items);
  }

  thead.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const isHost = botIsHost();
    const anyHand = (store.state?.participants ?? []).some((p) => p.handRaised);
    const needHost = isHost ? '' : ' (requires host)';
    menu({ x: e.clientX, y: e.clientY }, [
      { label: 'Mute all' + needHost, disabled: !isHost, onClick: () => void run({ cmd: 'muteAll' }) },
      { label: 'Lower all hands' + needHost, disabled: !isHost || !anyHand, onClick: () => void run({ cmd: 'lowerHand' }) },
    ]);
  });

  let bodySig = '';
  function render(force = false): void {
    const outs = store.settings.outputs;
    renderHead(outs);
    const all = (store.state?.participants ?? []).filter((p) => p.kind === 'camera' || store.settings.screenShare);
    const list = all
      .filter((p) => participantMatches(p, [...filters]))
      .filter((p) => !query || p.displayName.toLowerCase().includes(query) || meetId(p).includes(query))
      .sort(
        (a, b) =>
          Number(a.kind === 'screen') - Number(b.kind === 'screen') ||
          Number(!!(b.isHost || b.isCohost)) - Number(!!(a.isHost || a.isCohost)) ||
          a.displayName.localeCompare(b.displayName),
      );

    // Signature of everything shown, so the table only rebuilds when something changed.
    const sig = JSON.stringify([
      list.map((p) => [p.key, p.displayName, p.avatarUrl, p.isHost, p.isCohost, p.muted, p.hasVideo, p.handRaised, p.pinned, p.spotlit, p.width, p.height, Math.round(p.fps)]),
      outs.map((o) => {
        const st = outputState(o.id);
        return [o.id, o.mode, o.selection?.key, st?.status, st?.inWidth, st?.inHeight, Math.round(st?.inFps ?? 0)];
      }),
    ]);
    if (!force && sig === bodySig) return;
    bodySig = sig;

    tbody.replaceChildren(
      ...list.map((p) => {
        const tr = h(
          'tr' + (p.isSelf ? '.self' : ''),
          { dataset: { key: p.key } },
          h(
            'td.pm-name',
            h(
              'div.pm-info',
              profilePicture(p),
              h('span.pm-display', { title: p.displayName }, p.displayName),
              p.spotlit ? h('span.pm-tag', { title: 'Pinned for everyone in Meet' }, 'Spotlight') : p.pinned ? h('span.pm-tag', { title: "Pinned in the bot's Meet view" }, 'Pinned') : null,
            ),
          ),
          h('td.pm-id', meetId(p)),
          h('td', role(p) + (p.isSelf ? ' (Bot)' : '')),
          avCell(p),
          statusCell(p, outs),
          h('td'),
          ...outs.map((o) => assignCell(p, o)),
          h('td'),
        );
        tr.addEventListener('contextmenu', (e) => rowMenu(e as MouseEvent, p));
        return tr;
      }),
    );
    const inCall = store.state?.phase === 'in-call';
    empty.textContent = !inCall ? 'Join a meeting first.' : !all.length ? 'No participants' : !list.length ? 'No participants match the current filters' : '';
    empty.hidden = !empty.textContent;
  }

  on('state', () => render());
  on('settings', () => render(true));
  render(true);
}
