import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDefaultDesignTemplateRegistry,
  DesignWorkspaceBundleService,
  DesignWorkspaceService,
} from '../src/design/index.js';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'design-bundle-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('Design workspace bundles', () => {
  it('previews templates without writing and applies both editable entry files after confirmation', async () => {
    const root = await temporaryWorkspace();
    const workspace = new DesignWorkspaceService(root);
    const bundles = new DesignWorkspaceBundleService(workspace, createDefaultDesignTemplateRegistry(), 'test');

    const preview = await bundles.previewTemplateApply('electronics.circuit');
    expect(preview.template).toMatchObject({ category: 'Electronic design', entries: ['markdown', 'html'] });
    expect(preview.html).toContain('Electronic circuit');
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'design.md', action: 'add' }),
      expect.objectContaining({ path: 'design.html', action: 'add' }),
    ]));
    expect((await workspace.inspect()).entries.markdown.exists).toBe(false);

    await expect(bundles.applyTemplate('electronics.circuit', false, preview.changes)).rejects.toThrow(/confirmation/u);
    await bundles.applyTemplate('electronics.circuit', true, preview.changes);
    expect(await readFile(workspace.entryPath('markdown'), 'utf8')).toContain('# Electronic circuit design');
    expect(await readFile(workspace.entryPath('html'), 'utf8')).toContain('<title>Electronic circuit design</title>');
  });

  it('round-trips all Design workspace files and rejects a stale apply preview', async () => {
    const sourceRoot = await temporaryWorkspace();
    const source = new DesignWorkspaceService(sourceRoot);
    await source.writeMarkdown('# Source\n');
    await source.writeHtml('<!doctype html><h1>Source</h1>');
    await source.writeFile('styles/site.css', 'h1 { color: royalblue; }\n');
    const sourceBundles = new DesignWorkspaceBundleService(source, createDefaultDesignTemplateRegistry(), 'test');
    const exported = await sourceBundles.export(new Date('2026-08-12T00:00:00.000Z'));

    const targetRoot = await temporaryWorkspace();
    const target = new DesignWorkspaceService(targetRoot);
    await target.writeFile('notes/local.txt', 'Keep me');
    const targetBundles = new DesignWorkspaceBundleService(target, createDefaultDesignTemplateRegistry(), 'test');
    const preview = await targetBundles.preview(exported.bytes);
    expect(preview.files.map(file => file.path)).toEqual(['design.html', 'design.md', 'styles/site.css']);
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: 'notes/local.txt', action: 'preserve' }));
    await writeFile(path.join(await target.ensureRoot(), 'design.md'), '# Concurrent change\n');
    await expect(targetBundles.apply(preview, true, preview.changes)).rejects.toThrow(/changed since preview/u);

    const refreshed = await targetBundles.preview(exported.bytes);
    await targetBundles.apply(refreshed, true, refreshed.changes);
    expect(await target.readAsset('styles/site.css')).toEqual(Buffer.from('h1 { color: royalblue; }\n'));
    expect(await target.readAsset('notes/local.txt')).toEqual(Buffer.from('Keep me'));
    expect((await target.readEntry('markdown')).content).toBe('# Source\n');
  });
});
