import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { composeEntries, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('packed npm bundle loads compiled code outside repository with only host dependencies', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-hadamard-packed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Windows cannot spawn npm.cmd without a shell (Node blocks .cmd/.bat since the CVE-2024-27980 fix).
  const packed = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
    cwd: packageRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }))[0];
  const files = packed.files.map(file => file.path).sort();
  assert.ok(files.includes('dist/index.js'));
  assert.ok(files.includes('dist/index.d.ts'));
  assert.ok(files.includes('dist/client.js'));
  assert.ok(files.includes('cordis.patch.yml'));
  assert.ok(files.every(file => /^(dist\/|README\.md$|LICENSE$|package\.json$|cordis\.patch\.yml$)/.test(file)), JSON.stringify(files));
  execFileSync('tar', ['-xzf', path.join(root, packed.filename), '-C', root]);
  // Only the real host packages are available. No Hadamard source tree is copied or linked.
  await symlink(path.join(packageRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = JSON.parse(await readFile(path.join(root, 'package/package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { '@deepseek-ai/schemastery': '3.18.5' });
  assert.equal(manifest.dsh.engines.dsh, '>=0.2.1-rc.2');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  const clientSource = await readFile(path.join(root, 'package', manifest.exports['./client']), 'utf8');
  let registration;
  runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    // Markdown's browser entity decoder allocates a textarea at module load.
    // Real decoding/rendering is exercised in the DSH browser smoke check.
    document: { createElement() { return {}; } },
  });
  assert.equal(registration.id, manifest.name);
  const client = registration.factory(createRequire(import.meta.url));
  assert.equal(typeof client.apply, 'function');
  assert.equal(client.PANEL_ID, 'hadamard-project');
  const bundle = loadOptionalPatches('dsh', path.join(root, 'package', manifest.dsh.bundle.patch));
  const readme = await readFile(path.join(root, 'package/README.md'), 'utf8');
  // Tolerate a CRLF checkout: the README is stored LF but Windows checkouts materialize CRLF.
  const example = readme.match(/```yaml\r?\n([\s\S]+?)```/)[1]
    .replace('/absolute/path/to/workspace', JSON.stringify(path.join(root, 'workspace')))
    .replace('/absolute/path/to/user-home', JSON.stringify(path.join(root, 'home')));
  const profileFile = path.join(root, 'profile.patch.yml');
  await writeFile(profileFile, example);
  const profile = loadOptionalPatches('dsh', profileFile);
  const rows = composeEntries([bundle, profile]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'hadamard-project');
  assert.equal(rows[0].name, manifest.name);
  assert.deepEqual(rows[0].config, { homeDir: path.join(root, 'home'), maxOutputBytes: 1048576 });
  const entry = path.join(root, 'package', manifest.main);
  const source = await readFile(entry, 'utf8');
  assert.doesNotMatch(source, /from\s+["']\.\.\//);
  assert.doesNotMatch(source, /taskBoard|@linxin666/);
  assert.doesNotMatch(clientSource, /@linxin666/);
  assert.ok(!Object.keys(manifest.devDependencies).some(name => name.startsWith('@linxin666/')));
  const plugin = await import(pathToFileURL(entry).href);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
  const fiber = ctx.plugin(plugin, rows[0].config);
  await fiber;
  assert.deepEqual(ctx.tools.schemas(), []);
  await fiber.dispose();
  assert.deepEqual(ctx.tools.schemas(), []);
});
