import type { HcPluginManifest } from '../pluginManifest.js';

export interface PluginGalleryContext {
  request(path: string, init?: RequestInit): Promise<unknown>;
  reload(): Promise<unknown>;
  onChanged(): void;
  open(): void;
  close(): void;
  openManager?(): void;
  openModal(html: string): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

interface GallerySample {
  id: string;
  name: string;
  version: string;
  description: string;
  manifest: HcPluginManifest;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function galleryMarkup(samples: GallerySample[]): string {
  const cards = samples.map(sample => {
    const blocks = sample.manifest.blocks?.length || 0;
    const pages = sample.manifest.pagePresets?.length || 0;
    const details = [blocks ? blocks + ' block' + (blocks === 1 ? '' : 's') : '', pages ? pages + ' page template' + (pages === 1 ? '' : 's') : ''].filter(Boolean).join(' · ');
    return '<article class="gallery-card"><div class="gallery-card-head"><div><strong>' + escapeHtml(sample.name) + '</strong><small>v' + escapeHtml(sample.version) + ' · ' + escapeHtml(sample.id) + '</small></div><span class="gallery-badge">' + escapeHtml(details || 'plugin') + '</span></div>' +
      '<p>' + escapeHtml(sample.description) + '</p>' +
      '<button type="button" class="btn tiny primary" data-gallery-install="' + escapeHtml(sample.id) + '">Install</button></article>';
  }).join('');
  return '<div class="modal plugin-gallery-modal"><div class="modal-head"><div><strong>Plugin gallery</strong><small>Install a self-contained declarative plugin. Installs into this project.</small></div><button class="icon-btn" data-close>×</button></div>' +
    '<div class="modal-body"><div class="gallery-grid">' + (cards || '<p class="empty-state">No samples available.</p>') + '</div></div>' +
    '<div class="modal-foot"><button class="btn tiny" data-gallery-import>Import JSON</button><button class="btn primary tiny" data-close>Done</button></div></div>';
}

function importMarkup(): string {
  return '<div class="modal plugin-gallery-modal"><div class="modal-head"><div><strong>Import plugin manifest</strong><small>Paste a manifest or choose a JSON file. It installs into .hcanvas/plugins.</small></div><button class="icon-btn" data-close>×</button></div>' +
    '<div class="modal-body"><div class="field"><span>manifest.json</span><textarea id="galleryImportJson" rows="14" placeholder="{ ... }"></textarea></div><div class="field"><span>Or choose a file</span><input id="galleryImportFile" type="file" accept=".json,application/json"></div></div>' +
    '<div class="modal-foot"><button class="btn tiny" data-gallery-back>Back</button><button class="btn primary tiny" data-gallery-install-json>Install</button></div></div>';
}

export function openPluginGallery(ctx: PluginGalleryContext): void {
  ctx.openModal('<div class="modal plugin-gallery-modal"><div class="modal-body"><p class="empty-state">Loading gallery…</p></div></div>');
  void (async () => {
    let samples: GallerySample[] = [];
    try {
      const payload = await ctx.request('/api/plugins/gallery') as { samples?: GallerySample[] };
      samples = payload.samples || [];
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), 'error');
    }
    ctx.openModal(galleryMarkup(samples));
    const root = document.querySelector('.plugin-gallery-modal');
    const install = async (manifest: HcPluginManifest): Promise<void> => {
      try {
        await ctx.request('/api/plugins/install', { method: 'POST', body: JSON.stringify({ manifest }) });
        await ctx.reload();
        ctx.onChanged();
        ctx.toast('Installed ' + manifest.name, 'success');
        ctx.close();
        ctx.open();
      } catch (error) {
        ctx.toast(error instanceof Error ? error.message : String(error), 'error');
      }
    };
    root?.querySelectorAll<HTMLButtonElement>('[data-gallery-install]').forEach(button => {
      button.addEventListener('click', () => {
        const sample = samples.find(item => item.id === button.dataset.galleryInstall);
        if (sample) void install(sample.manifest);
      });
    });
    root?.querySelector<HTMLButtonElement>('[data-gallery-import]')?.addEventListener('click', () => {
      ctx.openModal(importMarkup());
      const importRoot = document.querySelector('.plugin-gallery-modal');
      const file = importRoot?.querySelector<HTMLInputElement>('#galleryImportFile');
      const textarea = importRoot?.querySelector<HTMLTextAreaElement>('#galleryImportJson');
      file?.addEventListener('change', async () => {
        const selected = file.files?.[0];
        if (selected && textarea) textarea.value = await selected.text();
      });
      importRoot?.querySelector<HTMLButtonElement>('[data-gallery-back]')?.addEventListener('click', () => ctx.open());
      importRoot?.querySelector<HTMLButtonElement>('[data-gallery-install-json]')?.addEventListener('click', () => {
        try {
          const manifest = JSON.parse(textarea?.value || '') as HcPluginManifest;
          void install(manifest);
        } catch {
          ctx.toast('The manifest is not valid JSON', 'error');
        }
      });
    });
  })();
}
