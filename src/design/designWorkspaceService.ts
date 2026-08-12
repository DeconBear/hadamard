import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DESIGN_WORKSPACE_DIRECTORY = path.join('.hadamard', 'design');
export const DESIGN_HTML_FILE_NAME = 'design.html';
export const DESIGN_MARKDOWN_FILE_NAME = 'design.md';

export type DesignEntryMode = 'html' | 'markdown';

export interface DesignWorkspaceEntry {
  mode: DesignEntryMode;
  path: string;
  exists: boolean;
  revision: string;
  size: number;
  modifiedAt?: string;
}

export interface DesignWorkspaceInspection {
  primaryWorkspacePath: string;
  rootPath: string;
  entries: Record<DesignEntryMode, DesignWorkspaceEntry>;
}

export interface DesignWorkspaceAsset {
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
}

function revisionOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export class DesignWorkspaceService {
  readonly primaryWorkspacePath: string;

  constructor(primaryWorkspacePath: string) {
    this.primaryWorkspacePath = path.resolve(primaryWorkspacePath);
  }

  rootPath(): string {
    return path.join(this.primaryWorkspacePath, DESIGN_WORKSPACE_DIRECTORY);
  }

  entryPath(mode: DesignEntryMode): string {
    return path.join(
      this.rootPath(),
      mode === 'html' ? DESIGN_HTML_FILE_NAME : DESIGN_MARKDOWN_FILE_NAME,
    );
  }

  async ensureRoot(): Promise<string> {
    await mkdir(this.rootPath(), { recursive: true });
    return this.rootPath();
  }

  async inspect(): Promise<DesignWorkspaceInspection> {
    const [html, markdown] = await Promise.all([
      this.inspectEntry('html'),
      this.inspectEntry('markdown'),
    ]);
    return {
      primaryWorkspacePath: this.primaryWorkspacePath,
      rootPath: this.rootPath(),
      entries: { html, markdown },
    };
  }

  async readEntry(mode: DesignEntryMode): Promise<DesignWorkspaceEntry & { content: string }> {
    const filePath = this.entryPath(mode);
    let content = '';
    try {
      await this.assertNoSymlink(filePath);
      content = await readFile(filePath, 'utf8');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const entry = await this.inspectEntry(mode, content);
    return { ...entry, content };
  }

  async refreshEntry(mode: DesignEntryMode): Promise<DesignWorkspaceEntry & { content: string }> {
    return this.readEntry(mode);
  }

  async writeMarkdown(content: string, expectedRevision?: string): Promise<DesignWorkspaceEntry & { content: string }> {
    return this.writeEntry('markdown', content, expectedRevision);
  }

  async writeHtml(content: string, expectedRevision?: string): Promise<DesignWorkspaceEntry & { content: string }> {
    return this.writeEntry('html', content, expectedRevision);
  }

  async listAssets(): Promise<DesignWorkspaceAsset[]> {
    const root = this.rootPath();
    try {
      await this.assertNoSymlink(root);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const assets: DesignWorkspaceAsset[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Design workspace symlinks are not allowed: ${target}`);
        if (entry.isDirectory()) {
          await visit(target);
          continue;
        }
        if (!entry.isFile()) continue;
        const metadata = await stat(target);
        assets.push({
          path: target,
          relativePath: path.relative(root, target).replaceAll(path.sep, '/'),
          size: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        });
      }
    };
    await visit(root);
    return assets.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  async readAsset(relativePath: string): Promise<Buffer> {
    const target = this.resolveAssetPath(relativePath);
    await this.assertNoSymlink(target);
    return readFile(target);
  }

  resolveAssetPath(relativePath: string): string {
    if (!relativePath.trim() || path.isAbsolute(relativePath)) {
      throw new Error('Design asset path must be a non-empty relative path.');
    }
    const target = path.resolve(this.rootPath(), relativePath);
    if (!isWithin(this.rootPath(), target)) {
      throw new Error('Design asset path is outside the Design workspace.');
    }
    return target;
  }

  private async writeEntry(
    mode: DesignEntryMode,
    content: string,
    expectedRevision?: string,
  ): Promise<DesignWorkspaceEntry & { content: string }> {
    const current = await this.readEntry(mode);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new Error(`${path.basename(current.path)} changed since it was loaded. Reload before saving.`);
    }
    await this.ensureRoot();
    await this.assertNoSymlink(this.rootPath());
    await atomicWrite(this.entryPath(mode), content);
    return this.readEntry(mode);
  }

  private async inspectEntry(mode: DesignEntryMode, knownContent?: string): Promise<DesignWorkspaceEntry> {
    const filePath = this.entryPath(mode);
    try {
      await this.assertNoSymlink(filePath);
      const [content, metadata] = await Promise.all([
        knownContent === undefined ? readFile(filePath) : Promise.resolve(Buffer.from(knownContent)),
        stat(filePath),
      ]);
      return {
        mode,
        path: filePath,
        exists: true,
        revision: revisionOf(content),
        size: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
      };
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { mode, path: filePath, exists: false, revision: revisionOf(''), size: 0 };
    }
  }

  private async assertNoSymlink(targetPath: string): Promise<void> {
    const root = this.rootPath();
    if (!isWithin(root, targetPath)) throw new Error('Design path is outside the Design workspace.');
    const relative = path.relative(root, targetPath);
    const segments = relative ? relative.split(path.sep) : [];
    let current = root;
    for (let index = -1; index < segments.length; index += 1) {
      if (index >= 0) current = path.join(current, segments[index]!);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) throw new Error(`Design workspace symlinks are not allowed: ${current}`);
      } catch (error) {
        if (isMissing(error)) throw error;
        throw error;
      }
    }
    try {
      const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(targetPath)]);
      if (!isWithin(realRoot, realTarget)) throw new Error('Design path resolves outside the Design workspace.');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}
