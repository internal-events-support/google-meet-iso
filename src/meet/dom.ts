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

function nameFromTile(tile: HTMLElement): string {
  // 1. The bot's own tile carries data-self-name.
  const self = tile.querySelector<HTMLElement>('[data-self-name]');
  if (self) {
    const n = cleanName(self.getAttribute('data-self-name') || self.textContent);
    if (n) return n;
  }
  // 2. Names are rendered with translate="no" / .notranslate so Chrome won't translate them.
  for (const el of Array.from(tile.querySelectorAll<HTMLElement>('.notranslate, [translate="no"]'))) {
    const n = cleanName(el.textContent);
    if (n && n.length <= 80) return n;
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
    const isSelf = !!el.querySelector('[data-self-name]');
    const isScreen = isScreenTile(el, rawName);
    const displayName = (isScreen ? presenterName(rawName) : rawName) || participantId.split('/').pop() || 'Unknown';
    const key = isScreen ? `${participantId}:screen` : participantId;

    const existing = out.get(key);
    // If duplicated (e.g. filmstrip + stage), prefer the bigger, visible one: higher-res stream.
    if (existing) {
      const er = existing.el.getBoundingClientRect();
      if (er.width * er.height >= r.width * r.height) continue;
    }
    out.set(key, { key, participantId, displayName, isSelf, isScreen, el });
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
  if (findButton(/^(join now|ask to join|join)$/i)) return { phase: 'green-room', detail: 'Ready to join' };
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
  const b = findButton(/^(join now|ask to join|join)$/i);
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
