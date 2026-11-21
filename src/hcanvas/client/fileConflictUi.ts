export interface FileConflictBannerRequest {
  <T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
}

export interface FileConflictBannerOptions {
  surface: HTMLElement;
  message: string;
  rootId: string;
  path: string;
  content: string;
  request: FileConflictBannerRequest;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  onReload(file: { content: string; hash?: string; mtime?: number }): void;
  onOverwrite(): void;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render the shared Reload / Overwrite / Save-copy recovery banner. */
export function showFileConflictBanner(options: FileConflictBannerOptions): void {
  const surface = options.surface;
  surface.querySelector('[data-file-conflict]')?.remove();
  const banner = document.createElement('div');
  banner.className = 'file-conflict-banner';
  banner.setAttribute('data-file-conflict', 'true');
  banner.innerHTML = '<div><strong>File changed on disk</strong><span>' + escapeHtml(options.message) + '</span></div><div class="file-conflict-actions"><button type="button" class="btn tiny" data-file-conflict-reload>Reload disk version</button><button type="button" class="btn tiny" data-file-conflict-overwrite>Overwrite</button><button type="button" class="btn tiny" data-file-conflict-copy>Save local copy</button></div>';
  banner.querySelector('[data-file-conflict-reload]')?.addEventListener('click', () => {
    void (async () => {
      try {
        const result = await options.request<{ file: { content: string; hash?: string; mtime?: number } }>('/api/files/read?root=' + encodeURIComponent(options.rootId) + '&path=' + encodeURIComponent(options.path));
        options.onReload(result.file);
        options.toast('Reloaded the disk version.', 'success');
      } catch (error) {
        options.toast(error instanceof Error ? error.message : String(error), 'error');
      }
    })();
  });
  banner.querySelector('[data-file-conflict-overwrite]')?.addEventListener('click', () => options.onOverwrite());
  banner.querySelector('[data-file-conflict-copy]')?.addEventListener('click', () => {
    void (async () => {
      const suffix = new Date().toISOString().replace(/[:.]/g, '-');
      const copyPath = options.path + '.conflict-copy-' + suffix;
      try {
        await options.request('/api/files/write', { method: 'POST', body: JSON.stringify({ root: options.rootId, path: copyPath, content: options.content }) });
        options.toast('Saved a local copy at ' + copyPath, 'success');
      } catch (error) {
        options.toast(error instanceof Error ? error.message : String(error), 'error');
      }
    })();
  });
  surface.insertBefore(banner, surface.querySelector('.file-surface-head')?.nextSibling || surface.firstChild);
}
