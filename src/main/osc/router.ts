// ZoomOSC / ZoomISO v3 compatible OSC router for GMeet ISO.
//
// Incoming:  /{gmeet|gmeetiso|zoom|zoomosc}/[target]/<command> args…
//   target  = userName <str> | galleryIndex|galIndex <int> | zoomID|targetID <int> | pID|participantID <str>
//             | galleryPosition <int> | me | all | panelists | attendees
//             | allExcept/<type> <v> | panelistsExcept/<type> <v> | attendeesExcept/<type> <v>
//             | users/<type> <v> <v> …
// Outgoing:  <header>/user/<event> | <header>/me/<event> {int targetIndex} {str userName} {int galleryIndex} {int zoomID} …
//            <header>/<reply>  (pong, outputRouting, engineState, audioLevels, galleryOrder, …)
// See docs/osc.md. Pure module (no Electron imports) so scripts/test-osc.js can bundle and exercise it.

import type { Command, MeetState, OscSubscribeMode, OutputConfig, OutputMode, LossMode, EmbeddedAudio, ParticipantState, Settings } from '../../shared/types';
import { OSC_SUPPORT } from '../../shared/oscSupport';

export type OscArg = number | string | boolean | null;
export interface OscMsg {
  address: string;
  args: OscArg[];
}
export type Send = (address: string, args: OscArg[], coalesceKey?: string) => void;

export interface OscRouterContext {
  settings(): Settings;
  state(): MeetState | null;
  exec(c: Command): Promise<unknown>;
  /** Unsolicited output (subscriptions); goes through the baud-rate queue. */
  send: Send;
  log(s: string): void;
  version: string;
}

const PREFIXES = new Set(['gmeet', 'gmeetiso', 'zoom', 'zoomosc']);
const ZOOM_FAMILY = new Set(['zoom', 'zoomosc']);
export const DEFAULT_HEADER = '/gmeetosc';

export const SUBSCRIBE_MODES: OscSubscribeMode[] = ['none', 'targetList', 'all', 'panelists', 'gallery'];

/** ZoomISO Mode picker, 0-based, Gallery omitted (catalogue: "5 is Active Screenshare"). */
const MODE_BY_INDEX: (OutputMode | null)[] = ['participant', 'activeSpeaker', 'activeSpeaker', null, 'screenshare', 'screenshare', 'auto'];
const MODE_BY_NAME: Record<string, OutputMode> = {
  participant: 'participant',
  activespeaker: 'activeSpeaker',
  speaker: 'activeSpeaker',
  uniquespeaker: 'activeSpeaker',
  screenshare: 'screenshare',
  activescreenshare: 'screenshare',
  screen: 'screenshare',
  auto: 'auto',
};
const MODE_LABEL: Record<OutputMode, string> = { participant: 'Participant', activeSpeaker: 'Active Speaker', screenshare: 'Active Screenshare', auto: 'Auto' };
/** Catalogue setVideoLossMode: 0 Black, 1 Transparent, 2 Image, 3 Testcard, 4 Freeze, 5 Color Bars, 6 Profile Picture. */
const LOSS_BY_INDEX: LossMode[] = ['black', 'transparent', 'image', 'testcard', 'freeze', 'testcard', 'profilePicture'];
const LOSS_BY_NAME: Record<string, LossMode> = {
  black: 'black',
  transparent: 'transparent',
  image: 'image',
  testcard: 'testcard',
  freeze: 'freeze',
  colorbars: 'testcard',
  bars: 'testcard',
  profilepicture: 'profilePicture',
  profile: 'profilePicture',
};
const AUDIO_BY_INDEX: EmbeddedAudio[] = ['off', 'iso', 'mix'];

const norm = (v: OscArg | undefined) => String(v ?? '').toLowerCase().replace(/[\s_-]+/g, '');
const isInt = (v: OscArg | undefined) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+$/.test(v));

type TargetKind = 'username' | 'galleryindex' | 'zoomid' | 'pid' | 'galleryposition';
const TARGET_TYPES: Record<string, TargetKind> = {
  username: 'username',
  name: 'username',
  galleryindex: 'galleryindex',
  galindex: 'galleryindex',
  galleryposition: 'galleryposition',
  galpos: 'galleryposition',
  zoomid: 'zoomid',
  targetid: 'zoomid',
  participantid: 'pid',
  pid: 'pid',
};
const GROUPS = new Set(['all', 'panelists', 'attendees']);

