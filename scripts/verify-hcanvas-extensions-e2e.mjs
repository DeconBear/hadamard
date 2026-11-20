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
  for (const name of ['svg-viewer', 'json-viewer', 'map-viewer', 'page-board', 'python-kernel', 'cpp-toolbox']) {
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
  await writeFile(path.join(workspace, 'sample.hnb.md'), ['---', 'hcanvas: notebook', 'version: 1', 'title: E2E notebook', 'kernel: python', '---', '', '# E2E notebook', '', 'Energy: $E=mc^2$', '', fence + 'python exec', 'print("e2e-notebook")', fence, ''].join('\n'), 'utf8');
  await writeFile(path.join(workspace, 'plain.hnb.md'), ['# Plain notebook', '', 'Body.', ''].join('\n'), 'utf8');
  await writeFile(path.join(workspace, 'evil.hnb.md'), '<img src=x onerror="window.__nbXss=123">\n\nSafe text.\n', 'utf8');
  await writeFile(path.join(workspace, 'raw.hnb.md'), '<details><summary>More</summary><p>Keep this structure.</p></details>\n\n<p class="nb-md-placeholder">Keep this class.</p>\n', 'utf8');

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

  for (const id of ['com.hadamard.examples.python-kernel', 'com.hadamard.examples.cpp']) {
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
        { op: 'add_block', pageId: 'page_e2eexec', block: { id: 'block_e2eimage', type: 'exec', x: 680, y: 80, w: 560, h: 320, z: 2, code: 'import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])', language: 'python', data: { execution: { kernelId: 'python' } } } },
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
  assert('notebook viewer opens .hnb.md', (await page.locator('.notebook-view').count()) === 1, await page.locator('.workspace-view-surface').innerText().catch(() => 'missing workspace view surface'));
  assert('notebook renders markdown and code cells', (await page.locator('.nb-markdown').count()) === 1 && (await page.locator('.nb-code').count()) === 1);
  assert('notebook uses native CodeMirror code cells', (await page.locator('.nb-code-input .cm-editor').count()) === 1);
  await page.locator('.nb-markdown-body').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' AUTOSAVE-MARKER');
  await page.waitForTimeout(1100);
  const autosavedMarkdown = (await api('/api/files/read?root=root_default&path=sample.hnb.md')).body.file?.content || '';
  assert('notebook markdown autosaves while focused', autosavedMarkdown.includes('AUTOSAVE-MARKER'), autosavedMarkdown.slice(0, 180));
  await page.locator('.nb-code-input .cm-content').first().press('Shift+Enter');
  const notebookOutput = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const text = await page.locator('.nb-output').first().innerText().catch(() => '');
      if (text.includes('e2e-notebook')) return true;
      if ((await page.locator('[data-nb-cell-status]').first().innerText().catch(() => '')) === 'Failed') return false;
      await page.waitForTimeout(300);
    }
    return false;
  })();
  assert('notebook executes a Python cell', notebookOutput, JSON.stringify({
    status: await page.locator('[data-nb-cell-status]').first().innerText().catch(() => ''),
    output: await page.locator('.nb-output').first().innerText().catch(() => ''),
    toasts: await page.locator('#toastRoot').innerText().catch(() => ''),
    kernels: (await api('/api/runtime')).body.kernels,
    pageErrors,
  }));

  await page.locator('[data-nb-variables]').click();
  await page.locator('[data-nb-new-name]').fill('distance');
  await page.locator('[data-nb-new-value]').fill('12');
  await page.locator('[data-nb-variable-add]').click();
  await page.waitForTimeout(250);
  assert('variable panel adds a shared numeric value', (await page.locator('[data-nb-variable-row="distance"] [data-nb-variable-value]').count()) === 1 && await page.locator('[data-nb-variable-row="distance"] [data-nb-variable-value]').inputValue() === '12', JSON.stringify({ panel: await page.locator('[data-nb-variable-panel]').innerText(), toasts: await page.locator('#toastRoot').innerText(), pageErrors }));
  await page.locator('[data-nb-variables]').click();
  const cellCountBeforeFormula = await page.locator('.nb-code').count();
  await page.locator('.nb-markdown-body .hc-math').click();
  await page.waitForSelector('.nb-formula-popover');
  assert('formula opens an inline LaTeX editor', await page.locator('.nb-formula-popover textarea').inputValue() === 'E=mc^2');
  await page.locator('.nb-formula-popover textarea').fill('total = distance * 2');
  await page.locator('[data-formula-calculate]').click();
  assert('formula calculation inserts an adjacent code cell', (await page.locator('.nb-code').count()) === cellCountBeforeFormula + 1 && (await page.locator('.nb-code').first().innerText()).includes('distance * 2'), JSON.stringify({ cells: await page.locator('.nb-code').allInnerTexts(), formulaMessage: await page.locator('.nb-formula-message').innerText().catch(() => 'closed'), toasts: await page.locator('#toastRoot').innerText() }));
  await page.locator('[data-nb-variables]').click();
  await page.locator('[data-nb-variable-initialize]').click();
  await page.locator('[data-nb-variables]').click();
  await page.locator('.nb-code-input .cm-content').first().press('Shift+Enter');
  let calculated = false;
  for (let attempt = 0; attempt < 100 && !calculated; attempt += 1) {
    calculated = (await page.locator('.nb-output').first().innerText().catch(() => '')).includes('24');
    if (!calculated) await page.waitForTimeout(300);
  }
  assert('generated formula code executes against shared variables', calculated);
  await page.locator('[data-nb-variables]').click();
  assert('kernel variable snapshot returns to the read-only current value', await page.locator('[data-nb-variable-row="total"] [data-nb-variable-current]').textContent() === '24');
  await page.locator('[data-nb-variables]').click();
  await page.locator('.nb-markdown-body').fill('# E2E notebook\n\nClosing autosave marker');
  await page.locator('[data-nb-add-md]').click();
  await page.waitForTimeout(250);
  await page.locator('.workspace-tab.view-tab.active .tab-close').click();
  let savedAfterClose = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const saved = await api('/api/files/read?root=root_default&path=sample.hnb.md');
    savedAfterClose = saved.body.file?.content || '';
    if (savedAfterClose.includes('Closing autosave marker') && savedAfterClose.includes('"total":24')) break;
    await page.waitForTimeout(150);
  }
  assert('closing a notebook flushes the latest markdown and variables', savedAfterClose.includes('Closing autosave marker') && savedAfterClose.includes('"total":24'), savedAfterClose.slice(0, 180));
  assert('empty markdown placeholder is not persisted', !savedAfterClose.includes('Write Markdown'), savedAfterClose.slice(0, 220));

  await openFile('evil.hnb.md');
  await page.waitForTimeout(900);
  const xssFlag = await page.evaluate(() => window.__nbXss ?? null);
  assert('notebook sanitizes raw markdown HTML', xssFlag === null, String(xssFlag));
  await page.locator('.workspace-tab.view-tab.active .tab-close').click();
  await page.waitForTimeout(300);

  await openFile('raw.hnb.md');
  await page.waitForSelector('.nb-markdown-body details');
  await page.locator('.nb-markdown-body').click();
  await page.keyboard.press('Tab');
  await page.locator('[data-nb-variables]').click();
  await page.locator('[data-nb-new-name]').fill('alpha');
  await page.locator('[data-nb-new-value]').fill('1');
  await page.locator('[data-nb-variable-add]').click();
  await page.locator('.workspace-tab.view-tab.active .tab-close').click();
  let rawSaved = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    rawSaved = (await api('/api/files/read?root=root_default&path=raw.hnb.md')).body.file?.content || '';
    if (rawSaved.includes('"alpha":1')) break;
    await page.waitForTimeout(150);
  }
  assert('untouched raw HTML survives autosave', rawSaved.includes('<details><summary>More</summary><p>Keep this structure.</p></details>') && rawSaved.includes('Keep this class.'), rawSaved.slice(0, 260));

  await openFile('plain.hnb.md');
  await page.waitForTimeout(1000);
  await page.locator('[data-nb-variables]').click();
  await page.locator('[data-nb-new-name]').fill('distance');
  await page.locator('[data-nb-new-value]').fill('12');
  await page.locator('[data-nb-variable-add]').click();
  await page.waitForTimeout(250);
  await page.locator('.workspace-tab.view-tab.active .tab-close').click();
  let plainSaved = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    plainSaved = (await api('/api/files/read?root=root_default&path=plain.hnb.md')).body.file?.content || '';
    if (plainSaved.startsWith('---') && plainSaved.includes('variables:')) break;
    await page.waitForTimeout(150);
  }
  assert('frontmatter-less notebook persists variables on close', plainSaved.startsWith('---') && plainSaved.includes('variables:') && plainSaved.includes('distance'), plainSaved.slice(0, 220));

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

  const chartCell = page.locator('.block-wrap[data-block-id="block_e2eimage"]');
  await chartCell.locator('.exec-actions button.primary').click();
  const chartRendered = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 45_000) {
      if (await chartCell.locator('img.exec-out-image').count()) return true;
      await page.waitForTimeout(400);
    }
    return false;
  })();
  assert('canvas exec cell renders a chart', chartRendered);
  let persistedAsset = null;
  for (let attempt = 0; attempt < 40 && !persistedAsset; attempt += 1) {
    const fresh = await api('/api/docs/' + doc.id);
    const pageData = (fresh.body.doc?.pages || []).find(item => item.id === 'page_e2eexec');
    const block = (pageData?.blocks || []).find(item => item.id === 'block_e2eimage');
    const outputs = (block?.data && Array.isArray(block.data.outputs)) ? block.data.outputs : [];
    const image = outputs.find(output => output && output.kind === 'image');
    if (image && typeof image.url === 'string' && image.url.includes('/api/assets/raw/') && image.assetId) persistedAsset = image;
    if (!persistedAsset) await page.waitForTimeout(400);
  }
  assert('chart output persists as a workspace asset', Boolean(persistedAsset), persistedAsset ? persistedAsset.url : 'no asset url');

  await page.locator('[data-sidebar-target="pages"]').click();
  await page.waitForTimeout(500);
  await page.locator('.page-item', { hasText: 'Board page' }).click();
  await page.waitForTimeout(1800);
  assert('extension page mounts a page viewer', (await page.locator('.extension-page-surface iframe').count()) === 1);
  frame = activeFrame();
  assert('extension page receives page data', frame ? (await frame.locator('.column').count()) === 3 : false);
  const viewerWrite = await frame.evaluate(async () => {
    const hc = await HcanvasView.acquire();
    const applied = await hc.document.apply([{ op: 'update_page', patch: { extension: { data: {
      title: 'E2E saved board',
      columns: [{ name: 'Backlog', cards: [] }, { name: 'In progress', cards: [] }, { name: 'Done', cards: [{ title: 'Saved through extension RPC' }] }],
    } } } }]);
    const imported = await hc.assets.import({ name: 'board-pixel.png', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
    return { applied, imported };
  });
  assert('extension viewer document.apply returns the real revision', viewerWrite.applied?.revision > 0, JSON.stringify(viewerWrite));
  assert('extension viewer imports an asset', Boolean(viewerWrite.imported?.asset?.url), JSON.stringify(viewerWrite.imported));
  const savedBoard = await api('/api/docs/' + doc.id);
  const savedBoardPage = savedBoard.body.doc?.pages?.find(item => item.id === 'page_e2eboard');
  assert('extension viewer changes persist in the host document', savedBoardPage?.extension?.data?.title === 'E2E saved board');
  const exported = await api('/api/export', { method: 'POST', body: JSON.stringify({ docId: doc.id, format: 'pdf', pageId: 'page_e2eboard' }) });
  assert('extensions page export fails with a readable error', exported.status >= 400 && String(JSON.stringify(exported.body)).includes('Extension pages cannot be exported'), String(exported.status));

  await page.locator('#presentBtn').click();
  await page.waitForSelector('#presentRoot:not(.hidden)');
  const presentFrame = await page.locator('#presentRoot iframe').first().contentFrame();
  await page.waitForTimeout(900);
  assert('Present renders an extension page', Boolean(presentFrame) && (await presentFrame.locator('.column').count()) === 3);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  assert('Present exits after presenting an extension page', await page.locator('#presentRoot').evaluate(element => element.classList.contains('hidden')));

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

  // Terminal dock over a real PTY session (P3 client shell surface).
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(300);
  await page.locator('#paletteInput').fill('terminal');
  await page.waitForTimeout(300);
  await page.locator('.palette-item').first().click();
  await page.waitForTimeout(1800);
  assert('terminal dock opens with xterm', (await page.locator('#terminalDock:not(.hidden)').count()) === 1 && (await page.locator('.xterm').count()) === 1);
  let sessionId = '';
  for (let attempt = 0; attempt < 50 && !sessionId; attempt += 1) {
    const sessions = await api('/api/terminal/sessions');
    sessionId = sessions.body.sessions?.[0]?.sessionId || '';
    if (!sessionId) await page.waitForTimeout(300);
  }
  assert('terminal dock creates a PTY session', Boolean(sessionId));
  const terminalTextarea = page.locator('.xterm-helper-textarea');
  await terminalTextarea.focus();
  await terminalTextarea.pressSequentially('echo terminal-e2e');
  await terminalTextarea.press('Enter');
  let terminalBuffer = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!sessionId) break;
    const buffer = await api('/api/terminal/sessions/' + encodeURIComponent(sessionId) + '/buffer');
    terminalBuffer = buffer.body.buffer?.base64 ? Buffer.from(buffer.body.buffer.base64, 'base64').toString('utf8') : '';
    if (terminalBuffer.includes('terminal-e2e')) break;
    await page.waitForTimeout(300);
  }
  assert('terminal PTY echoes typed input', terminalBuffer.includes('terminal-e2e'));
  await page.locator('[data-terminal-tab="output"]').click();
  assert('terminal dock Output tab is available', !(await page.locator('[data-terminal-output]').getAttribute('class')).includes('hidden'));
  await page.locator('[data-terminal-close]').click();
  await page.waitForTimeout(300);
  assert('terminal dock closes', (await page.locator('#terminalDock').getAttribute('class')).includes('hidden'));

  // Contributed user tools: run the C++ version tool and surface output in the dock.
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(300);
  await page.locator('#paletteInput').fill('Tools:');
  await page.waitForTimeout(300);
  await page.locator('.palette-item').first().click();
  await page.waitForTimeout(500);
  const toolButtons = page.locator('[data-tool-index]');
  assert('tool runner lists contributed tools', (await toolButtons.count()) > 0);
  await toolButtons.first().click();
  const toolOutput = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      const text = await page.locator('[data-terminal-output]').innerText().catch(() => '');
      if (text.includes('g++')) return true;
      await page.waitForTimeout(300);
    }
    return false;
  })();
  assert('tool runner streams command output', toolOutput);

  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(300);
  await page.locator('#paletteInput').fill('Tools:');
  await page.waitForTimeout(300);
  await page.locator('.palette-item').first().click();
  await page.waitForTimeout(500);
  const syntaxTool = page.locator('[data-tool-index]', { hasText: 'syntax' }).first();
  assert('tool runner exposes a syntax-check tool', (await syntaxTool.count()) === 1);
  await syntaxTool.click();
  const problemReported = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      const text = await page.locator('[data-terminal-problems]').innerText().catch(() => '');
      if (text.includes('missing_symbol')) return true;
      await page.waitForTimeout(300);
    }
    return false;
  })();
  assert('tool stderr is parsed into Problems', problemReported);
  await page.locator('[data-terminal-tab="problems"]').click();
  assert('Problems tab lists an error', (await page.locator('.terminal-problem.error').count()) > 0);
  await page.locator('[data-terminal-close]').click();
  await page.waitForTimeout(300);

  assert('no browser page errors', pageErrors.length === 0, pageErrors.join('; '));

  const failed = results.filter(item => !item.passed);
  console.log('');
  console.log('Hcanvas extension E2E: ' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exitCode = 1;

  await browser.close();
  browser = null;
  const exited = new Promise(resolve => {
    if (server.exitCode !== null) { resolve(); return; }
    server.once('exit', () => resolve());
    setTimeout(resolve, 2500);
  });
  server.kill();
  await exited;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { await rm(workspace, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 9) throw error; await new Promise(resolve => setTimeout(resolve, 350)); }
  }
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