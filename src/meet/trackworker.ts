// Off-main-thread video track reader. For each track we make a clone (so Meet's own <video>
// keeps playing), build a MediaStreamTrackProcessor on it and TRANSFER ITS READABLE to one shared
// DedicatedWorker. Chromium's stream-transfer optimizer then delivers frames straight to the
// worker thread instead of via the page's (busy) main thread, where MSTP's tiny buffer used to
// overflow and drop frames. The worker drains it promptly and posts VideoFrames back.
//
// Why not transfer the track itself: Chromium refuses to transfer any MediaStreamTrack that has
// clones ("MediaStreamTracks with clones cannot be transferred"), and transferring Meet's
// original would steal it from Meet's <video>.
//
// Back-pressure: the worker keeps at most MAX_INFLIGHT un-acked frames per track in the
// message queue; anything newer than that replaces a single held "pending" frame (latest wins,
// the superseded frame is closed), so a stalled main thread never causes unbounded queueing.
//
// Meet enforces Trusted Types, so the blob worker URL goes through a TT policy. If worker
// creation or the stream transfer fails, callers fall back to main-thread MSTP.

const WORKER_SRC = `
const MAX_INFLIGHT = 2;
const reads = new Map();
function pump(st) {
  while (st.pending && st.inflight < MAX_INFLIGHT) {
    const f = st.pending; st.pending = null; st.inflight++;
    try { postMessage({ id: st.id, frame: f }, [f]); } catch (e) { st.inflight--; f.close(); }
  }
}
async function run(st) {
  try {
    st.reader = st.readable.getReader();
    for (;;) {
      const { value, done } = await st.reader.read();
      if (done || !value) break;
      if (st.stopped) { value.close(); break; }
      if (st.pending) { st.pending.close(); st.dropped++; }
      st.pending = value;
      pump(st);
    }
    if (!st.stopped) postMessage({ id: st.id, end: true });
  } catch (e) {
    if (!st.stopped) postMessage({ id: st.id, end: true, err: String(e && e.message || e) });
  }
  cleanup(st);
}
function cleanup(st) {
  st.stopped = true;
  if (st.pending) { st.pending.close(); st.pending = null; }
  if (reads.get(st.id) === st) reads.delete(st.id);
}
onmessage = (e) => {
  const m = e.data;
  if (m.op === 'start') {
    const st = { id: m.id, readable: m.readable, inflight: 0, pending: null, stopped: false, reader: null, dropped: 0 };
    reads.set(m.id, st);
    run(st);
  } else if (m.op === 'ack') {
    const st = reads.get(m.id);
    if (st) { st.inflight = Math.max(0, st.inflight - 1); pump(st); }
  } else if (m.op === 'stop') {
    const st = reads.get(m.id);
    if (st) { st.stopped = true; if (st.reader) st.reader.cancel().catch(() => {}); cleanup(st); }
  } else if (m.op === 'probe') {
    postMessage({ probe: m.probe, ok: typeof MediaStreamTrackProcessor === 'function' });
  }
};
`;

declare const MediaStreamTrackProcessor: {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> };
};

export interface TrackSink {
  onFrame(frame: VideoFrame): void;
  onEnd(err?: string): void;
}

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
const sinks = new Map<number, TrackSink>();

function getWorker(log: (s: string) => void): Worker | null {
  if (worker || broken) return worker;
  try {
    const blobUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    let url: unknown = blobUrl;
    const tt = (globalThis as { trustedTypes?: { createPolicy(n: string, p: object): { createScriptURL(s: string): unknown } } }).trustedTypes;
    if (tt) {
      try {
        url = tt.createPolicy('gmeetIsoTrackWorker', { createScriptURL: (s: string) => s }).createScriptURL(blobUrl);
      } catch (e) {
        log(`track worker: TT policy failed (${(e as Error).message}); trying raw URL`);
      }
    }
    const w = new Worker(url as string, { name: 'gmeet-iso-tracks' });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; frame?: VideoFrame; end?: boolean; err?: string };
      if (m.frame) {
        w.postMessage({ op: 'ack', id: m.id });
        const s = sinks.get(m.id);
        if (s) s.onFrame(m.frame);
        else m.frame.close();
      } else if (m.end) {
        const s = sinks.get(m.id);
        sinks.delete(m.id);
        s?.onEnd(m.err);
      }
    };
    w.onerror = (e) => {
      log(`track worker error: ${e.message}`);
    };
    worker = w;
  } catch (e) {
    broken = true;
    log(`track worker unavailable: ${(e as Error).message}`);
  }
  return worker;
}

/**
 * Starts reading a clone of `track` in the worker. Returns a stop function, or null if the
 * worker path is unavailable (caller should fall back to main-thread reading).
 */
export function readInWorker(track: MediaStreamTrack, sink: TrackSink, log: (s: string) => void): (() => void) | null {
  if (typeof MediaStreamTrackProcessor !== 'function') return null;
  // Kill-switch / A-B testing: GMEET_ISO_TRACK_WORKER=0 forces the main-thread reader.
  if (typeof process !== 'undefined' && process.env?.GMEET_ISO_TRACK_WORKER === '0') return null;
  const w = getWorker(log);
  if (!w) return null;
  let clone: MediaStreamTrack | null = null;
  const id = nextId++;
  try {
    clone = track.clone();
    const { readable } = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 4 });
    w.postMessage({ op: 'start', id, readable }, [readable as unknown as Transferable]);
  } catch (e) {
    clone?.stop();
    broken = true; // not supported here: don't retry for every tile
    log(`track worker: stream transfer failed, using main-thread reader: ${(e as Error).message}`);
    return null;
  }
  sinks.set(id, sink);
  const c = clone;
  return () => {
    c.stop(); // ends the stream in the worker too
    if (!sinks.delete(id)) return;
    w.postMessage({ op: 'stop', id });
  };
}
