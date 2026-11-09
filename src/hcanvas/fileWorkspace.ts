import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HcValidationError } from './store.js';

export interface HcFileRoot {
  id: string;
  name: string;
  path: string;
}

export interface HcFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  ext?: string;
  size?: number;
  modified?: number;
}

export type HcFilePreview = 'text' | 'image' | 'pdf' | 'office' | 'binary';

export interface HcFileContent {
  path: string;
  name: string;
  ext: string;
  size: number;
  binary: boolean;
  content: string;
  language: string;
  preview: HcFilePreview;
}

const MAX_EDITABLE = 4 * 1024 * 1024;
const MAX_PREVIEW = 64 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.rtf', '.ppt', '.pptx', '.odp', '.xls', '.xlsx', '.ods']);
const SKIP_NAMES = new Set(['.git', 'node_modules', '.hcanvas', 'dist_electron']);

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'css', '.less': 'css', '.md': 'markdown', '.markdown': 'markdown',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.sql': 'sql', '.xml': 'xml', '.svg': 'xml', '.php': 'php', '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.cs': 'csharp', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.dart': 'dart', '.swift': 'swift', '.rb': 'ruby', '.lua': 'lua', '.pl': 'perl', '.ps1': 'powershell', '.r': 'r',
  '.dockerfile': 'dockerfile', '.toml': 'toml', '.ini': 'ini', '.txt': 'text', '.log': 'text', '.vue': 'html', '.svelte': 'html',
};

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

function languageFor(filePath: string): string {
  return LANGUAGE_BY_EXT[path.extname(filePath).toLowerCase()] || 'text';
}

function previewFor(filePath: string): HcFilePreview {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  return 'text';
}

function spawnAndWait(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('LibreOffice conversion timed out'));
    }, timeoutMs);
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || 'LibreOffice exited with code ' + code));
    });
  });
}

export class HcFileService {
  private roots: HcFileRoot[] = [];
  private readonly rootsFile: string;
  private readonly previewDir: string;
  private officeJobs = new Map<string, Promise<string>>();

  constructor(private readonly workspaceDir: string) {
    this.rootsFile = path.join(workspaceDir, 'file-roots.json');
    this.previewDir = path.join(workspaceDir, 'previews');
  }

