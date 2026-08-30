#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const main = fileURLToPath(new URL('../dist/src/gui/electronMain.js', import.meta.url));
const prepareLauncher = fileURLToPath(new URL('../scripts/prepare-gui-launcher.mjs', import.meta.url));

function resolveElectronExecutable() {
  const electronExe = require('electron');
  if (process.platform === 'win32') {
    const brandedLauncher = join(dirname(electronExe), 'Hadamard.exe');
    const prep = spawnSync(process.execPath, [prepareLauncher], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (prep.status !== 0) {
      process.stderr.write(
        'Hadamard: branded launcher could not be refreshed; taskbar may show a stale or Electron icon.\n',
      );
    }
    if (existsSync(brandedLauncher)) return brandedLauncher;
  }
  return electronExe;
}

const electron = resolveElectronExecutable();
const windowsGuiLaunch = process.platform === 'win32';

const child = spawn(electron, [main, ...process.argv.slice(2)], {
  stdio: windowsGuiLaunch ? 'ignore' : 'inherit',
  env: {
    ...process.env,
    HADAMARD_GUI_ROOT: rootDir,
    HADAMARD_GUI_DEVELOPMENT: '1',
  },
  windowsHide: windowsGuiLaunch,
  detached: windowsGuiLaunch,
});

if (windowsGuiLaunch) {
  // The Windows desktop app owns its own lifetime. Detach the GUI so the
  // Node launcher can exit immediately without leaving a console window.
  child.unref();
} else {
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

child.on('error', (error) => {
  console.error('Failed to start hadamard-gui:', error);
  process.exit(1);
});
