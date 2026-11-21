import type { HcPage } from '../types.js';
import { esc } from './utils.js';
import type { ExtensionRuntime, MountedView } from './extensionRuntime.js';

export interface ExtensionPageDeps {
  viewport(): HTMLElement;
  runtime(): ExtensionRuntime | null;
}

let deps: ExtensionPageDeps | null = null;
let mounted: MountedView | null = null;
let mountedKey = '';
let mountedHost: HTMLElement | null = null;

export function installExtensionPage(next: ExtensionPageDeps): void {
  deps = next;
}

function pageKey(page: HcPage): string {
  // Do not key on page data: page viewers (notebooks) save their own data and
  // must not be remounted by the resulting document update.
  return page.id + '|' + (page.extension ? page.extension.format : '');
}

export async function flushExtensionPage(): Promise<void> {
  try { await mounted?.flush?.(); } catch { /* best effort; the dispose path reports errors */ }
}

export function disposeExtensionPage(): void {
  if (mounted) {
    // Page switches are synchronous, so start the save before tearing down.
    // Document switches await flushExtensionPage() before replacing state.doc.
    try {
      const pending = mounted.flush?.();
      if (pending && typeof pending.then === 'function') void pending.catch(() => undefined);
    } catch { /* best effort */ }
    try { mounted.dispose?.(); } catch { /* best effort */ }
    mounted = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  mountedKey = '';
  document.body.classList.remove('extension-page-mode');
}

/** Render (or reuse) the viewer for the active extension page. */
export function renderExtensionPage(page: HcPage): void {
  if (!deps) return;
  const key = pageKey(page);
  if (key === mountedKey && mountedHost?.isConnected) return;
  disposeExtensionPage();
  const viewport = deps.viewport();
  document.body.classList.add('extension-page-mode');
  const host = document.createElement('div');
  host.className = 'extension-page-surface';
  viewport.appendChild(host);
  mountedHost = host;
  mountedKey = key;
  host.innerHTML = '<div class="extension-page-loading">Loading ' + esc(page.extension?.format || 'extension page') + '…</div>';
  const runtime = deps.runtime();
  if (!runtime || !page.extension) {
    host.innerHTML = '<div class="extension-page-error"><strong>Extension page cannot be rendered</strong><small>No extension runtime is available.</small></div>';
    return;
  }
  const handle = runtime.mountPage(page, host);
  if (!handle) {
    host.innerHTML = '<div class="extension-page-error"><strong>No viewer for this page format</strong><small>' + esc(page.extension.format) + ' · install or enable the extension that contributes this page format.</small></div>';
    return;
  }
  mounted = handle;
  host.querySelector('.extension-page-loading')?.remove();
}
