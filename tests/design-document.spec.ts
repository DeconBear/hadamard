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
    expect(saved.designPath).toBe(path.join(workDir, '.hadamard', 'design', 'design.md'));
    expect(saved.content).toBe('# Design\n');
    await expect(store.write('# stale', { expectedRevision: empty.revision })).rejects.toThrow(/changed since/u);
    expect(fs.readdirSync(path.dirname(saved.designPath)).some(name => name.endsWith('.tmp'))).toBe(false);
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
