/**
 * Hcanvas refresh/tab E2E: the top refresh reloads the active file from disk,
 * and closing the last workspace tab returns to the canvas.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.HCANVAS_TABS_E2E_PORT || 4381);
let browser;
let server;
let workspace;

function assert(name, condition, detail = '') {
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
        } catch { /* wait */ }
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Hcanvas exited ' + code)); });
  });
  return { child, info };
}

async function main() {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-tabs-e2e-'));
  await writeFile(path.join(workspace, 'refresh.txt'), 'one\n', 'utf8');
  const started = await startServer(workspace);
  server = started.child;
  const base = started.info.url.replace(/\/$/, '');
  const headers = { 'x-hcanvas-token': started.info.token, 'content-type': 'application/json' };
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe'),
  ].filter(Boolean);
  const executablePath = candidates.find(candidate => existsSync(candidate));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.locator('[data-sidebar-target="files"]').click();
  await page.locator('#refreshFilesBtn').click();
  await page.locator('.file-tree-root-name').first().click();
  await page.locator('.file-tree-node', { hasText: 'refresh.txt' }).first().click();
  await page.locator('.file-surface').waitFor();
  assert('File tab opens and shows disk content', (await page.locator('.file-surface').innerText()).includes('one'));

  await fetch(base + '/api/files/write', { method: 'POST', headers, body: JSON.stringify({ root: 'root_default', path: 'refresh.txt', content: 'two from disk\n' }) });
  await page.locator('#refreshWorkspaceBtn').click();
  await page.waitForFunction(() => document.querySelector('.file-surface')?.textContent?.includes('two from disk'), null, { timeout: 10_000 });
  assert('Refresh reloads the active file from disk', (await page.locator('.file-surface').innerText()).includes('two from disk'));

  assert('One file tab is open alongside the canvas tab', await page.locator('.workspace-tab.file-tab').count() === 1 && await page.locator('.workspace-tab.canvas-tab').count() === 1);
  await page.locator('.workspace-tab.file-tab .tab-close').click();
  await page.waitForFunction(() => document.querySelectorAll('.file-surface').length === 0, null, { timeout: 5_000 });
  assert('Closing the last file tab returns to the canvas', await page.evaluate(() => !document.body.classList.contains('file-browser-mode')) && await page.locator('.workspace-tab.canvas-tab').count() === 1);
  await page.locator('.workspace-tab.canvas-tab .tab-close').click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-tab').length === 0 && !document.querySelector('.workspace-no-tabs')?.classList.contains('hidden'), null, { timeout: 5_000 });
  assert('Closing the last canvas tab shows the empty workspace', await page.locator('.workspace-no-tabs').isVisible());
  assert('No browser page errors', errors.length === 0, errors.join('; '));
  console.log('Refresh/tab E2E passed');
}

try {
  await main();
} finally {
  await browser?.close().catch(() => undefined);
  server?.kill();
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
}
