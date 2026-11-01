#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startHcanvasServer } from './server.js';
import { hcId, type HcOp, type HcPage } from './types.js';
import { initWorkspace, projectWorkspaceDir, workspaceInfo } from './workspace.js';
import { excalidrawSceneToNativePage, nativeBlocksToExcalidrawScene } from './sceneBridge.js';
import { parseExcalidrawScene } from '../canvas/excalidrawScene.js';
import type { HcDocument } from './types.js';
import { listProjects, registerProject, registryFilePath, touchProject } from './projectRegistry.js';

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

interface Connection {
  url: string;
  token: string;
}

const DEFAULT_WORKSPACE = process.env.HCANVAS_HOME || path.join(os.homedir(), '.hcanvas');

function usage(): string {
  return [
    'hcanvas — Hadamard Canvas CLI (AI-native, JSON-first)',
    '',
    'Usage:',
    '  hcanvas app [--project <dir> | --workspace <dir>] [--port <n>] [--no-open]',
    '  hcanvas desktop [--project <dir> | --workspace <dir>] [--port <n>]   # standalone Electron window',
    '  hcanvas serve [--project <dir> | --workspace <dir>] [--port <n>] [--host 127.0.0.1]',
    '  hcanvas workspace init [projectDir]',
    '  hcanvas workspace info [projectDir]',
    '  hcanvas projects list',
    '  hcanvas status',
    '  hcanvas context [--session <id>]',
    '  hcanvas resolve <query>',
    '  hcanvas docs list | create --title <t> [--preset slide|a4|poster] | delete <doc>',
    '  hcanvas read [doc] [--format outline|html|json|page|scene] [--page <id>] [--block <id>]',
    '  hcanvas apply [doc] --ops-file <file|-> --base-revision <n> [--actor <name>] [--dry-run]',
    '  hcanvas propose [doc] --ops-file <file|-> --base-revision <n> --intent <text>',
    '  hcanvas proposal list [doc]',
    '  hcanvas proposal accept [doc] <proposalId> [--actor <name>]',
    '  hcanvas proposal reject [doc] <proposalId>',
    '  hcanvas import <file.html> [doc] [--title <t>] [--width <px>] [--height <px>]',
    '  hcanvas import-scene <file.excalidraw> [doc] [--title <t>]',
    '  hcanvas convert-whiteboard <doc> [--page <pageId>] [--title <t>]',
    '  hcanvas export-scene <doc> [--page <pageId>] [--out <file.excalidraw>]',
    '  hcanvas export [doc] --format html|pdf|png|pptx|pptx-editable|docx [--page <id>] [--out <file>] [--bleed-mm <n>] [--crop-marks]',
    '  hcanvas masters list',
    '  hcanvas masters save [doc] --page <id> [--name <name>]',
    '  hcanvas masters apply <masterId> [doc]',
    '  hcanvas masters delete <masterId>',
    '  hcanvas sessions list',
    '  hcanvas sessions create [doc] [--actor <name>]',
    '  hcanvas sessions heartbeat <sessionId> [--doc <id>] [--page <id>] [--block <id>]',
    '  hcanvas sessions delete <sessionId>',
    '  hcanvas guide',
    '',
    'Global flags: --project <dir> --workspace <dir> --url <url> --token <token> --session <id> --actor <name> --pretty',
    '',
    'Environment: HCANVAS_HOME HCANVAS_URL HCANVAS_TOKEN HCANVAS_SESSION HCANVAS_ACTOR HCANVAS_DOC',
    '',
    'Resolution order for a document: explicit id/title/URL -> --doc/HCANVAS_DOC -> session context -> unique document.',
    'Writes require --base-revision (or an active session context); stale revisions fail with exit code 2.',
  ].join('\n');
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      if (equals > 2) {
        flags[arg.slice(2, equals)] = arg.slice(equals + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) { flags[key] = next; index += 1; }
        else flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true' || args.flags[name] === '1';
}

function projectPath(args: ParsedArgs): string | null {
  const value = flagString(args, 'project') || process.env.HCANVAS_PROJECT;
  return value ? path.resolve(value) : null;
}

function workspacePath(args: ParsedArgs): string {
  const project = projectPath(args);
  if (project) return projectWorkspaceDir(project);
  const value = flagString(args, 'workspace') || process.env.HCANVAS_WORKSPACE || DEFAULT_WORKSPACE;
  return path.resolve(value);
}

async function findConnection(args: ParsedArgs): Promise<Connection> {
  const explicitUrl = flagString(args, 'url') || process.env.HCANVAS_URL;
  const explicitToken = flagString(args, 'token') || process.env.HCANVAS_TOKEN;
  if (explicitUrl && explicitToken) return { url: explicitUrl, token: explicitToken };
  const project = projectPath(args);
  const candidates = [
    project ? projectWorkspaceDir(project) : null,
    project,
    flagString(args, 'workspace') ? path.resolve(flagString(args, 'workspace')!) : null,
    process.env.HCANVAS_WORKSPACE ? path.resolve(process.env.HCANVAS_WORKSPACE) : null,
    path.resolve(process.cwd(), '.hcanvas'),
    path.resolve(process.cwd()),
    DEFAULT_WORKSPACE,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const daemonPath = path.join(candidate, 'daemon.json');
    if (!existsSync(daemonPath)) continue;
    try {
      const daemon = JSON.parse(await readFile(daemonPath, 'utf8')) as { url?: string; token?: string };
      if (daemon.url && daemon.token) return { url: daemon.url, token: daemon.token };
    } catch { /* try next */ }
  }
  throw new Error('No running hcanvas service found. Start one with: hcanvas app --workspace ' + workspacePath(args));
}

function headers(conn: Connection): Record<string, string> {
  return { 'x-hcanvas-token': conn.token, 'content-type': 'application/json' };
}

async function request<T>(conn: Connection, pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(conn.url.replace(/\/$/, '') + pathname, {
    ...init,
    headers: { ...headers(conn), ...(init.headers || {}) },
  });
  const raw = await response.text();
  let payload: unknown = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
  if (!response.ok) {
    const error = new Error((payload as { error?: string }).error || ('HTTP ' + response.status));
    (error as Error & { status?: number; payload?: unknown }).status = response.status;
    (error as Error & { status?: number; payload?: unknown }).payload = payload;
    throw error;
  }
  return payload as T;
}

async function resolveDoc(conn: Connection, args: ParsedArgs, selector?: string): Promise<string> {
  const explicit = selector || flagString(args, 'doc') || process.env.HCANVAS_DOC;
  if (explicit) {
    if (/^doc_[A-Za-z0-9]+$/.test(explicit)) return explicit;
    if (/^hcanvas:\/\/doc\//.test(explicit)) {
      const id = explicit.replace(/^hcanvas:\/\/doc\//, '').split(/[?#]/)[0];
      if (/^doc_[A-Za-z0-9]+$/.test(id || '')) return id!;
    }
    const resolved = await request<{ matches: Array<{ docId: string; confidence: number; title: string }>; ambiguous: boolean }>(conn,
      '/api/resolve?q=' + encodeURIComponent(explicit));
    if (resolved.matches.length === 1 && !resolved.ambiguous) return resolved.matches[0]!.docId;
    if (resolved.matches.length > 1) {
      throw new Error('Ambiguous document selector "' + explicit + '". Candidates: ' + resolved.matches.map(item => item.docId + ' "' + item.title + '"').join(', '));
    }
    throw new Error('No document matched "' + explicit + '"');
  }
  const session = flagString(args, 'session') || process.env.HCANVAS_SESSION;
  const context = await request<{ active: { docId: string } | null; docs: Array<{ id: string }> }>(conn, '/api/context' + (session ? '?session=' + encodeURIComponent(session) : ''));
  if (context.active) return context.active.docId;
  if (context.docs.length === 1) return context.docs[0]!.id;
  throw new Error('No active document and multiple canvases exist. Pass a document id or run: hcanvas docs list');
}

async function baseRevisionFor(conn: Connection, docId: string, args: ParsedArgs): Promise<number> {
  const explicit = flagString(args, 'base-revision') || flagString(args, 'baseRevision');
  if (explicit !== undefined) {
    const value = Number(explicit);
    if (!Number.isFinite(value)) throw new Error('--base-revision must be a number');
    return value;
  }
  const session = flagString(args, 'session') || process.env.HCANVAS_SESSION;
  const context = await request<{ active: { docId: string; revision: number } | null }>(conn, '/api/context' + (session ? '?session=' + encodeURIComponent(session) : ''));
  if (context.active?.docId === docId && Number.isFinite(context.active.revision)) return context.active.revision;
  throw new Error('Write requires --base-revision. Read the document first (hcanvas read) or pass --from-context with an active session.');
}

async function heartbeatIfSession(conn: Connection, args: ParsedArgs, docId?: string, pageId?: string, selection?: string[]): Promise<void> {
  const session = flagString(args, 'session') || process.env.HCANVAS_SESSION;
  if (!session || !session.startsWith('session_')) return;
  try {
    await request(conn, '/api/sessions/' + session + '/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ docId, pageId, selection }),
    });
  } catch { /* presence is best effort */ }
}

async function readOps(args: ParsedArgs): Promise<unknown[]> {
  const file = flagString(args, 'ops-file') || flagString(args, 'ops');
  if (!file) throw new Error('--ops-file <file|-> is required');
  let raw: string;
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    raw = await readFile(path.resolve(file), 'utf8');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('ops file is not valid JSON'); }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { ops?: unknown[] }).ops)) return (parsed as { ops: unknown[] }).ops;
  throw new Error('ops JSON must be an array or { "ops": [...] }');
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* user can open manually */ }
}

