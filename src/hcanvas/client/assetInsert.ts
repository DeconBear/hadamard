import type { HcAssetView } from './assetLibrary.js';
import type { HcBlock, HcDocument, HcOp, HcPage } from '../types.js';

export interface AssetInsertOptions {
  getPage(): HcPage | null;
  viewport: HTMLElement;
  zoom(): number;
  panX(): number;
  panY(): number;
  genId(prefix: string): string;
  copyText(text: string): Promise<void>;
  toast(message: string, kind?: 'success' | 'error' | 'info'): void;
  applyOps(ops: HcOp[], options?: { refreshArtboard?: boolean }): Promise<HcDocument | null>;
  setBlockSelection(ids: string[], primaryId: string): void;
}

function assetHtml(asset: HcAssetView, style = ''): string {
  const src = asset.url.replace(/"/g, '&quot;');
  const name = asset.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return '<img src="' + src + '" alt="' + name + '"' + (style ? ' style="' + style + '"' : '') + '>';
}

/** Insert an asset into the active page. HTML/Markdown pages receive inline markup; canvas pages get an image block. */
export async function insertAssetIntoPage(asset: HcAssetView, point: { clientX: number; clientY: number } | undefined, options: AssetInsertOptions): Promise<void> {
  const page = options.getPage();
  if (!page) return;
  if (!asset.mime.startsWith('image/') && page.mode !== 'html') {
    await options.copyText(asset.url).catch(() => undefined);
    options.toast('Attachment URL copied; insert it as a link', 'info');
    return;
  }
  const pageId = page.id;
  if (page.mode === 'html' && page.markdown !== undefined) {
    const markdown = (page.markdown || '').replace(/\s+$/, '') + '\n\n![' + asset.name.replace(/]/g, '\\]') + '](' + asset.url + ')\n';
    await options.applyOps([{ op: 'set_page_markdown', pageId, markdown }], { refreshArtboard: true });
    return;
  }
  if (page.mode === 'html') {
    const snippet = '<figure style="margin:24px 0;text-align:center">' + assetHtml(asset, 'max-width:100%;height:auto;border-radius:8px') + '</figure>';
    const html = page.html || '';
    const next = html.includes('</body>') ? html.replace('</body>', snippet + '</body>') : html + snippet;
    await options.applyOps([{ op: 'set_page_html', pageId, html: next }], { refreshArtboard: true });
    return;
  }
  if (page.mode !== 'canvas' && page.mode !== 'infinite') {
    options.toast('Images can be inserted on canvas, HTML, or Markdown pages', 'info');
    return;
  }
  const rect = options.viewport.getBoundingClientRect();
  const worldX = point ? (point.clientX - rect.left - options.panX()) / options.zoom() : page.width / 2 - 180;
  const worldY = point ? (point.clientY - rect.top - options.panY()) / options.zoom() : page.height / 2 - 120;
  const block: HcBlock = {
    id: options.genId('block'), type: 'image', src: asset.url, alt: asset.name,
    x: Math.max(0, worldX - 180), y: Math.max(0, worldY - 120), w: 360, h: 240,
    z: Math.max(0, ...(page.blocks || []).map(item => item.z)) + 1,
  };
  const result = await options.applyOps([{ op: 'add_block', pageId, block }], { refreshArtboard: true });
  if (result) options.setBlockSelection([block.id], block.id);
}
