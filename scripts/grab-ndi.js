// Grab one frame from each matching NDI source and save it as a BMP (visual checks of outputs).
//   node scripts/grab-ndi.js <name-substring> [outDir]
const fs = require('fs');
const path = require('path');

const mod = require(path.join(__dirname, '..', 'build', 'Release', 'gmeet_iso_ndi.node'));
const st = mod.load();
if (!st.ok) throw new Error(st.error);
const match = process.argv[2] ?? 'GMEET';
const outDir = process.argv[3] ?? path.join(__dirname, '..', 'tmp', 'grab');
fs.mkdirSync(outDir, { recursive: true });

function bmp(f) {
  const { width: w, height: h } = f;
  const row = w * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(-h, 22); // top-down
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(32, 28);
  buf.writeUInt32LE(row * h, 34);
  Buffer.from(f.data).copy(buf, 54);
  return buf;
}

(async () => {
  const finder = new mod.Finder();
  let names = [];
  for (let i = 0; i < 50 && !names.length; i++) {
    await new Promise((r) => setTimeout(r, 200));
    names = finder.sources().filter((s) => s.includes(match));
  }
  if (!names.length) throw new Error(`no NDI source matching "${match}"`);
  for (const name of names.sort()) {
    const rx = new mod.Receiver(name);
    let f = null;
    for (let i = 0; i < 100 && !f; i++) {
      await new Promise((r) => setTimeout(r, 50));
      f = rx.read();
    }
    // skip a few frames so the grab is from steady state
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 40));
      f = rx.read() ?? f;
    }
    rx.destroy();
    if (!f) {
      console.log(`${name}: no frame`);
      continue;
    }
    const file = path.join(outDir, `${name.replace(/[^\w]+/g, '_')}.bmp`);
    fs.writeFileSync(file, bmp(f));
    console.log(`${name}: ${f.width}x${f.height} ${f.format} → ${file}`);
  }
  finder.destroy();
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
