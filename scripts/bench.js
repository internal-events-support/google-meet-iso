// Video pipeline benchmark: runs the app against the mock Meet page with a fixed set of
// scenarios and prints CPU / GPU / main-thread lag / delivered-frame numbers per scenario.
//
//   npm run bench -- [--label=<name>] [--only=canvas6,jank] [--seconds=20] [--warmup=10] [--runs=1]
//
// Each run uses its own throwaway profile (tmp/bench/profiles), so the operator's settings and
// Google sign-in are never touched, and NDI sources are named "BENCH …". Results are saved to
// tmp/bench/results/<label>.json; pass --compare=<labelA>,<labelB> to diff two saved runs.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : 'true'];
  }),
);
const resultsDir = path.join(root, 'tmp', 'bench', 'results');

const F1080 = { width: 1920, height: 1080, fpsN: 30000, fpsD: 1001 };
const FX = { brightness: 1.05, saturation: 1.1, nameTag: true, nameTagSubtitle: 'Bench' };

function outputs(n, patch = {}) {
  const list = [];
  for (let i = 1; i <= n; i++) list.push({ id: `bench${i}`, name: `BENCH ${i}`, mode: 'auto', format: F1080, effects: { ...FX }, audio: 'off', ...patch });
  return list;
}
function withScreen(list) {
  list[list.length - 1] = { ...list[list.length - 1], mode: 'screenshare' };
  return list;
}

const SCENARIOS = {
  // 5 camera feeds (720p30, real WebRTC-decoded video) + a 1080p screen share → 6 × 1080p outputs with effects + name tag.
  canvas6: { query: 'n=5&w=1280&h=720&fps=30&screen=1&rtc=1', outputs: withScreen(outputs(6)) },
  // Enough canvas outputs to pass Chromium's live WebGL-context limit (2 contexts per output before the fix).
  canvas10: { query: 'n=9&w=1280&h=720&fps=30&screen=1&rtc=1', outputs: withScreen(outputs(10)) },
  // canvas6 while Meet's own JS keeps the page's main thread 40% busy.
  jank: { query: 'n=5&w=1280&h=720&fps=30&screen=1&rtc=1&jank=40', outputs: withScreen(outputs(6)) },
  // Native passthrough (no format, no effects), freeze loss mode.
  passthrough: { query: 'n=5&w=1280&h=720&fps=30&screen=1&rtc=1', outputs: withScreen(outputs(6, { format: null, effects: {}, lossMode: 'freeze' })) },
  // canvas6 with two outputs also shown in display windows (NDI receive → screen).
  display: {
    query: 'n=5&w=1280&h=720&fps=30&screen=1&rtc=1',
    outputs: withScreen(outputs(6).map((o, i) => (i < 2 ? { ...o, display: -1 } : o))),
    env: { GMEET_ISO_DISPLAY_TEST: '1' },
  },
  // Functional check (not a benchmark): serve it, then startRecording: output 1 is canvas, output 2 passthrough.
  record: {
    query: 'n=2&w=1280&h=720&fps=30&screen=0&rtc=1',
    outputs: [outputs(1)[0], { ...outputs(2, { format: null, effects: {} })[1] }],
    settings: (profile) => ({ recordDir: path.join(profile, 'rec') }),
  },
  // canvas6 with face-tracking auto-crop on.
  autocrop: { query: 'n=5&w=1280&h=720&fps=30&screen=1&rtc=1', outputs: withScreen(outputs(6, { autoCropEnabled: true })), env: { GMEET_ISO_EXPERIMENTAL_WEB: '1' } },
};

