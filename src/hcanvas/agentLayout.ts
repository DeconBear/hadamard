import { parse, type HTMLElement as ParsedElement } from 'node-html-parser';
import type { HcBlock, HcDocument, HcPage } from './types.js';

export interface LayoutReadOptions {
  pageId?: string;
  limit?: number;
}

export interface LayoutBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  right: number;
  bottom: number;
}

export interface LayoutTarget {
  id: string;
  tag: string;
  role: string;
  text?: string;
  tex?: string;
}

export interface LayoutBlock {
  id: string;
  type: string;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  bounds: LayoutBounds;
  preview?: string;
  style?: Record<string, string | number>;
  targets?: LayoutTarget[];
}

export interface LayoutIssue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  pageId?: string;
  pageName?: string;
  blockId?: string;
}

export interface LayoutPage {
  id: string;
  name: string;
  mode: string;
  width: number;
  height: number;
  background: string;
  blockCount: number;
  textPreview?: string;
  contentBounds?: LayoutBounds;
  issues: LayoutIssue[];
  blocks?: LayoutBlock[];
  targets?: LayoutTarget[];
  hasMoreBlocks?: boolean;
}

export interface LayoutReadResult {
  ok: true;
  format: 'layout';
  docId: string;
  revision: number;
  limit: number;
  page?: LayoutPage;
  pages?: LayoutPage[];
  issues: LayoutIssue[];
}

export interface LintReport {
  ok: true;
  format: 'lint';
  docId: string;
  revision: number;
  summary: { pages: number; blocks: number; errors: number; warnings: number; infos: number };
  issues: LayoutIssue[];
}

const DEFAULT_LIMIT = 120;
const TARGET_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'figcaption', 'button', 'a', 'label', 'td', 'th', 'text', 'tspan', 'foreignobject']);
const MATH_TAGS = new Set(['math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'mover', 'munder', 'mtable', 'mtr', 'mtd', 'annotation', 'katex']);
const TEXT_BLOCK_TYPES = new Set(['text', 'markdown', 'code']);

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(500, Math.floor(value!)));
}

function cleanText(value: string | undefined, max = 160): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function boundsOf(block: Pick<HcBlock, 'x' | 'y' | 'w' | 'h'>): LayoutBounds {
  return { x: block.x, y: block.y, w: block.w, h: block.h, right: block.x + block.w, bottom: block.y + block.h };
}

function htmlElementText(html: string | undefined, max = 240): string {
  if (!html) return '';
  const root = parse(html);
  root.querySelectorAll('script, style, noscript').forEach(node => node.remove());
  return cleanText(root.querySelector('body')?.text || root.text, max);
}

function stripMarkdown(source: string | undefined, max = 240): string {
  return cleanText((source || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'), max);
}

function blockPreview(block: HcBlock): string {
  switch (block.type) {
    case 'text': return cleanText(block.text);
    case 'markdown': return stripMarkdown(block.markdown);
    case 'code': return cleanText(block.code, 160);
    case 'html': return htmlElementText(block.html, 240);
    case 'image': return cleanText(block.alt || block.name || 'image', 120);
    case 'math': return cleanText(String(block.data?.tex || ''), 120);
    case 'shape': return cleanText(block.name || block.shape || 'shape', 80);
    default: return cleanText(block.text || block.name || block.type, 120);
  }
}

function targetRole(element: ParsedElement): string {
  const tag = element.tagName.toLowerCase();
  if (element.getAttribute('data-hc-tex')) return 'formula';
  if (tag === 'text' || tag === 'tspan') return 'svg-text';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'p') return 'paragraph';
  if (tag === 'li') return 'list-item';
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'td' || tag === 'th') return 'table-cell';
  if (tag === 'blockquote') return 'quote';
  if (tag === 'figcaption') return 'caption';
  return tag;
}

