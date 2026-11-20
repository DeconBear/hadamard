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
  const existingWorkspace = process.env.HCANVAS_MAXWELL_E2E_WORKSPACE;
  const workspace = existingWorkspace ? path.resolve(existingWorkspace) : await mkdtemp(path.join(os.tmpdir(), 'hcanvas-maxwell-e2e-'));
  try {
    if (!existingWorkspace) {
      await mkdir(path.join(workspace, 'extensions'), { recursive: true });
      for (const name of ['python-kernel', 'octave-kernel', 'cpp-kernel']) {
        await cp(path.join(root, 'examples/hcanvas-extensions', name), path.join(workspace, 'extensions', name), { recursive: true });
      }
      await mkdir(path.join(workspace, 'docs'), { recursive: true });
      await cp(path.join(root, 'examples/hcanvas-notebooks/.hcanvas/docs/doc_maxwellbloch.json'), path.join(workspace, 'docs/doc_maxwellbloch.json'));
    }
    server = spawn(process.execPath, ['bin/hcanvas.js', 'serve', '--workspace', workspace, '--port', String(port)], {
      cwd: root, env: { ...process.env, HCANVAS_CONFIG_HOME: path.join(workspace, '.config') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let errorOutput = '';
    server.stderr.on('data', chunk => { errorOutput += String(chunk); });
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out\n' + output + '\n' + errorOutput)), 20_000);
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
      server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + '\n' + output + '\n' + errorOutput)); });
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
    const documents = await api('/api/docs');
    assert('native document is listed from docs storage', documents.body.docs?.some(doc => doc.id === 'doc_maxwellbloch' && doc.pages === 1) === true, JSON.stringify(documents.body));
    await page.locator('[data-sidebar-target="pages"]').click();
    await page.locator('.page-item[data-page-id="page_maxwellbloch"] .page-open').click();
    await page.locator('.nb-title strong', { hasText: 'Maxwell–Bloch' }).waitFor();
    await page.waitForSelector('.nb-code');
    assert('six executable cells', await page.locator('.nb-code').count() === 6);
    await page.locator('[data-nb-runall]').click();
    await page.waitForFunction(() => !document.querySelector('[data-nb-runall]')?.disabled, undefined, { timeout: 120000 });
    const statuses = await page.locator('[data-nb-cell-status]').allInnerTexts();
    assert('all kernels complete', !statuses.some(status => /error|failed|aborted/iu.test(status)), statuses.join(', '));
    assert('three figures rendered', await page.locator('.nb-output img.exec-out-image').count() === 3);
    const documentFlow = await page.locator('.nb-code').first().evaluate(element => ({ border: getComputedStyle(element).borderTopWidth, caption: getComputedStyle(element.querySelector('.nb-output-caption > span')).display }));
    assert('code and outputs use continuous document presentation', documentFlow.border === '0px' && documentFlow.caption === 'none', JSON.stringify(documentFlow));
    assert('no cell errors', (await page.locator('.exec-out-error').count()) === 0);
    await page.locator('[data-nb-variable-expand]').click();
    const variables = await page.locator('[data-nb-variable-row]').evaluateAll(rows => rows.map(row => row.dataset.nbVariableRow || ''));
    const required = ['peak_inversion', 'final_inversion', 'propagation_peak_field', 'rabi_period', 'pulse_area', 'rabi_period_cpp', 'rabi_period_octave', 'rabi_period_error_cpp', 'period_max_error'];
    assert('cross-language variables present', required.every(name => variables.includes(name)), variables.join(', '));
    assert('twenty-two shared values', variables.length === 22, String(variables.length));
    const sharedValues = await page.locator('[data-nb-variable-row]').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.dataset.nbVariableRow, row.querySelector('[data-nb-variable-current]')?.textContent])));
    assert('derived values propagate across all three kernels', Math.abs(Number(sharedValues.rabi_period) - Math.PI) < 1e-12 && Number(sharedValues.pulse_area) > 20 && Number(sharedValues.rabi_period_error_cpp) < 1e-10 && Number(sharedValues.period_max_error) < 1e-10, JSON.stringify(sharedValues));
    let storedDoc;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      storedDoc = (await api('/api/docs/doc_maxwellbloch')).body.doc;
      if (storedDoc?.pages?.[0]?.extension?.data?.variables?.rabi_period_octave !== undefined) break;
      await page.waitForTimeout(150);
    }
    const storedData = storedDoc?.pages?.[0]?.extension?.data;
    const storedCodeCells = storedData?.cells?.filter(cell => cell.kind === 'code') || [];
    assert('native document persists shared variables and outputs', storedData?.variables?.rabi_period_octave !== undefined && Object.keys(storedData?.initialVariables || {}).length === 10 && storedCodeCells.length === 6 && storedCodeCells.every(cell => cell.executionCount > 0 && cell.outputs?.length), JSON.stringify(storedDoc).slice(0, 800));
    const revisions = await api('/api/docs/doc_maxwellbloch/revisions');
    assert('native document records execution revisions', revisions.body.revisions?.length > 0, JSON.stringify(revisions.body));
    const omegaInput = page.locator('[data-nb-variable-row="omega0"] [data-nb-variable-value]');
    const currentValue = name => page.locator('[data-nb-variable-row="' + name + '"] [data-nb-variable-current]').textContent();
    await omegaInput.fill('1');
    await omegaInput.press('Tab');
    assert('initial edits leave current runtime values unchanged', await currentValue('omega0') === '2' && Math.abs(Number(await currentValue('rabi_period')) - Math.PI) < 1e-12);
    const parameterCell = page.locator('.nb-code').first();
    const parameterId = await parameterCell.getAttribute('data-nb-cell');
    const beforeCount = Number((await parameterCell.locator('[data-nb-execution-count]').innerText()).replace(/\D/g, '')) || 0;
    await page.locator('[data-nb-run-affected]').click();
    await page.waitForFunction(({ id, before }) => Number(document.querySelector('[data-nb-cell="' + id + '"] [data-nb-execution-count]')?.textContent?.replace(/\D/g, '')) > before, { id: parameterId, before: beforeCount });
    await page.waitForFunction(() => !document.querySelector('[data-nb-cell-status][data-tone="running"], [data-nb-cell-status][data-tone="queued"]'));
    assert('Run affected keeps existing current values until initialization', await currentValue('omega0') === '2' && Math.abs(Number(await currentValue('rabi_period')) - Math.PI) < 1e-12);
    await page.locator('[data-nb-variable-initialize]').click();
    assert('Initialize applies the edited initial value', await currentValue('omega0') === '1');
    await page.locator('[data-nb-run-affected]').click();
    await page.waitForFunction(() => {
      const value = name => Number(document.querySelector('[data-nb-variable-row="' + name + '"] [data-nb-variable-current]')?.textContent);
      return value('rabi_period') > 6 && value('rabi_period_cpp') > 6 && value('rabi_period_octave') > 6 && value('pulse_area') < 11 && value('period_max_error') < 1e-10;
    }).catch(async () => {
      const values = await page.locator('[data-nb-variable-row]').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.dataset.nbVariableRow, row.querySelector('[data-nb-variable-current]')?.textContent])));
      throw new Error('Initialized dependency run stalled: ' + JSON.stringify(values) + ' statuses=' + (await page.locator('[data-nb-cell-status]').allInnerTexts()).join(',') + ' errors=' + (await page.locator('.exec-out-error').allInnerTexts()).join('\n'));
    });
    assert('Run affected recomputes the initialized cross-language chain', true);
    await omegaInput.fill('2');
    await omegaInput.press('Tab');
    await page.locator('[data-nb-variable-initialize]').click();
    await page.locator('[data-nb-run-affected]').click();
    await page.waitForFunction(() => {
      const value = name => Number(document.querySelector('[data-nb-variable-row="' + name + '"] [data-nb-variable-current]')?.textContent);
      return Math.abs(value('rabi_period') - Math.PI) < 1e-10 && Math.abs(value('rabi_period_cpp') - Math.PI) < 1e-10 && Math.abs(value('rabi_period_octave') - Math.PI) < 1e-10 && value('pulse_area') > 20 && value('period_max_error') < 1e-10;
    });
    assert('restoring and initializing a global input restores all derived kernels', true);
    assert('no browser errors', errors.length === 0, errors.join('; '));
    console.log('Maxwell-Bloch E2E passed');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    if (!existingWorkspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

try { await main(); } catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