function print(value: unknown, pretty = false): void {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + '\n');
}

function launchDesktop(args: ParsedArgs): void {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const electronMain = [
    path.join(moduleDir, 'electronMain.js'),
    path.resolve(moduleDir, '..', '..', '..', 'dist', 'src', 'hcanvas', 'electronMain.js'),
  ].find(candidate => existsSync(candidate));
  if (!electronMain) throw new Error('Desktop entry is not built. Run: npm run build');
  const require = createRequire(import.meta.url);
  let electronPath: string;
  try {
    electronPath = require('electron') as string;
  } catch {
    throw new Error('Electron is not installed. Run hcanvas app for the browser version.');
  }
  const childArgs = [electronMain];
  const project = projectPath(args);
  if (project) { void registerProject(project); }
  const workspace = flagString(args, 'workspace') || process.env.HCANVAS_WORKSPACE;
  if (project) childArgs.push('--project', project);
  else if (workspace) childArgs.push('--workspace', path.resolve(workspace));
  const port = flagString(args, 'port');
  if (port) childArgs.push('--port', port);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const logPath = path.join(os.tmpdir(), 'hcanvas-desktop.log');
  const logFd = openSync(logPath, 'a');
  const child = spawn(electronPath, childArgs, {
    env,
    stdio: ['ignore', logFd, logFd],
    windowsHide: false,
    detached: process.platform === 'win32',
  });
  closeSync(logFd);
  if (process.platform === 'win32') child.unref();
  const effectiveWorkspace = project ? projectWorkspaceDir(project) : workspace ? path.resolve(workspace) : path.join(os.homedir(), '.hcanvas');
  print({ ok: true, desktop: true, workspace: effectiveWorkspace, project: project || null, pid: child.pid, log: logPath }, flagBool(args, 'pretty'));
}

