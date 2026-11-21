#!/usr/bin/env node
/**
 * End-to-end NPM extension flow through the real GUI and HTTP route using a
 * local fake registry: install v1, update to v2 with overwrite, reject a
 * corrupted v3 (rollback), then uninstall. No public npm access is required.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const port = Number(process.env.HCANVAS_NPM_E2E_PORT || 46930);
const packageName = 'acme-browser-npm';
const extensionId = 'com.acme.browser-npm';
let browser;
let server;
let registryServer;

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
  console.log('PASS ' + name);
}

async function createPackage(base, version, integrityOverride) {
  const dir = path.join(base, 'v' + version);
  const packageDir = path.join(dir, 'package');
  await mkdir(path.join(packageDir, 'dist'), { recursive: true });
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: packageName, version, description: 'Fake npm extension', keywords: ['hcanvas-extension'], license: 'MIT',
  }, null, 2));
  await writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify({
    schema: 'hcanvas-extension/1', id: extensionId, name: 'Browser NPM Extension', version,
    engines: { hcanvas: '>=0.1.0' }, capabilities: {}, contributes: { commands: [{ id: 'browser.npm', title: 'Browser npm' }] },
  }, null, 2));
  await writeFile(path.join(packageDir, 'README.md'), '# fake npm extension\n');
  await writeFile(path.join(packageDir, 'LICENSE'), 'MIT\n');
  await writeFile(path.join(packageDir, 'dist', 'index.js'), 'export const version = "' + version + '";\n');
  const tarball = path.join(dir, 'package.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', dir, 'package'], { stdio: 'pipe' });
  const bytes = await (await import('node:fs/promises')).readFile(tarball);
  return { version, bytes, integrity: integrityOverride || ('sha512-' + createHash('sha512').update(bytes).digest('base64')) };
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-npm-e2e-'));
  try {
    const packages = {
      '1.0.0': await createPackage(workspace, '1.0.0'),
      '2.0.0': await createPackage(workspace, '2.0.0'),
      '3.0.0': await createPackage(workspace, '3.0.0', 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='),
    };
    registryServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/tarballs/')) {
        const version = url.pathname.slice('/tarballs/'.length).replace(/\.tgz$/, '');
        const pkg = packages[version];
        if (!pkg) { res.writeHead(404); res.end('missing'); return; }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(pkg.bytes);
        return;
      }
      if (url.pathname === '/acme-browser-npm') {
        const versions = {};
        for (const [version, pkg] of Object.entries(packages)) {
          versions[version] = { name: packageName, version, dist: { tarball: 'http://127.0.0.1:' + registryPort + '/tarballs/' + version + '.tgz', integrity: pkg.integrity } };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: packageName, 'dist-tags': { latest: '2.0.0' }, versions }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise(resolve => registryServer.listen(0, '127.0.0.1', resolve));
    const registryPort = registryServer.address().port;
    const registryUrl = 'http://127.0.0.1:' + registryPort;
    server = spawn(process.execPath, ['bin/hcanvas.js', 'serve', '--workspace', workspace, '--port', String(port)], {
      cwd: root,
      env: { ...process.env, HCANVAS_CONFIG_HOME: path.join(workspace, '.config'), HCANVAS_HOME: path.join(workspace, '.home'), HADAMARD_HOME: path.join(workspace, '.home'), HCANVAS_NPM_REGISTRY: registryUrl },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timed out: ' + output)), 20_000);
      server.stdout.on('data', chunk => {
        output += String(chunk);
        for (const line of output.split(/\r?\n/)) {
          try { const value = JSON.parse(line); if (value.url && value.token) { clearTimeout(timer); resolve(value); return; } } catch { /* startup json */ }
        }
      });
      server.stderr.on('data', chunk => { output += String(chunk); });
      server.once('error', reject);
      server.once('exit', code => reject(new Error('server exited ' + code + ': ' + output)));
    });
    const base = String(info.url).replace(/\/$/, '');
    const api = async (pathname, init = {}) => {
      const response = await fetch(base + pathname, { ...init, headers: { 'x-hcanvas-token': info.token, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
      return { status: response.status, body: await response.json() };
    };
    await api('/api/workspace/trust', { method: 'POST', body: JSON.stringify({ trust: 'trusted' }) });
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.getElementById('extensionManagerBtn')?.click());
    await page.waitForSelector('.plugin-manager-modal');
    const openInstall = async () => {
      await page.locator('[data-extensions-install-npm]').click();
      await page.locator('#installNpmName').waitFor();
    };
    await openInstall();
    await page.locator('#installNpmName').fill(packageName);
    await page.locator('#installNpmVersion').fill('1.0.0');
    await page.locator('#installNpmOk').click();
    await page.waitForSelector('.plugin-manager-modal');
    await page.locator('.extension-row', { hasText: extensionId }).waitFor();
    assert('GUI installs a package from the fake npm registry', (await page.locator('.extension-row', { hasText: extensionId }).innerText()).includes('npm ' + packageName));
    await openInstall();
    await page.locator('#installNpmName').fill(packageName);
    await page.locator('#installNpmVersion').fill('2.0.0');
    await page.locator('#installNpmOverwrite').check();
    await page.locator('#installNpmOk').click();
    await page.waitForSelector('.plugin-manager-modal');
    await page.waitForFunction(() => [...document.querySelectorAll('.extension-row')].some(row => row.textContent?.includes('v2.0.0')));
    assert('GUI update replaces the package version', (await page.locator('.extension-row', { hasText: extensionId }).innerText()).includes('v2.0.0'));
    const failed = await api('/api/extensions/install', { method: 'POST', body: JSON.stringify({ source: 'npm', packageName, version: '3.0.0', overwrite: true, registry: registryUrl }) });
    assert('corrupted package is rejected', failed.status === 400, JSON.stringify(failed.body));
    const catalog = await api('/api/extensions');
    const entry = (catalog.body.extensions || []).find(item => item.id === extensionId);
    assert('failed update keeps the previous version installed', entry?.version === '2.0.0', JSON.stringify(entry));
    await page.locator('.extension-row', { hasText: extensionId }).locator('[data-extension-uninstall]').click();
    await page.waitForSelector('#confirmOk');
    await page.locator('#confirmOk').click();
    await page.waitForTimeout(800);
    const after = await api('/api/extensions');
    assert('GUI uninstall removes the npm package', !(after.body.extensions || []).some(item => item.id === extensionId));
    assert('no browser page errors', errors.length === 0, errors.join('; '));
    console.log('NPM extension E2E passed');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) server.kill();
    if (registryServer) await new Promise(resolve => registryServer.close(resolve)).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
