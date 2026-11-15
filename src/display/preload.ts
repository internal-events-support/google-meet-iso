// Full-screen display output: shows one of our own NDI outputs on a monitor (for a confidence
// monitor or a projector), received back through NDI so it shows exactly what's on the wire.

import * as path from 'path';

interface Rx {
  read(): { width: number; height: number; format: string; data: ArrayBuffer } | null;
  destroy(): void;
}
interface Mod {
  load(): { ok: boolean };
  Receiver: new (name: string, opts?: { lowBandwidth?: boolean }) => Rx;
  Finder: new () => { sources(): string[]; destroy(): void };
}

const params = new URLSearchParams(location.search);
const wanted = params.get('source') ?? '';

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const label = document.getElementById('label') as HTMLDivElement;
  const ctx = canvas.getContext('2d')!;
  let mod: Mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(path.join(__dirname, '..', '..', 'build', 'Release', 'gmeet_iso_ndi.node')) as Mod;
    mod.load();
  } catch (e) {
    label.textContent = `NDI unavailable: ${(e as Error).message}`;
    return;
  }
  const finder = new mod.Finder();
  let rx: Rx | null = null;
  let lastFrame = performance.now();
  label.textContent = `Waiting for ${wanted}…`;

  const connect = () => {
    const full = finder.sources().find((s) => s.endsWith(`(${wanted})`));
    if (full) rx = new mod.Receiver(full);
  };

  const draw = () => {
    if (!rx) connect();
    const f = rx?.read();
    if (f) {
      lastFrame = performance.now();
      label.textContent = '';
      if (canvas.width !== f.width || canvas.height !== f.height) {
        canvas.width = f.width;
        canvas.height = f.height;
      }
      const vf = new VideoFrame(new Uint8Array(f.data), {
        format: f.format === 'BGRX' ? 'BGRX' : 'BGRA',
        codedWidth: f.width,
        codedHeight: f.height,
        timestamp: Math.round(performance.now() * 1000),
      });
      ctx.drawImage(vf, 0, 0);
      vf.close();
    } else if (performance.now() - lastFrame > 3000) {
      label.textContent = `No signal: ${wanted}`;
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  window.addEventListener('beforeunload', () => {
    rx?.destroy();
    finder.destroy();
  });
});
