import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { composeEntries, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('packed npm bundle loads compiled code outside repository with only host dependencies', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-hadamard-packed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: packageRoot, encoding: 'utf8' }))[0];
  const files = packed.files.map(file => file.path).sort();
  assert.ok(files.includes('dist/index.js'));
  assert.ok(files.includes('dist/index.d.ts'));
  assert.ok(files.includes('cordis.patch.yml'));
  assert.ok(files.every(file => /^(dist\/|README\.md$|LICENSE$|package\.json$|cordis\.patch\.yml$)/.test(file)), JSON.stringify(files));
  execFileSync('tar', ['-xzf', path.join(root, packed.filename), '-C', root]);
  // Only the real host packages are available. No Hadamard source tree is copied or linked.
  await symlink(path.join(packageRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = JSON.parse(await readFile(path.join(root, 'package/package.json'), 'utf8'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  const bundle = loadOptionalPatches('dsh', path.join(root, 'package', manifest.dsh.bundle.patch));
  const readme = await readFile(path.join(root, 'package/README.md'), 'utf8');
  const example = readme.match(/```yaml\n([\s\S]+?)```/)[1]
    .replace('/absolute/path/to/workspace', JSON.stringify(path.join(root, 'workspace')))
    .replace('/absolute/path/to/user-home', JSON.stringify(path.join(root, 'home')));
  const profileFile = path.join(root, 'profile.patch.yml');
  await writeFile(profileFile, example);
  const profile = loadOptionalPatches('dsh', profileFile);
  const rows = composeEntries([bundle, profile]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'hadamard-project');
  assert.equal(rows[0].name, manifest.name);
  assert.deepEqual(rows[0].config, { workDir: path.join(root, 'workspace'), homeDir: path.join(root, 'home'), maxOutputBytes: 65536 });
  const entry = path.join(root, 'package', manifest.main);
  const source = await readFile(entry, 'utf8');
  assert.doesNotMatch(source, /from\s+["']\.\.\//);
  assert.doesNotMatch(source, /(?:writeFile|mkdir|rename|copyFile|createProjectIssue|transitionProjectIssue)\s*\(/);
  const plugin = await import(pathToFileURL(entry).href);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
  const fiber = ctx.plugin(plugin, rows[0].config);
  await fiber;
  const result = await ctx.tools.execute({ name: 'hadamard_project_get', arguments: {}, callId: ToolCallId('packed'), signal: new AbortController().signal });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.path, path.join(root, 'workspace'));
  await fiber.dispose();
  assert.deepEqual(ctx.tools.schemas(), []);
});
