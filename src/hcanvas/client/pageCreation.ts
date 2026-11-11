import type { HcDocument, HcPage, HcOp } from '../types.js';
import type { HcClientPagePreset } from './pageTemplates.js';
import { canvasTemplateBlocks, pageTemplateHtml, starterHtml } from './pageTemplates.js';
import { markdownPageHtml } from '../markdownPage.js';
import { genId } from './utils.js';

export interface CreatePageOptions {
  applyOps(ops: HcOp[], options?: { refreshArtboard?: boolean }): Promise<HcDocument | null>;
  onCreated(page: HcPage): void;
}

export async function createPageFromPreset(preset: HcClientPagePreset, options: CreatePageOptions): Promise<void> {
  const page: HcPage = {
    id: genId('page'), name: preset.title, mode: preset.mode,
    width: preset.width, height: preset.height, background: preset.background,
    ...(preset.mode === 'html'
      ? preset.markdown !== undefined
        ? { html: markdownPageHtml(preset.markdown, { background: preset.background }), markdown: preset.markdown }
        : { html: preset.template ? pageTemplateHtml(preset.template, '') : starterHtml(preset.title) }
      : { blocks: preset.template?.startsWith('canvas-') ? canvasTemplateBlocks(preset.template, preset.width, preset.height) : [] }),
  };
  const result = await options.applyOps([{ op: 'add_page', page }], { refreshArtboard: false });
  if (result) options.onCreated(page);
}
