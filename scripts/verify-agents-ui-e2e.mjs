import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'output', 'playwright', 'agents-ui-audit');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'hadamard-agents-ui-e2e-'));
const HOME = path.join(TMP, 'home');
const WORK = path.join(TMP, 'work');
const CONFIG = path.join(HOME, 'settings.json');
const screenshots = [];
const browserErrors = [];
const providerRequests = [];
let app;
let appProcess;
let providerServer;
let failure;

function electronExecutable() {
  if (process.platform === 'win32') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (process.platform === 'darwin') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

async function startProvider() {
  providerServer = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    providerRequests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-agents-ui',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Use the Agents page and capability guide.' }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-agents-ui',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    })}\n\n`);
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise((resolve, reject) => providerServer.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = providerServer.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function shot(page, name) {
  const target = path.join(ARTIFACTS, name);
  await page.screenshot({ path: target, animations: 'disabled' });
  screenshots.push(target);
}

async function assertVisibleSelectsUsable(page, scope) {
  const states = await page.locator(scope).locator('select:visible').evaluateAll(selects => selects.map(select => ({
    id: select.id || select.closest('.te-field, .dialog-field')?.querySelector('label, span')?.textContent?.trim() || '(unnamed select)',
    disabled: select.disabled,
    optionCount: select.options.length,
    enabledOptionCount: Array.from(select.options).filter(option => !option.disabled).length,
  })));
  for (const state of states) {
    assert(state.optionCount > 0, `${state.id} has no options`);
    if (!state.disabled) assert(state.enabledOptionCount > 0, `${state.id} has no enabled options`);
  }
}

async function closeApplication() {
  if (!app && !appProcess) return;
  let closed = false;
  const child = appProcess;
  try {
    await Promise.race([
      app ? app.close().then(() => { closed = true; }) : Promise.resolve(),
      new Promise(resolve => setTimeout(resolve, 8_000)),
    ]);
  } catch {
    closed = child?.exitCode != null;
  }
  if (!closed && child?.exitCode == null) child.kill('SIGKILL');
  if (child?.exitCode == null) {
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ]);
  }
}

function graphDefinition() {
  return {
    name: 'Graph Base',
    description: 'Graph used by the Agents UI E2E audit.',
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    squadType: 'graph',
    members: [],
    nodes: [
      { kind: 'task', id: 'task', ui: { x: 40, y: 120 } },
      {
        kind: 'agent',
        id: 'worker',
        role: 'Worker',
        targetRef: { kind: 'model', config: 'Alpha Config', model: 'shared-model' },
        model: 'shared-model',
        ui: { x: 300, y: 100 },
      },
      { kind: 'return', id: 'return', returnMode: 'payload', ui: { x: 570, y: 120 } },
    ],
    edges: [
      { from: 'task', to: 'worker' },
      { from: 'worker', to: 'return' },
    ],
  };
}

function workflowCaller() {
  return {
    name: 'Workflow Caller',
    description: 'References Graph Base and creates an indirect-cycle picker case.',
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    squadType: 'workflow',
    members: [],
    nodes: [],
    edges: [],
    workflowTree: {
      id: 'call-graph',
      type: 'agent',
      label: 'Call Graph Base',
      prompt: '{{input}}',
      targetRef: { kind: 'team', name: 'Graph Base' },
      children: [],
    },
  };
}

function brokenWorkflow() {
  const definition = workflowCaller();
  definition.name = 'Broken Workflow';
  definition.description = 'Keeps a missing executor visible for the safe-state audit.';
  definition.workflowTree.id = 'missing-target';
  definition.workflowTree.label = 'Missing target';
  definition.workflowTree.targetRef = { kind: 'team', name: 'Missing Graph' };
  return definition;
}

