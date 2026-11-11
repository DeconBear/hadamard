import { CANVAS_PAGE_PRESETS, canvasTemplateBlocks, pageTemplateHtml, starterHtml } from './pageTemplates.js';
import { esc } from './utils.js';
import type { HcDocument } from '../types.js';

export interface NewDocModalOptions {
  openModal(html: string): void;
  closeModal(): void;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  openDoc(docId: string): Promise<void>;
  toast(message: string, kind?: 'success' | 'error' | 'info'): void;
}

export function openNewDocModal(options: NewDocModalOptions): void {
  let html = '<div class="modal small"><div class="modal-head"><div><strong>New canvas</strong><small>Start with a canvas size.</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="field"><span>Title</span><input id="newDocTitle" value="Untitled canvas"></div><div class="field"><span>First page</span><select id="newDocPreset">';
  for (const preset of CANVAS_PAGE_PRESETS) html += '<option value="' + esc(preset.id) + '">' + esc(preset.title) + ' · ' + esc(preset.hint) + '</option>';
  html += '</select></div></div><div class="modal-foot"><button class="btn" data-close>Cancel</button><button id="createDocBtn" class="btn primary">Create</button></div></div>';
  options.openModal(html);
  document.querySelector<HTMLButtonElement>('#createDocBtn')?.addEventListener('click', async () => {
    const title = document.querySelector<HTMLInputElement>('#newDocTitle')?.value || 'Untitled canvas';
    const presetId = document.querySelector<HTMLSelectElement>('#newDocPreset')?.value || 'canvas-16-9';
    const preset = CANVAS_PAGE_PRESETS.find(item => item.id === presetId);
    options.closeModal();
    try {
      const result = await options.request<{ doc: HcDocument }>('/api/docs', {
        method: 'POST',
        body: JSON.stringify({
          title,
          preset: preset ? {
            id: preset.id,
            title: preset.title,
            width: preset.width,
            height: preset.height,
            background: preset.background,
            mode: preset.mode,
            html: preset.mode === 'html' ? preset.markdown !== undefined ? undefined : preset.template ? pageTemplateHtml(preset.template, '') : starterHtml(preset.title) : undefined,
            markdown: preset.markdown,
            blocks: preset.mode === 'canvas' || preset.mode === 'infinite'
              ? preset.template?.startsWith('canvas-') ? canvasTemplateBlocks(preset.template, preset.width, preset.height) : []
              : undefined,
          } : undefined,
        }),
      });
      await options.openDoc(result.doc.id);
    } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
  });
}
