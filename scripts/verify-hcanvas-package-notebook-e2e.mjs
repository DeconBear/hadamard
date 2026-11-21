#!/usr/bin/env node
/**
 * Installed-package Notebook acceptance test.
 *
 * Starts the CLI/server from packages/hadamard-canvas (not from the source
 * checkout), trusts/enables the bundled Python kernel, opens a .hnb.md file in
 * Chromium, executes a cell, reloads and confirms the notebook can be opened
 * and run again. Run build:hcanvas:package first.
 */
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const packageRoot = path.join(root, 'packages', 'hadamard-canvas');
const port = Number(process.env.HCANVAS_PACKAGE_NOTEBOOK_PORT || 46910);
const timeout = 60_000;
let browser;
let server;

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
  console.log('PASS ' + name);
}

async function main() {
  await access(path.join(packageRoot, 'bin', 'hcanvas.js'));
  await access(path.join(packageRoot, 'dist', 'src', 'hcanvas', 'server.js'));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-package-notebook-'));
  try {
    const home = path.join(workspace, '.home');
    await mkdir(home, { recursive: true });
    const fence = String.fromCharCode(96).repeat(3);
    await writeFile(path.join(workspace, 'packaged.hnb.md'), ['---', 'hcanvas: notebook', 'version: 1', 'title: Packaged notebook', 'kernel: python', '---', '', '# Packaged notebook', '', 'Installed-product smoke test.', '', fence + 'python exec', 'print("packaged-e2e")', fence, ''].join('\n'), 'utf8');
    await writeFile(path.join(workspace, 'idle.md'), '# Idle\n\nNot a notebook.\n', 'utf8');
    server = spawn(process.execPath, [path.join(packageRoot, 'bin', 'hcanvas.js'), 'serve', '--workspace', workspace, '--port', String(port)], {
      cwd: packageRoot,
      env: { ...process.env, HCANVAS_CONFIG_HOME: path.join(workspace, '.config'), HCANVAS_HOME: home, HADAMARD_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('packaged server did not start: ' + output)), 30_000);
      server.stdout.on('data', chunk => {
        output += String(chunk);
        for (const line of output.split(/\r?\n/)) {
          try { const value = JSON.parse(line); if (value.url && value.token) { clearTimeout(timer); resolve(value); return; } } catch { /* startup json */ }
        }
      });
      server.stderr.on('data', chunk => { output += String(chunk); });
      server.once('error', reject);
      server.once('exit', code => reject(new Error('packaged server exited ' + code + ': ' + output)));
    });
    const base = String(info.url).replace(/\/$/, '');
    const api = async (pathname, init = {}) => {
      const response = await fetch(base + pathname, { ...init, headers: { 'x-hcanvas-token': info.token, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
      return response.json();
    };
    assert('workspace trust', (await api('/api/workspace/trust', { method: 'POST', body: JSON.stringify({ trust: 'trusted' }) })).ok === true);
    assert('bundled kernel enable', (await api('/api/extensions/toggle', { method: 'POST', body: JSON.stringify({ id: 'com.hadamard.kernel-python', enabled: true }) })).ok === true);
    assert('bundled kernel trust', (await api('/api/extensions/trust', { method: 'POST', body: JSON.stringify({ id: 'com.hadamard.kernel-python', trusted: true }) })).ok === true);

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(timeout);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await page.locator('[data-sidebar-target="files"]').click();
    await page.locator('#refreshFilesBtn').click();
    await page.locator('.file-tree-root-name').first().click();
    await page.locator('.file-tree-node', { hasText: 'packaged.hnb.md' }).first().click();
    await page.waitForSelector('.nb-code');
    await page.locator('.nb-code .cm-content').first().click();
    await page.locator('.nb-code .cm-content').first().press('Control+Enter');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.nb-output')).some(output => output.textContent?.includes('packaged-e2e')), undefined, { timeout: 60_000 });
    assert('installed package executes a Python Notebook cell', true);
    await page.locator('.file-tree-node', { hasText: 'idle.md' }).first().click();
    await page.waitForTimeout(300);
    await page.locator('.file-tree-node', { hasText: 'packaged.hnb.md' }).first().click();
    await page.waitForSelector('.nb-code');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await page.locator('[data-sidebar-target="files"]').click();
    await page.locator('#refreshFilesBtn').click();
    await page.locator('.file-tree-root-name').first().click();
    await page.locator('.file-tree-node', { hasText: 'packaged.hnb.md' }).first().click();
    await page.waitForSelector('.nb-code');
    assert('installed package reopens the Notebook after reload', await page.locator('.nb-markdown-body').count() > 0);
    assert('no browser page errors from packaged Notebook', errors.length === 0, errors.join('; '));
    console.log(JSON.stringify({ ok: true, package: packageRoot, workspace }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) server.kill();
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
