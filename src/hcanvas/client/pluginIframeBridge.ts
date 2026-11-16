import type { HcPage } from '../types.js';
import { blockPlugin } from '../blockPlugins.js';

export interface PluginIframeRendererRequest {
  type: 'hc-renderer-request';
  requestId?: string;
  rendererId?: string;
  payload?: unknown;
}

function iframeFor(source: MessageEventSource | null): HTMLIFrameElement | null {
  if (!source) return null;
  for (const iframe of document.querySelectorAll<HTMLIFrameElement>('iframe.block-plugin-iframe')) {
    if (iframe.contentWindow === source) return iframe;
  }
  return null;
}

export function installPluginIframeBridge(getPage: () => HcPage | null): void {
  window.addEventListener('message', event => {
    const message = event.data as PluginIframeRendererRequest;
    if (!message || message.type !== 'hc-renderer-request') return;
    const iframe = iframeFor(event.source);
    if (!iframe) return;
    const wrap = iframe.closest<HTMLElement>('.block-wrap[data-block-id]');
    const blockId = wrap?.dataset.blockId;
    const page = getPage();
    const block = page?.blocks?.find(item => item.id === blockId);
    if (!block || !message.requestId || !message.rendererId) return;
    const renderer = blockPlugin(block.type)?.renderers?.find(item => item.id === message.rendererId);
    if (!renderer) {
      iframe.contentWindow?.postMessage({ type: 'hc-renderer-response', requestId: message.requestId, ok: false, error: 'Renderer "' + message.rendererId + '" is not registered for this block.' }, '*');
      return;
    }
    void (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const response = await fetch(renderer.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ renderer: renderer.id, payload: message.payload || {} }),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) throw new Error('Renderer HTTP ' + response.status + ': ' + text.slice(0, 240));
        let result: unknown = text;
        try { result = JSON.parse(text); } catch { /* text result */ }
        iframe.contentWindow?.postMessage({ type: 'hc-renderer-response', requestId: message.requestId, ok: true, result }, '*');
      } catch (error) {
        iframe.contentWindow?.postMessage({ type: 'hc-renderer-response', requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }, '*');
      } finally {
        clearTimeout(timer);
      }
    })();
  });
}
