// OSC settings category: Settings | Logs | Commands sub-tabs (RE OSCSettings / OSCMainSettings / CommandBrowserView).
import { h, icon, promptSheet } from '../kit';
import { store, run } from '../store';
import { OSC_BAUD_RATE_OPTIONS, OSC_SUBSCRIBE_MODE_OPTIONS, type OptionItem } from '../../shared/types';
import { OSC_CATALOG } from './oscCatalog';
import { OSC_SUPPORT } from '../../shared/oscSupport';
import { field, numField, patchGroup, pick, row, sbtn, section, seg, tog } from './ui';
import { logsPane } from './panes2';

export type OscSubTab = 'settings' | 'logs' | 'commands';
let sub: OscSubTab = 'settings';
export function setOscSubTab(t: OscSubTab): void {
  sub = t;
}

let allowListFile: File | null = null;

function parseIps(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^[\d.:a-f]+$/i.test(x) && x.length >= 2))];
}

export function oscPane(rerender: () => void): { el: HTMLElement; dispose(): void } {
  const tabs = seg(
    [
      { value: 'settings', label: 'Settings' },
      { value: 'logs', label: 'Logs' },
      { value: 'commands', label: 'Commands' },
    ],
    sub,
    (v) => {
      sub = v;
      rerender();
    },
    'osc-tabs',
  );
  let body: HTMLElement;
  let dispose = () => {};
  if (sub === 'logs') {
    const l = logsPane('OSC');
    body = l.el;
    dispose = l.dispose;
  } else if (sub === 'commands') {
    const c = commandBrowser();
    body = c.el;
    dispose = c.dispose;
  } else body = h('div.s-pane', oscSettings());
  return { el: h('div.s-osc', tabs, h('div.s-osc-box.' + sub, body)), dispose };
}

function oscSettings(): HTMLElement {
  const o = store.settings.osc;
  const nics = store.system?.nics ?? [];
  const ifaces: OptionItem[] = [{ value: '', label: 'All' }, ...nics.map((n) => ({ value: n.address, label: `${n.name} (${n.address})` }))];
  if (o.interface && !nics.some((n) => n.address === o.interface)) ifaces.push({ value: o.interface, label: o.interface });

  const fileInput = h('input', { type: 'file', accept: '.txt,text/plain', style: 'display:none' }) as HTMLInputElement;
  const loadFile = async (f: File) => {
    allowListFile = f;
    const ips = parseIps(await f.text());
    await patchGroup('osc', { allowList: ips, allowListPath: f.name });
  };
  fileInput.addEventListener('change', () => fileInput.files?.[0] && void loadFile(fileInput.files[0]));

  const listInfo = o.allowList.length ? `${o.allowList.length} address${o.allowList.length === 1 ? '' : 'es'}${o.allowListPath ? ` · ${o.allowListPath}` : ''}` : 'Empty';

  return section('OSC settings', [
    row('Enable OSC', tog(o.enabled, (v) => void patchGroup('osc', { enabled: v })), { title: 'When enabled, the application will listen for incoming commands and transmit outgoing commands' }),
    row('Transmission IP', field(o.host, (v) => void patchGroup('osc', { host: v.trim() }), { cls: 'wide right' }), {
      info: 'The IP address where GMeet ISO will send outgoing commands',
    }),
    row('Transmission port', numField(o.txPort, (v) => void patchGroup('osc', { txPort: v }), { min: 1, max: 65535, cls: 'wide right' }), {
      title: 'The network port where GMeet ISO will send outgoing commands',
    }),
    row('Receiving port', numField(o.rxPort, (v) => void patchGroup('osc', { rxPort: v }), { min: 1, max: 65535, cls: 'wide right' }), {
      title: 'The network port where GMeet ISO will listen for incoming messages',
    }),
    row('Listen to interface', pick(ifaces, o.interface, (v) => void patchGroup('osc', { interface: v })), {
      title: 'Select the network interface to use for incoming commands, or "All" for all interfaces.',
    }),
    row('OSC control allow list', [h('span.s-dim', listInfo), tog(o.enableAllowList, (v) => void patchGroup('osc', { enableAllowList: v }))], {
      title: 'Restrict which devices are allowed to send OSC commands to GMeet ISO via a list of IP addresses. GMeet ISO will only allow control from these IPs on the selected interface(s).',
    }),
    row(
      'Upload OSC allow list',
      [
        fileInput,
        allowListFile ? sbtn('Reload', () => allowListFile && void loadFile(allowListFile), { title: `Reload ${allowListFile.name}` }) : null,
        sbtn('New', async () => {
          const v = await promptSheet('Allowed IP addresses (comma separated)', o.allowList.join(', '), 'Save');
          if (v !== null) void patchGroup('osc', { allowList: parseIps(v), allowListPath: '' });
        }),
        sbtn('Browse', () => fileInput.click()),
      ],
      { title: 'Configure a .txt file containing the IP addresses to use for the Allow List, one per-line.' },
    ),
    row('OSC baud rate', pick(OSC_BAUD_RATE_OPTIONS, o.baudRate, (v) => void patchGroup('osc', { baudRate: v })), { title: 'The maximum speed GMeet ISO will transmit OSC messages' }),
    row('OSC address header', field(o.prepend, (v) => void patchGroup('osc', { prepend: v.trim() ? '/' + v.trim().replace(/^\/+/, '') : '' }), { placeholder: '/gmeetosc', cls: 'wide right' }), {
      title: "Customize the prefix string on GMeet ISO's OSC outputs to differentiate between devices sending to the same receiver",
    }),
    row('Subscribe to', pick(OSC_SUBSCRIBE_MODE_OPTIONS, o.subscribeMode, (v) => void patchGroup('osc', { subscribeMode: v })), {
      title: 'Determine which group of participants to monitor for sending out OSC events',
    }),
  ]);
}