try {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });
  await mkdir(HOME, { recursive: true });
  await mkdir(WORK, { recursive: true });
  await mkdir(path.join(WORK, '.hadamard', 'teams'), { recursive: true });
  await mkdir(path.join(WORK, '.hadamard', 'routers'), { recursive: true });
  const baseURL = await startProvider();
  const guiPort = await freePort();
  await Promise.all([
    writeFile(CONFIG, JSON.stringify({ env: {
      HADAMARD_PROVIDER: 'openai',
      HADAMARD_API_KEY: 'test-key',
      HADAMARD_BASE_URL: baseURL,
      HADAMARD_MODEL: 'shared-model',
    } }, null, 2), 'utf8'),
    writeFile(path.join(HOME, 'bridge-configs.json'), JSON.stringify({ configs: [
      { name: 'Alpha Config', runtime: 'hadamard', provider: 'openai', apiKey: 'test-key', baseURL, model: 'shared-model', models: [{ name: 'shared-model' }] },
      { name: 'Beta Config', runtime: 'codex', provider: 'openai', apiKey: 'test-key', baseURL, model: 'shared-model', models: [{ name: 'shared-model' }] },
      { name: 'Empty Config', runtime: 'hadamard', provider: 'openai', apiKey: 'test-key', baseURL, models: [] },
    ] }, null, 2), 'utf8'),
    writeFile(path.join(HOME, 'agent-configs.json'), JSON.stringify({ version: 1, profiles: [
      { name: 'Reviewer Agent', description: 'Reviews results.', bridgeConfig: 'Alpha Config', model: 'shared-model' },
    ] }, null, 2), 'utf8'),
    writeFile(path.join(WORK, '.hadamard', 'teams', 'Graph Base.json'), JSON.stringify(graphDefinition(), null, 2), 'utf8'),
    writeFile(path.join(WORK, '.hadamard', 'teams', 'Workflow Caller.json'), JSON.stringify(workflowCaller(), null, 2), 'utf8'),
    writeFile(path.join(WORK, '.hadamard', 'teams', 'Broken Workflow.json'), JSON.stringify(brokenWorkflow(), null, 2), 'utf8'),
    writeFile(path.join(WORK, '.hadamard', 'routers', 'QA Router.json'), JSON.stringify({
      name: 'QA Router',
      description: 'Router entry for the Agents UI E2E audit.',
      routerModel: { model: 'shared-model' },
      routes: [{ role: 'review', when: 'review work', target: { kind: 'agent', name: 'Reviewer Agent' } }],
    }, null, 2), 'utf8'),
  ]);

  const env = { ...process.env, HADAMARD_HOME: HOME, NODE_ENV: 'test' };
  delete env.ELECTRON_RUN_AS_NODE;
  let page;
  let launchError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    app = await electron.launch({
      executablePath: electronExecutable(),
      args: [
        `--user-data-dir=${path.join(TMP, `electron-user-data-${attempt}`)}`,
        path.join(ROOT, 'dist', 'src', 'gui', 'electronMain.js'),
        WORK,
        '--config', CONFIG,
        '--port', String(guiPort),
        '--permission-mode', 'bypassPermissions',
      ],
      cwd: ROOT,
      env,
    });
    appProcess = app.process();
    try {
      page = await app.firstWindow({ timeout: 30_000 });
      break;
    } catch (error) {
      launchError = error;
      await closeApplication().catch(() => appProcess?.kill());
      app = undefined;
      appProcess = undefined;
    }
  }
  if (!page) throw launchError || new Error('Electron did not open a window');
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.getElementById('overviewBody')?.children.length);

  const initialFit = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    scrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  assert(initialFit.width >= 1100 && initialFit.height >= 700, `unexpected launch size ${JSON.stringify(initialFit)}`);
  assert.equal(initialFit.scrollX, false);
  assert.equal(initialFit.scrollY, false);

  await page.locator('#navTeam').click();
  await page.locator('#regionTeam').waitFor({ state: 'visible' });
  await page.locator('.squad-chip[data-name="Reviewer Agent"][data-kind="profile"]').waitFor();
  await page.locator('.squad-chip[data-name="QA Router"][data-kind="router"]').waitFor();
  await page.locator('#teamNewSquadBtn').click();
  await page.locator('#newSquadDialog').waitFor({ state: 'visible' });
  await page.locator('#newSquadDialog button').filter({ hasText: /^Agent$/ }).click();
  await page.locator('#newSquadDialog .te-field').filter({ hasText: /^Name/ }).locator('input').fill('QA-Agent');
  await page.locator('#newSquadDialog .te-field').filter({ hasText: /^Description/ }).locator('textarea').fill('Agent control validation.');
  await page.locator('#newSquadDialog button').filter({ hasText: /^Create$/ }).click();
  await page.locator('#agentProfileEditorPanel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#agentProfileEditorTitle').textContent(), 'New agent');
  assert.equal(await page.locator('#agentProfileDeleteBtn').isHidden(), true);
  const agentConfigPicker = page.locator('#agentProfileConfigPicker');
  const agentModelPicker = page.locator('#agentProfileModelSelect');
  const agentConfigOptions = await agentConfigPicker.locator('option').evaluateAll(options => options.map(option => ({
    value: option.value,
    text: option.textContent || '',
  })));
  assert(agentConfigOptions.some(option => option.value === '__inherit__'));
  assert(agentConfigOptions.some(option => option.value === 'Alpha Config'));
  assert(agentConfigOptions.some(option => option.value === 'Beta Config'));
  assert(agentConfigOptions.some(option => option.value === 'Empty Config' && option.text.includes('no models')),
    'Every saved Configuration must remain visible even when it has no models');
  await assertVisibleSelectsUsable(page, '#agentProfileEditorPanel');
  await agentConfigPicker.selectOption('Empty Config');
  assert.equal(await agentModelPicker.isDisabled(), true);
  assert.equal(await agentModelPicker.locator('option').textContent(), 'No models configured');
  await shot(page, '00-agent-empty-configuration.png');

  await agentConfigPicker.selectOption('Alpha Config');
  assert.equal(await agentModelPicker.isEnabled(), true);
  assert.equal(await agentModelPicker.inputValue(), 'shared-model');
  const agentDescriptionLabel = page.locator('label.dialog-field').filter({ has: page.locator('#agentProfileDescription') });
  assert.equal((await agentDescriptionLabel.textContent()).trim().startsWith('Description *'), false);
  await page.locator('#agentProfileDescription').fill('');
  await page.locator('#agentProfilePromptMode').selectOption('replace');
  await page.locator('#agentProfileSystemPrompt').fill('Validate every requested control.');
  await page.locator('#agentProfileSubagent').uncheck();
  await page.locator('#agentProfilePermission').selectOption('plan');
  await page.locator('#agentProfileEffort').selectOption('high');
  await page.locator('#agentProfileMaxTokens').fill('2048');
  await page.locator('#agentProfileTemperature').fill('0.4');
  await page.locator('#agentProfileAdvanced summary').click();
  await page.locator('#agentProfileTopP').fill('0.8');
  await page.locator('#agentProfileMaxIterations').fill('7');
  await page.locator('#agentProfileTimeoutMs').fill('9000');
  await page.locator('#agentProfileWorkspace').selectOption('workspace');
  await page.locator('#agentProfileTools .te-tool-toggle').filter({ hasText: 'Clear all' }).click();
  await page.locator('#agentProfileTools input[data-tool="Read"]').check();
  await page.locator('#agentProfileTools input[data-tool="Grep"]').check();
  await shot(page, '01-agent-controls-filled.png');
  const agentSaveResponse = page.waitForResponse(response => response.url().endsWith('/api/agent-profiles') && response.request().method() === 'POST');
  await page.locator('#agentProfileCfgSave').click();
  assert.equal((await agentSaveResponse).status(), 200);
  await page.locator('#agentProfileEditorPanel').waitFor({ state: 'visible' });
  await page.locator('#agentProfileEditorTitle').filter({ hasText: 'Edit agent' }).waitFor();
  assert.equal(await page.locator('#agentProfileConfigPicker').inputValue(), 'Alpha Config');
  assert.equal(await page.locator('#agentProfileModelSelect').inputValue(), 'shared-model');
  assert.equal(await page.locator('#agentProfileDescription').inputValue(), 'Validate every requested control.');
  assert.equal(await page.locator('#agentProfilePromptMode').inputValue(), 'replace');
  assert.equal(await page.locator('#agentProfileSystemPrompt').inputValue(), 'Validate every requested control.');
  assert.equal(await page.locator('#agentProfileSubagent').isChecked(), false);
  assert.equal(await page.locator('#agentProfilePermission').inputValue(), 'plan');
  assert.equal(await page.locator('#agentProfileEffort').inputValue(), 'high');
  assert.equal(await page.locator('#agentProfileMaxTokens').inputValue(), '2048');
  assert.equal(await page.locator('#agentProfileTemperature').inputValue(), '0.4');
  assert.equal(await page.locator('#agentProfileTopP').inputValue(), '0.8');
  assert.equal(await page.locator('#agentProfileMaxIterations').inputValue(), '7');
  assert.equal(await page.locator('#agentProfileTimeoutMs').inputValue(), '9000');
  assert.equal(await page.locator('#agentProfileWorkspace').inputValue(), 'workspace');
  assert.deepEqual(await page.locator('#agentProfileTools input[data-tool]:checked').evaluateAll(inputs => inputs.map(input => input.dataset.tool)), ['Read', 'Grep']);
  await assertVisibleSelectsUsable(page, '#agentProfileEditorPanel');
  await shot(page, '02-agent-controls-reopened.png');

  await page.locator('.squad-chip[data-name="QA Router"][data-kind="router"]').click();
  await page.locator('.router-form-body').waitFor({ state: 'visible' });
  const leaderSection = page.locator('.router-form-section').filter({ has: page.getByRole('heading', { name: 'Leader', exact: true }) });
  const leaderPicker = leaderSection.locator('.te-field').filter({ hasText: 'Leader model' }).locator('select');
  const leaderOptions = await leaderPicker.locator('option').evaluateAll(options => options.map(option => option.value));
  assert(leaderOptions.includes('model:Alpha Config:shared-model'));
  assert(leaderOptions.includes('model:Beta Config:shared-model'));
  assert((await leaderPicker.locator('option[value="model:Beta Config:shared-model"]').textContent()).includes('Beta Config'));
  await leaderPicker.selectOption('model:Beta Config:shared-model');
  let routeRow = page.locator('.router-form-route').first();
  const routeTarget = routeRow.locator('.te-field').filter({ hasText: /^Target/ }).locator('select');
  assert((await routeTarget.locator('option').evaluateAll(options => options.map(option => option.value))).includes('agent:QA-Agent'));
  await routeTarget.selectOption('agent:QA-Agent');
  routeRow = page.locator('.router-form-route').first();
  await routeRow.locator('.te-field').filter({ hasText: /^Role \/ label/ }).locator('input').fill('qa-specialist');
  await routeRow.locator('.te-field').filter({ hasText: /^When/ }).locator('input').fill('validate the Agents UI');
  await routeRow.locator('.te-field').filter({ hasText: /^Notes for leader/ }).locator('textarea').fill('Use the saved QA Agent.');
  await routeRow.locator('.te-field').filter({ hasText: /^Effort/ }).locator('select').selectOption('high');
  await routeRow.locator('.te-field').filter({ hasText: /^Max tokens/ }).locator('input').fill('1024');
  const fallbackSection = page.locator('.router-form-section').filter({ has: page.getByRole('heading', { name: 'Fallback', exact: true }) });
  await fallbackSection.locator('.te-field').filter({ hasText: /^Fallback target/ }).locator('select').selectOption('model:Alpha Config:shared-model');
  const promptSection = page.locator('.router-form-section').filter({ has: page.getByRole('heading', { name: 'Classification prompt', exact: true }) });
  await promptSection.locator('textarea').fill('Choose the most relevant QA route.');
  await assertVisibleSelectsUsable(page, '.router-form-body');
  await shot(page, '03-router-controls-filled.png');
  const routerSaveResponse = page.waitForResponse(response => response.url().endsWith('/api/router/profile') && response.request().method() === 'POST');
  await page.locator('.graph-save-btn').click();
  assert.equal((await routerSaveResponse).status(), 200);
  await page.locator('.router-form-body').waitFor({ state: 'visible' });
  const reopenedLeader = page.locator('.router-form-section').filter({ has: page.getByRole('heading', { name: 'Leader', exact: true }) })
    .locator('.te-field').filter({ hasText: 'Leader model' }).locator('select');
  assert.equal(await reopenedLeader.inputValue(), 'model:Beta Config:shared-model');
  const reopenedRoute = page.locator('.router-form-route').first();
  assert.equal(await reopenedRoute.locator('.te-field').filter({ hasText: /^Target/ }).locator('select').inputValue(), 'agent:QA-Agent');
  assert.equal(await reopenedRoute.locator('.te-field').filter({ hasText: /^When/ }).locator('input').inputValue(), 'validate the Agents UI');
  assert.equal(await reopenedRoute.locator('.te-field').filter({ hasText: /^Effort/ }).locator('select').inputValue(), 'high');
  assert.equal(await reopenedRoute.locator('.te-field').filter({ hasText: /^Max tokens/ }).locator('input').inputValue(), '1024');
  await shot(page, '04-router-controls-reopened.png');
  await page.locator('.squad-chip[data-name="Broken Workflow"][data-kind="team"]').click();
  await page.locator('.wf-node button[title="Edit"]').click();
  const brokenExecutor = page.locator('#wfNodeDialog .te-field').filter({ hasText: 'Executor' }).locator('select');
  const brokenOption = brokenExecutor.locator('option[data-broken="true"]');
  assert.equal(await brokenOption.getAttribute('value'), 'team:Missing Graph');
  assert((await brokenOption.textContent()).includes('(missing)'));
  await page.locator('#wfNodeDialog button').filter({ hasText: /^Cancel$/ }).click();
  await page.locator('.squad-chip[data-name="Graph Base"][data-kind="team"]').click();
  await page.locator('.graph-board-viewport').waitFor({ state: 'visible' });
  await page.locator('.graph-tools button').filter({ hasText: /^Used by 1$/ }).waitFor();
  assert.equal(await page.getByText('Design with agent', { exact: true }).count(), 0);

  const modeButtons = page.locator('.graph-mode-btn');
  assert.equal(await modeButtons.count(), 2);
  assert.equal((await modeButtons.nth(0).textContent()).trim(), '');
  assert.equal((await modeButtons.nth(1).textContent()).trim(), '');
  assert.equal(await modeButtons.nth(0).getAttribute('aria-label'), 'Pointer tool (V)');
  assert.equal(await modeButtons.nth(1).getAttribute('aria-label'), 'Hand tool (H)');
  assert.equal(await modeButtons.nth(0).getAttribute('aria-pressed'), 'true');
  await modeButtons.nth(1).click();
  assert.equal(await modeButtons.nth(1).getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('v');
  assert.equal(await modeButtons.nth(0).getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('h');
  assert.equal(await modeButtons.nth(1).getAttribute('aria-pressed'), 'true');
  await shot(page, '00-graph-canvas-icons.png');

  const viewport = page.locator('.graph-board-viewport');
  const stage = page.locator('.graph-board-stage');
  const viewportBox = await viewport.boundingBox();
  assert(viewportBox);
  const transformBefore = await stage.getAttribute('style');
  await page.mouse.move(viewportBox.x + 80, viewportBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + 145, viewportBox.y + 120, { steps: 5 });
  await page.mouse.up();
  const transformAfterHand = await stage.getAttribute('style');
  assert.notEqual(transformAfterHand, transformBefore, 'Hand drag did not pan the graph');
  await page.keyboard.press('v');
  await page.mouse.move(viewportBox.x + 120, viewportBox.y + 120);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(viewportBox.x + 165, viewportBox.y + 155, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  const transformAfterMiddle = await stage.getAttribute('style');
  assert.notEqual(transformAfterMiddle, transformAfterHand, 'Middle-button drag did not pan the graph');
  await page.keyboard.down('Space');
  await page.mouse.move(viewportBox.x + 160, viewportBox.y + 90);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + 200, viewportBox.y + 125, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const transformAfterSpace = await stage.getAttribute('style');
  assert.notEqual(transformAfterSpace, transformAfterMiddle, 'Space + left drag did not pan the graph');
  assert.equal(await page.locator('.graph-edge-visible').count(), 2);

  await page.mouse.move(viewportBox.x + 8, viewportBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + viewportBox.width - 8, viewportBox.y + viewportBox.height - 8, { steps: 6 });
  await page.mouse.up();
  assert((await page.locator('.graph-node.board-node.selected').count()) >= 2, 'Pointer marquee did not select graph nodes');

  const worker = page.locator('.graph-node.board-node[data-graph-ref="worker"]');
  await worker.click();
  assert(await worker.evaluate(node => node.classList.contains('selected')));
  const workerBefore = await worker.boundingBox();
  assert(workerBefore);
  await page.mouse.move(workerBefore.x + 30, workerBefore.y + 25);
  await page.mouse.down();
  await page.mouse.move(workerBefore.x + 65, workerBefore.y + 45, { steps: 4 });
  await page.mouse.up();
  const workerAfter = await worker.boundingBox();
  assert(workerAfter && Math.abs(workerAfter.x - workerBefore.x) > 10, 'Pointer drag did not move the node');
  await page.locator('.graph-undo-btn').click();
  const workerUndone = await worker.boundingBox();
  assert(workerUndone && Math.abs(workerUndone.x - workerBefore.x) < 5, 'Undo did not restore the node position');
  await page.locator('.graph-redo-btn').click();
  const workerRedone = await worker.boundingBox();
  assert(workerRedone && Math.abs(workerRedone.x - workerAfter.x) < 5, 'Redo did not restore the moved node position');
  await worker.dblclick();
  await page.locator('#teamAgentModal').waitFor({ state: 'visible' });
  const executor = page.locator('#teamAgentModalBody .te-field').filter({ hasText: 'Executor' }).locator('select');
  const optionState = await executor.locator('option').evaluateAll(options => options.map(option => ({
    value: option.value,
    text: option.textContent,
    disabled: option.disabled,
  })));
  assert(optionState.some(option => option.value === 'model:Alpha Config:shared-model'));
  assert(optionState.some(option => option.value === 'model:Beta Config:shared-model'));
  assert(optionState.some(option => option.value === 'agent:Reviewer Agent'));
  assert(optionState.some(option => option.value === 'team:Workflow Caller' && option.disabled));
  assert(optionState.some(option => option.value === 'model:Beta Config:shared-model' && option.text.includes('Beta Config')));
  await executor.selectOption('model:Beta Config:shared-model');
  const graphField = (label) => page.locator('#teamAgentModalBody .te-field').filter({ hasText: label }).first();
  await graphField(/^Role \/ specialty/).locator('input').fill('QA worker');
  await graphField(/^Responsibility/).locator('textarea').fill('Validate graph controls and persistence.');
  await graphField(/^Agent type/).locator('select').selectOption('single');
  await page.locator('#teamAgentModalBody').getByText('type=single', { exact: false }).waitFor();
  await graphField(/^Agent type/).locator('select').selectOption('react');
  await graphField(/^Workspace access/).locator('select').selectOption('full');
  await graphField(/^Specialist prompt/).locator('textarea').fill('Inspect every graph node option.');
  await graphField(/^Join incoming edges/).locator('select').selectOption('any');
  await graphField(/^Timeout/).locator('input').fill('8000');
  await graphField(/^Max tool iterations/).locator('input').fill('6');
  await graphField(/^Max rounds/).locator('input').fill('3');
  await page.locator('#teamAgentModalBody .te-tool-toggle').filter({ hasText: 'Clear all' }).click();
  await page.locator('#teamAgentModalBody input[data-tool="Read"]').check();
  await page.locator('#teamAgentModalBody input[data-tool="Grep"]').check();
  await assertVisibleSelectsUsable(page, '#teamAgentModalBody');
  await shot(page, '01-graph-picker-and-icons.png');
  await page.locator('#teamAgentModalDone').click();

  const graphSaveResponse = page.waitForResponse(response => response.url().endsWith('/api/team/save') && response.request().method() === 'POST');
  await page.locator('.graph-save-btn').click();
  assert.equal((await graphSaveResponse).status(), 200);
  await page.locator('.squad-chip[data-name="Workflow Caller"]').click();
  await page.locator('.squad-chip[data-name="Graph Base"]').click();
  const reopenedWorker = page.locator('.graph-node.board-node[data-graph-ref="worker"]');
  await reopenedWorker.dblclick();
  assert.equal(await graphField('Executor').locator('select').inputValue(), 'model:Beta Config:shared-model');
  assert.equal(await graphField(/^Role \/ specialty/).locator('input').inputValue(), 'QA worker');
  assert.equal(await graphField(/^Responsibility/).locator('textarea').inputValue(), 'Validate graph controls and persistence.');
  assert.equal(await graphField(/^Workspace access/).locator('select').inputValue(), 'full');
  assert.equal(await graphField(/^Join incoming edges/).locator('select').inputValue(), 'any');
  assert.equal(await graphField(/^Timeout/).locator('input').inputValue(), '8000');
  assert.equal(await graphField(/^Max tool iterations/).locator('input').inputValue(), '6');
  assert.equal(await graphField(/^Max rounds/).locator('input').inputValue(), '3');
  assert.deepEqual(await page.locator('#teamAgentModalBody input[data-tool]:checked').evaluateAll(inputs => inputs.map(input => input.dataset.tool)), ['Read', 'Grep']);
  await shot(page, '02-graph-controls-reopened.png');
  await page.locator('#teamAgentModalDone').click();

  const usedBy = page.locator('.graph-tools button').filter({ hasText: /^Used by 1$/ });
  await usedBy.click();
  await page.locator('#usedByDialog').waitFor({ state: 'visible' });
  await page.locator('#usedByDialog').getByText('Workflow "Workflow Caller"', { exact: false }).waitFor();
  await shot(page, '03-used-by-impact.png');
  await page.locator('#usedByDialog button').filter({ hasText: 'Go to' }).click();
  await page.locator('.squad-chip[data-name="Workflow Caller"].active').waitFor();
  await page.locator('.graph-tabs button').filter({ hasText: 'Workflow' }).waitFor();

  await page.locator('#teamNewSquadBtn').click();
  await page.locator('#newSquadDialog').waitFor({ state: 'visible' });
  await page.locator('#newSquadDialog button').filter({ hasText: /^Workflow$/ }).click();
  await page.locator('#newSquadDialog .te-field').filter({ hasText: /^Name/ }).locator('input').fill('QA Workflow');
  await page.locator('#newSquadDialog .te-field').filter({ hasText: /^Description/ }).locator('textarea').fill('Created by the real Electron audit.');
  const createResponse = page.waitForResponse(response => response.url().endsWith('/api/team/save') && response.request().method() === 'POST');
  await page.locator('#newSquadDialog button').filter({ hasText: /^Create$/ }).click();
  assert.equal((await createResponse).status(), 200);
  await page.locator('.squad-chip[data-name="QA Workflow"].active').waitFor();
  const rootNode = page.locator('.wf-node').first();
  await rootNode.waitFor();
  await rootNode.locator('button[title="Edit"]').click();
  const workflowExecutor = page.locator('#wfNodeDialog .te-field').filter({ hasText: 'Executor' }).locator('select');
  await workflowExecutor.selectOption('model:Alpha Config:shared-model');
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^Prompt/ }).locator('textarea').fill('QA: {{input}}');
  await page.locator('#wfNodeDialog button').filter({ hasText: /^Save$/ }).click();
  const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/team/save') && response.request().method() === 'POST');
  await page.locator('.graph-save-btn').click();
  assert.equal((await saveResponse).status(), 200);
  await page.locator('.squad-chip[data-name="Graph Base"]').click();
  await page.locator('.squad-chip[data-name="QA Workflow"]').click();
  await page.locator('.wf-node-meta').filter({ hasText: 'shared-model' }).waitFor();
  assert.equal(await page.getByText('Design with agent', { exact: true }).count(), 0);
  await rootNode.locator('button[title="Edit"]').click();
  assert.equal(await page.locator('#wfNodeDialog .te-field').filter({ hasText: 'Executor' }).locator('select').inputValue(), 'model:Alpha Config:shared-model');
  await assertVisibleSelectsUsable(page, '#wfNodeDialog');
  await page.locator('#wfNodeDialog button').filter({ hasText: /^Cancel$/ }).click();

  await rootNode.locator('xpath=..').locator(':scope > .wf-add').click();
  await page.locator('#wfNodeDialog .wf-type-pick button').filter({ hasText: /^Branch/ }).click();
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^Label/ }).locator('input').fill('Quality gate');
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^Condition/ }).locator('input').fill('approved');
  await assertVisibleSelectsUsable(page, '#wfNodeDialog');
  await page.locator('#wfNodeDialog button').filter({ hasText: /^Add$/ }).click();
  const qualityNode = page.locator('.wf-node').filter({ has: page.locator('.wf-node-label', { hasText: 'Quality gate' }) });
  await qualityNode.waitFor();
  assert.equal(await qualityNode.locator('.wf-node-cond').textContent(), 'if contains: "approved"');
  assert.deepEqual(await qualityNode.locator('xpath=..').locator(':scope > .wf-children > .wf-child-col > .wf-branch-label').allTextContents(), ['IF', 'ELSE']);

  const qualityFirstPath = qualityNode.locator('xpath=..').locator(':scope > .wf-children > .wf-child-col').first();
  await qualityFirstPath.locator(':scope > .wf-add').click();
  await page.locator('#wfNodeDialog .wf-type-pick button').filter({ hasText: /^Parallel/ }).click();
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^Label/ }).locator('input').fill('Parallel checks');
  await page.locator('#wfNodeDialog button').filter({ hasText: /^Add$/ }).click();
  const parallelNode = page.locator('.wf-node').filter({ has: page.locator('.wf-node-label', { hasText: 'Parallel checks' }) });
  await parallelNode.waitFor();
  await parallelNode.locator('xpath=..').locator(':scope > .wf-add').click();
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^Label/ }).locator('input').fill('Agent cross-check');
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^Prompt/ }).locator('textarea').fill('Cross-check: {{input}}');
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: 'Executor' }).locator('select').selectOption('agent:QA-Agent');
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^System prompt/ }).locator('textarea').fill('Use the saved QA Agent configuration.');
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^Workspace access/ }).locator('select').selectOption('full');
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^Timeout/ }).locator('input').fill('7000');
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^Max tool iterations/ }).locator('input').fill('5');
  await page.locator('#wfNodeDialog .te-tool-toggle').filter({ hasText: 'Clear all' }).click();
  await page.locator('#wfNodeDialog input[data-tool="Read"]').check();
  await page.locator('#wfNodeDialog input[data-tool="Grep"]').check();
  await assertVisibleSelectsUsable(page, '#wfNodeDialog');
  await page.locator('#wfNodeDialog button').filter({ hasText: /^Add$/ }).click();
  await page.locator('.wf-node-label').filter({ hasText: 'Agent cross-check' }).waitFor();
  await shot(page, '04-workflow-all-node-types.png');

  const nestedWorkflowSaveResponse = page.waitForResponse(response => response.url().endsWith('/api/team/save') && response.request().method() === 'POST');
  await page.locator('.graph-save-btn').click();
  assert.equal((await nestedWorkflowSaveResponse).status(), 200);
  await page.locator('.squad-chip[data-name="Graph Base"]').click();
  await page.locator('.squad-chip[data-name="QA Workflow"]').click();
  assert.equal(await page.locator('.wf-node-type').filter({ hasText: /^branch$/ }).count(), 1);
  assert.equal(await page.locator('.wf-node-type').filter({ hasText: /^parallel$/ }).count(), 1);
  const reopenedCrossCheck = page.locator('.wf-node').filter({ has: page.locator('.wf-node-label', { hasText: 'Agent cross-check' }) });
  await reopenedCrossCheck.locator('button[title="Edit"]').click();
  const reopenedWorkflowField = (label) => page.locator('#wfNodeDialog .te-field').filter({ hasText: label }).first();
  assert.equal(await reopenedWorkflowField('Executor').locator('select').inputValue(), 'agent:QA-Agent');
  assert.equal(await reopenedWorkflowField(/^Prompt/).locator('textarea').inputValue(), 'Cross-check: {{input}}');
  assert.equal(await reopenedWorkflowField(/^System prompt/).locator('textarea').inputValue(), 'Use the saved QA Agent configuration.');
  assert.equal(await reopenedWorkflowField(/^Workspace access/).locator('select').inputValue(), 'full');
  assert.equal(await reopenedWorkflowField(/^Timeout/).locator('input').inputValue(), '7000');
  assert.equal(await reopenedWorkflowField(/^Max tool iterations/).locator('input').inputValue(), '5');
  assert.deepEqual(await page.locator('#wfNodeDialog input[data-tool]:checked').evaluateAll(inputs => inputs.map(input => input.dataset.tool)), ['Read', 'Grep']);
  await page.locator('#wfNodeDialog button').filter({ hasText: /^Cancel$/ }).click();
  await shot(page, '05-workflow-created-reopened.png');

  await rootNode.locator('button[title="Edit"]').click();
  await page.locator('#wfNodeDialog .te-field').filter({ hasText: /^Prompt/ }).locator('textarea').fill('UNSAVED QA: {{input}}');
  await page.locator('#wfNodeDialog button').filter({ hasText: /^Save$/ }).click();
  await page.locator('#managerFab').click();
  await page.locator('#managerPanel').waitFor({ state: 'visible' });
  await page.locator('#managerScopeGlobal').click();
  await page.locator('#managerChatInput').fill('How do I use Workflow nodes?');
  const managerRequestPromise = page.waitForRequest(request => request.url().endsWith('/api/manager/chat'));
  await page.locator('#managerChatSend').click();
  const managerRequest = await managerRequestPromise;
  const managerPayload = managerRequest.postDataJSON();
  assert.equal(managerPayload.scope, 'global');
  assert.equal(managerPayload.editorContext.entityName, 'QA Workflow');
  assert.equal(managerPayload.editorContext.dirty, true);
  assert.equal(managerPayload.editorContext.draft.workflowTree.prompt, 'UNSAVED QA: {{input}}');
  await page.locator('#managerTranscript').filter({ hasText: 'Use the Agents page and capability guide.' }).waitFor();
  const assistantProviderRequest = providerRequests.find(request => Array.isArray(request.tools));
  const toolNames = assistantProviderRequest?.tools?.map(tool => tool.function?.name) ?? [];
  assert(toolNames.includes('ReadProductCapability'));
  assert(toolNames.includes('GetCurrentEditorContext'));
  assert(toolNames.includes('ProposeTeamGraph'));
  await page.waitForFunction(() => document.getElementById('managerChatSend')?.disabled === false);
  assert((await page.locator('#teamSavedStatus').textContent()).includes('Unsaved'), 'Global Assistant discarded the visible workflow draft');
  await shot(page, '06-global-assistant-with-draft.png');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 720));
  await page.waitForTimeout(400);
  const compactFit = await page.evaluate(() => {
    const region = document.getElementById('regionTeam')?.getBoundingClientRect();
    const manager = document.getElementById('managerPanel')?.getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      region: region && { left: region.left, top: region.top, right: region.right, bottom: region.bottom },
      manager: manager && { left: manager.left, top: manager.top, right: manager.right, bottom: manager.bottom },
    };
  });
  assert(compactFit.region && compactFit.region.left >= 0 && compactFit.region.right <= compactFit.width + 1);
  assert(compactFit.manager && compactFit.manager.left >= 0 && compactFit.manager.right <= compactFit.width + 1);
  await shot(page, '07-compact-window.png');

  await page.locator('#managerCloseBtn').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1536, 1000));
  await page.waitForTimeout(300);
  const providerCountBeforeRun = providerRequests.length;
  await page.locator('#teamRunSquadBtn').click();
  await page.locator('#teamRunDialog').waitFor({ state: 'visible' });
  await page.locator('#teamRunPrompt').fill('Run the complete workflow audit');
  await page.locator('#teamRunDialog button').filter({ hasText: /^Run$/ }).click();
  for (let attempt = 0; attempt < 80 && providerRequests.length === providerCountBeforeRun; attempt += 1) {
    await page.waitForTimeout(250);
  }
  assert(providerRequests.length > providerCountBeforeRun, 'Run simulation did not reach the model provider');
  const workflowRunRequests = JSON.stringify(providerRequests.slice(providerCountBeforeRun));
  const workflowRunMessages = providerRequests.slice(providerCountBeforeRun).flatMap(request =>
    (request.messages || []).map(message => ({ role: message.role, content: String(message.content || '').slice(-1200) })));
  assert(workflowRunRequests.includes('UNSAVED QA:'),
    `Run simulation used a stale saved workflow instead of the visible draft: ${JSON.stringify(workflowRunMessages)}`);
  await page.locator('#projectConversation').waitFor({ state: 'visible' });
  await page.locator('#projectConversation').getByText('Team response', { exact: false }).waitFor();
  assert.equal(await page.locator('#projectConversation').getByText('team not found: QA', { exact: false }).count(), 0);
  await page.waitForFunction(() => {
    const button = document.getElementById('sendBtn');
    return button && !button.classList.contains('stopping') && button.disabled !== true;
  });
  await shot(page, '08-workflow-real-run.png');

  const removeConfigResults = await page.evaluate(async (names) => {
    const results = [];
    for (const name of names) {
      const response = await fetch('/api/bridge/config/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hadamard-token': window.__HADAMARD_TOKEN__ },
        body: JSON.stringify({ name, strategy: { type: 'leave' } }),
      });
      results.push({ name, status: response.status });
    }
    return results;
  }, ['Alpha Config', 'Beta Config', 'Empty Config']);
  assert(removeConfigResults.every(result => result.status === 200), JSON.stringify(removeConfigResults));
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.getElementById('overviewBody')?.children.length);
  await page.locator('#navTeam').click();
  await page.locator('#teamNewSquadBtn').click();
  await page.locator('#newSquadDialog button').filter({ hasText: /^Agent$/ }).click();
  await page.locator('#newSquadDialog .te-field').filter({ hasText: /^Name/ }).locator('input').fill('No-Config-Agent');
  await page.locator('#newSquadDialog .te-field').filter({ hasText: /^Description/ }).locator('textarea').fill('No provider configuration fallback.');
  await page.locator('#newSquadDialog button').filter({ hasText: /^Create$/ }).click();
  await page.locator('#agentProfileEditorPanel').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('#agentProfileConfigPicker option').evaluateAll(options => options.map(option => option.value)), ['__inherit__']);
  assert.equal(await page.locator('#agentProfileModelSelect').isDisabled(), true);
  assert.equal(await page.locator('#agentProfileModelSelect option').textContent(), 'Uses the current session model');
  await page.getByRole('button', { name: 'Manage models' }).waitFor();
  await assertVisibleSelectsUsable(page, '#agentProfileEditorPanel');
  await shot(page, '09-agent-no-configurations.png');

  assert.deepEqual(browserErrors, []);
  const retiredTarget = await page.evaluate(() => ({
    url: new URL('/api/team/propose', window.location.href).href,
    token: window.__HADAMARD_TOKEN__,
  }));
  const retiredResponse = await fetch(retiredTarget.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hadamard-token': retiredTarget.token },
    body: JSON.stringify({ instruction: 'unused' }),
  });
  assert.equal(retiredResponse.status, 404);
} catch (error) {
  failure = error;
  if (app) {
    const windows = app.windows();
    if (windows[0]) await shot(windows[0], '99-failure.png').catch(() => undefined);
  }
} finally {
  await closeApplication().catch(() => appProcess?.kill());
  if (providerServer) {
    providerServer.closeAllConnections?.();
    await new Promise(resolve => providerServer.close(resolve));
  }
  await rm(TMP, { recursive: true, force: true });
}

const report = {
  passed: !failure,
  error: failure ? (failure.stack || failure.message || String(failure)) : null,
  browserErrors,
  providerToolNames: providerRequests.find(request => Array.isArray(request.tools))?.tools?.map(tool => tool.function?.name) ?? [],
  screenshots,
};
await writeFile(path.join(ARTIFACTS, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(failure ? 1 : 0);
