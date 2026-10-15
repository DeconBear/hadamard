import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Commands from '@deepseek-ai/dsh-commands';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import * as plugin from '../dist/index.js';

let calls = 0;
async function setup(t, { commands = false, ...extra } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hadamard-dsh-test-'));
  const config = { workDir: path.join(root, 'workspace'), homeDir: path.join(root, 'home'), ...extra };
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  if (commands) await ctx.plugin(Commands);
  const fiber = ctx.plugin(plugin, config);
  await fiber;
  const call = (name, args = {}, signal = new AbortController().signal) => ctx.tools.execute({
    name, arguments: args, callId: ToolCallId(`project-${++calls}`), signal,
  });
  const project = success(await call('hadamard_project_get'));
  const dataDir = path.join(config.homeDir, '.hadamard', 'projects', project.id);
  return { root, config, ctx, fiber, call, dataDir };
}
function success(result) {
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), result.value);
  return result.value;
}
function issue(number, extra = {}) {
  return {
    version: 1, id: `issue-${number}`, number, title: `Issue ${number}`,
    description: 'Existing description', status: 'todo', priority: 'medium',
    labels: ['scope'], acceptanceCriteria: ['A real complete acceptance criterion'],
    createdBy: 'user', createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z',
    sessionIds: [], comments: [], metadata: {}, ...extra,
  };
}
async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}
async function seed(s, issues, mode = 'home') {
  await json(path.join(s.dataDir, 'meta.json'), { status: 'in_progress', issueStorage: mode });
  const target = mode === 'home' ? s.dataDir : path.join(s.config.workDir, '.hadamard');
  await json(path.join(target, 'issues.json'), { version: 1, nextNumber: issues.length + 1, issues });
}
async function snapshot(root) {
  const result = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const info = await stat(file);
      result[path.relative(root, file)] = entry.isDirectory()
        ? { directory: true, mtime: info.mtimeMs }
        : { data: await readFile(file, 'utf8'), mtime: info.mtimeMs };
      if (entry.isDirectory()) await walk(file);
    }
  }
  await walk(root);
  return result;
}

test('loads using real Cordis/DSH and registers only three read-only tools without creating storage', async t => {
  const s = await setup(t);
  assert.deepEqual((await readdir(s.root)), []);
  assert.deepEqual(s.ctx.tools.schemas().map(x => x.name).sort(), ['hadamard_issue_get', 'hadamard_issue_list', 'hadamard_project_get']);
  const project = success(await s.call('hadamard_project_get', { workDir: '/ignored/model/path', homeDir: '/ignored/home' }));
  assert.equal(project.path, s.config.workDir);
  assert.equal(project.status, 'not_started');
  assert.deepEqual(project.issueCounts, { total: 0, open: 0, review: 0, closed: 0 });
  assert.deepEqual(success(await s.call('hadamard_issue_list')).issues, []);
  assert.equal(success(await s.call('hadamard_issue_get', { idOrNumber: 1 })), null);
  await s.fiber.dispose();
  assert.deepEqual(s.ctx.tools.schemas(), []);
  assert.deepEqual(await readdir(s.root), []);
});

test('home-storage records, full issue detail, counts, and status command preserve state byte-for-byte', async t => {
  const s = await setup(t, { commands: true });
  const records = [issue(1, { status: 'in_review', parentIssueId: 'parent', comments: [{ id: 'c1', kind: 'progress', actor: 'agent', body: 'Read me', createdAt: '2026-10-14T10:00:00.000Z' }] }), issue(2, { status: 'done' }), issue(3, { status: 'cancelled' })];
  await seed(s, records);
  const before = await snapshot(s.root);
  const project = success(await s.call('hadamard_project_get'));
  assert.equal(project.status, 'in_progress');
  assert.deepEqual(project.issueCounts, { total: 3, open: 1, review: 1, closed: 2 });
  const listed = success(await s.call('hadamard_issue_list'));
  assert.equal(listed.total, 3);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.issues[0].acceptanceCriteria, records[0].acceptanceCriteria);
  assert.equal(listed.issues[0].description, undefined);
  for (const idOrNumber of [1, '1', 'ISS-1', 'issue-1']) {
    assert.deepEqual(success(await s.call('hadamard_issue_get', { idOrNumber })), records[0]);
  }
  const events = [];
  const agent = { session: { append(type, value) { events.push({ type, value }); return events.length; } } };
  const command = await s.ctx.commands.execute(agent, '/project status', [], new AbortController().signal);
  assert.equal(command.result.kind, 'success');
  assert.match(command.result.text, /1 open \(1 in review\), 2 closed/);
  assert.deepEqual(events.map(x => x.type), ['command/run', 'command/done']);
  const badCommand = await s.ctx.commands.execute(agent, '/project start', [], new AbortController().signal);
  assert.equal(badCommand.result.kind, 'error');
  await s.fiber.dispose();
  assert.equal(s.ctx.commands.find(agent, 'project'), undefined);
  assert.deepEqual(await snapshot(s.root), before);
  const again = s.ctx.plugin(plugin, s.config);
  await again;
  assert.equal(s.ctx.tools.schemas().length, 3);
  assert.equal(s.ctx.commands.list(agent).length, 1);
  await again.dispose();
  assert.deepEqual(await snapshot(s.root), before);
});

