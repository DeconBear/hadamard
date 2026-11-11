#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
function run(command, args) {
  console.log('$ ' + [command, ...args].join(' '));
  execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

const hcanvasVersion = JSON.parse(readFileSync(path.join(root, 'hcanvas.version.json'), 'utf8')).version;
console.log('1/4 Building standalone Hcanvas installer (' + hcanvasVersion + ')');
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:hcanvas:installer']);
const canvasDir = path.join(root, 'dist_electron', 'canvas');
const setupFile = 'Hadamard-Canvas-Setup-' + hcanvasVersion + '.exe';
const setup = readdirSync(canvasDir).includes(setupFile) ? setupFile : undefined;
if (!setup) throw new Error('Hadamard Canvas 0.1.0 installer not found in ' + canvasDir);
mkdirSync(path.join(root, 'build-artifacts'), { recursive: true });
copyFileSync(path.join(canvasDir, setup), path.join(root, 'build-artifacts', 'hcanvas-setup.exe'));
console.log('Bundled component: ' + setup);

console.log('2/4 Preparing GUI runtime assets');
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'prepare:xterm']);

console.log('3/4 Building Hadamard');
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);

console.log('4/4 Building Hadamard suite installer (NSIS)');
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', '--config', 'electron-builder.hadamard-suite.cjs', '--win', 'nsis', '--x64', '--publish', 'never']);
console.log('Suite installer written to dist_electron/suite');
