import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DesignDocumentService } from '../src/design/designDocumentService.js';
import { DesignDocumentStore } from '../src/design/designDocumentStore.js';
import { serializeDesignDocument } from '../src/design/designSchema.js';

let workDir: string;
let homeDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-work-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-home-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('DesignDocumentStore', () => {
  it('uses DESIGN.md as the canonical source and revision-checks atomic writes', async () => {
    const store = new DesignDocumentStore(workDir, homeDir);
    const empty = await store.inspect();
    expect(empty.state).toBe('empty');
    await store.write('# Design\n');
    const saved = await store.inspect();
    expect(saved.state).toBe('design');
    expect(saved.designPath).toMatch(/DESIGN\.md$/u);
    expect(saved.content).toBe('# Design\n');
    await expect(store.write('# stale', { expectedRevision: empty.revision })).rejects.toThrow(/changed since/u);
    expect(fs.readdirSync(path.dirname(saved.designPath)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('previews legacy-only content and migrates with a timestamped backup', async () => {
    const store = new DesignDocumentStore(workDir, homeDir);
    fs.mkdirSync(store.directory(), { recursive: true });
    fs.writeFileSync(path.join(store.directory(), 'PROGRESS.md'), '# Legacy\n');
    const preview = await store.inspect();
    expect(preview.state).toBe('legacy-progress');
    expect(preview.content).toBe('# Legacy\n');
    expect(fs.existsSync(preview.designPath)).toBe(false);

    const migrated = await store.migrate('migrate-legacy', new Date('2026-08-11T01:02:03.000Z'));
    expect(migrated.state).toBe('design');
    expect(migrated.content).toBe('# Legacy\n');
    expect(fs.existsSync(path.join(store.directory(), 'PROGRESS.md'))).toBe(false);
    expect(fs.existsSync(path.join(store.directory(), 'PROGRESS.md.2026-08-11T01-02-03-000Z.bak'))).toBe(true);
  });

  it('never auto-overwrites a DESIGN/PROGRESS conflict', async () => {
    const store = new DesignDocumentStore(workDir, homeDir);
    fs.mkdirSync(store.directory(), { recursive: true });
    fs.writeFileSync(store.designPath(), '# Canonical\n');
    fs.writeFileSync(path.join(store.directory(), 'PROGRESS.md'), '# Legacy\n');
    const conflict = await store.inspect();
    expect(conflict.state).toBe('conflict');
    expect(conflict.content).toBe('# Canonical\n');
    expect(conflict.legacyProgressContent).toBe('# Legacy\n');
    expect(fs.readFileSync(store.designPath(), 'utf8')).toBe('# Canonical\n');

    const merged = await store.migrate('merge-history', new Date('2026-08-11T00:00:00.000Z'));
    expect(merged.content).toContain('# Canonical');
    expect(merged.content).toContain('## History: legacy progress');
    expect(merged.content).toContain('# Legacy');
  });

  it('requires an explicit keep or replace action for conflicts', async () => {
    const keepStore = new DesignDocumentStore(workDir, homeDir);
    fs.mkdirSync(keepStore.directory(), { recursive: true });
    fs.writeFileSync(keepStore.designPath(), '# Keep canonical\n');
    fs.writeFileSync(path.join(keepStore.directory(), 'PROGRESS.md'), '# Discard legacy\n');
    expect((await keepStore.migrate('keep-design')).content).toBe('# Keep canonical\n');

    fs.writeFileSync(path.join(keepStore.directory(), 'PROGRESS.md'), '# Replace from legacy\n');
    const replaced = await keepStore.migrate('replace-with-legacy');
    expect(replaced.content).toBe('# Replace from legacy\n');
  });

  it('recognizes a legacy workspace mirror but writes only a service-managed DESIGN mirror', async () => {
    fs.mkdirSync(path.join(workDir, '.hadamard'), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.hadamard', 'PROGRESS.md'), '# Workspace legacy\n');
    const store = new DesignDocumentStore(workDir, homeDir, workDir);
    expect((await store.inspect()).state).toBe('legacy-progress');
    await store.migrate('migrate-legacy');
    await store.write('# New design\n', { mirror: true });
    expect(fs.readFileSync(path.join(workDir, '.hadamard', 'DESIGN.md'), 'utf8')).toBe('# New design\n');
  });
});

describe('DesignDocumentService', () => {
  it('returns parsed metadata and templates without making HTML a source of truth', async () => {
    const service = new DesignDocumentService(workDir, homeDir);
    const source = serializeDesignDocument('# Goal\n', {
      template: 'software.general',
      theme: 'clean-dark',
      updatedAt: '2026-08-11T00:00:00.000Z',
    });
    await service.patch(source);
    const document = await service.read();
    expect(document.parsed.frontmatter.theme).toBe('clean-dark');
    expect(document.parsed.markdown).toContain('# Goal');
    expect(service.templates.list().map(template => template.id)).toContain('software.general');
  });
});
