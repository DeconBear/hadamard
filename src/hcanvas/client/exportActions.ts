import { nativeBlocksToExcalidrawScene } from '../sceneBridge.js';
import type { HcDocument, HcPage } from '../types.js';

export interface ExportActionsDeps {
  getDoc(): HcDocument | null;
  getPage(): HcPage | null;
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  token(): string;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export interface ExportActionsController {
  toggleExportMenu(force?: boolean): void;
  exportCurrent(format: string, options?: { bleedMm?: number; cropMarks?: boolean }): Promise<void>;
}

/** Export menu + export pipeline (extracted from main.ts). */
export function createExportActions(deps: ExportActionsDeps): ExportActionsController {
  const toggleExportMenu = (force?: boolean): void => {
    const menu = document.getElementById('exportMenu');
    const button = document.getElementById('exportBtn');
    if (!menu) return;
    const show = force === undefined ? menu.classList.contains('hidden') : force;
    menu.classList.toggle('hidden', !show);
    button?.setAttribute('aria-expanded', String(show));
  };

  const exportCurrent = async (format: string, options: { bleedMm?: number; cropMarks?: boolean } = {}): Promise<void> => {
    const doc = deps.getDoc();
    if (!doc) return;
    const page = deps.getPage();
    if (format === 'scene') {
      if (!page) { deps.toast('Open a page first.', 'error'); return; }
      if (page.mode === 'infinite') {
        const scene = nativeBlocksToExcalidrawScene(page);
        const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/vnd.excalidraw+json' });
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = (page.name || 'infinite').replace(/[^a-z0-9_-]+/gi, '-') + '.excalidraw';
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
        setTimeout(() => URL.revokeObjectURL(anchor.href), 2000);
        return;
      }
      deps.toast('Scene export is available for Canvas and Infinite pages.', 'error');
      return;
    }
    try {
      deps.toast('Rendering ' + format.toUpperCase() + '…', 'info');
      const result = await deps.request<{ downloadUrl?: string; path?: string; format: string }>('/api/export', { method: 'POST', body: JSON.stringify({ docId: doc.id, format, pageId: format === 'pptx' || format === 'pptx-editable' ? undefined : page?.id, bleedMm: options.bleedMm || undefined, cropMarks: options.cropMarks || undefined }) });
      if (result.downloadUrl) {
        const anchor = document.createElement('a');
        anchor.href = result.downloadUrl + (result.downloadUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(deps.token());
        anchor.download = '';
        anchor.style.display = 'none';
        document.body.appendChild(anchor); anchor.click();
        setTimeout(() => anchor.remove(), 5000);
        deps.toast('Export ready: ' + (result.path || format), 'success');
      } else deps.toast('Export failed', 'error');
    } catch (error) { deps.toast(error instanceof Error ? error.message : String(error), 'error'); }
  };

  return { toggleExportMenu, exportCurrent };
}
