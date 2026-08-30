import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';

import {
  buildPathTree,
  gitStatusBadge,
  parseGitCommitLog,
  readWorkspaceFile,
  splitGitStatus,
  writeWorkspaceFile,
} from '../src/gui/projectWorkbench.js';
import { createHadamardGuiClientScript } from '../src/gui/hadamardGuiAssets.js';

describe('projectWorkbench helpers', () => {
  it('splits porcelain status into staged and unstaged', () => {
    const split = splitGitStatus([
      { x: 'M', y: '', file: 'staged.ts' },
      { x: '', y: 'M', file: 'unstaged.ts' },
      { x: 'M', y: 'M', file: 'both.ts' },
      { x: '?', y: '?', file: 'new.ts' },
    ]);
    expect(split.staged.map((e) => e.file)).toEqual(['staged.ts', 'both.ts']);
    expect(split.unstaged.map((e) => e.file)).toEqual(['unstaged.ts', 'both.ts', 'new.ts']);
  });

  it('builds a path tree with dirs before files', () => {
    const tree = buildPathTree([
      { file: 'src/a.ts', badge: 'M' },
      { file: 'src/util/b.ts', badge: 'A' },
      { file: 'readme.md', badge: 'M' },
    ]);
    expect(tree.map((n) => n.name)).toEqual(['src', 'readme.md']);
    expect(tree[0]?.kind).toBe('dir');
    expect(tree[0]?.children?.map((n) => n.name)).toEqual(['util', 'a.ts']);
    expect(tree[0]?.children?.[0]?.children?.[0]).toMatchObject({
      name: 'b.ts',
      relPath: 'src/util/b.ts',
      badge: 'A',
      kind: 'file',
    });
  });

  it('picks status badges for staged and unstaged sides', () => {
    expect(gitStatusBadge({ x: 'A', y: '', file: 'a' }, 'staged')).toBe('A');
    expect(gitStatusBadge({ x: '', y: 'D', file: 'a' }, 'unstaged')).toBe('D');
    expect(gitStatusBadge({ x: '?', y: '?', file: 'a' }, 'unstaged')).toBe('U');
  });

  it('parses enriched git log records with refs and dates', () => {
    const raw = [
      'abc123\x1fFix login\x1fAda\x1fada@ex.com\x1f2 hours ago\x1f2026-07-11T12:00:00+08:00\x1fdef456 ghi789\x1fHEAD -> main, origin/main, tag: v1.2.0\x1e',
      'def456\x1fBase\x1fBob\x1fbob@ex.com\x1f1 day ago\x1f2026-07-10T09:00:00+08:00\x1f\x1f\x1e',
    ].join('');
    const commits = parseGitCommitLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      hash: 'abc123',
      subject: 'Fix login',
      author: 'Ada',
      authorEmail: 'ada@ex.com',
      relativeDate: '2 hours ago',
      absoluteDate: '2026-07-11T12:00:00+08:00',
      date: '2 hours ago',
      parents: ['def456', 'ghi789'],
    });
    expect(commits[0]?.refs).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'main', kind: 'local' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v1.2.0', kind: 'tag' },
    ]);
    expect(commits[1]?.parents).toEqual([]);
  });

  it('reads workspace files and rejects path escape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-files-'));
    const file = path.join(root, 'hello.txt');
    await writeFile(file, 'hello world', 'utf8');
    const ok = await readWorkspaceFile(file, root);
    expect(ok.text).toBe('hello world');
    expect(ok.binary).toBeUndefined();

    await expect(
      readWorkspaceFile(path.join(root, '..', 'outside.txt'), root),
    ).rejects.toThrow(/escapes workspace/);
  });

  it('marks binary files without returning text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-bin-'));
    const file = path.join(root, 'blob.bin');
    await writeFile(file, Buffer.from([0, 1, 2, 3, 4, 255, 0, 9]));
    const result = await readWorkspaceFile(file, root);
    expect(result.binary).toBe(true);
    expect(result.text).toBeUndefined();
  });

  it('returns an image data URL preview for PNG files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-img-'));
    const file = path.join(root, 'pixel.png');
    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(file, png);
    const result = await readWorkspaceFile(file, root);
    expect(result.binary).toBeUndefined();
    expect(result.image?.mediaType).toBe('image/png');
    expect(result.image?.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.size).toBe(png.length);
  });

  it('ships hidden-dotfile listing and image preview wiring in the GUI', async () => {
    const src = await readFile(new URL('../src/gui/hadamardGui.ts', import.meta.url), 'utf8');
    const assets = await readFile(new URL('../src/gui/hadamardGuiAssets.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(
      /if \(entry\.name\.startsWith\('\.'\) && entry\.name !== '\.hadamard'\) continue;/,
    );
    expect(src).toContain("...(entry.name.startsWith('.') ? { hidden: true } : {})");
    expect(assets).toContain('files-image-preview');
    expect(assets).toContain('hidden-entry');
    expect(assets).toContain('data.image');
  });

  it('writes text files only within the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-write-'));
    const file = path.join(root, 'hello.txt');
    await writeFile(file, 'before', 'utf8');

    await expect(writeWorkspaceFile(file, 'after', root)).resolves.toMatchObject({
      path: file,
      size: 5,
    });
    await expect(readFile(file, 'utf8')).resolves.toBe('after');
    await expect(writeWorkspaceFile('hello.txt', 'relative-ok', root)).resolves.toMatchObject({
      size: Buffer.byteLength('relative-ok', 'utf8'),
    });
    await expect(readFile(file, 'utf8')).resolves.toBe('relative-ok');
    await expect(
      writeWorkspaceFile(path.join(root, '..', 'outside.txt'), 'nope', root),
    ).rejects.toThrow(/escapes workspace/);
  });

  it('reads declaration files as editable text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-dts-'));
    const file = path.join(root, 'hadamardSettingsStore.d.ts');
    await writeFile(file, 'export declare const x: number;\n', 'utf8');
    const ok = await readWorkspaceFile(file, root);
    expect(ok.binary).toBeUndefined();
    expect(ok.text).toContain('export declare');
  });

  it('refuses writes to binary workspace files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-write-bin-'));
    const file = path.join(root, 'blob.bin');
    await writeFile(file, Buffer.from([0, 1, 2, 3, 4, 255, 0, 9]));

    await expect(writeWorkspaceFile(file, 'nope', root)).rejects.toThrow(/binary file/);
  });

  it('gui source wires the four project tabs and shared workbench tools', async () => {
    const src = await readFile(new URL('../src/gui/hadamardGui.ts', import.meta.url), 'utf8');
    const assets = await readFile(new URL('../src/gui/hadamardGuiAssets.ts', import.meta.url), 'utf8');
    expect(assets).toContain("['document', 'Document']");
    expect(assets).toContain("['issues', 'Issues']");
    expect(assets).toContain("['agents', 'Agent monitor']");
    expect(assets).toContain("['settings', 'Project settings']");
    expect(assets).toContain('data-aux="review"');
    expect(assets).toContain('data-aux="git"');
    expect(assets).toContain('data-aux="terminal"');
    expect(assets).toContain('data-aux="browser"');
    expect(assets).toContain('data-aux="files"');
    expect(assets).toContain('function renderProjectFilesPanel');
    expect(assets).toContain('function renderProjectGitPanel');
    expect(assets).toContain('function mountProjectTerminal');
    expect(assets).toContain('/api/workspace-file');
    expect(assets).toContain('function saveFilesPreview');
    expect(assets).toContain("method: 'PUT'");
    expect(assets).toContain('detectEditorLanguage');
    expect(assets).toContain('highlightCode');
    expect(assets).toContain('files-preview-modes');
    expect(assets).toContain('files-hl-overlay');
    expect(assets).toContain('files-md-preview');
    expect(assets).toContain('position: absolute; inset: 0');
    expect(assets).toMatch(/\.files-preview-editor[^}]*overflow:\s*auto/);
    expect(assets).toContain('files-image-preview');
    expect(assets).toContain('hidden-entry');
    expect(assets).toContain('data.image');
    expect(src).toContain('/api/git/diff');
    expect(assets).toContain('.project-files-split');
    expect(assets).toContain('.project-git-split');
    expect(assets).toContain('.tree-row');
    expect(src).toContain('parseGitCommitLog');
    expect(assets).toContain('.git-history-ref');
    expect(assets).toContain('.git-history-graph');
    expect(assets).toContain('relativeDate');
    expect(assets).toContain('history: false');
  });

  it('ships a wider auxiliary file pane with Markdown and sandboxed HTML previews', async () => {
    const assets = await readFile(new URL('../src/gui/hadamardGuiAssets.ts', import.meta.url), 'utf8');
    const client = createHadamardGuiClientScript();
    const editor = client.slice(
      client.indexOf('function workspaceHtmlPreviewDocument'),
      client.indexOf('function renderComposerMeta'),
    );

    expect(() => new Function(client)).not.toThrow();
    expect(client).toContain('const AUX_PANEL_MAX_WIDTH = 1600');
    expect(client).toContain('const AUX_PRIMARY_MIN_WIDTH = 360');
    expect(client).toContain('Math.floor(bounds.width - AUX_PRIMARY_MIN_WIDTH)');
    expect(assets).toMatch(/\.aux-panel[^}]*max-width:\s*min\(82vw, 1600px\)/);
    expect(editor).toContain("for (const mode of ['source', 'preview'])");
    expect(editor).toContain("mode === 'source' ? 'Source' : 'Preview'");
    expect(editor).toContain("previewKind === 'markdown'");
    expect(editor).toContain("renderMarkdownInto(renderedPreview, editor.value)");
    expect(editor).toContain("renderedPreview.setAttribute('sandbox', '')");
    expect(editor).toContain("renderedPreview.setAttribute('referrerpolicy', 'no-referrer')");
    expect(editor).toContain("script-src 'none'");
    expect(editor).toContain("connect-src 'none'");
    expect(editor).toContain("parsed.querySelectorAll('script, iframe, object, embed, base, link, meta[http-equiv]')");
  });
});
