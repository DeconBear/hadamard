import type { HcBlock, HcOp, HcPage } from '../types.js';
import type { HcPluginAction } from '../pluginManifest.js';
import { blockPlugin } from '../blockPlugins.js';
import { runSandboxAction } from './pluginSandbox.js';
import { listPluginPagePresets, materializePluginPagePreset } from './pluginBlocks.js';

export interface PluginActionContext {
  page: HcPage;
  applyOps(ops: HcOp[], options?: { refreshArtboard?: boolean }): Promise<unknown>;
  createId(prefix: string): string;
  select(ids: string[], primary?: string | null): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export async function runPluginAction(block: HcBlock, action: HcPluginAction, context: PluginActionContext): Promise<void> {
  try {
    if (action.kind === 'script') {
      const plugin = blockPlugin(block.type);
      if (!plugin?.script) { context.toast('This plugin has no sandbox script.', 'error'); return; }
      const effects = await runSandboxAction(plugin, action, block, context.page);
      if (!effects.length) { context.toast('Sandbox action returned no effects.', 'info'); return; }
      for (const effect of effects) await runPluginAction(block, effect, context);
      return;
    }
    if (action.kind === 'set-data') {
      await context.applyOps([{ op: 'update_block', pageId: context.page.id, blockId: block.id, patch: { data: { ...(block.data || {}), ...(action.data || {}) } } }], { refreshArtboard: true });
      context.toast('Updated ' + (block.name || 'plugin data'), 'success');
      return;
    }
    if (action.kind === 'apply-style') {
      await context.applyOps([{ op: 'update_block', pageId: context.page.id, blockId: block.id, patch: { style: { ...(block.style || {}), ...(action.style || {}) } } }], { refreshArtboard: true });
      context.toast('Applied style from plugin action', 'success');
      return;
    }
    if (action.kind === 'insert-block') {
      const type = action.blockType;
      if (!type) { context.toast('Plugin action has no block type.', 'error'); return; }
      const maxZ = Math.max(0, ...(context.page.blocks || []).map(item => item.z));
      const next: HcBlock = {
        id: context.createId('block'),
        type,
        x: action.x ?? Math.min(context.page.width - 320, block.x + block.w + 24),
        y: action.y ?? block.y,
        w: action.w ?? 320,
        h: action.h ?? 200,
        z: maxZ + 1,
        name: action.label || type,
        text: action.text,
        data: action.data ? { ...action.data } : undefined,
        style: action.style as HcBlock['style'],
      };
      await context.applyOps([{ op: 'add_block', pageId: context.page.id, block: next }], { refreshArtboard: true });
      context.select([next.id], next.id);
      context.toast('Inserted ' + (action.label || type), 'success');
      return;
    }
    if (action.kind === 'add-page-preset') {
      const preset = listPluginPagePresets().find(item => item.preset.id === action.presetId);
      if (!preset) { context.toast('Page preset "' + action.presetId + '" is not available.', 'error'); return; }
      const page = materializePluginPagePreset(preset.preset, context.createId);
      await context.applyOps([{ op: 'add_page', page }], { refreshArtboard: true });
      context.toast('Added page from ' + preset.pluginName, 'success');
      return;
    }
    context.toast('Unsupported plugin action.', 'error');
  } catch (error) {
    context.toast(error instanceof Error ? error.message : String(error), 'error');
  }
}