// ---------------------------------------------------------------- Command Browser
// Support per catalogue row comes from the shared table that src/main/osc/router.ts implements.
const supportOf = (msg: string, type: string) =>
  OSC_SUPPORT.find((e) => e.address === msg && e.type === type) ?? OSC_SUPPORT.find((e) => e.address.toLowerCase() === msg.toLowerCase());

type GroupName = 'Global Commands' | 'User Commands' | 'Outputs';
const GROUP_INFO: Record<GroupName, string> = {
  'Global Commands': 'Commands that control the meeting or application without a target.',
  'User Commands': 'Commands that act on a participant or group target.',
  Outputs: 'Messages emitted by GMeet ISO, including command responses.',
};

interface Cmd {
  idx: number;
  msg: string;
  type: string;
  parent: string;
  children: string;
  title: string;
  category: string;
  syntax: string;
  description: string;
  pro: boolean;
  requireHost: string;
  group: GroupName;
  supported: boolean;
  note: string;
}

const CMDS: Cmd[] = OSC_CATALOG.map((r, idx) => {
  const [msg, type, parent, children, , pro, requireHost, title, category, syntax, description] = r;
  const group: GroupName = type === 'Incoming User Command' ? 'User Commands' : type === 'Incoming Command' ? 'Global Commands' : 'Outputs';
  const sup = supportOf(msg, type);
  return {
    idx, msg, type, parent, children, title, syntax, description, requireHost, group,
    supported: !!sup?.supported,
    note: sup?.note ?? '',
    pro: pro === 'Pro',
    category: (category || 'Other').replace(/ZoomISO/g, 'GMeet ISO').replace(/ZoomOSC/g, 'GMeet ISO'),
  };
}).filter((c) => c.supported); // Only commands GMeet ISO actually handles are listed.

const meetify = (s: string) => s.replace(/ZoomOSC\/ISO/g, 'GMeet ISO').replace(/ZoomOSC|ZoomISO/g, 'GMeet ISO').replace(/\bZoom\b/g, 'Google Meet');

type SimTarget = 'userName' | 'galIndex' | 'targetID';
const SIM_OPTS: OptionItem<SimTarget>[] = [
  { value: 'userName', label: 'User name' },
  { value: 'galIndex', label: 'Gallery index' },
  { value: 'targetID', label: 'Participant ID' },
];
let sim: SimTarget = 'userName';
let simName = '';
let query = '';
const collapsed = new Set<GroupName>();

/** disabledCommands entry: the router matches on the command name after the /gmeet… prefix (in and out). */
function cmdAddresses(c: Cmd): string[] {
  return [`/gmeet/${c.msg}`];
}

