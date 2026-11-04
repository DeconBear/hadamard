import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'node-html-parser';
import pptxgen from 'pptxgenjs';
import { BorderStyle, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

import { htmlToPlainDocument } from './html.js';
import { blockPlugin } from './blockPlugins.js';
import { renderBlockBody } from './builtinBlocks.js';
import { excalidrawSceneToNativePage } from './sceneBridge.js';
import { extractHtmlLayout, type HtmlLayout } from './htmlLayout.js';
import type { HcBlock, HcDocument, HcPage } from './types.js';

const execFileAsync = promisify(execFile);

export type HcExportFormat = 'html' | 'pdf' | 'png' | 'pptx' | 'pptx-editable' | 'docx';

export interface HcExportResult {
  format: HcExportFormat;
  path: string;
  pageId: string | null;
  width: number;
  height: number;
  bytes: number;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function blockStyle(block: HcBlock): string {
  const style = block.style || {};
  const parts = [
    'left:' + block.x + 'px',
    'top:' + block.y + 'px',
    'width:' + block.w + 'px',
    'height:' + block.h + 'px',
    'z-index:' + block.z,
  ];
  if (block.rotation) parts.push('transform:rotate(' + block.rotation + 'deg)');
  if (style.fill && block.type !== 'markdown' && block.type !== 'code' && block.type !== 'image' && block.type !== 'shape') parts.push('background:' + String(style.fill));
  if (style.radius) parts.push('border-radius:' + style.radius + 'px');
  if (style.stroke && block.type !== 'shape' && block.type !== 'freehand' && block.type !== 'arrow' && block.type !== 'curve') parts.push('border:' + (style.strokeWidth || 1) + 'px ' + String(style.strokeStyle || 'solid') + ' ' + style.stroke);
  if (style.opacity !== undefined) parts.push('opacity:' + style.opacity);
  return parts.join(';');
}

function renderBlock(block: HcBlock): string {
  const wrapper = '<div class="hc-block hc-block-' + block.type + '" data-block-id="' + escapeHtml(block.id) + '" style="' + blockStyle(block) + '">';
  return wrapper + renderBlockBody(block, 'export') + '</div>';
}

function exportPage(page: HcPage): HcPage {
  if (page.mode !== 'infinite') return page;
  const blocks = page.blocks || [];
  if (!blocks.length) return { ...page, width: 1280, height: 720 };
  const minX = Math.min(...blocks.map(block => block.x));
  const minY = Math.min(...blocks.map(block => block.y));
  const maxX = Math.max(...blocks.map(block => block.x + block.w));
  const maxY = Math.max(...blocks.map(block => block.y + block.h));
  const padding = 80;
  return {
    ...page,
    width: Math.max(640, Math.ceil(maxX - minX) + padding * 2),
    height: Math.max(480, Math.ceil(maxY - minY) + padding * 2),
    blocks: blocks.map(block => ({ ...block, x: block.x - minX + padding, y: block.y - minY + padding })),
  };
}

function nativePageFromWhiteboard(page: HcPage): HcPage {
  if (page.mode !== 'whiteboard') return page;
  const native = excalidrawSceneToNativePage({ elements: (page.scene?.elements || []) as never[], appState: page.scene?.appState, files: page.scene?.files }, page.name || 'Legacy whiteboard');
  native.id = page.id;
  native.name = page.name;
  native.notes = page.notes;
  native.background = page.background || native.background;
  return native;
}

function renderCanvasPage(page: HcPage): string {
  const blocks = [...(page.blocks || [])].sort((left, right) => left.z - right.z).map(renderBlock).join('');
  return '<div class="hc-page hc-page-canvas" style="width:' + page.width + 'px;height:' + page.height + 'px;background:' + escapeHtml(page.background) + '">' + blocks + '</div>';
}

function extractHtmlPageParts(html: string): { styles: string; body: string } {
  const root = parse(html, { comment: true, blockTextElements: { script: true, style: true, pre: true, textarea: true } });
  const styles = root.querySelectorAll('style').map(style => style.toString()).join('\n');
  const links = root.querySelectorAll('link[rel="stylesheet"]').map(link => link.toString()).join('\n');
  const body = root.querySelector('body');
  return { styles: styles + '\n' + links, body: body ? body.innerHTML : htmlToPlainDocument(html) };
}

const MM_TO_PX = 96 / 25.4;

function buildPrintHtml(doc: HcDocument, pageInput: HcPage, options: { bleedMm?: number; cropMarks?: boolean }): string {
  const page = exportPage(pageInput);
  if (page.mode === 'whiteboard') throw new Error('Print bleed export is not supported for whiteboard pages');
  const bleed = Math.max(0, options.bleedMm ?? 3) * MM_TO_PX;
  const mark = options.cropMarks ? 4 * MM_TO_PX : 0;
  const offset = bleed + mark;
  const sheetW = page.width + offset * 2;
  const sheetH = page.height + offset * 2;
  const parts = page.mode === 'html' ? extractHtmlPageParts(page.html || '') : { styles: '', body: renderCanvasPage(page) };
  const marks: string[] = [];
  if (options.cropMarks) {
    const add = (x: number, y: number, w: number, h: number): void => {
      marks.push('<div style="position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;background:#111"></div>');
    };
    const t = 0.6;
    add(0, offset, mark, t); add(offset, 0, t, mark);
    add(sheetW - mark, offset, mark, t); add(sheetW - offset - t, 0, t, mark);
    add(0, sheetH - offset - t, mark, t); add(offset, sheetH - mark, t, mark);
    add(sheetW - mark, sheetH - offset - t, mark, t); add(sheetW - offset - t, sheetH - mark, t, mark);
  }
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + parts.styles + '</style><style data-hc-print>' +
    '@page{size:' + sheetW + 'px ' + sheetH + 'px;margin:0;}' +
    'html,body{margin:0!important;padding:0!important;width:' + sheetW + 'px!important;height:' + sheetH + 'px!important;overflow:hidden!important;background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
    '.hc-print-sheet{position:relative;width:' + sheetW + 'px;height:' + sheetH + 'px;overflow:hidden;background:' + escapeHtml(page.background) + ';}' +
    '.hc-print-content{position:absolute;left:' + offset + 'px;top:' + offset + 'px;width:' + page.width + 'px;height:' + page.height + 'px;overflow:hidden;background:' + escapeHtml(page.background) + ';}' +
    '.hc-print-content .hc-page{width:' + page.width + 'px!important;height:' + page.height + 'px!important;box-shadow:none!important;}' +
    '</style></head><body><div class="hc-print-sheet"><div class="hc-print-content">' + parts.body + '</div>' + marks.join('') + '</div></body></html>';
}

export function buildStandalonePageHtml(doc: HcDocument, pageInput: HcPage): string {
  const page = exportPage(pageInput);
  if (page.mode === 'html') {
    const source = page.html || '<!doctype html><html><body></body></html>';
    const printCss = '<style data-hc-export>html,body{margin:0;padding:0;} @page{size:' + page.width + 'px ' + page.height + 'px;margin:0;} .hc-page{width:' + page.width + 'px;height:' + page.height + 'px;overflow:hidden;}</style>';
    if (/<\/head>/i.test(source)) return source.replace(/<\/head>/i, printCss + '</head>');
    if (/<html[^>]*>/i.test(source)) return source.replace(/<html([^>]*)>/i, '<html$1><head>' + printCss + '</head>');
    return '<!doctype html><html><head>' + printCss + '</head><body>' + source + '</body></html>';
  }
  return '<!doctype html><html><head><meta charset="utf-8"><style data-hc-export>' + exportCss() + '</style></head><body>' + renderCanvasPage(page) + '</body></html>';
}

export function exportCss(): string {
  return [
    '*{box-sizing:border-box}',
    'html,body{margin:0;padding:0;background:#f3f1ec;}',
    '.hc-doc{display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px;background:#f3f1ec;}',
    '.hc-page{position:relative;overflow:hidden;background:#fff;box-shadow:0 8px 40px rgba(15,23,42,.12);}',
    '.hc-page-canvas[style*="f8f6f1"]{background-color:#f8f6f1;background-image:radial-gradient(rgba(80,70,55,.14) 1px,transparent 1px);background-size:22px 22px;}',
    '.hc-block{position:absolute;}',
    '.hc-md{font:16px/1.65 Inter,ui-sans-serif,system-ui,sans-serif;color:#334155;}',
    '.hc-md h1,.hc-md h2,.hc-md h3{font-family:Georgia,serif;letter-spacing:-.03em;line-height:1.15;margin:0 0 12px;}',
    '.hc-md h1{font-size:34px}.hc-md h2{font-size:26px}.hc-md h3{font-size:20px}',
    '.hc-md p{margin:0 0 10px}.hc-md ul,.hc-md ol{margin:0 0 10px;padding-left:22px}',
    '.hc-md code{background:#f1f5f9;border-radius:4px;padding:1px 5px;font:13px ui-monospace,Consolas,monospace}',
    '.hc-md pre{background:#0f172a;color:#e2e8f0;border-radius:12px;padding:16px;overflow:auto}',
    '.hc-md blockquote{border-left:3px solid #c4b5fd;margin:0;padding-left:14px;color:#64748b}',
    '.hc-md img{max-width:100%}',
    '@media print{html,body,.hc-doc{background:#fff;padding:0;gap:0}.hc-page{box-shadow:none;break-after:page;page-break-after:always}.hc-page:last-child{break-after:auto;page-break-after:auto}}',
  ].join('\n');
}

export function buildDocumentHtml(doc: HcDocument, pageId?: string): string {
  const pages = (pageId ? doc.pages.filter(page => page.id === pageId) : doc.pages).map(exportPage);
  if (pages.length === 0) throw new Error('No pages to export');
  const single = pages.length === 1 ? pages[0]! : null;
  if (single?.mode === 'html') return buildStandalonePageHtml(doc, single);
  const styles = pages.filter(page => page.mode === 'html').map(page => extractHtmlPageParts(page.html || '').styles).join('\n');
  const body = pages.map(page => {
    if (page.mode === 'html') {
      const parts = extractHtmlPageParts(page.html || '');
      return '<div class="hc-page hc-page-html" style="width:' + page.width + 'px;height:' + page.height + 'px;background:' + escapeHtml(page.background) + '">' + parts.body + '</div>';
    }
    return renderCanvasPage(page);
  }).join('\n');
  return '<!doctype html><html><head><meta charset="utf-8"><style data-hc-export>' + exportCss() + '</style>' + styles + '</head><body><div class="hc-doc">' + body + '</div></body></html>';
}

export function firstPage(doc: HcDocument, pageId?: string): HcPage {
  const page = pageId ? doc.pages.find(item => item.id === pageId) : doc.pages[0];
  if (!page) throw new Error('Page not found: ' + (pageId || '(first)'));
  return page;
}

export function browserCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.HCANVAS_BROWSER_PATH) candidates.push(process.env.HCANVAS_BROWSER_PATH);
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const root of roots) {
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    candidates.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return candidates;
}

