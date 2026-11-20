import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const port = Number(process.env.HCANVAS_MAXWELL_E2E_PORT || 46771);
let browser;
let server;

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
  console.log('PASS ' + name);
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-maxwell-e2e-'));
  try {
    await mkdir(path.join(workspace, 'extensions'), { recursive: true });
    for (const name of ['python-kernel', 'octave-kernel', 'cpp-kernel']) {
      await cp(path.join(root, 'examples/hcanvas-extensions', name), path.join(workspace, 'extensions', name), { recursive: true });
    }
    await cp(path.join(root, 'examples/hcanvas-notebooks/maxwell-bloch.hnb.md'), path.join(workspace, 'maxwell-bloch.hnb.md'));
    server = spawn(process.execPath, ['bin/hcanvas.js', 'serve', '--workspace', workspace, '--port', String(port)], {
      cwd: root, env: { ...process.env, HCANVAS_CONFIG_HOME: path.join(workspace, '.config') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 20_000);
      server.stdout.on('data', chunk => {
        output += String(chunk);
        for (const line of output.split(/\r?\n/)) {
          try {
            const value = JSON.parse(line);
            if (value.url && value.token) { clearTimeout(timer); resolve(value); return; }
          } catch { /* wait for startup JSON */ }
        }
      });
      server.once('error', reject);
      server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code)); });
    });
    const base = info.url.replace(/\/$/, '');
    const api = async (pathname, init = {}) => {
      const response = await fetch(base + pathname, { ...init, headers: { 'x-hcanvas-token': info.token, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
      return { status: response.status, body: await response.json() };
    };
    assert('workspace trust', (await api('/api/workspace/trust', { method: 'POST', body: JSON.stringify({ trust: 'trusted' }) })).status === 200);
    for (const id of ['com.hadamard.examples.python-kernel', 'com.hadamard.examples.octave-kernel', 'com.hadamard.examples.cpp-kernel']) {
      assert('trust ' + id, (await api('/api/extensions/trust', { method: 'POST', body: JSON.stringify({ id, trusted: true }) })).status === 200);
    }
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.locator('[data-sidebar-target="files"]').click();
    await page.locator('#refreshFilesBtn').click();
    await page.locator('.file-tree-root-name').first().click();
    await page.locator('.file-tree-node', { hasText: 'maxwell-bloch.hnb.md' }).first().click();
    await page.waitForSelector('.nb-code');
    assert('five executable cells', await page.locator('.nb-code').count() === 5);
    await page.locator('[data-nb-runall]').click();
    await page.waitForFunction(() => !document.querySelector('[data-nb-runall]')?.disabled, undefined, { timeout: 120000 });
    const statuses = await page.locator('[data-nb-cell-status]').allInnerTexts();
    assert('all kernels complete', !statuses.some(status => /error|failed|aborted/iu.test(status)), statuses.join(', '));
    assert('three figures rendered', await page.locator('.nb-output img.exec-out-image').count() === 3);
    assert('no cell errors', (await page.locator('.exec-out-error').count()) === 0);
    await page.locator('[data-nb-variables]').click();
    const variables = await page.locator('[data-nb-variable-row]').evaluateAll(rows => rows.map(row => row.dataset.nbVariableRow || ''));
    const required = ['peak_inversion', 'final_inversion', 'propagation_peak_field', 'rabi_period_cpp', 'rabi_period_octave'];
    assert('cross-language variables present', required.every(name => variables.includes(name)), variables.join(', '));
    assert('fourteen shared values', variables.length === 14, String(variables.length));
    assert('no browser errors', errors.length === 0, errors.join('; '));
    console.log('Maxwell-Bloch E2E passed');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

try { await main(); } catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
