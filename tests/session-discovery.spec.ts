import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverProjectSessions,
  getHadamardProjectSessionDirectory,
  invalidateProjectSessionDiscovery,
  SessionStore,
} from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  invalidateProjectSessionDiscovery();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('project Session discovery', () => {
  it('discovers unregistered workspace Sessions from shared persistence metadata', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-discovery-'));
    roots.push(homeDir);
    const workDir = path.join(homeDir, 'unregistered-workspace');
    await mkdir(workDir, { recursive: true });
    const sessionDirectory = getHadamardProjectSessionDirectory(workDir, homeDir);
    const store = new SessionStore(sessionDirectory);
    const created = await store.create({
      id: 'from-tui',
      title: 'TUI Session',
      model: 'test-model',
      metadata: { __hadamardWorkDir: workDir },
      initialMessages: [{ role: 'user', content: 'hello' }],
    });

    const discovered = await discoverProjectSessions(homeDir, { cacheTtlMs: 0 });
    expect(discovered).toEqual([
      expect.objectContaining({
        projectPath: path.resolve(workDir),
        sessionDirectory,
        summary: expect.objectContaining({ id: created.id, workDir: path.resolve(workDir) }),
      }),
    ]);
  });
});
