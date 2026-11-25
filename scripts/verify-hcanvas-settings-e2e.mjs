/**
 * Hcanvas settings E2E: opens Project Hub -> Settings, verifies runtime rows,
 * tests a configured interpreter, saves and reprobes the persisted value.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.HCANVAS_SETTINGS_E2E_PORT || 4377);
const results = [];
let browser;
let server;
let workspace;

function assert(name, condition, detail = '') {
  results.push({ name, passed: Boolean(condition), detail });
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
}

async function startServer(ws) {
  const child = spawn(process.execPath, ['bin/hcanvas.js', 'serve', '--workspace', ws, '--port', String(port)], {
    cwd: root,
    env: { ...process.env, HCANVAS_CONFIG_HOME: path.join(ws, '.e2e-config'), HCANVAS_HOME: path.join(ws, '.home'), HADAMARD_HOME: path.join(ws, '.home') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hcanvas server did not start: ' + stderr.slice(-2000))), 30_000);
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      for (const line of buffer.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const value = JSON.parse(line);
          if (value?.url && value?.token) { clearTimeout(timer); resolve(value); return; }
        } catch { /* keep waiting */ }
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Hcanvas exited ' + code)); });
  });
  return { child, info };
}

async function main() {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-settings-e2e-'));
  const started = await startServer(workspace);
  server = started.child;
  const base = started.info.url.replace(/\/$/, '');
  const headers = { 'x-hcanvas-token': started.info.token, 'content-type': 'application/json' };
  await fetch(base + '/api/workspace/trust', { method: 'POST', headers, body: JSON.stringify({ trust: 'trusted' }) });
  await fetch(base + '/api/extensions/trust', { method: 'POST', headers, body: JSON.stringify({ id: 'com.hadamard.kernel-cpp', trusted: true }) });
  await fetch(base + '/api/extensions/toggle', { method: 'POST', headers, body: JSON.stringify({ id: 'com.hadamard.kernel-cpp', enabled: true }) });
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe'),
  ].filter(Boolean);
  const executablePath = candidates.find(candidate => existsSync(candidate));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('#projectMenuBtn').click();
  await page.locator('#hubSettingsBtn').click();
  await page.locator('.settings-modal').waitFor();
  assert('Settings dialog opens from Project Hub', await page.locator('.settings-modal').isVisible());
  assert('Settings shows all three runtime paths', await page.locator('[data-runtime="python"], [data-runtime="octave"], [data-runtime="cpp"]').count() === 3);
  assert('Settings exposes update preferences', await page.locator('#settings-auto-check').count() === 1 && await page.locator('#settings-update-channel').count() === 1);
  const pythonInput = page.locator('#settings-runtime-python');
  await pythonInput.fill(process.execPath);
  await page.locator('[data-test-runtime="python"]').click();
  await page.waitForFunction(() => document.querySelector('[data-runtime-row="python"] .runtime-badge')?.classList.contains('ok'), null, { timeout: 15_000 });
  assert('Test button reports a working configured interpreter', (await page.locator('[data-runtime-row="python"] .runtime-badge').innerText()).length > 0, await page.locator('[data-runtime-row="python"] .runtime-badge').innerText());
  await page.locator('#settings-language').selectOption('zh');
  await page.locator('#settings-default-kernel').selectOption('cpp');
  await page.locator('#settings-save').click();
  await page.waitForFunction(() => document.querySelector('#settings-save-status')?.textContent?.includes('Saved'), null, { timeout: 10_000 }).catch(() => undefined);
  const saved = await (await fetch(base + '/api/settings', { headers })).json();
  assert('Settings persist configured Python path', saved.settings?.runtimes?.python === process.execPath, JSON.stringify(saved.settings?.runtimes));
  assert('Settings persist language and default kernel', saved.settings?.language === 'zh' && saved.settings?.notebook?.defaultKernel === 'cpp');
  await page.locator('.settings-modal [data-close]').first().click();
  await page.locator('#hubCloseBtn').click();
  await page.locator('#addPageMini').click();
  await page.locator('[data-notebook-page]').click();
  await page.waitForFunction(() => Boolean(document.querySelector('.notebook-page-host')), null, { timeout: 15_000 });
  const state = await (await fetch(base + '/api/state', { headers })).json();
  const activeDoc = await (await fetch(base + '/api/docs/' + state.active.docId, { headers })).json();
  const notebookPage = activeDoc.doc.pages.find(item => item.extension?.format === 'hadamard-notebook');
  assert('New Notebook page uses the configured default kernel', notebookPage?.extension?.data?.defaultKernelId === 'cpp', JSON.stringify(notebookPage?.extension?.data?.defaultKernelId));
  assert('No browser page errors during settings flow', errors.length === 0, errors.join('; '));
  console.log('Settings E2E passed');
}

try {
  await main();
} finally {
  await browser?.close().catch(() => undefined);
  server?.kill();
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
}