function htmlTargets(html: string | undefined, limit: number): LayoutTarget[] {
  if (!html) return [];
  const root = parse(html);
  const targets: LayoutTarget[] = [];
  for (const element of root.querySelectorAll('[data-hc-id]')) {
    const tag = element.tagName.toLowerCase();
    const formula = element.getAttribute('data-hc-tex');
    if (!formula && !TARGET_TAGS.has(tag)) continue;
    if (element.closest('.katex, math, semantics, mrow, mi, mo, mn, msup, msub, mfrac, msqrt, mtext, mover, munder, mtable, mtr, mtd, annotation')) continue;
    if (MATH_TAGS.has(tag)) continue;
    const text = cleanText(formula || element.text, 120);
    if (!text) continue;
    targets.push({
      id: element.getAttribute('data-hc-id') || '',
      tag,
      role: targetRole(element),
      ...(formula ? { tex: formula } : { text }),
    });
    if (targets.length >= limit) break;
  }
  return targets;
}

function styleSummary(block: HcBlock): Record<string, string | number> | undefined {
  if (!block.style) return undefined;
  const out: Record<string, string | number> = {};
  for (const key of ['fontSize', 'fontWeight', 'color', 'fill', 'stroke', 'align', 'radius', 'lineHeight']) {
    const value = block.style[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function summarizeBlock(block: HcBlock, targetLimit: number): LayoutBlock {
  const preview = blockPreview(block);
  return {
    id: block.id,
    type: block.type,
    ...(block.name ? { name: block.name } : {}),
    x: block.x,
    y: block.y,
    w: block.w,
    h: block.h,
    z: block.z,
    bounds: boundsOf(block),
    ...(preview ? { preview } : {}),
    ...(styleSummary(block) ? { style: styleSummary(block) } : {}),
    ...(block.type === 'html' ? { targets: htmlTargets(block.html, targetLimit) } : {}),
  };
}

function unionBounds(blocks: HcBlock[]): LayoutBounds | undefined {
  if (!blocks.length) return undefined;
  const x = Math.min(...blocks.map(block => block.x));
  const y = Math.min(...blocks.map(block => block.y));
  const right = Math.max(...blocks.map(block => block.x + block.w));
  const bottom = Math.max(...blocks.map(block => block.y + block.h));
  return { x, y, w: right - x, h: bottom - y, right, bottom };
}

function estimatedTextHeight(block: HcBlock): number {
  const text = block.type === 'markdown' ? stripMarkdown(block.markdown, 100000) : (block.text || block.code || '');
  if (!text) return 0;
  const fontSize = typeof block.style?.fontSize === 'number' ? block.style.fontSize : 16;
  const lineHeight = typeof block.style?.lineHeight === 'number' ? block.style.lineHeight : 1.45;
  const charsPerLine = Math.max(1, Math.floor(block.w / Math.max(6, fontSize * 0.58)));
  let lines = 0;
  for (const line of text.split('\n')) {
    const visual = Array.from(line).reduce((sum, char) => sum + (/[\u2E80-\u9FFF\uF900-\uFAFF]/.test(char) ? 1 : 0.55), 0);
    lines += Math.max(1, Math.ceil(visual / charsPerLine));
  }
  return lines * fontSize * lineHeight;
}

function lintPage(page: HcPage): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const blocks = page.blocks || [];
  if (page.mode !== 'html' && !blocks.length && !cleanText(htmlElementText(page.html, 1000), 1000)) {
    issues.push({ code: 'empty-page', severity: 'warning', message: 'Page has no blocks or content.', pageId: page.id, pageName: page.name });
  }
  for (const block of blocks) {
    if (page.mode === 'canvas' && (block.x < 0 || block.y < 0 || block.x + block.w > page.width || block.y + block.h > page.height)) {
      issues.push({ code: 'block-outside-page', severity: 'warning', message: 'Block is outside the page bounds.', pageId: page.id, pageName: page.name, blockId: block.id });
    }
    if (TEXT_BLOCK_TYPES.has(block.type) && block.h > 0) {
      const estimated = estimatedTextHeight(block);
      if (estimated > block.h * 1.2) {
        issues.push({ code: 'text-overflow', severity: 'warning', message: 'Text may overflow its box (estimated ' + Math.ceil(estimated) + 'px > ' + Math.round(block.h) + 'px).', pageId: page.id, pageName: page.name, blockId: block.id });
      }
    }
    if ((block.type === 'text' || block.type === 'markdown') && !blockPreview(block)) {
      issues.push({ code: 'empty-text', severity: 'info', message: 'Text block is empty.', pageId: page.id, pageName: page.name, blockId: block.id });
    }
  }
  let overlaps = 0;
  for (let i = 0; i < blocks.length && overlaps < 8; i += 1) {
    for (let j = i + 1; j < blocks.length && overlaps < 8; j += 1) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const area = width * height;
      if (area <= 0 || a.w * a.h <= 0 || b.w * b.h <= 0) continue;
      const ratio = area / Math.min(a.w * a.h, b.w * b.h);
      if (ratio < 0.12) continue;
      const contains = (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) ||
        (b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h);
      issues.push({
        code: contains ? 'block-contained' : 'block-overlap',
        severity: contains ? 'info' : 'warning',
        message: 'Blocks overlap by ' + Math.round(ratio * 100) + '%.',
        pageId: page.id,
        pageName: page.name,
        blockId: b.id,
      });
      overlaps += 1;
    }
  }
  return issues;
}

function pageLayout(page: HcPage, limit: number, includeBlocks: boolean): LayoutPage {
  const blocks = page.blocks || [];
  const issues = lintPage(page);
  const summary: LayoutPage = {
    id: page.id,
    name: page.name,
    mode: page.mode,
    width: page.width,
    height: page.height,
    background: page.background,
    blockCount: blocks.length,
    ...(cleanText(page.html ? htmlElementText(page.html, 1600) : '', 160) ? { textPreview: cleanText(page.html ? htmlElementText(page.html, 1600) : '', 160) } : {}),
    ...(unionBounds(blocks) ? { contentBounds: unionBounds(blocks) } : {}),
    issues,
  };
  if (page.mode === 'html') {
    summary.targets = htmlTargets(page.html, limit);
    summary.textPreview = cleanText(htmlElementText(page.html, 4000), 160) || summary.textPreview;
  }
  if (includeBlocks) {
    summary.blocks = blocks.slice(0, limit).map(block => summarizeBlock(block, Math.min(40, limit)));
    summary.hasMoreBlocks = blocks.length > limit;
  } else if (blocks.length) {
    summary.textPreview = cleanText(blocks.map(blockPreview).filter(Boolean).join(' · '), 160) || summary.textPreview;
  }
  return summary;
}

export function buildLayoutRead(doc: HcDocument, options: LayoutReadOptions = {}): LayoutReadResult {
  const limit = clampLimit(options.limit);
  const issues: LayoutIssue[] = [];
  if (options.pageId) {
    const page = doc.pages.find(item => item.id === options.pageId);
    if (!page) throw new Error('Page not found: ' + options.pageId);
    const layout = pageLayout(page, limit, true);
    issues.push(...layout.issues);
    return { ok: true, format: 'layout', docId: doc.id, revision: doc.revision, limit, page: layout, issues };
  }
  const pages = doc.pages.map(page => pageLayout(page, limit, false));
  issues.push(...pages.flatMap(page => page.issues));
  return { ok: true, format: 'layout', docId: doc.id, revision: doc.revision, limit, pages, issues };
}

export function buildLintReport(doc: HcDocument, options: LayoutReadOptions = {}): LintReport {
  const layout = buildLayoutRead(doc, options);
  const pages = layout.page ? [layout.page] : (layout.pages || []);
  const issues = layout.issues;
  return {
    ok: true,
    format: 'lint',
    docId: doc.id,
    revision: doc.revision,
    summary: {
      pages: pages.length,
      blocks: pages.reduce((sum, page) => sum + page.blockCount, 0),
      errors: issues.filter(issue => issue.severity === 'error').length,
      warnings: issues.filter(issue => issue.severity === 'warning').length,
      infos: issues.filter(issue => issue.severity === 'info').length,
    },
    issues,
  };
}
