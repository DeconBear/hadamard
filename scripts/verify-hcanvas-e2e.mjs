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
  page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.on('dialog', async dialog => { await dialog.accept(); });

  const fillFilePrompt = async (value) => {
    await page.locator('#filePromptInput').waitFor({ state: 'visible' });
    await page.locator('#filePromptInput').fill(value);
    await page.locator('#filePromptOk').click();
  };
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  assert('UI loads', (await page.title()).includes('Hadamard Canvas'), await page.title());

  // File CRUD + search. Creation must reveal the new entry without re-expanding the root.
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

  // Markdown page: direct rich-text editing, no top Edit button.
  await page.locator('#addPageBtn').click();
  await page.waitForTimeout(300);
  await page.locator('[data-preset="markdown-a4"]').click();
  await page.waitForTimeout(800);
  assert('Markdown page badge', (await page.locator('.html-reader-badge').innerText()).includes('MARKDOWN PAGE'));
  assert('Markdown page has no top Edit', await page.locator('.html-reader-edit').count() === 0);
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
  await frame.locator('body').click({ button: 'right' });
  await page.waitForTimeout(250);
  assert('Markdown body source menu present', await page.locator('.page-context-menu button', { hasText: 'Edit Markdown source' }).count() > 0);
  await frame.locator('body').click({ position: { x: 40, y: 40 } });
  await page.waitForTimeout(250);
  assert('Markdown source menu dismisses on outside click', await page.locator('.page-context-menu').count() === 0);

  // Source editing via page-list right-click.
  const activePageItem = page.locator('.page-item.active').first();
  await activePageItem.click({ button: 'right' });
  await page.waitForTimeout(200);
  assert('Page source menu present', await page.locator('.page-context-menu button', { hasText: 'Edit Markdown source' }).count() > 0);
  await page.locator('.page-context-menu button', { hasText: 'Edit Markdown source' }).click();
  await page.waitForTimeout(700);
  assert('Markdown source editor opens', await page.locator('.markdown-workspace .cm-content').count() > 0);
  await page.locator('.markdown-workspace [data-close]').first().click();
  await page.waitForTimeout(300);

  // Assets upload + insert.
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
  const revisionButtons = page.locator('[data-history-rev]');
  const count = await revisionButtons.count();
  assert('History has multiple revisions', count > 1, 'count=' + count);
  await revisionButtons.nth(1).click();
  await page.waitForTimeout(800);
  const diffText = await page.locator('#historyDiff').innerText();
  assert('History diff renders', diffText.length > 0 && !diffText.startsWith('No textual differences'), diffText.slice(0, 80));

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
