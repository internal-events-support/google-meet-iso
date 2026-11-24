// Tests for the first-run copy from GMeet ISO (temp folders only).
//   node scripts/test-carryover.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carryover-'));
const outfile = path.join(root, 'carryover.js');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/main/carryover.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error' });
const { carryOver, OldAppRunning } = require(outfile);
let n = 0;
let failed = 0;
function test(name, fn) {
  const dir = path.join(root, String(++n));
  const put = (rel, text = rel) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const get = (rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : null);
  const oldApp = (d = 'GMeet ISO') => {
    put(`${d}/settings.json`, JSON.stringify({ botName: d }));
    put(`${d}/Local State`);
    put(`${d}/Partitions/meet/Network/Cookies`);
    put(`${d}/Partitions/meet/Cache/big`);
    put(`${d}/Partitions/meet/Service Worker/CacheStorage/keep`);
    put(`${d}/GPUCache/data`);
  };
  fs.mkdirSync(dir);
  const run = () => carryOver(dir, path.join(dir, 'Google Meet ISO'), path.join(dir, 'Videos', 'GMeet ISO'));
  try {
    fn({ dir, put, get, oldApp, run });
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n${e.stack}`);
  }
}

test('copies settings and sign-in, leaves the old folder alone, skips caches', ({ get, oldApp, run, put, dir }) => {
  oldApp();
  put('Google Meet ISO/lockfile', ''); // our own lock is already there
  assert.ok(run().endsWith('GMeet ISO'));
  assert.strictEqual(JSON.parse(get('Google Meet ISO/settings.json')).botName, 'GMeet ISO');
  assert.ok(get('Google Meet ISO/Local State') && get('Google Meet ISO/Partitions/meet/Network/Cookies'));
  assert.ok(get('Google Meet ISO/Partitions/meet/Service Worker/CacheStorage/keep'));
  assert.strictEqual(get('Google Meet ISO/Partitions/meet/Cache/big'), null);
  assert.strictEqual(get('Google Meet ISO/GPUCache/data'), null);
  assert.ok(get('GMeet ISO/Partitions/meet/Network/Cookies') && get('GMeet ISO/settings.json'));
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'Google Meet ISO')).filter((f) => f.startsWith('.')), []);
});
test('runs once', ({ put, get, oldApp, run }) => {
  oldApp();
  run();
  put('GMeet ISO/settings.json', '{"botName":"changed"}');
  assert.strictEqual(run(), null);
  assert.strictEqual(JSON.parse(get('Google Meet ISO/settings.json')).botName, 'GMeet ISO');
});
test('never overwrites an existing new profile', ({ put, get, oldApp, run }) => {
  oldApp();
  put('Google Meet ISO/Local State', 'mine');
  assert.strictEqual(run(), null);
  assert.strictEqual(get('Google Meet ISO/Local State'), 'mine');
});
test('new install: nothing to do', ({ run }) => assert.strictEqual(run(), null));
test('falls back to gmeet-iso', ({ get, oldApp, run }) => {
  oldApp('gmeet-iso');
  assert.ok(run().endsWith('gmeet-iso'));
  assert.strictEqual(JSON.parse(get('Google Meet ISO/settings.json')).botName, 'gmeet-iso');
});
test('both old folders: GMeet ISO wins', ({ oldApp, run }) => {
  oldApp('gmeet-iso');
  oldApp();
  assert.ok(run().endsWith('GMeet ISO'));
});
test('interrupted copy starts again', ({ put, get, oldApp, run }) => {
  oldApp();
  put('Google Meet ISO/.copying/settings.json', 'half');
  put('Google Meet ISO/.copying/junk');
  run();
  assert.strictEqual(JSON.parse(get('Google Meet ISO/settings.json')).botName, 'GMeet ISO');
  assert.strictEqual(get('Google Meet ISO/junk'), null);
});
test('interrupted move is finished', ({ put, get, run }) => {
  put('Google Meet ISO/settings.json', 'moved');
  put('Google Meet ISO/.copied/Local State', 'rest');
  run();
  assert.strictEqual(get('Google Meet ISO/settings.json'), 'moved');
  assert.strictEqual(get('Google Meet ISO/Local State'), 'rest');
});
test('keeps the old recording folder when it exists', ({ dir, get, oldApp, run }) => {
  oldApp();
  fs.mkdirSync(path.join(dir, 'Videos', 'GMeet ISO'), { recursive: true });
  run();
  assert.strictEqual(JSON.parse(get('Google Meet ISO/settings.json')).recordDir, path.join(dir, 'Videos', 'GMeet ISO'));
  assert.strictEqual(JSON.parse(get('GMeet ISO/settings.json')).recordDir, undefined);
});
test('keeps a chosen recording folder', ({ dir, put, get, oldApp, run }) => {
  oldApp();
  put('GMeet ISO/settings.json', JSON.stringify({ recordDir: 'D:\\rec' }));
  fs.mkdirSync(path.join(dir, 'Videos', 'GMeet ISO'), { recursive: true });
  run();
  assert.strictEqual(JSON.parse(get('Google Meet ISO/settings.json')).recordDir, 'D:\\rec');
});
test('stops if the old app is running', ({ dir, put, get, oldApp, run }) => {
  oldApp();
  put('GMeet ISO/lockfile', '');
  fs.chmodSync(path.join(dir, 'GMeet ISO', 'lockfile'), 0o444); // refuses writes, like a held lock
  assert.throws(run, OldAppRunning);
  assert.strictEqual(get('Google Meet ISO/settings.json'), null);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `all ${n} passed`);
process.exit(failed ? 1 : 0);
