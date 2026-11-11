import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HcNotFoundError, HcValidationError } from './store.js';

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

export interface HcPdfWord {
  text: string;
  /** normalized 0..1 coordinates relative to the page */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HcPdfPageInfo {
  page: number;
  width: number;
  height: number;
  image: string;
  words: HcPdfWord[];
}

export interface HcPdfPreview {
  pages: HcPdfPageInfo[];
}

export interface HcFileSearchResult {
  rootId: string;
  rootName: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
}

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
// Hidden is a browser affordance, not a file-system rule: show dotfiles/dotfolders.
const SKIP_NAMES = new Set(['node_modules', 'dist_electron']);

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

function decodeXmlEntity(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function runPdfTool(name: 'pdftoppm' | 'pdftotext', args: string[], timeoutMs: number): Promise<void> {
  const candidates = name === 'pdftoppm'
    ? [process.env.PDFTOPPM_PATH, 'pdftoppm', 'pdftoppm.exe']
    : [process.env.PDFTOTEXT_PATH, 'pdftotext', 'pdftotext.exe'];
  let lastError = '';
  for (const candidate of candidates.filter((value): value is string => Boolean(value))) {
    try {
      await spawnAndWait(candidate, args, timeoutMs);
      return;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
  }
  throw new HcValidationError('PDF annotation preview requires Poppler (' + name + '). ' + lastError);
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

  async create(rootId: string, relative: string, kind: 'file' | 'directory'): Promise<void> {
    if (!relative.trim()) throw new HcValidationError('A file name is required');
    const root = this.root(rootId);
    const filePath = await this.resolveForWrite(root, relative);
    const existing = await stat(filePath).catch(() => null);
    if (existing) throw new HcValidationError('A file or folder with that name already exists');
    await mkdir(path.dirname(filePath), { recursive: true });
    if (kind === 'directory') await mkdir(filePath, { recursive: true });
    else await writeFile(filePath, '', 'utf8');
  }

  async renameEntry(rootId: string, relative: string, nextName: string): Promise<void> {
    const name = nextName.trim();
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new HcValidationError('Invalid file name');
    const root = this.root(rootId);
    const source = await this.resolveExisting(root, relative);
    if (source === (await realpath(root.path))) throw new HcValidationError('Cannot rename the workspace root');
    const target = path.join(path.dirname(source), name);
    if (!target.startsWith(await realpath(root.path))) throw new HcValidationError('Path escapes workspace root');
    const existing = await stat(target).catch(() => null);
    if (existing) throw new HcValidationError('A file or folder with that name already exists');
    await rename(source, target);
  }

  async deleteEntry(rootId: string, relative: string): Promise<void> {
    if (!relative.trim()) throw new HcValidationError('Cannot delete the workspace root');
    const root = this.root(rootId);
    const target = await this.resolveExisting(root, relative);
    if (target === (await realpath(root.path))) throw new HcValidationError('Cannot delete the workspace root');
    await rm(target, { recursive: true, force: false });
  }

  async searchAll(query: string, limit = 80): Promise<HcFileSearchResult[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const results: HcFileSearchResult[] = [];
    const walk = async (root: HcFileRoot, directory: string, depth: number): Promise<void> => {
      if (results.length >= limit || depth > 8) return;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= limit) return;
        if (SKIP_NAMES.has(entry.name)) continue;
        const fullPath = path.join(directory, entry.name);
        const relative = path.relative(root.path, fullPath).split(path.sep).join('/');
        if (entry.name.toLowerCase().includes(needle) || relative.toLowerCase().includes(needle)) {
          results.push({ rootId: root.id, rootName: root.name, name: entry.name, path: relative, type: entry.isDirectory() ? 'directory' : 'file' });
        }
        if (entry.isDirectory()) await walk(root, fullPath, depth + 1);
      }
    };
    for (const root of this.roots) await walk(root, root.path, 0);
    return results.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'directory' ? -1 : 1));
  }

  async serve(rootId: string, relative: string): Promise<{ stream: ReturnType<typeof createReadStream>; type: string; size: number }> {
    const root = this.root(rootId);
    const filePath = await this.resolveExisting(root, relative);
    const info = await stat(filePath);
    if (!info.isFile()) throw new HcValidationError('Not a file');
    const type = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    return { stream: createReadStream(filePath), type, size: info.size };
  }

  async pdfPreview(rootId: string, relative: string): Promise<HcPdfPreview> {
    const root = this.root(rootId);
    const source = await this.resolveExisting(root, relative);
    if (path.extname(source).toLowerCase() !== '.pdf') throw new HcValidationError('Not a PDF file');
    const info = await stat(source);
    if (info.size > MAX_PREVIEW) throw new HcValidationError('File is too large to preview (max 64 MB)');
    const key = createHash('sha1').update(source + ':' + info.mtimeMs + ':' + info.size).digest('hex').slice(0, 20);
    const dir = path.join(this.previewDir, 'pdf-' + key);
    const metaFile = path.join(dir, 'meta.json');
    const cached = await readFile(metaFile, 'utf8').then(raw => JSON.parse(raw) as HcPdfPreview).catch(() => null);
    if (cached) return cached;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await runPdfTool('pdftoppm', ['-png', '-r', '120', '-f', '1', '-l', '50', source, path.join(dir, 'page')], 90_000);
    await runPdfTool('pdftotext', ['-bbox', '-f', '1', '-l', '50', source, path.join(dir, 'words.html')], 60_000);
    const xml = await readFile(path.join(dir, 'words.html'), 'utf8');
    const images = (await readdir(dir)).filter(name => /^page-\d+\.png$/.test(name)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    const pages: HcPdfPageInfo[] = [];
    let index = 0;
    for (const pageMatch of xml.matchAll(/<page width="([^"]+)" height="([^"]+)">([\s\S]*?)<\/page>/g)) {
      const width = Number(pageMatch[1]);
      const height = Number(pageMatch[2]);
      const words: HcPdfWord[] = [];
      for (const wordMatch of pageMatch[3]!.matchAll(/<word xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)">([\s\S]*?)<\/word>/g)) {
        const xMin = Number(wordMatch[1]);
        const yMin = Number(wordMatch[2]);
        const xMax = Number(wordMatch[3]);
        const yMax = Number(wordMatch[4]);
        const text = decodeXmlEntity(wordMatch[5] || '');
        if (!text.trim() || !width || !height) continue;
        words.push({ text, x: xMin / width, y: yMin / height, w: Math.max(0, (xMax - xMin) / width), h: Math.max(0, (yMax - yMin) / height) });
      }
      pages.push({ page: index + 1, width, height, image: images[index] || '', words });
      index += 1;
      if (index >= 50) break;
    }
    const preview: HcPdfPreview = { pages };
    await writeFile(metaFile, JSON.stringify(preview), 'utf8');
    return preview;
  }

  async pdfPage(rootId: string, relative: string, page: number): Promise<{ stream: ReturnType<typeof createReadStream>; type: string; size: number }> {
    const preview = await this.pdfPreview(rootId, relative);
    const info = preview.pages.find(item => item.page === page);
    if (!info?.image) throw new HcNotFoundError('PDF page not found');
    const root = this.root(rootId);
    const source = await this.resolveExisting(root, relative);
    const statInfo = await stat(source);
    const key = createHash('sha1').update(source + ':' + statInfo.mtimeMs + ':' + statInfo.size).digest('hex').slice(0, 20);
    const file = path.join(this.previewDir, 'pdf-' + key, info.image);
    const pageInfo = await stat(file);
    return { stream: createReadStream(file), type: 'image/png', size: pageInfo.size };
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
