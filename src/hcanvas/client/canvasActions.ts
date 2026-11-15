import type { HcDocument, HcOp, HcBlock, HcPage } from '../types.js';
import { distributeBlocks, frameChildLayout, layoutBlocks, layoutIssues } from '../canvasLayout.js';
import { CANVAS_THEMES, themeOps } from '../canvasTheme.js';
import { insertCanvasComponent, listCanvasComponents, saveCanvasComponent } from '../canvasComponents.js';

export interface CanvasActionContext {
  getPage(): HcPage | null;
  getSelectedBlocks(): HcBlock[];
  getActiveBlock(): HcBlock | null;
  getDocument(): HcDocument | null;
  applyOps(ops: HcOp[], options?: { refreshArtboard?: boolean; historyBase?: HcDocument }): Promise<unknown>;
  cloneDocument(): HcDocument | null;
  artboard(): HTMLElement;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  newId(prefix: string): string;
  select(ids: string[], primary?: string | null): void;
  prompt(message: string, defaultValue?: string): string | null;
}

export async function runCanvasAction(action: string, context: CanvasActionContext): Promise<void> {
  const page = context.getPage();
  if (!page) return;
  const selected = context.getSelectedBlocks().filter(block => !block.locked);
  if (action.startsWith('theme-')) {
    const theme = CANVAS_THEMES.find(item => item.id === action.slice('theme-'.length));
    if (!theme) return;
    const blocks = selected.length ? selected : (page.blocks || []).filter(block => !block.locked);
    if (!blocks.length) { context.toast('No blocks to theme.', 'info'); return; }
    await context.applyOps(themeOps(page, blocks, theme), { refreshArtboard: true, historyBase: context.cloneDocument() || undefined });
    context.toast('Applied ' + theme.name + ' theme', 'success');
    return;
  }
  if (action === 'component-refresh') {
    const components = listCanvasComponents();
    if (!components.length) { context.toast('No saved components yet.', 'info'); return; }
    const name = context.prompt('Component instances to refresh:\n' + components.map(item => '- ' + item.name).join('\n'));
    const component = components.find(item => item.name === name || item.id === name);
    if (!component) { context.toast('Component not found.', 'error'); return; }
    const groups = new Map<string, HcBlock[]>();
    for (const block of page.blocks || []) {
      const metadata = block.data || {};
      if (metadata.componentId !== component.id) continue;
      const instanceId = String(metadata.componentInstanceId || 'default');
      if (!groups.has(instanceId)) groups.set(instanceId, []);
      groups.get(instanceId)!.push(block);
    }
    const ops: HcOp[] = [];
    for (const blocks of groups.values()) {
      component.blocks.forEach((master, index) => {
        const target = blocks[index];
        if (!target) return;
        ops.push({ op: 'update_block', pageId: page.id, blockId: target.id, patch: { text: master.text, style: master.style, data: { ...(target.data || {}), ...(master.data || {}) } } });
      });
    }
    if (!ops.length) { context.toast('No component instances found on this page.', 'info'); return; }
    await context.applyOps(ops, { refreshArtboard: true, historyBase: context.cloneDocument() || undefined });
    context.toast('Refreshed ' + groups.size + ' component instance' + (groups.size === 1 ? '' : 's'), 'success');
    return;
  }
  if (action === 'check-layout') {
    const issues = layoutIssues((page.blocks || []).filter(block => !block.locked), page.width, page.height, page.mode);
    context.toast(issues.length ? issues.length + ' layout issue' + (issues.length === 1 ? '' : 's') + ' found — see hover states or lint output.' : 'Layout looks clean.', issues.length ? 'info' : 'success');
    return;
  }
  if (action === 'component-save') {
    if (!selected.length) { context.toast('Select at least one block to save as a component.', 'info'); return; }
    const name = context.prompt('Component name', selected[0]?.name || 'Component');
    if (!name) return;
    saveCanvasComponent(name, selected);
    context.toast('Saved component "' + name + '"', 'success');
    return;
  }
  if (action === 'component-insert') {
    const components = listCanvasComponents();
    if (!components.length) { context.toast('No saved components yet.', 'info'); return; }
    const name = context.prompt('Component to insert:\n' + components.map(item => '- ' + item.name).join('\n'));
    const component = components.find(item => item.name === name || item.id === name);
    if (!component) { context.toast('Component not found.', 'error'); return; }
    const blocks = insertCanvasComponent(component, context.newId, 24);
    const instanceId = context.newId('instance');
    for (const block of blocks) block.data = { ...(block.data || {}), componentId: component.id, componentInstanceId: instanceId };
    await context.applyOps(blocks.map(block => ({ op: 'add_block', pageId: page.id, block } as HcOp)), { refreshArtboard: true, historyBase: context.cloneDocument() || undefined });
    context.select(blocks.map(block => block.id), blocks[blocks.length - 1]?.id || null);
    context.toast('Inserted component "' + component.name + '"', 'success');
    return;
  }
  if (action.startsWith('frame-')) {
    const frame = context.getActiveBlock()?.shape === 'frame' ? context.getActiveBlock() : selected.find(block => block.shape === 'frame') || null;
    if (!frame) { context.toast('Select a frame to layout its children.', 'info'); return; }
    const children = (page.blocks || []).filter(block => block.frameId === frame.id && !block.locked);
    if (!children.length) { context.toast('This frame has no child blocks.', 'info'); return; }
    const metadata = { mode: action === 'frame-grid2' ? 'grid' as const : 'stack' as const, gap: 16, columns: 2, padding: 18 };
    const patches = frameChildLayout(frame, children, metadata);
    const byChild = new Map(children.map(block => [block.id, block]));
    const ops: HcOp[] = [];
    for (const patch of patches) {
      const child = byChild.get(patch.id);
      if (!child || (child.x === patch.x && child.y === patch.y && child.w === patch.w && child.h === patch.h)) continue;
      ops.push({ op: 'update_block', pageId: page.id, blockId: child.id, patch: { x: patch.x, y: patch.y, w: patch.w, h: patch.h } });
    }
    ops.push({ op: 'update_block', pageId: page.id, blockId: frame.id, patch: { data: { ...(frame.data || {}), layout: metadata } } });
    const artboard = context.artboard();
    artboard.classList.add('block-layout-animating');
    await context.applyOps(ops, { refreshArtboard: true, historyBase: context.cloneDocument() || undefined });
    setTimeout(() => artboard.classList.remove('block-layout-animating'), 260);
    context.toast('Frame layout applied', 'success');
    return;
  }
  if (selected.length < 2) return;
  const minX = Math.min(...selected.map(block => block.x));
  const minY = Math.min(...selected.map(block => block.y));
  const maxX = Math.max(...selected.map(block => block.x + block.w));
  const maxY = Math.max(...selected.map(block => block.y + block.h));
  const area = { x: minX, y: minY, w: Math.max(48, maxX - minX), h: Math.max(48, maxY - minY) };
  const patches = action === 'distribute-h' || action === 'distribute-v'
    ? distributeBlocks(selected, action === 'distribute-h' ? 'horizontal' : 'vertical')
    : layoutBlocks(selected, {
        mode: action === 'stack' ? 'stack' : action === 'row' ? 'row' : 'grid',
        area,
        gap: 24,
        columns: action === 'grid3' ? 3 : 2,
        stretch: false,
      });
  const byId = new Map(selected.map(block => [block.id, block]));
  const ops: HcOp[] = [];
  for (const patch of patches) {
    const block = byId.get(patch.id);
    if (!block || (block.x === patch.x && block.y === patch.y && block.w === patch.w && block.h === patch.h)) continue;
    ops.push({ op: 'update_block', pageId: page.id, blockId: block.id, patch: { x: patch.x, y: patch.y, w: patch.w, h: patch.h } });
  }
  if (!ops.length) { context.toast('Layout already up to date', 'info'); return; }
  const artboard = context.artboard();
  artboard.classList.add('block-layout-animating');
  await context.applyOps(ops, { refreshArtboard: true, historyBase: context.cloneDocument() || undefined });
  setTimeout(() => artboard.classList.remove('block-layout-animating'), 260);
  context.toast('Applied ' + action.replace('-', ' ') + ' layout', 'success');
}
