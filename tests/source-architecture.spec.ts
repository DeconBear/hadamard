import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { glob } from 'glob';

import { inspectSolidBoundaries } from '../scripts/check-solid-boundaries.mjs';

const execFileAsync = promisify(execFile);

describe('source architecture', () => {
  it('keeps production source free of circular imports', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(root, 'scripts', 'check-source-cycles.mjs'), path.join(root, 'src')],
      { cwd: root },
    );
    expect(JSON.parse(stdout)).toMatchObject({ passed: true, cycles: [] });
  });

  it('keeps oversized files and interfaces at or below reviewed baselines', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(root, 'scripts', 'check-solid-boundaries.mjs'), path.join(root, 'src')],
      { cwd: root },
    );
    expect(JSON.parse(stdout)).toMatchObject({ passed: true, violations: [] });
  });

  it('keeps embedded Keyway execution independent from the parity runtime', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const files = await glob('**/*.ts', { cwd: path.join(root, 'src', 'keyway'), absolute: true });
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const isExplicitLegacyMigration = path.basename(file) === 'keywayMigrationService.ts';
      if (!isExplicitLegacyMigration && /from\s+['"]\.\.\/parity(?:\/|['"])/u.test(source)) {
        violations.push(path.relative(root, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the Hadamard-owned native CLI process core independent from parity', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const ownedFiles = [
      'nativeCliAuth.ts',
      'nativeCliClient.ts',
      'nativeCliCodewhaleProtocol.ts',
      'nativeCliCursorProtocol.ts',
      'nativeCliExecResolver.ts',
      'nativeCliPiProtocol.ts',
      'nativeCliProcessTree.ts',
    ];
    const violations: string[] = [];
    for (const name of ownedFiles) {
      const file = path.join(root, 'src', 'nativeCli', name);
      const source = await readFile(file, 'utf8');
      if (/from\s+['"]\.\.\/parity(?:\/|['"])/u.test(source)) {
        violations.push(path.relative(root, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('detects newly oversized source files and interfaces', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'hadamard-solid-boundary-'));
    try {
      const members = Array.from({ length: 21 }, (_, index) => `  field${index}: string;`).join('\n');
      await writeFile(
        path.join(fixture, 'oversized.ts'),
        `${'export const filler = 0;\n'.repeat(1_001)}export interface FatPort {\n${members}\n}\n`,
        'utf8',
      );
      const result = await inspectSolidBoundaries(fixture, { files: {}, interfaces: {} });
      expect(result.passed).toBe(false);
      expect(result.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'file-size', target: 'oversized.ts' }),
        expect.objectContaining({ kind: 'interface-size', target: 'oversized.ts#FatPort' }),
      ]));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
