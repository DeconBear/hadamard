#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startHcanvasServer } from './server.js';
import { initWorkspace, projectWorkspaceDir, workspaceInfo } from './workspace.js';
import { excalidrawSceneToNativePage, nativeBlocksToExcalidrawScene } from './sceneBridge.js';
import { parseExcalidrawScene } from '../canvas/excalidrawScene.js';
import type { HcDocument } from './types.js';
import { listProjects, registerProject, registryFilePath, touchProject } from './projectRegistry.js';
import { readHcanvasSettings, resolveDataRootSync } from './dataRoot.js';
import { detectRuntime } from './runtimes.js';
import { compileScene, type ComposeScene } from './composeScene.js';
import { AGENT_SCHEMAS, SCENE_EXAMPLE } from './agentSchemas.js';
import { getComposeTemplate, listComposeTemplates } from './composeTemplates.js';
import { discoverExtensions, findExtension, installExtension, setExtensionEnabled, setExtensionTrusted, uninstallProjectExtension } from './extensions/loader.js';
import { installLocalTarballExtension, installNpmExtension } from './extensions/npmInstaller.js';

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

interface Connection {
  url: string;
  token: string;
}

if (!process.env.HCANVAS_HOME) process.env.HCANVAS_HOME = resolveDataRootSync();
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
    '  hcanvas context [--session <id>] [--brief]',
    '  hcanvas resolve <query>',
    '  hcanvas docs list [--query <q>] [--recent] [--limit <n>] | create --title <t> [--preset slide|a4|poster|square|canvas|infinite] | delete <doc>',
    '  hcanvas read [doc] [--format outline|layout|lint|html|json|page] [--page <id>] [--block <id>] [--limit <n>]',
    '  hcanvas lint [doc] [--page <id>] [--limit <n>]',
    '  hcanvas compose [scene.json|-|--template <name>] [doc] [--title <t>] [--base-revision <n>] [--dry-run]',
    '  hcanvas template list',
    '  hcanvas assets list | upload <file> [--name <name>] | delete <assetId>',
    '  hcanvas schema [scene|ops|layout]',
    '  hcanvas apply [doc] --ops-file <file|-> --base-revision <n> [--actor <name>] [--dry-run] [--compact] [--idempotency-key <key>]',
    '  hcanvas propose [doc] --ops-file <file|-> --base-revision <n> --intent <text>',
    '  hcanvas proposal list [doc]',
    '  hcanvas proposal accept [doc] <proposalId> [--actor <name>]',
    '  hcanvas proposal reject [doc] <proposalId>',
    '  hcanvas import-scene <file.excalidraw> [doc] [--title <t>]',
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
  '  hcanvas extension list [--user|--project] [--json]',
  '  hcanvas extension info <id> [--json]',
  '  hcanvas extension install <@scope/name@version> [--user|--project] [--overwrite] [--registry <url>]',
  '  hcanvas extension update <@scope/name@version> [--user|--project]',
  '  hcanvas extension install --folder <dir> [--user|--project] [--overwrite]',
  '  hcanvas extension install --tarball <package.tgz> [--user|--project] [--overwrite]',
  '  hcanvas extension install --manifest <manifest.json> [--user|--project]',
  '  hcanvas extension uninstall <id> [--user|--project]',
  '  hcanvas extension enable|disable|trust|untrust <id>',
  '  hcanvas extension reload [--json]',
  '  hcanvas plugin list|install|uninstall ...   # alias for extension, same implementation',
  '  hcanvas doctor [--json]',
    '  hcanvas guide',
    '',
    'Global flags: --project <dir> --workspace <dir> --home <dir> --url <url> --token <token> --session <id> --actor <name> --pretty',
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

async function readTextInput(file: string, label: string): Promise<string> {
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    return await readFile(path.resolve(file), 'utf8');
  } catch {
    throw new Error('Could not read ' + label + ' file: ' + file);
  }
}

async function uploadAsset(conn: Connection, file: string, name?: string): Promise<{ id: string; name: string; mime: string; size: number; url: string }> {
  const absolute = path.resolve(file);
  const data = await readFile(absolute);
  const response = await request<{ asset: { id: string; name: string; mime: string; size: number; url: string } }>(conn, '/api/assets', {
    method: 'POST',
    body: JSON.stringify({ name: name || path.basename(absolute), data: data.toString('base64') }),
  });
  return response.asset;
}

