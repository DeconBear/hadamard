import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { GUI_RESEARCH_CLIENT_SCRIPT } from '../src/gui/guiResearchClientScript.js';

class Element {
  textContent = '';
  children: Element[] = [];
  style = { cssText: '' };
  disabled = false;
  id = '';
  value = '';
  listeners: Record<string, (...args: unknown[]) => unknown> = {};
  constructor(readonly tag: string) {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  setAttribute() {}
  addEventListener(name: string, fn: (...args: unknown[]) => unknown) { this.listeners[name] = fn; }
  querySelectorAll(selector: string) { return this.children.filter(node => node.tag === selector); }
  querySelector(selector: string) { return this.children.find(node => node.tag === selector); }
}
function fixture() {
  const elements = new Map<string, Element>();
  for (const id of ['projectResearchPanel', 'researchStatus', 'researchRecords']) elements.set(id, new Element('div'));
  const state = { activeRegion: 'project', projectView: 'detail', projectDetailTab: 'research', snapshot: { workDir: '/project' } };
  const api = vi.fn(async () => ({ ok: true, json: async () => ({ manifests: [], runs: [] }) }));
  const context = vm.createContext({
    state, api, el: (id: string) => elements.get(id), document: { createElement: (tag: string) => new Element(tag) },
    setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), confirm: () => true, crypto: { randomUUID: () => 'request' },
  });
  vm.runInContext(GUI_RESEARCH_CLIENT_SCRIPT, context);
  return { context, state, api, elements };
}

describe('research panel lifecycle', () => {
  it('suppresses duplicate execution while a mutation is pending', async () => {
    const { context, api } = fixture();
    let resolve!: (value: unknown) => void;
    api.mockImplementationOnce(() => new Promise(r => { resolve = r; }) as any);
    const first = vm.runInContext("researchMutate({action:'start'}, '/project')", context);
    await vm.runInContext("researchMutate({action:'start'}, '/project')", context);
    expect(api).toHaveBeenCalledTimes(1);
    resolve({ ok: true, json: async () => ({ run: { id: 'run' } }) });
    await first;
  });
  it('ignores an in-flight response after navigating to another workspace', async () => {
    const { context, state, api, elements } = fixture();
    let resolve!: (value: unknown) => void;
    api.mockImplementationOnce(() => new Promise(r => { resolve = r; }) as any);
    const pending = vm.runInContext('refreshResearchPanel()', context);
    state.snapshot.workDir = '/other';
    resolve({ ok: true, json: async () => ({ manifests: [{ id: 'old', title: 'Old data' }], runs: [] }) });
    await pending;
    expect(elements.get('researchRecords')?.children).toHaveLength(0);
    expect(context.setTimeout).not.toHaveBeenCalled();
  });
  it('stops polling outside the research tab and resumes from canonical records', async () => {
    const { context, state, api } = fixture();
    state.projectDetailTab = 'document';
    await vm.runInContext('refreshResearchPanel()', context);
    expect(api).not.toHaveBeenCalled();
    state.projectDetailTab = 'research';
    await vm.runInContext('refreshResearchPanel()', context);
    expect(api).toHaveBeenCalledWith('/api/research?workspace=%2Fproject');
    expect(context.setTimeout).toHaveBeenCalledTimes(1);
  });
  it('renders untrusted labels and logs as text, never artifact markup', () => {
    const { context } = fixture();
    const element = vm.runInContext('researchText("pre", "<script>alert(1)</script>")', context);
    expect(element.textContent).toBe('<script>alert(1)</script>');
    expect(GUI_RESEARCH_CLIENT_SCRIPT).not.toContain('innerHTML');
    expect(GUI_RESEARCH_CLIENT_SCRIPT).not.toContain('srcdoc');
  });
  it('provides an offline example with pinned criteria and bounded execution', () => {
    const { context } = fixture();
    const manifest = vm.runInContext('researchExampleManifest()', context);
    expect(manifest.budget.timeoutMs).toBe(10000);
    expect(manifest.acceptanceCriteria).toHaveLength(2);
    expect(manifest.code).toContain('RESEARCH_PARAMETERS');
    expect(manifest.code).not.toContain('http');
  });
});
