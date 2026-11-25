#!/usr/bin/env node
/**
 * Windows desktop-shell smoke E2E using the local Electron binary and a
 * locally assembled unpacked app directory (no electron-builder download).
 * Verifies the real Electron main process, window, trust flow and a Notebook
 * cell execution/reopen. The signed installer artifact remains a separate
 * release step.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const appDir = path.join(root, 'build-artifacts', 'desktop-app');
const packagedExe = process.env.HCANVAS_DESKTOP_EXE ? path.resolve(process.env.HCANVAS_DESKTOP_EXE) : undefined;
const electronExe = packagedExe || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const port = Number(process.env.HCANVAS_DESKTOP_E2E_PORT || 47120);
const debugPort = Number(process.env.HCANVAS_DESKTOP_DEBUG_PORT || 9223);
let electronProcess;
let browser;
let workspace;

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
  console.log('PASS ' + name);
}

async function assembleApp() {
  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  await cp(path.join(root, 'dist'), path.join(appDir, 'dist'), { recursive: true });
  await mkdir(path.join(appDir, 'assets'), { recursive: true });
  for (const icon of ['hcanvas-icon.ico', 'hcanvas-icon.png']) {
    await cp(path.join(root, 'assets', icon), path.join(appDir, 'assets', icon)).catch(() => undefined);
  }
  await cp(path.join(root, 'hcanvas.version.json'), path.join(appDir, 'hcanvas.version.json'));
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'hadamard-canvas-desktop-smoke', version: '0.1.5', type: 'module', main: 'dist/src/hcanvas/electronMain.js' }, null, 2));
  await mkdir(path.join(appDir, 'node_modules'), { recursive: true });
  const modules = await readdir(path.join(root, 'node_modules'), { withFileTypes: true });
  for (const entry of modules) {
    if (!entry.isDirectory() || entry.name === 'electron' || entry.name === '.bin') continue;
    await symlink(path.join(root, 'node_modules', entry.name), path.join(appDir, 'node_modules', entry.name), 'junction').catch(() => undefined);
  }
}

async function main() {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-desktop-'));
  try {
    if (!packagedExe) await assembleApp();
    const fence = String.fromCharCode(96).repeat(3);
    await writeFile(path.join(workspace, 'desktop.hnb.md'), ['---', 'hcanvas: notebook', 'kernel: python', '---', '', '# Desktop notebook', '', fence + 'python exec', 'print("desktop-e2e")', fence, ''].join('\n'), 'utf8');
    const childEnv = { ...process.env, HCANVAS_CONFIG_HOME: path.join(workspace, '.config'), HCANVAS_HOME: path.join(workspace, '.home'), HADAMARD_HOME: path.join(workspace, '.home') };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const profileDir = path.join(workspace, '.electron-profile');
    const commonArgs = ['--workspace', workspace, '--port', String(port), '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profileDir];
    const launchArgs = packagedExe ? commonArgs : [appDir, '--no-sandbox', ...commonArgs];
    electronProcess = spawn(electronExe, launchArgs, {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let launchError = '';
    electronProcess.stderr.on('data', chunk => { launchError += String(chunk); });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try { const response = await fetch('http://127.0.0.1:' + debugPort + '/json/version'); if (response.ok) break; } catch { /* wait */ }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    let cdpReady = false;
    try { cdpReady = (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok; } catch { cdpReady = false; }
    if (!cdpReady) throw new Error('Electron debug port did not open: ' + launchError);
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort);
    const pages = browser.contexts().flatMap(context => context.pages());
    const page = pages.find(item => item.url().startsWith('http://127.0.0.1')) || pages[0];
    if (!page) throw new Error('Electron desktop window did not expose a page: ' + launchError);
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(800);
    assert('Electron desktop window loads', await page.locator('body').count() === 1);
    await page.waitForTimeout(500);
    const boot = await page.evaluate(() => JSON.parse(document.getElementById('hc-boot')?.textContent || '{}'));
    const apiStatus = await page.evaluate(async (token) => {
      const post = (route, body) => fetch(route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hcanvas-token': token }, body: JSON.stringify(body) }).then(response => response.status);
      const trust = await post('/api/workspace/trust', { trust: 'trusted' });
      const enabled = await post('/api/extensions/toggle', { id: 'com.hadamard.kernel-python', enabled: true });
      const trusted = await post('/api/extensions/trust', { id: 'com.hadamard.kernel-python', trusted: true });
      return { trust, enabled, trusted };
    }, boot.token);
    assert('desktop API trusts workspace and enables the bundled Python kernel', apiStatus.trust === 200 && apiStatus.enabled === 200 && apiStatus.trusted === 200, JSON.stringify(apiStatus));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.locator('[data-sidebar-target="files"]').click();
    await page.locator('#refreshFilesBtn').click();
    await page.locator('.file-tree-root-name').first().click();
    await page.locator('.file-tree-node', { hasText: 'desktop.hnb.md' }).first().click();
    await page.waitForSelector('.nb-code');
    assert('desktop opens the .hnb.md notebook', await page.locator('.nb-markdown-body').count() > 0);
    await page.locator('.nb-code').first().locator('[data-nb-run]').click();
    try {
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.nb-output')).some(output => output.textContent?.includes('desktop-e2e')), undefined, { timeout: 60_000 });
    } catch (error) {
      const catalog = await page.evaluate(async (token) => (await fetch('/api/extensions', { headers: { 'x-hcanvas-token': token } })).json(), boot.token);
      const kernel = catalog.extensions?.find(entry => entry.id === 'com.hadamard.kernel-python');
      throw new Error('Notebook output timeout: outputs=' + JSON.stringify(await page.locator('.nb-output').allInnerTexts()) + ' statuses=' + JSON.stringify(await page.locator('[data-nb-cell-status]').allInnerTexts()) + ' kernel=' + JSON.stringify(kernel && { enabled: kernel.enabled, trusted: kernel.trusted, diagnostics: kernel.diagnostics }) + ' errors=' + JSON.stringify(errors));
    }
    assert('desktop Notebook executes a Python cell', true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await page.locator('[data-sidebar-target="files"]').click();
    await page.locator('#refreshFilesBtn').click();
    await page.locator('.file-tree-root-name').first().click();
    await page.locator('.file-tree-node', { hasText: 'desktop.hnb.md' }).first().click();
    await page.waitForSelector('.nb-code');
    assert('desktop Notebook reopens after reload', await page.locator('.nb-markdown-body').count() > 0);
    console.log('Windows desktop-shell Notebook E2E passed');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (electronProcess?.pid) {
      await new Promise(resolve => {
        const killer = spawn(process.platform === 'win32' ? 'taskkill' : 'kill', process.platform === 'win32' ? ['/pid', String(electronProcess.pid), '/T', '/F'] : ['-TERM', String(electronProcess.pid)], { stdio: 'ignore', windowsHide: true });
        killer.once('exit', () => resolve());
        killer.once('error', () => resolve());
        setTimeout(resolve, 3000);
      });
    }
    if (packagedExe) {
      await new Promise(resolve => {
        const killer = spawn(process.platform === 'win32' ? 'taskkill' : 'kill', process.platform === 'win32' ? ['/IM', path.basename(electronExe), '/T', '/F'] : ['-TERM', String(electronProcess?.pid)], { stdio: 'ignore', windowsHide: true });
        killer.once('exit', () => resolve());
        killer.once('error', () => resolve());
        setTimeout(resolve, 3000);
      });
    }
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
