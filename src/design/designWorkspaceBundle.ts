import { createHash } from 'node:crypto';
import path from 'node:path';

import { decodeZip, encodeZip, type ZipEntry } from './zipCodec.js';
import type { DesignTemplate, DesignTemplateRegistry } from './designTemplateRegistry.js';
import type { DesignWorkspaceService } from './designWorkspaceService.js';

export interface DesignWorkspaceBundleFile {
  path: string;
  mediaType: string;
  bytes: Buffer;
  sha256: string;
}

export interface DesignWorkspaceFileChange {
  path: string;
  action: 'add' | 'overwrite' | 'unchanged' | 'preserve';
  beforeRevision?: string;
  afterRevision: string;
}

export interface DesignWorkspaceBundlePreview {
  kind: 'hadamard-workspace-bundle';
  editable: true;
  checksum: string;
  warnings: string[];
  files: DesignWorkspaceBundleFile[];
  changes: DesignWorkspaceFileChange[];
}

export interface DesignWorkspaceBundleExport {
  fileName: 'design.hadamard-design.zip';
  mediaType: 'application/vnd.hadamard.design-workspace+zip';
  bytes: Buffer;
  checksum: string;
}

export interface DesignTemplateBundleSummary {
  id: string;
  version: number;
  name: string;
  description: string;
  category: string;
  entries: Array<'markdown' | 'html'>;
  thumbnail: string;
}