test('reloads selected workspace/home store on each read and pages without dropping criteria', async t => {
  const s = await setup(t);
  await seed(s, [issue(1)]);
  await seed(s, Array.from({ length: 23 }, (_, i) => issue(i + 10)), 'workspace');
  const first = success(await s.call('hadamard_issue_list'));
  assert.equal(first.issues.length, 20);
  assert.equal(first.total, 23);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.truncated, true);
  const last = success(await s.call('hadamard_issue_list', { offset: first.nextOffset }));
  assert.equal(last.issues.length, 3);
  assert.equal(last.nextOffset, null);
  assert.equal(success(await s.call('hadamard_issue_get', { idOrNumber: 1 })), null);
  await json(path.join(s.dataDir, 'meta.json'), { issueStorage: 'home' });
  assert.equal(success(await s.call('hadamard_issue_list')).issues[0].number, 1);
});

test('validates IDs and page arguments through the actual tool registry', async t => {
  const s = await setup(t);
  for (const idOrNumber of ['', ' ', 0, -1, 1.5, {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await s.call('hadamard_issue_get', { idOrNumber })).isError, true);
  }
  assert.equal((await s.call('hadamard_issue_get')).isError, true);
  for (const args of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal((await s.call('hadamard_issue_list', args)).isError, true);
  }
  assert.deepEqual(await readdir(s.root), []);
});

test('cancellation and malformed issue JSON return errors without repair or writes', async t => {
  const s = await setup(t);
  await seed(s, [issue(1)]);
  await writeFile(path.join(s.dataDir, 'issues.json'), '{bad json');
  const before = await snapshot(s.root);
  assert.equal((await s.call('hadamard_issue_list')).isError, true);
  const aborted = AbortSignal.abort(new Error('test cancellation'));
  assert.equal((await s.call('hadamard_project_get', {}, aborted)).isError, true);
  await s.fiber.dispose();
  assert.deepEqual(await snapshot(s.root), before);
});

test('caps UTF-8 output, rejects oversized detail/criteria truthfully, and never silently truncates', async t => {
  const s = await setup(t, { maxOutputBytes: 1024 });
  await seed(s, [issue(1, { description: '中'.repeat(1000) })]);
  assert.equal(success(await s.call('hadamard_issue_list')).issues.length, 1);
  const detail = await s.call('hadamard_issue_get', { idOrNumber: 1 });
  assert.equal(detail.isError, true);
  assert.equal(detail.value, undefined);
  assert.match(detail.error.message, /No partial issue or acceptance criteria/);
  await seed(s, [issue(1, { acceptanceCriteria: ['中'.repeat(1000)] })]);
  const page = await s.call('hadamard_issue_list', { limit: 1 });
  assert.equal(page.isError, true);
  assert.match(page.error.message, /maxOutputBytes/);
});

test('config requires explicit absolute scope and rejects invalid result caps before registration', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
  for (const config of [{}, { workDir: '.', homeDir: '/tmp/home' }, { workDir: '/tmp/project', homeDir: 'relative' }, { workDir: '/tmp/project', homeDir: '/tmp/home', maxOutputBytes: 1 }]) {
    await assert.rejects(async () => { await ctx.plugin(plugin, config); });
    assert.deepEqual(ctx.tools.schemas(), []);
  }
});
