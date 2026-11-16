import type { HcBlock, HcPage } from '../types.js';
import { execData, renderStoredOutputsHtml, truncateText, type HcStoredOutput } from '../execOutputs.js';
import type { KernelDescriptor, KernelExecutionHandle, KernelManager, KernelOutputEvent } from './kernelManager.js';
import { esc } from './utils.js';

export interface ExecCellDeps {
  kernelManager: KernelManager;
  getKernels(): KernelDescriptor[];
  getDocId(): string;
  patchData(pageId: string, blockId: string, data: Record<string, unknown>): Promise<boolean>;
  openEditor(pageId: string, blockId: string): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

interface CellState {
  status: 'idle' | 'queued' | 'running' | 'ok' | 'error' | 'aborted';
  outputs: KernelOutputEvent[];
  handle: KernelExecutionHandle | null;
  outputHost: HTMLElement | null;
}

interface StoredMimePick {
  output: HcStoredOutput | null;
  bytes: number;
}

let deps: ExecCellDeps | null = null;
const states = new Map<string, CellState>();

export function installExecCells(next: ExecCellDeps): void {
  deps = next;
}

function stateOf(block: HcBlock): CellState {
  let state = states.get(block.id);
  if (!state) {
    state = { status: 'idle', outputs: [], handle: null, outputHost: null };
    states.set(block.id, state);
  }
  return state;
}

function kernelIdOf(block: HcBlock): string {
  const execution = execData(block.data).execution;
  return execution && typeof execution.kernelId === 'string' ? execution.kernelId : '';
}

function chooseKernel(block: HcBlock): KernelDescriptor | null {
  const kernels = deps?.getKernels() || [];
  const explicit = kernelIdOf(block);
  if (explicit) return kernels.find(kernel => kernel.id === explicit) || { id: explicit, label: explicit, language: 'unknown' };
  const python = kernels.find(kernel => kernel.language === 'python') || kernels.find(kernel => (kernel.defaultFor || []).includes('python'));
  return python || kernels[0] || null;
}

function outputFallbackHtml(): string {
  return renderStoredOutputsHtml([]);
}

function statusLabel(status: CellState['status']): string {
  if (status === 'running') return 'running';
  if (status === 'queued') return 'queued';
  if (status === 'ok') return 'ok';
  if (status === 'error') return 'error';
  if (status === 'aborted') return 'aborted';
  return 'idle';
}

function mimeOutput(mime: string, value: unknown): HcStoredOutput | null {
  if (typeof value !== 'string') {
    if (mime === 'application/json' && value !== undefined) {
      return { id: '', kind: 'json', value };
    }
    return null;
  }
  const id = '';
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/svg+xml') {
    if (value.length > 2 * 1024 * 1024) return null;
    const dataUrl = mime === 'image/svg+xml'
      ? 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(value)))
      : 'data:' + mime + ';base64,' + value;
    return { id, kind: 'image', mime: mime as 'image/png' | 'image/jpeg' | 'image/svg+xml', url: dataUrl };
  }
  if (mime === 'text/html') return { id, kind: 'html', html: truncateText(value, 256 * 1024) };
  if (mime === 'text/markdown') return { id, kind: 'markdown', text: truncateText(value) };
  if (mime === 'text/plain') return { id, kind: 'text', text: truncateText(value) };
  if (mime === 'application/json') return { id, kind: 'json', value };
  return null;
}

function pickMime(data: Record<string, unknown>): HcStoredOutput | null {
  const order = ['image/png', 'image/svg+xml', 'image/jpeg', 'text/html', 'application/json', 'text/markdown', 'text/plain'];
  for (const mime of order) {
    if (!(mime in data)) continue;
    const output = mimeOutput(mime, data[mime]);
    if (output) return output;
  }
  return null;
}

