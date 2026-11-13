import { cp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const staging = path.join(root, 'packages', 'hadamard-canvas');

async function main() {
  // Ensure fresh build
  console.log('Building Hcanvas...');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });

  // Clean generated staging outputs, but keep the tracked package source files
  // (package.json / npm-README.md) so the script can be run repeatedly.
  console.log('Staging package...');
  for (const name of ['bin', 'dist', 'assets', 'README.md']) {
    await rm(path.join(staging, name), { recursive: true, force: true });
  }
  for (const name of await readdir(staging).catch(() => [])) {
    if (name.endsWith('.tgz')) await rm(path.join(staging, name), { force: true });
  }
  await mkdir(path.join(staging, 'bin'), { recursive: true });

  // Copy bin scripts
  await cp(path.join(root, 'bin', 'hcanvas.js'), path.join(staging, 'bin', 'hcanvas.js'));
  await cp(path.join(root, 'bin', 'hcanvas-desktop.js'), path.join(staging, 'bin', 'hcanvas-desktop.js'));

  // Copy compiled server code
  await cp(path.join(root, 'dist', 'src', 'hcanvas'), path.join(staging, 'dist', 'src', 'hcanvas'), { recursive: true });
  await cp(path.join(root, 'dist', 'src', 'canvas'), path.join(staging, 'dist', 'src', 'canvas'), { recursive: true });

  // Copy static UI
  await cp(path.join(root, 'dist', 'hcanvas'), path.join(staging, 'dist', 'hcanvas'), { recursive: true });

  // Copy app icons
  await mkdir(path.join(staging, 'assets'), { recursive: true });
  for (const icon of ['hcanvas-icon.ico', 'hcanvas-icon.png']) {
    await cp(path.join(root, 'assets', icon), path.join(staging, 'assets', icon)).catch(() => {});
  }

  // Copy docs
  const readme = await readFile(path.join(root, 'packages', 'hadamard-canvas', 'npm-README.md'), 'utf8').catch(() => '');
  if (readme) {
    await writeFile(path.join(staging, 'README.md'), readme, 'utf8');
  }

  // Generate package.json
  const hcanvasVersion = JSON.parse(await readFile(path.join(root, 'hcanvas.version.json'), 'utf8')).version;
  const pkg = {
    name: 'hadamard-canvas',
    version: hcanvasVersion,
    description: 'AI-native visual canvas and document workspace with CLI for agents',
    keywords: ['canvas', 'document', 'markdown', 'presentation', 'whiteboard', 'ai', 'agent', 'hadamard'],
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/DeconBear/hadamard.git' },
    bugs: { url: 'https://github.com/DeconBear/hadamard/issues' },
    homepage: 'https://github.com/DeconBear/hadamard#readme',
    type: 'module',
    main: './dist/src/hcanvas/server.js',
    types: './dist/src/hcanvas/server.d.ts',
    bin: {
      hcanvas: './bin/hcanvas.js',
      'hcanvas-desktop': './bin/hcanvas-desktop.js',
      'hadamard-canvas': './bin/hcanvas.js',
    },
    files: ['bin', 'dist', 'assets', 'README.md'],
    dependencies: {
      docx: '^9.15.1',
      katex: '^0.16.47',
      marked: '^18.1.2',
      'node-html-parser': '^9.0.6',
      pptxgenjs: '^4.0.1',
      'puppeteer-core': '^25.16.0',
      zod: '^4.1.12',
    },
    optionalDependencies: {
      electron: '^42.4.1',
    },
    engines: { node: '>=22.13.0' },
    publishConfig: { access: 'public' },
  };
  await writeFile(path.join(staging, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  // Build the actual tarball consumed by npm publish or a manual upload.
  console.log('\nPacking npm tarball:');
  execSync('npm pack', { cwd: staging, stdio: 'inherit' });
  const tarball = 'hadamard-canvas-' + hcanvasVersion + '.tgz';
  console.log('\nPackage staged at: ' + staging);
  console.log('Tarball: ' + path.join(staging, tarball));
  console.log('Publish with: npm publish ' + path.join(staging, tarball) + ' --access public');
}

main().catch(error => { console.error(error); process.exit(1); });
