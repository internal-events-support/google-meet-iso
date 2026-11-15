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

/** Names of people asking to join, as shown in Meet's admit prompt (best effort). */
export function waitingRequests(): string[] {
  const out = new Set<string>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [aria-live]'))) {
    const t = cleanName(el.innerText);
    const m = t.match(/^(.{1,80}?) (?:wants|asks|is asking) to join/i);
    if (m) out.add(m[1]);
    const many = t.match(/(\d+) (?:people|others) want to join/i);
    if (many) out.add(`${many[1]} people`);
  }
  return Array.from(out);
}

/** Click Meet's Admit / Admit all (who = undefined or 'all'). Returns clicks made. */
export async function admitWaiting(who?: string): Promise<number> {
  let n = 0;
  const all = buttonByLabel(/^admit all$/i);
  if (all && (!who || who === 'all')) {
    all.click();
    await sleep(400);
    buttonByLabel(/^admit all$/i)?.click(); // confirmation step
    return 1;
  }
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    if (!/^admit$/i.test(cleanName(b.innerText || b.getAttribute('aria-label'))) || !isVisible(b)) continue;
    if (who && who !== 'all') {
      const ctx = cleanName(b.closest('[role="dialog"], [role="listitem"], [role="alertdialog"]')?.textContent ?? '');
      if (!ctx.toLowerCase().includes(who.toLowerCase())) continue;
    }
    b.click();
    n++;
    await sleep(250);
  }
  return n;
}

export async function denyWaiting(who?: string): Promise<number> {
  let n = 0;
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    if (!/^(deny entry|deny|remove)$/i.test(cleanName(b.innerText || b.getAttribute('aria-label'))) || !isVisible(b)) continue;
    if (who && who !== 'all') {
      const ctx = cleanName(b.closest('[role="dialog"], [role="listitem"], [role="alertdialog"]')?.textContent ?? '');
      if (!ctx.toLowerCase().includes(who.toLowerCase())) continue;
    }
    b.click();
    n++;
    await sleep(250);
  }
  return n;
}
