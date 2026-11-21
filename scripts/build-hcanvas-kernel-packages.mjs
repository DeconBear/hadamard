#!/usr/bin/env node
/**
 * Build local @hcanvas/kernel-* npm packages from the bundled kernel extensions.
 *
 * This prepares reviewed package folders under build-artifacts/hcanvas-kernels
 * and packs them locally. Publishing (Trusted Publishing/OIDC, scope ownership,
 * provenance) remains a separate, externally authorized step; the defaults
 * here keep NPM distribution in Preview.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const outRoot = path.join(root, 'build-artifacts', 'hcanvas-kernels');
const version = JSON.parse(await readFile(path.join(root, 'hcanvas.version.json'), 'utf8')).version;
const NL = String.fromCharCode(10);
const kernels = [
  { id: 'com.hadamard.kernel-python', name: '@hcanvas/kernel-python' },
  { id: 'com.hadamard.kernel-cpp', name: '@hcanvas/kernel-cpp' },
  { id: 'com.hadamard.kernel-octave', name: '@hcanvas/kernel-octave' },
];

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });
for (const kernel of kernels) {
  const source = path.join(root, 'src', 'hcanvas', 'builtinExtensions', kernel.id);
  const target = path.join(outRoot, kernel.name.replace(/^@/, '').replace('/', '-'));
  await cp(source, target, { recursive: true });
  const manifestPath = path.join(target, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.builtin = false;
  manifest.engines = { hcanvas: '>=0.1.0' };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + NL, 'utf8');
  const packageJson = {
    name: kernel.name,
    version: manifest.version,
    description: manifest.description,
    license: 'MIT',
    type: 'module',
    keywords: ['hcanvas-extension', 'hcanvas', 'kernel'],
    files: ['manifest.json', 'sidecar', 'README.md', 'LICENSE'],
    repository: { type: 'git', url: 'git+https://github.com/DeconBear/hadamard.git' },
    engines: { node: '>=22.13.0' },
  };
  await writeFile(path.join(target, 'package.json'), JSON.stringify(packageJson, null, 2) + NL, 'utf8');
  await cp(path.join(root, 'LICENSE'), path.join(target, 'LICENSE'));
  if (!(await readdir(target)).includes('README.md')) await writeFile(path.join(target, 'README.md'), '# ' + manifest.name + NL + NL + 'Hcanvas language kernel extension.' + NL, 'utf8');
  const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', outRoot], { cwd: target, encoding: 'utf8', shell: process.platform === 'win32' });
  const start = packed.indexOf('[');
  const end = packed.lastIndexOf(']');
  const info = JSON.parse(packed.slice(start, end + 1))[0];
  console.log(kernel.name + ' -> ' + path.join(outRoot, info.filename));
}
console.log('Kernel packages prepared in ' + outRoot + ' (version ' + version + '). Publish remains a separate authorized step.');
