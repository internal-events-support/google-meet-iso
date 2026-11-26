// Performance Details window — replica of ZoomISO v3 PerformanceDetailsView (page31_img01.png):
// PerformanceCaptureToolbar (status · Outputs|System · Stop/Start · Clear · Export Data),
// OutputsPerformanceDetailsView (table + per-output timeline scrubber + 6 OutputMetricCharts),
// SystemPerformanceDetailsView (scrubber + Current/Average/Maximum/Minimum table + charts).

import type { PerfSample } from '../../shared/types';
import { OUTPUT_METRIC_OPTIONS, PERF_SECTION_OPTIONS, SYSTEM_METRIC_OPTIONS } from '../../shared/types';
import { button, h, icon, segmented } from '../kit';
import { api, initStore, store } from '../store';
import { installWindowChrome } from '../chrome';

type Section = 'outputs' | 'system';
type Pt = { t: number; v: number | null };
interface Range {
  a: number; // 0..1 start
  b: number; // 0..1 end (1 = live edge, follows new data)
}
interface ChartOpts {
  color: string;
  fmt: (v: number) => string;
  /** Categorical ticks (evenly spaced, piecewise-linear) — the RE charts do this for resolution / frame rate. */
  cats?: number[];
}

let section: Section = 'outputs';
let samples: PerfSample[] = [];
let capture = { capturing: true, since: Date.now() };
const expanded = new Set<string>();
let expandedInit = false;
const ranges = new Map<string, Range>();

const COLORS = {
  incomingResolution: '#32D74B',
  incomingFrameRate: '#40C8E0',
  engineCycleTime: '#7D7AFF',
  engineLatency: '#FF375F',
  outgoingResolution: '#DA44E6',
  outgoingFrameRate: '#2BD9B0',
  cpu: '#0A84FF',
  gpu: '#BF5AF2',
  ram: '#FF9F0A',
  diskWrite: '#FFD60A',
  networkOut: '#FF375F',
  networkIn: '#32D74B',
};