function storedOutputsFromEvents(events: KernelOutputEvent[]): HcStoredOutput[] {
  const result: HcStoredOutput[] = [];
  let total = 0;
  let images = 0;
  let dropped = false;
  const push = (output: HcStoredOutput | null, bytes = 0): void => {
    if (!output) return;
    if (total + bytes > 1024 * 1024) { dropped = true; return; }
    total += bytes;
    result.push({ ...output, id: 'out_' + result.length + '_' + Math.random().toString(36).slice(2, 7) });
  };
  for (const event of events) {
    if (event.kind === 'stream') {
      const text = truncateText(event.text);
      push({ id: '', kind: 'stream', name: event.stream, text }, text.length);
      continue;
    }
    if (event.kind === 'error') {
      push({ id: '', kind: 'error', ename: event.ename, evalue: event.evalue, traceback: event.traceback.slice(0, 80) }, event.traceback.join('\n').length);
      continue;
    }
    const output = pickMime(event.data);
    if (!output) continue;
    if (output.kind === 'image') {
      if (images >= 10) { dropped = true; continue; }
      images += 1;
      push(output, output.url.length);
    } else if (output.kind === 'html') push(output, output.html.length);
    else if (output.kind === 'json') push(output, JSON.stringify(output.value).length);
    else if ('text' in output) push(output, output.text.length);
    else push(output, 0);
  }
  if (dropped) push({ id: '', kind: 'notice', text: 'Output limit reached; older items were truncated.' }, 0);
  return result;
}

function renderRuntimeOutput(host: HTMLElement, event: KernelOutputEvent): void {
  if (event.kind === 'stream') {
    const last = host.lastElementChild as HTMLElement | null;
    if (last && last.classList.contains('exec-out-stream') && last.dataset.stream === event.stream) {
      last.textContent = (last.textContent || '') + event.text;
      return;
    }
    const pre = document.createElement('pre');
    pre.className = 'exec-out-stream' + (event.stream === 'stderr' ? ' stderr' : '');
    pre.dataset.stream = event.stream;
    pre.textContent = event.text;
    host.appendChild(pre);
    host.scrollTop = host.scrollHeight;
    return;
  }
  if (event.kind === 'error') {
    const box = document.createElement('div');
    box.className = 'exec-out-error';
    const title = document.createElement('strong');
    title.textContent = event.ename + ': ' + event.evalue;
    const trace = document.createElement('pre');
    trace.textContent = event.traceback.join('\n');
    box.append(title, trace);
    host.appendChild(box);
    return;
  }
  const output = pickMime(event.data);
  if (!output) return;
  host.insertAdjacentHTML('beforeend', renderStoredOutputsHtml([output]));
  host.scrollTop = host.scrollHeight;
}

function renderStored(host: HTMLElement, block: HcBlock): void {
  const state = states.get(block.id);
  if (state && state.outputs.length) {
    host.innerHTML = '';
    for (const event of state.outputs) renderRuntimeOutput(host, event);
    return;
  }
  const stored = execData(block.data).outputs;
  host.innerHTML = renderStoredOutputsHtml(stored);
}

function readCode(block: HcBlock): string {
  return block.code || '';
}

export function mountExecCell(host: HTMLElement, block: HcBlock, page: HcPage): void {
  if (!deps) return;
  const state = stateOf(block);
  const kernels = deps.getKernels();
  const chosen = chooseKernel(block);
  host.className = 'exec-cell';
  host.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'exec-head';
  const select = document.createElement('select');
  select.className = 'exec-kernel';
  select.title = 'Kernel';
  if (!kernels.length) {
    const option = document.createElement('option');
    option.textContent = 'No kernel installed';
    option.value = '';
    select.appendChild(option);
  } else {
    for (const kernel of kernels) {
      const option = document.createElement('option');
      option.value = kernel.id;
      option.textContent = kernel.label || kernel.id;
      if (chosen && kernel.id === chosen.id) option.selected = true;
      select.appendChild(option);
    }
  }
  const status = document.createElement('span');
  status.className = 'exec-status status-' + state.status;
  status.textContent = statusLabel(state.status);
  const actions = document.createElement('div');
  actions.className = 'exec-actions';
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'btn tiny primary';
  run.textContent = 'Run';
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'btn tiny';
  stop.textContent = 'Stop';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn tiny';
  clear.textContent = 'Clear';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn tiny';
  edit.textContent = 'Edit';
  actions.append(run, stop, clear, edit);
  head.append(select, status, actions);

  const code = document.createElement('pre');
  code.className = 'exec-code';
  code.textContent = readCode(block) || 'Double-click to write code';
  const outputHost = document.createElement('div');
  outputHost.className = 'exec-outputs';
  state.outputHost = outputHost;
  renderStored(outputHost, block);
  host.append(head, code, outputHost);

  for (const node of [head, select, actions, outputHost, code] as HTMLElement[]) {
    node.addEventListener('pointerdown', event => event.stopPropagation());
    node.addEventListener('click', event => event.stopPropagation());
  }
  code.addEventListener('dblclick', event => { event.stopPropagation(); deps?.openEditor(page.id, block.id); });
  edit.addEventListener('click', () => deps?.openEditor(page.id, block.id));
  run.addEventListener('click', () => { void runExecBlock(block, page); });
  stop.addEventListener('click', () => { void stopExecBlock(block); });
  clear.addEventListener('click', () => { void clearExecBlock(block, page); });
  select.addEventListener('change', () => {
    const kernelId = select.value;
    if (!kernelId) return;
    void deps?.patchData(page.id, block.id, { ...(block.data || {}), execution: { ...(execData(block.data).execution || {}), kernelId } });
  });
}

