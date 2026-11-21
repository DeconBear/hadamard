import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = process.cwd();
const port = Number(process.env.HCANVAS_NOTEBOOK_E2E_PORT || 46770);
const timeout = 30_000;
let browser;
let server;

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
  console.log('PASS ' + name);
}

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-notebook-interactions-'));
  try {
    await mkdir(path.join(workspace, 'extensions'), { recursive: true });
    await cp(path.join(root, 'examples/hcanvas-extensions/python-kernel'), path.join(workspace, 'extensions/python-kernel'), { recursive: true });
    const fence = String.fromCharCode(96).repeat(3);
    const source = ['---', 'hcanvas: notebook', 'kernel: python', '---', '', '# Interaction notebook', '', 'Energy: $E=mc^2$', '', fence + 'python exec', 'a = 1\nprint(a)', fence, '', fence + 'python exec', 'b = 2\nprint(b)', fence, ''].join('\n');
    await writeFile(path.join(workspace, 'interaction.hnb.md'), source, 'utf8');
    const layoutSource = ['# Layout', '', 'First **bold** paragraph.', '', 'Second paragraph.', '', 'Third paragraph.', '', fence + 'python exec', 'print("layout")', fence, ''].join('\n');
    await writeFile(path.join(workspace, 'layout.hnb.md'), layoutSource, 'utf8');
    const saveSource = ['---', 'hcanvas: notebook', 'kernel: python', '---', '', '# Save notebook', '', fence + 'python exec', 'x = 1\nprint(x)', fence, ''].join('\n');
    await writeFile(path.join(workspace, 'save.hnb.md'), saveSource, 'utf8');
    const switchSource = ['---', 'hcanvas: notebook', 'kernel: python', '---', '', '# Switch notebook', '', 'Original body.', ''].join('\n');
    await writeFile(path.join(workspace, 'switch.hnb.md'), switchSource, 'utf8');
    await writeFile(path.join(workspace, 'legacy.ipynb'), JSON.stringify({ nbformat: 4, cells: [] }), 'utf8');
    server = spawn(process.execPath, ['bin/hcanvas.js', 'serve', '--workspace', workspace, '--port', String(port)], {
      cwd: root, env: { ...process.env, HCANVAS_CONFIG_HOME: path.join(workspace, '.config'), HCANVAS_HOME: path.join(workspace, '.home'), HADAMARD_HOME: path.join(workspace, '.home') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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
    assert('kernel trust', (await api('/api/extensions/trust', { method: 'POST', body: JSON.stringify({ id: 'com.hadamard.examples.python-kernel', trusted: true }) })).status === 200);

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(timeout);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.env.HCANVAS_E2E_DEBUG) {
      page.on('response', async response => {
        if (!response.url().includes('/api/kernels/')) return;
        console.log('KERNEL HTTP', response.request().method(), response.url(), response.status(), await response.text().catch(() => ''));
      });
      page.on('console', message => { if (message.type() === 'error') console.log('BROWSER', message.text()); });
    }
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.locator('[data-sidebar-target="files"]').click();
    await page.locator('#refreshFilesBtn').click();
    await page.locator('.file-tree-root-name').first().click();
    await page.locator('.file-tree-node', { hasText: 'interaction.hnb.md' }).first().click();
    await page.waitForSelector('.nb-code');
    assert('two native code cells', await page.locator('.nb-code').count() === 2);
    assert('bottom Add a cell control is removed', await page.locator('[data-nb-end-add], .nb-end-add').count() === 0);
    assert('Notebook toolbar groups run and session controls', await page.locator('.nb-run-group [data-nb-runall], .nb-run-group [data-nb-run-scope], .nb-session-group [data-nb-restart], .nb-session-group [data-nb-tasks]').count() === 4);
    assert('variable dock starts collapsed without toolbar variable or global kernel controls', await page.locator('[data-nb-variable-body]').evaluate(element => element.classList.contains('hidden')) && await page.locator('[data-nb-variables], [data-nb-default-kernel]').count() === 0);

    const firstEditor = page.locator('.nb-code-input').first();
    await firstEditor.evaluate(element => { element.dataset.nbKeep = 'preserved'; });
    await page.locator('[data-nb-add-code]').click();
    assert('insert preserves existing editor DOM', await firstEditor.evaluate(element => element.dataset.nbKeep) === 'preserved');
    assert('insert adds a cell', await page.locator('.nb-code').count() === 3);

    const ids = await page.locator('.nb-code').evaluateAll(cells => cells.map(cell => cell.dataset.nbCell));
    await page.locator('.nb-code-input .cm-content').first().press('Shift+Enter');
    await page.waitForFunction(expected => document.querySelector('.nb-cell-active')?.dataset.nbCell === expected && document.querySelector('.nb-output')?.textContent?.includes('1'), ids[1]);
    assert('Shift+Enter runs and advances', true);
    await page.locator('.nb-code').nth(1).locator('.cm-content').press('Control+Enter');
    await page.waitForFunction(expected => document.querySelector('.nb-cell-active')?.dataset.nbCell === expected && document.querySelectorAll('.nb-output')[1]?.textContent?.includes('2'), ids[1]);
    assert('Ctrl+Enter runs in place', true);
    await page.locator('.nb-code').nth(1).locator('.cm-content').press('Alt+Enter');
    await page.waitForFunction(() => document.querySelectorAll('.nb-code').length === 4);
    assert('Alt+Enter runs and inserts', true);

    await page.keyboard.press('Escape');
    await page.keyboard.press('a');
    assert('A inserts above', await page.locator('.nb-code').count() === 5);
    await page.locator('.nb-code').first().focus();
    await page.keyboard.press('b');
    await page.waitForTimeout(200);
    const countAfterB = await page.locator('.nb-code').count();
    assert('B inserts below', countAfterB === 6, 'count=' + countAfterB + ' activeText=' + await page.locator('.nb-cell-active').innerText());
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await page.keyboard.press('d');
    assert('DD deletes the selected cell', await page.locator('.nb-code').count() === 5);
    await page.keyboard.press('z');
    const countAfterUndo = await page.locator('.nb-code').count();
    assert('Z restores the deleted cell', countAfterUndo === 6, 'count=' + countAfterUndo + ' active=' + await page.locator('.nb-cell-active').getAttribute('data-nb-cell'));

    const heads = page.locator('.nb-code .nb-cell-head');
    await heads.nth(0).click();
    await heads.nth(1).click({ modifiers: ['Control'] });
    assert('Ctrl click selects multiple cells', await page.locator('.nb-cell-selected').count() === 2);
    await page.locator('[data-nb-run-selected]').click();
    await page.waitForTimeout(500);
    await page.waitForFunction(() => !document.querySelector('[data-nb-cell-status][data-tone="running"], [data-nb-cell-status][data-tone="queued"]'));
    assert('Run selected executes selected cells', true);

    const firstCode = page.locator('.nb-code').first();
    await firstCode.locator('[data-nb-toggle-code]').click();
    assert('code collapse toggles', (await firstCode.getAttribute('class')).includes('nb-code-hidden') && await firstCode.locator('[data-nb-toggle-code]').getAttribute('aria-expanded') === 'false');
    await firstCode.locator('[data-nb-toggle-output]').click();
    assert('output collapse toggles', (await firstCode.getAttribute('class')).includes('nb-output-hidden'));
    await firstCode.locator('[data-nb-toggle-code]').click();
    assert('every code block exposes an always-visible collapse control', await page.locator('.nb-code [data-nb-toggle-code]').count() === await page.locator('.nb-code').count() && await page.locator('.nb-code [data-nb-toggle-code]').evaluateAll(buttons => buttons.every(button => getComputedStyle(button).display !== 'none' && getComputedStyle(button).visibility !== 'hidden')));

    const beforeDrag = await page.locator('.nb-code').evaluateAll(cells => cells.map(cell => cell.dataset.nbCell));
    await page.locator('.nb-code').first().locator('[data-nb-drag]').dragTo(page.locator('.nb-code').nth(1));
    const afterDrag = await page.locator('.nb-code').evaluateAll(cells => cells.map(cell => cell.dataset.nbCell));
    assert('drag reorders cells', beforeDrag[0] === afterDrag[1]);
    assert('drag preserves editor instances', await page.locator('[data-nb-keep="preserved"]').count() === 1);
    await page.keyboard.press('Escape');
    await page.keyboard.press('z');
    const afterUndo = await page.locator('.nb-code').evaluateAll(cells => cells.map(cell => cell.dataset.nbCell));
    assert('undo restores drag order', JSON.stringify(afterUndo) === JSON.stringify(beforeDrag), JSON.stringify({ beforeDrag, afterUndo }));

    await page.locator('.nb-markdown-body .hc-math').click();
    await page.locator('[data-formula-symbolic]').click();
    const symbolicCell = page.locator('.nb-code', { hasText: 'import sympy as sp' }).first();
    assert('symbolic formula generates real SymPy code', await symbolicCell.count() === 1);
    await symbolicCell.locator('.cm-content').press('Control+Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.nb-output')].some(element => /(?:c\*\*2(?:\.0)?\*m|m\*c\*\*2)/u.test(element.textContent || '')));
    const symbolicText = await symbolicCell.locator('.nb-output').innerText();
    const symbolicSource = await symbolicCell.locator('.cm-content').innerText();
    assert('symbolic code executes in Python', /(?:c\*\*2(?:\.0)?\*m|m\*c\*\*2)/u.test(symbolicText), symbolicText + '\nSOURCE:\n' + symbolicSource);

    await page.locator('[data-nb-add-code]').click();
    const parameterCell = page.locator('.nb-code').last();
    await parameterCell.locator('.cm-content').fill('distance = hc_get("distance", 2)\ndoubled = distance * 2\nhc_set("distance", distance)\nhc_set("doubled", doubled)\nprint(doubled)');
    await page.locator('[data-nb-variable-expand]').click();
    await page.locator('[data-nb-variable-popout]').click();
    assert('variable dock pops out as a floating topmost window', await page.locator('[data-nb-variable-panel]').evaluate(element => element.classList.contains('floating') && getComputedStyle(element).position === 'fixed') && await page.locator('[data-nb-variable-body]').evaluate(element => !element.classList.contains('hidden')));
    const variablePanel = page.locator('[data-nb-variable-panel]');
    const variableBeforeDrag = await variablePanel.boundingBox();
    const variableBar = await page.locator('.nb-variable-summary').boundingBox();
    if (!variableBeforeDrag || !variableBar) throw new Error('Variable panel drag bounds are unavailable');
    await page.mouse.move(variableBar.x + 45, variableBar.y + variableBar.height / 2);
    await page.mouse.down();
    await page.mouse.move(variableBar.x - 75, variableBar.y + variableBar.height / 2 + 70, { steps: 5 });
    await page.mouse.up();
    const variableAfterDrag = await variablePanel.boundingBox();
    assert('floating variable panel moves with mouse drag', Boolean(variableAfterDrag && variableAfterDrag.x < variableBeforeDrag.x - 60 && variableAfterDrag.y > variableBeforeDrag.y + 40), JSON.stringify({ variableBeforeDrag, variableAfterDrag }));
    await page.locator('[data-nb-variable-popout]').click();
    assert('variable dock returns inline without collapsing', await page.locator('[data-nb-variable-panel]').evaluate(element => !element.classList.contains('floating')) && await page.locator('[data-nb-variable-expand]').getAttribute('aria-expanded') === 'true');
    await page.locator('[data-nb-new-name]').fill('distance');
    await page.locator('[data-nb-new-value]').fill('2');
    await page.locator('[data-nb-variable-add]').click();
    assert('variable panel has no numeric sliders', await page.locator('[data-nb-variable-range]').count() === 0);
    await page.locator('[data-nb-variable-expand]').click();
    await parameterCell.locator('.cm-content').press('Control+Enter');
    await parameterCell.locator('.nb-output').filter({ hasText: '4' }).waitFor();
    await page.locator('[data-nb-variable-expand]').click();
    const initialInput = page.locator('[data-nb-variable-row="distance"] [data-nb-variable-value]');
    const currentText = name => page.locator('[data-nb-variable-row="' + name + '"] [data-nb-variable-current]').textContent();
    assert('initial and current values are separate after execution', await initialInput.inputValue() === '2' && await currentText('distance') === '2' && await currentText('doubled') === '4');
    await initialInput.fill('4');
    await initialInput.press('Tab');
    assert('editing an initial value does not change current values', await currentText('distance') === '2' && await currentText('doubled') === '4');
    const parameterId = await parameterCell.getAttribute('data-nb-cell');
    const beforeAffectedCount = Number((await parameterCell.locator('[data-nb-execution-count]').innerText()).replace(/\D/g, '')) || 0;
    await page.locator('[data-nb-run-affected]').click();
    await page.waitForFunction(({ id, before }) => Number(document.querySelector('[data-nb-cell="' + id + '"] [data-nb-execution-count]')?.textContent?.replace(/\D/g, '')) > before, { id: parameterId, before: beforeAffectedCount });
    assert('Run affected does not auto-initialize initial values', await currentText('distance') === '2' && await currentText('doubled') === '4');
    await page.locator('[data-nb-variable-initialize]').click();
    assert('Initialize copies initial values without running cells', await currentText('distance') === '4' && await initialInput.inputValue() === '4');
    await page.locator('[data-nb-run-affected]').click();
    await page.waitForFunction(() => document.querySelector('[data-nb-variable-row="doubled"] [data-nb-variable-current]')?.textContent === '8');
    assert('Run affected recomputes dependencies after initialization', true);
    const variableFile = page.locator('[data-nb-variable-file]');
    const variableChooser = page.waitForEvent('filechooser');
    await page.locator('[data-nb-variable-import]').click();
    await (await variableChooser).setFiles({ name: 'places.json', mimeType: 'application/json', buffer: Buffer.from('{"place":"Yangjiang","days":3}') });
    await page.waitForFunction(() => document.querySelector('[data-nb-variable-row="place"] [data-nb-variable-value]')?.value === '"Yangjiang"');
    assert('JSON variables import through the panel', await page.locator('[data-nb-variable-row="days"] [data-nb-variable-value]').inputValue() === '3');
    await variableFile.setInputFiles({ name: 'travel.csv', mimeType: 'text/csv', buffer: Buffer.from('name,value\nscenic,true\ncost,680.5') });
    await page.waitForFunction(() => document.querySelector('[data-nb-variable-row="scenic"] [data-nb-variable-value]')?.value === 'true');
    assert('CSV variables import through the panel', await page.locator('[data-nb-variable-row="cost"] [data-nb-variable-value]').inputValue() === '680.5');
    const variablesDownload = page.waitForEvent('download');
    await page.locator('[data-nb-variable-export]').click();
    assert('variables export downloads JSON', (await variablesDownload).suggestedFilename().endsWith('-variables.json'));
    await page.locator('.file-tree-node', { hasText: 'switch.hnb.md' }).first().click();
    await page.locator('.nb-markdown-body').first().waitFor();
    await page.locator('.nb-markdown-body').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' CROSS-DOC-AUTOSAVE');
    await page.locator('.file-tree-node', { hasText: 'interaction.hnb.md' }).first().click();
    await page.waitForSelector('.nb-code');
    await page.waitForTimeout(1800);
    const switchSaved = await readFile(path.join(workspace, 'switch.hnb.md'), 'utf8');
    const interactionSaved = await readFile(path.join(workspace, 'interaction.hnb.md'), 'utf8');
    assert('switching documents flushes the old notebook file', switchSaved.includes('CROSS-DOC-AUTOSAVE'), switchSaved.slice(0, 200));
    assert('switching documents does not write into the new notebook file', !interactionSaved.includes('CROSS-DOC-AUTOSAVE'), interactionSaved.slice(0, 200));
    await page.locator('.nb-markdown-body .hc-math').click();
    await page.locator('.nb-formula-popover textarea').fill('distance * 2');
    await page.locator('[data-nb-formula-symbol="distance"]').click();
    assert('formula variable opens its panel row', await page.locator('[data-nb-variable-expand]').getAttribute('aria-expanded') === 'true' && await page.locator('[data-nb-variable-row="distance"] [data-nb-variable-value]').inputValue() === '4');
    await page.locator('[data-formula-cancel]').click();
    await initialInput.fill('6');
    await initialInput.press('Tab');
    assert('Run all has not initialized before it is clicked', await currentText('distance') === '4');
    await page.locator('[data-nb-variable-expand]').click();
    await page.locator('[data-nb-runall]').click();
    await page.waitForFunction(() => !document.querySelector('[data-nb-runall]')?.disabled, undefined, { timeout: 60000 });
    await page.locator('[data-nb-variable-expand]').click();
    assert('Run all initializes before executing cells', await currentText('distance') === '6' && await currentText('doubled') === '12');
    await page.locator('[data-nb-variable-expand]').click();

    await page.locator('[data-nb-add-code]').click();
    const tableCell = page.locator('.nb-code').last();
    await tableCell.locator('.cm-content').fill('hc_display({"application/json": [{"name": "A", "value": 1}, {"name": "B", "value": 2}]})');
    await tableCell.locator('.cm-content').press('Control+Enter');
    await tableCell.locator('.hc-data-table').waitFor();
    assert('JSON array renders native table', await tableCell.locator('.hc-data-table tbody tr').count() === 2);
    const csvDownload = page.waitForEvent('download');
    await tableCell.locator('[data-hc-table-download]').click();
    const csv = await csvDownload;
    assert('table downloads CSV', csv.suggestedFilename().endsWith('.csv'));

    await page.locator('[data-nb-add-code]').click();
    const completionCell = page.locator('.nb-code').last();
    await completionCell.locator('.cm-content').fill('pri');
    await completionCell.locator('.cm-content').press('Control+Space');
    await page.waitForSelector('.cm-tooltip-autocomplete');
    assert('kernel completion appears in editor', (await page.locator('.cm-tooltip-autocomplete').innerText()).includes('print'));
    await page.keyboard.press('Escape');
    await completionCell.locator('.cm-content').fill('print');
    await completionCell.locator('.cm-line').hover({ position: { x: 55, y: 10 } });
    await page.locator('.cm-notebook-doc').waitFor();
    assert('kernel documentation appears on hover', (await page.locator('.cm-notebook-doc').innerText()).includes('print'));
    await page.keyboard.press('Escape');

    await page.locator('[data-nb-add-code]').click();
    const stoppedCell = page.locator('.nb-code').last();
    await stoppedCell.locator('.cm-content').fill('import time\ntime.sleep(30)\nprint("should not finish")');
    await stoppedCell.locator('.cm-content').press('Control+Enter');
    await stoppedCell.locator('[data-nb-cell-status][data-tone="running"]').waitFor();
    await page.locator('[data-nb-tasks]').click();
    await page.locator('[data-nb-task-stop]').first().click();
    await stoppedCell.locator('[data-nb-cell-status]').filter({ hasText: /cancelled|aborted/iu }).waitFor();
    assert('execution center stops a real kernel task', true);
    await page.locator('[data-nb-clear-tasks]').click();
    assert('completed tasks can be cleared', await page.locator('[data-nb-task-id]').count() === 0);
    await page.locator('[data-nb-tasks]').click();

    await page.locator('[data-nb-add-code]').click();
    const backgroundCell = page.locator('.nb-code').last();
    await backgroundCell.locator('.cm-content').fill('import time\ntime.sleep(1)\nprint("background")');
    await backgroundCell.locator('.cm-content').press('Control+Enter');
    await page.locator('.workspace-tab.view-tab.active .tab-close').click();
    await page.waitForTimeout(1700);
    await page.locator('.file-tree-node', { hasText: 'interaction.hnb.md' }).first().click();
    await page.waitForFunction(
      () => [...document.querySelectorAll('.nb-output')].some(element => element.textContent?.includes('background')),
    );
    assert('background task replays after reopening', true);

    await page.locator('.file-tree-node', { hasText: 'layout.hnb.md' }).first().click();
    await page.locator('.nb-title strong', { hasText: 'layout.hnb.md' }).waitFor();
    const layoutCode = page.locator('.nb-code');
    const layoutView = page.locator('[data-nb-markdown-view]');
    await layoutView.click();
    await page.keyboard.press('Escape');
    assert('selected Markdown has no visible cell chrome in continuous document mode', await page.locator('.nb-markdown').evaluate(element => getComputedStyle(element).outlineStyle === 'none' && getComputedStyle(element.querySelector('.nb-markdown-rail')).display === 'none' && getComputedStyle(element.querySelector('.nb-markdown-hover-actions')).display === 'none'));
    const layoutCodeId = await layoutCode.getAttribute('data-nb-cell');
    const originalLayoutSource = await page.locator('.nb-markdown').getAttribute('data-nb-rendered-source');
    await page.locator('.nb-code-input').evaluate(element => { element.dataset.layoutKeep = 'preserved'; });
    await layoutCode.locator('[data-nb-drag]').dragTo(layoutView.locator('p').nth(1), { targetPosition: { x: 40, y: 1 } });
    await page.waitForFunction(() => document.querySelectorAll('.nb-markdown').length === 2);
    const layoutOrder = await page.locator('.nb-cell').evaluateAll(cells => cells.map(cell => cell.dataset.nbCell));
    assert('code drop splits Markdown at a paragraph boundary', layoutOrder.length === 3 && layoutOrder[1] === layoutCodeId, JSON.stringify(layoutOrder));
    const splitMarkdownText = await page.locator('.nb-markdown-body').allInnerTexts();
    assert('Markdown halves retain their paragraph content', splitMarkdownText[0].includes('First bold paragraph') && !splitMarkdownText[0].includes('Second paragraph') && splitMarkdownText[1].includes('Second paragraph') && splitMarkdownText[1].includes('Third paragraph'), JSON.stringify(splitMarkdownText));
    assert('code identity and editor instance survive Markdown splitting', await layoutCode.getAttribute('data-nb-cell') === layoutCodeId && await page.locator('.nb-code-input').evaluate(element => element.dataset.layoutKeep) === 'preserved');
    assert('code uses continuous document styling instead of a card', await layoutCode.evaluate(element => getComputedStyle(element).borderTopWidth === '0px' && getComputedStyle(element).outlineStyle === 'none' && !element.querySelector('.nb-cell-rail')));
    await page.waitForTimeout(1000);
    const savedLayout = (await api('/api/files/read?root=root_default&path=layout.hnb.md')).body.file?.content || '';
    assert('split layout persists code between Markdown paragraphs', savedLayout.indexOf('First **bold** paragraph.') < savedLayout.indexOf('```python') && savedLayout.indexOf('```python') < savedLayout.indexOf('Second paragraph.'), savedLayout);
    await page.keyboard.press('Control+ArrowDown');
    await page.waitForFunction(() => document.querySelectorAll('.nb-markdown').length === 1);
    const mergedMarkdownText = await page.locator('[data-nb-markdown-view]').innerText();
    assert('moving code away merges adjacent Markdown into one segment', await page.locator('.nb-code').count() === 1 && mergedMarkdownText.includes('First bold paragraph') && mergedMarkdownText.includes('Second paragraph') && mergedMarkdownText.includes('Third paragraph'));
    const mergedSelection = await page.locator('[data-nb-markdown-view]').evaluate(view => {
      const range = document.createRange();
      range.selectNodeContents(view);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() || '';
    });
    assert('one native selection spans all formerly separated Markdown', mergedSelection.includes('First bold paragraph') && mergedSelection.includes('Second paragraph') && mergedSelection.includes('Third paragraph'));
    await page.keyboard.press('Escape');
    await page.keyboard.press('z');
    await page.waitForFunction(() => document.querySelectorAll('.nb-markdown').length === 2);
    assert('one undo restores the split around the moved code', await page.locator('.nb-code').getAttribute('data-nb-cell') === layoutCodeId);
    await page.keyboard.press('Escape');
    await page.keyboard.press('z');
    await page.waitForFunction(() => document.querySelectorAll('.nb-markdown').length === 1);
    assert('a second undo restores the original Markdown and code order', await page.locator('.nb-markdown').getAttribute('data-nb-rendered-source') === originalLayoutSource && await page.locator('.nb-code-input').evaluate(element => element.dataset.layoutKeep) === 'preserved');

    await layoutView.evaluate(view => { const paragraph = document.createElement('p'); paragraph.appendChild(document.createElement('br')); view.appendChild(paragraph); view.dispatchEvent(new Event('input', { bubbles: true })); });
    await layoutView.locator('p').last().hover();
    await page.locator('.nb-block-insert-plus').click();
    await page.locator('[data-insert-kernel="python"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.nb-code').length === 2);
    const insertedCode = page.locator('.nb-code.nb-cell-active');
    await insertedCode.locator('.cm-content').fill('print("plus")');
    await insertedCode.locator('.cm-content').press('Control+Enter');
    await insertedCode.locator('.nb-output').filter({ hasText: 'plus' }).waitFor();
    assert('blank-line plus inserts and runs a kernel code block', true);
    await layoutView.evaluate(view => { const paragraph = document.createElement('p'); paragraph.appendChild(document.createElement('br')); view.appendChild(paragraph); view.dispatchEvent(new Event('input', { bubbles: true })); });
    await layoutView.locator('p').last().hover();
    await page.locator('.nb-block-insert-plus').click();
    await page.locator('[data-insert-block="h2"]').click();
    await page.keyboard.type('Inserted heading');
    await layoutView.locator('h2', { hasText: 'Inserted heading' }).waitFor();
    assert('blank-line plus also inserts rich Markdown blocks', true);
    const runtimeBeforeSave = await api('/api/runtime');
    for (const session of runtimeBeforeSave.body.kernels || []) {
      if (session.scope?.key === 'root_default:layout.hnb.md') await api('/api/kernels/' + session.sessionId, { method: 'DELETE' });
    }

    await page.locator('.file-tree-node', { hasText: 'save.hnb.md' }).first().click();
    await page.locator('.nb-title strong', { hasText: 'save.hnb.md' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.nb-code').length === 1);
    assert('Markdown notebook opens for native editing', await page.locator('.nb-code').count() === 1);
    const saveEditor = page.locator('.nb-code-input .cm-content').first();
    await saveEditor.press('Control+A');
    await saveEditor.pressSequentially('x = 2\nprint(x)');
    await saveEditor.press('Control+Enter');
    await page.waitForFunction(() => document.querySelector('.nb-output')?.textContent?.includes('2')).catch(async () => {
      throw new Error('Save notebook execution failed: source=' + await saveEditor.innerText() + ' status=' + await page.locator('[data-nb-cell-status]').allInnerTexts() + ' output=' + await page.locator('.nb-output').allInnerTexts() + ' toasts=' + await page.locator('#toastRoot').innerText());
    });
    await page.waitForTimeout(900);
    const savedMarkdown = (await api('/api/files/read?root=root_default&path=save.hnb.md')).body.file?.content || '';
    assert('Markdown notebook saves edited source', savedMarkdown.includes('x = 2\nprint(x)'), savedMarkdown);
    await page.locator('[data-nb-clear]').first().click({ force: true });
    await page.waitForFunction(() => document.querySelector('.nb-output .nb-output-content') === null);
    await page.locator('.nb-code').first().locator('[data-nb-toggle-code]').click();
    await page.locator('.nb-code').first().locator('[data-nb-toggle-code]').click();
    assert('clear output stays cleared across structural re-render', await page.locator('.nb-output .nb-output-content').count() === 0);
    const beforeRestart = Number((await page.locator('[data-nb-execution-count]').first().innerText()).replace(/\D/g, '')) || 0;
    await page.locator('[data-nb-run-scope]').selectOption('restart');
    await page.waitForFunction(count => document.querySelector('[data-nb-execution-count]')?.textContent === '[' + (count + 1) + ']', beforeRestart);
    assert('Restart and Run All executes the Markdown notebook', true);
    await page.locator('[data-nb-add-code]').click();
    const undoCell = page.locator('.nb-code').last();
    await undoCell.locator('.cm-content').fill('undo_marker = 1');
    await page.keyboard.press('Escape');
    await page.keyboard.press('z');
    assert('undo restores the live CodeMirror source', (await undoCell.locator('.cm-content').innerText()).trim() === '', await undoCell.locator('.cm-content').innerText());
    await undoCell.locator('.cm-content').fill('print("after undo")');
    await undoCell.locator('.cm-content').press('Control+Enter');
    await undoCell.locator('.nb-output').filter({ hasText: 'after undo' }).waitFor();
    assert('editing/running after undo targets the current cell object', true);
    await page.locator('[data-nb-add-code]').click();
    const imageCell = page.locator('.nb-code').last();
    await imageCell.locator('.cm-content').fill('import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()');
    await imageCell.locator('.cm-content').press('Control+Enter');
    await imageCell.locator('.nb-output img.exec-out-image').waitFor();
    const htmlDownload = page.waitForEvent('download');
    await page.locator('[data-nb-export]').click();
    const exportedHtmlFile = await htmlDownload;
    assert('standalone HTML export downloads', exportedHtmlFile.suggestedFilename().endsWith('.html'));
    const exportedHtmlPath = await exportedHtmlFile.path();
    if (!exportedHtmlPath) throw new Error('HTML export did not produce a file');
    const exportedHtml = await readFile(exportedHtmlPath, 'utf8');
    assert('HTML export embeds kernel image assets', exportedHtml.includes('data:image/png;base64,'));
    const offlineContext = await browser.newContext({ offline: true, viewport: { width: 1100, height: 900 } });
    const offlinePage = await offlineContext.newPage();
    await offlinePage.goto('data:text/html;charset=utf-8,' + encodeURIComponent(exportedHtml), { waitUntil: 'load' });
    await offlineContext.setOffline(true);
    await offlinePage.reload({ waitUntil: 'load' });
    await offlinePage.waitForTimeout(500);
    const offlineImage = offlinePage.locator('img').first();
    await offlineImage.scrollIntoViewIfNeeded();
    await offlinePage.waitForFunction(() => { const image = document.querySelector('img'); return Boolean(image && image.complete && image.naturalWidth > 0); }, undefined, { timeout: 5000 }).catch(() => undefined);
    const offlineImageState = await offlineImage.evaluate(image => ({ src: image.getAttribute('src') || '', complete: image.complete, width: image.naturalWidth }));
    assert('offline HTML export renders the inlined image without Hcanvas', offlineImageState.src.startsWith('data:image/') && offlineImageState.complete && offlineImageState.width > 0, JSON.stringify(offlineImageState));
    await offlineContext.close();
    assert('ipynb export control is not offered', await page.locator('[data-nb-export-ipynb]').count() === 0);
    await page.locator('.file-tree-node', { hasText: 'legacy.ipynb' }).first().click();
    await page.locator('.file-surface-title strong', { hasText: 'legacy.ipynb' }).waitFor();
    assert('ipynb does not open in the Notebook viewer', await page.locator('.notebook-view, .nb-code').count() === 0);
    assert('no browser errors', errors.length === 0, errors.join('; '));
    console.log('Notebook interaction E2E passed');
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