export function findBrowser(): string | null {
  return browserCandidates().find(candidate => existsSync(candidate)) ?? null;
}

async function runBrowser(browser: string, args: string[], timeoutMs = 60000): Promise<void> {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-export-'));
  try {
    await execFileAsync(browser, ['--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

function inlineRuns(root: ReturnType<typeof parse> | any): TextRun[] {
  const runs: TextRun[] = [];
  const visit = (node: any, style: { bold?: boolean; italics?: boolean } = {}): void => {
    if (!node) return;
    if (node.nodeType === 3) {
      const text = String(node.rawText || '').replace(/\s+/g, ' ');
      if (text) runs.push(new TextRun({ text, ...style }));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = String(node.rawTagName || '').toLowerCase();
    if (tag === 'br') { runs.push(new TextRun({ text: '', break: 1 })); return; }
    if (tag === 'style' || tag === 'script') return;
    const nextStyle = {
      bold: style.bold || tag === 'strong' || tag === 'b',
      italics: style.italics || tag === 'em' || tag === 'i',
    };
    for (const child of node.childNodes || []) visit(child, nextStyle);
  };
  for (const child of root.childNodes || []) visit(child);
  return runs;
}

function textContentOf(node: any): string {
  return String(node?.text || '').replace(/\s+/g, ' ').trim();
}

function canvasPageToSemanticHtml(page: HcPage): string {
  const blocks = [...(page.blocks || [])].sort((left, right) => (left.y - right.y) || (left.x - right.x));
  const parts: string[] = ['<!doctype html><html><head><meta charset="utf-8"></head><body>'];
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = (block.text || '').trim();
      if (!text) continue;
      const heading = Number(block.style?.fontSize || 0) >= 14 || Number(block.style?.fontWeight || 0) >= 650;
      const tag = heading && text.length <= 40 ? 'h2' : 'p';
      parts.push('<' + tag + '>' + escapeHtml(text).replace(/\n/g, '<br>') + '</' + tag + '>');
    } else if (block.type === 'markdown' || block.type === 'code') {
      const text = (block.markdown || block.code || '').trim();
      if (text) parts.push('<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>');
    } else if (block.type === 'image') {
      parts.push('<p>[Image: ' + escapeHtml(block.alt || block.name || 'image') + ']</p>');
    }
  }
  parts.push('</body></html>');
  return parts.join('');
}

async function exportDocx(doc: HcDocument, outDir: string, options: { pageId?: string; outPath?: string }): Promise<HcExportResult> {
  const page = options.pageId ? doc.pages.find(item => item.id === options.pageId) : doc.pages[0];
  if (!page) throw new Error('Page not found');
  const html = page.mode === 'html' ? (page.html || '') : canvasPageToSemanticHtml(page);
  const root = parse(html, { comment: true, blockTextElements: { script: true, style: true, pre: true } });
  const body = root.querySelector('body') || root;
  const children: Paragraph[] = [];
  const walk = (element: any): void => {
    const tag = String(element.rawTagName || '').toLowerCase();
    if (!tag || ['style', 'script', 'head', 'meta', 'link', 'title'].includes(tag)) return;
    if (['h1', 'h2', 'h3', 'h4'].includes(tag)) {
      const level = tag === 'h1' ? HeadingLevel.HEADING_1 : tag === 'h2' ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ heading: level, children: inlineRuns(element), spacing: { before: tag === 'h1' ? 0 : 180, after: 80 } }));
      return;
    }
    if (tag === 'p') {
      const runs = inlineRuns(element);
      if (runs.length) children.push(new Paragraph({ children: runs, spacing: { after: 110 } }));
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = element.querySelectorAll(':scope > li');
      const list = items.length ? items : element.querySelectorAll('li');
      for (const item of list) children.push(new Paragraph({ children: inlineRuns(item), bullet: { level: 0 }, spacing: { after: 50 } }));
      return;
    }
    if (tag === 'hr') {
      children.push(new Paragraph({ text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 8 } }, spacing: { after: 120 } }));
      return;
    }
    if (['header', 'section', 'article', 'main', 'footer', 'div', 'blockquote', 'nav'].includes(tag)) {
      const blockChildren = Array.from(element.childNodes || []).filter((child: any) => child.nodeType === 1);
      const inline = Array.from(element.childNodes || []).filter((child: any) => child.nodeType === 3 && String(child.rawText || '').trim());
      if (blockChildren.length) {
        for (const child of blockChildren) walk(child);
      } else if (inline.length) {
        const text = textContentOf(element);
        if (text) children.push(new Paragraph({ children: inlineRuns(element), spacing: { after: 80 } }));
      }
      return;
    }
    const text = textContentOf(element);
    if (text) children.push(new Paragraph({ children: inlineRuns(element), spacing: { after: 80 } }));
  };
  for (const child of body.childNodes || []) if (child.nodeType === 1) walk(child);
  if (!children.length) children.push(new Paragraph({ text: textContentOf(body) || 'Empty document' }));
  const document = new Document({
    creator: 'Hadamard Canvas',
    title: doc.title,
    description: 'ATS-friendly résumé exported from Hadamard Canvas',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { line: 276 } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 720, right: 820, bottom: 720, left: 820 } } },
      children,
    }],
  });
  const buffer = await Packer.toBuffer(document);
  const safeTitle = (page.name || 'resume').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 50) || 'resume';
  const outPath = path.resolve(options.outPath || path.join(outDir, doc.id + '-' + safeTitle + '.docx'));
  await writeFile(outPath, buffer);
  return { format: 'docx', path: outPath, pageId: page.id, width: page.width, height: page.height, bytes: buffer.byteLength };
}

