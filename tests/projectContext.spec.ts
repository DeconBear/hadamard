import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadProjectContext } from '../src/memory/projectContext.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('loadProjectContext', () => {
  it('does not fabricate project context for a dir with no instruction file', async () => {
    const missing = path.join(os.tmpdir(), 'nonexistent-hadamard-ctx-12345');
    const hadamardHomeDir = await makeTempDir('ctx-home-empty-');
    const result = loadProjectContext(missing, { hadamardHomeDir });
    // No source should reference the (missing) working directory.
    expect(result.sources.find(s => s.includes('nonexistent-hadamard-ctx-12345'))).toBeUndefined();
  });

  it('loads project AGENTS.md and ignores CLAUDE.md by default', async () => {
    const dir = await makeTempDir('ctx-proj-');
    const hadamardHomeDir = await makeTempDir('ctx-home-');
    await writeFile(path.join(dir, 'AGENTS.md'), '# Rules\n\n- Use TypeScript.\n- Do not touch src/generated/.\n');
    await writeFile(path.join(dir, 'CLAUDE.md'), 'CLAUDE_ONLY_RULE\n');
    const result = loadProjectContext(dir, { hadamardHomeDir });
    expect(result.sources.some(s => s.endsWith('AGENTS.md'))).toBe(true);
    expect(result.text).toContain('Use TypeScript.');
    expect(result.text).toContain('Do not touch src/generated/');
    expect(result.text).not.toContain('CLAUDE_ONLY_RULE');
  });

  it('loads CLAUDE.md compatibility sources only when selected', async () => {
    const dir = await makeTempDir('ctx-nested-');
    const hadamardHomeDir = await makeTempDir('ctx-home-');
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'CLAUDE.md'), 'Nested rules go here.\n');
    const result = loadProjectContext(dir, {
      hadamardHomeDir,
      projectInstructionMode: 'claude',
    });
    expect(result.text).toContain('Nested rules go here.');
    expect(result.sources.find(s => s.endsWith(path.join('.claude', 'CLAUDE.md')))).toBeDefined();
  });

  it('inlines @path includes relative to the file', async () => {
    const dir = await makeTempDir('ctx-incl-');
    const hadamardHomeDir = await makeTempDir('ctx-home-');
    await writeFile(path.join(dir, 'standards.md'), '# Coding standards\n\n- 2-space indent.\n');
    await writeFile(path.join(dir, 'AGENTS.md'), 'Project rules.\n\n@standards.md\n');
    const result = loadProjectContext(dir, { hadamardHomeDir });
    expect(result.text).toContain('Project rules.');
    expect(result.text).toContain('2-space indent.');
  });

  it('guards against @include cycles', async () => {
    const dir = await makeTempDir('ctx-cycle-');
    const hadamardHomeDir = await makeTempDir('ctx-home-');
    await writeFile(path.join(dir, 'AGENTS.md'), 'A\n\n@AGENTS.md\n');
    // Should not hang; the cycle is detected and the self-include is skipped.
    const result = loadProjectContext(dir, { hadamardHomeDir });
    expect(result.text).toContain('A');
  });

  it('walks ancestor AGENTS.md files (nearest-to-cwd last)', async () => {
    const root = await makeTempDir('ctx-walk-');
    const hadamardHomeDir = await makeTempDir('ctx-home-');
    const child = path.join(root, 'pkg');
    await mkdir(child, { recursive: true });
    await writeFile(path.join(root, 'AGENTS.md'), 'ROOT RULE\n');
    await writeFile(path.join(child, 'AGENTS.md'), 'CHILD RULE\n');
    const result = loadProjectContext(child, { hadamardHomeDir });
    expect(result.text).toContain('ROOT RULE');
    expect(result.text).toContain('CHILD RULE');
    // Child (cwd) appends after root.
    expect(result.text.indexOf('CHILD RULE')).toBeGreaterThan(result.text.indexOf('ROOT RULE'));
  });

  it('bounds nested AGENTS.md resolution to the registered work path', async () => {
    const outside = await makeTempDir('hadamard-context-parent-');
    const hadamardHomeDir = await makeTempDir('hadamard-context-home-');
    const root = path.join(outside, 'project');
    const child = path.join(root, 'packages', 'web');
    await mkdir(child, { recursive: true });
    await writeFile(path.join(outside, 'AGENTS.md'), 'OUTSIDE RULE\n');
    await writeFile(path.join(root, 'AGENTS.md'), 'ROOT RULE\n');
    await writeFile(path.join(child, 'AGENTS.md'), 'CHILD RULE\n');
    const result = loadProjectContext(child, { hadamardHomeDir, projectWorkPaths: [root] });
    expect(result.text).toContain('ROOT RULE');
    expect(result.text).toContain('CHILD RULE');
    expect(result.text).not.toContain('OUTSIDE RULE');
  });

  it('loads global rules only from the Hadamard AGENTS.md', async () => {
    const dir = await makeTempDir('ctx-global-project-');
    const hadamardHomeDir = await makeTempDir('ctx-global-home-');
    await writeFile(path.join(hadamardHomeDir, 'AGENTS.md'), 'GLOBAL HADAMARD RULE\n');
    const result = loadProjectContext(dir, { hadamardHomeDir });
    expect(result.sources).toContain('~/.hadamard/AGENTS.md');
    expect(result.text).toContain('GLOBAL HADAMARD RULE');
  });

  it('combines the global AGENTS.md with only the active workspace rules', async () => {
    const parent = await makeTempDir('ctx-workspaces-');
    const hadamardHomeDir = await makeTempDir('ctx-shared-home-');
    const first = path.join(parent, 'first');
    const second = path.join(parent, 'second');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(path.join(hadamardHomeDir, 'AGENTS.md'), 'GLOBAL RULE\n');
    await writeFile(path.join(first, 'AGENTS.md'), 'FIRST RULE\n');
    await writeFile(path.join(second, 'AGENTS.md'), 'SECOND RULE\n');

    const firstResult = loadProjectContext(first, {
      hadamardHomeDir,
      projectWorkPaths: [first],
    });
    const secondResult = loadProjectContext(second, {
      hadamardHomeDir,
      projectWorkPaths: [second],
    });

    expect(firstResult.text).toContain('GLOBAL RULE');
    expect(firstResult.text).toContain('FIRST RULE');
    expect(firstResult.text).not.toContain('SECOND RULE');
    expect(secondResult.text).toContain('GLOBAL RULE');
    expect(secondResult.text).toContain('SECOND RULE');
    expect(secondResult.text).not.toContain('FIRST RULE');
  });
});
