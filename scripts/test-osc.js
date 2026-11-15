// Unit-style tests for the OSC codec + ZoomOSC/ZoomISO router (no Electron, no network).
//   node scripts/test-osc.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');

const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'osc-test-'));
for (const [entry, name] of [['src/main/osc/router.ts', 'router.js'], ['src/main/osc.ts', 'osc.js'], ['src/shared/oscSupport.ts', 'support.js']]) {
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', entry)], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(outDir, name), logLevel: 'error' });
}
const { OscRouter, parseAddress } = require(path.join(outDir, 'router.js'));
const { encode, decode } = require(path.join(outDir, 'osc.js'));
const { OSC_SUPPORT, OSC_SUPPORTED } = require(path.join(outDir, 'support.js'));

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- fixtures ----
const P = (key, name, extra = {}) => ({ key, participantId: key, displayName: name, kind: 'camera', isSelf: false, hasVideo: true, width: 0, height: 0, fps: 0, muted: false, handRaised: false, level: 0, speaking: false, outputs: [], ...extra });
function fixture() {
  const settings = {
    engine: 'standby',
    lastMeetUrl: '',
    embeddedAudio: { defaultMode: 'iso' },
    osc: { prepend: '/gmeetosc', subscribeMode: 'all', disabledCommands: [], enableAllowList: false, allowList: [] },
    outputs: [
      { id: 'o1', name: 'GMEET 1', enabled: true, mode: 'participant', selection: { key: 'b', name: 'Bob' }, format: null, audio: 'iso' },
      { id: 'o2', name: 'GMEET 2', enabled: false, mode: 'activeSpeaker', selection: null, format: { width: 1920, height: 1080 }, audio: 'mix' },
    ],
  };
  const state = {
    phase: 'in-call',
    inCall: true,
    camOn: true,
    micOn: true,
    activeSpeaker: 'b',
    waiting: ['Lobby Larry'],
    outputs: [{ id: 'o1', sourceKey: 'b', status: 'live', outWidth: 1280, outHeight: 720 }],
    participants: [P('me', 'GMeet Bot', { isSelf: true }), P('a', 'Alice', { isHost: true }), P('b', 'Bob', { outputs: ['o1'], level: 0.5 }), { ...P('b:screen', 'Bob (screen)'), kind: 'screen' }],
  };
  const execd = [];
  const sent = [];
  const logs = [];
  const ctx = {
    settings: () => settings,
    state: () => state,
    exec: async (c) => {
      execd.push(c);
      if (c.cmd === 'setOscSubscribe') settings.osc.subscribeMode = c.mode;
    },
    send: (a, args) => sent.push([a, args]),
    log: (s) => logs.push(s),
    version: '0.1.0-test',
  };
  const r = new OscRouter(ctx);
  const replies = [];
  const call = async (address, ...args) => {
    replies.length = 0;
    const handled = await r.handle({ address, args }, (a, x) => replies.push([a, x]), { address: '127.0.0.1' });
    return handled;
  };
  return { r, settings, state, execd, sent, replies, call, logs };
}

// ---- codec ----
test('encode/decode round trip', () => {
  const b = encode('/zoom/userName/pin', ['Bob', 3, 1.5, true]);
  const [m] = decode(b);
  assert.strictEqual(m.address, '/zoom/userName/pin');
  assert.deepStrictEqual(m.args.slice(0, 2), ['Bob', 3]);
  assert.ok(Math.abs(m.args[2] - 1.5) < 1e-6);
  assert.strictEqual(m.args[3], true);
});
test('bundle decode', () => {
  const a = encode('/zoom/ping', []);
  const c = encode('/zoom/list', []);
  const sz = (x) => { const s = Buffer.alloc(4); s.writeInt32BE(x.length); return s; };
  const bundle = Buffer.concat([Buffer.from('#bundle\0'), Buffer.alloc(8), sz(a), a, sz(c), c]);
  assert.deepStrictEqual(decode(bundle).map((m) => m.address), ['/zoom/ping', '/zoom/list']);
});

