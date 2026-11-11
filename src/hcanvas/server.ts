import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { htmlOutline } from './html.js';
import { exportFile, type HcExportFormat } from './export.js';
import {
  HcNotFoundError,
  HcRevisionConflictError,
  HcStore,
  HcValidationError,
} from './store.js';
import type { HcBlock, HcDocument, HcOp, HcPage, HcPagePreset } from './types.js';
import { resolveLlmConfig, runAgentChat, type AgentChatMessage } from './agentChat.js';
import { workspaceInfo } from './workspace.js';
import { discoverPlugins, setPluginEnabled } from './pluginLoader.js';
import { installPluginManifest, listGallerySamples, uninstallProjectPlugin } from './pluginGallery.js';
import { blockAgentSummary } from './builtinBlocks.js';
import { createPluginScaffold } from './pluginScaffold.js';
import { listProjects } from './projectRegistry.js';
import { HcFileService } from './fileWorkspace.js';

export interface HcServerOptions {
  workspace: string;
  host?: string;
  port?: number;
  staticDir?: string;
  token?: string;
}

export interface HcServer {
  url: string;
  token: string;
  port: number;
  store: HcStore;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;
let exportQueue: Promise<unknown> = Promise.resolve();

function enqueueExport<T>(task: () => Promise<T>): Promise<T> {
  const next = exportQueue.then(task, task);
  exportQueue = next.then(() => undefined, () => undefined);
  return next;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function text(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HcValidationError('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HcValidationError('Invalid JSON body');
  }
}

function openFolderInFileManager(folder: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [folder], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function blockLine(block: HcBlock): string {
  const label = blockAgentSummary(block) || '(no label)';
  return '- block ' + block.id + ' [' + block.type + '] ' + String(label).slice(0, 100) +
    ' at ' + block.x + ',' + block.y + ' ' + block.w + '×' + block.h + ' z=' + block.z;
}

function outlineDocument(doc: HcDocument, pageId?: string): string {
  const lines: string[] = [];
  lines.push('# Canvas: ' + doc.title + ' (id=' + doc.id + ', revision=' + doc.revision + ')');
  lines.push('');
  const pages = pageId ? doc.pages.filter(page => page.id === pageId) : doc.pages;
  for (const page of pages) {
    lines.push('## Page: ' + page.name + ' [' + page.mode + '] ' + page.width + '×' + page.height + ' (id=' + page.id + ')');
    if (page.notes) lines.push('Notes: ' + page.notes);
    if (page.mode === 'html') {
      const rows = htmlOutline(page.html || '');
      for (const row of rows.slice(0, 120)) {
        lines.push('  '.repeat(Math.min(6, row.depth)) + '- <' + row.tag + '>' + (row.hcId ? ' #' + row.hcId : '') + (row.text ? ' ' + row.text : '') + (row.classes ? ' .' + row.classes.split(/\s+/).join('.') : ''));
      }
      if (rows.length > 120) lines.push('  ... ' + (rows.length - 120) + ' more elements');
    } else if (page.mode === 'whiteboard') {
      const elements = (page.scene?.elements || []) as Array<Record<string, unknown>>;
      for (const element of elements.slice(0, 160)) {
        if (element.isDeleted === true) continue;
        const type = String(element.type || 'element');
        const id = String(element.id || '');
        const text = typeof element.text === 'string' ? element.text.replace(/\s+/g, ' ').slice(0, 90) : '';
        const bounds = typeof element.x === 'number' ? ' at ' + Math.round(Number(element.x)) + ',' + Math.round(Number(element.y)) + ' ' + Math.round(Number(element.width || 0)) + '×' + Math.round(Number(element.height || 0)) : '';
        lines.push('  - ' + type + ' ' + id + (text ? ' "' + text + '"' : '') + bounds);
      }
      if (elements.length > 160) lines.push('  ... ' + (elements.length - 160) + ' more elements');
    } else {
      for (const block of [...(page.blocks || [])].sort((left, right) => left.z - right.z)) {
        lines.push(' ' + blockLine(block));
        if (block.type === 'html') {
          for (const row of htmlOutline(block.html || '').slice(0, 40)) {
            lines.push('   ' + '  '.repeat(Math.min(4, row.depth)) + '- <' + row.tag + '>' + (row.hcId ? ' #' + row.hcId : '') + (row.text ? ' ' + row.text : ''));
          }
        }
      }
      if (!(page.blocks || []).length) lines.push('- (empty canvas page)');
    }
    lines.push('');
  }
  if (doc.proposals.filter(proposal => proposal.status === 'pending').length) {
    lines.push('## Pending proposals');
    for (const proposal of doc.proposals.filter(item => item.status === 'pending')) {
      lines.push('- ' + proposal.id + ' by ' + proposal.actor + ': ' + proposal.intent + ' (' + proposal.ops.length + ' ops, base rev ' + proposal.baseRevision + ')');
    }
  }
  lines.push('Edit with: hcanvas apply <doc> --ops-file ops.json --base-revision ' + doc.revision + ' --actor <name>');
  return lines.join('\n');
}

function readHtmlFor(doc: HcDocument, pageId?: string, blockId?: string): { page: HcPage; block?: HcBlock; html: string } {
  const page = pageId ? doc.pages.find(item => item.id === pageId) : doc.pages[0];
  if (!page) throw new HcValidationError('Page not found: ' + (pageId || '(first)'));
  if (blockId) {
    const block = (page.blocks || []).find(item => item.id === blockId);
    if (!block) throw new HcValidationError('Block not found: ' + blockId);
    return { page, block, html: block.html || '' };
  }
  return { page, html: page.html || '' };
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.woff') return 'font/woff';
  return 'application/octet-stream';
}

function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export async function startHcanvasServer(options: HcServerOptions): Promise<HcServer> {
  const store = new HcStore(options.workspace);
  await store.init();
  const files = new HcFileService(options.workspace);
  await files.init();
  const host = options.host || '127.0.0.1';
  const token = options.token || randomBytes(18).toString('hex');
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const staticCandidates = options.staticDir
    ? [options.staticDir]
    : [
        path.resolve(process.cwd(), 'dist/hcanvas'),
        path.resolve(moduleDir, '..', '..', 'hcanvas'),
        path.resolve(moduleDir, '..', '..', 'dist', 'hcanvas'),
      ];
  const staticDir = staticCandidates.find(candidate => existsSync(path.join(candidate, 'index.html'))) || staticCandidates[0]!;
  const indexPath = path.join(staticDir, 'index.html');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://' + host);
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/api/')) {
        const provided = req.headers['x-hcanvas-token'] || url.searchParams.get('token');
        const cookie = String(req.headers.cookie || '');
        const cookieToken = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('hc_files_token='))?.slice('hc_files_token='.length);
        const rawPathToken = pathname.match(/^\/api\/files\/raw\/root_[A-Za-z0-9]+\/([^/]+)\//)?.[1];
        if (provided !== token && rawPathToken !== token && !(pathname.startsWith('/api/files/raw/') && cookieToken === token)) {
          json(res, 401, { error: 'Unauthorized' });
          return;
        }
      }
      if (pathname === '/' || pathname === '/index.html') {
        let html: string;
        try {
          html = await readFile(indexPath, 'utf8');
        } catch {
          text(res, 503, 'Hadamard Canvas UI is not built. Run: npm run build:hcanvas');
          return;
        }
        const boot = {
          token,
          workspace: options.workspace,
          mode: 'standalone',
          version: '0.1.0',
        };
        html = html.replace('__HCANVAS_BOOT_JSON__', escapeJsonForHtml(boot));
        text(res, 200, html, 'text/html; charset=utf-8');
        return;
      }
      if (pathname.startsWith('/assets/')) {
        const relative = pathname.slice('/assets/'.length);
        const filePath = path.resolve(staticDir, 'assets', relative);
        if (!filePath.startsWith(path.resolve(staticDir, 'assets') + path.sep)) {
          json(res, 403, { error: 'Forbidden' });
          return;
        }
        try {
          const info = await stat(filePath);
          if (!info.isFile()) throw new Error('not a file');
          res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-cache' });
          createReadStream(filePath).pipe(res);
        } catch {
          json(res, 404, { error: 'Asset not found' });
        }
        return;
      }
      if (pathname === '/api/files/roots' && req.method === 'GET') {
        json(res, 200, { ok: true, roots: files.listRoots() });
        return;
      }
      if (pathname === '/api/files/roots' && req.method === 'POST') {
        const body = await readBody(req);
        const root = await files.addRoot(String(body.path || ''));
        json(res, 201, { ok: true, root });
        return;
      }
      const rootMatch = pathname.match(/^\/api\/files\/roots\/(root_[A-Za-z0-9]+)$/);
      if (rootMatch && req.method === 'DELETE') {
        await files.removeRoot(rootMatch[1]!);
        json(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/files/list' && req.method === 'GET') {
        const rootId = url.searchParams.get('root') || '';
        const relative = url.searchParams.get('path') || '';
        json(res, 200, { ok: true, entries: await files.list(rootId, relative) });
        return;
      }
      if (pathname === '/api/files/read' && req.method === 'GET') {
        const rootId = url.searchParams.get('root') || '';
        const relative = url.searchParams.get('path') || '';
        json(res, 200, { ok: true, file: await files.read(rootId, relative) });
        return;
      }
      if (pathname === '/api/files/write' && req.method === 'POST') {
        const body = await readBody(req);
        await files.write(String(body.root || ''), String(body.path || ''), String(body.content ?? ''));
        json(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/files/create' && req.method === 'POST') {
        const body = await readBody(req);
        await files.create(String(body.root || ''), String(body.path || ''), body.kind === 'directory' ? 'directory' : 'file');
        json(res, 201, { ok: true });
        return;
      }
      if (pathname === '/api/files/rename' && req.method === 'POST') {
        const body = await readBody(req);
        await files.renameEntry(String(body.root || ''), String(body.path || ''), String(body.name || ''));
        json(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/files/delete' && req.method === 'POST') {
        const body = await readBody(req);
        await files.deleteEntry(String(body.root || ''), String(body.path || ''));
        json(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/files/search' && req.method === 'GET') {
        json(res, 200, { ok: true, results: await files.searchAll(url.searchParams.get('q') || '') });
        return;
      }
      const rawMatch = pathname.match(/^\/api\/files\/raw\/(root_[A-Za-z0-9]+)\/([^/]+)\/(.+)$/);
      if (rawMatch && rawMatch[2] === token && req.method === 'GET') {
        const served = url.searchParams.get('office') === '1'
          ? await files.officePreviewPdf(rawMatch[1]!, rawMatch[3]!)
          : await files.serve(rawMatch[1]!, rawMatch[3]!);
        res.writeHead(200, {
          'content-type': served.type,
          'content-length': served.size,
          'cache-control': 'no-store',
          'set-cookie': 'hc_files_token=' + token + '; Path=/api/files/raw/; SameSite=Strict',
        });
        served.stream.pipe(res);
        return;
      }
      if (pathname === '/api/health') {
        json(res, 200, { ok: true, workspace: options.workspace, version: '0.1.0' });
        return;
      }
      if (pathname === '/api/state' && req.method === 'GET') {
        const context = await store.getContext(typeof url.searchParams.get('session') === 'string' ? url.searchParams.get('session')! : undefined);
        json(res, 200, { ok: true, ...context });
        return;
      }
      if (pathname === '/api/docs' && req.method === 'GET') {
        json(res, 200, { ok: true, docs: await store.listDocs() });
        return;
      }
      if (pathname === '/api/docs' && req.method === 'POST') {
        const body = await readBody(req);
        const preset = body.preset as HcPagePreset | undefined;
        const doc = await store.createDoc({
          title: typeof body.title === 'string' ? body.title : undefined,
          preset: preset && Number.isFinite(preset.width) && Number.isFinite(preset.height)
            ? {
                ...preset,
                id: typeof preset.id === 'string' && preset.id ? preset.id : 'custom',
                title: preset.title || 'Custom',
                width: preset.width,
                height: preset.height,
                background: preset.background || '#ffffff',
              }
            : undefined,
        });
        json(res, 201, { ok: true, doc });
        return;
      }
      let match = pathname.match(/^\/api\/docs\/(doc_[A-Za-z0-9]+)$/);
      if (match) {
        const docId = match[1]!;
        if (req.method === 'GET') {
          json(res, 200, { ok: true, doc: await store.readDoc(docId) });
          return;
        }
        if (req.method === 'DELETE') {
          await store.deleteDoc(docId);
          json(res, 200, { ok: true });
          return;
        }
        if (req.method === 'PATCH') {
          const body = await readBody(req);
          if (typeof body.title !== 'string') throw new HcValidationError('title is required');
          json(res, 200, { ok: true, doc: await store.updateTitle(docId, body.title, typeof body.source === 'string' ? body.source : undefined) });
          return;
        }
      }
      match = pathname.match(/^\/api\/docs\/(doc_[A-Za-z0-9]+)\/read$/);
      if (match && req.method === 'GET') {
        const doc = await store.readDoc(match[1]!);
        const format = url.searchParams.get('format') || 'outline';
        const pageId = url.searchParams.get('pageId') || undefined;
        const blockId = url.searchParams.get('blockId') || undefined;
        if (format === 'outline' || format === 'markdown') {
          json(res, 200, { ok: true, format, content: outlineDocument(doc, pageId), docId: doc.id, revision: doc.revision });
          return;
        }
        if (format === 'html') {
          const html = readHtmlFor(doc, pageId, blockId);
          json(res, 200, { ok: true, format, ...html, docId: doc.id, revision: doc.revision });
          return;
        }
        if (format === 'scene') {
          const page = pageId ? doc.pages.find(item => item.id === pageId) : doc.pages[0];
          if (!page) throw new HcValidationError('Page not found');
          if (page.mode !== 'whiteboard') throw new HcValidationError('Page is not a whiteboard page');
          json(res, 200, { ok: true, format, pageId: page.id, revision: doc.revision, scene: page.scene });
          return;
        }
        if (format === 'page') {
          const page = pageId ? doc.pages.find(item => item.id === pageId) : doc.pages[0];
          if (!page) throw new HcValidationError('Page not found');
          json(res, 200, { ok: true, format, page, docId: doc.id, revision: doc.revision });
          return;
        }
        if (format === 'json') {
          json(res, 200, { ok: true, format, doc });
          return;
        }
        throw new HcValidationError('Unknown format: ' + format);
      }
      match = pathname.match(/^\/api\/docs\/(doc_[A-Za-z0-9]+)\/apply$/);
      if (match && req.method === 'POST') {
        const body = await readBody(req);
        const result = await store.applyOps(match[1]!, {
          baseRevision: typeof body.baseRevision === 'number' ? body.baseRevision : undefined,
          actor: typeof body.actor === 'string' ? body.actor : 'cli',
          ops: Array.isArray(body.ops) ? body.ops as HcOp[] : [],
          dryRun: body.dryRun === true,
          summary: typeof body.summary === 'string' ? body.summary : undefined,
          source: typeof body.source === 'string' ? body.source : undefined,
        });
        json(res, 200, { ok: true, doc: result.doc, dryRun: result.dryRun, changed: result.changed, revision: result.doc.revision });
        return;
      }
      match = pathname.match(/^\/api\/docs\/(doc_[A-Za-z0-9]+)\/proposals$/);
      if (match) {
        const docId = match[1]!;
        if (req.method === 'GET') {
          const doc = await store.readDoc(docId);
          json(res, 200, { ok: true, proposals: doc.proposals });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const proposal = await store.createProposal(docId, {
            baseRevision: Number(body.baseRevision),
            actor: typeof body.actor === 'string' ? body.actor : 'agent',
            intent: typeof body.intent === 'string' ? body.intent : 'Agent proposal',
            ops: Array.isArray(body.ops) ? body.ops as never[] : [],
          });
          json(res, 201, { ok: true, proposal });
          return;
        }
      }
      match = pathname.match(/^\/api\/docs\/(doc_[A-Za-z0-9]+)\/proposals\/(proposal_[A-Za-z0-9]+)\/accept$/);
      if (match && req.method === 'POST') {
        const body = await readBody(req);
        const result = await store.resolveProposal(match[1]!, match[2]!, 'accept', typeof body.actor === 'string' ? body.actor : 'human');
        json(res, result.conflict ? 409 : 200, { ok: !result.conflict, doc: result.doc, proposal: result.proposal, conflict: result.conflict });
        return;
      }
      match = pathname.match(/^\/api\/docs\/(doc_[A-Za-z0-9]+)\/proposals\/(proposal_[A-Za-z0-9]+)\/reject$/);
      if (match && req.method === 'POST') {
        const body = await readBody(req);
        const result = await store.resolveProposal(match[1]!, match[2]!, 'reject', typeof body.actor === 'string' ? body.actor : 'human');
        json(res, 200, { ok: true, doc: result.doc, proposal: result.proposal });
        return;
      }
      if (pathname === '/api/context' && req.method === 'GET') {
        const session = url.searchParams.get('session') || undefined;
        json(res, 200, { ok: true, ...(await store.getContext(session)) });
        return;
      }
      if (pathname === '/api/context/activate' && req.method === 'POST') {
        const body = await readBody(req);
        const active = await store.activate({
          docId: typeof body.docId === 'string' ? body.docId : undefined,
          pageId: typeof body.pageId === 'string' ? body.pageId : undefined,
          blockId: typeof body.blockId === 'string' ? body.blockId : undefined,
          actor: typeof body.actor === 'string' ? body.actor : 'human',
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        });
        json(res, 200, { ok: true, active });
        return;
      }
      if (pathname === '/api/workspace' && req.method === 'GET') {
        json(res, 200, { ok: true, ...(await workspaceInfo(store.root)) });
        return;
      }
      if (pathname === '/api/projects' && req.method === 'GET') {
        const workspace = await workspaceInfo(store.root);
        json(res, 200, { ok: true, current: { workspace: workspace.workspace, project: workspace.project }, projects: await listProjects() });
        return;
      }
      if (pathname === '/api/projects/reveal' && req.method === 'POST') {
        const body = await readBody(req);
        const workspace = await workspaceInfo(store.root);
        const projects = await listProjects();
        const documentsDir = path.join(workspace.workspace, 'docs');
        const allowed = new Set<string>();
        for (const value of [workspace.project, workspace.workspace, documentsDir, ...projects.flatMap(project => [project.projectPath, project.workspacePath])]) {
          if (value) allowed.add(path.resolve(value));
        }
        const kind = String(body.kind || 'project');
        const defaultTarget = kind === 'documents' ? documentsDir : kind === 'workspace' ? workspace.workspace : workspace.project || workspace.workspace;
        const requested = String(body.projectPath || body.path || defaultTarget);
        const target = path.resolve(requested);
        if (!allowed.has(target)) { json(res, 403, { error: 'Only registered project folders can be opened' }); return; }
        try {
          const info = await stat(target);
          if (!info.isDirectory()) throw new HcValidationError('Not a folder: ' + target);
          await openFolderInFileManager(target);
          json(res, 200, { ok: true, path: target });
        } catch (error) {
          if (error instanceof HcValidationError) throw error;
          throw new HcNotFoundError('Folder not found: ' + target);
        }
        return;
      }
      if (pathname === '/api/agent/status' && req.method === 'GET') {
        const config = await resolveLlmConfig(store.root);
        json(res, 200, { ok: true, configured: Boolean(config), model: config?.model || null, baseUrl: config?.baseUrl || null });
        return;
      }
      if (pathname === '/api/agent/chat' && req.method === 'POST') {
        const body = await readBody(req);
        const messages = Array.isArray(body.messages) ? body.messages.filter(message => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string') as AgentChatMessage[] : [];
        try {
          const result = await runAgentChat(store, store.root, {
            docId: typeof body.docId === 'string' ? body.docId : undefined,
            pageId: typeof body.pageId === 'string' ? body.pageId : undefined,
            messages,
          });
          json(res, 200, { ok: true, ...result });
        } catch (error) {
          json(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (pathname === '/api/masters' && req.method === 'GET') {
        json(res, 200, { ok: true, masters: await store.listMasters() });
        return;
      }
      if (pathname === '/api/masters' && req.method === 'POST') {
        const body = await readBody(req);
        const master = await store.saveMaster({
          docId: String(body.docId || ''),
          pageId: String(body.pageId || ''),
          name: typeof body.name === 'string' ? body.name : undefined,
        });
        json(res, 201, { ok: true, master });
        return;
      }
      let masterMatch = pathname.match(/^\/api\/masters\/(master_[A-Za-z0-9]+)\/pages$/);
      if (masterMatch && req.method === 'POST') {
        const body = await readBody(req);
        const result = await store.addPageFromMaster(String(body.docId || ''), masterMatch[1]!, {
          baseRevision: Number.isFinite(Number(body.baseRevision)) ? Number(body.baseRevision) : undefined,
          actor: typeof body.actor === 'string' ? body.actor : 'human',
          name: typeof body.name === 'string' ? body.name : undefined,
        });
        json(res, 201, { ok: true, doc: result.doc, page: result.page });
        return;
      }
      masterMatch = pathname.match(/^\/api\/masters\/(master_[A-Za-z0-9]+)$/);
      if (masterMatch && req.method === 'DELETE') {
        await store.deleteMaster(masterMatch[1]!);
        json(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/sessions' && req.method === 'GET') {
        json(res, 200, { ok: true, sessions: await store.listSessions() });
        return;
      }
      if (pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const session = await store.createSession(String(body.docId), String(body.actor || 'agent'));
        json(res, 201, { ok: true, session });
        return;
      }
      let sessionMatch = pathname.match(/^\/api\/sessions\/(session_[A-Za-z0-9]+)\/heartbeat$/);
      if (sessionMatch && req.method === 'POST') {
        const body = await readBody(req);
        const session = await store.touchSession(sessionMatch[1]!, {
          docId: typeof body.docId === 'string' ? body.docId : undefined,
          pageId: typeof body.pageId === 'string' ? body.pageId : undefined,
          selection: Array.isArray(body.selection) ? body.selection as string[] : undefined,
          actor: typeof body.actor === 'string' ? body.actor : undefined,
        });
        json(res, 200, { ok: true, session });
        return;
      }
      sessionMatch = pathname.match(/^\/api\/sessions\/(session_[A-Za-z0-9]+)$/);
      if (sessionMatch && req.method === 'DELETE') {
        await store.deleteSession(sessionMatch[1]!);
        json(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/resolve' && req.method === 'GET') {
        const query = url.searchParams.get('q') || '';
        json(res, 200, { ok: true, ...(await store.resolve(query)) });
        return;
      }
      if (pathname === '/api/plugins' && req.method === 'GET') {
        const discovery = await discoverPlugins(options.workspace);
        json(res, 200, { ok: true, plugins: discovery.plugins, errors: discovery.errors });
        return;
      }
      if (pathname === '/api/plugins/gallery' && req.method === 'GET') {
        json(res, 200, { ok: true, samples: listGallerySamples() });
        return;
      }
      if (pathname === '/api/plugins/scaffold' && req.method === 'POST') {
        const body = await readBody(req);
        const scaffold = await createPluginScaffold(options.workspace, body.kind === 'page' ? 'page' : 'block');
        json(res, 201, { ok: true, ...scaffold });
        return;
      }
      if (pathname === '/api/plugins/install' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await installPluginManifest(options.workspace, body.manifest, body.overwrite === true);
        json(res, 201, { ok: true, plugin: result.plugin, discovery: result.discovery });
        return;
      }
      if (pathname === '/api/plugins/uninstall' && req.method === 'POST') {
        const body = await readBody(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) throw new HcValidationError('id is required');
        const discovery = await uninstallProjectPlugin(options.workspace, id);
        json(res, 200, { ok: true, discovery });
        return;
      }
      if (pathname === '/api/plugins/toggle' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.id || '');
        if (!id) throw new HcValidationError('id is required');
        const discovery = await setPluginEnabled(options.workspace, id, body.enabled !== false);
        json(res, 200, { ok: true, plugins: discovery.plugins, errors: discovery.errors });
        return;
      }
      if (pathname === '/api/export' && req.method === 'POST') {
        const body = await readBody(req);
        const doc = await store.readDoc(String(body.docId));
        const format = String(body.format || 'html') as HcExportFormat;
        if (!['html', 'pdf', 'png', 'pptx', 'pptx-editable', 'docx'].includes(format)) throw new HcValidationError('format must be html, pdf, png, pptx, pptx-editable or docx');
        const result = await enqueueExport(() => exportFile(doc, format, store.exportsDir, {
          pageId: typeof body.pageId === 'string' ? body.pageId : undefined,
          outPath: typeof body.outPath === 'string' ? body.outPath : undefined,
          bleedMm: Number.isFinite(Number(body.bleedMm)) ? Number(body.bleedMm) : undefined,
          cropMarks: body.cropMarks === true,
        }));
        json(res, 200, { ok: true, ...result, downloadUrl: '/api/export/download?name=' + encodeURIComponent(path.basename(result.path)) });
        return;
      }
      if (pathname === '/api/export/download' && req.method === 'GET') {
        const name = url.searchParams.get('name') || '';
        const filePath = path.resolve(store.exportsDir, name);
        if (!filePath.startsWith(path.resolve(store.exportsDir) + path.sep)) {
          json(res, 403, { error: 'Forbidden' });
          return;
        }
        try {
          const info = await stat(filePath);
          if (!info.isFile()) throw new Error('not a file');
          res.writeHead(200, { 'content-type': contentType(filePath), 'content-disposition': 'attachment; filename="' + path.basename(filePath) + '"' });
          createReadStream(filePath).pipe(res);
        } catch {
          json(res, 404, { error: 'File not found' });
        }
        return;
      }
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('event: hello\ndata: ' + JSON.stringify({ ok: true }) + '\n\n');
        const unsubscribe = store.subscribe(event => {
          res.write('event: canvas\ndata: ' + JSON.stringify(event) + '\n\n');
        });
        const timer = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(timer); unsubscribe(); });
        return;
      }
      json(res, 404, { error: 'Not found: ' + pathname });
    } catch (error) {
      if (error instanceof HcRevisionConflictError) {
        json(res, 409, { error: error.message, latestRevision: error.latest.revision, latestDoc: error.latest });
        return;
      }
      if (error instanceof HcNotFoundError) {
        json(res, 404, { error: error.message });
        return;
      }
      if (error instanceof HcValidationError) {
        json(res, 400, { error: error.message });
        return;
      }
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  const requested = options.port === 0 ? 0 : Number.isFinite(options.port) && (options.port || 0) > 0 ? options.port! : 4319;
  const attempts = requested === 0 ? 1 : 40;
  let boundPort = 0;
  for (let offset = 0; offset < attempts; offset += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => { server.removeListener('listening', onListening); reject(error); };
        const onListening = (): void => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(requested + offset, host);
      });
      const address = server.address();
      if (address && typeof address === 'object') { boundPort = address.port; break; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || offset === attempts - 1) throw error;
    }
  }
  const url = 'http://' + host + ':' + boundPort + '/';
  await mkdir(store.exportsDir, { recursive: true });
  await writeFile(path.join(store.root, 'daemon.json'), JSON.stringify({ url, token, workspace: store.root, pid: process.pid, startedAt: new Date().toISOString() }, null, 2), 'utf8');
  let closePromise: Promise<void> | null = null;
  return {
    url,
    token,
    port: boundPort,
    store,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await rm(path.join(store.root, 'daemon.json'), { force: true }).catch(() => undefined);
        const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closing;
      })();
      return closePromise;
    },
  };
}
