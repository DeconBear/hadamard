import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DesignWorkspaceService } from '../src/design/designWorkspaceService.js';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })));
});

describe('DesignWorkspaceService', () => {
  it('uses only the primary workspace .hadamard/design directory', async () => {
    const primary = await temporaryWorkspace('design-primary');
    const additional = await temporaryWorkspace('design-additional');
    await mkdir(path.join(additional, '.hadamard', 'design'), { recursive: true });
    await writeFile(path.join(additional, '.hadamard', 'design', 'design.md'), '# Wrong workspace\n', 'utf8');

    const service = new DesignWorkspaceService(primary);
    expect(service.rootPath()).toBe(path.join(primary, '.hadamard', 'design'));
    expect((await service.readEntry('markdown')).content).toBe('');

    const saved = await service.writeMarkdown('# Primary design\n');
    expect(saved.path).toBe(path.join(primary, '.hadamard', 'design', 'design.md'));
    expect(await readFile(saved.path, 'utf8')).toBe('# Primary design\n');
    expect(await readFile(path.join(additional, '.hadamard', 'design', 'design.md'), 'utf8'))
      .toBe('# Wrong workspace\n');
  });

  it('supports independent HTML and Markdown entries with revision checks', async () => {
    const primary = await temporaryWorkspace('design-entries');
    const service = new DesignWorkspaceService(primary);
    const empty = await service.inspect();
    expect(empty.entries.html.exists).toBe(false);
    expect(empty.entries.markdown.exists).toBe(false);

    const html = await service.writeHtml('<!doctype html><h1>HTML</h1>');
    const markdown = await service.writeMarkdown('# Markdown\n');
    expect((await service.inspect()).entries).toMatchObject({
      html: { exists: true, revision: html.revision },
      markdown: { exists: true, revision: markdown.revision },
    });
    await expect(service.writeMarkdown('# Stale\n', empty.entries.markdown.revision))
      .rejects.toThrow(/changed since/u);
  });

  it('rejects path traversal and symlinks that escape the Design root', async () => {
    const primary = await temporaryWorkspace('design-security');
    const outside = await temporaryWorkspace('design-outside');
    const service = new DesignWorkspaceService(primary);
    await service.ensureRoot();
    await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');

    expect(() => service.resolveAssetPath('../secret.txt')).toThrow(/outside/u);
    const link = path.join(service.rootPath(), 'escape');
    await symlink(outside, link, 'junction');
    await expect(service.readAsset('escape/secret.txt')).rejects.toThrow(/symlink/u);
    await expect(service.listAssets()).rejects.toThrow(/symlink/u);
  });

  it('writes nested Design assets atomically and rejects symlinked parent directories', async () => {
    const primary = await temporaryWorkspace('design-write-assets');
    const outside = await temporaryWorkspace('design-write-outside');
    const service = new DesignWorkspaceService(primary);
    const written = await service.writeFile('styles/site.css', 'body { color: black; }\n');
    expect(written.relativePath).toBe('styles/site.css');
    expect(await service.readAsset('styles/site.css')).toEqual(Buffer.from('body { color: black; }\n'));

    await symlink(outside, path.join(service.rootPath(), 'linked'), 'junction');
    await expect(service.writeFile('linked/escape.css', 'unsafe')).rejects.toThrow(/symlink/u);
  });
});