export interface ParsedAddress {
  family: string;
  /** Command name (lower-case) after the target, e.g. "pin", "outputiso", "all/mute". */
  cmd: string;
  target: null | { group?: 'all' | 'me'; except?: boolean; multi?: boolean; kind?: TargetKind };
}

/** Split an address into prefix family, target and command. Returns null if the prefix isn't ours. */
export function parseAddress(address: string): ParsedAddress | null {
  const parts = address.split('/').filter(Boolean);
  if (!parts.length) return null;
  const family = parts[0].toLowerCase();
  if (!PREFIXES.has(family)) return null;
  const rest = parts.slice(1).map((p) => p.toLowerCase());
  const t0 = rest[0];
  if (rest.length >= 2) {
    // ZoomOSC global commands that look like targets.
    if (t0 === 'all' && (rest[1] === 'mute' || rest[1] === 'unmute') && rest.length === 2) return { family, cmd: rest.join('/'), target: null };
    if (t0 === 'me') return { family, cmd: rest.slice(1).join('/'), target: { group: 'me' } };
    if (GROUPS.has(t0)) return { family, cmd: rest.slice(1).join('/'), target: { group: 'all' } };
    if (TARGET_TYPES[t0]) return { family, cmd: rest.slice(1).join('/'), target: { kind: TARGET_TYPES[t0] } };
    const exc = /^(all|panelists|attendees)except$/.exec(t0);
    if (exc && rest.length >= 2) {
      if (rest[1] === 'me') return { family, cmd: rest.slice(2).join('/'), target: { group: 'me', except: true } };
      if (TARGET_TYPES[rest[1]] && rest.length >= 3) return { family, cmd: rest.slice(2).join('/'), target: { kind: TARGET_TYPES[rest[1]], except: true } };
    }
    if (t0 === 'users' && TARGET_TYPES[rest[1]] && rest.length >= 3) return { family, cmd: rest.slice(2).join('/'), target: { kind: TARGET_TYPES[rest[1]], multi: true } };
  }
  return { family, cmd: rest.join('/'), target: null };
}

/** Commands whose args after the target list are command arguments (so users/* can't swallow them). */
const TRAILING_ARGS: Record<string, number> = { outputiso: 1, chat: 1, rename: 1, audioiso: 1 };

export class OscRouter {
  private zoomIds = new Map<string, number>();
  private nextZoomId = 16778241;
  private galTrackMode = 1; // 0 = participantID, 1 = zoomID
  private zoomClients = false;
  private prev: MeetState | null = null;
  private prevEngine: string | null = null;

  constructor(private ctx: OscRouterContext) {}

  // ---------- identity ----------
  zoomId(p: ParticipantState | string): number {
    const key = typeof p === 'string' ? p : p.participantId || p.key;
    let id = this.zoomIds.get(key);
    if (id === undefined) {
      id = this.nextZoomId++;
      this.zoomIds.set(key, id);
    }
    return id;
  }

  /** People (camera feeds) in gallery order; self included (ZoomOSC galleries include self). */
  gallery(state = this.ctx.state()): ParticipantState[] {
    return (state?.participants ?? []).filter((p) => p.kind === 'camera');
  }

  private header(): string {
    const p = (this.ctx.settings().osc.prepend || DEFAULT_HEADER).replace(/\/+$/, '');
    return p === DEFAULT_HEADER && this.zoomClients ? '/zoomosc' : p;
  }

