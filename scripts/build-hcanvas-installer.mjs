#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const versionFile = path.join(root, 'hcanvas.version.json');
const packageFile = path.join(root, 'package.json');
const allowedTargets = new Set(['portable', 'nsis']);
const requested = process.argv.slice(2).filter(target => allowedTargets.has(target));
const targets = requested.length ? requested : ['portable', 'nsis'];
const hcanvasVersion = JSON.parse(readFileSync(versionFile, 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(hcanvasVersion)) {
  console.error('Invalid hcanvas version: ' + hcanvasVersion);
  process.exit(1);
}

function run(command, args) {
  console.log('$ ' + [command, ...args].join(' '));
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

console.log('Hcanvas version: ' + hcanvasVersion);
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);

const originalPackage = readFileSync(packageFile, 'utf8');
const packageJson = JSON.parse(originalPackage);
try {
  packageJson.version = hcanvasVersion;
  writeFileSync(packageFile, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
    'electron-builder',
    '--config',
    'electron-builder.hcanvas.yml',
    '--win',
    ...targets,
    '--x64',
  ]);
} finally {
  writeFileSync(packageFile, originalPackage, 'utf8');
  console.log('Restored root package.json version.');
}