async function runServe(args: ParsedArgs, open: boolean): Promise<void> {
  const workspace = workspacePath(args);
  const project = projectPath(args);
  const workspaceMeta = await initWorkspace(workspace, project);
  if (project) { await registerProject(project); await touchProject(project); }
  const portValue = flagString(args, 'port');
  const port = portValue ? Number(portValue) : 4319;
  const server = await startHcanvasServer({
    workspace,
    host: flagString(args, 'host') || '127.0.0.1',
    port,
    staticDir: flagString(args, 'static-dir') ? path.resolve(flagString(args, 'static-dir')!) : undefined,
  });
  print({ ok: true, url: server.url, token: server.token, workspace, project: workspaceMeta.project, guide: workspaceMeta.guidePath, pid: process.pid }, flagBool(args, 'pretty'));
  if (open && !flagBool(args, 'no-open')) openBrowser(server.url);
  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  await new Promise<void>(() => undefined);
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (flagBool(args, 'help') || flagBool(args, 'h') || args.positionals.length === 0) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const command = args.positionals[0]!;
  const sub = args.positionals[1];
  const pretty = flagBool(args, 'pretty');
  if (command === 'serve' || command === 'app') { await runServe(args, command === 'app'); return; }
  if (command === 'desktop') { launchDesktop(args); return; }
  if (command === 'workspace') {
    const project = path.resolve(args.positionals[2] || projectPath(args) || process.cwd());
    const workspace = projectWorkspaceDir(project);
    if (sub === 'info') {
      print(await workspaceInfo(workspace), pretty);
      return;
    }
    if (!sub || sub === 'init') {
      const info = await initWorkspace(workspace, project);
      const record = await registerProject(project);
      print({ ok: true, ...info, projectRecord: record, hint: 'Start with: hcanvas app --project ' + project }, pretty);
      return;
    }
    throw new Error('Unknown workspace command: ' + sub);
  }
  if (command === 'projects') {
    if (sub && sub !== 'list') throw new Error('Unknown projects command: ' + sub);
    print({ ok: true, projects: await listProjects(), registry: registryFilePath() }, pretty);
    return;
  }
  if (command === 'guide') {
    process.stdout.write(usage() + '\n\nAgent notes:\n- Always run "hcanvas context --json" first when the user refers to "this canvas".\n- If context is absent or ambiguous, list documents and ask the user; never guess for writes.\n- All writes are revision-checked; read, then apply with --base-revision.\n- HTML edits should patch data-hc-id targets, not rewrite whole documents.\n');
    return;
  }
  const conn = await findConnection(args);
  const actor = flagString(args, 'actor') || process.env.HCANVAS_ACTOR || 'cli';

  if (command === 'status') {
    print(await request(conn, '/api/state'), pretty);
    return;
  }
  if (command === 'context') {
    const session = flagString(args, 'session') || process.env.HCANVAS_SESSION;
    const context = await request<{ active?: { docId?: string; pageId?: string; selection?: string[] } }>(conn, '/api/context' + (session ? '?session=' + encodeURIComponent(session) : ''));
    print(context, pretty);
    await heartbeatIfSession(conn, args, context.active?.docId, context.active?.pageId, context.active?.selection);
    return;
  }
  if (command === 'resolve') {
    if (!sub) throw new Error('resolve requires a query');
    print(await request(conn, '/api/resolve?q=' + encodeURIComponent(args.positionals.slice(1).join(' '))), pretty);
    return;
  }
  if (command === 'docs') {
    if (!sub || sub === 'list') { print(await request(conn, '/api/docs'), pretty); return; }
    if (sub === 'create') {
      const title = flagString(args, 'title') || 'Untitled canvas';
      const presetId = flagString(args, 'preset');
      const presets: Record<string, { width: number; height: number; background: string; title: string }> = {
        slide: { width: 1280, height: 720, background: '#ffffff', title: 'Slide' },
        a4: { width: 794, height: 1123, background: '#ffffff', title: 'A4' },
        poster: { width: 1080, height: 1350, background: '#ffffff', title: 'Poster' },
        square: { width: 1080, height: 1080, background: '#ffffff', title: 'Square' },
      };
      const body: Record<string, unknown> = { title };
      if (presetId && presets[presetId]) body.preset = presets[presetId];
      print(await request(conn, '/api/docs', { method: 'POST', body: JSON.stringify(body) }), pretty);
      return;
    }
    if (sub === 'delete') {
      const docId = await resolveDoc(conn, args, args.positionals[2]);
      print(await request(conn, '/api/docs/' + docId, { method: 'DELETE' }), pretty);
      return;
    }
    throw new Error('Unknown docs command: ' + sub);
  }
  if (command === 'read') {
    const docId = await resolveDoc(conn, args, args.positionals[1]);
    const format = flagString(args, 'format') || 'outline';
    const pageId = flagString(args, 'page');
    const blockId = flagString(args, 'block');
    const params = new URLSearchParams({ format });
    if (pageId) params.set('pageId', pageId);
    if (blockId) params.set('blockId', blockId);
    print(await request(conn, '/api/docs/' + docId + '/read?' + params.toString()), pretty);
    await heartbeatIfSession(conn, args, docId, pageId, blockId ? [blockId] : undefined);
    return;
  }
  if (command === 'apply') {
    const docId = await resolveDoc(conn, args, args.positionals[1]);
    const baseRevision = await baseRevisionFor(conn, docId, args);
    const ops = await readOps(args);
    const result = await request(conn, '/api/docs/' + docId + '/apply', {
      method: 'POST',
      body: JSON.stringify({ ops, baseRevision, actor, summary: flagString(args, 'summary'), dryRun: flagBool(args, 'dry-run') }),
    });
    print(result, pretty);
    await heartbeatIfSession(conn, args, docId);
    return;
  }
  if (command === 'propose') {
    const docId = await resolveDoc(conn, args, args.positionals[1]);
    const baseRevision = await baseRevisionFor(conn, docId, args);
    const ops = await readOps(args);
    const result = await request(conn, '/api/docs/' + docId + '/proposals', {
      method: 'POST',
      body: JSON.stringify({ ops, baseRevision, actor, intent: flagString(args, 'intent') || 'Agent proposal' }),
    });
    print(result, pretty);
    await heartbeatIfSession(conn, args, docId);
    return;
  }
  if (command === 'proposal') {
    const docId = await resolveDoc(conn, args, args.positionals.filter((value, index) => index > 1 && value.startsWith('doc_'))[0]);
    if (!sub || sub === 'list') {
      print(await request(conn, '/api/docs/' + docId + '/proposals'), pretty);
      return;
    }
    const proposalId = args.positionals.slice(2).find(value => value.startsWith('proposal_'));
    if (!proposalId) throw new Error('proposal id is required (proposal_...)');
    const action = sub === 'accept' ? 'accept' : sub === 'reject' ? 'reject' : null;
    if (!action) throw new Error('Unknown proposal command: ' + sub);
    print(await request(conn, '/api/docs/' + docId + '/proposals/' + proposalId + '/' + action, {
      method: 'POST', body: JSON.stringify({ actor }),
    }), pretty);
    return;
  }
  if (command === 'import-scene') {
    const file = args.positionals[1];
    if (!file) throw new Error('import-scene requires a .excalidraw file');
    const parsed = JSON.parse(await readFile(path.resolve(file), 'utf8')) as unknown;
    const scene = parseExcalidrawScene(parsed);
    const docId = await resolveDoc(conn, args, args.positionals[2]);
    const current = (await request<{ doc: HcDocument }>(conn, '/api/docs/' + docId)).doc;
    const title = flagString(args, 'title') || path.basename(file).replace(/\.excalidraw$/i, '');
    const page = excalidrawSceneToNativePage(scene, title);
    const result = await request(conn, '/api/docs/' + docId + '/apply', {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'add_page', page }], baseRevision: current.revision, actor, summary: 'import native scene' }),
    });
    print({ ok: true, docId, pageId: page.id, name: page.name, blocks: page.blocks?.length || 0, result }, pretty);
    return;
  }
  if (command === 'export-scene') {
    const docId = await resolveDoc(conn, args, args.positionals[1]);
    const current = (await request<{ doc: HcDocument }>(conn, '/api/docs/' + docId)).doc;
    const requestedPage = flagString(args, 'page');
    const source = requestedPage ? current.pages.find(page => page.id === requestedPage) : current.pages.find(page => page.mode === 'infinite') || current.pages.find(page => page.mode === 'whiteboard');
    if (!source) throw new Error('No Infinite or whiteboard page found' + (requestedPage ? ': ' + requestedPage : ''));
    const scene = source.mode === 'whiteboard'
      ? { type: 'excalidraw', version: 2, source: 'hcanvas', elements: source.scene?.elements || [], appState: source.scene?.appState || {}, files: source.scene?.files || {} }
      : nativeBlocksToExcalidrawScene(source);
    const out = path.resolve(flagString(args, 'out') || (source.name || 'scene').replace(/[^a-zA-Z0-9_-]+/g, '-') + '.excalidraw');
    await writeFile(out, JSON.stringify(scene, null, 2), 'utf8');
    print({ ok: true, docId, pageId: source.id, pageName: source.name, mode: source.mode, out, elements: scene.elements.length }, pretty);
    return;
  }
  if (command === 'convert-whiteboard') {
    const docId = await resolveDoc(conn, args, args.positionals[1]);
    const current = (await request<{ doc: HcDocument }>(conn, '/api/docs/' + docId)).doc;
    const requestedPage = flagString(args, 'page');
    const source = requestedPage ? current.pages.find(page => page.id === requestedPage) : current.pages.find(page => page.mode === 'whiteboard');
    if (!source || source.mode !== 'whiteboard') throw new Error('No whiteboard page found' + (requestedPage ? ': ' + requestedPage : ''));
    const scene = parseExcalidrawScene({ elements: source.scene?.elements || [], appState: source.scene?.appState, files: source.scene?.files });
    const page = excalidrawSceneToNativePage(scene, flagString(args, 'title') || (source.name + ' · Native'));
    page.background = source.background || page.background;
    const result = await request(conn, '/api/docs/' + docId + '/apply', {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'add_page', page }], baseRevision: current.revision, actor, summary: 'convert whiteboard to native Infinite' }),
    });
    print({ ok: true, docId, sourcePageId: source.id, pageId: page.id, name: page.name, blocks: page.blocks?.length || 0, result }, pretty);
    return;
  }
  if (command === 'import') {
    const file = args.positionals[1];
    if (!file) throw new Error('import requires an HTML file path');
    const html = await readFile(path.resolve(file), 'utf8');
    if (!html.trim()) throw new Error('HTML file is empty');
    const docId = await resolveDoc(conn, args, args.positionals[2]);
    const baseRevision = await baseRevisionFor(conn, docId, args);
    const width = Number(flagString(args, 'width') || 1280);
    const height = Number(flagString(args, 'height') || 720);
    const title = flagString(args, 'title') || path.basename(file).replace(/\.[^.]+$/, '') || 'Imported HTML';
    const page: HcPage = { id: hcId('page'), name: title, mode: 'html', width: Number.isFinite(width) && width > 0 ? width : 1280, height: Number.isFinite(height) && height > 0 ? height : 720, background: '#ffffff', html };
    const result = await request<Record<string, unknown>>(conn, '/api/docs/' + docId + '/apply', {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'add_page', page } as HcOp], baseRevision, actor, summary: 'Import HTML: ' + file }),
    });
    print({ ok: true, docId, pageId: page.id, ...result }, pretty);
    return;
  }
  if (command === 'export') {
    const docId = await resolveDoc(conn, args, args.positionals[1]);
    const format = flagString(args, 'format') || 'html';
    const result = await request(conn, '/api/export', {
      method: 'POST',
      body: JSON.stringify({
        docId, format, pageId: flagString(args, 'page'), outPath: flagString(args, 'out'),
        bleedMm: flagString(args, 'bleed-mm') ? Number(flagString(args, 'bleed-mm')) : undefined,
        cropMarks: flagBool(args, 'crop-marks'),
      }),
    });
    print(result, pretty);
    return;
  }
  if (command === 'masters') {
    if (!sub || sub === 'list') {
      print(await request(conn, '/api/masters'), pretty);
      return;
    }
    if (sub === 'save') {
      const docId = await resolveDoc(conn, args, args.positionals[2]);
      const pageId = flagString(args, 'page');
      if (!pageId) throw new Error('masters save requires --page <pageId>');
      print(await request(conn, '/api/masters', {
        method: 'POST',
        body: JSON.stringify({ docId, pageId, name: flagString(args, 'name'), actor }),
      }), pretty);
      return;
    }
    if (sub === 'apply') {
      const masterId = args.positionals[2];
      if (!masterId) throw new Error('masters apply requires a master id');
      const docId = await resolveDoc(conn, args, args.positionals[3]);
      const baseRevision = await baseRevisionFor(conn, docId, args);
      print(await request(conn, '/api/masters/' + masterId + '/pages', {
        method: 'POST',
        body: JSON.stringify({ docId, baseRevision, actor, name: flagString(args, 'name') }),
      }), pretty);
      return;
    }
    if (sub === 'delete') {
      const masterId = args.positionals[2];
      if (!masterId) throw new Error('masters delete requires a master id');
      print(await request(conn, '/api/masters/' + masterId, { method: 'DELETE' }), pretty);
      return;
    }
    throw new Error('Unknown masters command: ' + sub);
  }
  if (command === 'sessions') {
    const currentSession = flagString(args, 'session') || process.env.HCANVAS_SESSION;
    if (!sub || sub === 'list') {
      print(await request(conn, '/api/sessions'), pretty);
      return;
    }
    if (sub === 'create') {
      const docId = await resolveDoc(conn, args, args.positionals[2]);
      const result = await request<{ session: { id: string } }>(conn, '/api/sessions', { method: 'POST', body: JSON.stringify({ docId, actor }) });
      print({ ok: true, session: result.session, hint: 'Use --session ' + result.session.id + ' or set HCANVAS_SESSION=' + result.session.id }, pretty);
      return;
    }
    if (sub === 'heartbeat') {
      const sessionId = args.positionals[2] || currentSession;
      if (!sessionId) throw new Error('sessions heartbeat requires a session id or --session');
      print(await request(conn, '/api/sessions/' + sessionId + '/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ docId: flagString(args, 'doc'), pageId: flagString(args, 'page'), selection: flagString(args, 'block') ? [flagString(args, 'block')!] : undefined, actor: flagString(args, 'actor') }),
      }), pretty);
      return;
    }
    if (sub === 'delete') {
      const sessionId = args.positionals[2] || currentSession;
      if (!sessionId) throw new Error('sessions delete requires a session id');
      print(await request(conn, '/api/sessions/' + sessionId, { method: 'DELETE' }), pretty);
      return;
    }
    throw new Error('Unknown sessions command: ' + sub);
  }
  throw new Error('Unknown command: ' + command);
}

main(process.argv.slice(2)).catch(error => {
  const status = (error as Error & { status?: number }).status;
  const payload = (error as Error & { payload?: unknown }).payload;
  process.stderr.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), status, payload }) + '\n');
  process.exit(status === 409 ? 2 : 1);
});