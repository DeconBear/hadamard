import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createHadamardNativeCliClient,
  NATIVE_CLI_DEFAULT_MODEL,
} from '../src/nativeCli/keywayNativeCliAdapter.js';

const temporaryDirectories: string[] = [];
const fakeCodexCli = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-codex-cli.mjs');
const fakeClaudeCli = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-hadamard-runtime-cli.mjs');
const fakeCodewhaleCli = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-codewhale-cli.mjs');
const fakeCursorCli = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-cursor-cli.mjs');
const fakeCrushCli = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-crush-cli.mjs');
const fakePiCli = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-pi-cli.mjs');
const fakeReasonixCli = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-reasonix-cli.mjs');

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

  it('lets Codex use its configured default model when the route requests the CLI default', async () => {
    const workDir = await temporaryDirectory('hadamard-owned-codex-default-');
    const client = await createHadamardNativeCliClient(
      { runtime: 'codex' },
      NATIVE_CLI_DEFAULT_MODEL,
      { executable: process.execPath, cliPath: fakeCodexCli, workDir },
    );
    try {
      const result = await client.stream('who-am-i').result;
      expect(result.text).toBe('codex:agent:inherit');
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

  it('runs a Keyway Pi target through the owned interactive RPC protocol', async () => {
    const workDir = await temporaryDirectory('hadamard-owned-pi-');
    const client = await createHadamardNativeCliClient(
      { runtime: 'pi' },
      'openai/gpt-4o-mini',
      { executable: process.execPath, cliPath: fakePiCli, workDir },
    );
    try {
      const result = await client.stream('who-am-i').result;
      expect(result).toMatchObject({
        text: 'pi:agent:gpt-4o-mini',
        sessionId: 'pi-fixture-session',
        isError: false,
        totalCostUsd: 0,
      });
      expect(result.initEvent?.model).toBe('gpt-4o-mini');
    } finally {
      await client.close();
    }
  });

  it('correlates a Keyway CodeWhale target with its persisted native session', async () => {
    const workDir = await temporaryDirectory('hadamard-owned-codewhale-');
    const codewhaleHome = path.join(workDir, 'codewhale-home');
    const client = await createHadamardNativeCliClient(
      { runtime: 'codewhale' },
      'codewhale-default',
      {
        executable: process.execPath,
        cliPath: fakeCodewhaleCli,
        workDir,
        env: { CODEWHALE_HOME: codewhaleHome },
      },
    );
    try {
      const result = await client.stream('hello-codewhale').result;
      expect(result).toMatchObject({
        text: 'codewhale:hello-codewhale',
        sessionId: 'codewhale-fixture-session',
        isError: false,
      });
      expect(result.resultEvent).toMatchObject({ input_tokens: 4 });
    } finally {
      await client.close();
    }
  });

  it('keeps a Keyway Reasonix target on its owned managed ACP runtime', async () => {
    const workDir = await temporaryDirectory('hadamard-owned-reasonix-');
    const client = await createHadamardNativeCliClient(
      { runtime: 'reasonix' },
      'fixture/managed',
      { executable: process.execPath, cliPath: fakeReasonixCli, workDir, homeDir: workDir },
    );
    try {
      const first = await client.stream('runtime-identity').result;
      const second = await client.stream('runtime-identity').result;
      const firstIdentity = /pid=(\d+):session=([^:]+):turn=(\d+)/u.exec(first.text);
      const secondIdentity = /pid=(\d+):session=([^:]+):turn=(\d+)/u.exec(second.text);
      expect(firstIdentity?.[1]).toBe(secondIdentity?.[1]);
      expect(firstIdentity?.[2]).toBe('reasonix-fixture-session');
      expect(firstIdentity?.[3]).toBe('1');
      expect(secondIdentity?.[3]).toBe('2');
      expect(second.sessionId).toBe('reasonix-fixture-session');
    } finally {
      await client.close();
    }
  });

  it('runs a Keyway Crush target over the owned private local transport', async () => {
    const workDir = await temporaryDirectory('hadamard-owned-crush-');
    const client = await createHadamardNativeCliClient(
      { runtime: 'crush' },
      'openai/gpt-5',
      { executable: process.execPath, cliPath: fakeCrushCli, workDir },
    );
    try {
      const first = await client.stream('hello-crush').result;
      const resumed = await client.stream('second-turn', {
        resume: first.sessionId,
        sessionId: first.sessionId,
      }).result;
      expect(first).toMatchObject({ text: 'crush:hello-crush', sessionId: 'crush-session-1' });
      expect(resumed).toMatchObject({ text: 'crush:second-turn', sessionId: 'crush-session-1' });
    } finally {
      await client.close();
    }
  });
});
