// Native sender checks: zero-copy sendVideoOwned() hands buffers back, the cadence clock repeats
// the last frame (freeze), and frames arrive intact at a receiver.
//   node scripts/test-sender.js
const path = require('path');
const assert = require('assert');

const mod = require(path.join(__dirname, '..', 'build', 'Release', 'gmeet_iso_ndi.node'));
const st = mod.load();
if (!st.ok) throw new Error(st.error);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 640;
const H = 360;

function frame(v) {
  // UYVY, all pixels (U,Y,V,Y) = (128, v, 128, v)
  const b = new ArrayBuffer((W / 2) * 4 * H);
  const u8 = new Uint8Array(b);
  for (let i = 0; i < u8.length; i += 4) {
    u8[i] = 128;
    u8[i + 1] = v;
    u8[i + 2] = 128;
    u8[i + 3] = v;
  }
  return b;
}

(async () => {
  const name = `SENDERTEST ${process.pid}`;
  const s = new mod.Sender(name, { idleMs: 0 });
  assert.strictEqual(typeof s.sendVideoOwned, 'function', 'addon lacks sendVideoOwned (rebuild with npm run build:native)');

  // 1) Owned buffers come back once the worker is done with them.
  const sent = new Set();
  const back = new Set();
  for (let i = 0; i < 20; i++) {
    const b = frame(16 + i * 10);
    sent.add(b);
    for (const r of s.sendVideoOwned(b, W, H, 'UYVY', W * 2)) back.add(r);
    await sleep(20);
  }
  await sleep(100);
  for (const r of s.reclaim()) back.add(r);
  for (const r of back) assert(sent.has(r), 'returned buffer was never sent');
  // At most the last frame (kept for repeats) may still be held.
  assert(back.size >= sent.size - 1, `only ${back.size}/${sent.size} buffers returned`);
  console.log(`owned: ${back.size}/${sent.size} buffers returned`);

  // 2) Receiver sees the last frame, and the cadence clock keeps repeating it (freeze).
  const finder = new mod.Finder();
  let full = '';
  for (let i = 0; i < 50 && !full; i++) {
    await sleep(100);
    full = finder.sources().find((x) => x.endsWith(`(${name})`)) ?? '';
  }
  assert(full, 'sender not discovered');
  const rx = new mod.Receiver(full);
  await sleep(500);
  const before = s.stats().sent;
  s.setCadence(10, 1);
  await sleep(1500);
  const repeats = s.stats().sent - before;
  assert(repeats >= 10, `cadence repeated only ${repeats} frames`);
  let f = null;
  for (let i = 0; i < 40 && !f; i++) {
    await sleep(50);
    f = rx.read();
  }
  assert(f, 'receiver got no frame');
  const px = new Uint8Array(f.data);
  // Y=206 limited → about 220 full-range grey in BGRA
  assert(Math.abs(px[0] - px[1]) < 4 && px[0] > 190, `unexpected pixel ${px.slice(0, 4)}`);
  console.log(`cadence: ${repeats} repeats in 1.5 s; receiver pixel ${Array.from(px.slice(0, 4))}`);

  // 3) UYVY receive into a reused buffer: no allocation, exact bytes, "too small" handshake.
  const rx2 = new mod.Receiver(full, { format: 'UYVY' });
  s.setCadence(30, 1);
  let small = rx2.readInto(new ArrayBuffer(16));
  for (let i = 0; i < 60 && !small; i++) {
    await sleep(50);
    small = rx2.readInto(new ArrayBuffer(16));
  }
  assert(small && small.bytes === 0 && small.needed === (W / 2) * 4 * H, `too-small handshake: ${JSON.stringify(small)}`);
  const ubuf = new ArrayBuffer(small.needed);
  let u = rx2.readInto(ubuf);
  for (let i = 0; i < 40 && !u; i++) {
    await sleep(50);
    u = rx2.readInto(ubuf);
  }
  assert(u && u.format === 'UYVY' && u.bytes === ubuf.byteLength, `readInto: ${JSON.stringify(u)}`);
  const ub = new Uint8Array(ubuf);
  assert(Math.abs(ub[0] - 128) <= 2 && Math.abs(ub[1] - 206) <= 2, `UYVY bytes ${Array.from(ub.slice(0, 4))}`);
  console.log(`receiver: UYVY ${u.width}x${u.height} into reused buffer, bytes ${Array.from(ub.slice(0, 4))}`);
  rx2.destroy();

  // 4) Copy-mode sendVideo still works alongside.
  assert.strictEqual(s.sendVideo(new Uint8Array(frame(100)), W, H, 'UYVY', W * 2), true);
  rx.destroy();
  finder.destroy();
  s.destroy();
  console.log('OK');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