function runOnce(name, sc, seconds, warmup, serve = false, appDir = root) {
  const stamp = Date.now().toString(36);
  const profile = path.join(root, 'tmp', 'bench', 'profiles', `${name}-${stamp}`);
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    JSON.stringify({ ndiPrefix: 'BENCH', outputs: sc.outputs, previewFps: Number(args.previewFps ?? 8), oscEnabled: false, apiEnabled: false, ...(typeof sc.settings === 'function' ? sc.settings(profile) : (sc.settings ?? {})) }, null, 2),
  );
  const out = path.join(profile, 'bench-result.json');
  const electron = require('electron');
  return new Promise((resolve) => {
    const child = spawn(electron, ['.'], {
      cwd: appDir,
      env: {
        ...process.env,
        ...(sc.env ?? {}),
        GMEET_ISO_MOCK: '1',
        GMEET_ISO_MOCK_QUERY: sc.query,
        GMEET_ISO_USER_DATA: profile,
        ...(serve ? {} : { GMEET_ISO_BENCH: out }),
        GMEET_ISO_BENCH_SECONDS: String(seconds),
        GMEET_ISO_BENCH_WARMUP: String(warmup),
        GMEET_ISO_BENCH_PROFILE: args.profile ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    if (serve) {
      console.log(`serving ${name} (profile ${profile}); quit with: npx cross-env GMEET_ISO_USER_DATA="${profile}" electron . --cmd=quit`);
      child.stdout.pipe(process.stdout);
    }
    const kill = serve ? null : setTimeout(() => child.kill(), (seconds + warmup + 150) * 1000);
    child.on('exit', () => {
      clearTimeout(kill);
      fs.writeFileSync(path.join(profile, 'app.log'), log);
      try {
        resolve(JSON.parse(fs.readFileSync(out, 'utf8')));
      } catch {
        resolve({ error: 'no result', logTail: log.split('\n').slice(-15).join('\n') });
      }
    });
  });
}

function summary(r) {
  if (r.error) return { error: r.error };
  // Electron reports CPU as % of the whole machine; show cores (1.0 = one core busy).
  const cores = (p) => Math.round(((p * require('os').cpus().length) / 100) * 100) / 100;
  const eng = (k) => r.gpuEngines?.[k] ?? r.gpuEngines?.[k.toUpperCase()] ?? 0;
  return {
    coresTotal: cores(r.cpu.total),
    coresMeet: cores(r.cpu.meet),
    coresGpuProc: cores(r.cpu.gpu),
    gpu3d: eng('3d'),
    gpuCopy: eng('copy'),
    memMB: r.memMB,
    lagP95: r.meetLagP95Ms,
    lagMax: r.meetLagMaxMs,
    inFps: r.avgInFps,
    uniqueFps: r.avgUniqueFps,
    minUniqueFps: Math.min(...r.outputs.map((o) => o.uniqueFps)),
    late: r.outputs.reduce((s, o) => s + o.lateTicks, 0),
    cycleMs: r.avgCycleMs,
    glLost: r.glContextsLost,
  };
}

function mean(rs) {
  const ok = rs.filter((r) => !r.error);
  if (!ok.length) return rs[0];
  const o = {};
  for (const k of Object.keys(ok[0])) o[k] = Math.round((ok.reduce((s, r) => s + r[k], 0) / ok.length) * 10) / 10;
  return o;
}

function table(rows) {
  const keys = [...new Set(rows.flatMap(([, r]) => Object.keys(r)))];
  console.log(['scenario', ...keys].join('\t'));
  for (const [n, r] of rows) console.log([n, ...keys.map((k) => r[k] ?? '')].join('\t'));
}

async function main() {
  if (args.serve) {
    await runOnce(args.serve, SCENARIOS[args.serve], 0, 0, true);
    return;
  }
  if (args.compare) {
    const [a, b] = args.compare.split(',');
    const A = JSON.parse(fs.readFileSync(path.join(resultsDir, `${a}.json`), 'utf8'));
    const B = JSON.parse(fs.readFileSync(path.join(resultsDir, `${b}.json`), 'utf8'));
    for (const n of Object.keys(A.summary)) {
      if (!B.summary[n]) continue;
      console.log(`\n${n}: ${a} → ${b}`);
      for (const k of Object.keys(A.summary[n])) {
        const x = A.summary[n][k];
        const y = B.summary[n][k];
        const d = typeof x === 'number' && x ? ` (${y >= x ? '+' : ''}${Math.round(((y - x) / x) * 100)}%)` : '';
        console.log(`  ${k.padEnd(13)} ${String(x).padStart(8)} → ${String(y).padStart(8)}${d}`);
      }
    }
    return;
  }
  if (args.ab) return ab(path.resolve(args.ab));
  const seconds = Number(args.seconds ?? 20);
  const warmup = Number(args.warmup ?? 10);
  const runs = Number(args.runs ?? 1);
  const only = args.only ? args.only.split(',') : Object.keys(SCENARIOS);
  const label = args.label ?? new Date().toISOString().replace(/[:.]/g, '-');
  const raw = {};
  const summ = {};
  for (const n of only) {
    const sc = SCENARIOS[n];
    if (!sc) throw new Error(`unknown scenario ${n}`);
    raw[n] = [];
    for (let i = 0; i < runs; i++) {
      process.stdout.write(`${n} run ${i + 1}/${runs}… `);
      const r = await runOnce(n, sc, seconds, warmup);
      raw[n].push(r);
      console.log(r.error ? `ERROR ${r.error}` : `cpu ${r.cpu.total}% unique ${r.avgUniqueFps} fps`);
      if (r.profile) {
        console.log(`  main-thread profile (${r.profile.sampledMs} ms sampled; idle = "(idle)"):`);
        for (const [f, ms] of r.profile.top.slice(0, Number(args.profile) > 1 ? Number(args.profile) : 18)) console.log(`    ${String(ms).padStart(6)} ms  ${f}`);
      }
      if (r.error && r.logTail) console.log(r.logTail);
    }
    summ[n] = mean(raw[n].map(summary));
  }
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), summary: summ, raw }, null, 2));
  console.log(`\n${label}`);
  table(Object.entries(summ));
}