async function renderHtmlPagePng(doc: HcDocument, page: HcPage, outPath: string): Promise<void> {
  const browser = findBrowser();
  if (!browser) throw new Error('No Chrome/Edge/Chromium browser found. Set HCANVAS_BROWSER_PATH.');
  const html = buildStandalonePageHtml(doc, page);
  const temp = path.join(path.dirname(outPath), '.hc-slide-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.html');
  await writeFile(temp, html, 'utf8');
  try {
    await runBrowser(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=' + page.width + ',' + page.height, '--screenshot=' + path.resolve(outPath), 'file://' + path.resolve(temp).replace(/\\/g, '/')], 90000);
    if (!existsSync(outPath)) throw new Error('Browser did not produce a screenshot for page ' + page.name);
  } finally {
    await rm(temp, { force: true });
  }
}

function slideBackground(page: HcPage): string {
  const value = String(page.background || '#ffffff').replace('#', '').slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(value) ? value : 'FFFFFF';
}

function pptxPxColor(value: string, fallback = 'FFFFFF'): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : fallback;
}

function addEditableHtmlSlide(pptx: { addSlide: () => any; ShapeType: { roundRect: string; ellipse: string } }, page: HcPage, layout: HtmlLayout, index: number, slideW: number, slideH: number): any {
  const slide = pptx.addSlide();
  slide.background = { color: slideBackground(page) };
  const scale = Math.min(slideW / page.width, slideH / page.height);
  const offsetX = (slideW - page.width * scale) / 2;
  const offsetY = (slideH - page.height * scale) / 2;
  const pxToPt = scale * 72;
  for (const shape of layout.shapes) {
    const options: Record<string, unknown> = {
      x: offsetX + shape.x * scale,
      y: offsetY + shape.y * scale,
      w: shape.w * scale,
      h: shape.h * scale,
      fill: { color: pptxPxColor(shape.fill) },
      line: { color: pptxPxColor(shape.stroke, pptxPxColor(shape.fill)), width: shape.strokeWidth > 0 ? Math.max(0.5, shape.strokeWidth * 0.75) : 0 },
      rectRadius: Math.max(0, shape.radius * scale),
    };
    slide.addShape(shape.ellipse ? pptx.ShapeType.ellipse : pptx.ShapeType.roundRect, options);
  }
  for (const text of layout.texts) {
    slide.addText(text.text, {
      x: offsetX + text.x * scale,
      y: offsetY + text.y * scale,
      w: Math.max(0.1, text.w * scale),
      h: Math.max(0.1, text.h * scale),
      margin: 0,
      fontFace: text.fontFamily,
      fontSize: Math.max(5, text.fontSize * pxToPt),
      color: pptxPxColor(text.color, '1F2430'),
      bold: text.fontWeight >= 600,
      italic: text.italic,
      align: text.align,
      valign: 'top',
      breakLine: true,
      bullet: text.bullet ? true : undefined,
      fit: 'shrink',
    });
  }
  if (page.notes) slide.addNotes(page.notes);
  slide.addText(String(index + 1), { x: slideW - 0.65, y: slideH - 0.35, w: 0.4, h: 0.25, fontSize: 9, color: '8A8276', align: 'right' });
  return slide;
}

