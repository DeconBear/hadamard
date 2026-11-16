import type { HcBlock, HcPage } from '../types.js';
import type { HcPluginAction } from '../pluginManifest.js';
import type { HcBlockPlugin } from '../blockPlugins.js';

const BOOTSTRAP = `
let handler = null;
const hcanvas = {
  register(definition) { handler = definition; },
  version: 'hcanvas-sandbox/1',
};
self.hcanvas = hcanvas;
self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type !== 'run') return;
  try {
    const definition = handler;
    const key = message.actionHandler || message.actionId;
    const fn = definition && definition.actions && definition.actions[key];
    if (typeof fn !== 'function') throw new Error('Sandbox has no action handler "' + key + '".');
    const result = await fn({
      action: message.action,
      block: message.block,
      page: message.page,
    });
    self.postMessage({ type: 'result', id: message.id, ok: true, result });
  } catch (error) {
    self.postMessage({ type: 'result', id: message.id, ok: false, error: error && error.message ? error.message : String(error) });
  }
};
`;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class SandboxWorker {
  private readonly worker: Worker;
  private readonly url: string;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;

  constructor(script: string) {
    const blob = new Blob([BOOTSTRAP + '\n' + script], { type: 'text/javascript' });
    this.url = URL.createObjectURL(blob);
    this.worker = new Worker(this.url);
    this.worker.onmessage = event => {
      const message = event.data as { type?: string; id?: number; ok?: boolean; result?: unknown; error?: string };
      if (message.type !== 'result' || typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'Sandbox action failed.'));
    };
    this.worker.onerror = event => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(event.message || 'Sandbox worker failed.'));
      }
      this.pending.clear();
    };
  }

  call(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Sandbox action timed out after ' + timeoutMs + 'ms.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: 'run', id, ...payload });
    });
  }

  dispose(): void {
    this.worker.terminate();
    URL.revokeObjectURL(this.url);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Sandbox disposed.'));
    }
    this.pending.clear();
  }
}

const runtimes = new Map<string, SandboxWorker>();

export function clearPluginSandboxes(): void {
  for (const runtime of runtimes.values()) runtime.dispose();
  runtimes.clear();
}

function runtimeFor(plugin: HcBlockPlugin): SandboxWorker {
  if (!plugin.script) throw new Error('Plugin has no sandbox script.');
  const key = plugin.pluginId || plugin.type;
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = new SandboxWorker(plugin.script);
    runtimes.set(key, runtime);
  }
  return runtime;
}

function normalizeEffects(raw: unknown): HcPluginAction[] {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { effects?: unknown }).effects) ? (raw as { effects: unknown[] }).effects : [];
  const allowed = new Set(['insert-block', 'set-data', 'apply-style', 'add-page-preset']);
  const effects: HcPluginAction[] = [];
  for (const candidate of source.slice(0, 20)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as Record<string, unknown>;
    const kind = item.kind;
    if (typeof kind !== 'string' || !allowed.has(kind)) continue;
    const effect: HcPluginAction = {
      id: typeof item.id === 'string' ? item.id : 'sandbox-effect-' + effects.length,
      label: typeof item.label === 'string' ? item.label : 'Sandbox effect',
      kind: kind as HcPluginAction['kind'],
    };
    if (typeof item.blockType === 'string' && /^[a-z][a-z0-9-]*$/.test(item.blockType)) effect.blockType = item.blockType;
    if (item.data && typeof item.data === 'object' && !Array.isArray(item.data)) effect.data = item.data as Record<string, unknown>;
    if (item.style && typeof item.style === 'object' && !Array.isArray(item.style)) effect.style = item.style as Record<string, unknown>;
    if (typeof item.text === 'string') effect.text = item.text.slice(0, 5000);
    if (typeof item.presetId === 'string') effect.presetId = item.presetId;
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      if (typeof item[key] === 'number' && Number.isFinite(item[key])) effect[key] = item[key] as number;
    }
    effects.push(effect);
  }
  return effects;
}

export async function runSandboxAction(plugin: HcBlockPlugin, action: HcPluginAction, block: HcBlock, page: HcPage, timeoutMs = 5000): Promise<HcPluginAction[]> {
  const runtime = runtimeFor(plugin);
  const raw = await runtime.call({
    actionId: action.id,
    actionHandler: action.handler || action.id,
    action,
    block: { id: block.id, type: block.type, data: block.data || {}, style: block.style || {}, text: block.text || '' },
    page: { id: page.id, name: page.name, mode: page.mode, width: page.width, height: page.height },
  }, timeoutMs);
  return normalizeEffects(raw);
}