/**
 * A/B: alternate runs of another checkout (`--ab=<dir>`, e.g. the original code + this harness)
 * and this one, so both see the same machine conditions. Prints base → new with % change.
 */
async function ab(baseDir) {
  const seconds = Number(args.seconds ?? 20);
  const warmup = Number(args.warmup ?? 10);
  const runs = Number(args.runs ?? 2);
  const only = args.only ? args.only.split(',') : Object.keys(SCENARIOS);
  const label = args.label ?? `ab-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const out = { label, at: new Date().toISOString(), base: baseDir, summary: {}, raw: {} };
  for (const n of only) {
    const A = [];
    const B = [];
    for (let i = 0; i < runs; i++) {
      process.stdout.write(`${n} ${i + 1}/${runs}: base… `);
      const a = await runOnce(n, SCENARIOS[n], seconds, warmup, false, baseDir);
      process.stdout.write(a.error ? 'ERR ' : `${a.avgUniqueFps}fps `);
      process.stdout.write('new… ');
      const b = await runOnce(n, SCENARIOS[n], seconds, warmup, false, root);
      console.log(b.error ? 'ERR' : `${b.avgUniqueFps}fps`);
      A.push(a);
      B.push(b);
    }
    out.raw[n] = { base: A, new: B };
    out.summary[n] = { base: mean(A.map(summary)), new: mean(B.map(summary)) };
  }
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${label}.json`), JSON.stringify(out, null, 2));
  console.log(`
${label}  (base → new)`);
  for (const [n, { base, new: nw }] of Object.entries(out.summary)) {
    console.log(`
${n}`);
    for (const k of Object.keys(base)) {
      const x = base[k];
      const y = nw[k];
      const d = typeof x === 'number' && x ? ` ${y >= x ? '+' : ''}${Math.round(((y - x) / x) * 100)}%` : '';
      console.log(`  ${k.padEnd(13)} ${String(x).padStart(8)} → ${String(y).padStart(8)}${d}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