// ---- address parsing ----
test('parse prefixes and targets', () => {
  assert.strictEqual(parseAddress('/foo/ping'), null);
  assert.deepStrictEqual(parseAddress('/zoomosc/ping'), { family: 'zoomosc', cmd: 'ping', target: null });
  assert.deepStrictEqual(parseAddress('/zoom/userName/pin').target, { kind: 'username' });
  assert.deepStrictEqual(parseAddress('/gmeet/galIndex/outputISO').target, { kind: 'galleryindex' });
  assert.deepStrictEqual(parseAddress('/zoom/users/zoomID/addSpot').target, { kind: 'zoomid', multi: true });
  assert.deepStrictEqual(parseAddress('/zoom/allExcept/userName/videoOff').target, { kind: 'username', except: true });
  assert.deepStrictEqual(parseAddress('/zoom/allExcept/me/mute').target, { group: 'me', except: true });
  assert.deepStrictEqual(parseAddress('/zoom/me/raiseHand').target, { group: 'me' });
  assert.deepStrictEqual(parseAddress('/zoom/all/mute'), { family: 'zoom', cmd: 'all/mute', target: null });
  assert.deepStrictEqual(parseAddress('/zoom/all/lowerHand').target, { group: 'all' });
});

// ---- commands ----
test('ping → pong (ZoomISO fields)', async () => {
  const f = fixture();
  await f.call('/zoom/ping', 'hi');
  assert.deepStrictEqual(f.replies[0], ['/zoomosc/pong', ['hi', '0.1.0-test', 2, 1, 1, 2, 3, 1]]);
});
test('gmeet prefix uses /gmeetosc header + ok', async () => {
  const f = fixture();
  await f.call('/gmeet/ping');
  assert.strictEqual(f.replies[0][0], '/gmeetosc/pong');
  assert.strictEqual(f.replies[0][1][0], 0);
  assert.deepStrictEqual(f.replies[1], ['/gmeetosc/ok', ['/gmeet/ping']]);
});
test('custom header (prepend) wins', async () => {
  const f = fixture();
  f.settings.osc.prepend = '/studioA';
  await f.call('/zoom/getEngineState');
  assert.deepStrictEqual(f.replies[0], ['/studioA/engineState', [1]]);
});
test('targets: userName / galleryIndex / zoomID / me / all', async () => {
  const f = fixture();
  await f.call('/zoom/userName/pin', 'Alice');
  await f.call('/zoom/galleryIndex/spot', 2);
  const bobId = f.r.zoomId(f.state.participants[2]);
  await f.call('/zoom/zoomID/mute', bobId);
  await f.call('/zoom/me/mute');
  await f.call('/zoom/me/videoOff');
  await f.call('/zoom/me/raiseHand');
  await f.call('/zoom/all/lowerHand');
  assert.deepStrictEqual(f.execd, [
    { cmd: 'pin', participant: 'a', on: true },
    { cmd: 'spotlight', participant: 'b', on: true },
    { cmd: 'muteParticipant', participant: 'b' },
    { cmd: 'setMic', on: false },
    { cmd: 'setCam', on: false },
    { cmd: 'raiseHand', on: true },
    { cmd: 'raiseHand', on: false },
    { cmd: 'lowerHand', participant: 'a' },
    { cmd: 'lowerHand', participant: 'b' },
  ]);
});
test('users/* multi-target and allExcept', async () => {
  const f = fixture();
  await f.call('/zoom/users/userName/unPin', 'Alice', 'Bob');
  await f.call('/zoom/allExcept/userName/eject', 'Alice');
  assert.deepStrictEqual(f.execd, [
    { cmd: 'pin', participant: 'a', on: false },
    { cmd: 'pin', participant: 'b', on: false },
    { cmd: 'removeParticipant', participant: 'b' },
  ]);
});
test('Meet limits produce oscErrors', async () => {
  const f = fixture();
  await f.call('/zoom/userName/unMute', 'Alice');
  assert.match(f.replies[0][1][0], /only works on "me"/);
  await f.call('/zoom/createBreakout', 'Room 1');
  assert.strictEqual(f.replies[0][0], '/zoomosc/oscErrors');
  assert.match(f.replies[0][1][0], /not supported in Google Meet/);
  await f.call('/zoom/userName/chat', 'Alice', 'hi');
  assert.match(f.replies[0][1][0], /no private chat/);
  assert.strictEqual(f.execd.length, 0);
});
test('outputISO by userName / galIndex', async () => {
  const f = fixture();
  await f.call('/zoom/userName/outputISO', 'Alice', 2);
  await f.call('/gmeet/galIndex/outputISO', 2, 'GMEET 1');
  assert.deepStrictEqual(f.execd, [
    { cmd: 'route', output: 2, participant: 'a' },
    { cmd: 'route', output: 'GMEET 1', participant: 'b' },
  ]);
});
test('output settings controls', async () => {
  const f = fixture();
  await f.call('/zoom/setOutputCount', 4);
  await f.call('/zoom/enableOutput', 'GMEET 2');
  await f.call('/zoom/setOutputMode', 1, 5);
  await f.call('/zoom/setOutputMode', 2, 'Active Speaker');
  await f.call('/zoom/setOutputEmbeddedAudio', 1, 2);
  await f.call('/zoom/setOutputName', 1, 'Host Cam');
  await f.call('/zoom/setVideoLossMode', 5);
  await f.call('/zoom/setOutputSelection', 1, 0);
  await f.call('/zoom/setOutputSelection', 1, 1);
  await f.call('/zoom/setOutputSelection', 1, 2); // first non-self row = Alice
  await f.call('/zoom/startISOEngine');
  await f.call('/zoom/startLocalRecording');
  assert.deepStrictEqual(f.execd, [
    { cmd: 'setOutputCount', count: 4 },
    { cmd: 'updateOutput', output: 'GMEET 2', patch: { enabled: true } },
    { cmd: 'updateOutput', output: 1, patch: { mode: 'screenshare' } },
    { cmd: 'updateOutput', output: 2, patch: { mode: 'activeSpeaker' } },
    { cmd: 'updateOutput', output: 1, patch: { audio: 'mix', useDefaultAudioMode: false } },
    { cmd: 'updateOutput', output: 1, patch: { name: 'Host Cam' } },
    { cmd: 'setVideoLoss', patch: { mode: 'testcard' } },
    { cmd: 'route', output: 1, participant: null },
    { cmd: 'updateOutput', output: 1, patch: { mode: 'auto', selection: null, isAutoAssign: true } },
    { cmd: 'route', output: 1, participant: 'a' },
    { cmd: 'engine', state: 'enabled' },
    { cmd: 'startRecording', outputs: undefined },
  ]);
});
test('getOutputRouting / getAudioLevels', async () => {
  const f = fixture();
  await f.call('/zoom/getOutputRouting');
  const bob = f.r.zoomId(f.state.participants[2]);
  assert.deepStrictEqual(f.replies, [
    ['/zoomosc/outputRouting', [2, 1, 1, 'GMEET 1', 'Participant', bob, '1280x720', 'ISO', 'live']],
    ['/zoomosc/outputRouting', [2, 2, 0, 'GMEET 2', 'Active Speaker', 0, '1920x1080', 'Mix', 'off']],
  ]);
  await f.call('/zoom/getAudioLevels');
  assert.deepStrictEqual(f.replies, [['/zoomosc/audioLevels', [1, 128]], ['/zoomosc/audioLevels', [2, 0]]]);
});
test('list / gallery / waiting room', async () => {
  const f = fixture();
  await f.call('/zoom/list');
  assert.strictEqual(f.replies[0][0], '/zoomosc/listCleared');
  assert.strictEqual(f.replies.length, 4); // cleared + me + Alice + Bob (screen feed excluded)
  assert.strictEqual(f.replies[1][0], '/zoomosc/me/list');
  const bob = f.replies[3][1];
  assert.deepStrictEqual(bob.slice(0, 3), [1, 'Bob', 2]);
  assert.deepStrictEqual(bob.slice(4), [1, 3, 5, 1, 1, 1, 0]);
  assert.strictEqual(f.replies[2][1][6], 1, 'Alice is host');
  await f.call('/zoom/galleryCount');
  assert.deepStrictEqual(f.replies, [['/zoomosc/galleryCount', [3]]]);
  await f.call('/zoom/galTrackMode', 0);
  await f.call('/zoom/getGalleryOrder');
  assert.deepStrictEqual(f.replies, [['/zoomosc/galleryOrder', ['me', 'a', 'b']]]);
  await f.call('/zoom/listWaitingRoomUsers');
  assert.deepStrictEqual(f.replies, [['/zoomosc/waitingRoomUserList', [0, 1, 0, 'Lobby Larry', 'Lobby Larry']]]);
});
test('subscribe mode filters list', async () => {
  const f = fixture();
  await f.call('/zoom/subscribe', 1); // targetList = people on outputs
  assert.strictEqual(f.settings.osc.subscribeMode, 'targetList');
  await f.call('/zoom/list');
  assert.deepStrictEqual(f.replies.slice(1).map((r) => r[1][1]), ['Bob']);
  await f.call('/zoom/subscribe', 0);
  await f.call('/zoom/list');
  assert.strictEqual(f.replies.length, 1);
});
test('subscription events from state diffs', async () => {
  const f = fixture();
  await f.call('/zoom/ping'); // switch header to /zoomosc
  f.r.onState(f.state);
  const next = JSON.parse(JSON.stringify(f.state));
  next.participants[1].hasVideo = false;
  next.participants[1].handRaised = true;
  next.participants[2].muted = true;
  next.participants[2].displayName = 'Robert';
  next.participants.push(P('c', 'Carol'));
  next.waiting = [];
  next.activeSpeaker = 'a';
  f.r.onState(next);
  const addrs = f.sent.map((s) => s[0]);
  for (const a of ['/zoomosc/user/videoOff', '/zoomosc/user/handRaised', '/zoomosc/user/mute', '/zoomosc/user/userNameChanged', '/zoomosc/user/online', '/zoomosc/user/leftWaitingRoom', '/zoomosc/user/activeSpeaker', '/zoomosc/galleryOrder'])
    assert.ok(addrs.includes(a), `missing ${a} in ${addrs.join(',')}`);
  const rn = f.sent.find((s) => s[0] === '/zoomosc/user/userNameChanged');
  assert.deepStrictEqual(rn[1].slice(1), ['Robert', 2, f.r.zoomId('b'), 'Bob']);
  f.sent.length = 0;
  f.settings.osc.subscribeMode = 'none';
  const n2 = JSON.parse(JSON.stringify(next));
  n2.participants[1].hasVideo = true;
  f.r.onState(n2);
  assert.strictEqual(f.sent.length, 0);
});
test('disabled commands + allow list', async () => {
  const f = fixture();
  f.settings.osc.disabledCommands = ['/zoom/pin'];
  assert.strictEqual(await f.call('/zoom/userName/pin', 'Alice'), true);
  assert.strictEqual(f.execd.length, 0);
  f.settings.osc.enableAllowList = true;
  f.settings.osc.allowList = ['10.0.0.9'];
  await f.call('/zoom/ping');
  assert.strictEqual(f.replies.length, 0);
});
test('unknown legacy /gmeet commands fall through', async () => {
  const f = fixture();
  assert.strictEqual(await f.call('/gmeet/saveShow', 'x.gmiso'), false);
  assert.strictEqual(await f.call('/other/ping'), false);
});
test('support table', () => {
  assert.strictEqual(OSC_SUPPORT.length, 278);
  assert.strictEqual(OSC_SUPPORTED.pin, true);
  assert.strictEqual(OSC_SUPPORTED.createbreakout, false);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      console.log(`ok   ${name}`);
    } catch (e) {
      console.log(`FAIL ${name}\n     ${e.message}`);
    }
  }
  const sup = OSC_SUPPORT.filter((e) => e.supported).length;
  console.log(`\n${pass}/${tests.length} passed · catalogue coverage ${sup}/${OSC_SUPPORT.length} supported`);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(pass === tests.length ? 0 : 1);
})();
