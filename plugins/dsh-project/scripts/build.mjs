import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
await rm(new URL('../.build', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist', import.meta.url), { recursive: true });
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.json', '--emitDeclarationOnly'], { cwd: root, stdio: 'inherit' });
// Bundle the exact shared read-only implementation, never a copied or reimplemented store.
// Host-owned Cordis/DSH modules remain external to preserve service identity.
await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  packages: 'external',
  treeShaking: true,
  minifySyntax: true,
  legalComments: 'none',
});
await copyFile(new URL('../.build/types/plugins/dsh-project/src/index.d.ts', import.meta.url), new URL('../dist/index.d.ts', import.meta.url));