async function hydrateSceneAssets(conn: Connection, scene: ComposeScene, warnings: string[]): Promise<void> {
  const uploaded = new Map<string, string>();
  for (const page of scene.pages) {
    for (const block of page.blocks || []) {
      if (block.type !== 'image' || !block.srcFile) continue;
      const file = block.srcFile;
      if (!uploaded.has(file)) {
        try {
          const asset = await uploadAsset(conn, file, undefined);
          uploaded.set(file, asset.url);
        } catch (error) {
          warnings.push('Could not upload image ' + file + ': ' + (error instanceof Error ? error.message : String(error)));
          continue;
        }
      }
      block.src = uploaded.get(file)!;
    }
  }
}

async function assetCommand(conn: Connection, args: ParsedArgs, pretty: boolean): Promise<void> {
  const sub = args.positionals[1];
  if (!sub || sub === 'list') {
    print(await request(conn, '/api/assets'), pretty);
    return;
  }
  if (sub === 'upload') {
    const file = args.positionals[2];
    if (!file) throw new Error('assets upload requires a file path');
    print({ ok: true, asset: await uploadAsset(conn, file, flagString(args, 'name')) }, pretty);
    return;
  }
  if (sub === 'delete') {
    const id = args.positionals[2];
    if (!id) throw new Error('assets delete requires an asset id');
    print(await request(conn, '/api/assets/' + id, { method: 'DELETE' }), pretty);
    return;
  }
  throw new Error('Unknown assets command: ' + sub);
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

function extensionScope(args: ParsedArgs): 'user' | 'workspace' {
  return flagBool(args, 'project') || flagString(args, 'project') || flagBool(args, 'workspace') || flagString(args, 'workspace') ? 'workspace' : 'user';
}

function parseNpmSpec(spec: string): { packageName: string; version: string } {
  const at = spec.lastIndexOf('@');
  if (at <= 0 || at === spec.length - 1) throw new Error('NPM install requires an exact package@version, for example @hcanvas/kernel-python@0.1.0');
  return { packageName: spec.slice(0, at), version: spec.slice(at + 1) };
}

async function extensionCommand(args: ParsedArgs, pretty: boolean): Promise<void> {
  const action = args.positionals[1] || 'list';
  const workspace = workspacePath(args);
  const home = flagString(args, 'home');
  const options = { ...(home ? { homeDir: path.resolve(home) } : {}) };
  const scope = extensionScope(args);
  const scopeFilter = flagBool(args, 'user') ? 'user' : flagBool(args, 'project') || flagBool(args, 'workspace') ? 'workspace' : 'all';
  if (action === 'list' || action === 'reload') {
    const discovery = await discoverExtensions(workspace, options);
    const extensions = discovery.extensions
      .filter(entry => scopeFilter === 'all' || (scopeFilter === 'user' ? entry.source === 'user' || entry.source === 'legacy-user' : entry.source === 'workspace' || entry.source === 'legacy-project'))
      .map(entry => ({
        id: entry.id, name: entry.name, version: entry.version, source: entry.source,
        enabled: entry.enabled, trusted: entry.trusted, compatible: entry.compatible,
        requiresProcess: entry.requiresProcess, diagnostics: entry.diagnostics,
        ...(entry.provenance ? { provenance: entry.provenance, installSource: entry.provenance.source } : { installSource: entry.source === 'bundled' ? 'bundled' : 'folder' }),
        ...(entry.incompatibilityReason ? { incompatibilityReason: entry.incompatibilityReason } : {}),
      }));
    print({ ok: true, workspace, extensions, warnings: discovery.warnings, errors: discovery.errors }, pretty);
    return;
  }
  if (action === 'info') {
    const id = args.positionals[2];
    if (!id) throw new Error('extension info requires an extension id');
    const discovery = await discoverExtensions(workspace, options);
    const entry = findExtension(discovery, id);
    if (!entry) throw new Error('Unknown extension id: ' + id);
    print({ ok: true, extension: {
      id: entry.id, name: entry.name, version: entry.version, source: entry.source, enabled: entry.enabled,
      trusted: entry.trusted, compatible: entry.compatible, requiresProcess: entry.requiresProcess,
      path: entry.path, root: entry.root, diagnostics: entry.diagnostics, grantStatus: entry.grantStatus,
      ...(entry.provenance ? { provenance: entry.provenance } : {}),
      ...(entry.incompatibilityReason ? { incompatibilityReason: entry.incompatibilityReason } : {}),
    } }, pretty);
    return;
  }
  if (action === 'doctor') {
    await doctorCommand(args, pretty);
    return;
  }
  if (action === 'install' || action === 'update') {
    const overwrite = action === 'update' || flagBool(args, 'overwrite');
    const folder = flagString(args, 'folder');
    const tarball = flagString(args, 'tarball');
    const manifestFile = flagString(args, 'manifest');
    if (folder) {
      const result = await installExtension(workspace, { source: 'folder', path: folder, scope, overwrite }, options);
      print({ ok: true, id: result.id, path: result.path, scope, extension: result.extension }, pretty);
      return;
    }
    if (manifestFile) {
      const manifest = JSON.parse(await readFile(path.resolve(manifestFile), 'utf8')) as unknown;
      const result = await installExtension(workspace, { source: 'json', manifest, scope, overwrite }, options);
      print({ ok: true, id: result.id, path: result.path, scope, extension: result.extension }, pretty);
      return;
    }
    if (tarball) {
      const result = await installLocalTarballExtension(workspace, { source: 'tarball', path: tarball, scope, overwrite }, options);
      print({ ok: true, id: result.id, path: result.path, scope, provenance: result.provenance, warnings: result.warnings, extension: result.extension }, pretty);
      return;
    }
    const target = args.positionals[2];
    if (!target) throw new Error('extension install requires a package@version, --folder <dir>, or --manifest <file>');
    const { packageName, version } = parseNpmSpec(target);
    const registry = flagString(args, 'registry');
    const result = await installNpmExtension(workspace, { source: 'npm', packageName, version, scope, overwrite, ...(registry ? { registry } : {}) }, options);
    print({ ok: true, id: result.id, path: result.path, scope, provenance: result.provenance, warnings: result.warnings, extension: result.extension }, pretty);
    return;
  }
  if (action === 'uninstall') {
    const id = args.positionals[2];
    if (!id) throw new Error('extension uninstall requires an extension id');
    const discovery = await uninstallProjectExtension(workspace, id, options, scope);
    print({ ok: true, id, scope, extensions: discovery.extensions.map(entry => entry.id) }, pretty);
    return;
  }
  if (action === 'enable' || action === 'disable') {
    const id = args.positionals[2];
    if (!id) throw new Error('extension ' + action + ' requires an extension id');
    const discovery = await setExtensionEnabled(workspace, id, action === 'enable', options);
    print({ ok: true, id, enabled: action === 'enable', extensions: discovery.extensions.map(entry => ({ id: entry.id, enabled: entry.enabled })) }, pretty);
    return;
  }
  if (action === 'trust' || action === 'untrust') {
    const id = args.positionals[2];
    if (!id) throw new Error('extension ' + action + ' requires an extension id');
    const discovery = await setExtensionTrusted(workspace, id, action === 'trust', options);
    print({ ok: true, id, trusted: action === 'trust', extensions: discovery.extensions.map(entry => ({ id: entry.id, trusted: entry.trusted })) }, pretty);
    return;
  }
  throw new Error('Unknown extension command: ' + action);
}

function runtimeCheck(id: string, label: string, command: string, args: string[], required: boolean, hint: string): Record<string, unknown> {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const output = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || '';
  const ok = result.status === 0;
  return {
    id, label, ok, required, detail: ok ? output : (result.error?.message || 'not found'),
    ...(ok ? {} : { hint }),
  };
}

async function doctorCommand(args: ParsedArgs, pretty: boolean): Promise<void> {
  const workspace = workspacePath(args);
  const checks: Array<Record<string, unknown>> = [];
  checks.push(runtimeCheck('node', 'Node.js', process.execPath, ['--version'], true, 'Install Node.js 22.13+ or 24.'));
  const settings = await readHcanvasSettings();
  const runtimeChecks = [
    { id: 'python', kind: 'python' as const, label: 'Python kernel runtime', hint: 'Install Python 3, then enable/trust a Python kernel extension.' },
    { id: 'gpp', kind: 'cpp' as const, label: 'C++ kernel runtime', hint: 'Install g++ (MinGW-w64, Xcode command line tools or build-essential) for the C++ kernel.' },
    { id: 'octave', kind: 'octave' as const, label: 'GNU Octave kernel runtime', hint: 'Install GNU Octave for the Octave kernel.' },
  ];
  for (const check of runtimeChecks) {
    const probe = detectRuntime(check.kind, settings);
    checks.push({
      id: check.id,
      label: check.label,
      ok: probe.ok,
      required: false,
      detail: probe.ok ? (probe.version || probe.path || probe.command) + ' (' + probe.source + ')' : (probe.error || 'not found'),
      ...(probe.path ? { path: probe.path } : {}),
      source: probe.source,
      ...(probe.ok ? {} : { hint: check.hint }),
    });
  }
  let discovery: Awaited<ReturnType<typeof discoverExtensions>> | null = null;
  try {
    discovery = await discoverExtensions(workspace, {});
    const incompatible = discovery.extensions.filter(entry => !entry.compatible);
    const enabled = discovery.extensions.filter(entry => entry.enabled);
    checks.push({ id: 'workspace', label: 'Workspace', ok: true, required: true, detail: workspace });
    checks.push({ id: 'extensions', label: 'Extensions', ok: incompatible.length === 0, required: false, detail: discovery.extensions.length + ' discovered · ' + enabled.length + ' enabled', ...(incompatible.length ? { hint: 'Incompatible: ' + incompatible.map(entry => entry.id).join(', ') } : {}) });
    checks.push({ id: 'workspace-trust', label: 'Workspace trust', ok: discovery.workspaceTrust === 'trusted', required: false, detail: discovery.workspaceTrust, ...(discovery.workspaceTrust !== 'trusted' ? { hint: 'Trust the workspace in the Extensions manager before process kernels can run.' } : {}) });
  } catch (error) {
    checks.push({ id: 'workspace', label: 'Workspace', ok: false, required: true, detail: error instanceof Error ? error.message : String(error), hint: 'Pass --workspace <dir> or --project <dir>.' });
  }
  print({ ok: checks.every(check => check.ok === true || check.required !== true), workspace, dataRoot: resolveDataRootSync(), checks }, pretty);
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
  if (command === 'extension' || command === 'extensions' || command === 'plugin' || command === 'plugins') { await extensionCommand(args, pretty); return; }
  if (command === 'doctor') { await doctorCommand(args, pretty); return; }
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
    process.stdout.write(usage() + '\n\nAgent notes:\n- Always run "hcanvas context --json" first when the user refers to "this canvas".\n- If context is absent or ambiguous, list documents and ask the user; never guess for writes.\n- All writes are revision-checked; read, then apply with --base-revision.\n- HTML edits should patch data-hc-id targets, not rewrite whole documents.\n- Prefer "hcanvas read --format layout" for a compact page/block view, and "hcanvas lint" before presenting a result.\n- Prefer "hcanvas compose scene.json" for new pages instead of hand-computing x/y/w/h.\n');
    return;
  }
  if (command === 'schema') {
    const name = sub as keyof typeof AGENT_SCHEMAS | undefined;
    if (!name) {
      print({ ok: true, schemas: Object.keys(AGENT_SCHEMAS) }, pretty);
      return;
    }
    const schema = AGENT_SCHEMAS[name];
    if (!schema) throw new Error('Unknown schema: ' + name + ' (expected scene, ops, layout)');
    print({ ok: true, name, schema, ...(name === 'scene' ? { example: SCENE_EXAMPLE } : {}) }, pretty);
    return;
  }
  if (command === 'template') {
    if (!sub || sub === 'list') {
      print({ ok: true, templates: listComposeTemplates() }, pretty);
      return;
    }
    throw new Error('Unknown template command: ' + sub + ' (expected list)');
  }
  const conn = await findConnection(args);
  const actor = flagString(args, 'actor') || process.env.HCANVAS_ACTOR || 'cli';
  if (command === 'assets' || command === 'asset') { await assetCommand(conn, args, pretty); return; }

  if (command === 'status') {
    print(await request(conn, '/api/state'), pretty);
    return;
  }
  if (command === 'context') {
    const session = flagString(args, 'session') || process.env.HCANVAS_SESSION;
    const params = new URLSearchParams();
    if (session) params.set('session', session);
    if (flagBool(args, 'brief')) params.set('brief', '1');
    const context = await request<{ active?: { docId?: string; pageId?: string; selection?: string[] } }>(conn, '/api/context' + (params.toString() ? '?' + params.toString() : ''));
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
    if (!sub || sub === 'list') {
      const result = await request<{ docs?: Array<{ id: string; title: string; updatedAt?: string; revision?: number; pages?: number }> }>(conn, '/api/docs');
      let docs = Array.isArray(result.docs) ? result.docs.slice() : [];
      const query = (flagString(args, 'query') || flagString(args, 'q') || '').trim().toLowerCase();
      if (query) docs = docs.filter(doc => doc.id.toLowerCase().includes(query) || doc.title.toLowerCase().includes(query));
      if (flagBool(args, 'recent')) docs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      const limit = Number(flagString(args, 'limit'));
      if (Number.isFinite(limit) && limit > 0) docs = docs.slice(0, Math.floor(limit));
      print({ ok: true, docs }, pretty);
      return;
    }
    if (sub === 'create') {
      const title = flagString(args, 'title') || 'Untitled canvas';
      const presetId = flagString(args, 'preset');
      const presets: Record<string, { width: number; height: number; background: string; title: string; mode?: 'canvas' | 'infinite' }> = {
        slide: { width: 1280, height: 720, background: '#ffffff', title: 'Slide' },
        a4: { width: 794, height: 1123, background: '#ffffff', title: 'A4' },
        poster: { width: 1080, height: 1350, background: '#ffffff', title: 'Poster' },
        square: { width: 1080, height: 1080, background: '#ffffff', title: 'Square' },
        canvas: { width: 1280, height: 720, background: '#fbfaf7', title: 'Canvas', mode: 'canvas' },
        infinite: { width: 4800, height: 3200, background: '#f8f6f1', title: 'Infinite canvas', mode: 'infinite' },
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
    if (flagString(args, 'limit')) params.set('limit', flagString(args, 'limit')!);
    print(await request(conn, '/api/docs/' + docId + '/read?' + params.toString()), pretty);
    await heartbeatIfSession(conn, args, docId, pageId, blockId ? [blockId] : undefined);
    return;
  }
  if (command === 'lint') {
    const docId = await resolveDoc(conn, args, args.positionals[1]);
    const params = new URLSearchParams({ format: 'lint' });
    if (flagString(args, 'page')) params.set('pageId', flagString(args, 'page')!);
    if (flagString(args, 'limit')) params.set('limit', flagString(args, 'limit')!);
    const result = await request<{ summary?: { errors?: number } }>(conn, '/api/docs/' + docId + '/read?' + params.toString());
    print(result, pretty);
    if ((result.summary?.errors || 0) > 0) process.exitCode = 1;
    return;
  }

  if (command === 'compose') {
    const templateId = flagString(args, 'template');
    let scene: ComposeScene;
    if (templateId) {
      const template = getComposeTemplate(templateId);
      if (!template) throw new Error('Unknown compose template: ' + templateId + ' (run hcanvas template list)');
      scene = template.scene;
    } else {
      const sceneFile = args.positionals[1];
      if (!sceneFile) throw new Error('compose requires a scene JSON file, - for stdin, or --template <name>');
      const rawScene = await readTextInput(sceneFile, 'scene');
      let parsedScene: unknown;
      try { parsedScene = JSON.parse(rawScene); } catch { throw new Error('Scene file is not valid JSON'); }
      scene = parsedScene as ComposeScene;
    }
    const assetWarnings: string[] = [];
    if (!flagBool(args, 'dry-run')) await hydrateSceneAssets(conn, scene, assetWarnings);
    const compiled = compileScene(scene, { title: flagString(args, 'title') });
    compiled.warnings.push(...assetWarnings);
    const pageSummaries = compiled.pages.map(page => ({
      id: page.id,
      name: page.name,
      mode: page.mode,
      width: page.width,
      height: page.height,
      blocks: page.blocks?.map(block => ({ id: block.id, type: block.type, x: block.x, y: block.y, w: block.w, h: block.h })) || [],
    }));
    if (flagBool(args, 'dry-run')) {
      print({ ok: true, dryRun: true, title: compiled.title, pages: pageSummaries, warnings: compiled.warnings, blockCount: compiled.blockCount }, pretty);
      return;
    }
    const selector = templateId ? (args.positionals[1] || flagString(args, 'doc')) : (args.positionals[2] || flagString(args, 'doc'));
    let finalDoc: HcDocument;
    if (selector) {
      const docId = await resolveDoc(conn, args, selector);
      const baseRevision = await baseRevisionFor(conn, docId, args);
      const ops = compiled.pages.map(page => ({ op: 'add_page', page }));
      const applied = await request<{ doc: HcDocument }>(conn, '/api/docs/' + docId + '/apply', {
        method: 'POST',
        body: JSON.stringify({ ops, baseRevision, actor, summary: 'Compose ' + compiled.pages.length + ' page(s)' }),
      });
      finalDoc = applied.doc;
    } else {
      const created = await request<{ doc: HcDocument }>(conn, '/api/docs', {
        method: 'POST',
        body: JSON.stringify({ title: compiled.title, preset: compiled.firstPreset }),
      });
      finalDoc = created.doc;
      if (compiled.pages.length > 1) {
        const ops = compiled.pages.slice(1).map(page => ({ op: 'add_page', page }));
        const applied = await request<{ doc: HcDocument }>(conn, '/api/docs/' + finalDoc.id + '/apply', {
          method: 'POST',
          body: JSON.stringify({ ops, baseRevision: finalDoc.revision, actor, summary: 'Compose ' + (compiled.pages.length - 1) + ' additional page(s)' }),
        });
        finalDoc = applied.doc;
      }
    }
    await heartbeatIfSession(conn, args, finalDoc.id);
    print({
      ok: true,
      docId: finalDoc.id,
      revision: finalDoc.revision,
      title: finalDoc.title,
      pages: finalDoc.pages.slice(-compiled.pages.length).map(page => ({ id: page.id, name: page.name, mode: page.mode, blocks: page.blocks?.length || 0 })),
      warnings: compiled.warnings,
      blockCount: compiled.blockCount,
    }, pretty);
    return;
  }

  if (command === 'apply') {
    const docId = await resolveDoc(conn, args, args.positionals[1]);
    const baseRevision = await baseRevisionFor(conn, docId, args);
    const ops = await readOps(args);
    const result = await request(conn, '/api/docs/' + docId + '/apply', {
      method: 'POST',
      body: JSON.stringify({
        ops,
        baseRevision,
        actor,
        summary: flagString(args, 'summary'),
        dryRun: flagBool(args, 'dry-run'),
        compact: flagBool(args, 'compact'),
        idempotencyKey: flagString(args, 'idempotency-key') || flagString(args, 'idempotencyKey'),
      }),
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
    const source = requestedPage ? current.pages.find(page => page.id === requestedPage) : current.pages.find(page => page.mode === 'infinite');
    if (!source) throw new Error('No Infinite page found' + (requestedPage ? ': ' + requestedPage : ''));
    const scene = nativeBlocksToExcalidrawScene(source);
    const out = path.resolve(flagString(args, 'out') || (source.name || 'scene').replace(/[^a-zA-Z0-9_-]+/g, '-') + '.excalidraw');
    await writeFile(out, JSON.stringify(scene, null, 2), 'utf8');
    print({ ok: true, docId, pageId: source.id, pageName: source.name, mode: source.mode, out, elements: scene.elements.length }, pretty);
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
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  let outputPayload: unknown = payload;
  if (record.latestDoc && typeof record.latestDoc === 'object') {
    const latest = record.latestDoc as { id?: string; title?: string; revision?: number; pages?: unknown[] };
    outputPayload = {
      ...record,
      latestDoc: { id: latest.id, title: latest.title, revision: latest.revision, pages: Array.isArray(latest.pages) ? latest.pages.length : 0 },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  let hint = typeof record.hint === 'string' ? record.hint : undefined;
  if (!hint) {
    if (message.includes('No running hcanvas service')) hint = 'Start one with: hcanvas app --project <dir>';
    else if (message.includes('No active document')) hint = 'Run hcanvas docs list or set HCANVAS_DOC / HCANVAS_SESSION.';
    else if (message.includes('--base-revision')) hint = 'Read the document first (hcanvas read <doc>) and pass its revision.';
    else if (message.includes('Ambiguous document')) hint = 'Use the exact document id from hcanvas docs list.';
    else if (message.includes('compose requires')) hint = 'Pass a scene JSON file or --template <name>.';
  }
  process.stderr.write(JSON.stringify({
    ok: false,
    error: message,
    status,
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(hint ? { hint } : {}),
    ...(Object.keys(record).length ? { payload: outputPayload } : {}),
  }) + '\n');
  process.exit(status === 409 ? 2 : 1);
});