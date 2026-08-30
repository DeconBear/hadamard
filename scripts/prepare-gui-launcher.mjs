// Windows dev launcher: copy electron.exe beside Electron's dist resources
// (icudtl.dat, resources/, …) and embed assets/hadamard-icon.ico. The icon
// fingerprint in the filename gives Explorer a fresh cache key after a brand
// icon update; Windows taskbar icons are otherwise sticky by executable path.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'win32') {
  process.exit(0);
}

const electronExe = require('electron');
const distDir = dirname(electronExe);
const iconIco = join(root, 'assets', 'hadamard-icon.ico');

if (!existsSync(iconIco)) {
  process.stderr.write('prepare-gui-launcher: missing assets/hadamard-icon.ico — run npm run generate:icon\n');
  process.exit(1);
}

const iconFingerprint = createHash('sha256').update(readFileSync(iconIco)).digest('hex').slice(0, 12);
const launcherName = `Hadamard-${iconFingerprint}.exe`;
const launcher = join(distDir, launcherName);

const sources = [electronExe, iconIco];
const stale = !existsSync(launcher)
  || sources.some((src) => statSync(src).mtimeMs > statSync(launcher).mtimeMs);

if (!stale) {
  process.stdout.write(`prepare-gui-launcher: up to date (${launcher})\n`);
  process.exit(0);
}

copyFileSync(electronExe, launcher);

let rcedit;
try {
  rcedit = require('rcedit');
} catch {
  process.stderr.write('prepare-gui-launcher: install rcedit (npm install -D rcedit)\n');
  process.exit(1);
}

await rcedit(launcher, {
  icon: iconIco,
  'product-version': '1.0.0',
  'version-string': {
    FileDescription: 'Hadamard',
    ProductName: 'Hadamard',
    CompanyName: 'Hadamard',
    OriginalFilename: launcherName,
    InternalName: 'Hadamard',
  },
});

process.stdout.write(`prepare-gui-launcher: wrote ${launcher}\n`);
