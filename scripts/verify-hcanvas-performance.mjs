#!/usr/bin/env node
/**
 * Hcanvas Notebook performance baseline.
 *
 * Builds a representative Markdown-first notebook (many Markdown segments,
 * code cells and image outputs), drives it in Chromium and records timings for
 * first render, typing/editing, cell drag, variables panel, Run all and HTML
 * export. This is a measurement baseline; callers can set optional regression
 * thresholds with HCANVAS_PERF_MAX_* environment variables.
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const port = Number(process.env.HCANVAS_PERF_PORT || 46810);
const timeout = 120_000;
const codeCells = Number(process.env.HCANVAS_PERF_CODE_CELLS || 24);
const imageCells = Number(process.env.HCANVAS_PERF_IMAGE_CELLS || 2);
let browser;
let server;

function assert(name, condition) {
  if (!condition) throw new Error(name);
  console.log('PASS ' + name);
}

function threshold(name, value) {
  const key = 'HCANVAS_PERF_MAX_' + name.toUpperCase();
  const max = Number(process.env[key] || 0);
  if (max > 0 && value > max) throw new Error(name + ' exceeded threshold: ' + value + 'ms > ' + max + 'ms');
  return value;
}

function notebookSource() {
  const fence = String.fromCharCode(96).repeat(3);
  const lines = ['---', 'hcanvas: notebook', 'version: 1', 'title: Performance notebook', 'kernel: python', '---', ''];
  for (let index = 0; index < codeCells; index += 1) {
    lines.push('## Section ' + (index + 1), '', 'Paragraph ' + (index + 1) + ' with **bold**, *italic* and inline formula $x_{' + (index + 1) + '}^2$.', '');
    if (index < imageCells) {
      lines.push(fence + 'python hc-cell=perfimg' + index + ' exec', 'import matplotlib', 'matplotlib.use("Agg")', 'import matplotlib.pyplot as plt', 'plt.figure(figsize=(6,3))', 'plt.plot(range(' + (30 + index * 10) + '))', 'plt.title("perf chart ' + index + '")', 'plt.show()', fence, '');
    } else {
      lines.push(fence + 'python hc-cell=perfcode' + index + ' exec', 'value = ' + index + ' * 3', 'print("cell-' + index + ':", value)', fence, '');
    }
  }
  return lines.join('\n');
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-perf-'));
  const result = { workspace, codeCells, imageCells, metrics: {} };
  try {
    await mkdir(path.join(workspace, 'extensions'), { recursive: true });
    await cp(path.join(root, 'examples/hcanvas-extensions/python-kernel'), path.join(workspace, 'extensions/python-kernel'), { recursive: true });
    await writeFile(path.join(workspace, 'performance.hnb.md'), notebookSource(), 'utf8');
    await writeFile(path.join(workspace, 'idle.md'), '# Idle file\n\nNot a notebook.\n', 'utf8');
    const started = Date.now();
    server = spawn(process.execPath, ['bin/hcanvas.js', 'serve', '--workspace', workspace, '--port', String(port)], {
      cwd: root,
      env: { ...process.env, HCANVAS_CONFIG_HOME: path.join(workspace, '.config'), HCANVAS_HOME: path.join(workspace, '.home'), HADAMARD_HOME: path.join(workspace, '.home') },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timed out: ' + output)), 30_000);
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
    result.metrics.serverStartupMs = Date.now() - started;
    const base = String(info.url).replace(/\/$/, '');
    const api = async (pathname, init = {}) => {
      const response = await fetch(base + pathname, { ...init, headers: { 'x-hcanvas-token': info.token, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
      return response.json();
    };
    await api('/api/workspace/trust', { method: 'POST', body: JSON.stringify({ trust: 'trusted' }) });
    await api('/api/extensions/trust', { method: 'POST', body: JSON.stringify({ id: 'com.hadamard.examples.python-kernel', trusted: true }) });
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
    const openStart = Date.now();
    await page.locator('.file-tree-node', { hasText: 'performance.hnb.md' }).first().click();
    try {
      await page.waitForFunction(expected => document.querySelectorAll('.nb-code').length === expected && document.querySelectorAll('.nb-markdown-body').length > 0, codeCells, { timeout: 30_000 });
    } catch (error) {
      const body = await page.locator('body').innerText().catch(() => '');
      throw new Error('notebook did not render: codes=' + await page.locator('.nb-code').count() + ' markdown=' + await page.locator('.nb-markdown-body').count() + ' body=' + body.slice(0, 700) + ' error=' + (error instanceof Error ? error.message : error));
    }
    result.metrics.firstRenderMs = threshold('firstRender', Date.now() - openStart);
    assert('representative notebook renders all cells', await page.locator('.nb-code').count() === codeCells);

    const markdown = page.locator('.nb-markdown-body').first();
    await markdown.click();
    await page.keyboard.press('Control+End');
    const bodyStart = Date.now();
    await page.keyboard.type(' performance-body-marker');
    result.metrics.bodyInputMs = threshold('bodyInput', Date.now() - bodyStart);
    const codeEditor = page.locator('.nb-code .cm-content').nth(1);
    await codeEditor.focus();
    const codeStart = Date.now();
    await codeEditor.press('Control+End');
    await page.keyboard.type('\nprint("perf-edit")');
    result.metrics.codeEditMs = threshold('codeEdit', Date.now() - codeStart);
    const dragStart = Date.now();
    await page.locator('.nb-code').first().locator('[data-nb-drag]').dragTo(page.locator('.nb-code').nth(1));
    result.metrics.dragMs = threshold('drag', Date.now() - dragStart);
    const variablesStart = Date.now();
    await page.locator('[data-nb-variable-expand]').click();
    result.metrics.variablesPanelMs = threshold('variables', Date.now() - variablesStart);
    const runStart = Date.now();
    await page.locator('[data-nb-runall]').click();
    await page.waitForTimeout(100);
    await page.waitForFunction(() => !document.querySelector('[data-nb-runall]')?.hasAttribute('disabled'), undefined, { timeout: 120_000 });
    result.metrics.runAllMs = threshold('runAll', Date.now() - runStart);
    const filledOutputs = await page.locator('.nb-output').evaluateAll(outputs => outputs.filter(output => (output.textContent || '').trim().length > 0 || output.querySelector('img, iframe, canvas')).length);
    assert('Run all produced outputs for every executable cell', filledOutputs >= codeCells);
    result.metrics.domImageOutputs = await page.locator('.nb-output img').count();
    const exportStart = Date.now();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-nb-export]').click();
    const download = await downloadPromise;
    const exportedPath = await download.path();
    result.metrics.htmlExportMs = threshold('htmlExport', Date.now() - exportStart);
    result.metrics.exportedBytes = exportedPath ? (await stat(exportedPath)).size : 0;
    assert('HTML export produced a standalone file', result.metrics.exportedBytes > 10_000);
    const exported = exportedPath ? await readFile(exportedPath, 'utf8') : '';
    result.metrics.exportedImageAssets = (exported.match(/data:image\/png;base64,/g) || []).length;
    console.log('METRICS ' + JSON.stringify(result.metrics));
    assert('export inlines generated image outputs', result.metrics.exportedImageAssets >= 1, 'images=' + result.metrics.exportedImageAssets + ' expected=' + imageCells + ' dom=' + result.metrics.domImageOutputs + ' bytes=' + result.metrics.exportedBytes);
    const restartStart = Date.now();
    await page.locator('[data-nb-restart]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-nb-runall]').click();
    await page.waitForTimeout(100);
    await page.waitForFunction(() => !document.querySelector('[data-nb-runall]')?.hasAttribute('disabled'), undefined, { timeout: 120_000 });
    result.metrics.restartRunAllMs = threshold('restartRunAll', Date.now() - restartStart);
    assert('restart and Run all complete after a kernel restart', true);
    const sessions = (await api('/api/runtime')).kernels || [];
    const pids = sessions.map(session => session.pid).filter(pid => typeof pid === 'number');
    for (const session of sessions) await api('/api/kernels/' + encodeURIComponent(session.sessionId), { method: 'DELETE' });
    await page.waitForTimeout(1200);
    const live = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    result.metrics.kernelSessions = pids.length;
    result.metrics.orphanProcesses = live.length;
    assert('disposing notebook kernels leaves no orphan processes', live.length === 0, 'live=' + live.join(','));
    const reopenStart = Date.now();
    await page.locator('.file-tree-node', { hasText: 'idle.md' }).first().click();
    await page.waitForTimeout(200);
    await page.locator('.file-tree-node', { hasText: 'performance.hnb.md' }).first().click();
    await page.waitForSelector('.nb-code');
    result.metrics.reopenMs = threshold('reopen', Date.now() - reopenStart);
    assert('no browser page errors during performance run', errors.length === 0);
    result.ok = true;
    const outDir = path.join(root, 'build-artifacts');
    await mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, 'hcanvas-performance.json');
    await writeFile(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ ok: true, file: outFile, metrics: result.metrics }, null, 2));
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
