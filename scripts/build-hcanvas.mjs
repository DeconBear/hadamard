import { build } from 'esbuild';
import { copyFile, cp, mkdir } from 'node:fs/promises';
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
await copyFile(path.join(root, 'assets', 'hcanvas-icon.svg'), path.join(outDir, 'assets', 'hcanvas-icon.svg'));
await cp(path.join(root, 'src', 'hcanvas', 'client', 'fonts'), path.join(outDir, 'assets', 'fonts'), { recursive: true });
await mkdir(path.join(root, 'dist', 'src', 'hcanvas'), { recursive: true });
await copyFile(path.join(root, 'src', 'hcanvas', 'preload.cjs'), path.join(root, 'dist', 'src', 'hcanvas', 'preload.cjs'));
console.log('hcanvas bundle: dist/hcanvas');