/**
 * Hcanvas extension-platform E2E.
 * Starts an isolated server + workspace, installs example extensions, and drives
 * real file viewers, the notebook, canvas executable cells and custom extension
 * pages through the browser UI. Requires a fresh `npm run build`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.HCANVAS_EXT_E2E_PORT || 4362);
const timeout = 25_000;
const results = [];
let browser;
let server;

function report(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log((passed ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}
function assert(name, condition, detail = '') {
  report(name, Boolean(condition), detail);
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
}

async function startServer(workspace) {
  const child = spawn(process.execPath, ['bin/hcanvas.js', 'serve', '--workspace', workspace, '--port', String(port)], {
    cwd: root,
    env: { ...process.env, HCANVAS_CONFIG_HOME: path.join(workspace, '.e2e-config') },
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
          if (value && value.url && value.token) { clearTimeout(timer); resolve(value); return; }
        } catch { /* keep waiting */ }
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Hcanvas server exited with ' + code + ': ' + stderr.slice(-2000))); });
  });
  return { child, info };
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-ext-e2e-'));
  const extensionsDir = path.join(workspace, 'extensions');
  await mkdir(extensionsDir, { recursive: true });
  const exampleRoot = path.join(root, 'examples', 'hcanvas-extensions');
  for (const name of ['svg-viewer', 'json-viewer', 'map-viewer', 'page-board', 'python-kernel']) {
    await cp(path.join(exampleRoot, name), path.join(extensionsDir, name), { recursive: true });
  }
  await writeFile(path.join(workspace, 'sample.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" rx="10" fill="#6657D9"/><circle cx="46" cy="45" r="20" fill="#faf8f3"/><text x="78" y="52" fill="#fff" font-family="sans-serif" font-size="15">SVG</text></svg>\n', 'utf8');
  await writeFile(path.join(workspace, 'sample.json'), JSON.stringify({ extension: 'json-viewer', values: [1, 2, 3], nested: { ok: true } }, null, 2) + '\n', 'utf8');
  await writeFile(path.join(workspace, 'sample.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'Alpha' }, geometry: { type: 'Polygon', coordinates: [[[-10, 0], [0, 0], [0, 10], [-10, 10], [-10, 0]]] } },
      { type: 'Feature', properties: { name: 'Beta' }, geometry: { type: 'LineString', coordinates: [[2, 2], [8, 8]] } },
    ],
  }, null, 2) + '\n', 'utf8');
  const fence = String.fromCharCode(96).repeat(3);
  await writeFile(path.join(workspace, 'sample.hnb.md'), ['---', 'hcanvas: notebook', 'version: 1', 'title: E2E notebook', 'kernel: python', '---', '', '# E2E notebook', '', fence + 'python exec', 'print("e2e-notebook")', fence, ''].join('\n'), 'utf8');

  const started = await startServer(workspace);
  server = started.child;
  const base = started.info.url.replace(/\/$/, '');
  const token = started.info.token;
  const api = async (pathname, init = {}) => {
    const response = await fetch(base + pathname, {
      ...init,
      headers: { 'x-hcanvas-token': token, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  };

  for (const id of ['com.hadamard.examples.python-kernel']) {
    const trusted = await api('/api/extensions/trust', { method: 'POST', body: JSON.stringify({ id, trusted: true }) });
    assert('trust ' + id, trusted.status === 200, String(trusted.status));
  }
  const catalog = await api('/api/extensions');
  const ids = (catalog.body.extensions || []).map(item => item.id);
  assert('extension catalog discovers examples', ['com.hadamard.examples.svg', 'com.hadamard.examples.json', 'com.hadamard.examples.map', 'com.hadamard.examples.board', 'com.hadamard.examples.python-kernel'].every(id => ids.includes(id)), ids.join(', '));

  const created = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'Extension E2E' }) });
  const doc = created.body.doc;
  assert('creates an E2E document', Boolean(doc && doc.id), String(created.status));
  const firstPage = doc.pages[0];
  const applied = await api('/api/docs/' + doc.id + '/apply', {
    method: 'POST',
    body: JSON.stringify({
      baseRevision: doc.revision,
      actor: 'e2e',
      ops: [
        { op: 'add_page', page: { id: 'page_e2eexec', name: 'Exec page', mode: 'canvas', width: 1280, height: 720, background: '#ffffff', blocks: [] } },
        { op: 'add_block', pageId: 'page_e2eexec', block: { id: 'block_e2eexec', type: 'exec', x: 80, y: 80, w: 560, h: 320, z: 1, code: 'print("e2e-exec")', language: 'python', data: { execution: { kernelId: 'python' } } } },
        { op: 'add_page', page: { id: 'page_e2eboard', name: 'Board page', mode: 'extension', width: 1280, height: 800, background: '#ffffff', extension: { format: 'board-page', data: {} } } },
      ],
    }),
  });
  assert('seeds exec and extension pages', applied.status === 200, JSON.stringify(applied.body).slice(0, 160));

  const executableCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe'),
  ].filter(Boolean);
  const executablePath = executableCandidates.find(candidate => existsSync(candidate));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=swiftshader'], ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const pageErrors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.on('pageerror', error => { pageErrors.push(error.message); console.error('Browser page error:', error.message); });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  assert('UI loads', (await page.title()).includes('Hadamard Canvas'), await page.title());

  await page.locator('[data-sidebar-target="files"]').click();
  await page.waitForTimeout(1000);
  await page.locator('#refreshFilesBtn').click();
  await page.waitForTimeout(500);
  await page.locator('.file-tree-root-name').first().click();
  await page.waitForTimeout(600);

  const openFile = async (name) => {
    const node = page.locator('.file-tree-node', { hasText: name }).first();
    await node.click();
    await page.waitForTimeout(1400);
  };
  const activeFrame = () => {
    const frames = page.frames().filter(frame => frame.url().includes('/api/extension-views/'));
    return frames[frames.length - 1];
  };

  await openFile('sample.svg');
  let frame = activeFrame();
  assert('SVG file opens in an extension viewer', Boolean(frame));
  let svgRendered = false;
  if (frame) {
    try { await frame.waitForSelector('img', { timeout: 8000 }); svgRendered = true; }
    catch { svgRendered = (await frame.locator('#meta').innerText().catch(() => '')).includes('sample.svg'); }
  }
  assert('SVG viewer renders the file', svgRendered);
  const sandbox = await page.locator('.extension-viewer-host iframe, .view-tab iframe').first().getAttribute('sandbox').catch(() => null);
  assert('iframe viewers are opaque-origin sandboxed', Boolean(sandbox && sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin')), sandbox || 'missing sandbox');

  await openFile('sample.geojson');
  frame = activeFrame();
  assert('GeoJSON map viewer renders canvas', frame ? (await frame.locator('canvas#map').count()) === 1 : false);
  assert('map viewer reports feature count', frame ? (await frame.locator('#meta').innerText()).includes('2') : false);

  await openFile('sample.hnb.md');
  await page.waitForTimeout(1000);
  assert('notebook viewer opens .hnb.md', (await page.locator('.notebook-view').count()) === 1);
  assert('notebook renders markdown and code cells', (await page.locator('.nb-markdown').count()) === 1 && (await page.locator('.nb-code').count()) === 1);
  await page.locator('[data-nb-run]').first().click();
  const notebookOutput = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const text = await page.locator('.nb-output').first().innerText().catch(() => '');
      if (text.includes('e2e-notebook')) return true;
      await page.waitForTimeout(300);
    }
    return false;
  })();
  assert('notebook executes a Python cell', notebookOutput);

  // File viewers live in workspace view tabs; close them so the canvas is active again.
  while (await page.locator('.workspace-tab.view-tab .tab-close').count()) {
    await page.locator('.workspace-tab.view-tab .tab-close').first().click();
    await page.waitForTimeout(250);
  }
  await page.locator('[data-sidebar-target="pages"]').click();
  await page.waitForTimeout(500);
  await page.locator('.page-item', { hasText: 'Exec page' }).click();
  await page.waitForTimeout(1200);
  const execCell = page.locator('.block-wrap[data-block-id="block_e2eexec"]');
  assert('canvas renders the seeded exec cell', (await execCell.count()) === 1);
  await execCell.locator('.exec-actions button.primary').click();
  const execOutput = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const text = await page.locator('.block-wrap[data-block-id="block_e2eexec"] .exec-outputs').innerText().catch(() => '');
      if (text.includes('e2e-exec')) return true;
      await page.waitForTimeout(300);
    }
    return false;
  })();
  assert('canvas exec cell streams Python output', execOutput);

  await page.locator('[data-sidebar-target="pages"]').click();
  await page.waitForTimeout(500);
  await page.locator('.page-item', { hasText: 'Board page' }).click();
  await page.waitForTimeout(1800);
  assert('extension page mounts a page viewer', (await page.locator('.extension-page-surface iframe').count()) === 1);
  frame = activeFrame();
  assert('extension page receives page data', frame ? (await frame.locator('.column').count()) === 3 : false);
  const exported = await api('/api/export', { method: 'POST', body: JSON.stringify({ docId: doc.id, format: 'pdf', pageId: 'page_e2eboard' }) });
  assert('extensions page export fails with a readable error', exported.status >= 400 && String(JSON.stringify(exported.body)).includes('Extension pages cannot be exported'), String(exported.status));

  // Workspace trust / Restricted Mode and the extension gallery.
  const restricted = await api('/api/workspace/trust', { method: 'POST', body: JSON.stringify({ trust: 'restricted' }) });
  assert('API can put the workspace in Restricted Mode', restricted.status === 200);
  await page.evaluate(() => document.getElementById('extensionManagerBtn')?.click());
  await page.waitForSelector('.plugin-manager-modal');
  assert('extension manager shows Restricted Mode', (await page.locator('.plugin-manager-warning').count()) === 1);
  const managerRowsBefore = await page.locator('.plugin-manager-modal .extension-row').count();
  await page.locator('[data-workspace-trust="trusted"]').click();
  await page.waitForSelector('#confirmOk');
  await page.locator('#confirmOk').click();
  await page.waitForSelector('.plugin-manager-modal');
  assert('trusting the workspace leaves Restricted Mode', !(await page.locator('.plugin-manager-modal .modal-head small').first().innerText()).includes('restricted'));
  await page.locator('[data-extensions-gallery]').click();
  await page.waitForSelector('.plugin-manager-modal');
  assert('gallery lists first-party examples', (await page.locator('.gallery-row').count()) > 0);
  const installButtons = page.locator('[data-gallery-install]');
  assert('gallery has installable examples', (await installButtons.count()) > 0);
  await installButtons.first().click();
  await page.waitForSelector('.plugin-manager-modal');
  assert('gallery install adds a workspace extension', (await page.locator('.plugin-manager-modal .extension-row').count()) > managerRowsBefore);
  await page.locator('.modal [data-close], .modal .icon-btn[data-close]').first().click();
  await page.waitForTimeout(300);

  assert('no browser page errors', pageErrors.length === 0, pageErrors.join('; '));

  const failed = results.filter(item => !item.passed);
  console.log('');
  console.log('Hcanvas extension E2E: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exitCode = 1;

  await browser.close();
  browser = null;
  server.kill();
  await rm(workspace, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}