// ---------------------------------------------------------------------------
const p2 = (n: number) => String(n).padStart(2, '0');
const clock24 = (t: number) => {
  const d = new Date(t);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
const clock12 = (t: number) => {
  const d = new Date(t);
  return `${d.getHours() % 12 || 12}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
const fpsFmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function niceTicks(max: number): number[] {
  if (!(max > 0)) max = 1;
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(+v.toFixed(6));
  if (out[out.length - 1] < max) out.push(+(out[out.length - 1] + step).toFixed(6));
  return out;
}

/** Inline SVG line + area chart (PerformanceLineChart). */
function drawChart(host: HTMLElement, pts: Pt[], t0: number, t1: number, o: ChartOpts): void {
  const W = Math.max(200, host.clientWidth || 380);
  const H = Math.max(100, host.clientHeight || 160);
  const valid = pts.filter((p) => p.v !== null) as { t: number; v: number }[];
  let ticks: number[];
  let yOf: (v: number) => number;
  const L = 52;
  const R = 10;
  const T = 8;
  const B = 22;
  const ph = H - T - B;
  if (o.cats) {
    const maxV = Math.max(0, ...valid.map((p) => p.v));
    ticks = o.cats.filter((c, i) => c <= maxV || i <= 1 || o.cats![i - 1] < maxV);
    if (ticks.length < 2) ticks = o.cats.slice(0, 2);
    const n = ticks.length - 1;
    yOf = (v) => {
      let i = 0;
      while (i < n - 1 && v > ticks[i + 1]) i++;
      const a = ticks[i];
      const b = ticks[i + 1];
      const f = Math.max(0, Math.min(1.05, (v - a) / (b - a || 1)));
      return T + ph - ((i + f) / n) * ph;
    };
  } else {
    ticks = niceTicks(Math.max(0, ...valid.map((p) => p.v)) * 1.1);
    const top = ticks[ticks.length - 1] || 1;
    yOf = (v) => T + ph - (v / top) * ph;
  }
  const span = Math.max(1, t1 - t0);
  const xOf = (t: number) => L + ((t - t0) / span) * (W - L - R);
  let svg = '';
  for (const tk of ticks) {
    const y = yOf(tk);
    svg += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="grid"/>`;
    svg += `<text x="${L - 8}" y="${y + 3.5}" text-anchor="end">${o.fmt(tk)}</text>`;
  }
  const nx = Math.max(2, Math.floor((W - L - R) / 62));
  for (let i = 1; i <= nx; i++) {
    const t = t0 + (span * i) / (nx + 0.3);
    const x = xOf(t);
    svg += `<line x1="${x}" x2="${x}" y1="${T}" y2="${T + ph}" class="vgrid"/>`;
    svg += `<text x="${x}" y="${H - 6}" text-anchor="middle">${clock12(t)}</text>`;
  }
  // Split into runs of valid points (gaps = output inactive).
  const runs: { t: number; v: number }[][] = [];
  let cur: { t: number; v: number }[] = [];
  for (const p of pts) {
    if (p.v === null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push(p as { t: number; v: number });
  }
  if (cur.length) runs.push(cur);
  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  svg = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${o.color}" stop-opacity=".42"/><stop offset="1" stop-color="${o.color}" stop-opacity=".08"/></linearGradient></defs>` + svg;
  const base = T + ph;
  for (const run of runs) {
    const line = run.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join('');
    const area = `${line}L${xOf(run[run.length - 1].t).toFixed(1)},${base}L${xOf(run[0].t).toFixed(1)},${base}Z`;
    svg += `<path d="${area}" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="${o.color}" stroke-width="1.6" stroke-linejoin="round"/>`;
  }
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svg}</svg>`;
}

function chartCard(title: string): { el: HTMLElement; body: HTMLElement } {
  const body = h('div.pf-chart-body');
  return { el: h('div.pf-chart', h('div.pf-chart-title', title), body), body };
}

function placeholder(body: HTMLElement, text: string): void {
  body.replaceChildren(h('div.pf-placeholder', text));
}

/** PerformanceTimelineScrubber: two handles over the captured span. */
function scrubber(key: string, onChange: () => void) {
  const startLbl = h('span.pf-scrub-time');
  const endLbl = h('span.pf-scrub-time');
  const sel = h('div.pf-scrub-sel');
  const ha = h('div.pf-scrub-handle') as HTMLDivElement;
  const hb = h('div.pf-scrub-handle') as HTMLDivElement;
  const track = h('div.pf-scrub-track', sel, ha, hb) as HTMLDivElement;
  const el = h('div.pf-scrub', startLbl, track, endLbl);
  const rng = () => ranges.get(key) ?? { a: 0, b: 1 };
  const layout = () => {
    const r = rng();
    sel.style.left = `${r.a * 100}%`;
    sel.style.width = `${(r.b - r.a) * 100}%`;
    ha.style.left = `${r.a * 100}%`;
    hb.style.left = `${r.b * 100}%`;
  };
  const drag = (which: 'a' | 'b') => (e: PointerEvent) => {
    e.preventDefault();
    const box = track.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const f = Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width));
      const r = { ...rng() };
      if (which === 'a') r.a = Math.min(f, r.b - 0.02);
      else r.b = Math.max(f, r.a + 0.02);
      if (r.b > 0.995) r.b = 1;
      ranges.set(key, r);
      layout();
      onChange();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  ha.addEventListener('pointerdown', drag('a'));
  hb.addEventListener('pointerdown', drag('b'));
  track.addEventListener('dblclick', () => {
    ranges.delete(key);
    layout();
    onChange();
  });
  layout();
  return {
    el,
    update(t0: number, t1: number) {
      startLbl.textContent = t0 ? clock24(t0) : '--:--:--';
      endLbl.textContent = t1 ? clock24(t1) : '--:--:--';
      layout();
    },
  };
}

/** Visible [t0, t1] for a range over the whole capture. */
function window_(key: string): [number, number] {
  const first = samples[0]?.t ?? Date.now();
  const last = samples[samples.length - 1]?.t ?? first;
  const r = ranges.get(key) ?? { a: 0, b: 1 };
  const span = Math.max(1, last - first);
  return [first + r.a * span, first + r.b * span];
}

// ---------------------------------------------------------------------------
// Outputs section
type OutMetric = (typeof OUTPUT_METRIC_OPTIONS)[number]['value'];
const OUT_TITLES: Record<OutMetric, string> = {
  incomingResolution: 'Incoming resolution',
  incomingFrameRate: 'Incoming frame rate',
  engineCycleTime: 'Engine cycle time',
  engineLatency: 'Engine latency',
  outgoingResolution: 'Outgoing resolution',
  outgoingFrameRate: 'Outgoing frame rate',
};
type OutSample = PerfSample['outputs'][number];
const OUT_VALUE: Record<OutMetric, (o: OutSample) => number | null> = {
  incomingResolution: (o) => (o.inH > 0 ? o.inH : null),
  incomingFrameRate: (o) => (o.inH > 0 ? o.inFps : null),
  engineCycleTime: (o) => (o.cycleMs > 0 ? o.cycleMs : null),
  engineLatency: (o) => (o.inH > 0 ? o.latencyMs : null),
  outgoingResolution: (o) => (o.outH > 0 ? o.outH : null),
  outgoingFrameRate: (o) => (o.outH > 0 ? o.outFps : null),
};
const OUT_OPTS: Record<OutMetric, ChartOpts> = {
  incomingResolution: { color: COLORS.incomingResolution, fmt: (v) => String(v), cats: [0, 90, 180, 360, 480, 720, 1080, 1440, 2160] },
  incomingFrameRate: { color: COLORS.incomingFrameRate, fmt: (v) => `${fpsFmt(v)} fps` },
  engineCycleTime: { color: COLORS.engineCycleTime, fmt: (v) => `${fpsFmt(v)} ms` },
  engineLatency: { color: COLORS.engineLatency, fmt: (v) => `${fpsFmt(v)} ms` },
  outgoingResolution: { color: COLORS.outgoingResolution, fmt: (v) => String(v), cats: [0, 360, 480, 720, 1080, 2160] },
  outgoingFrameRate: { color: COLORS.outgoingFrameRate, fmt: (v) => `${fpsFmt(v)} fps`, cats: [23.98, 24, 25, 29.97, 30, 50, 59.94, 60] },
};

interface OutRow {
  el: HTMLElement;
  cells: HTMLElement[];
  detail: HTMLElement;
  scrub: ReturnType<typeof scrubber>;
  charts: Record<OutMetric, { el: HTMLElement; body: HTMLElement }>;
  chev: HTMLElement;
}
const outRows = new Map<string, OutRow>();

function buildOutputs(): HTMLElement {
  const head = h('div.pf-thead', ...['Output name', ...OUTPUT_METRIC_OPTIONS.map((m) => m.label)].map((l) => h('div', l)));
  const body = h('div.pf-tbody');
  const empty = h('div.pf-empty', 'No outputs');
  const wrap = h('div.pf-table', head, body, empty);
  (wrap as unknown as { refresh: () => void }).refresh = () => {
    const outs = store.settings.outputs;
    if (!expandedInit && outs.length) {
      expandedInit = true;
      if (outs[0]) expanded.add(outs[0].id);
    }
    empty.hidden = outs.length > 0;
    const seen = new Set<string>();
    for (const o of outs) {
      seen.add(o.id);
      let row = outRows.get(o.id);
      if (!row) {
        row = makeOutRow(o.id);
        outRows.set(o.id, row);
      }
      body.append(row.el); // keeps order in sync
      updateOutRow(o.id, o.name, row);
    }
    for (const [id, row] of outRows)
      if (!seen.has(id)) {
        row.el.remove();
        outRows.delete(id);
      }
  };
  return wrap;
}

function makeOutRow(id: string): OutRow {
  const chev = h('span.pf-chev', icon('chevronDown'));
  const cells = Array.from({ length: 7 }, () => h('div'));
  cells[0].prepend(chev);
  const line = h('div.pf-row', ...cells);
  const charts = {} as OutRow['charts'];
  const grid = h('div.pf-grid');
  for (const m of OUTPUT_METRIC_OPTIONS) {
    charts[m.value] = chartCard(OUT_TITLES[m.value]);
    grid.append(charts[m.value].el);
  }
  const row: OutRow = { el: h('div.pf-out'), cells, detail: h('div.pf-detail'), scrub: null as unknown as OutRow['scrub'], charts, chev };
  row.scrub = scrubber(id, () => drawOutCharts(id, row));
  row.detail.append(row.scrub.el, grid);
  row.el.append(line, row.detail);
  line.addEventListener('click', () => {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    refresh();
  });
  return row;
}

function seriesFor(id: string): { t: number; o: OutSample | null }[] {
  return samples.map((s) => ({ t: s.t, o: s.outputs.find((x) => x.id === id) ?? null }));
}

function updateOutRow(id: string, name: string, row: OutRow): void {
  const open = expanded.has(id);
  row.chev.classList.toggle('closed', !open);
  row.detail.hidden = !open;
  const live = store.state?.outputs.find((o) => o.id === id);
  const last = [...samples].reverse().find((s) => s.outputs.some((x) => x.id === id))?.outputs.find((x) => x.id === id);
  const inW = live?.inWidth ?? last?.inW ?? 0;
  const inH = live?.inHeight ?? last?.inH ?? 0;
  const vals = [
    name,
    inH ? `${inW} x ${inH}` : '--',
    inH ? `${(live?.inFps ?? last?.inFps ?? 0).toFixed(1)} fps` : '--',
    (live?.cycleMs ?? last?.cycleMs) ? `${(live?.cycleMs ?? last?.cycleMs ?? 0).toFixed(1)} ms/cyc` : '--',
    inH ? `${Math.round(live?.latencyMs ?? last?.latencyMs ?? 0)} ms` : '--',
    (live?.outHeight ?? last?.outH) ? `${live?.outWidth ?? last?.outW} x ${live?.outHeight ?? last?.outH}` : '--',
    (live?.outFps ?? last?.outFps) ? `${fpsFmt(+(live?.outFps ?? last?.outFps ?? 0).toFixed(2))} fps` : '--',
  ];
  row.cells.forEach((c, i) => {
    const node = i === 0 ? (c.lastChild as Node | null) : c.firstChild;
    if (i === 0) {
      if (node && node.nodeType === 3) node.textContent = vals[0];
      else c.append(vals[0]);
    } else c.textContent = vals[i];
  });
  if (open) drawOutCharts(id, row);
}

function drawOutCharts(id: string, row: OutRow): void {
  const [t0, t1] = window_(id);
  row.scrub.update(samples[0]?.t ?? 0, samples[samples.length - 1]?.t ?? 0);
  const ser = seriesFor(id).filter((p) => p.t >= t0 - 1 && p.t <= t1 + 1);
  for (const m of OUTPUT_METRIC_OPTIONS) {
    const c = row.charts[m.value];
    const pts: Pt[] = ser.map((p) => ({ t: p.t, v: p.o ? OUT_VALUE[m.value](p.o) : null }));
    if (!samples.length) placeholder(c.body, capture.capturing ? 'Waiting for data…' : 'Start performance log capture to plot data');
    else if (!pts.some((p) => p.v !== null)) placeholder(c.body, 'Output inactive');
    else drawChart(c.body, pts, t0, t1, OUT_OPTS[m.value]);
  }
}

// ---------------------------------------------------------------------------
// System section
type SysMetric = (typeof SYSTEM_METRIC_OPTIONS)[number]['value'];
const SYS_VALUE: Record<SysMetric, ((s: PerfSample) => number) | null> = {
  cpu: (s) => s.cpu,
  gpu: null,
  ram: (s) => s.memMB / 1024,
  diskWrite: null,
  networkOut: null,
  networkIn: (s) => s.rxMbps,
};
const SYS_FMT: Record<SysMetric, (v: number) => string> = {
  cpu: (v) => `${Math.round(v)}%`,
  gpu: (v) => `${Math.round(v)}%`,
  ram: (v) => `${v.toFixed(1)} GB`,
  diskWrite: (v) => `${v.toFixed(1)} MB/s`,
  networkOut: (v) => `${v.toFixed(1)} Mbps`,
  networkIn: (v) => `${v.toFixed(1)} Mbps`,
};
const SYS_NA: Partial<Record<SysMetric, string>> = {
  gpu: 'GPU usage is not exposed to Google Meet ISO on Windows',
  diskWrite: 'Disk write rate is not measured by Google Meet ISO',
  networkOut: 'Outgoing network rate is not measured by Google Meet ISO',
};

let sysBuilt: { el: HTMLElement; refresh: () => void } | null = null;
function buildSystem(): { el: HTMLElement; refresh: () => void } {
  const scrub = scrubber('__system__', () => draw());
  const tbody = h('div.pf-tbody');
  const cells = new Map<SysMetric, HTMLElement[]>();
  for (const m of SYSTEM_METRIC_OPTIONS) {
    const cs = [h('div', h('span.pf-dot', { style: `background:${COLORS[m.value]}` }), m.label), h('div'), h('div'), h('div'), h('div')];
    cells.set(m.value, cs);
    const r = h('div.pf-row.pf-sysrow', ...cs);
    if (SYS_NA[m.value]) r.title = SYS_NA[m.value]!;
    tbody.append(r);
  }
  const table = h('div.pf-table.pf-systable', h('div.pf-thead', ...['Metric', 'Current', 'Average', 'Maximum', 'Minimum'].map((l) => h('div', l))), tbody);
  const grid = h('div.pf-grid');
  const charts = new Map<SysMetric, { el: HTMLElement; body: HTMLElement }>();
  for (const m of SYSTEM_METRIC_OPTIONS) {
    const c = chartCard(m.label);
    charts.set(m.value, c);
    grid.append(c.el);
  }
  const draw = () => {
    const [t0, t1] = window_('__system__');
    scrub.update(samples[0]?.t ?? 0, samples[samples.length - 1]?.t ?? 0);
    const vis = samples.filter((s) => s.t >= t0 - 1 && s.t <= t1 + 1);
    for (const m of SYSTEM_METRIC_OPTIONS) {
      const f = SYS_VALUE[m.value];
      const cs = cells.get(m.value)!;
      const c = charts.get(m.value)!;
      if (!f) {
        for (let i = 1; i < 5; i++) cs[i].textContent = 'N/A';
        placeholder(c.body, SYS_NA[m.value]!);
        continue;
      }
      const vals = vis.map(f);
      const fmt = SYS_FMT[m.value];
      const cur = store.system ? (m.value === 'cpu' ? store.system.cpu : m.value === 'ram' ? store.system.memMB / 1024 : store.system.rxMbps) : vals[vals.length - 1];
      cs[1].textContent = cur !== undefined ? fmt(cur) : '--';
      cs[2].textContent = vals.length ? fmt(vals.reduce((a, b) => a + b, 0) / vals.length) : '--';
      cs[3].textContent = vals.length ? fmt(Math.max(...vals)) : '--';
      cs[4].textContent = vals.length ? fmt(Math.min(...vals)) : '--';
      if (!samples.length) placeholder(c.body, capture.capturing ? 'Waiting for data…' : 'Start performance log capture to plot data');
      else drawChart(c.body, vis.map((s) => ({ t: s.t, v: f(s) })), t0, t1, { color: COLORS[m.value], fmt });
    }
  };
  const el = h('div.pf-system', scrub.el, table, grid);
  return { el, refresh: draw };
}

// ---------------------------------------------------------------------------
let outputsEl: HTMLElement & { refresh?: () => void };
let content: HTMLElement;
let statusEl: HTMLElement;
let stopBtn: HTMLButtonElement;

function refresh(): void {
  statusEl.textContent = capture.capturing ? `Capturing since ${clock24(capture.since)}` : 'Performance log capture is stopped';
  stopBtn.textContent = capture.capturing ? 'Stop' : 'Start';
  outputsEl.hidden = section !== 'outputs';
  sysBuilt!.el.hidden = section !== 'system';
  if (section === 'outputs') (outputsEl as unknown as { refresh: () => void }).refresh();
  else sysBuilt!.refresh();
}

function exportCsv(): void {
  const outs = [...new Map(samples.flatMap((s) => s.outputs.map((o) => [o.id, o.name] as const))).entries()];
  const header = ['time', 'cpu_pct', 'ram_gb', 'network_in_mbps'];
  for (const [, name] of outs) for (const m of ['in_w', 'in_h', 'in_fps', 'cycle_ms', 'latency_ms', 'out_w', 'out_h', 'out_fps']) header.push(`${name} ${m}`);
  const lines = [header.map((x) => `"${x.replace(/"/g, '""')}"`).join(',')];
  for (const s of samples) {
    const row: (string | number)[] = [new Date(s.t).toISOString(), s.cpu.toFixed(1), (s.memMB / 1024).toFixed(2), s.rxMbps.toFixed(2)];
    for (const [id] of outs) {
      const o = s.outputs.find((x) => x.id === id);
      row.push(...(o ? [o.inW, o.inH, o.inFps.toFixed(2), o.cycleMs.toFixed(2), o.latencyMs.toFixed(1), o.outW, o.outH, o.outFps.toFixed(2)] : ['', '', '', '', '', '', '', '']));
    }
    lines.push(row.join(','));
  }
  const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: `Google Meet ISO Performance ${clock24(Date.now()).replace(/:/g, '-')}.csv` }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
}

