import { getPluginCatalog } from './pluginBlocks.js';
import { openPluginManager } from './pluginManager.js';
import { openPluginGallery } from './pluginGallery.js';

export interface PluginSidebarOptions {
  request(path: string, init?: RequestInit): Promise<unknown>;
  openModal(html: string): void;
  closeModal(): void;
  confirm(message: string): Promise<boolean>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  reload(): Promise<unknown>;
  onChanged(): void;
}

function pluginCount(): number {
  return getPluginCatalog().plugins.length;
}

/** A permanent left-sidebar entry for plugin management. */
export function installPluginSidebar(options: PluginSidebarOptions): void {
  const updateCount = (): void => {
    const count = document.getElementById('pluginSidebarCount');
    if (count) count.textContent = pluginCount() + ' plugin' + (pluginCount() === 1 ? '' : 's') + ' loaded';
  };
  const reload = async (): Promise<unknown> => {
    const result = await options.reload();
    updateCount();
    options.onChanged();
    return result;
  };
  const openManager = (): void => openPluginManager({
    catalog: getPluginCatalog(),
    request: options.request,
    reload,
    onChanged: options.onChanged,
    open: openManager,
    openGallery,
    confirm: options.confirm,
    close: options.closeModal,
    openModal: options.openModal,
    toast: options.toast,
  });
  const openGallery = (): void => openPluginGallery({
    request: options.request,
    reload,
    onChanged: options.onChanged,
    open: openGallery,
    close: options.closeModal,
    openManager,
    openModal: options.openModal,
    toast: options.toast,
  });
  for (const id of ['managePluginsBtn', 'pluginManagePanelBtn']) document.getElementById(id)?.addEventListener('click', event => { event.stopPropagation(); openManager(); });
  for (const id of ['pluginGalleryBtn', 'pluginGalleryPanelBtn']) document.getElementById(id)?.addEventListener('click', event => { event.stopPropagation(); openGallery(); });
  updateCount();
}
