import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as guiMeta from '../src/gui/projectMeta.js';
import * as coreMeta from '../src/project/projectMeta.js';
import { encodeHadamardProjectPath } from '../src/config/projectSessionDirectory.js';
import { createProjectIssue, listProjectIssues, resolveIssueStorePath, writeIssueStore } from '../src/issues/issueStore.js';
import { createProjectReader, countProjectIssues, readProjectIssueSnapshot } from '../src/project/projectReader.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-project-reader-'));
  roots.push(root);
  const scope = { workDir: path.join(root, 'workspace'), homeDir: path.join(root, 'home') };
  await mkdir(scope.workDir);
  return { root, ...scope };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const fullPath = path.join(entry.parentPath, entry.name);
    files[path.relative(root, fullPath)] = entry.isDirectory() ? '<directory>' : await readFile(fullPath, 'utf8');
  }
  return files;
}

describe('host-independent project reader', () => {
  it('keeps the GUI metadata API as the same implementation', () => {
    expect(guiMeta).toEqual(coreMeta);
    expect(guiMeta.readProjectMeta).toBe(coreMeta.readProjectMeta);
    expect(guiMeta.writeProjectMeta).toBe(coreMeta.writeProjectMeta);
  });

  it.each(['home', 'workspace'] as const)('reads existing %s issues without changing any files', async storage => {
    const scope = await fixture();
    await guiMeta.writeProjectMeta(scope.workDir, scope.homeDir, { status: 'planning', issueStorage: storage });
    const issue = await createProjectIssue(scope.workDir, scope.homeDir, {
      title: 'Validate experiment',
      acceptanceCriteria: ['Reproduce baseline', 'Record uncertainty'],
      metadata: { evidence: 'results/baseline.json' },
    }, storage);
    const before = await snapshot(scope.root);
    const reader = createProjectReader(scope);
    expect(await reader.listIssues()).toEqual(await listProjectIssues(scope.workDir, scope.homeDir, storage));
    for (const key of [issue.id, issue.number, String(issue.number), `ISS-${issue.number}`, `iss-${issue.number}`]) {
      expect(await reader.getIssue(key)).toEqual(issue);
    }
    expect(await reader.getIssue('missing')).toBeNull();
    expect(await reader.getProject()).toEqual({
      id: encodeHadamardProjectPath(scope.workDir),
      path: scope.workDir,
      name: 'workspace',
      status: 'planning',
      issueStorage: storage,
      issueCounts: { total: 1, open: 1, review: 0, closed: 0 },
      updatedAt: (await guiMeta.readProjectMeta(scope.workDir, scope.homeDir)).updatedAt,
    });
    expect(await snapshot(scope.root)).toEqual(before);
  });

  it('does not bootstrap or migrate missing stores', async () => {
    const scope = await fixture();
    const before = await snapshot(scope.root);
    const reader = createProjectReader(scope);
    expect(await reader.listIssues()).toEqual([]);
    expect(await reader.getIssue(1)).toBeNull();
    expect(await reader.getProject()).toMatchObject({ status: 'not_started', issueStorage: 'home' });
    expect(await snapshot(scope.root)).toEqual(before);
  });

  it('reloads the host storage preference and isolates projects', async () => {
    const scope = await fixture();
    const home = await createProjectIssue(scope.workDir, scope.homeDir, { title: 'Home task' });
    const workspace = await createProjectIssue(scope.workDir, scope.homeDir, { title: 'Workspace task' }, 'workspace');
    await createProjectIssue(path.join(scope.root, 'another'), scope.homeDir, { title: 'Other project' });
    const reader = createProjectReader(scope);
    expect(await reader.listIssues()).toEqual([home]);
    await guiMeta.writeProjectMeta(scope.workDir, scope.homeDir, { issueStorage: 'workspace' });
    expect(await reader.listIssues()).toEqual([workspace]);
    expect(await readProjectIssueSnapshot(scope)).toEqual({ storage: 'workspace', issues: [workspace] });
    expect(await reader.getIssue(home.id)).toBeNull();
  });

  it('shares GUI count semantics including review within open', async () => {
    const scope = await fixture();
    const issue = await createProjectIssue(scope.workDir, scope.homeDir, { title: 'Task' });
    const issues = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'].map((status, i) => ({
      ...issue, id: `test-${i}`, number: i + 1, status: status as typeof issue.status,
    }));
    await writeIssueStore(scope.workDir, scope.homeDir, { version: 1, nextNumber: 7, issues });
    expect(countProjectIssues(issues)).toEqual({ total: 6, open: 4, review: 1, closed: 2 });
    expect((await createProjectReader(scope).getProject()).issueCounts).toEqual(countProjectIssues(issues));
  });

  it('propagates malformed issue JSON and never repairs it', async () => {
    const scope = await fixture();
    const issuePath = resolveIssueStorePath(scope.workDir, scope.homeDir);
    await mkdir(path.dirname(issuePath), { recursive: true });
    await writeFile(issuePath, '{broken');
    const before = await snapshot(scope.root);
    const reader = createProjectReader(scope);
    await expect(reader.listIssues()).rejects.toThrow();
    await expect(reader.getProject()).rejects.toThrow();
    expect(await snapshot(scope.root)).toEqual(before);
  });

  it('returns fresh values and rejects empty scope or invalid issue numbers', async () => {
    const scope = await fixture();
    await createProjectIssue(scope.workDir, scope.homeDir, { title: 'Original' });
    const reader = createProjectReader(scope);
    (await reader.listIssues())[0]!.title = 'Local mutation';
    expect((await reader.getIssue(1))?.title).toBe('Original');
    expect(() => createProjectReader({ ...scope, workDir: '' })).toThrow('explicit');
    expect(() => createProjectReader({ ...scope, homeDir: '' })).toThrow('explicit');
    for (const key of ['', ' ', 0, -1, 1.5, NaN, Infinity]) {
      await expect(reader.getIssue(key)).rejects.toThrow();
    }
  });
});
