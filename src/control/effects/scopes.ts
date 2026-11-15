// ProcAmp scopes (RE ProcAmpHistogramView / ProcAmpVectorscopeView / ProcAmpWaveformView).
// Fed from the preview canvas pixels (downsampled), drawn into their own canvases.

export type ScopeType = 'histogram' | 'vectorscope' | 'waveform';

/** Downsample a canvas to at most `maxW` wide and return its pixels. */
export function samplePixels(src: HTMLCanvasElement, maxW = 320): ImageData | null {
  const w = Math.min(maxW, src.width);
  const h = Math.max(1, Math.round((src.height * w) / Math.max(1, src.width)));
  if (!w || !h) return null;
  const c = sampler.canvas;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  sampler.ctx.drawImage(src, 0, 0, w, h);
  return sampler.ctx.getImageData(0, 0, w, h);
}
const sampler = (() => {
  const canvas = document.createElement('canvas');
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! };
})();

function fit(c: HTMLCanvasElement): { W: number; H: number; ctx: CanvasRenderingContext2D } {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(c.clientWidth * dpr));
  const H = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  return { W, H, ctx: c.getContext('2d')! };
}

const GRID = 'rgba(255,255,255,0.10)';
const LABEL = 'rgba(255,255,255,0.35)';

export function drawHistogram(c: HTMLCanvasElement, px: ImageData | null): void {
  const { W, H, ctx } = fit(c);
  ctx.fillStyle = '#0b0b0b';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const x = Math.round((W * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  if (!px) return;
  const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    bins[0][d[i]]++;
    bins[1][d[i + 1]]++;
    bins[2][d[i + 2]]++;
  }
  let max = 1;
  for (const b of bins) for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);
  const top = H * 0.06;
  const cols = ['rgba(215,45,35,0.8)', 'rgba(55,175,65,0.7)', 'rgba(35,95,215,0.75)'];
  ctx.globalCompositeOperation = 'screen';
  bins.forEach((b, ci) => {
    ctx.fillStyle = cols[ci];
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, b[i] / max) * (H - top));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  });
  ctx.globalCompositeOperation = 'source-over';
}

export function drawVectorscope(c: HTMLCanvasElement, px: ImageData | null): void {
  const { W, H, ctx } = fit(c);
  ctx.fillStyle = '#0b0b0b';
  ctx.fillRect(0, 0, W, H);
  const R = Math.min(W, H) * 0.45;
  const cx = W / 2;
  const cy = H / 2;
  const dpr = window.devicePixelRatio || 1;
  // Trace (accumulated into an ImageData for speed).
  if (px) {
    const size = Math.ceil(R * 2);
    const acc = new Float32Array(size * size);
    const d = px.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255;
      const g = d[i + 1] / 255;
      const b = d[i + 2] / 255;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const cb = (b - y) / 1.8556;
      const cr = (r - y) / 1.5748;
      const x = Math.round(size / 2 + cb * 2 * R * 0.9);
      const yy = Math.round(size / 2 - cr * 2 * R * 0.9);
      if (x >= 0 && yy >= 0 && x < size && yy < size) acc[yy * size + x]++;
    }
    const img = ctx.createImageData(size, size);
    const o = img.data;
    for (let i = 0; i < acc.length; i++) {
      if (!acc[i]) continue;
      const v = Math.min(1, 0.25 + Math.log2(1 + acc[i]) / 6);
      o[i * 4] = 60 * v;
      o[i * 4 + 1] = 255 * v;
      o[i * 4 + 2] = 80 * v;
      o[i * 4 + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = size;
    tmp.height = size;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(tmp, cx - size / 2, cy - size / 2);
    ctx.globalCompositeOperation = 'source-over';
  }
  // Graticule.
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  // Skin-tone line (~123°).
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  const a = (-123 * Math.PI) / 180;
  ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
  ctx.stroke();
  // 75% colour targets.
  const targets: [string, number, number, number, string][] = [
    ['R', 0.75, 0, 0, '#e5484d'],
    ['Mg', 0.75, 0, 0.75, '#d24fd0'],
    ['B', 0, 0, 0.75, '#4a7cf0'],
    ['Cy', 0, 0.75, 0.75, '#3bc7d6'],
    ['G', 0, 0.75, 0, '#3fbf5a'],
    ['Yl', 0.75, 0.75, 0, '#d7c93a'],
  ];
  ctx.font = `${9 * dpr}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  for (const [lab, r, g, b, col] of targets) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const x = cx + ((b - y) / 1.8556) * 2 * R * 0.9;
    const yy = cy - ((r - y) / 1.5748) * 2 * R * 0.9;
    const s = 4 * dpr;
    ctx.strokeStyle = col;
    ctx.strokeRect(x - s, yy - s, s * 2, s * 2);
    ctx.fillStyle = col;
    ctx.fillText(lab, x + s + 2 * dpr, yy);
  }
}

export function drawWaveform(c: HTMLCanvasElement, px: ImageData | null): void {
  const { W, H, ctx } = fit(c);
  ctx.fillStyle = '#0b0b0b';
  ctx.fillRect(0, 0, W, H);
  const dpr = window.devicePixelRatio || 1;
  const top = H * 0.06;
  const bot = H * 0.04;
  const span = H - top - bot;
  if (px) {
    const cols = Math.max(1, Math.min(W, px.width));
    const rows = 256;
    const acc = [new Float32Array(cols * rows), new Float32Array(cols * rows), new Float32Array(cols * rows)];
    const d = px.data;
    const pw = px.width;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const x = Math.floor(((p % pw) / pw) * cols);
      acc[0][(255 - d[i]) * cols + x]++;
      acc[1][(255 - d[i + 1]) * cols + x]++;
      acc[2][(255 - d[i + 2]) * cols + x]++;
    }
    const img = ctx.createImageData(cols, rows);
    const o = img.data;
    const k = (n: number) => (n ? Math.min(0.85, 0.12 + Math.log2(1 + n) / 9) : 0);
    for (let i = 0; i < cols * rows; i++) {
      o[i * 4] = 255 * k(acc[0][i]);
      o[i * 4 + 1] = 255 * k(acc[1][i]);
      o[i * 4 + 2] = 255 * k(acc[2][i]);
      o[i * 4 + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = cols;
    tmp.height = rows;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, top, W, span);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = LABEL;
  ctx.font = `${9 * dpr}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  for (const v of [0, 25, 50, 75, 100]) {
    const y = Math.round(top + span * (1 - v / 100)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(18 * dpr, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillText(String(v), 3 * dpr, y);
  }
}

export function drawScope(type: ScopeType, c: HTMLCanvasElement, px: ImageData | null): void {
  if (type === 'histogram') drawHistogram(c, px);
  else if (type === 'vectorscope') drawVectorscope(c, px);
  else drawWaveform(c, px);
}
