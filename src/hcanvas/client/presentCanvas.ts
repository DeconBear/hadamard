import type { HcPage } from '../types.js';
import { renderBlockBody } from '../builtinBlocks.js';
import { blocksInStackOrder } from '../layers.js';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderPresentCanvasHtml(page: HcPage): string {
  let html = '<div style="position:relative;width:100%;height:100%;background:' + escapeHtml(page.background) + ';overflow:hidden">';
  for (const block of blocksInStackOrder(page)) {
    const style = 'position:absolute;left:' + block.x + 'px;top:' + block.y + 'px;width:' + block.w + 'px;height:' + block.h + 'px;overflow:' + (block.type === 'freehand' || block.type === 'arrow' ? 'visible' : 'hidden') + ';border-radius:' + escapeHtml(String(block.style?.radius || 0)) + 'px;' + (block.rotation ? 'transform:rotate(' + block.rotation + 'deg);' : '') + (block.style?.opacity !== undefined ? 'opacity:' + block.style.opacity + ';' : '');
    html += '<div style="' + style + '">' + renderBlockBody(block, 'present') + '</div>';
  }
  return html + '</div>';
}