function isEnabled(c: Cmd): boolean {
  const dis = store.settings.osc.disabledCommands.map((d) => d.toLowerCase());
  return !cmdAddresses(c).some((a) => dis.includes(a.toLowerCase()));
}

function simArg(): { seg: string; arg: string } {
  const name = simName || store.state?.participants.find((p) => !p.isSelf)?.displayName || 'Participant Name';
  switch (sim) {
    case 'galIndex':
      return { seg: 'galIndex', arg: '1' };
    case 'targetID':
      return { seg: 'targetID', arg: '"' + (store.state?.participants.find((p) => p.displayName === name)?.key ?? 'participant-key') + '"' };
    default:
      return { seg: 'userName', arg: `"${name}"` };
  }
}

/** StyledCommandAddress: prefix / target / command coloured separately, then arguments. */
function addressEl(c: Cmd): { el: HTMLElement; text: string } {
  const t = simArg();
  const syntax = c.syntax.trim();
  if (c.group === 'Outputs') {
    const prefix = store.settings.osc.prepend || '/gmeetosc';
    const mid = c.type === 'Outgoing User Command' ? 'user/' : '';
    const text = `${prefix}/${mid}${c.msg}${syntax ? ' ' + syntax : ''}`;
    return { el: h('code.s-addr', h('span.p', prefix + '/'), mid ? h('span.t', mid) : null, h('b', c.msg), syntax ? h('span.a', ' ' + syntax) : null), text };
  }
  if (c.group === 'User Commands') {
    const text = `/gmeet/${t.seg}/${c.msg}${t.arg ? ' ' + t.arg : ''}${syntax ? ' ' + syntax : ''}`;
    return { el: h('code.s-addr', h('span.p', '/gmeet/'), h('span.t', t.seg + '/'), h('b', c.msg), t.arg ? h('span.v', ' ' + t.arg) : null, syntax ? h('span.a', ' ' + syntax) : null), text };
  }
  const text = `/gmeet/${c.msg}${syntax ? ' ' + syntax : ''}`;
  return { el: h('code.s-addr', h('span.p', '/gmeet/'), h('b', c.msg), syntax ? h('span.a', ' ' + syntax) : null), text };
}

