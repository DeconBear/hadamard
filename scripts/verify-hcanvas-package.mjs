#!/usr/bin/env node
/**
 * Clean-package acceptance test for Hcanvas.
 *
 * Packs the generated packages/hadamard-canvas staging directory, extracts the
 * tarball into a temp folder (outside the repo), starts its CLI server and
 * verifies the version file/health endpoint and extension installation route.
 *
 * Usage: node scripts/verify-hcanvas-package.mjs [--no-build]
 */
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const skipBuild = process.argv.includes('--no-build');
const version = JSON.parse(await readFile(path.join(root, 'hcanvas.version.json'), 'utf8')).version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd || root, encoding: 'utf8', timeout: 600000, shell: process.platform === 'win32' && command === 'npm', ...options });
  if (result.status !== 0) throw new Error(command + ' ' + args.join(' ') + ' failed: ' + String(result.stderr || result.stdout || result.error));
  return result;
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-package-'));
  let server;
  try {
    if (!skipBuild) {
      console.log('Building Hcanvas package...');
      run('npm', ['run', 'build:hcanvas:package']);
    }
    const packageDir = path.join(root, 'packages', 'hadamard-canvas');
    const pack = run('npm', ['pack', '--json', '--pack-destination', temp], { cwd: packageDir });
    const rawPack = pack.stdout.trim();
    const start = rawPack.indexOf('[');
    const end = rawPack.lastIndexOf(']');
    const packJson = JSON.parse(rawPack.slice(start, end + 1));
    const packed = Array.isArray(packJson) ? packJson[0] : packJson;
    if (!packed?.filename) throw new Error('npm pack did not report a tarball filename');
    const tarball = path.join(temp, packed.filename);
    const extracted = path.join(temp, 'unpacked');
    await mkdir(extracted, { recursive: true });
    run('tar', ['-xzf', tarball, '-C', extracted]);
    const packageRoot = path.join(extracted, 'package');
    console.log('Installing packaged runtime dependencies...');
    run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: packageRoot });
    const packagedEntries = await readdir(packageRoot, { recursive: true });
    for (const forbidden of ['plan', 'tests', '.git', 'bench']) {
      if (packagedEntries.some(entry => String(entry).replace(/\\\\/g, '/').startsWith(forbidden + '/') || String(entry).replace(/\\\\/g, '/') === forbidden)) {
        throw new Error('packaged tarball unexpectedly contains private directory: ' + forbidden);
      }
    }
    const versionFile = path.join(packageRoot, 'hcanvas.version.json');
    const packagedVersion = JSON.parse(await readFile(versionFile, 'utf8')).version;
    if (packagedVersion !== version) throw new Error('packaged hcanvas.version.json mismatch: ' + packagedVersion + ' !== ' + version);
    for (const required of ['bin/hcanvas.js', 'dist/src/hcanvas/server.js', 'dist/hcanvas/index.html']) {
      await readFile(path.join(packageRoot, required));
    }
    const workspace = path.join(temp, 'workspace');
    const home = path.join(temp, 'home');
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    server = spawn(process.execPath, [path.join(packageRoot, 'bin', 'hcanvas.js'), 'serve', '--workspace', workspace, '--port', '0'], {
      cwd: packageRoot,
      env: { ...process.env, HCANVAS_CONFIG_HOME: path.join(home, 'config'), HCANVAS_HOME: home, HADAMARD_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let serverError = '';
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('packaged server did not start: ' + output + serverError)), 20000);
      server.stdout.on('data', chunk => {
        output += String(chunk);
        for (const line of output.split(/\r?\n/)) {
          try {
            const value = JSON.parse(line);
            if (value.url && value.token) { clearTimeout(timer); resolve(value); return; }
          } catch { /* wait for the startup JSON */ }
        }
      });
      server.stderr.on('data', chunk => { serverError += String(chunk); });
      server.once('error', reject);
      server.once('exit', code => reject(new Error('packaged server exited ' + code + ': ' + output + serverError)));
    });
    const base = String(info.url).replace(/\/$/, '');
    const health = await fetch(base + '/api/health', { headers: { 'x-hcanvas-token': info.token } }).then(response => response.json());
    if (health.version !== version) throw new Error('health version mismatch: ' + health.version + ' !== ' + version);
    const gallery = await fetch(base + '/api/extensions/gallery', { headers: { 'x-hcanvas-token': info.token } }).then(response => response.json());
    const bundledKernels = (gallery.entries || []).filter(entry => entry.kind === 'bundled' && String(entry.id).startsWith('com.hadamard.kernel-'));
    if (bundledKernels.length < 3) throw new Error('packaged Gallery is missing bundled kernels: ' + JSON.stringify(gallery.entries || []));
    const extensionDir = path.join(temp, 'extension');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify({
      schema: 'hcanvas-extension/1', id: 'com.example.package-smoke', name: 'Package smoke', version: '0.1.0', engines: { hcanvas: '>=0.1.0' },
      capabilities: {}, contributes: { commands: [{ id: 'package.smoke', title: 'Package smoke' }] },
    }), 'utf8');
    const install = await fetch(base + '/api/extensions/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hcanvas-token': info.token },
      body: JSON.stringify({ source: 'folder', path: extensionDir, scope: 'workspace' }),
    }).then(response => response.json());
    if (!install.ok || install.id !== 'com.example.package-smoke') throw new Error('packaged extension install failed: ' + JSON.stringify(install));
    console.log(JSON.stringify({ ok: true, version, tarball: packed.filename, files: (await readdir(packageRoot)).length, health: health.version, extension: install.id }, null, 2));
  } finally {
    if (server) server.kill();
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

try { await main(); } catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
