#!/usr/bin/env node
/**
 * Focused regression: editing and switching pages while a notebook cell is
 * executing must not lose the edited source or misplace completed output.
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const port = Number(process.env.HCANVAS_EXEC_EDIT_PORT || 46920);
let browser;
let server;

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
  console.log('PASS ' + name);
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-exec-edit-'));
  try {
    await mkdir(path.join(workspace, 'extensions'), { recursive: true });
    await cp(path.join(root, 'examples/hcanvas-extensions/python-kernel'), path.join(workspace, 'extensions/python-kernel'), { recursive: true });
    const fence = String.fromCharCode(96).repeat(3);
    await writeFile(path.join(workspace, 'exec-edit.hnb.md'), ['---', 'hcanvas: notebook', 'kernel: python', '---', '', '# Exec edit notebook', '', fence + 'python exec', 'print("initial")', fence, '', fence + 'python exec', 'print("second")', fence, ''].join('\n'), 'utf8');
    await writeFile(path.join(workspace, 'idle.md'), '# Idle\n\nNot a notebook.\n', 'utf8');
    server = spawn(process.execPath, ['bin/hcanvas.js', 'serve', '--workspace', workspace, '--port', String(port)], {
      cwd: root,
      env: { ...process.env, HCANVAS_CONFIG_HOME: path.join(workspace, '.config'), HCANVAS_HOME: path.join(workspace, '.home'), HADAMARD_HOME: path.join(workspace, '.home') },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
    const api = async (pathname, init = {}) => fetch(base + pathname, { ...init, headers: { 'x-hcanvas-token': info.token, ...(init.body ? { 'content-type': 'application/json' } : {}) } }).then(response => response.json());
    await api('/api/workspace/trust', { method: 'POST', body: JSON.stringify({ trust: 'trusted' }) });
    await api('/api/extensions/trust', { method: 'POST', body: JSON.stringify({ id: 'com.hadamard.examples.python-kernel', trusted: true }) });
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await page.locator('[data-sidebar-target="files"]').click();
    await page.locator('#refreshFilesBtn').click();
    await page.locator('.file-tree-root-name').first().click();
    await page.locator('.file-tree-node', { hasText: 'exec-edit.hnb.md' }).first().click();
    await page.waitForFunction(() => document.querySelectorAll('.nb-code').length === 2);
    const longCell = page.locator('.nb-code').first();
    await longCell.locator('.cm-content').fill('import time\ntime.sleep(3)\nprint("exec-during-edit")');
    await longCell.locator('.cm-content').press('Control+Enter');
    await page.waitForTimeout(300);
    const editedCell = page.locator('.nb-code').nth(1);
    await editedCell.locator('.cm-content').fill('edited_while_running = True\nprint("edited-second")');
    await page.locator('.file-tree-node', { hasText: 'idle.md' }).first().click();
    await page.waitForTimeout(250);
    await page.locator('.file-tree-node', { hasText: 'exec-edit.hnb.md' }).first().click();
    await page.waitForSelector('.nb-code');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.nb-output')).some(output => output.textContent?.includes('exec-during-edit')), undefined, { timeout: 30_000 });
    const editedSource = await page.locator('.nb-code').nth(1).locator('.cm-content').innerText();
    assert('executing while editing another cell keeps the edited source', editedSource.includes('edited_while_running'));
    assert('output remains in the cell that was running', (await page.locator('.nb-code').first().locator('.nb-output').innerText()).includes('exec-during-edit'));
    assert('no browser errors', errors.length === 0, errors.join('; '));
    console.log('Notebook execution-edit E2E passed');
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
