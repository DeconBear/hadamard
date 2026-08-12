import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRECTORIES = new Set([
  '.git', '.hadamard', '.next', '.nuxt', '.turbo', '.venv', 'build', 'coverage', 'dist',
  'node_modules', 'target', 'vendor',
]);

export type ProjectRuleEntry = {
  id: string;
  workPath: string;
  path: string;
  relativePath: string;
  scopePath: string;
  revision: string;
  size: number;
  content?: string;
};

function normalize(value: string): string {
  const resolved = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class ProjectRuleCatalogService {
  readonly workPaths: string[];

  constructor(workPaths: string[], private readonly maxFiles = 500) {
    this.workPaths = [...new Set(workPaths.map(candidate => path.resolve(candidate)))];
  }

  async list(includeContent = false): Promise<ProjectRuleEntry[]> {
    const results: ProjectRuleEntry[] = [];
    for (const workPath of this.workPaths) await this.scan(workPath, workPath, results, includeContent);
    return results.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(id: string): Promise<ProjectRuleEntry> {
    const entry = (await this.list(false)).find(candidate => candidate.id === id);
    if (!entry) throw new Error('Rule file was not found');
    const content = await readFile(entry.path, 'utf8');
    return { ...entry, content, revision: revision(content), size: Buffer.byteLength(content) };
  }

  async write(id: string, content: string, expectedRevision: string): Promise<ProjectRuleEntry> {
    const current = await this.read(id);
    if (current.revision !== expectedRevision) throw new Error('Rule file changed on disk; refresh before saving');
    await writeFile(current.path, content, 'utf8');
    return this.read(id);
  }

  effectiveFor(targetPath: string, entries: ProjectRuleEntry[]): ProjectRuleEntry[] {
    const target = path.resolve(targetPath);
    return entries
      .filter(entry => inside(entry.scopePath, target))
      .sort((left, right) => left.scopePath.length - right.scopePath.length);
  }

  private async scan(root: string, directory: string, output: ProjectRuleEntry[], includeContent: boolean): Promise<void> {
    if (output.length >= this.maxFiles) throw new Error(`Rule catalog exceeds ${this.maxFiles} files`);
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (output.length >= this.maxFiles) throw new Error(`Rule catalog exceeds ${this.maxFiles} files`);
      const candidate = path.join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(child.name)) await this.scan(root, candidate, output, includeContent);
        continue;
      }
      if (!child.isFile() || child.name.toLowerCase() !== 'agents.md') continue;
      const fileStat = await stat(candidate);
      const content = await readFile(candidate, 'utf8');
      const resolved = await realpath(candidate);
      const resolvedRoot = await realpath(root);
      if (!inside(resolvedRoot, resolved)) continue;
      output.push({
        id: createHash('sha256').update(normalize(candidate)).digest('hex').slice(0, 24),
        workPath: root,
        path: candidate,
        relativePath: path.relative(root, candidate) || 'AGENTS.md',
        scopePath: path.dirname(candidate),
        revision: revision(content),
        size: fileStat.size,
        ...(includeContent ? { content } : {}),
      });
    }
  }
}
