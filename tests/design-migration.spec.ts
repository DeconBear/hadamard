import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectDesignMigration,
} from '../src/design/designMigration.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Design document compatibility inspection', () => {
  it('keeps legacy PROGRESS.md readable without writing DESIGN.md', async () => {
    const root = await tempStore();
    const content = await readFile(
      new URL('./fixtures/compat/legacy-progress-only/PROGRESS.md', import.meta.url),
      'utf8',
    );
    await writeFile(path.join(root, 'PROGRESS.md'), content, 'utf8');

    const inspection = await inspectDesignMigration(root);
    expect(inspection.state).toBe('legacy-progress');
    expect(inspection.readableContent).toBe(content);
    await expect(readFile(path.join(root, 'DESIGN.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prefers DESIGN.md for reading and reports a conflict when both files exist', async () => {
    const root = await tempStore();
    await writeFile(path.join(root, 'DESIGN.md'), '# Canonical design\n', 'utf8');
    await writeFile(path.join(root, 'PROGRESS.md'), '# Legacy progress\n', 'utf8');

    const inspection = await inspectDesignMigration(root);
    expect(inspection.state).toBe('conflict');
    expect(inspection.readableContent).toBe('# Canonical design\n');
    expect(inspection.legacyProgressContent).toBe('# Legacy progress\n');
  });

  it('distinguishes canonical-only and empty stores', async () => {
    const canonical = await tempStore();
    await writeFile(path.join(canonical, 'DESIGN.md'), '# Design\n', 'utf8');
    expect((await inspectDesignMigration(canonical)).state).toBe('design');

    const empty = await tempStore();
    expect((await inspectDesignMigration(empty)).state).toBe('empty');
  });
});

async function tempStore(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-design-migration-'));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