function commandBrowser(): { el: HTMLElement; dispose(): void } {
  const list = h('div.cb-list');
  const outline = h('div.cb-outline');
  const anchors = new Map<string, HTMLElement>();
  const outlineLinks = new Map<string, HTMLElement>();
  const addrPreview = h('div.cb-addr-preview');

  const matches = (c: Cmd) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return [c.msg, c.title, c.description, c.category, c.note, ...cmdAddresses(c)].some((s) => s.toLowerCase().includes(q));
  };

  const card = (c: Cmd): HTMLElement => {
    const a = addressEl(c);
    const enabled = isEnabled(c);
    const sw = tog(enabled, async (v) => {
      for (const address of cmdAddresses(c)) await run({ cmd: 'setOscCommandEnabled', address, enabled: v });
    });
    sw.title = 'Enable or disable the app listening for / sending this OSC command';
    const copy = h('button.cb-copy', { type: 'button', title: 'Copy the complete OSC message' }, icon('copy'));
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(a.text);
      copy.classList.add('done');
      setTimeout(() => copy.classList.remove('done'), 900);
    });
    // Related commands: only those GMeet ISO supports (and so are listed) become links.
    const link = (label: string, names: string) => {
      const targets = names.split(/[,;\s]+/).filter(Boolean).map((n) => CMDS.find((x) => x.msg === n && x.idx !== c.idx)).filter((t): t is Cmd => !!t);
      if (!targets.length) return null;
      return h(
        'div.cb-related',
        h('span.cb-cap', label),
        ...targets.map((target) => {
          const b = h('button.cb-link', { type: 'button' }, `/gmeet/${target.msg}`) as HTMLButtonElement;
          b.addEventListener('click', () => anchors.get('cmd-' + target.idx)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
          return b;
        }),
      );
    };
    const badges = h(
      'div.cb-badges',
      c.note ? h('span.cb-badge.note', meetify(c.note)) : null,
      c.requireHost && c.requireHost !== 'None' ? h('span.cb-badge', `Host: ${c.requireHost.replace(/^Host /, '')}`) : null,
    );
    const el = h(
      'div.cb-card',
      h('div.cb-card-l', h('h4', meetify(c.title || c.msg)), c.description ? h('p', meetify(c.description)) : null, badges),
      h(
        'div.cb-card-m',
        h('div.cb-addr-line', a.el, copy),
        c.parent ? link('RESPONSE TO:', c.parent) : null,
        c.children && c.group !== 'Outputs' ? link('RESPONSES:', c.children) : null,
      ),
      h('div.cb-card-r', sw),
    );
    anchors.set('cmd-' + c.idx, el);
    return el;
  };

  const render = () => {
    list.replaceChildren();
    outline.replaceChildren();
    anchors.clear();
    outlineLinks.clear();
    const groups: GroupName[] = ['Global Commands', 'User Commands', 'Outputs'];
    let total = 0;
    for (const g of groups) {
      const cmds = CMDS.filter((c) => c.group === g && matches(c));
      if (!cmds.length) continue;
      total += cmds.length;
      const cats = [...new Set(cmds.map((c) => c.category))].sort((a, b) => a.localeCompare(b));
      // Outline
      const gHead = h('button.cb-o-group' + (collapsed.has(g) ? '.collapsed' : ''), { type: 'button' }, icon('chevronDown'), icon(g === 'Outputs' ? 'externalLink' : g === 'User Commands' ? 'person' : 'osc'), g);
      gHead.addEventListener('click', () => {
        if (collapsed.has(g)) collapsed.delete(g);
        else collapsed.add(g);
        render();
      });
      outline.append(gHead);
      // List section header (FloatingMacroHeader)
      const sec = h('div.cb-group', h('div.cb-macro', h('h3', g), h('span', GROUP_INFO[g]), h('span.cb-count', `${cmds.length} command${cmds.length === 1 ? '' : 's'}`)));
      for (const cat of cats) {
        const id = `cat-${g}-${cat}`;
        if (!collapsed.has(g)) {
          const l = h('button.cb-o-cat', { type: 'button' }, cat);
          l.addEventListener('click', () => anchors.get(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
          outline.append(l);
          outlineLinks.set(id, l);
        }
        const catEl = h('div.cb-cat', h('h5', cat));
        anchors.set(id, catEl);
        sec.append(catEl, ...cmds.filter((c) => c.category === cat).map(card));
      }
      list.append(sec);
    }
    if (!total) list.append(h('div.cb-empty', `No commands match “${query}”`));
    addrPreview.textContent = `/gmeet/${simArg().seg}/…`;
    spy();
  };

  const spy = () => {
    const top = list.getBoundingClientRect().top + 60;
    let cur = '';
    for (const [id, el] of anchors) if (id.startsWith('cat-') && el.getBoundingClientRect().top <= top) cur = id;
    outlineLinks.forEach((l, id) => l.classList.toggle('active', id === cur));
  };
  list.addEventListener('scroll', spy, { passive: true });

  const search = h('input.cb-search', { type: 'search', placeholder: 'Search name, description, or OSC address', value: query, spellcheck: 'false' }) as HTMLInputElement;
  search.addEventListener('input', () => {
    query = search.value.trim();
    render();
  });
  const nameField = field(simName, (v) => {
    simName = v;
    render();
  }, { placeholder: 'Participant Name', cls: 'cb-name' });

  const header = h(
    'div.cb-header',
    h('label.cb-search-wrap', icon('search'), search),
    h('div.cb-hfield', h('span.cb-cap', 'SIMULATE TARGET'), pick(SIM_OPTS, sim, (v) => {
      sim = v;
      render();
    })),
    h('div.cb-hfield', h('span.cb-cap', 'OSC ADDRESS'), addrPreview),
    h('div.cb-hfield', h('span.cb-cap', 'PARTICIPANT NAME'), nameField),
  );
  render();
  return { el: h('div.cb', header, h('div.cb-body', outline, list)), dispose: () => {} };
}

// Exposed for self-checks.
export const commandStats = () => ({ total: CMDS.length, catalog: OSC_CATALOG.length });
