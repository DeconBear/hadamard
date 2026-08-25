import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { UsageEventV2 } from '../src/usage/contracts.js';
import { UsageLedger } from '../src/usage/usageLedger.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function tempPath(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-usage-'));
  tempDirs.push(directory);
  return path.join(directory, name);
}

function event(overrides: Partial<UsageEventV2> = {}): UsageEventV2 {
  return {
    version: 2,
    eventId: 'event-1',
    requestId: 'request-1',
    correlationId: 'correlation-1',
    timestamp: '2026-08-25T10:00:00.000Z',
    source: 'hadamard',
    status: 'succeeded',
    requestedModel: 'gpt-4o-mini',
    resolvedModel: 'gpt-4o-mini',
    operation: 'generate',
    providerId: 'openai',
    configurationId: 'default',
    projectId: 'project-hash',
    agentId: 'main',
    usage: {
      requests: 1,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      reasoningTokens: 0,
      audioInputTokens: 0,
      audioOutputTokens: 0,
      costUsd: 0.01,
      accuracy: 'actual',
    },
    attempts: [],
    durationMs: 0,
    streaming: false,
    ...overrides,
  };
}

describe('UsageLedger', () => {
  it('deduplicates events and aggregates every usage counter', async () => {
    const ledger = await UsageLedger.open({ filename: await tempPath('usage.sqlite') });
    expect(ledger.append(event())).toBe(true);
    expect(ledger.append(event())).toBe(false);
    ledger.append(event({
      eventId: 'event-2',
      requestedModel: 'other',
      usage: {
        ...event().usage,
        inputTokens: 50,
        outputTokens: 5,
        totalTokens: 55,
        costUsd: 0,
      },
    }));

    expect(ledger.summarize()).toEqual({
      entries: 2,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
      totalTokens: 180,
      reasoningTokens: 0,
      audioInputTokens: 0,
      audioOutputTokens: 0,
      requests: 2,
      costUsd: 0.01,
      accuracy: 'actual',
    });
    expect(ledger.summarize({ model: 'gpt-4o-mini', providerId: 'openai' }).entries).toBe(1);
    expect(ledger.query({ configurationId: 'default' }).map(item => item.eventId)).toEqual(['event-2', 'event-1']);
    ledger.close();
  });

  it('imports old JSONL idempotently and preserves malformed-line accounting', async () => {
    const database = await tempPath('usage.sqlite');
    const legacy = path.join(path.dirname(database), 'cost-ledger.jsonl');
    await writeFile(legacy, [
      JSON.stringify({
        ts: '2026-08-25T10:00:00.000Z',
        model: 'gpt-4o-mini',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        costUsd: 0.01,
      }),
      'not-json',
      JSON.stringify({ model: 'missing-timestamp', inputTokens: 1 }),
      '',
    ].join('\n'), 'utf8');
    const ledger = await UsageLedger.open({ filename: database });

    expect(await ledger.importLegacyJsonl(legacy)).toEqual({ imported: 2, skipped: 0, malformed: 1 });
    expect(await ledger.importLegacyJsonl(legacy)).toEqual({ imported: 0, skipped: 0, malformed: 0 });
    expect(ledger.summarize()).toMatchObject({ entries: 2, cacheReadTokens: 7, cacheWriteTokens: 3 });
    ledger.close();
  });

  it('exports filtered JSONL and deletes events before a retention cutoff', async () => {
    const database = await tempPath('usage.sqlite');
    const output = path.join(path.dirname(database), 'exports', 'usage.jsonl');
    const ledger = await UsageLedger.open({ filename: database });
    ledger.append(event({ eventId: 'old', timestamp: '2025-01-01T00:00:00.000Z' }));
    ledger.append(event({ eventId: 'new', source: 'bridge' }));

    expect(await ledger.exportJsonl(output, { source: 'bridge' })).toBe(1);
    const exported = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(exported).toMatchObject([{ eventId: 'new', source: 'bridge' }]);
    expect(ledger.deleteBefore('2026-01-01T00:00:00.000Z')).toBe(1);
    expect(ledger.summarize().entries).toBe(1);
    ledger.close();
  });

  it('creates parent directories for a new database', async () => {
    const root = await tempPath('placeholder');
    const filename = path.join(path.dirname(root), 'nested', 'usage.sqlite');
    await mkdir(path.dirname(filename), { recursive: true });
    const ledger = await UsageLedger.open({ filename });
    expect(ledger.summarize().entries).toBe(0);
    ledger.close();
  });
});
