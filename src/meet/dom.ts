// Google Meet DOM heuristics. Meet's markup is obfuscated and changes without notice,
// so EVERYTHING that depends on Meet's DOM lives in this file. If feeds stop being
// detected after a Meet update, use "Dump Meet DOM" in the control window and adjust here.

export interface TileInfo {
  /** Stable per-feed key: participant id, plus ":screen" for presentations. */
  key: string;
  participantId: string;
  displayName: string;
  isSelf: boolean;
  isScreen: boolean;
  /** False when displayName is only the participant-id fallback (name not rendered yet). */
  hasName: boolean;
  el: HTMLElement;
}

/** Attribute Meet puts on each participant tile (and some nested elements). */
const TILE_ATTR = 'data-participant-id';

const PRESENTING_RE = /\b(presentation|presenting|is presenting|screen)\b/i;

/** Elements that are visible and have nonzero area. */
export function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
}

function cleanName(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Material/Google Symbols ligature text such as "frame_person", "more_vert", "mic_off". */
const ICON_LIGATURE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

function isIconElement(el: Element): boolean {
  const cls = typeof el.className === 'string' ? el.className : '';
  if (/google-symbols|material-icons|material-symbols|icon/i.test(cls)) return true;
  if (el.getAttribute('aria-hidden') === 'true' && ICON_LIGATURE_RE.test(cleanName(el.textContent))) return true;
  return !!el.closest('i, [class*="google-symbols"], [class*="material-symbols"], [class*="material-icons"]');
}

function nameFromTile(tile: HTMLElement): string {
  // 1. The bot's own tile carries data-self-name.
  const self = tile.querySelector<HTMLElement>('[data-self-name]');
  if (self) {
    const n = cleanName(self.getAttribute('data-self-name') || self.textContent);
    if (n) return n;
  }
  // 2. Names are rendered with translate="no" / .notranslate so Chrome won't translate them.
  //    Meet's icon-font ligatures (e.g. "frame_person", "mic_off") use the same markers, so skip
  //    icon elements and snake_case/lowercase single tokens.
  for (const el of Array.from(tile.querySelectorAll<HTMLElement>('.notranslate, [translate="no"]'))) {
    if (isIconElement(el)) continue;
    const n = cleanName(el.textContent);
    if (n && n.length <= 80 && !ICON_LIGATURE_RE.test(n)) return n;
  }
  // 3. Fall back to aria labels / tooltips on the tile.
  const labelled = tile.getAttribute('aria-label') || tile.querySelector('[aria-label]')?.getAttribute('aria-label');
  if (labelled) return cleanName(labelled);
  return '';
}

function isScreenTile(tile: HTMLElement, name: string): boolean {
  if (PRESENTING_RE.test(name)) return true;
  const aria = Array.from(tile.querySelectorAll('[aria-label]'))
    .map((e) => e.getAttribute('aria-label') || '')
    .join(' ');
  if (/presentation/i.test(aria)) return true;
  // Meet labels presentation tiles e.g. "Alice (Presentation)" / "Alice is presenting".
  const text = cleanName(tile.innerText).slice(0, 200);
  return /\(presentation\)|is presenting|presenting now/i.test(text);
}

/** Strip "(Presentation)" style suffixes so screen feeds are named after the presenter. */
function presenterName(name: string): string {
  return cleanName(name.replace(/\(presentation\)|\bis presenting\b|\bpresentation\b|\bpresenting\b/gi, ''));
}

/** Bot account display name (from settings), set by the preload. */
let botName = '';
export function setBotName(n: string): void {
  botName = cleanName(n).toLowerCase();
}

/** True if any <video> in the tile plays a camera track our media shim handed to Meet. */
function playsOwnCamera(tile: HTMLElement): boolean {
  const ids = document.documentElement?.dataset.gmeetIsoCamTracks;
  if (!ids) return false;
  const set = new Set(ids.split(','));
  for (const v of Array.from(tile.querySelectorAll('video'))) {
    const s = v.srcObject;
    if (s instanceof MediaStream && s.getVideoTracks().some((t) => set.has(t.id))) return true;
  }
  return false;
}

/** Participant ids learned to be the bot (sticky for the page lifetime). */
const selfIds = new Set<string>();

/** Read the signed-in account's name from Meet's account button ("Google Account: Name (email)"). */
export function accountName(): string {
  for (const el of Array.from(document.querySelectorAll('[aria-label*="Google Account" i]'))) {
    const label = el.getAttribute('aria-label') ?? '';
    const m = label.match(/Google Account:\s*([^(\n]+?)\s*(\(|\n|$)/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

/** Find every participant tile currently in the DOM, deduplicated by key. */
export function findTiles(): TileInfo[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[${TILE_ATTR}]`));
  // Keep only outermost tile elements per participant id (Meet nests the attribute).
  const outermost = nodes.filter((el) => {
    const id = el.getAttribute(TILE_ATTR);
    const parent = el.parentElement?.closest(`[${TILE_ATTR}="${CSS.escape(id ?? '')}"]`);
    return !parent;
  });

  const out = new Map<string, TileInfo>();
  for (const el of outermost) {
    const participantId = el.getAttribute(TILE_ATTR) || '';
    if (!participantId) continue;
    // Ignore participant-list rows etc.: a tile must contain a <video> or be large.
    const r = el.getBoundingClientRect();
    if (!el.querySelector('video') && (r.width < 120 || r.height < 80)) continue;

    const rawName = nameFromTile(el);
    // Meet doesn't mark the local tile, so: our camera track, or the bot's account name.
    if (playsOwnCamera(el)) selfIds.add(participantId);
    const isSelf =
      !!el.querySelector('[data-self-name]') ||
      selfIds.has(participantId) ||
      (!!botName && cleanName(rawName).toLowerCase() === botName);
    const isScreen = isScreenTile(el, rawName);
    const displayName = (isScreen ? presenterName(rawName) : rawName) || participantId.split('/').pop() || 'Unknown';
    const key = isScreen ? `${participantId}:screen` : participantId;

    const existing = out.get(key);
    // If duplicated (e.g. filmstrip + stage), prefer the bigger, visible one: higher-res stream.
    if (existing) {
      const er = existing.el.getBoundingClientRect();
      if (er.width * er.height >= r.width * r.height) continue;
    }
    out.set(key, { key, participantId, displayName, isSelf, isScreen, hasName: !!rawName, el });
  }
  return Array.from(out.values());
}

/** Pick the <video> in a tile that is actually showing live frames. */
export function pickVideo(tile: HTMLElement): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of Array.from(tile.querySelectorAll('video'))) {
    if (v.readyState < 2 || v.videoWidth === 0 || v.videoHeight === 0) continue;
    if (!isVisible(v)) continue;
    const area = v.videoWidth * v.videoHeight;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

/** Text of the page body, normalized (cheap enough at 2 Hz). */
function bodyText(): string {
  return cleanName(document.body?.innerText ?? '').slice(0, 4000);
}

/** Green-room join buttons. "Switch here" appears when this account is already in the call
 *  elsewhere (e.g. a previous bot session that hasn't timed out) and moves the call here. */
const JOIN_BUTTON_RE = /^(join now|ask to join|join|switch here|join here too)$/i;

const WAITING_RE = /please wait until a meeting host brings you|asking to be let in|you'll join the call when someone lets you in|waiting for the host|asking to join\.\.\./i;
const DENIED_RE = /you can't join this (video )?call|someone in the call denied your request|your request to join was denied|no one responded to your request|you can't create a meeting yourself|meeting code (has expired|isn't valid)|check your meeting code/i;
const ENDED_RE = /you left the meeting|you've been removed from the meeting|you have been removed|the call has ended|meeting has ended|returning to home screen|rejoin/i;

function hasLeaveButton(): boolean {
  return !!document.querySelector('[aria-label*="Leave call" i], [data-tooltip*="Leave call" i]');
}

/** True once we're in the call (not green room / waiting room / landing page). */
export function inCall(): boolean {
  if (!hasLeaveButton()) return false;
  return !WAITING_RE.test(bodyText());
}

/** Where the Meet client is in the join flow, plus Meet's own message when relevant. */
export function meetingPhase(): { phase: import('../shared/types').MeetPhase; detail: string } {
  const host = location.hostname;
  if (host !== 'meet.google.com' && !location.pathname.endsWith('mock-meet.html')) {
    if (host.endsWith('workspace.google.com') || host === 'accounts.google.com') return { phase: 'signed-out', detail: 'Google sign-in required' };
    return { phase: 'loading', detail: host };
  }
  const text = bodyText();
  const firstMatch = (re: RegExp) => text.match(re)?.[0] ?? '';
  if (hasLeaveButton()) {
    if (WAITING_RE.test(text)) return { phase: 'waiting', detail: 'Waiting for a host to admit the bot' };
    return { phase: 'in-call', detail: '' };
  }
  if (DENIED_RE.test(text)) return { phase: 'denied', detail: firstMatch(DENIED_RE) };
  if (ENDED_RE.test(text) && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.pathname)) return { phase: 'ended', detail: firstMatch(ENDED_RE) };
  if (findButton(JOIN_BUTTON_RE)) return { phase: 'green-room', detail: 'Ready to join' };
  if (/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.pathname)) return { phase: 'loading', detail: 'Opening meeting…' };
  return { phase: 'home', detail: '' };
}

function findButton(re: RegExp): HTMLElement | null {
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    const t = cleanName(b.innerText || b.getAttribute('aria-label'));
    const a = cleanName(b.getAttribute('aria-label'));
    if ((re.test(t) || re.test(a)) && isVisible(b) && !(b as HTMLButtonElement).disabled) return b;
  }
  return null;
}

/** Meet's camera/mic toggle buttons are labelled "Turn off camera" / "Turn on microphone" etc. */
function toggleState(kind: 'camera' | 'microphone'): { on: boolean | null; el: HTMLElement | null } {
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[aria-label], [data-tooltip]'))) {
    const label = cleanName(b.getAttribute('aria-label') || b.getAttribute('data-tooltip'));
    const m = label.match(new RegExp(`^turn (on|off) ${kind}`, 'i'));
    if (m && isVisible(b)) return { on: m[1].toLowerCase() === 'off', el: b };
  }
  return { on: null, el: null };
}

export function cameraOn(): boolean | null {
  return toggleState('camera').on;
}
export function micOn(): boolean | null {
  return toggleState('microphone').on;
}
/** Click Meet's toggle if its state differs. Returns true if clicked. */
export function setDevice(kind: 'camera' | 'microphone', on: boolean): boolean {
  const s = toggleState(kind);
  if (s.on === null || s.on === on || !s.el) return false;
  s.el.click();
  return true;
}

export function clickLeave(): boolean {
  const b = document.querySelector<HTMLElement>('[aria-label*="Leave call" i], [data-tooltip*="Leave call" i]');
  if (!b) return false;
  b.click();
  return true;
}

/**
 * If camera/mic permission is unavailable Meet asks "Do you want people to see and
 * hear you?" with "Continue without microphone and camera". It can appear before OR after
 * "Join now" is clicked, so this runs every tick while not in a call.
 */
export function dismissDeviceDialog(): boolean {
  const re = /^continue without (microphone|camera|mic)/i;
  // Match real buttons first: wrapper <div>s contain the same text but have no handler.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    const t = cleanName(el.innerText || el.getAttribute('aria-label'));
    if (!re.test(t) || !isVisible(el)) continue;
    el.click();
    return true;
  }
  return false;
}

/** Click "Join now" / "Ask to join" on the green room page if present. */
export function tryAutoJoin(): boolean {
  const b = findButton(JOIN_BUTTON_RE);
  if (!b) return false;
  b.click();
  return true;
}

/** Diagnostic snapshot used to recalibrate the heuristics above against live Meet. */
export function dumpDom(): string {
  const lines: string[] = [];
  lines.push(`url: ${location.href}`);
  lines.push(`inCall: ${inCall()}  phase: ${JSON.stringify(meetingPhase())}  cam=${cameraOn()} mic=${micOn()}`);
  lines.push(`videos: ${document.querySelectorAll('video').length}`);
  for (const v of Array.from(document.querySelectorAll('video'))) {
    const tile = v.closest(`[${TILE_ATTR}]`);
    const r = v.getBoundingClientRect();
    lines.push(
      `  video ${v.videoWidth}x${v.videoHeight} rs=${v.readyState} paused=${v.paused} box=${Math.round(r.width)}x${Math.round(r.height)} visible=${isVisible(v)} tile=${tile?.getAttribute(TILE_ATTR) ?? '-'}`,
    );
  }
  const tiles = Array.from(document.querySelectorAll<HTMLElement>(`[${TILE_ATTR}]`));
  lines.push(`[${TILE_ATTR}] elements: ${tiles.length}`);
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    lines.push(
      `  ${t.tagName.toLowerCase()} id=${t.getAttribute(TILE_ATTR)} box=${Math.round(r.width)}x${Math.round(r.height)} videos=${t.querySelectorAll('video').length} self=${!!t.querySelector('[data-self-name]')} name="${nameFromTile(t)}" text="${cleanName(t.innerText).slice(0, 120)}"`,
    );
  }
  lines.push('detected tiles:');
  for (const t of findTiles()) {
    const v = pickVideo(t.el);
    lines.push(`  ${t.key} name="${t.displayName}" self=${t.isSelf} screen=${t.isScreen} video=${v ? `${v.videoWidth}x${v.videoHeight}` : 'none'}`);
  }
  return lines.join('\n');
}


// ---------------------------------------------------------------------------
// Meet controls (validated against live Meet, Nov 2026 UI)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buttonByLabel(re: RegExp, root: ParentNode = document): HTMLElement | null {
  for (const b of Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"]'))) {
    const label = cleanName(b.getAttribute('aria-label') || b.innerText);
    if (re.test(label) && isVisible(b)) return b;
  }
  return null;
}

/** Set an <input type=range> the way a user would, so Meet's handlers fire. */
function setRange(input: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * More options → Adjust view → "Tiled (legacy)" + max tiles slider.
 * Tiled renders every participant (up to the tile limit) at equal size, which is what we
 * need: Meet only sends video for rendered tiles and sizes each stream to its tile.
 */
export async function applyTiledLayout(maxTiles: number): Promise<string> {
  const more = buttonByLabel(/^more options$/i);
  if (!more) return 'more-options button not found';
  more.click();
  await sleep(600);
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((e) => /adjust view|change layout/i.test(e.innerText));
  if (!item) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'adjust-view item not found';
  }
  item.click();
  await sleep(900);
  const dlg = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((d) => /adjust view|change layout/i.test(d.innerText));
  if (!dlg) return 'adjust-view dialog not found';
  let result = '';
  // Radio whose label contains "Tiled".
  for (const radio of Array.from(dlg.querySelectorAll<HTMLInputElement>('input[type="radio"]'))) {
    const label = cleanName((radio.closest('label') ?? radio.parentElement?.parentElement ?? radio.parentElement)?.textContent);
    if (/tiled/i.test(label)) {
      if (!radio.checked) radio.click();
      result += 'tiled ';
      break;
    }
  }
  // Slider steps map to tile counts (6, 9, 16, 25, 36, 49).
  const slider = dlg.querySelector<HTMLInputElement>('input[type="range"]');
  if (slider) {
    const steps = [6, 9, 16, 25, 36, 49];
    const max = Number(slider.max || steps.length - 1);
    let idx = steps.findIndex((n) => n >= maxTiles);
    if (idx < 0) idx = steps.length - 1;
    idx = Math.min(idx, max);
    if (Number(slider.value) !== idx) setRange(slider, idx);
    result += `tiles=${steps[idx] ?? idx}`;
  }
  await sleep(300);
  buttonByLabel(/^close/i, dlg)?.click();
  return result.trim() || 'dialog found but no controls matched';
}

/** Mic state from a tile: Meet shows "You can't unmute someone else" when muted. */
export function tileMicMuted(tile: HTMLElement): boolean | null {
  for (const b of Array.from(tile.querySelectorAll<HTMLElement>('[aria-label]'))) {
    const l = b.getAttribute('aria-label') ?? '';
    if (/can't unmute|cannot unmute|is muted/i.test(l)) return true;
    if (/^mute .*microphone/i.test(l)) return false;
  }
  const ligatures = Array.from(tile.querySelectorAll('i, [aria-hidden="true"]')).map((e) => cleanName(e.textContent));
  if (ligatures.includes('mic_off')) return true;
  return null;
}

export function tileHandRaised(tile: HTMLElement): boolean {
  if (tile.querySelector('[aria-label*="raised" i][aria-label*="hand" i]')) return true;
  return Array.from(tile.querySelectorAll('i, [aria-hidden="true"]')).some((e) => /^(back_hand|front_hand|pan_tool)$/.test(cleanName(e.textContent)));
}

/** Host action: mute a participant's mic (confirms Meet's dialog). */
export async function muteParticipant(tile: HTMLElement): Promise<boolean> {
  const b = Array.from(tile.querySelectorAll<HTMLElement>('[aria-label]')).find((e) => /^mute .*microphone/i.test(e.getAttribute('aria-label') ?? ''));
  if (!b) return false;
  b.click();
  await sleep(500);
  const confirm = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="alertdialog"] button')).find((x) => /^mute$/i.test(cleanName(x.innerText)));
  confirm?.click();
  return true;
}

export async function pinTile(tile: HTMLElement): Promise<boolean> {
  const b = Array.from(tile.querySelectorAll<HTMLElement>('[aria-label]')).find((e) => /^pin .* to your main screen/i.test(e.getAttribute('aria-label') ?? ''));
  if (!b) return false;
  b.click();
  return true;
}

/** Post a message to everyone via the chat panel, then close the panel again. */
export async function sendChat(text: string): Promise<boolean> {
  noteSentChat(text);
  const toggle = buttonByLabel(/^chat with everyone/i);
  let opened = false;
  let box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Send a message"]');
  if (!box || !isVisible(box)) {
    if (!toggle) return false;
    toggle.click();
    opened = true;
    for (let i = 0; i < 20 && !(box && isVisible(box)); i++) {
      await sleep(150);
      box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Send a message"]');
    }
  }
  if (!box) return false;
  box.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(box, text);
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  const send = Array.from(document.querySelectorAll<HTMLElement>('button[aria-label="Send a message"]')).find((b) => isVisible(b));
  if (send && !(send as HTMLButtonElement).disabled) send.click();
  else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  await sleep(400);
  if (opened) toggle?.click(); // restore the stage size
  return true;
}

// ---------------------------------------------------------------------------
// Chat history (validated live, Nov 2026): Meet keeps the chat transcript mounted in
// an aria-live="polite" container even while the side panel shows People, so we can
// read it without opening the chat panel. Each message is a div[data-message-id]
// (the Pin button carries the same attribute) inside a sender group
// (div[jsname="Ypafjf"]) whose header holds the sender name (omitted for our own
// messages) and an HH:MM time (div[jsname="biJjHb"]). Body: [jsname="dTKtvb"].
// ---------------------------------------------------------------------------
const chatLog = new Map<string, import('../shared/types').ChatMessage>();
const sentByBot: string[] = [];
const TIME_RE = /^\d{1,2}[:.]\d{2}(\s?[AP]M)?$/i;

/** Remember text the bot sent so it is flagged self even if Meet shows a sender name. */
export function noteSentChat(text: string): void {
  sentByBot.push(cleanName(text));
  if (sentByBot.length > 50) sentByBot.shift();
}

function hhmmToEpoch(hhmm: string): number {
  const m = hhmm.match(/(\d{1,2})[:.](\d{2})\s?([AP]M)?/i);
  if (!m) return Date.now();
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0);
  const d = new Date();
  d.setHours(h, Number(m[2]), 0, 0);
  if (d.getTime() - Date.now() > 3600_000) d.setDate(d.getDate() - 1); // shown time is from yesterday
  return d.getTime();
}

/** Scrape chat messages currently in the DOM and merge them into the rolling log (last 200). */
export function scrapeChat(selfName = ''): import('../shared/types').ChatMessage[] {
  const msgs = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).filter(
    (el) => el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button' && !el.parentElement?.closest('[data-message-id]'),
  );
  for (const el of msgs) {
    const id = el.getAttribute('data-message-id') || '';
    if (!id || chatLog.has(id)) continue;
    const body = el.querySelector<HTMLElement>('[jsname="dTKtvb"]');
    let text = body?.innerText ?? body?.textContent ?? '';
    if (!body) {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('button, [role="button"], [role="tooltip"]').forEach((b) => b.remove());
      text = clone.textContent ?? '';
    }
    text = text.trim();
    if (!text) continue;
    const group = el.closest<HTMLElement>('[jsname="Ypafjf"]') ?? el.parentElement?.parentElement ?? el;
    const timeEl = group.querySelector<HTMLElement>('[jsname="biJjHb"]');
    let timeText = cleanName(timeEl?.textContent);
    // Header = the group's text before the first message, minus the time.
    let from = '';
    const header = timeEl?.parentElement ?? null;
    if (header) {
      for (const n of Array.from(header.querySelectorAll<HTMLElement>('div, span'))) {
        const t = cleanName(n.textContent);
        if (!t || n.children.length) continue;
        if (TIME_RE.test(t)) timeText ||= t;
        else if (!from) from = t;
      }
    }
    const fromLc = from.toLowerCase();
    const self = !from || fromLc === 'you' || (!!selfName && fromLc === selfName.toLowerCase()) || sentByBot.includes(cleanName(text));
    chatLog.set(id, { id, from: self && !from ? 'You' : from, text, time: hhmmToEpoch(timeText), self });
  }
  while (chatLog.size > 200) chatLog.delete(chatLog.keys().next().value as string);
  return Array.from(chatLog.values());
}

// ---------------------------------------------------------------------------
// Waiting room. Meet shows join requests either as a popup/toast ("X wants to join",
// buttons Admit / View / Deny entry) or, when the People panel is open, as a
// "Waiting to join" / "Waiting to be admitted" section of rows with Admit / Deny buttons.
// ---------------------------------------------------------------------------
const WAIT_SECTION_RE = /waiting to (join|be admitted)|asking to join|lobby/i;

function btnText(b: HTMLElement): string {
  return cleanName(b.getAttribute('aria-label') || b.innerText || b.textContent);
}

/** Rows of the People panel's waiting section: each has its own Admit/Deny buttons. */
function waitingRows(): { name: string; row: HTMLElement }[] {
  const out: { name: string; row: HTMLElement }[] = [];
  const seen = new Set<HTMLElement>();
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    if (!/^admit\b(?! all)/i.test(btnText(b)) || !isVisible(b)) continue;
    // Smallest ancestor that is a list item / row holding this one Admit button.
    let row: HTMLElement | null = b.closest<HTMLElement>('[role="listitem"]');
    if (!row) {
      let p = b.parentElement;
      while (p && p !== document.body) {
        if (Array.from(p.querySelectorAll('button, [role="button"]')).filter((x) => /^admit\b(?! all)/i.test(btnText(x as HTMLElement))).length > 1) break;
        row = p;
        if (cleanName(p.innerText).replace(/admit|deny( entry)?|view|remove/gi, '').trim().length > 1) break;
        p = p.parentElement;
      }
    }
    if (!row || seen.has(row)) continue;
    seen.add(row);
    // Name: aria-label "Admit <name>" or row text without button labels / prompt text.
    const lab = btnText(b).match(/^admit\s+(.+)$/i)?.[1];
    let name = lab ?? '';
    if (!name) {
      const clone = row.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('button, [role="button"], [aria-hidden="true"], i, [role="tooltip"]').forEach((x) => x.remove());
      const t = cleanName(clone.innerText || clone.textContent);
      name = t.match(/^(.{1,80}?)\s+(?:wants|asks|is asking) to join/i)?.[1] ?? t.split(/\n/)[0];
    }
    name = cleanName(name);
    if (name && !WAIT_SECTION_RE.test(name)) out.push({ name, row });
  }
  return out;
}

/** Names of people asking to join (People-panel waiting section + admit popups). */
export function waitingRequests(): string[] {
  const out = new Set<string>(waitingRows().map((r) => r.name));
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [aria-live], [role="alert"]'))) {
    const t = cleanName(el.innerText);
    const m = t.match(/^(.{1,80}?) (?:wants|asks|is asking) to join/i);
    if (m) out.add(m[1]);
    const many = t.match(/(\d+) (?:people|others) want to join/i);
    if (many && !out.size) out.add(`${many[1]} people`);
  }
  return Array.from(out);
}

function matchRow(who: string): HTMLElement | null {
  const w = who.toLowerCase();
  const rows = waitingRows();
  return (rows.find((r) => r.name.toLowerCase() === w) ?? rows.find((r) => r.name.toLowerCase().includes(w)))?.row ?? null;
}

/** Popup "N people want to join" → View: opens the People panel's waiting list. */
async function expandWaitingList(): Promise<void> {
  if (waitingRows().length) return;
  const view = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
    (b) => isVisible(b) && /^view( all)?$/i.test(btnText(b)) && /want(s)? to join/i.test(b.closest('[role="dialog"], [role="alertdialog"], [aria-live], [role="alert"]')?.textContent ?? ''),
  );
  if (view) {
    view.click();
    for (let i = 0; i < 10 && !waitingRows().length; i++) await sleep(150);
  } else ensurePeoplePanel(8000); // [quality-agent]
}

/** Click Meet's Admit / Admit all (who = undefined or 'all'), or Admit for one named person. */
export async function admitWaiting(who?: string): Promise<number> {
  if (!who || who === 'all') {
    const all = buttonByLabel(/^admit all/i);
    if (all) {
      all.click();
      await sleep(400);
      // Confirmation dialog repeats "Admit all".
      const confirm = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="alertdialog"] button')).find((b) => /^admit all/i.test(btnText(b)) && isVisible(b));
      confirm?.click();
      return 1;
    }
    let n = 0;
    for (const b of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
      if (!/^admit\b(?! all)/i.test(btnText(b)) || !isVisible(b)) continue;
      b.click();
      n++;
      await sleep(250);
    }
    return n;
  }
  await expandWaitingList();
  const row = matchRow(who);
  let b = row ? Array.from(row.querySelectorAll<HTMLElement>('button, [role="button"]')).find((x) => /^admit\b(?! all)/i.test(btnText(x))) : undefined;
  if (!b) {
    // Single-person popup: "<who> wants to join" with an Admit button.
    for (const d of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [aria-live], [role="alert"]'))) {
      if (!cleanName(d.innerText).toLowerCase().includes(who.toLowerCase())) continue;
      b = Array.from(d.querySelectorAll<HTMLElement>('button, [role="button"]')).find((x) => /^admit$/i.test(btnText(x)) && isVisible(x));
      if (b) break;
    }
  }
  if (!b) return 0;
  b.click();
  return 1;
}

/** Click Deny / Deny entry for everyone (who = undefined/'all') or one named person. */
export async function denyWaiting(who?: string): Promise<number> {
  const DENY = /^(deny( entry)?|reject)\b/i;
  if (who && who !== 'all') {
    await expandWaitingList();
    const row = matchRow(who);
    let b = row ? Array.from(row.querySelectorAll<HTMLElement>('button, [role="button"]')).find((x) => DENY.test(btnText(x))) : undefined;
    if (!b) {
      for (const d of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [aria-live], [role="alert"]'))) {
        if (!cleanName(d.innerText).toLowerCase().includes(who.toLowerCase())) continue;
        b = Array.from(d.querySelectorAll<HTMLElement>('button, [role="button"]')).find((x) => DENY.test(btnText(x)) && isVisible(x));
        if (b) break;
      }
    }
    if (!b) return 0;
    b.click();
    await sleep(300);
    Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="alertdialog"] button')).find((x) => DENY.test(btnText(x)) && isVisible(x))?.click();
    return 1;
  }
  let n = 0;
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    if (!DENY.test(btnText(b)) || !isVisible(b)) continue;
    b.click();
    n++;
    await sleep(250);
  }
  return n;
}

/** Participant key (Meet participant id) of whoever is screen-sharing, or null. */
export function presenterKey(): string | null {
  const t = findTiles().find((x) => x.isScreen);
  return t ? t.participantId : null;
}

// ---------------------------------------------------------------------------
// People panel roster + host actions (validated against live Meet, Nov 2026 UI)
//
// The People panel (side panel, role=list aria-label="Participants") lists everyone in
// the call, including people without a rendered tile. Each row is
// [role=listitem][data-participant-id][aria-label=<name>] with an <img> avatar, a role
// line ("Meeting host" / "Co-host"), a mic indicator and a "More actions" menu
// (Pin to the screen, Add as co-host, Remove from the call, ...).
// ---------------------------------------------------------------------------

export interface RosterEntry {
  participantId: string;
  displayName: string;
  isSelf: boolean;
  isHost: boolean;
  isCohost: boolean;
  avatarUrl: string;
  /** null = unknown (e.g. no indicator for unmuted people when the bot isn't host). */
  muted: boolean | null;
  handRaised: boolean;
  el: HTMLElement;
}

const ROSTER_ROW = '[role="list"][aria-label="Participants" i] [role="listitem"][data-participant-id]';

function labelledText(el: Element): string {
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  return cleanName(ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ') || el.getAttribute('aria-label') || '');
}

/** Toolbar "People" button (a role=button labelled by a hidden span "People"). */
function peopleButton(): HTMLElement | null {
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[role="button"], button'))) {
    if (/^(people|show everyone|participants)\b/i.test(labelledText(b)) && isVisible(b)) return b;
  }
  return null;
}

// [quality-agent] The People panel is no longer kept open: an open side panel shrinks the video
// grid, and Meet picks each feed's simulcast layer from the rendered tile size. Once opened, Meet
// keeps the roster list in the DOM (hidden, still updated) after the panel is closed, so we open it
// briefly to (re)build the list, then close it again. Host actions re-open it for a few seconds.
function rosterList(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="list"][aria-label="Participants" i]');
}

/** True when the People panel is actually shown (the list can stay in the DOM while hidden). */
export function rosterOpen(): boolean {
  const l = rosterList();
  return !!l && isVisible(l);
}

let panelCloseTimer: ReturnType<typeof setTimeout> | null = null;
let panelOpenedByUs = false;
let lastPanelRefresh = 0;
const PANEL_REFRESH_MS = 25000;

function closePeoplePanel(): void {
  panelCloseTimer = null;
  if (!panelOpenedByUs) return;
  panelOpenedByUs = false;
  let p: HTMLElement | null = rosterList();
  if (!p || !isVisible(p)) return;
  while (p) {
    const c = Array.from(p.querySelectorAll<HTMLElement>('button, [role="button"]')).find((b) => /^close$/i.test(cleanName(b.getAttribute('aria-label'))) && isVisible(b));
    if (c) {
      c.click();
      return;
    }
    p = p.parentElement;
  }
}

/**
 * Show the People panel for `holdMs` (then close it again if we opened it). Returns true if the
 * panel is/was opened. Pass holdMs = 0 to leave it open (old behaviour).
 */
export function ensurePeoplePanel(holdMs = 1500): boolean {
  lastPanelRefresh = Date.now();
  if (!rosterOpen()) {
    const b = peopleButton();
    if (!b) return false;
    b.click();
    panelOpenedByUs = true;
  }
  if (panelCloseTimer) clearTimeout(panelCloseTimer);
  panelCloseTimer = holdMs > 0 && panelOpenedByUs ? setTimeout(closePeoplePanel, holdMs) : null;
  return true;
}

/** Open the panel (if needed) and wait for its rows to render, for host actions. */
async function withPeoplePanel(holdMs = 8000): Promise<void> {
  const wasOpen = rosterOpen();
  if (!ensurePeoplePanel(holdMs)) return;
  if (!wasOpen) await sleep(500);
}

function rowMuted(row: HTMLElement): boolean | null {
  for (const e of Array.from(row.querySelectorAll<HTMLElement>('[aria-label]'))) {
    const l = e.getAttribute('aria-label') ?? '';
    if (/can't unmute|cannot unmute|microphone is (turned )?off|is muted/i.test(l)) return true;
    if (/^mute .*microphone|microphone is on/i.test(l)) return false;
  }
  return null;
}

function rowHandRaised(row: HTMLElement): boolean {
  if (row.querySelector('[aria-label*="lower" i][aria-label*="hand" i], [aria-label*="raised" i][aria-label*="hand" i]')) return true;
  if (/hand/i.test(row.closest('[role="list"]')?.getAttribute('aria-label') ?? '')) return true;
  return Array.from(row.querySelectorAll('i, [aria-hidden="true"]')).some((e) => /^(back_hand|front_hand|pan_tool)$/.test(cleanName(e.textContent)));
}

/** Everyone listed in the People panel (empty when the panel isn't open). Deduplicated by id. */
export function scrapeRoster(): RosterEntry[] {
  // [quality-agent] Periodically flash the panel so the (hidden) roster list stays fresh.
  if (!rosterOpen() && Date.now() - lastPanelRefresh > PANEL_REFRESH_MS && inCall()) ensurePeoplePanel();
  const out = new Map<string, RosterEntry>();
  for (const row of Array.from(document.querySelectorAll<HTMLElement>(ROSTER_ROW))) {
    const participantId = row.getAttribute('data-participant-id') ?? '';
    if (!participantId) continue;
    const text = row.innerText ?? '';
    const lines = text.split('\n').map((s) => s.trim());
    const displayName = cleanName(row.getAttribute('aria-label')) || cleanName(lines[0]);
    if (!displayName) continue;
    const roleLine = lines.find((l) => /^(meeting host|host|co-host|cohost)$/i.test(l)) ?? '';
    const e: RosterEntry = {
      participantId,
      displayName,
      isSelf: /\(you\)/i.test(text) || (!!botName && displayName.toLowerCase() === botName),
      isHost: /^(meeting )?host$/i.test(roleLine),
      isCohost: /co-?host/i.test(roleLine),
      avatarUrl: row.querySelector<HTMLImageElement>('img')?.src ?? '',
      muted: rowMuted(row),
      handRaised: rowHandRaised(row),
      el: row,
    };
    const prev = out.get(participantId);
    if (prev) {
      // Same person listed twice (e.g. "Raised hands" + "In the meeting"): merge.
      prev.handRaised ||= e.handRaised;
      prev.isHost ||= e.isHost;
      prev.isCohost ||= e.isCohost;
      if (prev.muted === null) prev.muted = e.muted;
      prev.avatarUrl ||= e.avatarUrl;
    } else out.set(participantId, e);
  }
  return Array.from(out.values());
}

function rosterRow(participantId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`${ROSTER_ROW}[data-participant-id="${CSS.escape(participantId)}"]`);
}

function escapeKey(): void {
  const t = document.activeElement ?? document.body;
  t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
}

function visibleMenuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')).filter(isVisible);
}

/** Menu-item label without the leading Material icon ligature ("keep Pin to the screen" -> "Pin to the screen"). */
function menuLabel(e: HTMLElement): string {
  let t = cleanName(e.innerText);
  for (const i of Array.from(e.querySelectorAll('i'))) {
    const ic = cleanName(i.textContent);
    if (ic && t.startsWith(ic)) t = t.slice(ic.length).trim();
  }
  return t || cleanName(e.getAttribute('aria-label'));
}

/**
 * Open a participant's "More actions" (roster) or "More options for X" (tile) menu and pick an item.
 * `steps` walks submenus, e.g. [/^pin to the screen/, /^for everyone$/]. A step that doesn't appear
 * after the first one is skipped only when `optional` (Meet sometimes has no submenu).
 */
async function participantMenu(participantId: string, displayName: string, steps: RegExp[], optionalTail = false): Promise<string | null> {
  await withPeoplePanel(); // [quality-agent] roster rows are hidden while the panel is closed
  const triggers: HTMLElement[] = [];
  const rb = rosterRow(participantId)?.querySelector<HTMLElement>('[aria-label="More actions"], [aria-haspopup="menu"]');
  if (rb) triggers.push(rb);
  const want = `more options for ${displayName}`.toLowerCase();
  const tb = Array.from(document.querySelectorAll<HTMLElement>('[aria-label]')).find(
    (b) => cleanName(b.getAttribute('aria-label')).toLowerCase() === want && isVisible(b),
  );
  if (tb) triggers.push(tb);
  const find = async (re: RegExp) => {
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      const hit = visibleMenuItems().find((m) => re.test(menuLabel(m)) && m.getAttribute('aria-disabled') !== 'true');
      if (hit) return hit;
    }
    return undefined;
  };
  for (const t of triggers) {
    t.click();
    const labels: string[] = [];
    let ok = true;
    for (let i = 0; i < steps.length; i++) {
      const hit = await find(steps[i]);
      if (!hit) {
        ok = i > 0 && optionalTail;
        break;
      }
      labels.push(menuLabel(hit));
      hit.click();
    }
    if (ok && labels.length) return labels.join(' > ');
    escapeKey();
    await sleep(250);
  }
  return null;
}

async function confirmDialog(re: RegExp): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await sleep(150);
    const b = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="alertdialog"] button')).find(
      (x) => re.test(cleanName(x.innerText || x.getAttribute('aria-label'))) && isVisible(x),
    );
    if (b) {
      b.click();
      return true;
    }
  }
  return false;
}

/** Pin / unpin in the bot's own view (Meet "Pin to the screen" > "For myself only"). */
export async function pinParticipant(participantId: string, displayName: string, on: boolean): Promise<boolean> {
  // Tile shortcut first: "Pin X to your main screen" / "Unpin X from your main screen".
  const n = displayName.toLowerCase();
  const tileBtn = Array.from(document.querySelectorAll<HTMLElement>('[aria-label]')).find((b) => {
    const l = cleanName(b.getAttribute('aria-label')).toLowerCase();
    return isVisible(b) && (on ? l === `pin ${n} to your main screen` : l === `unpin ${n}` || l === `unpin ${n} from your main screen`);
  });
  if (tileBtn) {
    tileBtn.click();
    await sleep(400);
    // The tile button may open the same "For myself only / For everyone" chooser.
    if (on) visibleMenuItems().find((m) => /^for (myself|yourself)/i.test(menuLabel(m)))?.click();
    return true;
  }
  const label = on
    ? await participantMenu(participantId, displayName, [/^pin( to the screen)?$/i, /^for (myself|yourself)( only)?$/i], true)
    : await participantMenu(participantId, displayName, [/^unpin\b/i]);
  if (!label) throw new Error(on ? 'Pin is not available for this participant' : 'Participant is not pinned');
  return true;
}

/** Spotlight = Meet "Pin to the screen" > "For everyone" (host / co-host only). */
export async function spotlightParticipant(participantId: string, displayName: string, on: boolean): Promise<boolean> {
  const label = on
    ? await participantMenu(participantId, displayName, [/^pin( to the screen)?$/i, /^for everyone$/i])
    : await participantMenu(participantId, displayName, [/^unpin\b/i]);
  if (!label) throw new Error(on ? 'Spotlight (pin for everyone) is not available (the bot must be host or co-host)' : 'Participant is not spotlit');
  return true;
}

/** Host action: remove someone from the call (confirms Meet's dialog). */
export async function removeParticipant(participantId: string, displayName: string): Promise<boolean> {
  const label = await participantMenu(participantId, displayName, [/^remove from (the )?call/i]);
  if (!label) throw new Error('Remove from the call is not available (the bot must be host or co-host)');
  await confirmDialog(/^remove$/i);
  return true;
}

/** Lower one participant's hand (host/co-host), or every hand when no id is given. */
export async function lowerHand(participantId?: string, displayName?: string): Promise<boolean> {
  if (!participantId) {
    const all = buttonByLabel(/^lower all( hands)?$/i);
    if (all) {
      all.click();
      await confirmDialog(/^lower all( hands)?$/i);
      return true;
    }
    const own = buttonByLabel(/^lower hand\b/i); // the bot's own hand
    if (own) {
      own.click();
      return true;
    }
    throw new Error('No raised hands to lower');
  }
  await withPeoplePanel(); // [quality-agent]
  const btn = rosterRow(participantId)?.querySelector<HTMLElement>('[aria-label*="lower" i][aria-label*="hand" i]');
  if (btn) {
    btn.click();
    return true;
  }
  const label = await participantMenu(participantId, displayName ?? '', [/^lower hand/i]);
  if (!label) throw new Error('Lower hand is not available (no raised hand, or the bot is not host)');
  return true;
}

/** Host action: "Mute all" in the People panel. */
export async function muteAll(): Promise<boolean> {
  await withPeoplePanel(); // [quality-agent]
  await sleep(300);
  const b = buttonByLabel(/^mute (all|everyone)$/i);
  if (!b) throw new Error('Mute all is not available (nobody is unmuted, or the bot is not host)');
  b.click();
  await confirmDialog(/^mute( all| everyone)?$/i);
  return true;
}

/** Host action: mute one participant from their roster row (works for people without a tile). */
export async function muteRosterParticipant(participantId: string): Promise<boolean> {
  await withPeoplePanel(); // [quality-agent]
  const row = rosterRow(participantId);
  const b = row ? Array.from(row.querySelectorAll<HTMLElement>('[aria-label]')).find((e) => /^mute .*microphone/i.test(e.getAttribute('aria-label') ?? '')) : null;
  if (!b) return false;
  b.click();
  await confirmDialog(/^mute$/i);
  return true;
}

/** Tile-level pin state: "Pinned for yourself" / "Unpin X" = pinned, "Pinned for everyone" = spotlit. */
export function tilePinState(tile: HTMLElement): { pinned: boolean; spotlit: boolean } {
  let pinned = false;
  let spotlit = false;
  for (const e of Array.from(tile.querySelectorAll('[aria-label]'))) {
    const l = e.getAttribute('aria-label') ?? '';
    if (/pinned for everyone|spotlight/i.test(l)) spotlit = true;
    else if (/^unpin\b|pinned for (yourself|you)/i.test(l)) pinned = true;
  }
  return { pinned, spotlit };
}
