/** Offline browser smoke. Requires npm run build and a Playwright Chromium install. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startHadamardGuiServer } from '../dist/src/gui/hadamardGui.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-research-gui-'));
const workspace = path.join(root, 'project');
const homeDir = path.join(root, 'home');
await mkdir(workspace); await mkdir(homeDir);
const configPath = path.join(homeDir, 'settings.json');
await writeFile(configPath, '{}');
const server = await startHadamardGuiServer({ workDir: workspace, homeDir, configPath, port: 0 });
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HADAMARD_RESEARCH_BROWSER ? { executablePath: process.env.HADAMARD_RESEARCH_BROWSER } : {}), args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(server.url, { waitUntil: 'networkidle' });
  // Switch through existing project navigation functions, then use visible UI.
  await page.evaluate(() => { switchProjectView('detail'); setProjectDetailTab('research'); });
  await page.getByRole('heading', { name: 'Research experiments' }).waitFor();
  await page.getByText('New experiment manifest (JSON)', { exact: true }).click();
  await page.getByRole('button', { name: 'Pin manifest and probe environment', exact: true }).click();
  await page.getByRole('button', { name: 'Run pinned experiment', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Run pinned experiment', exact: true }).click();
  await page.getByRole('button', { name: 'Rerun pinned experiment', exact: true }).waitFor({ timeout: 30000 });
  assert.match(await page.locator('#researchRecords').innerText(), /State: passed/);
  await page.getByText('Independent validation and metrics', { exact: true }).click();
  assert.match(await page.locator('#researchRecords').innerText(), /"observed": 5/);
  await page.screenshot({ path: process.env.HADAMARD_RESEARCH_SCREENSHOT || path.join(root, 'research-passed.png'), fullPage: true });
  const previousRunHeading = await page.locator('#researchRecords h3').innerText();
  await page.getByRole('button', { name: 'Rerun pinned experiment', exact: true }).click();
  await page.waitForFunction(previous => {
    const records = document.querySelector('#researchRecords');
    return records?.querySelector('h3')?.textContent !== previous && records?.textContent?.includes('State: passed');
  }, previousRunHeading, { timeout: 30000 });
  assert.match(await page.locator('#researchRecords').innerText(), /State: passed/);
  await page.getByRole('button', { name: 'Back to experiments', exact: true }).click();
  await page.getByRole('tab', { name: 'Document', exact: true }).click();
  await page.getByRole('tab', { name: 'Research', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#researchRecords')?.textContent?.includes('2 criteria passed'));
  const records = await fetch(`${server.url}api/research?workspace=${encodeURIComponent(workspace)}`, { headers: { 'x-hadamard-token': server.token } }).then(response => response.json());
  assert.equal(records.runs.length, 2);
  assert.notEqual(records.runs[0].id, records.runs[1].id);
  assert.equal(records.runs[0].manifestDigest, records.runs[1].manifestDigest);
  assert.equal(records.runs.filter(run => run.rerunOf).length, 1);
  assert.deepEqual(errors, []);
  console.log('Research GUI smoke passed: manifest pin, real CodeAct, independent validation, rerun, tab navigation, no browser errors.');
} finally {
  await browser?.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
