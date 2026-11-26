// Render worker entry (bundled to dist/meet/engine-worker.js by scripts/build-ui.js).
//
// The Meet page hands over each participant track as a transferred MediaStreamTrackProcessor
// readable (Chromium's stream-transfer optimisation delivers frames straight to this thread).
// Frames stay here: the EngineCore renders, packs and reads back every output and makes the
// preview JPEGs; only finished NDI buffers (transferred, no copy), previews and stats go back.

import { EngineCore, type EngineIn } from './engine';
import { initWebGpu } from './gpucompositor';
import { setJpegEncoder, workerEncoder } from './thumbs';

type WorkerIn =
  | EngineIn
  | { t: 'track'; id: string; read: number; readable: ReadableStream<VideoFrame> }
  | { t: 'trackStop'; read: number }
  | { t: 'pushFrame'; id: string; frame: VideoFrame }
  | { t: 'endSource'; id: string };

const scope = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };

initWebGpu();
// JPEG previews are encoded in their own worker so they never delay rendering.
const jpeg = workerEncoder();
if (jpeg) setJpegEncoder(jpeg);
const core = new EngineCore((m, transfer) => scope.postMessage(m, transfer ?? []));

/** Active reads: read token → source id (a source restarts with a new token on a new track). */
const reads = new Map<number, { id: string; reader: ReadableStreamDefaultReader<VideoFrame> | null; stopped: boolean }>();
const currentRead = new Map<string, number>();

async function pump(read: number, id: string, readable: ReadableStream<VideoFrame>): Promise<void> {
  const st = { id, reader: readable.getReader(), stopped: false };
  reads.set(read, st);
  let err = '';
  try {
    for (;;) {
      const { value, done } = await st.reader.read();
      if (done || !value) break;
      if (st.stopped || currentRead.get(id) !== read) {
        value.close();
        break;
      }
      core.onFrame(id, value);
    }
  } catch (e) {
    err = String((e as Error)?.message ?? e);
  }
  reads.delete(read);
  if (currentRead.get(id) === read) {
    currentRead.delete(id);
    if (err) scope.postMessage({ t: 'log', s: `worker track reader [${id}]: ${err}` });
    scope.postMessage({ t: 'trackEnd', id, read });
  }
}

scope.onmessage = (e: MessageEvent) => {
  const m = e.data as WorkerIn;
  switch (m.t) {
    case 'track':
      currentRead.set(m.id, m.read);
      void pump(m.read, m.id, m.readable);
      break;
    case 'trackStop': {
      const st = reads.get(m.read);
      if (st) {
        st.stopped = true;
        st.reader?.cancel().catch(() => {});
      }
      break;
    }
    case 'pushFrame':
      core.onFrame(m.id, m.frame);
      break;
    case 'endSource':
      core.endSource(m.id);
      break;
    default:
      core.handle(m);
  }
};

scope.postMessage({ t: 'ready', webgpu: !!(globalThis.navigator as Navigator | undefined)?.gpu, mstp: typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function' });
