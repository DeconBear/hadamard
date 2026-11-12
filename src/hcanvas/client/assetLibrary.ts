export interface HcAssetView {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  url: string;
}

export interface AssetLibraryOptions {
  mount: HTMLElement;
  dropTarget: HTMLElement;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  serveUrl(id: string): string;
  onInsert(asset: HcAssetView, point?: { clientX: number; clientY: number }): Promise<void> | void;
  openPreview?(asset: HcAssetView): void;
  isReferenced(url: string): boolean;
  toast(message: string, kind?: 'success' | 'error' | 'info'): void;
  confirm(message: string): Promise<boolean>;
}

let assets: HcAssetView[] = [];
let uploading = false;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function isImage(asset: HcAssetView): boolean {
  return asset.mime.startsWith('image/');
}

export function installAssetLibrary(options: AssetLibraryOptions): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,application/pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.json';
  input.style.display = 'none';
  document.body.appendChild(input);

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files).filter(file => file.size <= 32 * 1024 * 1024);
    if (!list.length) { options.toast('No files to upload (max 32 MB each)', 'error'); return; }
    uploading = true;
    render();
    try {
      for (const file of list) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(reader.error || new Error('Could not read file'));
          reader.readAsDataURL(file);
        });
        const data = dataUrl.replace(/^data:[^;]+;base64,/, '');
        const result = await options.request<{ asset: HcAssetView }>('/api/assets', {
          method: 'POST',
          body: JSON.stringify({ name: file.name, mime: file.type || undefined, data }),
        });
        assets.unshift(result.asset);
      }
      options.toast(list.length === 1 ? 'Asset uploaded' : list.length + ' assets uploaded', 'success');
    } catch (error) {
      options.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      uploading = false;
      render();
    }
  }

  async function load(): Promise<void> {
    try {
      const result = await options.request<{ assets: HcAssetView[] }>('/api/assets');
      assets = result.assets || [];
    } catch {
      assets = [];
    }
    render();
  }

  function render(): void {
    const hadFocus = options.mount.contains(document.activeElement);
    options.mount.innerHTML = '';
    if (uploading) {
      const status = document.createElement('p');
      status.className = 'assets-status';
      status.textContent = 'Uploading…';
      options.mount.appendChild(status);
    }
    if (!assets.length && !uploading) {
      options.mount.innerHTML = '<p class="assets-empty">Drop images or files here, or use +.</p>';
    }
    for (const asset of assets) {
      const row = document.createElement('div');
      row.className = 'asset-row';
      row.draggable = true;
      row.dataset.assetId = asset.id;
      row.title = asset.name + ' · ' + formatBytes(asset.size) + ' · Click to preview';
      const thumb = isImage(asset)
        ? '<img src="' + escapeHtml(asset.url) + '" alt="" loading="lazy">'
        : '<span class="asset-file-icon">' + escapeHtml((asset.name.split('.').pop() || 'file').slice(0, 4).toUpperCase()) + '</span>';
      row.innerHTML = '<div class="asset-thumb">' + thumb + '</div><div class="asset-copy"><strong>' + escapeHtml(asset.name) + '</strong><small>' + formatBytes(asset.size) + '</small></div><button type="button" class="btn tiny asset-insert" title="Insert into current page">Insert</button><button type="button" class="icon-btn asset-delete" title="Delete asset">×</button>';
      row.addEventListener('dragstart', event => {
        event.dataTransfer?.setData('application/x-hcanvas-asset', JSON.stringify(asset));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      });
      row.addEventListener('click', event => {
        if ((event.target as HTMLElement).closest('button')) return;
        options.openPreview?.(asset);
      });
      row.querySelector<HTMLButtonElement>('.asset-insert')!.addEventListener('click', () => void options.onInsert(asset));
      row.querySelector<HTMLButtonElement>('.asset-delete')!.addEventListener('click', async () => {
        const used = options.isReferenced(asset.url);
        const ok = await options.confirm(used ? 'This asset is used in the document. Delete it anyway?' : 'Delete asset "' + asset.name + '"?');
        if (!ok) return;
        try {
          await options.request('/api/assets/' + encodeURIComponent(asset.id), { method: 'DELETE' });
          assets = assets.filter(item => item.id !== asset.id);
          options.toast('Asset deleted', 'success');
          render();
        } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
      });
      options.mount.appendChild(row);
    }
    if (hadFocus) options.mount.querySelector<HTMLElement>('.asset-row')?.focus();
  }

  document.getElementById('uploadAssetBtn')?.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files) void uploadFiles(input.files); input.value = ''; });
  options.mount.addEventListener('dragover', event => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); event.dataTransfer!.dropEffect = 'copy'; }
  });
  options.mount.addEventListener('drop', event => {
    if (event.dataTransfer?.files?.length) { event.preventDefault(); event.stopPropagation(); void uploadFiles(event.dataTransfer.files); }
  });
  options.dropTarget.addEventListener('dragover', event => {
    if (Array.from(event.dataTransfer?.types || []).includes('application/x-hcanvas-asset')) { event.preventDefault(); event.dataTransfer!.dropEffect = 'copy'; }
  });
  options.dropTarget.addEventListener('drop', event => {
    const raw = event.dataTransfer?.getData('application/x-hcanvas-asset');
    if (!raw) return;
    event.preventDefault();
    event.stopPropagation();
    try { void options.onInsert(JSON.parse(raw) as HcAssetView, { clientX: event.clientX, clientY: event.clientY }); }
    catch { options.toast('Could not read that asset', 'error'); }
  });
  void load();
}
