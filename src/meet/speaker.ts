// Active speaker + audio attribution.
//
// Meet's web client receives 3 "virtual" audio streams carrying the loudest speakers; each
// RTP packet's CSRC identifies the real speaker (read via getContributingSources() in the
// main-world shim, published on <html data-gmeet-iso-rtc>). Video receivers carry no CSRC,
// so CSRC→participant is learned by correlation: when a single CSRC is talking, the tile
// whose speaking indicator animates at the same moment is credited. A single remote
// participant is mapped immediately.

export interface RtcEntry {
  k: 'audio' | 'video';
  t: string; // track id
  c: number | null; // latest CSRC
  s: number | null; // latest SSRC
  l: number; // audio level 0..1
  age: number; // ms since that CSRC's last packet
}

const TALK = 0.015;

export class SpeakerTracker {
  private csrcToKey = new Map<number, string>();
  private score = new Map<number, Map<string, number>>();
  private tileMut = new Map<string, number>();
  private observed = new WeakSet<Element>();
  private elKey = new WeakMap<Element, string>();
  private observer: MutationObserver;
  private entries: RtcEntry[] = [];
  private levelByKey = new Map<string, number>();
  activeSpeaker: string | null = null;
  private activeSince = 0;

  constructor() {
    this.observer = new MutationObserver((muts) => {
      const now = performance.now();
      for (const m of muts) {
        const tile = (m.target as Element).closest?.('[data-participant-id]');
        const key = tile ? this.elKey.get(tile) : undefined;
        if (key) this.tileMut.set(key, now);
      }
    });
  }

  /** Watch tiles for speaking-indicator animation (class/style churn). */
  observe(tiles: { key: string; el: HTMLElement }[]): void {
    for (const t of tiles) {
      this.elKey.set(t.el, t.key);
      if (this.observed.has(t.el)) continue;
      this.observed.add(t.el);
      this.observer.observe(t.el, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
    }
  }

  readRtc(): RtcEntry[] {
    try {
      this.entries = JSON.parse(document.documentElement?.dataset.gmeetIsoRtc || '[]') as RtcEntry[];
    } catch {
      this.entries = [];
    }
    return this.entries;
  }

  /** `cameraKeys`: non-self camera participants currently present. */
  update(cameraKeys: string[]): void {
    const now = performance.now();
    const talking = this.entries.filter((e) => e.k === 'audio' && e.c !== null && e.age >= 0 && e.age < 400 && e.l > TALK);

    // Trivial mapping: only one remote participant.
    if (cameraKeys.length === 1) for (const e of talking) this.csrcToKey.set(e.c!, cameraKeys[0]);

    // Correlation learning: one CSRC talking + one tile animating right now.
    if (talking.length === 1) {
      const c = talking[0].c!;
      const recent = cameraKeys.filter((k) => now - (this.tileMut.get(k) ?? 0) < 400);
      if (recent.length === 1) {
        const m = this.score.get(c) ?? new Map<string, number>();
        m.set(recent[0], (m.get(recent[0]) ?? 0) + 1);
        this.score.set(c, m);
        const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
        if (ranked[0][1] >= 3 && (!ranked[1] || ranked[0][1] >= ranked[1][1] * 2)) this.csrcToKey.set(c, ranked[0][0]);
      }
    }

    // Levels per participant.
    this.levelByKey.clear();
    for (const e of this.entries) {
      if (e.k !== 'audio' || e.c === null || e.age < 0 || e.age > 600) continue;
      const key = this.csrcToKey.get(e.c);
      if (key) this.levelByKey.set(key, Math.max(this.levelByKey.get(key) ?? 0, e.l));
    }

    // Active speaker: loudest attributed talker, with a 1.5 s hold to avoid flapping.
    let best: string | null = null;
    let bestL = TALK;
    for (const e of talking) {
      const key = this.csrcToKey.get(e.c!);
      if (key && e.l > bestL) {
        best = key;
        bestL = e.l;
      }
    }
    if (best && best !== this.activeSpeaker && (now - this.activeSince > 1500 || !this.activeSpeaker || !cameraKeys.includes(this.activeSpeaker))) {
      this.activeSpeaker = best;
      this.activeSince = now;
    }
    if (this.activeSpeaker && !cameraKeys.includes(this.activeSpeaker)) this.activeSpeaker = cameraKeys[0] ?? null;
    if (!this.activeSpeaker && cameraKeys.length) this.activeSpeaker = cameraKeys[0];
  }

  level(key: string): number {
    return this.levelByKey.get(key) ?? 0;
  }

  speaking(key: string): boolean {
    return this.level(key) > TALK;
  }

  /** Audio track id currently carrying this participant's voice, if attributed. */
  audioTrackFor(key: string): string | null {
    let best: RtcEntry | null = null;
    for (const e of this.entries) {
      if (e.k !== 'audio' || e.c === null || e.age < 0 || e.age > 1000) continue;
      if (this.csrcToKey.get(e.c) !== key) continue;
      if (!best || e.age < best.age) best = e;
    }
    return best?.t ?? null;
  }

  mappedCount(): number {
    return this.csrcToKey.size;
  }
}
