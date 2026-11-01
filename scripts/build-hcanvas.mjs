import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'dist', 'hcanvas');
await mkdir(path.join(outDir, 'assets'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src', 'hcanvas', 'client', 'main.ts')],
  outfile: path.join(outDir, 'assets', 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: false,
  minify: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
await copyFile(path.join(root, 'src', 'hcanvas', 'client', 'styles.css'), path.join(outDir, 'assets', 'app.css'));
await copyFile(path.join(root, 'src', 'hcanvas', 'client', 'index.html'), path.join(outDir, 'index.html'));
console.log('hcanvas bundle: dist/hcanvas');
