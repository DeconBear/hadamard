import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHadamardNativeCliClient } from '../src/nativeCli/keywayNativeCliAdapter.js';

const temporaryDirectories: string[] = [];
const fakeCodexCli = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-codex-cli.mjs');
const fakeClaudeCli = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-hadamard-runtime-cli.mjs');
const fakeCursorCli = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-cursor-cli.mjs');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('Hadamard-owned native CLI client', () => {
  it('runs and resumes Codex through the owned runtime with reported usage', async () => {
    const workDir = await temporaryDirectory('hadamard-owned-codex-');
    const client = await createHadamardNativeCliClient(
      { runtime: 'codex' },
      'gpt-5',
      { executable: process.execPath, cliPath: fakeCodexCli, workDir },
    );
    try {
      const first = await client.stream('first-turn').result;
      expect(first.text).toBe('codex:first-turn');
      expect(first.sessionId).toBe('codex-fixture-thread');
      expect(first.resultEvent?.usage).toEqual({
        input_tokens: 10,
        cache_read_input_tokens: 0,
        output_tokens: 'codex:first-turn'.length,
      });

      const resumed = await client.stream('check-resume', { resume: first.sessionId }).result;
      expect(resumed.text).toBe('codex:resume:codex-fixture-thread');
      expect(resumed.sessionId).toBe(first.sessionId);
    } finally {
      await client.close();
    }
  });

  it('runs Claude without forwarding Hadamard API credentials into native auth', async () => {
    const workDir = await temporaryDirectory('hadamard-owned-claude-');
    const client = await createHadamardNativeCliClient(
      { runtime: 'claude' },
      'claude-sonnet-4-6',
      {
        executable: process.execPath,
        cliPath: fakeClaudeCli,
        workDir,
        env: { HADAMARD_AUTH_TOKEN: 'must-not-reach-native-cli' },
      },
    );
    try {
      const result = await client.stream('check-native-auth-boundary').result;
      expect(result.initEvent?.env_token).toBe('missing');
      expect(JSON.stringify(result)).not.toContain('must-not-reach-native-cli');
    } finally {
      await client.close();
    }
  });

  it('runs a Keyway Cursor target through the owned stream-json protocol', async () => {
    const workDir = await temporaryDirectory('hadamard-owned-cursor-');
    const client = await createHadamardNativeCliClient(
      { runtime: 'cursor' },
      'composer-2.5',
      { executable: process.execPath, cliPath: fakeCursorCli, workDir },
    );
    try {
      const result = await client.stream('hello-cursor').result;
      expect(result).toMatchObject({
        text: 'cursor:hello-cursor',
        sessionId: 'cursor-fixture-session',
        isError: false,
      });
      expect(result.resultEvent?.input_tokens).toBe(10);
    } finally {
      await client.close();
    }
  });
});
