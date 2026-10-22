// Renders assets/icon.svg to a 1024px PNG with Electron, then builds assets/icon.icns with the
// macOS sips and iconutil tools. Run: npx electron scripts/make-app-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const ICNS = path.join(ROOT, 'assets', 'icon.icns');
const SIZES = [16, 32, 128, 256, 512]; // each also gets an @2x variant

app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent">${fs.readFileSync(SVG, 'utf8')}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the first frame paint
  const png = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024 }).toPNG();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-icon-'));
  try {
    const master = path.join(dir, 'icon-1024.png');
    const set = path.join(dir, 'icon.iconset');
    fs.writeFileSync(master, png);
    fs.mkdirSync(set);
    const sips = (size, name) => execFileSync('sips', ['-z', String(size), String(size), master, '--out', path.join(set, name)], { stdio: 'ignore' });
    for (const s of SIZES) {
      sips(s, `icon_${s}x${s}.png`);
      sips(s * 2, `icon_${s}x${s}@2x.png`);
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', ICNS]);
    if (process.env.ICON_PREVIEW) fs.copyFileSync(master, process.env.ICON_PREVIEW);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`wrote ${path.relative(ROOT, ICNS)}`);
  app.quit();
});
