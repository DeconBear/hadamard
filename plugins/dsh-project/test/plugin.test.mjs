import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import * as plugin from '../dist/index.js';

async function setup(t, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hadamard-dsh-test-'));
  const config = { homeDir: path.join(root, 'home'), ...extra };
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const state = { workspaces: [{ id: 'ws-a', path: workspace, title: '项目 A', sessionIds: [] }], sessions: [], creates: [], prompts: [] };
  ctx.provide('workspaceRegistry', { list: () => state.workspaces });
  ctx.provide('sessionController', {
    list: async () => ({ items: state.sessions }),
    create: async args => { state.creates.push(args); return { sessionId: `execution-${state.creates.length}` }; },
    prompt: async args => { state.prompts.push(args); return { accepted: true }; },
  });
  ctx.provide('credentials', { async modifyRecord(_key, update) { return update(undefined); } });
  await ctx.plugin(Connection);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const fiber = ctx.plugin(plugin, config); await fiber;
  const handler = ctx.connection.createSharedFetchHandler('/api');
  const raw = (method, payload = {}, { signal, peer = ctx.connection.browserPeer, envelope } = {}) => handler.fetch(
    new Request(`http://localhost/api/hadamard-project/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify(envelope ?? { type: 'client-request', rpcId: 'test', method: `hadamard-project/${method}`, payload }),
    }), peer);
  const rpc = async (method, payload, options) => {
    const response = await raw(method, payload, options);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).result;
  };
  const project = (await rpc('projects')).value.projects[0];
  const call = (method, args = {}, options) => rpc(method, { projectId: project.id, ...args }, options);
  const dataDir = path.join(config.homeDir, '.hadamard', 'projects', project.id);
  return { root, config, ctx, fiber, workspace, state, project, dataDir, raw, rpc, call };
}
function issue(number, extra = {}) {
  return { version: 1, id: `issue-${number}`, number, title: `Issue ${number}`, description: 'Existing description',
    status: 'todo', priority: 'medium', labels: ['scope'], acceptanceCriteria: ['A complete criterion'],
    createdBy: 'user', createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z',
    sessionIds: [], comments: [], metadata: {}, ...extra };
}
async function json(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); }
async function seed(s, issues, mode = 'home') {
  await json(path.join(s.dataDir, 'meta.json'), { status: 'in_progress', issueStorage: mode });
  await json(path.join(mode === 'home' ? s.dataDir : path.join(s.workspace, '.hadamard'), 'issues.json'), { version: 1, nextNumber: issues.length + 1, issues });
}
async function snapshot(root) {
  const result = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name); const info = await stat(file);
      result[path.relative(root, file)] = entry.isDirectory() ? { directory: true, mtime: info.mtimeMs } : { data: await readFile(file, 'utf8'), mtime: info.mtimeMs };
      if (entry.isDirectory()) await walk(file);
    }
  }
  await walk(root); return result;
}

test('registers no model tools, loads without fixed paths, and unregisters its routes', async t => {
  const s = await setup(t);
  assert.deepEqual(s.ctx.tools.schemas(), []);
  assert.deepEqual(await readdir(s.root), ['workspace']);
  assert.equal((await s.call('overview')).value.path, s.workspace);
  await s.fiber.dispose();
  assert.equal((await s.raw('projects')).status, 404);
  assert.deepEqual(s.ctx.tools.schemas(), []);
  const standalone = new Context(); t.after(() => standalone.fiber.dispose());
  await standalone.plugin(plugin); // no tools, commands, registry or connection required
});

test('discovers live projects and inherited sessions without a third-party board, even when an incompatible board exists', async t => {
  const s = await setup(t);
  // The old desktop board has no snapshot/apply methods. Never touch its face.
  s.ctx.provide('taskBoard', new Proxy({}, { get() { throw new Error('Must not access third-party board'); } }));
  s.state.sessions.push(
    { sessionId: 'run-a', cwd: s.workspace, running: true, updatedAt: 100, projections: { values: { title: '真实会话' } } },
    { sessionId: 'child', parentSessionId: 'run-a', running: true, updatedAt: 101 },
    { sessionId: 'run-b', cwd: path.join(s.root, 'B'), running: true, updatedAt: 100 },
    { sessionId: 'old', cwd: path.join(s.root, 'old'), running: false, updatedAt: 1 });
  await seed(s, [issue(1, { status: 'in_progress', sessionIds: ['run-a'], activeSessionId: 'run-a' }), issue(2)]);
  const catalog = (await s.rpc('projects')).value;
  assert.equal(catalog.projects.length, 2);
  assert.equal(catalog.projects[0].name, '项目 A');
  assert.equal(catalog.projects[0].running.length, 2);
  assert.equal(catalog.projects[0].taskCount, 2);
  const board = (await s.call('board')).value;
  assert.deepEqual(board.tasks.map(t => t.id), ['issue-1', 'issue-2']);
  assert.deepEqual(board.sessions.map(s => s.id), ['child']); // no duplicate execution card
  assert.equal((await s.rpc('board', { projectId: catalog.projects[1].id })).value.tasks.length, 0);
  s.state.sessions = [];
  assert.equal((await s.rpc('projects')).value.projects.length, 1);
  assert.equal((await s.call('overview', { projectId: catalog.projects[1].id })).ok, false);
});

test('reads the selected store, filters and pages Issues, and prevents cross-project access', async t => {
  const s = await setup(t);
  await seed(s, Array.from({ length: 25 }, (_, i) => issue(i + 1, { status: i % 2 ? 'blocked' : 'todo' })));
  const before = await snapshot(s.root);
  assert.equal((await s.call('overview', { workDir: '/ignored', homeDir: '/ignored' })).value.path, s.workspace);
  assert.equal((await s.call('issues')).value.total, 25);
  assert.equal((await s.call('issues', { offset: 20 })).value.issues.length, 5);
  assert.equal((await s.call('issues', { status: 'blocked', query: 'scope' })).value.total, 12);
  assert.equal((await s.call('issues', { query: 'ISS-25' })).value.issues[0].number, 25);
  assert.deepEqual((await s.call('issue', { id: 'issue-1' })).value.acceptanceCriteria, ['A complete criterion']);
  s.state.workspaces.push({ id: 'ws-b', path: path.join(s.root, 'B'), title: 'B', sessionIds: [] });
  const second = (await s.rpc('projects')).value.projects.find(p => p.name === 'B');
  assert.equal((await s.rpc('issue', { projectId: second.id, id: 'issue-1' })).value, null);
  assert.equal((await s.call('issue', { projectId: '../elsewhere', id: 'issue-1' })).ok, false);
  for (const args of [{ limit: 0 }, { offset: -1 }, { status: 'wrong' }, { query: {} }]) assert.equal((await s.call('issues', args)).ok, false);
  assert.deepEqual(await snapshot(s.root), before);
  await seed(s, [issue(80)], 'workspace');
  assert.equal((await s.call('issues')).value.issues[0].number, 80);
});

test('reads scoped Markdown/design/plan documents and rejects traversal, symlinks and oversized content', async t => {
  const s = await setup(t);
  await mkdir(path.join(s.workspace, 'docs'));
  await writeFile(path.join(s.workspace, 'README.md'), '# Hello\n<script>alert(1)</script>');
  await writeFile(path.join(s.workspace, 'docs/guide.md'), '# Guide');
  await mkdir(path.join(s.workspace, '.hadamard/design'), { recursive: true });
  await writeFile(path.join(s.workspace, '.hadamard/design/design.md'), '# Design');
  await json(path.join(s.dataDir, 'plan.json'), { today: ['Build project page'] });
  const before = await snapshot(s.root);
  assert.deepEqual((await s.call('documents')).value.documents.map(d => d.id).sort(), ['design', 'plan', 'workspace:README.md', 'workspace:docs/guide.md']);
  assert.match((await s.call('document', { id: 'workspace:README.md' })).value.content, /# Hello/);
  assert.match((await s.call('document', { id: 'plan' })).value.content, /Build project page/);
  for (const id of ['workspace:../home/secret.md', '../home', s.workspace]) assert.equal((await s.call('document', { id })).ok, false);
  assert.deepEqual(await snapshot(s.root), before);
  await writeFile(path.join(s.workspace, 'large.md'), 'x'.repeat(524289));
  assert.equal((await s.call('document', { id: 'workspace:large.md' })).ok, false);
  const outside = path.join(s.root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'secret.md'), 'private');
  await symlink(outside, path.join(s.workspace, 'docs/link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(!(await s.call('documents')).value.documents.some(d => d.title.includes('secret')));
  assert.equal((await s.call('document', { id: 'workspace:docs/link/secret.md' })).ok, false);
  await rename(path.join(s.workspace, 'docs'), path.join(s.workspace, 'old-docs'));
  await symlink(outside, path.join(s.workspace, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(!(await s.call('documents')).value.documents.some(d => d.title.includes('secret')));
});

test('board creates share Issues storage, serialize concurrent writes, and deduplicate retries', async t => {
  const s = await setup(t);
  await seed(s, [], 'workspace');
  const results = await Promise.all(['one', 'two', 'one'].map(requestId =>
    s.call('board-action', { requestId, kind: 'create', title: requestId, prompt: 'Build it', workDir: 'malicious' })));
  assert.ok(results.every(result => result.ok));
  const board = (await s.call('board')).value;
  const issues = (await s.call('issues')).value;
  assert.equal(board.tasks.length, 2);
  assert.deepEqual(new Set(board.tasks.map(task => task.id)), new Set(issues.issues.map(issue => issue.id)));
  assert.deepEqual(board.tasks.map(task => task.number).sort(), [1, 2]);
  assert.equal(JSON.parse(await readFile(path.join(s.workspace, '.hadamard/issues.json'))).issues.length, 2);
  assert.equal(s.state.creates.length, 0);
  assert.equal(s.state.prompts.length, 0);
  const taskId = board.tasks[0].id;
  assert.equal((await s.call('board-action', { requestId: 'move', kind: 'move', taskId, status: 'cancelled' })).ok, true);
  assert.equal((await s.call('issue', { id: taskId })).value.status, 'cancelled');
});

test('execution uses DSH directly with the selected cwd and default permissions; enforces states and project isolation', async t => {
  const s = await setup(t);
  await seed(s, [issue(1)]);
  for (const args of [{ kind: 'run', taskId: 'other' }, { kind: 'delete', taskId: 'issue-1' },
    { kind: 'move', taskId: 'issue-1', status: 'invalid' }, { kind: 'move', taskId: 'issue-1', status: 'in_progress' }]) {
    assert.equal((await s.call('board-action', { requestId: 'reject', ...args })).ok, false);
  }
  s.state.workspaces.push({ id: 'ws-b', path: path.join(s.root, 'B'), title: 'B', sessionIds: [] });
  const second = (await s.rpc('projects')).value.projects.find(p => p.name === 'B');
  assert.equal((await s.rpc('board-action', { projectId: second.id, requestId: 'cross', kind: 'run', taskId: 'issue-1' })).ok, false);
  const run = { requestId: 'run-1', kind: 'run', taskId: 'issue-1', cwd: 'malicious', permissionMode: 'bypass' };
  assert.equal((await s.call('board-action', run)).ok, true);
  assert.deepEqual(s.state.creates, [{ cwd: s.workspace }]);
  assert.deepEqual(s.state.prompts, [{ requestId: 'run-1', sessionId: 'execution-1', mode: 'queue',
    content: [{ type: 'text', text: '任务：Issue 1\n\nExisting description\n\n验收标准：\n- A complete criterion' }] }]);
  s.state.sessions.push({ sessionId: 'execution-1', cwd: s.workspace, running: true, updatedAt: 100 });
  assert.equal((await s.call('board-action', run)).ok, true);
  assert.equal(s.state.creates.length, 1);
  assert.equal((await s.call('issue', { id: 'issue-1' })).value.status, 'in_progress');
  assert.equal((await s.call('board')).value.sessions.length, 0);
  assert.equal((await s.call('board-action', { requestId: 'move', kind: 'move', taskId: 'issue-1', status: 'in_review' })).ok, false);
  s.state.sessions[0].running = false;
  assert.equal((await s.call('board-action', { requestId: 'review', kind: 'move', taskId: 'issue-1', status: 'in_review' })).ok, true);
  assert.equal((await s.call('board-action', { requestId: 'done', kind: 'move', taskId: 'issue-1', status: 'done' })).ok, true);
  assert.equal((await s.call('board-action', { ...run, requestId: 'again' })).ok, false);
});

test('failed DSH dispatch restores todo and permits retry without losing issue content', async t => {
  const s = await setup(t);
  await seed(s, [issue(1)]);
  const original = s.ctx.sessionController.prompt;
  s.ctx.sessionController.prompt = async () => { throw new Error('Dispatch unavailable'); };
  const run = { requestId: 'retry', kind: 'run', taskId: 'issue-1' };
  assert.match((await s.call('board-action', run)).error.message, /Dispatch unavailable/);
  const failed = (await s.call('issue', { id: 'issue-1' })).value;
  assert.equal(failed.status, 'todo');
  assert.ok(!failed.activeSessionId);
  assert.equal(failed.description, 'Existing description');
  assert.match((await s.call('board')).value.tasks[0].dispatchError, /Dispatch unavailable/);
  s.ctx.sessionController.prompt = original;
  assert.equal((await s.call('board-action', run)).ok, true);
  assert.equal((await s.call('issue', { id: 'issue-1' })).value.status, 'in_progress');
  assert.equal((await s.call('board')).value.tasks[0].dispatchError, undefined);
});

test('actual authenticated HTTP carrier coexists with the host gateway and rejects guests', async t => {
  const s = await setup(t);
  s.ctx.webServer.register({ kind: 'exact', path: '/', handler(req, res) { if (s.ctx.connection.authorizeIndex(req, res)) res.end('fixture'); } });
  s.ctx.connection.rpc.intercept('/api', endpoint => endpoint.startsWith('settings/'), async () => ({ ok: true, value: 'host gateway' }));
  const origin = s.ctx.webServer.getOrigin();
  const login = await fetch(s.ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (method, authenticated = true) => fetch(`${origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId: 'http-test', method, payload: {} }),
  });
  assert.equal((await (await call('hadamard-project/projects')).json()).result.value.projects.length, 1);
  assert.equal((await call('hadamard-project/projects', false)).status, 401);
  assert.equal((await s.raw('projects', {}, { peer: { ...s.ctx.connection.browserPeer, principal: { kind: 'test-guest' } } })).status, 403);
  assert.equal((await (await call('settings/describe')).json()).result.value, 'host gateway');
});

test('malformed input, canceled reads, corrupt data and size limits fail without data changes', async t => {
  const s = await setup(t, { maxOutputBytes: 1024 });
  await seed(s, [issue(1, { description: '中'.repeat(1000) })]);
  assert.match((await s.call('issue', { id: 'issue-1' })).error.message, /maxOutputBytes/);
  assert.equal((await s.raw('projects', {}, { envelope: {} })).status, 400);
  const canceled = await s.call('overview', {}, { signal: AbortSignal.abort() });
  assert.equal(canceled.ok, false); assert.equal(canceled.error.code, 'cancelled');
  await writeFile(path.join(s.dataDir, 'issues.json'), '{bad json');
  const before = await snapshot(s.root);
  assert.equal((await s.call('issues')).ok, false);
  assert.equal((await s.rpc('projects')).value.projects[0].taskCount, null);
  assert.equal((await s.call('documents')).ok, true);
  assert.deepEqual(await snapshot(s.root), before);
});

test('rejects relative operator paths and invalid response limits', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  for (const config of [{ workDir: '.' }, { homeDir: 'relative' }, { maxOutputBytes: 1 }, { maxOutputBytes: 1024.5 }]) {
    await assert.rejects(async () => { await ctx.plugin(plugin, config); });
  }
});
