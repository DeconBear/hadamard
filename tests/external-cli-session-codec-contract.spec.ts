import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { codewhaleExternalCliSessionCodec } from '../src/parity/codewhaleExternalCliSessionCodec.js';
import type { ExternalCliSessionCodec } from '../src/parity/externalCliSessionCodec.js';
import { createLegacyExternalCliSessionCodec } from '../src/parity/legacyExternalCliSessionCodec.js';
import { reasonixExternalCliSessionCodec } from '../src/parity/reasonixExternalCliSessionCodec.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('ExternalCliSessionCodec contract', () => {
  it.each([
    {
      codec: createLegacyExternalCliSessionCodec('claude'),
      fileName: 'claude-session.jsonl',
      source: `${JSON.stringify({
        type: 'user',
        sessionId: 'claude-session',
        timestamp: '2026-08-10T01:00:00.000Z',
        message: { role: 'user', content: 'Claude fixture' },
      })}\n`,
      runtime: 'claude',
      text: 'Claude fixture',
    },
    {
      codec: reasonixExternalCliSessionCodec,
      fileName: 'reasonix-session.jsonl',
      source: `${JSON.stringify({
        role: 'user',
        content: 'Reasonix fixture',
        timestamp: '2026-08-10T01:00:00.000Z',
      })}\n`,
      runtime: 'reasonix',
      text: 'Reasonix fixture',
    },
    {
      codec: codewhaleExternalCliSessionCodec,
      fileName: 'codewhale-session.json',
      source: JSON.stringify({
        metadata: {
          id: 'codewhale-session',
          title: 'CodeWhale fixture',
          workspace: 'E:\\fixture',
          created_at: '2026-08-10T01:00:00.000Z',
          updated_at: '2026-08-10T01:00:01.000Z',
          message_count: 1,
        },
        messages: [{ role: 'user', content: 'CodeWhale fixture' }],
      }),
      runtime: 'codewhale',
      text: 'CodeWhale fixture',
    },
  ] as const)('allows $runtime to substitute the shared codec port', async fixture => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-codec-contract-'));
    tempDirs.push(directory);
    const filePath = path.join(directory, fixture.fileName);
    await writeFile(filePath, fixture.source, 'utf8');

    const session = await parseThroughCodecPort(fixture.codec, filePath);

    expect(session?.summary.runtime).toBe(fixture.runtime);
    expect(session?.summary.path).toBe(filePath);
    expect(session?.messages[0]?.text).toBe(fixture.text);
  });
});

async function parseThroughCodecPort(
  codec: ExternalCliSessionCodec,
  filePath: string,
) {
  return codec.parse(filePath, {
    maxBytes: 128 * 1024,
    maxMessages: 100,
  }, await stat(filePath));
}
