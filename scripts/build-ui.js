// Bundles the control UI (sandboxed renderer pages) with esbuild.
// One entry per window: main app, settings, output effects, performance details.
const esbuild = require('esbuild');
const path = require('path');

const root = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: {
    app: path.join(root, 'src/control/app.ts'),
    settings: path.join(root, 'src/control/windows/settings.ts'),
    effects: path.join(root, 'src/control/windows/effects.ts'),
    perf: path.join(root, 'src/control/windows/perf.ts'),
  },
  outdir: path.join(root, 'dist/ui'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  sourcemap: true,
  define: { __APP_VERSION__: JSON.stringify('v' + require('../package.json').version) },
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
