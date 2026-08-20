import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveExecutableInvocation } from '../src/parity/bridgeExecResolver.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('resolveExecutableInvocation', () => {
  it('passes ordinary executables and argv through unchanged', async () => {
    await expect(resolveExecutableInvocation(process.execPath, ['-e', 'console.log("ok")']))
      .resolves.toEqual({
        file: process.execPath,
        args: ['-e', 'console.log("ok")'],
      });
  });

  it.runIf(process.platform === 'win32')(
    'unwraps npm cmd shims without sending user input through cmd.exe',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-shim-'));
      tempRoots.push(root);
      const packageBin = path.join(root, 'node_modules', 'fake-cli', 'cli.js');
      await mkdir(path.dirname(packageBin), { recursive: true });
      await writeFile(packageBin, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))', 'utf8');
      const shim = path.join(root, 'fake.cmd');
      await writeFile(
        shim,
        '@ECHO off\r\n"%dp0%\\node_modules\\fake-cli\\cli.js" %*\r\n',
        'utf8',
      );
      const prompt = 'literal %GITHUB_TOKEN% & whoami "quoted"';

      await expect(resolveExecutableInvocation(shim, ['--json', prompt])).resolves.toEqual({
        file: process.execPath,
        args: [packageBin, '--json', prompt],
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects an unparseable batch wrapper instead of shelling user input',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-shim-'));
      tempRoots.push(root);
      const shim = path.join(root, 'unsafe.cmd');
      await writeFile(shim, '@ECHO off\r\necho %*\r\n', 'utf8');

      await expect(resolveExecutableInvocation(shim, ['%TOKEN% & calc']))
        .rejects.toThrow(/Unsupported Windows CLI wrapper/);
    },
  );

  it.runIf(process.platform === 'win32')(
    'resolves Cursor-style PowerShell shims to the latest versioned node bundle',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-shim-'));
      tempRoots.push(root);
      const shim = path.join(root, 'cursor-agent.cmd');
      await writeFile(
        shim,
        '@echo off\r\npowershell.exe -NoProfile -File "%~dp0cursor-agent.ps1" %*\r\n',
        'utf8',
      );
      for (const version of ['2025.01.01-deadbeef', '2026.08.11-e8db854']) {
        const bundleDir = path.join(root, 'versions', version);
        await mkdir(bundleDir, { recursive: true });
        await writeFile(path.join(bundleDir, 'node.exe'), '', 'utf8');
        await writeFile(path.join(bundleDir, 'index.js'), '// entry', 'utf8');
      }
      const latest = path.join(root, 'versions', '2026.08.11-e8db854');

      await expect(resolveExecutableInvocation(shim, ['--version'])).resolves.toEqual({
        file: path.join(latest, 'node.exe'),
        args: [path.join(latest, 'index.js'), '--version'],
      });
    },
  );
});