export async function runExecBlock(block: HcBlock, page: HcPage): Promise<void> {
  if (!deps) return;
  const state = stateOf(block);
  if (state.status === 'running' || state.status === 'queued') return;
  const kernel = chooseKernel(block);
  if (!kernel) {
    deps.toast('Install a kernel extension (for example Python Kernel) before running code cells.', 'info');
    return;
  }
  const scope = { kind: 'document' as const, key: deps.getDocId() };
  if (kernelIdOf(block) !== kernel.id) {
    await deps.patchData(page.id, block.id, { ...(block.data || {}), execution: { ...(execData(block.data).execution || {}), kernelId: kernel.id } });
  }
  state.status = 'queued';
  state.outputs = [];
  state.handle = null;
  refreshStatus(block);
  if (state.outputHost) state.outputHost.innerHTML = '';
  try {
    const handle = await deps.kernelManager.execute(kernel.id, readCode(block), { scope, cellId: block.id });
    state.handle = handle;
    state.status = 'running';
    refreshStatus(block);
    handle.onOutput(event => {
      state.outputs.push(event);
      if (state.outputHost) renderRuntimeOutput(state.outputHost, event);
    });
    const result = await handle.done;
    state.handle = null;
    state.status = result.status === 'ok' ? 'ok' : result.status === 'error' ? 'error' : 'aborted';
    const stored = storedOutputsFromEvents(result.outputs);
    await deps.patchData(page.id, block.id, {
      ...(block.data || {}),
      execution: { ...(execData(block.data).execution || {}), kernelId: kernel.id },
      outputs: stored,
      lastRun: { status: result.status, startedAt: new Date().toISOString(), ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}) },
    });
    refreshStatus(block);
    if (state.outputHost) { state.outputHost.innerHTML = ''; for (const event of result.outputs) renderRuntimeOutput(state.outputHost, event); }
    if (result.status === 'error') deps.toast('Code cell failed; see traceback in the block.', 'error');
  } catch (error) {
    state.status = 'error';
    state.handle = null;
    refreshStatus(block);
    deps.toast(error instanceof Error ? error.message : String(error), 'error');
  }
}

export async function stopExecBlock(block: HcBlock): Promise<void> {
  const state = states.get(block.id);
  if (!state?.handle) return;
  await state.handle.cancel().catch(() => undefined);
}

export async function clearExecBlock(block: HcBlock, page: HcPage): Promise<void> {
  if (!deps) return;
  const state = stateOf(block);
  state.outputs = [];
  state.status = 'idle';
  if (state.outputHost) state.outputHost.innerHTML = outputFallbackHtml();
  refreshStatus(block);
  await deps.patchData(page.id, block.id, { ...(block.data || {}), outputs: [], lastRun: undefined });
}

export function runAllExecCells(page: HcPage): Promise<void> {
  const blocks = (page.blocks || []).filter(block => block.type === 'exec');
  blocks.sort((left, right) => {
    const leftOrder = Number((execData(left.data).execution as { runOrder?: number } | undefined)?.runOrder ?? 0);
    const rightOrder = Number((execData(right.data).execution as { runOrder?: number } | undefined)?.runOrder ?? 0);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left.y !== right.y) return left.y - right.y;
    return left.x - right.x;
  });
  return blocks.reduce<Promise<void>>((chain, block) => chain.then(() => runExecBlock(block, page)), Promise.resolve());
}

function refreshStatus(block: HcBlock): void {
  const state = states.get(block.id);
  if (!state) return;
  const host = document.querySelector<HTMLElement>('.block-wrap[data-block-id="' + block.id + '"] .exec-status');
  if (!host) return;
  host.textContent = statusLabel(state.status);
  host.className = 'exec-status status-' + state.status;
}
