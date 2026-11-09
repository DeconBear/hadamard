import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HcFileService } from '../src/hcanvas/fileWorkspace.js';

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-files-'));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('HcFileService', () => {
  it('seeds the project root and lists files without node_modules', async () => {
    const project = await tempDir();
    const workspace = path.join(project, '.hcanvas');
    await mkdir(path.join(project, 'src'), { recursive: true });
    await mkdir(path.join(project, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(project, 'README.md'), '# Hello');
    await writeFile(path.join(project, 'src', 'main.ts'), 'export const x = 1;');
    const service = new HcFileService(workspace);
    await service.init();
    const roots = service.listRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0]!.path).toBe(project);
    const entries = await service.list(roots[0]!.id);
    expect(entries.map(entry => entry.name)).toContain('README.md');
    expect(entries.map(entry => entry.name)).toContain('src');
    expect(entries.map(entry => entry.name)).not.toContain('node_modules');
  });

  it('reads, writes, and classifies text files', async () => {
    const project = await tempDir();
    const service = new HcFileService(path.join(project, '.hcanvas'));
    await service.init();
    const root = service.listRoots()[0]!;
    await writeFile(path.join(project, 'note.md'), '# old');
    const content = await service.read(root.id, 'note.md');
    expect(content.language).toBe('markdown');
    expect(content.content).toBe('# old');
    await service.write(root.id, 'note.md', '# new');
    expect(await readFile(path.join(project, 'note.md'), 'utf8')).toBe('# new');
    expect((await service.read(root.id, 'note.md')).content).toBe('# new');
  });

  it('supports multiple roots and rejects path escapes', async () => {
    const project = await tempDir();
    const extra = await tempDir();
    await writeFile(path.join(extra, 'outside.md'), '# outside');
    const escapePath = path.join(extra, '..', path.basename(extra) + '-escape.md');
    await writeFile(escapePath, '# escape');
    const service = new HcFileService(path.join(project, '.hcanvas'));
    await service.init();
    const added = await service.addRoot(extra);
    expect(service.listRoots().map(root => root.id)).toContain(added.id);
    expect((await service.list(added.id)).map(entry => entry.name)).toContain('outside.md');
    await expect(service.read(added.id, '../' + path.basename(extra) + '-escape.md')).rejects.toThrow(/escapes workspace/);
    await rm(escapePath, { force: true });
    await service.removeRoot(added.id);
    expect(service.listRoots().map(root => root.id)).not.toContain(added.id);
  });

  it('rejects binary and oversized files', async () => {
    const project = await tempDir();
    const service = new HcFileService(path.join(project, '.hcanvas'));
    await service.init();
    const root = service.listRoots()[0]!;
    await writeFile(path.join(project, 'bin.dat'), Buffer.from([0, 1, 2]));
    expect((await service.read(root.id, 'bin.dat')).binary).toBe(true);
    await writeFile(path.join(project, 'big.txt'), 'x'.repeat(5 * 1024 * 1024));
    await expect(service.read(root.id, 'big.txt')).rejects.toThrow(/too large/);
  });
});