  private disabled(name: string): boolean {
    const n = name.toLowerCase();
    return this.ctx.settings().osc.disabledCommands.some((d) => d.toLowerCase().replace(/^\/?(gmeetiso|gmeetosc|gmeet|zoomosc|zoom)\//, '').replace(/^\//, '') === n);
  }

  private targetIndex(p: ParticipantState): number {
    const outs = this.ctx.settings().outputs;
    const i = outs.findIndex((o) => p.outputs.includes(o.id) || o.selection?.key === p.key);
    return i >= 0 ? i + 1 : -1;
  }

  userArgs(p: ParticipantState, gal = this.gallery()): OscArg[] {
    return [this.targetIndex(p), p.displayName, gal.indexOf(p), this.zoomId(p)];
  }

  private userAddr(p: ParticipantState, ev: string): string {
    return `${this.header()}/${p.isSelf ? 'me' : 'user'}/${ev}`;
  }

  // ---------- targets ----------
  private findOne(kind: TargetKind, v: OscArg, gal: ParticipantState[]): ParticipantState | undefined {
    switch (kind) {
      case 'username': {
        const s = String(v ?? '');
        return gal.find((p) => p.displayName === s) ?? gal.find((p) => p.displayName.toLowerCase() === s.toLowerCase());
      }
      case 'galleryindex':
      case 'galleryposition':
        return isInt(v) ? gal[Number(v)] : undefined;
      case 'zoomid': {
        if (isInt(v)) {
          const n = Number(v);
          const key = [...this.zoomIds.entries()].find(([, id]) => id === n)?.[0];
          if (key) return gal.find((p) => (p.participantId || p.key) === key);
        }
        return gal.find((p) => p.participantId === String(v) || p.key === String(v));
      }
      case 'pid':
        return gal.find((p) => p.participantId === String(v) || p.key === String(v));
    }
  }

  /** Resolve the target, consuming its args. Returns participants + remaining args. */
  resolve(t: NonNullable<ParsedAddress['target']>, cmd: string, args: OscArg[]): { users: ParticipantState[]; rest: OscArg[] } {
    const gal = this.gallery();
    if (t.group === 'me') {
      const me = gal.filter((p) => p.isSelf);
      return { users: t.except ? gal.filter((p) => !p.isSelf) : me, rest: args };
    }
    if (t.group === 'all') return { users: gal, rest: args };
    const kind = t.kind!;
    if (t.multi) {
      const n = Math.max(1, args.length - (TRAILING_ARGS[cmd] ?? 0));
      const vals = args.slice(0, n);
      return { users: vals.map((v) => this.findOne(kind, v, gal)).filter((p): p is ParticipantState => !!p), rest: args.slice(n) };
    }
    const hit = this.findOne(kind, args[0], gal);
    if (t.except) return { users: gal.filter((p) => p !== hit), rest: args.slice(1) };
    return { users: hit ? [hit] : [], rest: args.slice(1) };
  }

  // ---------- incoming ----------
  /**
   * Handle one OSC message. Returns true when consumed (handled, rejected or errored);
   * false lets legacy /gmeet handlers in main.ts try it (saveShow, applyLayout, …).
   */
  async handle(m: OscMsg, reply: Send, from: { address: string }): Promise<boolean> {
    const parsed = parseAddress(m.address);
    if (!parsed) return false;
    const o = this.ctx.settings().osc;
    if (o.enableAllowList && o.allowList.length && !o.allowList.includes(from.address.replace(/^::ffff:/, ''))) {
      this.ctx.log(`OSC: ignored ${m.address} from ${from.address} (not on allow list)`);
      return true;
    }
    if (ZOOM_FAMILY.has(parsed.family)) this.zoomClients = true;
    if (this.disabled(parsed.cmd) || o.disabledCommands.some((d) => d.toLowerCase() === m.address.toLowerCase())) {
      this.ctx.log(`OSC: ${m.address} is disabled in the Command Browser`);
      return true;
    }
    const H = this.header();
    try {
      const done = await this.dispatch(parsed, m.args, (a, args) => reply(H + a, args));
      if (!done) {
        const sup = OSC_SUPPORT.find((e) => e.address.toLowerCase() === parsed.cmd);
        if (sup && !sup.supported) throw new Error(`${sup.address} is not supported in Google Meet: ${sup.note}`);
        return false;
      }
      if (!ZOOM_FAMILY.has(parsed.family)) reply(`${DEFAULT_HEADER}/ok`, [m.address]);
      return true;
    } catch (e) {
      const msg = `${m.address}: ${(e as Error).message}`;
      this.ctx.log(`OSC ${msg}`);
      if (!this.disabled('oscErrors')) reply(`${H}/oscErrors`, [msg]);
      return true;
    }
  }

  private out(v: OscArg | undefined): number | string {
    if (v === undefined || v === null || v === '') throw new Error('missing output');
    return isInt(v) ? Number(v) : String(v);
  }

  private async dispatch(p: ParsedAddress, args: OscArg[], r: (a: string, args: OscArg[]) => void): Promise<boolean> {
    if (p.target) return this.userCommand(p, args);
    const c = this.ctx;
    const st = c.state();
    const s = c.settings();
    const run = (cmd: Command) => c.exec(cmd);
    switch (p.cmd) {
      // ---- App info ----
      case 'ping':
        r('/pong', [args[0] ?? 0, c.version, SUBSCRIBE_MODES.indexOf(s.osc.subscribeMode), this.galTrackMode, st?.inCall ? 1 : 0, s.outputs.length, this.gallery().length, 1]);
        return true;
      // ---- Gallery / subscription ----
      case 'subscribe': {
        const mode = isInt(args[0]) ? SUBSCRIBE_MODES[Number(args[0])] : SUBSCRIBE_MODES.find((x) => x.toLowerCase() === norm(args[0]));
        if (!mode) throw new Error(`bad subscribe mode ${args[0]}`);
        await run({ cmd: 'setOscSubscribe', mode });
        return true;
      }
      case 'galtrackmode':
        this.galTrackMode = Number(args[0]) ? 1 : 0;
        return true;
      case 'gallerycount':
        r('/galleryCount', [this.gallery().length]);
        return true;
      case 'getgalleryorder':
        r('/galleryOrder', this.galleryOrderArgs());
        return true;
      case 'getspotorder':
        r('/spotOrder', this.gallery().filter((x) => x.spotlit).map((x) => this.zoomId(x)));
        return true;
      case 'list':
        this.sendList(r);
        return true;
      // ---- Chat ----
      case 'chatall':
      case 'chat': // legacy /gmeet/chat <text> (no target) = everyone
        await run({ cmd: 'chat', text: String(args[0] ?? '') });
        return true;
      // ---- Waiting room ----
      case 'admitall':
        await run({ cmd: 'admit', who: 'all' });
        return true;
      case 'admit':
        await run({ cmd: 'admit', who: args[0] ? String(args[0]) : 'all' });
        return true;
      case 'listwaitingroomusers': {
        const w = st?.waiting ?? [];
        w.forEach((name, i) => r('/waitingRoomUserList', [i, w.length, 0, name, name]));
        return true;
      }
      // ---- Global ----
      case 'joinmeeting':
      case 'join':
      case 'startmeeting': {
        const id = String(args[0] ?? (p.cmd === 'startmeeting' ? 'new' : s.lastMeetUrl) ?? '').trim();
        if (!id) throw new Error('missing meeting ID');
        await run({ cmd: 'join', url: /^https?:\/\//i.test(id) ? id : `https://meet.google.com/${id.replace(/^meet\.google\.com\//i, '')}` });
        return true;
      }
      case 'leavemeeting':
      case 'leave':
        await run({ cmd: 'leave' });
        return true;
      case 'all/mute':
        await run({ cmd: 'muteAll' });
        return true;
      case 'lowerallhands':
        await run({ cmd: 'lowerHand' });
        return true;
      case 'clearpin':
        for (const x of this.gallery().filter((x) => x.pinned)) await run({ cmd: 'pin', participant: x.key, on: false });
        return true;
      case 'clearspot':
        for (const x of this.gallery().filter((x) => x.spotlit)) await run({ cmd: 'spotlight', participant: x.key, on: false });
        return true;
      // ---- Recording ----
      case 'startlocalrecording':
      case 'startrecording':
        await run({ cmd: 'startRecording', outputs: args.length ? args.map((a) => this.out(a)) : undefined });
        return true;
      case 'stoplocalrecording':
      case 'stoprecording':
        await run({ cmd: 'stopRecording', outputs: args.length ? args.map((a) => this.out(a)) : undefined });
        return true;
      // ---- ISO engine / outputs ----
      case 'startisoengine':
      case 'enableisoengine':
        await run({ cmd: 'engine', state: 'enabled' });
        return true;
      case 'standbyisoengine':
        await run({ cmd: 'engine', state: 'standby' });
        return true;
      case 'stopisoengine':
      case 'disableisoengine':
        await run({ cmd: 'engine', state: 'disabled' });
        return true;
      case 'getenginestate':
      case 'getengine':
        r('/engineState', [engineInt(s.engine)]);
        return true;
      case 'setoutputcount': {
        const n = Number(args[0]);
        if (!Number.isFinite(n) || n < 1 || n > 64) throw new Error(`bad count ${args[0]}`);
        await run({ cmd: 'setOutputCount', count: n });
        return true;
      }
      case 'addoutput':
        await run({ cmd: 'addOutput', patch: args[0] ? { name: String(args[0]) } : undefined });
        return true;
      case 'deleteoutput':
        await run({ cmd: 'deleteOutput', output: this.out(args[0]) });
        return true;
      case 'enableoutput':
      case 'disableoutput':
        await run({ cmd: 'updateOutput', output: this.out(args[0]), patch: { enabled: p.cmd === 'enableoutput' } });
        return true;
      case 'setoutputname':
        await run({ cmd: 'updateOutput', output: this.out(args[0]), patch: { name: String(args[1] ?? '') } });
        return true;
      case 'setoutputmode': {
        const mode = isInt(args[1]) ? MODE_BY_INDEX[Number(args[1])] : MODE_BY_NAME[norm(args[1])];
        if (!mode) throw new Error(`mode ${args[1]} is not available in Google Meet`);
        await run({ cmd: 'updateOutput', output: this.out(args[0]), patch: { mode } });
        return true;
      }
      case 'setoutputembeddedaudio':
      case 'setoutputaudio': {
        const audio = isInt(args[1]) ? AUDIO_BY_INDEX[Number(args[1])] : (norm(args[1]) as EmbeddedAudio);
        if (!AUDIO_BY_INDEX.includes(audio)) throw new Error(`bad audio mode ${args[1]}`);
        await run({ cmd: 'updateOutput', output: this.out(args[0]), patch: { audio, useDefaultAudioMode: false } });
        return true;
      }
      case 'setvideolossmode': {
        const mode = isInt(args[0]) ? LOSS_BY_INDEX[Number(args[0])] : LOSS_BY_NAME[norm(args[0])];
        if (!mode) throw new Error(`bad loss mode ${args[0]}`);
        await run({ cmd: 'setVideoLoss', patch: { mode } });
        return true;
      }
      case 'setoutputselection':
        await this.setSelection(this.out(args[0]), args[1]);
        return true;
      case 'getoutputrouting':
      case 'getoutputs':
        this.sendRouting(r);
        return true;
      case 'getaudiolevels':
        this.sendAudioLevels(r);
        return true;
      case 'getactivespeaker': {
        const sp = this.gallery().find((x) => x.key === st?.activeSpeaker);
        if (sp) r(`/${sp.isSelf ? 'me' : 'user'}/activeSpeaker`, this.userArgs(sp));
        return true;
      }
    }
    return false;
  }

  private async setSelection(output: number | string, v: OscArg | undefined): Promise<void> {
    const gal = this.gallery().filter((p) => !p.isSelf);
    let participant: string | null;
    if (v === undefined || v === null || v === '' || (isInt(v) && Number(v) === 0)) participant = null;
    else if (isInt(v) && Number(v) === 1) {
      await this.ctx.exec({ cmd: 'updateOutput', output, patch: { mode: 'auto', selection: null, isAutoAssign: true } });
      return;
    } else if (isInt(v) && Number(v) >= 2 && Number(v) <= gal.length + 1) participant = gal[Number(v) - 2].key;
    else if (isInt(v)) {
      const hit = this.findOne('zoomid', v, this.gallery());
      if (!hit) throw new Error(`no participant with zoomID ${v}`);
      participant = hit.key;
    } else participant = (this.findOne('username', v, this.gallery()) ?? null)?.key ?? String(v);
    await this.ctx.exec({ cmd: 'route', output, participant });
  }

  private async userCommand(p: ParsedAddress, args: OscArg[]): Promise<boolean> {
    const { users, rest } = this.resolve(p.target!, p.cmd, args);
    const run = (c: Command) => this.ctx.exec(c);
    const st = this.ctx.state();
    const meOnly = (what: string) => {
      const others = users.filter((u) => !u.isSelf);
      if (others.length) throw new Error(`${what} only works on "me" in Google Meet`);
    };
    const need = () => {
      if (!users.length) throw new Error('no matching participant');
    };
    switch (p.cmd) {
      case 'pin':
      case 'addpin':
        need();
        await run({ cmd: 'pin', participant: users[users.length - 1].key, on: true });
        return true;
      case 'unpin':
        for (const u of users) await run({ cmd: 'pin', participant: u.key, on: false });
        return true;
      case 'togglepin':
        for (const u of users) await run({ cmd: 'pin', participant: u.key, on: !u.pinned });
        return true;
      case 'spot':
      case 'addspot':
        need();
        await run({ cmd: 'spotlight', participant: users[users.length - 1].key, on: true });
        return true;
      case 'unspot':
        for (const u of users) await run({ cmd: 'spotlight', participant: u.key, on: false });
        return true;
      case 'togglespot':
        for (const u of users) await run({ cmd: 'spotlight', participant: u.key, on: !u.spotlit });
        return true;
      case 'mute':
        need();
        for (const u of users) await run(u.isSelf ? { cmd: 'setMic', on: false } : { cmd: 'muteParticipant', participant: u.key });
        return true;
      case 'unmute':
        need();
        meOnly('unMute');
        await run({ cmd: 'setMic', on: true });
        return true;
      case 'togglemute':
        need();
        for (const u of users) {
          if (u.isSelf) await run({ cmd: 'setMic', on: !(st?.micOn ?? !u.muted) });
          else if (!u.muted) await run({ cmd: 'muteParticipant', participant: u.key });
          else throw new Error('Google Meet cannot unmute other participants');
        }
        return true;
      case 'videoon':
      case 'videooff':
      case 'togglevideo':
        need();
        meOnly(p.cmd);
        await run({ cmd: 'setCam', on: p.cmd === 'videoon' ? true : p.cmd === 'videooff' ? false : !(st?.camOn ?? users[0].hasVideo) });
        return true;
      case 'raisehand':
        need();
        meOnly('raiseHand');
        await run({ cmd: 'raiseHand', on: true });
        return true;
      case 'lowerhand':
        need();
        for (const u of users) await run(u.isSelf ? { cmd: 'raiseHand', on: false } : { cmd: 'lowerHand', participant: u.key });
        return true;
      case 'togglehand':
        need();
        for (const u of users) {
          if (u.isSelf) await run({ cmd: 'raiseHand', on: !u.handRaised });
          else if (u.handRaised) await run({ cmd: 'lowerHand', participant: u.key });
          else throw new Error('Google Meet cannot raise hands for other participants');
        }
        return true;
      case 'eject':
      case 'remove':
        need();
        for (const u of users) if (!u.isSelf) await run({ cmd: 'removeParticipant', participant: u.key });
        return true;
      case 'outputiso': {
        need();
        await run({ cmd: 'route', output: this.out(rest[0]), participant: users[users.length - 1].key });
        return true;
      }
      case 'admit': {
        // /zoom/userName/admit "Name": waiting-room users are matched by name.
        const name = String(args[0] ?? '');
        await run({ cmd: 'admit', who: name || 'all' });
        return true;
      }
    }
    if (p.cmd === 'chat') throw new Error('Google Meet has no private chat; use chatAll');
    const sup = OSC_SUPPORT.find((e) => e.address.toLowerCase() === p.cmd);
    if (sup && !sup.supported) throw new Error(`${sup.address} is not supported in Google Meet: ${sup.note}`);
    throw new Error(`unknown user command ${p.cmd}`);
  }

  // ---------- replies ----------
  galleryOrderArgs(): OscArg[] {
    return this.gallery().map((x) => (this.galTrackMode ? this.zoomId(x) : x.participantId || x.key));
  }

  private subscribed(state: MeetState | null): ParticipantState[] {
    const gal = this.gallery(state);
    switch (this.ctx.settings().osc.subscribeMode) {
      case 'none':
        return [];
      case 'targetList':
        return gal.filter((p) => this.targetIndex(p) > 0);
      case 'gallery':
        return gal.filter((p) => p.hasVideo);
      default:
        return gal;
    }
  }

  sendList(r: (a: string, args: OscArg[]) => void): void {
    const gal = this.gallery();
    const list = this.subscribed(this.ctx.state());
    const targets = gal.filter((p) => this.targetIndex(p) > 0).length;
    r('/listCleared', []);
    for (const p of list)
      r(`/${p.isSelf ? 'me' : 'user'}/list`, [
        ...this.userArgs(p, gal),
        targets,
        list.length,
        role(p),
        1,
        p.hasVideo ? 1 : 0,
        p.muted ? 0 : 1,
        p.handRaised ? 1 : 0,
      ]);
  }

  sendRouting(r: (a: string, args: OscArg[]) => void): void {
    const s = this.ctx.settings();
    const st = this.ctx.state();
    s.outputs.forEach((o, i) => {
      const live = st?.outputs.find((x) => x.id === o.id);
      const shown = live?.sourceKey ? this.gallery().find((p) => p.key === live.sourceKey || live.sourceKey!.startsWith(p.key + ':')) : undefined;
      let sel = 0;
      if (o.mode === 'activeSpeaker') sel = shown ? this.zoomId(shown) : 0;
      else if (o.selection) {
        const p = this.gallery().find((x) => x.key === o.selection!.key || x.key === o.selection!.key.replace(/:screen$/, ''));
        sel = p ? this.zoomId(p) : this.zoomId(o.selection.key);
      } else sel = o.mode === 'auto' || o.isAutoAssign ? 1 : 0;
      const res = o.format ? `${o.format.width}x${o.format.height}` : live?.outWidth ? `${live.outWidth}x${live.outHeight}` : 'native';
      r('/outputRouting', [s.outputs.length, i + 1, o.enabled ? 1 : 0, o.name, MODE_LABEL[o.mode], sel, res, audioLabel(o, s), live?.status ?? (o.enabled ? 'standby' : 'off')]);
    });
  }

  sendAudioLevels(r: (a: string, args: OscArg[]) => void): void {
    const st = this.ctx.state();
    this.ctx.settings().outputs.forEach((o, i) => {
      const live = st?.outputs.find((x) => x.id === o.id);
      const p = st?.participants.find((x) => x.key === live?.sourceKey);
      r('/audioLevels', [i + 1, Math.round(Math.min(1, p?.level ?? 0) * 255)]);
    });
  }

  // ---------- subscriptions ----------
  /** Diff the new Meet state against the last one and emit ZoomOSC user events. */
  onState(next: MeetState): void {
    const prev = this.prev;
    this.prev = next;
    const H = this.header();
    const send = (addr: string, args: OscArg[], key?: string) => {
      const ev = addr.slice(addr.lastIndexOf('/') + 1);
      if (!this.disabled(ev)) this.ctx.send(H + addr, args, key);
    };
    const s = this.ctx.settings();
    if (this.prevEngine !== null && this.prevEngine !== s.engine) send('/engineState', [engineInt(s.engine)], 'engineState');
    this.prevEngine = s.engine;
    if (!prev) return;
    if (prev.phase !== next.phase || prev.inCall !== next.inCall) send('/meetingStatusChanged', [meetingStatus(next), 0, 0], 'meetingStatus');
    if (s.osc.subscribeMode === 'none') return;
    const gal = this.gallery(next);
    const subs = new Set(this.subscribed(next).map((p) => p.key));
    const before = new Map(this.gallery(prev).map((p) => [p.key, p]));
    const ev = (p: ParticipantState, name: string, extra: OscArg[] = []) => {
      if (!subs.has(p.key) && name !== 'offline') return;
      const a = this.userAddr(p, name).slice(H.length);
      send(a, [...this.userArgs(p, gal), ...extra], `${name}:${p.key}`);
    };
    for (const p of gal) {
      const o = before.get(p.key);
      if (!o) {
        ev(p, 'online');
        continue;
      }
      if (o.displayName !== p.displayName) ev(p, 'userNameChanged', [o.displayName]);
      if (o.hasVideo !== p.hasVideo) ev(p, p.hasVideo ? 'videoOn' : 'videoOff');
      if (o.muted !== p.muted && p.muted !== null) ev(p, p.muted ? 'mute' : 'unMute');
      if (o.handRaised !== p.handRaised) ev(p, p.handRaised ? 'handRaised' : 'handLowered');
      if (o.speaking !== p.speaking) ev(p, p.speaking ? 'isSpeaking' : 'stoppedSpeaking');
      if (!!o.spotlit !== !!p.spotlit) ev(p, p.spotlit ? 'spotlightOn' : 'spotlightOff');
      if (role(o) !== role(p)) ev(p, 'roleChanged', [role(p)]);
    }
    const nowKeys = new Set(gal.map((p) => p.key));
    for (const [k, o] of before) {
      if (nowKeys.has(k)) continue;
      const a = this.userAddr(o, 'offline').slice(H.length);
      if (subs.size || s.osc.subscribeMode !== 'targetList') send(a, [this.targetIndex(o), o.displayName, -1, this.zoomId(o)]);
    }
    if (next.activeSpeaker && next.activeSpeaker !== prev.activeSpeaker) {
      const sp = gal.find((p) => p.key === next.activeSpeaker);
      if (sp && subs.has(sp.key)) send(this.userAddr(sp, 'activeSpeaker').slice(H.length), this.userArgs(sp, gal), 'activeSpeaker');
    }
    const pw = new Set(prev.waiting ?? []);
    const nw = new Set(next.waiting ?? []);
    for (const w of nw) if (!pw.has(w)) send('/user/joinedWaitingRoom', [-1, w, -1, 0]);
    for (const w of pw) if (!nw.has(w)) send('/user/leftWaitingRoom', [-1, w, -1, 0]);
    const po = this.gallery(prev).map((p) => p.key).join('|');
    if (po !== gal.map((p) => p.key).join('|')) {
      send('/galleryCount', [gal.length], 'galleryCount');
      send('/galleryOrder', this.galleryOrderArgs(), 'galleryOrder');
    }
  }
}

function engineInt(e: string): number {
  return e === 'enabled' ? 2 : e === 'standby' ? 1 : 0;
}
/** Zoom SDK user roles: 1 host, 2 co-host, 5 attendee. */
function role(p: ParticipantState): number {
  return p.isHost ? 1 : p.isCohost ? 2 : 5;
}
/** Zoom MeetingStatus codes: 0 idle, 1 connecting, 3 in meeting, 7 ended, 8 waiting room, 9 unknown/failed. */
function meetingStatus(s: MeetState): number {
  if (s.inCall || s.phase === 'in-call') return 3;
  if (s.phase === 'waiting') return 8;
  if (s.phase === 'green-room' || s.phase === 'loading') return 1;
  if (s.phase === 'ended') return 7;
  if (s.phase === 'denied') return 9;
  return 0;
}
function audioLabel(o: OutputConfig, s: Settings): string {
  const a = o.useDefaultAudioMode ? (s as unknown as { embeddedAudio?: { defaultMode?: string } }).embeddedAudio?.defaultMode ?? o.audio : o.audio;
  return a === 'iso' ? 'ISO' : a === 'mix' ? 'Mix' : 'Off';
}

// ---------- shared active router (for the HTTP/WS API) ----------
let active: OscRouter | null = null;
export function setActiveRouter(r: OscRouter | null): void {
  active = r;
}
export function getActiveRouter(): OscRouter | null {
  return active;
}

/** Run an OSC message through the router and collect its replies (HTTP/WS bridge). */
export async function runOscCollect(address: string, args: OscArg[]): Promise<{ handled: boolean; replies: OscMsg[] }> {
  const r = active;
  if (!r) throw new Error('OSC router not ready');
  const replies: OscMsg[] = [];
  const handled = await r.handle({ address, args }, (a, x) => replies.push({ address: a, args: x }), { address: '127.0.0.1' });
  return { handled, replies };
}