async function poll(): Promise<void> {
  try {
    samples = await api.perfHistory();
  } catch {
    /* window closing */
  }
  refresh();
}

void initStore().then(async () => {
  installWindowChrome();
  const app = document.getElementById('app')!;
  statusEl = h('span.pf-status');
  const nav = segmented(PERF_SECTION_OPTIONS.map((o) => ({ value: o.value, label: o.label })), section, (v) => {
    section = v as Section;
    nav.set(section);
    refresh();
  }, 'pf-nav');
  stopBtn = button('Stop', async () => {
    capture = await api.perfControl(capture.capturing ? 'stop' : 'start');
    void poll();
  }, 'pf-tb');
  const clearBtn = button('Clear', async () => {
    capture = await api.perfControl('clear');
    ranges.clear();
    void poll();
  }, 'pf-tb');
  const exportBtn = button('Export data', exportCsv, 'pf-tb');
  const toolbar = h('div.pf-toolbar', h('div.pf-tl', statusEl), h('div.pf-tc', nav.el), h('div.pf-tr', stopBtn, clearBtn, exportBtn));
  outputsEl = buildOutputs();
  sysBuilt = buildSystem();
  content = h('div.pf-content', outputsEl, sysBuilt.el);
  app.append(toolbar, content);
  // perfControl has no read-only query; 'start' while already capturing would reset `since`, so infer it from history.
  samples = await api.perfHistory();
  const lastT = samples[samples.length - 1]?.t ?? 0;
  capture = { capturing: !samples.length || Date.now() - lastT < 3000, since: samples[0]?.t ?? Date.now() };
  refresh();
  setInterval(() => void poll(), 1000);
  window.addEventListener('resize', () => refresh());
});
