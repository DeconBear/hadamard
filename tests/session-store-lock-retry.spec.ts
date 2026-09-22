import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const lockState = vi.hoisted(() => ({ transientFailuresRemaining: 0 }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const target = String(args[0]);
      const flags = args[1];
      if (
        lockState.transientFailuresRemaining > 0 &&
        typeof flags === 'string' &&
        flags.includes('wx') &&
        target.endsWith('.lock')
      ) {
        lockState.transientFailuresRemaining -= 1;
        const error = new Error(
          `Injected transient lock failure for ${target}`,
        ) as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return actual.open(...args);
    },
  };
});

const { SessionStore } = await import('../src/index.js');

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(dir => realFs.rm(dir, { recursive: true, force: true })),
  );
});

describe('SessionStore lock acquisition', () => {
  it('retries the save lock through transient EPERM from concurrent scanners', async () => {
    const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'hadamard-lock-retry-'));
    tempDirs.push(root);
    const store = new SessionStore(root);

    lockState.transientFailuresRemaining = 2;
    const created = await store.create({ title: 'Lock retry', model: 'demo-model' });
    expect(lockState.transientFailuresRemaining).toBe(0);

    const loaded = await store.load(created.id);
    loaded.title = 'Saved past the transient lock failures';
    await store.save(loaded);
    expect((await store.load(created.id)).title).toBe('Saved past the transient lock failures');
  });

  it('retries the exclusive turn lock through transient EPERM', async () => {
    const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'hadamard-turn-lock-retry-'));
    tempDirs.push(root);
    const store = new SessionStore(root);
    const created = await store.create({ title: 'Turn lock retry', model: 'demo-model' });

    lockState.transientFailuresRemaining = 1;
    const result = await store.runExclusiveTurn(created.id, async () => 'turn-ok');
    expect(result).toBe('turn-ok');
    expect(lockState.transientFailuresRemaining).toBe(0);
  });
});
