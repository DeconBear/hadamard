#!/usr/bin/env node
/**
 * Validate locally built @hcanvas/kernel-* package tarballs.
 *
 * Runs build:hcanvas:kernels, extracts each tarball into a temp folder and
 * checks the published manifest/package version contract, keywords, file
 * layout and reserved ID. Publishing remains an external authorized step.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const outRoot = path.join(root, 'build-artifacts', 'hcanvas-kernels');
execFileSync('npm', ['run', 'build:hcanvas:kernels'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
const tarballs = (await readdir(outRoot)).filter(name => name.endsWith('.tgz')).sort();
if (tarballs.length !== 3) throw new Error('expected 3 kernel tarballs, found ' + tarballs.length);
const temp = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-kernel-check-'));
try {
  const results = [];
  for (const name of tarballs) {
    const folder = path.join(temp, name.replace(/\.tgz$/, ''));
    await mkdir(folder, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(outRoot, name), '-C', folder], { stdio: 'pipe' });
    const packageRoot = path.join(folder, 'package');
    const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'manifest.json'), 'utf8'));
    if (pkg.version !== manifest.version) throw new Error(name + ': package/manifest version mismatch');
    if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes('hcanvas-extension')) throw new Error(name + ': missing hcanvas-extension keyword');
    if (!String(pkg.name).startsWith('@hcanvas/kernel-')) throw new Error(name + ': unexpected package name ' + pkg.name);
    if (!/^(?:hcanvas|com\.hadamard)\./.test(manifest.id)) throw new Error(name + ': unexpected extension id ' + manifest.id);
    if (manifest.builtin !== false) throw new Error(name + ': published package must not be marked builtin');
    const files = await readdir(packageRoot, { recursive: true });
    for (const required of ['package.json', 'manifest.json', 'README.md', 'LICENSE']) {
      if (!files.map(String).includes(required)) throw new Error(name + ': missing ' + required);
    }
    if (!files.some(file => /sidecar[\\/](?:.*\.(?:mjs|py))$/.test(String(file)))) throw new Error(name + ': missing sidecar source');
    results.push({ package: pkg.name, version: pkg.version, id: manifest.id, files: files.length, bytes: (await stat(path.join(outRoot, name))).size });
  }
  console.log(JSON.stringify({ ok: true, packages: results }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true }).catch(() => undefined);
}