function pptxColor(value: unknown, fallback = 'FFFFFF'): string {
  const text = String(value ?? '').replace('#', '').trim();
  return /^[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function pptxText(value: string): string {
  return value.replace(/[*_#>`]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function addEditableCanvasSlide(pptx: { addSlide: () => any; ShapeType: { roundRect: string; ellipse: string } }, page: HcPage, index: number, slideW: number, slideH: number): any {
  const slide = pptx.addSlide();
  slide.background = { color: slideBackground(page) };
  const scale = Math.min(slideW / page.width, slideH / page.height);
  const offsetX = (slideW - page.width * scale) / 2;
  const offsetY = (slideH - page.height * scale) / 2;
  const pxToPt = scale * 72;
  const blocks = [...(page.blocks || [])].sort((left, right) => left.z - right.z);
  for (const block of blocks) {
    const style = block.style || {};
    const x = offsetX + block.x * scale;
    const y = offsetY + block.y * scale;
    const w = block.w * scale;
    const h = block.h * scale;
    if (block.type === 'shape') {
      const hasFill = Boolean(style.fill && style.fill !== 'transparent' && /^#[0-9a-f]{6}$/i.test(String(style.fill)));
      const hasLine = Number(style.strokeWidth || 0) > 0 && Boolean(style.stroke);
      slide.addShape(block.shape === 'ellipse' ? pptx.ShapeType.ellipse : pptx.ShapeType.roundRect, {
        x, y, w, h,
        fill: hasFill ? { color: pptxColor(style.fill, 'FFFFFF') } : { color: 'FFFFFF', transparency: 100 },
        line: hasLine ? { color: pptxColor(style.stroke, 'A855F7'), width: Math.max(0.5, Number(style.strokeWidth || 1) * 0.75) } : { color: 'FFFFFF', width: 0 },
        radius: Number(style.radius || 14) * scale,
      });
      continue;
    }
    if (block.type === 'image') {
      if (block.src) {
        const media = block.src.startsWith('data:') ? { data: block.src } : { path: block.src };
        slide.addImage({ ...media, x, y, w, h });
      }
      continue;
    }
    if (block.type === 'markdown' || block.type === 'code') {
      slide.addShape(pptx.ShapeType.roundRect, {
        x, y, w, h,
        fill: { color: pptxColor(style.fill, block.type === 'code' ? '171923' : 'FFFFFF') },
        line: { color: pptxColor(style.fill, block.type === 'code' ? '171923' : 'FFFFFF'), width: 0 },
        radius: Number(style.radius || 14) * scale,
      });
    }
    const text = block.type === 'text' ? (block.text || '') : block.type === 'markdown' ? pptxText(block.markdown || '') : block.type === 'code' ? (block.code || '') : (block.text || '');
    if (!text) continue;
    slide.addText(text, {
      x: x + 8 * scale, y: y + 8 * scale, w: Math.max(0.1, w - 16 * scale), h: Math.max(0.1, h - 16 * scale),
      margin: 0,
      fontFace: block.type === 'code' ? 'Consolas' : String(style.fontFamily || 'Arial').replace(/['"]/g, '').split(',')[0]!.trim(),
      fontSize: Math.max(8, Math.round((style.fontSize || (block.type === 'code' ? 13 : 18)) * pxToPt)),
      color: pptxColor(style.color, block.type === 'code' ? 'E2E8F0' : '1D232E'),
      bold: Number(style.fontWeight || 400) >= 600,
      align: style.align || 'left',
      valign: 'top',
      breakLine: true,
      fit: 'shrink',
    });
  }
  if (page.notes) slide.addNotes(page.notes);
  slide.addText(String(index + 1), { x: slideW - 0.65, y: slideH - 0.35, w: 0.4, h: 0.25, fontSize: 9, color: '8A8276', align: 'right' });
  return slide;
}

async function exportPptx(doc: HcDocument, outDir: string, options: { pageId?: string; outPath?: string; editableHtml?: boolean }): Promise<HcExportResult> {
  const sourcePages = options.pageId ? doc.pages.filter(page => page.id === options.pageId) : doc.pages;
  const pages = sourcePages.map(page => nativePageFromWhiteboard(page));
  if (!pages.length) throw new Error('No pages to export');
  const safeTitle = (doc.title || 'hadamard-canvas').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'hadamard-canvas';
  const outDirAbs = path.resolve(outDir);
  const outPath = options.outPath ? path.resolve(options.outPath) : path.join(outDirAbs, safeTitle + '-' + Date.now() + '.pptx');
  const workDir = path.join(outDirAbs, '.pptx-work-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  await mkdir(workDir, { recursive: true });
  type PptxInstance = { layout: string; author: string; subject: string; title: string; company: string; ShapeType: { roundRect: string; ellipse: string }; defineLayout: (options: { name: string; width: number; height: number }) => void; addSlide: () => { background: { color: string }; addImage: (options: Record<string, unknown>) => void; addNotes: (text: string) => void; addText: (text: string, options: Record<string, unknown>) => void; addShape: (shape: string, options: Record<string, unknown>) => void }; writeFile: (options: { fileName: string }) => Promise<unknown> };
  const pptxModule = pptxgen as unknown as { default?: new () => PptxInstance };
  const PptxGenJS = (pptxModule.default ?? pptxgen) as unknown as new () => PptxInstance;
  const pptx = new PptxGenJS();
  const firstSource = pages[0]!;
  const deckW = Math.max(3, firstSource.width / 96);
  const deckH = Math.max(3, firstSource.height / 96);
  pptx.defineLayout({ name: 'HC_PAGE', width: deckW, height: deckH });
  pptx.layout = 'HC_PAGE';
  pptx.author = 'Hadamard Canvas';
  pptx.subject = doc.title;
  pptx.title = doc.title;
  pptx.company = 'Hadamard';
  try {
    for (const [index, page] of pages.entries()) {
      const blocks = page.blocks || [];
      const editable = Boolean(options.editableHtml)
        && page.mode === 'canvas'
        && blocks.length > 0
        && !blocks.some(block => block.type === 'html' || block.type === 'freehand' || block.type === 'arrow' || block.type === 'curve' || block.type === 'math' || Boolean(blockPlugin(block.type)))
        && !blocks.some(block => block.type === 'image' && /^https?:/i.test(block.src || ''));
      if (editable) {
        addEditableCanvasSlide(pptx as unknown as { addSlide: () => any; ShapeType: { roundRect: string; ellipse: string } }, page, index, deckW, deckH);
        continue;
      }
      if (options.editableHtml && page.mode === 'html') {
        try {
          const browserPath = findBrowser();
          if (browserPath) {
            const layout = await extractHtmlLayout(buildStandalonePageHtml(doc, page), page.width, page.height, browserPath);
            if (layout.texts.length) {
              addEditableHtmlSlide(pptx as unknown as { addSlide: () => any; ShapeType: { roundRect: string; ellipse: string } }, page, layout, index, deckW, deckH);
              continue;
            }
          }
        } catch { /* fall through to image */ }
      }
      const imagePath = path.join(workDir, 'page-' + index + '.png');
      await renderHtmlPagePng(doc, page, imagePath);
      const slide = pptx.addSlide();
      slide.background = { color: slideBackground(page) };
      const slideW = deckW;
      const slideH = deckH;
      const pageAspect = page.width / page.height;
      let width = slideW;
      let height = slideW / pageAspect;
      if (height > slideH) { height = slideH; width = slideH * pageAspect; }
      slide.addImage({ path: imagePath, x: (slideW - width) / 2, y: (slideH - height) / 2, w: width, h: height });
      const notes = page.notes || '';
      if (notes) slide.addNotes(notes);
      slide.addText(String(index + 1), { x: slideW - 0.65, y: slideH - 0.35, w: 0.4, h: 0.25, fontSize: 9, color: '8A8276', align: 'right' });
    }
    await pptx.writeFile({ fileName: outPath });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  const data = await readFile(outPath);
  const first = exportPage(pages[0]!);
  return { format: 'pptx', path: outPath, pageId: options.pageId || null, width: first.width, height: first.height, bytes: data.byteLength };
}

export async function exportFile(
  doc: HcDocument,
  format: HcExportFormat,
  outDir: string,
  options: { pageId?: string; outPath?: string; bleedMm?: number; cropMarks?: boolean } = {},
): Promise<HcExportResult> {
  await mkdir(outDir, { recursive: true });
  if (format === 'docx') return exportDocx(doc, outDir, options);
  if (format === 'pptx') return exportPptx(doc, outDir, options);
  if (format === 'pptx-editable') {
    const result = await exportPptx(doc, outDir, { ...options, editableHtml: true });
    return { ...result, format: 'pptx-editable' };
  }
  const page = exportPage(nativePageFromWhiteboard(firstPage(doc, options.pageId)));
  const safeTitle = (page.name || 'page').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'page';
  if (format === 'html') {
    const html = buildDocumentHtml(doc, options.pageId);
    const outPath = options.outPath || path.join(outDir, doc.id + '-' + safeTitle + '.html');
    await writeFile(outPath, html, 'utf8');
    const stat = await readFile(outPath);
    return { format, path: outPath, pageId: page.id, width: page.width, height: page.height, bytes: stat.byteLength };
  }
  const sourcePage = nativePageFromWhiteboard(firstPage(doc, options.pageId));
  const html = format === 'png'
    ? buildStandalonePageHtml(doc, sourcePage)
    : buildPrintHtml(doc, sourcePage, { bleedMm: (options.bleedMm || 0) > 0 ? options.bleedMm : 0, cropMarks: options.cropMarks });
  const temp = path.resolve(outDir, '.hc-export-' + randomUUID() + '.html');
  await writeFile(temp, html, 'utf8');
  const outPath = path.resolve(options.outPath || path.join(outDir, doc.id + '-' + safeTitle + '.' + format));
  try {
    const browser = findBrowser();
    if (!browser) throw new Error('No Chrome/Edge/Chromium browser found. Set HCANVAS_BROWSER_PATH.');
    if (format === 'pdf') {
      await runBrowser(browser, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--no-margins', '--print-to-pdf=' + outPath, 'file://' + temp.replace(/\\/g, '/')]);
    } else {
      await runBrowser(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=' + page.width + ',' + page.height, '--screenshot=' + outPath, 'file://' + temp.replace(/\\/g, '/')]);
    }
  } finally {
    await rm(temp, { force: true });
  }
  const data = await readFile(outPath);
  return { format, path: outPath, pageId: page.id, width: page.width, height: page.height, bytes: data.byteLength };
}