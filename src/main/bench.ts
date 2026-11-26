// Benchmark mode (GMEET_ISO_BENCH=<result.json>, driven by scripts/bench.js).
//
// Waits until the mock call is up and every enabled output is live, lets it settle, then
// samples once a second: per-process CPU (Electron app metrics), GPU engine utilisation of
// our processes (Windows perf counters), memory, the Meet page's main-thread lag, and each
// output's native NDI counters (frames submitted / sent / late / dropped). Writes the
// averages to the result file and exits.

import { app, type BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import type { MeetState } from '../shared/types';

interface BenchEnv {
  out: string;
  meetWin: () => BrowserWindow | null;
  state: () => MeetState | null;
  log: (s: string) => void;
}

interface OutSample {
  submitted: number;
  sent: number;
  late: number;
  dropped: number;
  t: number;
}

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Samples GPU engine utilisation (%) of `pids` once a second for `secs` seconds. */
function sampleGpu(pids: number[], secs: number): Promise<Record<string, number>> {
  const script = `
$pids = @(${pids.join(',')})
$acc = @{}
$n = 0
Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -SampleInterval 1 -MaxSamples ${secs} -ErrorAction SilentlyContinue | ForEach-Object {
  $n++
  $per = @{}
  foreach ($c in $_.CounterSamples) {
    if ($c.InstanceName -match '^pid_(\\d+)_.*engtype_(.+)$') {
      if ($pids -contains [int]$Matches[1]) { $per[$Matches[2]] = $per[$Matches[2]] + $c.CookedValue }
    }
  }
  foreach ($k in $per.Keys) { $acc[$k] = $acc[$k] + $per[$k] }
}
$o = @{}
foreach ($k in $acc.Keys) { $o[$k] = [math]::Round($acc[$k] / [math]::Max(1, $n), 1) }
$o | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({});
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.on('close', () => {
      try {
        resolve(JSON.parse(out.trim() || '{}') as Record<string, number>);
      } catch {
        resolve({});
      }
    });
    ps.on('error', () => resolve({}));
  });
}

interface ProfNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}

/** CPU-profile the Meet page's main thread (V8 sampling profiler) and return top self-time functions. */
async function profileMeet(win: BrowserWindow | null, ms: number): Promise<{ sampledMs: number; top: [string, number][] } | null> {
  if (!win) return null;
  const dbg = win.webContents.debugger;
  try {
    dbg.attach('1.3');
    await dbg.sendCommand('Profiler.enable');
    await dbg.sendCommand('Profiler.setSamplingInterval', { interval: 200 });
    await dbg.sendCommand('Profiler.start');
    await new Promise((r) => setTimeout(r, ms));
    const { profile } = (await dbg.sendCommand('Profiler.stop')) as { profile: { nodes: ProfNode[]; samples: number[]; timeDeltas: number[] } };
    dbg.detach();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map<string, number>();
    let total = 0;
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
      if (!n) return;
      const f = n.callFrame;
      const name = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      self.set(name, (self.get(name) ?? 0) + dt);
      total += dt;
    });
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, Math.round(v)] as [string, number]);
    return { sampledMs: Math.round(total), top };
  } catch (e) {
    try {
      dbg.detach();
    } catch {
      /* not attached */
    }
    return { sampledMs: 0, top: [[`profile failed: ${(e as Error).message}`, 0]] };
  }
}

export function startBench(env: BenchEnv): void {
  const warmupS = Number(process.env.GMEET_ISO_BENCH_WARMUP ?? 12);
  const durationS = Number(process.env.GMEET_ISO_BENCH_SECONDS ?? 20);
  const deadline = Date.now() + 120_000;
  const finish = (result: unknown) => {
    fs.writeFileSync(env.out, JSON.stringify(result, null, 2));
    env.log(`bench: wrote ${env.out}`);
    app.exit(0);
  };

  const waitLive = setInterval(() => {
    const s = env.state();
    const outs = s?.outputs ?? [];
    const ready = !!s?.inCall && outs.length > 0 && outs.filter((o) => o.status !== 'off').every((o) => o.status === 'live');
    if (Date.now() > deadline) {
      clearInterval(waitLive);
      finish({ error: 'outputs never went live', state: s ? { phase: s.phase, outputs: outs.map((o) => [o.name, o.status]) } : null });
      return;
    }
    if (!ready) return;
    clearInterval(waitLive);
    env.log(`bench: live; warming up ${warmupS}s`);
    setTimeout(measure, warmupS * 1000);
  }, 500);

  function measure(): void {
    env.log(`bench: measuring ${durationS}s`);
    const meetPid = env.meetWin()?.webContents.getOSProcessId() ?? -1;
    app.getAppMetrics(); // reset the CPU-usage window
    const cpu: Record<string, number[]> = { total: [], meet: [], gpu: [], browser: [], other: [] };
    const mem: number[] = [];
    const meetMem: number[] = [];
    const lag: number[] = [];
    const lagMax: number[] = [];
    const first = new Map<string, OutSample>();
    let last = new Map<string, OutSample>();
    const cycles = new Map<string, number[]>();
    const lost: number[] = [];
    const pids = app.getAppMetrics().map((m) => m.pid);
    const gpu = sampleGpu(pids, durationS);
    const profile = process.env.GMEET_ISO_BENCH_PROFILE === '1' ? profileMeet(env.meetWin(), durationS * 1000 - 500) : Promise.resolve(null);
    let n = 0;
    const iv = setInterval(() => {
      const ms = app.getAppMetrics();
      let total = 0;
      let meet = 0;
      let g = 0;
      let b = 0;
      let o = 0;
      let m = 0;
      for (const x of ms) {
        const c = x.cpu.percentCPUUsage;
        total += c;
        m += (x.memory.workingSetSize ?? 0) / 1024;
        if (x.pid === meetPid) {
          meet += c;
          meetMem.push((x.memory.workingSetSize ?? 0) / 1024);
        } else if (x.type === 'GPU') g += c;
        else if (x.type === 'Browser') b += c;
        else o += c;
      }
      cpu.total.push(total);
      cpu.meet.push(meet);
      cpu.gpu.push(g);
      cpu.browser.push(b);
      cpu.other.push(o);
      mem.push(m);
      const s = env.state();
      if (s?.bench) {
        lag.push(s.bench.lagP95);
        lagMax.push(s.bench.lagMax);
        lost.push(s.bench.glContextsLost);
      }
      const now = Date.now();
      const cur = new Map<string, OutSample>();
      for (const out of s?.outputs ?? []) {
        if (out.status === 'off') continue;
        const smp = { submitted: out.nativeSubmitted ?? 0, sent: out.nativeSent ?? 0, late: out.nativeLate ?? 0, dropped: out.nativeDropped ?? 0, t: now };
        cur.set(out.name, smp);
        if (!first.has(out.name)) first.set(out.name, smp);
        const arr = cycles.get(out.name) ?? [];
        arr.push(out.cycleMs ?? 0);
        cycles.set(out.name, arr);
      }
      last = cur;
      if (++n >= durationS) {
        clearInterval(iv);
        void Promise.all([gpu, profile]).then(([gpuEngines, prof]) => {
          const outputs = [...last].map(([name, l]) => {
            const f = first.get(name)!;
            const dt = Math.max(0.001, (l.t - f.t) / 1000);
            const st = s?.outputs.find((x) => x.name === name);
            return {
              name,
              inFps: st?.inFps ?? 0,
              uniqueFps: r1((l.submitted - f.submitted) / dt),
              sentFps: r1((l.sent - f.sent) / dt),
              lateTicks: l.late - f.late,
              dropped: l.dropped - f.dropped,
              cycleMs: r1(avg(cycles.get(name) ?? [])),
              out: `${st?.outWidth}x${st?.outHeight}`,
            };
          });
          finish({
            seconds: durationS,
            cpu: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, r1(avg(v))])),
            gpuEngines,
            memMB: Math.round(avg(mem)),
            meetMemMB: Math.round(avg(meetMem)),
            meetLagP95Ms: r1(avg(lag)),
            meetLagMaxMs: r1(Math.max(0, ...lagMax)),
            glContextsLost: Math.max(0, ...lost),
            outputs,
            avgUniqueFps: r1(avg(outputs.map((x) => x.uniqueFps))),
            avgInFps: r1(avg(outputs.map((x) => x.inFps))),
            avgCycleMs: r1(avg(outputs.map((x) => x.cycleMs))),
            profile: prof,
          });
        });
      }
    }, 1000);
  }
}
