// Rasterizes static/icon.svg into PNGs + a multi-size Windows .ico using Electron's renderer.
// Usage: npx electron scripts/build-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'static', 'icon.svg'), 'utf8');
const outDir = path.join(root, 'static', 'icons');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

function buildIco(pngs) {
  // ICO container with PNG-compressed entries (supported since Windows Vista).
  const entries = pngs.filter((p) => p.size <= 256);
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((p, i) => {
    const o = 6 + 16 * i;
    header.writeUInt8(p.size >= 256 ? 0 : p.size, o);
    header.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
    header.writeUInt8(0, o + 2);
    header.writeUInt8(0, o + 3);
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(p.data.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += p.data.length;
  });
  return Buffer.concat([header, ...entries.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const pngs = [];
  const htmlPath = path.join(outDir, '_render.html');
  void svg;
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  for (const size of SIZES) {
    fs.writeFileSync(
      htmlPath,
      `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">` +
        `<img src="../icon.svg" width="${size}" height="${size}" style="display:block"></body></html>`,
    );
    win.setContentSize(Math.max(size, 64), Math.max(size, 64));
    await win.loadFile(htmlPath);
    await new Promise((r) => setTimeout(r, 200));
    let img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    if (img.getSize().width !== size) img = img.resize({ width: size, height: size, quality: 'best' });
    const data = img.toPNG();
    fs.writeFileSync(path.join(outDir, `icon-${size}.png`), data);
    pngs.push({ size, data });
  }
  fs.unlinkSync(htmlPath);
  win.destroy();
  fs.copyFileSync(path.join(outDir, 'icon-512.png'), path.join(root, 'static', 'icon.png'));
  fs.writeFileSync(path.join(root, 'static', 'icon.ico'), buildIco(pngs));
  console.log(`wrote ${SIZES.length} PNGs, static/icon.png, static/icon.ico`);
  app.quit();
});