const MANIFEST_NAME = 'manifest.json';
const CHECKSUMS_NAME = 'checksums.sha256';
const FILE_PREFIX = 'files/';
const MAX_FILES = 128;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mediaType(filePath: string): string {
  const extension = path.posix.extname(filePath).toLowerCase();
  return ({
    '.css': 'text/css', '.gif': 'image/gif', '.html': 'text/html', '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json',
    '.md': 'text/markdown', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)
    || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe Design bundle path: ${value}`);
  }
  return normalized;
}

function parseChecksums(bytes: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of bytes.toString('utf8').split(/\r?\n/u)) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})  (.+)$/u);
    if (!match || result.has(match[2]!)) throw new Error('Design bundle checksum file is invalid.');
    result.set(match[2]!, match[1]!);
  }
  return result;
}

function templateCategory(template: DesignTemplate): string {
  if (template.id.startsWith('software.')) return 'Software engineering';
  if (template.id.startsWith('ai4s.')) return 'AI for Science';
  if (template.id.startsWith('ml.')) return 'Machine learning';
  if (template.id.startsWith('math.')) return 'Mathematical modeling';
  if (template.id.startsWith('electronics.')) return 'Electronic design';
  return 'Other';
}

function templateTitle(template: DesignTemplate): string {
  return `# ${template.name} design\n\n${template.description}\n\n`;
}

function templateMarkdown(template: DesignTemplate, registry: DesignTemplateRegistry): string {
  return templateTitle(template) + registry.createMarkdown(template.id);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function templateHtml(template: DesignTemplate): string {
  const sections = template.sections.map(item => `
      <section>
        <span class="eyebrow">${escapeHtml(item.id.replaceAll('-', ' '))}</span>
        <h2>${escapeHtml(item.title)}</h2>
        <p>${escapeHtml(item.prompt)}</p>
      </section>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(template.name)} design</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f5f7fb; }
    body { margin: 0; }
    main { width: min(980px, calc(100% - 48px)); margin: 0 auto; padding: 72px 0 96px; }
    header { padding: 48px; border-radius: 28px; background: linear-gradient(135deg, #172033, #3658d4); color: white; box-shadow: 0 24px 70px #17203324; }
    header p { color: #dce4ff; font-size: 18px; line-height: 1.7; max-width: 720px; }
    h1 { margin: 0 0 16px; font-size: clamp(38px, 7vw, 72px); letter-spacing: -.055em; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; margin-top: 24px; }
    section { padding: 26px; border: 1px solid #e1e6f0; border-radius: 20px; background: white; box-shadow: 0 10px 34px #1720330a; }
    section h2 { margin: 7px 0 10px; font-size: 20px; }
    section p { margin: 0; color: #61708a; line-height: 1.6; }
    .eyebrow { color: #3658d4; font-size: 11px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
  </style>
</head>
<body>
  <main>
    <header><span class="eyebrow">${escapeHtml(templateCategory(template))}</span><h1>${escapeHtml(template.name)}</h1><p>${escapeHtml(template.description)}</p></header>
    <div class="grid">${sections}
    </div>
  </main>
</body>
</html>
`;
}

function templateThumbnail(template: DesignTemplate): string {
  const label = escapeHtml(template.name.slice(0, 28));
  const category = escapeHtml(templateCategory(template));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#172033"/><stop offset="1" stop-color="#4968df"/></linearGradient></defs><rect width="640" height="400" rx="28" fill="#f5f7fb"/><rect x="28" y="28" width="584" height="160" rx="22" fill="url(#g)"/><text x="60" y="72" fill="#cfd8ff" font-family="system-ui" font-size="16">${category}</text><text x="60" y="128" fill="white" font-family="system-ui" font-size="34" font-weight="700">${label}</text><g fill="white" stroke="#dfe5f0"><rect x="28" y="210" width="180" height="142" rx="18"/><rect x="230" y="210" width="180" height="142" rx="18"/><rect x="432" y="210" width="180" height="142" rx="18"/></g><g fill="#3155d5"><rect x="52" y="238" width="64" height="8" rx="4"/><rect x="254" y="238" width="64" height="8" rx="4"/><rect x="456" y="238" width="64" height="8" rx="4"/></g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function templateFiles(template: DesignTemplate, registry: DesignTemplateRegistry): DesignWorkspaceBundleFile[] {
  return [
    { path: 'design.md', mediaType: 'text/markdown', bytes: Buffer.from(templateMarkdown(template, registry)), sha256: '' },
    { path: 'design.html', mediaType: 'text/html', bytes: Buffer.from(templateHtml(template)), sha256: '' },
  ].map(file => ({ ...file, sha256: sha256(file.bytes) }));
}

export class DesignWorkspaceBundleService {
  constructor(
    private readonly workspace: DesignWorkspaceService,
    private readonly templates: DesignTemplateRegistry,
    private readonly generatorVersion = '0.4.15',
  ) {}

  listTemplates(): DesignTemplateBundleSummary[] {
    return this.templates.list().map(template => ({
      id: template.id,
      version: template.version,
      name: template.name,
      description: template.description,
      category: templateCategory(template),
      entries: ['markdown', 'html'],
      thumbnail: templateThumbnail(template),
    }));
  }

  templatePreview(id: string): { template: DesignTemplateBundleSummary; html: string; markdown: string; changes: DesignWorkspaceFileChange[] } {
    const selected = this.templates.get(id);
    if (!selected) throw new Error(`Unknown Design template: ${id}`);
    const summary = this.listTemplates().find(item => item.id === id)!;
    const files = templateFiles(selected, this.templates);
    return {
      template: summary,
      html: files.find(file => file.path === 'design.html')!.bytes.toString('utf8'),
      markdown: files.find(file => file.path === 'design.md')!.bytes.toString('utf8'),
      changes: [],
    };
  }

  async previewTemplateApply(id: string): Promise<ReturnType<DesignWorkspaceBundleService['templatePreview']>> {
    const preview = this.templatePreview(id);
    const selected = this.templates.get(id)!;
    return { ...preview, changes: await this.changesFor(templateFiles(selected, this.templates)) };
  }

  async applyTemplate(
    id: string,
    confirmed: boolean,
    expectedChanges?: readonly DesignWorkspaceFileChange[],
  ): Promise<DesignWorkspaceFileChange[]> {
    if (!confirmed) throw new Error('Template application requires confirmation.');
    const selected = this.templates.get(id);
    if (!selected) throw new Error(`Unknown Design template: ${id}`);
    const files = templateFiles(selected, this.templates);
    const changes = await this.changesFor(files);
    this.assertUnchanged(changes, expectedChanges);
    for (const file of files) await this.workspace.writeFile(file.path, file.bytes);
    return changes;
  }

  async export(now = new Date()): Promise<DesignWorkspaceBundleExport> {
    const listed = await this.workspace.listAssets();
    const files = await Promise.all(listed.map(async item => {
      const bytes = await this.workspace.readAsset(item.relativePath);
      return { path: item.relativePath, mediaType: mediaType(item.relativePath), bytes, sha256: sha256(bytes) };
    }));
    this.assertFiles(files);
    const manifest = {
      schemaVersion: 1,
      kind: 'hadamard-design-workspace',
      exportedAt: now.toISOString(),
      generator: { name: 'Hadamard', version: this.generatorVersion },
      resources: files.map(file => ({ path: file.path, mediaType: file.mediaType, size: file.bytes.length, sha256: file.sha256 })),
    };
    const entries: ZipEntry[] = [
      { name: MANIFEST_NAME, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      ...files.map(file => ({ name: FILE_PREFIX + file.path, data: file.bytes })),
    ];
    const checksums = entries.map(entry => `${sha256(entry.data)}  ${entry.name}`).sort().join('\n') + '\n';
    entries.push({ name: CHECKSUMS_NAME, data: Buffer.from(checksums) });
    const bytes = encodeZip(entries);
    return { fileName: 'design.hadamard-design.zip', mediaType: 'application/vnd.hadamard.design-workspace+zip', bytes, checksum: sha256(bytes) };
  }

  async preview(bytes: Buffer): Promise<DesignWorkspaceBundlePreview> {
    const entries = decodeZip(bytes);
    const manifestBytes = entries.get(MANIFEST_NAME);
    const checksumsBytes = entries.get(CHECKSUMS_NAME);
    if (!manifestBytes || !checksumsBytes) throw new Error('Design workspace bundle metadata is missing.');
    const raw = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
    if (raw.schemaVersion !== 1 || raw.kind !== 'hadamard-design-workspace' || !Array.isArray(raw.resources)) {
      throw new Error('Not a Hadamard Design workspace bundle.');
    }
    const checksums = parseChecksums(checksumsBytes);
    for (const [name, entry] of entries) {
      if (name === CHECKSUMS_NAME) continue;
      if (checksums.get(name) !== sha256(entry)) throw new Error(`Design bundle checksum mismatch: ${name}`);
    }
    if (checksums.size !== entries.size - 1) throw new Error('Design bundle checksum coverage is incomplete.');
    const files = (raw.resources as Array<Record<string, unknown>>).map(resource => {
      if (typeof resource.path !== 'string' || typeof resource.mediaType !== 'string'
        || typeof resource.size !== 'number' || typeof resource.sha256 !== 'string') {
        throw new Error('Design bundle resource is invalid.');
      }
      const relativePath = safeRelativePath(resource.path);
      const data = entries.get(FILE_PREFIX + relativePath);
      if (!data || data.length !== resource.size || sha256(data) !== resource.sha256) {
        throw new Error(`Design bundle resource mismatch: ${relativePath}`);
      }
      return { path: relativePath, mediaType: resource.mediaType, bytes: Buffer.from(data), sha256: resource.sha256 };
    });
    this.assertFiles(files);
    if (entries.size !== files.length + 2) throw new Error('Design bundle contains undeclared files.');
    return { kind: 'hadamard-workspace-bundle', editable: true, checksum: sha256(bytes), warnings: [], files, changes: await this.changesFor(files) };
  }

  async apply(
    preview: DesignWorkspaceBundlePreview,
    confirmed: boolean,
    expectedChanges?: readonly DesignWorkspaceFileChange[],
  ): Promise<DesignWorkspaceFileChange[]> {
    if (!confirmed) throw new Error('Design bundle import requires confirmation.');
    const currentChanges = await this.changesFor(preview.files);
    this.assertUnchanged(currentChanges, expectedChanges);
    for (const file of preview.files) await this.workspace.writeFile(file.path, file.bytes);
    return currentChanges;
  }

  private async changesFor(files: readonly DesignWorkspaceBundleFile[]): Promise<DesignWorkspaceFileChange[]> {
    const existing = new Map((await this.workspace.listAssets()).map(item => [item.relativePath, item]));
    const incoming = new Set(files.map(file => file.path));
    const changes = await Promise.all(files.map(async file => {
      const current = existing.get(file.path);
      if (!current) return { path: file.path, action: 'add' as const, afterRevision: file.sha256 };
      const beforeRevision = sha256(await this.workspace.readAsset(file.path));
      return { path: file.path, action: beforeRevision === file.sha256 ? 'unchanged' as const : 'overwrite' as const, beforeRevision, afterRevision: file.sha256 };
    }));
    const preserved = await Promise.all([...existing.keys()].filter(filePath => !incoming.has(filePath)).map(async filePath => {
      const beforeRevision = sha256(await this.workspace.readAsset(filePath));
      return { path: filePath, action: 'preserve' as const, beforeRevision, afterRevision: beforeRevision };
    }));
    return [...changes, ...preserved].sort((left, right) => left.path.localeCompare(right.path));
  }

  private assertFiles(files: readonly DesignWorkspaceBundleFile[]): void {
    if (files.length > MAX_FILES) throw new Error(`Design bundle exceeds ${MAX_FILES} files.`);
    let total = 0;
    const paths = new Set<string>();
    for (const file of files) {
      const relativePath = safeRelativePath(file.path);
      if (paths.has(relativePath)) throw new Error(`Duplicate Design bundle path: ${relativePath}`);
      paths.add(relativePath);
      if (file.bytes.length > MAX_FILE_BYTES) throw new Error(`Design bundle file exceeds 10 MiB: ${relativePath}`);
      total += file.bytes.length;
    }
    if (total > MAX_TOTAL_BYTES) throw new Error('Design bundle exceeds 20 MiB expanded.');
  }

  private assertUnchanged(
    current: readonly DesignWorkspaceFileChange[],
    expected?: readonly DesignWorkspaceFileChange[],
  ): void {
    if (!expected) return;
    const normalized = (changes: readonly DesignWorkspaceFileChange[]) => changes
      .map(item => ({ path: item.path, action: item.action, beforeRevision: item.beforeRevision ?? null, afterRevision: item.afterRevision }))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (JSON.stringify(normalized(current)) !== JSON.stringify(normalized(expected))) {
      throw new Error('Design workspace changed since preview. Refresh before applying.');
    }
  }
}
