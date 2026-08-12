import { mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ProjectRuleCatalogService } from '../src/rules/projectRuleCatalog.js';

describe('ProjectRuleCatalogService', () => {
  it('catalogs nested AGENTS.md across work paths and resolves directory scope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-rules-'));
    const extra = await mkdtemp(path.join(os.tmpdir(), 'hadamard-rules-extra-'));
    await mkdir(path.join(root, 'packages', 'web'), { recursive: true });
    await writeFile(path.join(root, 'AGENTS.md'), 'root');
    await writeFile(path.join(root, 'packages', 'web', 'AGENTS.md'), 'web');
    await writeFile(path.join(extra, 'AGENTS.md'), 'extra');
    const service = new ProjectRuleCatalogService([root, extra]);
    const entries = await service.list(true);
    expect(entries).toHaveLength(3);
    expect(service.effectiveFor(path.join(root, 'packages', 'web', 'src', 'app.ts'), entries).map(item => item.content)).toEqual(['root', 'web']);
    expect(service.effectiveFor(path.join(extra, 'file.ts'), entries).map(item => item.content)).toEqual(['extra']);
  });

  it('does not follow directory symlinks and revision-checks writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-rules-safe-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'hadamard-rules-outside-'));
    await writeFile(path.join(root, 'AGENTS.md'), 'one');
    await writeFile(path.join(outside, 'AGENTS.md'), 'outside');
    await symlink(outside, path.join(root, 'linked'), 'junction');
    const service = new ProjectRuleCatalogService([root]);
    const [entry] = await service.list();
    expect(entry?.relativePath).toBe('AGENTS.md');
    await expect(service.write(entry!.id, 'two', 'stale')).rejects.toThrow('changed on disk');
    expect((await service.write(entry!.id, 'two', entry!.revision)).content).toBe('two');
  });
});
