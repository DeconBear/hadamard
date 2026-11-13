#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const versionFile = path.join(root, 'hcanvas.version.json');
const packageFile = path.join(root, 'package.json');
const platformArgIndex = process.argv.indexOf('--platform');
const requestedPlatform = platformArgIndex >= 0 ? process.argv[platformArgIndex + 1] : undefined;
const hostPlatform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const platform = requestedPlatform || hostPlatform;
const targetsByPlatform = {
  win: { allowed: new Set(['portable', 'nsis']), defaults: ['portable', 'nsis'], flag: '--win' },
  linux: { allowed: new Set(['AppImage', 'deb']), defaults: ['AppImage', 'deb'], flag: '--linux' },
  mac: { allowed: new Set(['dmg', 'zip']), defaults: ['dmg', 'zip'], flag: '--mac' },
};
const platformConfig = targetsByPlatform[platform];
if (!platformConfig) {
  console.error('Unsupported Hcanvas platform: ' + platform + ' (expected win, linux or mac)');
  process.exit(1);
}
const rawArgs = process.argv.slice(2);
const cliArgs = rawArgs.filter((value, index) => value !== '--platform' && rawArgs[index - 1] !== '--platform');
const requestedTargets = cliArgs.filter(target => platformConfig.allowed.has(target));
const targets = requestedTargets.length ? requestedTargets : platformConfig.defaults;
const hcanvasVersion = JSON.parse(readFileSync(versionFile, 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(hcanvasVersion)) {
  console.error('Invalid hcanvas version: ' + hcanvasVersion);
  process.exit(1);
}

function run(command, args, extra = {}) {
  console.log('$ ' + [command, ...args].join(' '));
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...extra,
  });
}

console.log('Hcanvas version: ' + hcanvasVersion);
console.log('Target platform: ' + platform + ' (' + targets.join(', ') + ')');
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);

const originalPackage = readFileSync(packageFile, 'utf8');
const packageJson = JSON.parse(originalPackage);
try {
  packageJson.version = hcanvasVersion;
  writeFileSync(packageFile, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  const builderArgs = ['electron-builder', '--config', 'electron-builder.hcanvas.yml', platformConfig.flag, ...targets, '--publish', 'never'];
  if (platform === 'mac') builderArgs.push('--x64', '--arm64');
  else builderArgs.push('--x64');
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', builderArgs, {
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false' },
  });
} finally {
  writeFileSync(packageFile, originalPackage, 'utf8');
  console.log('Restored root package.json version.');
}