  async init(): Promise<void> {
    await mkdir(this.workspaceDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.rootsFile, 'utf8')) as { roots?: HcFileRoot[] };
      this.roots = (parsed.roots || []).filter(root => root && root.id && root.path);
    } catch { /* no persisted roots */ }
    const defaultRoot = path.basename(this.workspaceDir) === '.hcanvas' ? path.dirname(this.workspaceDir) : this.workspaceDir;
    if (!this.roots.length) {
      this.roots.push({ id: 'root_default', name: path.basename(defaultRoot) || 'Workspace', path: defaultRoot });
      await this.persist();
    }
  }

  listRoots(): HcFileRoot[] {
    return this.roots.map(root => ({ ...root }));
  }

  async addRoot(rawPath: string): Promise<HcFileRoot> {
    if (!rawPath || !rawPath.trim()) throw new HcValidationError('Folder path is required');
    const resolved = await realpath(path.resolve(rawPath));
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new HcValidationError('Path is not a directory');
    const existing = this.roots.find(root => path.resolve(root.path) === path.resolve(resolved));
    if (existing) return { ...existing };
    const root: HcFileRoot = { id: 'root_' + randomUUID().replace(/-/g, '').slice(0, 12), name: path.basename(resolved) || resolved, path: resolved };
    this.roots.push(root);
    await this.persist();
    return { ...root };
  }

  async removeRoot(id: string): Promise<void> {
    this.roots = this.roots.filter(root => root.id !== id);
    if (!this.roots.length) {
      const fallback = path.basename(this.workspaceDir) === '.hcanvas' ? path.dirname(this.workspaceDir) : this.workspaceDir;
      this.roots.push({ id: 'root_default', name: path.basename(fallback) || 'Workspace', path: fallback });
    }
    await this.persist();
  }

  async list(rootId: string, relative = ''): Promise<HcFileEntry[]> {
    const root = this.root(rootId);
    const directory = await this.resolveExisting(root, relative || '.');
    const info = await stat(directory);
    if (!info.isDirectory()) throw new HcValidationError('Not a directory');
    const entries = await readdir(directory, { withFileTypes: true });
    const result: HcFileEntry[] = [];
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const childPath = path.join(directory, entry.name);
      const childRelative = path.relative(root.path, childPath).split(path.sep).join('/');
      const childInfo = await stat(childPath).catch(() => null);
      if (!childInfo) continue;
      result.push({
        name: entry.name,
        path: childRelative,
        type: entry.isDirectory() ? 'directory' : 'file',
        ...(entry.isDirectory() ? {} : { ext: path.extname(entry.name).toLowerCase(), size: childInfo.size }),
        modified: childInfo.mtimeMs,
      });
    }
    return result.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  }

  async read(rootId: string, relative: string): Promise<HcFileContent> {
    const root = this.root(rootId);
    const filePath = await this.resolveExisting(root, relative);
    const info = await stat(filePath);
    if (!info.isFile()) throw new HcValidationError('Not a file');
    const ext = path.extname(filePath).toLowerCase();
    const preview = previewFor(filePath);
    if (info.size > MAX_PREVIEW) throw new HcValidationError('File is too large to preview (max 64 MB)');
    if (preview === 'text' && info.size > MAX_EDITABLE) throw new HcValidationError('File is too large to edit (max 4 MB)');
    const buffer = preview === 'text' ? await readFile(filePath) : Buffer.alloc(0);
    const binary = preview !== 'text' || buffer.includes(0);
    const resolvedPreview: HcFilePreview = preview === 'text' && binary ? 'binary' : preview;
    return {
      path: relative,
      name: path.basename(filePath),
      ext,
      size: info.size,
      binary,
      content: binary ? '' : buffer.toString('utf8'),
      language: preview === 'text' ? languageFor(filePath) : ext.replace(/^\./, '') || 'file',
      preview: resolvedPreview,
    };
  }

  async write(rootId: string, relative: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE) throw new HcValidationError('File is too large to save (max 4 MB)');
    const root = this.root(rootId);
    const filePath = await this.resolveForWrite(root, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }

  async serve(rootId: string, relative: string): Promise<{ stream: ReturnType<typeof createReadStream>; type: string; size: number }> {
    const root = this.root(rootId);
    const filePath = await this.resolveExisting(root, relative);
    const info = await stat(filePath);
    if (!info.isFile()) throw new HcValidationError('Not a file');
    const type = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    return { stream: createReadStream(filePath), type, size: info.size };
  }

  async officePreviewPdf(rootId: string, relative: string): Promise<{ stream: ReturnType<typeof createReadStream>; type: string; size: number }> {
    const root = this.root(rootId);
    const source = await this.resolveExisting(root, relative);
    const ext = path.extname(source).toLowerCase();
    if (!OFFICE_EXTENSIONS.has(ext)) throw new HcValidationError('Office preview is available for Word, PowerPoint and Excel files');
    const info = await stat(source);
    if (info.size > MAX_PREVIEW) throw new HcValidationError('File is too large to preview (max 64 MB)');
    const pdfPath = await this.convertOfficeToPdf(source, info.mtimeMs, info.size);
    const pdfInfo = await stat(pdfPath);
    return { stream: createReadStream(pdfPath), type: 'application/pdf', size: pdfInfo.size };
  }

  private async convertOfficeToPdf(source: string, mtimeMs: number, size: number): Promise<string> {
    const key = createHash('sha1').update(source + ':' + mtimeMs + ':' + size).digest('hex').slice(0, 20);
    const target = path.join(this.previewDir, key + '.pdf');
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile()) return target;
    const pending = this.officeJobs.get(key);
    if (pending) return pending;
    const job = this.runOfficeConversion(source, key, target);
    this.officeJobs.set(key, job);
    try { return await job; } finally { this.officeJobs.delete(key); }
  }

  private async runOfficeConversion(source: string, key: string, target: string): Promise<string> {
    await mkdir(this.previewDir, { recursive: true });
    const outDir = path.join(this.previewDir, 'out-' + key);
    const profileDir = path.join(this.previewDir, 'profile-' + key);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const args = [
      '-env:UserInstallation=' + pathToFileURL(profileDir).href,
      '--headless',
      '--norestore',
      '--convert-to',
      'pdf',
      '--outdir',
      outDir,
      source,
    ];
    const candidates = [
      process.env.LIBREOFFICE_PATH,
      process.env.SOFFICE_PATH,
      'soffice.com',
      'soffice',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LibreOffice', 'program', 'soffice.com'),
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/bin/soffice',
    ].filter((value): value is string => Boolean(value));
    let lastError = '';
    for (const candidate of candidates) {
      try {
        await spawnAndWait(candidate, args, 90_000);
        const files = await readdir(outDir);
        const pdf = files.find(file => file.toLowerCase().endsWith('.pdf'));
        if (!pdf) throw new Error('LibreOffice did not produce a PDF');
        const generated = path.join(outDir, pdf);
        await rm(target, { force: true });
        await writeFile(target, await readFile(generated));
        await rm(outDir, { recursive: true, force: true });
        await rm(profileDir, { recursive: true, force: true });
        return target;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new HcValidationError('Office preview requires LibreOffice (soffice). ' + lastError);
  }

  private root(id: string): HcFileRoot {
    const root = this.roots.find(item => item.id === id);
    if (!root) throw new HcValidationError('File root not found');
    return root;
  }

  private async resolveExisting(root: HcFileRoot, relative: string): Promise<string> {
    const rootReal = await realpath(root.path);
    const target = path.resolve(rootReal, relative || '.');
    if (target !== rootReal && !target.startsWith(rootReal + path.sep)) throw new HcValidationError('Path escapes workspace root');
    const real = await realpath(target);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new HcValidationError('Path escapes workspace root');
    return real;
  }

  private async resolveForWrite(root: HcFileRoot, relative: string): Promise<string> {
    const rootReal = await realpath(root.path);
    const target = path.resolve(rootReal, relative);
    if (!target.startsWith(rootReal + path.sep)) throw new HcValidationError('Path escapes workspace root');
    return target;
  }

  private async persist(): Promise<void> {
    await writeFile(this.rootsFile, JSON.stringify({ roots: this.roots }, null, 2), 'utf8');
  }
}
