import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'gui-canvas');
const excaliburRoot = path.join(root, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src', 'gui', 'canvasEditor', 'excalidrawEntry.tsx')],
  outfile: path.join(outDir, 'excalidraw.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
  logLevel: 'info',
});

async function copyDir(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

await copyDir(path.join(excaliburRoot, 'fonts'), path.join(outDir, 'fonts'));
await copyDir(path.join(excaliburRoot, 'locales'), path.join(outDir, 'locales')).catch(() => undefined);
await copyDir(path.join(excaliburRoot, 'data'), path.join(outDir, 'data')).catch(() => undefined);
await copyFile(path.join(excaliburRoot, 'index.css'), path.join(outDir, 'excalidraw.css')).catch(() => undefined);
const bundleInfo = await stat(path.join(outDir, 'excalidraw.js'));
console.log('gui-canvas bundle:', Math.round(bundleInfo.size / 1024) + ' KiB');
