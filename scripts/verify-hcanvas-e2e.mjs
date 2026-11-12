/**
 * Hcanvas standalone UI E2E.
 * Starts an isolated Hcanvas server, then exercises Markdown pages, Copilot,
 * file CRUD/search, assets and revision history through the real browser UI.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.HCANVAS_E2E_PORT || 4361);
const timeout = 20_000;
const results = [];
let browser;
let server;
let page;

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
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hcanvas server did not start. stderr=' + stderr.slice(-2000))), 30_000);
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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-e2e-'));
  await mkdir(path.join(workspace, 'notes'), { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# E2E workspace\n\nSeed file.\n', 'utf8');
  await writeFile(path.join(workspace, 'notes', 'plan.md'), '# Plan\n', 'utf8');
  await writeFile(path.join(workspace, '.hidden.md'), '# Hidden file\n', 'utf8');

  const started = await startServer(workspace);
  server = started.child;
  const base = started.info.url.replace(/\/$/, '');
  const token = started.info.token;

  const executableCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe'),
  ].filter(Boolean);
  const executablePath = executableCandidates.find(candidate => existsSync(candidate));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const pageErrors = [];
  page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.on('dialog', async dialog => { await dialog.accept(); });
  page.on('pageerror', error => { pageErrors.push(error.message); console.error('Browser page error:', error.message); });

  const fillFilePrompt = async (value) => {
    await page.locator('#filePromptInput').waitFor({ state: 'visible' });
    await page.locator('#filePromptInput').fill(value);
    await page.locator('#filePromptOk').click();
  };
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  assert('UI loads', (await page.title()).includes('Hadamard Canvas'), await page.title());
  assert('Top bar removes duplicate page and canvas actions', await page.locator('#addPageBtn, #newDocBtn').count() === 0);
  assert('Present and Export are accessible icon actions', await page.locator('#presentBtn svg, #exportBtn svg').count() === 2 && (await page.locator('#presentBtn').getAttribute('title')) === 'Present this canvas' && (await page.locator('#exportBtn').getAttribute('title')) === 'Export this canvas');
  assert('Workspace navigator renders all sections', await page.locator('.workspace-nav-item').count() === 5);
  assert('Pages panel is the focused default', await page.locator('[data-sidebar-section="pages"]').isVisible() && !(await page.locator('[data-sidebar-section="canvases"]').isVisible()));
  await page.locator('[data-sidebar-target="canvases"]').click();
  assert('Canvas section switches panels', await page.locator('#docsList').isVisible() && !(await page.locator('#pagesList').isVisible()));
  await page.locator('.sidebar-filter input').fill('Welcome');
  await page.waitForTimeout(200);
  assert('Canvas filter narrows visible rows', await page.locator('#docsList .doc-item:visible').count() === 1);
  await page.locator('.sidebar-filter input').fill('');
  await page.locator('[data-sidebar-target="pages"]').focus();
  await page.keyboard.press('ArrowRight');
  assert('Arrow key switches workspace sections', await page.locator('#filesPanel').isVisible());
  await page.locator('[data-sidebar-target="pages"]').click();
  await page.locator('.page-open').first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert('Arrow keys and Enter open pages', await page.locator('.page-item.active .page-open').evaluate(node => node.dataset.pageId) === await page.locator('.page-open').nth(1).getAttribute('data-page-id'));
  await page.keyboard.press('F2');
  assert('F2 focuses page rename', await page.locator('#pageName').evaluate(node => document.activeElement === node));
  await page.locator('[data-sidebar-target="pages"]').click();
  await page.keyboard.press('Control+b');
  assert('Ctrl+B hides the workspace navigator', await page.locator('#app').evaluate(node => node.classList.contains('left-collapsed')));
  await page.keyboard.press('Control+b');
  assert('Ctrl+B restores the workspace navigator', !(await page.locator('#app').evaluate(node => node.classList.contains('left-collapsed'))));
  assert('Canvas tabs expose close controls', await page.locator('.canvas-tab.active .tab-close').count() === 1);
  const pageCountBeforeClosingTabs = await page.locator('.page-item').count();
  await page.locator('.canvas-tab.active .tab-close').click();
  await page.waitForTimeout(300);
  assert('Closing the active canvas tab selects a neighbor', await page.locator('.canvas-tab.active').count() === 1);
  await page.locator('.canvas-tab.active').click({ button: 'middle' });
  await page.waitForTimeout(300);
  assert('Middle-click closes the last canvas tab', await page.locator('.canvas-tab').count() === 0);
  assert('Closing tabs never deletes pages', await page.locator('.page-item').count() === pageCountBeforeClosingTabs);
  await page.locator('.page-open').nth(1).click();
  await page.waitForTimeout(400);
  assert('Pages intentionally reopen a closed canvas tab', await page.locator('.canvas-tab.active').count() === 1);

  // File CRUD + search. Creation must reveal the new entry without re-expanding the root.
  await page.locator('[data-sidebar-target="files"]').click();
  const rootName = page.locator('#filesPanel .file-tree-root-name').first();
  await rootName.click({ button: 'right' });
  await page.waitForTimeout(150);
  await page.locator('.file-context-menu button', { hasText: 'New file' }).click();
  await fillFilePrompt('e2e-created.md');
  await page.waitForTimeout(700);
  const closeFileSurface = page.locator('[data-file-action="close"]');
  if (await closeFileSurface.count()) await closeFileSurface.first().click();
  await page.waitForTimeout(200);
  assert('File created and visible', await page.locator('#filesPanel .file-tree-node', { hasText: 'e2e-created.md' }).count() > 0);
  assert('Hidden file visible', await page.locator('#filesPanel .file-tree-node', { hasText: '.hidden.md' }).count() > 0);
  const createdRow = page.locator('#filesPanel .file-tree-node', { hasText: 'e2e-created.md' });
  await createdRow.click({ button: 'right' });
  await page.waitForTimeout(150);
  await page.locator('.file-context-menu button', { hasText: 'Rename' }).click();
  await fillFilePrompt('e2e-renamed.md');
  await page.waitForTimeout(700);
  assert('File renamed and visible', await page.locator('#filesPanel .file-tree-node', { hasText: 'e2e-renamed.md' }).count() > 0);
  await page.locator('#fileSearchInput').fill('e2e-renamed');
  await page.waitForTimeout(1400);
  assert('File search finds renamed file', await page.locator('.file-search-result', { hasText: 'e2e-renamed.md' }).count() > 0);
  await page.locator('.file-search-result', { hasText: 'e2e-renamed.md' }).click({ button: 'right' });
  await page.waitForTimeout(150);
  await page.locator('.file-context-menu button', { hasText: 'Delete' }).click();
  await page.waitForTimeout(700);
  assert('File deleted', await page.locator('.file-search-result', { hasText: 'e2e-renamed.md' }).count() === 0);
  await page.locator('#fileSearchClear').click();
  await page.waitForTimeout(300);
  await rootName.click({ button: 'right' });
  await page.waitForTimeout(150);
  await page.locator('.file-context-menu button', { hasText: 'New folder' }).click();
  await fillFilePrompt('e2e-folder');
  await page.waitForTimeout(700);
  assert('Folder created and visible', await page.locator('#filesPanel .file-tree-node.directory', { hasText: 'e2e-folder' }).count() > 0);
  const folderRow = page.locator('#filesPanel .file-tree-node.directory', { hasText: 'e2e-folder' });
  await folderRow.click({ button: 'right' });
  await page.waitForTimeout(150);
  await page.locator('.file-context-menu button', { hasText: 'Delete' }).click();
  await page.waitForTimeout(700);
  assert('Folder deleted', await page.locator('#filesPanel .file-tree-node.directory', { hasText: 'e2e-folder' }).count() === 0);

  // Markdown page: direct rich-text editing and reopenable help.
  await page.locator('[data-sidebar-target="pages"]').click();
  await page.locator('#addPageMini').click();
  await page.waitForTimeout(300);
  await page.locator('[data-preset="markdown-a4"]').click();
  await page.waitForTimeout(800);
  assert('Markdown help opens on first view', (await page.locator('.markdown-help-popover').innerText()).includes('MARKDOWN PAGE'));
  await page.locator('[data-help-dismiss]').click();
  assert('Markdown help can be dismissed', await page.locator('.markdown-help-popover').isHidden());
  await page.locator('.markdown-help-trigger').click();
  assert('Markdown help can be reopened', await page.locator('.markdown-help-popover').isVisible());
  await page.locator('[data-help-never]').click();
  assert('Markdown do-not-show preference persists', await page.evaluate(() => localStorage.getItem('hcanvas.markdownHelp.hidden.v1') === '1'));
  await page.locator('.markdown-help-trigger').click();
  assert('Markdown help remains available after do-not-show', await page.locator('.markdown-help-popover').isVisible());
  await page.locator('[data-help-dismiss]').click();
  assert('Markdown page has no persistent reader badge', await page.locator('.html-reader-badge, .html-reader-edit').count() === 0);
  const outerScroll = await page.locator('.html-page-surface').evaluate(element => ({ overflow: getComputedStyle(element).overflow, client: element.clientHeight, scroll: element.scrollHeight }));
  assert('Markdown page has one scrolling context', outerScroll.overflow === 'hidden' && outerScroll.scroll <= outerScroll.client + 1, JSON.stringify(outerScroll));
  await page.locator('#presentBtn').click();
  assert('Markdown presentation uses natural reading layout', await page.locator('#presentRoot').getAttribute('data-present-mode') === 'markdown' && (await page.locator('#presentPage').evaluate(element => getComputedStyle(element).transform)) === 'none');
  assert('Markdown presentation is scrollable', await page.frameLocator('#presentPage iframe').locator('body').evaluate(body => body.scrollHeight >= body.clientHeight));
  await page.locator('#presentClose').click();
  const frame = page.frameLocator('.html-page-surface iframe');
  await frame.locator('body').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nE2E rich markdown edit');
  await page.waitForTimeout(1400);
  assert('Markdown rich edit renders', (await frame.locator('body').innerText()).includes('E2E rich markdown edit'));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('# ');
  await page.waitForTimeout(350);
  assert('Markdown # shortcut creates heading', await frame.locator('h1').count() >= 2);
  await page.keyboard.type('Shortcut heading');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.waitForTimeout(350);
  assert('Slash menu opens', await frame.locator('.hc-slash-menu').count() > 0);
  await frame.locator('.hc-slash-menu .hc-slash-item', { hasText: 'Heading 2' }).click();
  await page.waitForTimeout(400);
  assert('Slash command creates heading', await frame.locator('h2').count() > 0);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/formula');
  await page.waitForTimeout(350);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  assert('Formula command renders math', await frame.locator('.hc-math-inline').count() > 0);
  assert('Formula editor opens', await frame.locator('.hc-formula-editor').count() > 0);
  const formulaInput = frame.locator('.hc-formula-input');
  await formulaInput.fill('a = b + c');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  assert('Formula editor commits edited LaTeX', await frame.locator('.hc-math-inline').getAttribute('data-tex') === 'a = b + c');
  assert('Formula editor closes', await frame.locator('.hc-formula-editor').count() === 0);
  const formulaCaret = await frame.locator('body').evaluate(() => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return { inMath: Boolean(element?.closest('.hc-math-inline')) };
  });
  assert('Caret leaves the formula', formulaCaret.inMath === false);
  await frame.locator('.hc-math-inline').first().click();
  await page.waitForTimeout(300);
  assert('Clicking formula reopens editor', await frame.locator('.hc-formula-editor').count() > 0);
  await frame.locator('.hc-formula-input').fill('x^2 + y^2');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  assert('Existing formula can be edited', await frame.locator('.hc-math-inline').getAttribute('data-tex') === 'x^2 + y^2');
  await frame.locator('.hc-math-inline').first().click();
  await frame.locator('.hc-formula-input').fill('cancel = true');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert('Escape cancels formula changes', await frame.locator('.hc-math-inline').first().getAttribute('data-tex') === 'x^2 + y^2');
  await frame.locator('body').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nDistance /formula');
  await page.waitForTimeout(350);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await frame.locator('.hc-formula-input').fill('d = rt');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  assert('Formula inserts beside existing text', (await frame.locator('body').innerText()).includes('Distance') && await frame.locator('.hc-math-inline').last().getAttribute('data-tex') === 'd = rt');
  await frame.locator('.hc-math-inline').last().click();
  await page.waitForTimeout(300);
  await page.waitForTimeout(1300);
  const savedMarkdownWhileEditorOpen = await page.evaluate(async () => {
    const boot = JSON.parse(document.getElementById('hc-boot').textContent);
    const headers = { 'x-hcanvas-token': boot.token };
    const context = await (await fetch('/api/state', { headers })).json();
    const result = await (await fetch('/api/docs/' + context.active.docId, { headers })).json();
    const active = result.doc.pages.find(item => item.id === context.active.pageId) || result.doc.pages[0];
    return active.markdown || '';
  });
  assert('Formula editor chrome never reaches Markdown', !/Enter apply|Esc cancel|empty removes/.test(savedMarkdownWhileEditorOpen), savedMarkdownWhileEditorOpen.slice(-160));
  await page.screenshot({ path: path.resolve('plan/hcanvas-formula-ux-11Nov2026.png') });
  await page.keyboard.press('Escape');
  await frame.locator('body').click({ button: 'right' });
  await page.waitForTimeout(250);
  assert('Markdown body source menu present', await page.locator('.page-context-menu button', { hasText: 'Edit Markdown source' }).count() > 0);
  await frame.locator('body').click({ position: { x: 40, y: 40 } });
  await page.waitForTimeout(250);
  assert('Markdown source menu dismisses on outside click', await page.locator('.page-context-menu').count() === 0);

  // Source editing via page-list right-click. Let the formula autosave settle before page-list rerender.
  await page.waitForTimeout(1200);
  const activePageItem = page.locator('.page-item.active').first();
  await activePageItem.click({ button: 'right' });
  await page.waitForTimeout(200);
  assert('Page source menu present', await page.locator('.page-context-menu button', { hasText: 'Edit Markdown source' }).count() > 0);
  await page.locator('.page-context-menu button', { hasText: 'Edit Markdown source' }).click();
  await page.waitForTimeout(700);
  assert('Markdown source editor opens', await page.locator('.markdown-workspace .cm-content').count() > 0);
  const markdownSource = await page.locator('.markdown-workspace .cm-content').innerText();
  assert('Inline formula persists to Markdown source', markdownSource.includes('Distance') && markdownSource.includes('$d = rt$'));
  assert('Source editor has no manual Save button', await page.locator('#saveCodeBtn').count() === 0);
  await page.locator('.markdown-workspace .cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nAuto-save source verification');
  await page.evaluate(async () => {
    const boot = JSON.parse(document.getElementById('hc-boot').textContent);
    const headers = { 'x-hcanvas-token': boot.token, 'content-type': 'application/json' };
    const context = await (await fetch('/api/state', { headers })).json();
    const result = await (await fetch('/api/docs/' + context.active.docId, { headers })).json();
    const active = result.doc.pages.find(item => item.id === context.active.pageId) || result.doc.pages[0];
    const saved = await fetch('/api/docs/' + result.doc.id + '/apply', { method: 'POST', headers, body: JSON.stringify({ baseRevision: result.doc.revision, actor: 'external-test', ops: [{ op: 'set_page_markdown', pageId: active.id, markdown: active.markdown + '\n\nExternal sync marker' }] }) });
    if (!saved.ok) throw new Error('External revision setup failed');
  });
  await page.waitForFunction(async () => {
    const boot = JSON.parse(document.getElementById('hc-boot').textContent);
    const headers = { 'x-hcanvas-token': boot.token };
    const context = await (await fetch('/api/state', { headers })).json();
    const result = await (await fetch('/api/docs/' + context.active.docId, { headers })).json();
    const active = result.doc.pages.find(item => item.id === context.active.pageId) || result.doc.pages[0];
    return active.markdown?.includes('Auto-save source verification');
  });
  assert('Source edits auto-save to the document', true);
  await page.keyboard.type('\n\nSaved while closing');
  await page.locator('.markdown-workspace .modal-foot [data-close]').click();
  await page.waitForFunction(async () => {
    const boot = JSON.parse(document.getElementById('hc-boot').textContent);
    const headers = { 'x-hcanvas-token': boot.token };
    const context = await (await fetch('/api/state', { headers })).json();
    const result = await (await fetch('/api/docs/' + context.active.docId, { headers })).json();
    const active = result.doc.pages.find(item => item.id === context.active.pageId) || result.doc.pages[0];
    return active.markdown?.includes('Saved while closing');
  });
  assert('Closing the source editor flushes pending edits', true);
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForTimeout(1000);
  const reloaded = page.frameLocator('.html-page-surface iframe');
  if (await reloaded.locator('.hc-math-inline').count() === 0) {
    const debug = await page.evaluate(async () => {
      const boot = JSON.parse(document.getElementById('hc-boot').textContent);
      const headers = { 'x-hcanvas-token': boot.token };
      const context = await (await fetch('/api/state', { headers })).json();
      const result = await (await fetch('/api/docs/' + context.active.docId, { headers })).json();
      return { active: context.active, pages: result.doc.pages.map(item => ({ id: item.id, name: item.name, markdown: item.markdown, hasInline: item.html?.includes('hc-math-inline') })) };
    });
    console.log('Reload formula debug:', JSON.stringify(debug));
  }
  await reloaded.locator('.hc-math-inline').last().click();
  await page.waitForTimeout(300);
  if (await reloaded.locator('.hc-formula-editor').count() === 0) {
    console.log('Formula click debug:', await reloaded.locator('body').evaluate(() => ({ editable: document.body.contentEditable, formulas: Array.from(document.querySelectorAll('.hc-math-inline')).map(item => item.outerHTML.slice(0, 400)) })));
  }
  assert('Persisted formula reopens after reload', await reloaded.locator('.hc-formula-input').inputValue() === 'd = rt');
  const formulaCountBeforeDelete = await reloaded.locator('.hc-math-inline').count();
  await reloaded.locator('.hc-formula-input').fill('');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  assert('Empty formula removes the inline object', await reloaded.locator('.hc-math-inline').count() === formulaCountBeforeDelete - 1);
  await page.evaluate(async () => {
    const boot = JSON.parse(document.getElementById('hc-boot').textContent);
    const headers = { 'x-hcanvas-token': boot.token, 'content-type': 'application/json' };
    const context = await (await fetch('/api/state', { headers })).json();
    const result = await (await fetch('/api/docs/' + context.active.docId, { headers })).json();
    const active = result.doc.pages.find(item => item.id === context.active.pageId) || result.doc.pages[0];
    const markdown = (active.markdown || '') + '\n\n$$\\frac{d}{t}$$';
    const saved = await fetch('/api/docs/' + result.doc.id + '/apply', { method: 'POST', headers, body: JSON.stringify({ baseRevision: result.doc.revision, ops: [{ op: 'set_page_markdown', pageId: active.id, markdown }] }) });
    if (!saved.ok) throw new Error('Could not add display formula');
  });
  await page.waitForTimeout(800);
  await reloaded.locator('.hc-math-block').click();
  await page.waitForTimeout(250);
  assert('Display formula opens the same editor', await reloaded.locator('.hc-formula-input').inputValue() === '\\frac{d}{t}');
  await page.keyboard.press('Escape');

  // Assets upload + insert.
  await page.locator('[data-sidebar-target="assets"]').click();
  const assetInput = page.locator('input[type=file]').last();
  await assetInput.setInputFiles(path.join(root, 'assets', 'hcanvas-icon.png'));
  await page.waitForTimeout(900);
  assert('Asset uploaded', await page.locator('.asset-row').count() > 0);
  await page.locator('.asset-insert').first().click();
  await page.waitForTimeout(900);
  const imgs = page.frameLocator('.html-page-surface iframe').locator('img');
  assert('Asset image inserted', await imgs.count() > 0 && await imgs.last().evaluate(el => el.naturalWidth > 0));

  // History diff + restore.
  await page.locator('[data-tab="history"]').click();
  await page.waitForTimeout(800);
  const historyText = await page.locator('#historyPanel').innerText();
  assert('History lists revisions', historyText.includes('Revision history') && historyText.includes('r0'));
  assert('History describes edits instead of raw operation counts', /Edit Markdown|Add shape|Edit text/.test(historyText), historyText.slice(0, 180));
  assert('Current revision cannot create an empty restore', await page.locator('[data-history-restore]').isDisabled());
  assert('Revision preview is rendered read-only', await page.locator('#historyPreview iframe').count() === 1);
  const revisionButtons = page.locator('[data-history-rev]');
  const count = await revisionButtons.count();
  assert('History has multiple revisions', count > 1, 'count=' + count);
  const selectedRevision = Number(await revisionButtons.nth(1).getAttribute('data-history-rev'));
  await revisionButtons.nth(1).click();
  await page.waitForTimeout(800);
  const diffText = await page.locator('#historyDiff').innerText();
  assert('History compares a revision with its predecessor', diffText.includes('r' + (selectedRevision - 1) + ' → r' + selectedRevision), diffText.slice(0, 100));
  await page.locator('[data-history-mode="current"]').click();
  await page.waitForTimeout(350);
  assert('History can compare with current without changing the canvas', (await page.locator('#historyDiff').innerText()).includes('r' + selectedRevision + ' → r'));
  await page.locator('#historySearch').fill('no-such-edit');
  assert('History filter handles empty results', (await page.locator('#historyList').innerText()).includes('No revisions match'));
  await page.locator('#historySearch').fill('');
  await page.locator('.history-refresh').click();
  await page.waitForTimeout(500);
  assert('History refresh preserves the selected revision', await page.locator('[data-history-rev="' + selectedRevision + '"]').getAttribute('aria-pressed') === 'true');
  const beforeRestore = Number((await page.locator('#docRevision').innerText()).replace(/\D/g, ''));
  await page.locator('[data-history-restore="' + selectedRevision + '"]').click();
  await page.locator('#confirmOk').click();
  await page.waitForTimeout(1000);
  assert('Restore creates a new revision', (await page.locator('#docRevision').innerText()).includes('rev ' + (beforeRestore + 1)));
  assert('Restore remains non-destructive', (await page.locator('#historyPanel').innerText()).includes('Restore revision ' + selectedRevision));

  // Presentation uses a dedicated layout for documents, slides, and Infinite content.
  await page.evaluate(async () => {
    const boot = JSON.parse(document.getElementById('hc-boot').textContent);
    const headers = { 'x-hcanvas-token': boot.token, 'content-type': 'application/json' };
    const context = await (await fetch('/api/state', { headers })).json();
    const current = await (await fetch('/api/docs/' + context.active.docId, { headers })).json();
    const pages = [
      { id: 'page_present_html', name: 'Web presentation', mode: 'html', width: 1280, height: 720, background: '#ffffff', html: '<!doctype html><html><body style="margin:0;font:20px sans-serif"><section style="height:1200px;padding:40px"><h1>HTML presentation</h1><p>Scrollable web content</p></section></body></html>' },
      { id: 'page_present_canvas', name: 'Slide presentation', mode: 'canvas', width: 800, height: 450, background: '#ffffff', notes: 'Speaker note test', blocks: [{ id: 'block_present_shape', type: 'shape', shape: 'roundRect', x: 80, y: 80, w: 300, h: 160, z: 0 }] },
      { id: 'page_present_infinite', name: 'Map presentation', mode: 'infinite', width: 3200, height: 2400, background: '#ffffff', blocks: [{ id: 'block_present_map', type: 'shape', shape: 'ellipse', x: -200, y: 300, w: 260, h: 180, z: 0 }] },
    ];
    const response = await fetch('/api/docs/' + context.active.docId + '/apply', { method: 'POST', headers, body: JSON.stringify({ baseRevision: current.doc.revision, ops: pages.map(page => ({ op: 'add_page', page })) }) });
    if (!response.ok) throw new Error('Could not create presentation fixtures');
  });
  await page.waitForTimeout(700);
  await page.locator('[data-sidebar-target="pages"]').click();
  await page.locator('.page-item[data-page-id="page_present_html"] .page-open').click();
  await page.waitForTimeout(400);
  await page.locator('#presentBtn').click();
  assert('HTML presentation uses a responsive interactive viewport', await page.locator('#presentRoot').getAttribute('data-present-mode') === 'html' && (await page.locator('#presentPage iframe').evaluate(frame => getComputedStyle(frame).pointerEvents)) === 'auto');
  const htmlPresentation = page.frameLocator('#presentPage iframe');
  assert('HTML presentation keeps long content scrollable', await htmlPresentation.locator('body').evaluate(() => document.documentElement.scrollHeight > window.innerHeight));
  await htmlPresentation.locator('h1').click();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(200);
  assert('HTML presentation wheel scrolls the document', await htmlPresentation.locator('body').evaluate(() => window.scrollY > 0));
  await page.locator('#presentClose').click();
  await page.locator('.page-item[data-page-id="page_present_canvas"] .page-open').click();
  await page.locator('#presentBtn').click();
  assert('Canvas presentation retains fit-to-slide rendering', await page.locator('#presentRoot').getAttribute('data-present-mode') === 'canvas' && (await page.locator('#presentPage').evaluate(element => element.style.transform)).includes('scale'));
  await page.locator('#presentNotesBtn').click();
  assert('Presentation notes remain available', await page.locator('#presentNotes').innerText() === 'Speaker note test');
  await page.locator('#presentClose').click();
  await page.locator('.page-item[data-page-id="page_present_infinite"] .page-open').click();
  await page.locator('#presentBtn').click();
  assert('Infinite presentation fits actual content', await page.locator('#presentRoot').getAttribute('data-present-mode') === 'infinite' && (await page.locator('#presentPage').evaluate(element => element.offsetWidth)) === 640);
  assert('Presentation disables Next on the last page', await page.locator('#presentNext').isDisabled());
  await page.locator('#presentClose').click();
  assert('No browser page errors', pageErrors.length === 0, pageErrors.join('; '));

  console.log(JSON.stringify({ port, revisions: count, tokenPresent: Boolean(token) }));
}

try {
  await main();
  console.log('\nHcanvas E2E: ' + results.filter(result => result.passed).length + '/' + results.length + ' passed');
  process.exitCode = results.every(result => result.passed) ? 0 : 1;
} catch (error) {
  console.error('\nHcanvas E2E failed: ' + (error instanceof Error ? error.stack : String(error)));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  server?.kill();
}
