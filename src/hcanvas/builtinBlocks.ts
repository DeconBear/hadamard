import { renderMarkdownHtml, renderMathHtml } from './markdown.js';
import { curveSvgMarkup } from './curves.js';
import { arcSvgMarkup } from './arcs.js';
import { shapeSvgMarkup, shapeTextMarkup } from './shapes.js';
import { vectorSvgMarkup } from './vector.js';
import { blockPlugin } from './blockPlugins.js';
import type { HcBlock } from './types.js';

export type HcBlockRenderMode = 'export' | 'present';

export interface HcBuiltinBlockDefinition {
  type: string;
  label: string;
  hint: string;
  renderBody(block: HcBlock, mode: HcBlockRenderMode): string;
  summary(block: HcBlock): string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textStyle(block: HcBlock): string {
  const style = block.style || {};
  const parts: string[] = [];
  if (style.fontSize) parts.push('font-size:' + style.fontSize + 'px');
  if (style.fontWeight) parts.push('font-weight:' + style.fontWeight);
  if (style.color) parts.push('color:' + style.color);
  if (style.fontFamily) parts.push('font-family:' + style.fontFamily);
  if (style.align) parts.push('text-align:' + style.align);
  return parts.join(';');
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function textBody(block: HcBlock, mode: HcBlockRenderMode): string {
  if (mode === 'present') {
    return '<div style="padding:4px;font-size:' + (block.style?.fontSize || 20) + 'px;font-weight:' + (block.style?.fontWeight || 400) + ';color:' + escapeHtml(String(block.style?.color || '#1d232e')) + ';white-space:pre-wrap">' + escapeHtml(block.text || '') + '</div>';
  }
  const paragraphs = (block.text || '').split(/\n{2,}/).map(paragraph => '<p style="margin:0">' + escapeHtml(paragraph).replace(/\n/g, '<br>') + '</p>').join('');
  return '<div style="padding:4px;' + textStyle(block) + '">' + paragraphs + '</div>';
}

function markdownBody(block: HcBlock, mode: HcBlockRenderMode): string {
  const html = renderMarkdownHtml(block.markdown || '');
  return '<div class="hc-md" style="' + (mode === 'export' ? textStyle(block) : '') + '">' + html + '</div>';
}

function codeBody(block: HcBlock, mode: HcBlockRenderMode): string {
  const background = mode === 'present' ? 'background:' + escapeHtml(String(block.style?.fill || '#171923')) + ';' : '';
  return '<pre style="margin:0;padding:' + (mode === 'present' ? '20px' : '22px 24px') + ';overflow:hidden;white-space:pre-wrap;font:13px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;' + background + 'color:' + escapeHtml(String(block.style?.color || '#e2e8f0')) + '"><code>' + escapeHtml(block.code || '') + '</code></pre>';
}

function shapeBody(block: HcBlock, mode: HcBlockRenderMode): string {
  const frameLabel = mode === 'export' && block.shape === 'frame'
    ? '<span style="position:absolute;left:10px;top:7px;font:600 11px Inter,sans-serif;color:#525d66;pointer-events:none">' + escapeHtml(block.name || 'Frame') + '</span>'
    : '';
  return '<div style="position:relative;width:100%;height:100%">' + shapeSvgMarkup(block) + frameLabel + (block.shape === 'frame' ? '' : shapeTextMarkup(block)) + '</div>';
}

function imageBody(block: HcBlock): string {
  return '<img src="' + escapeHtml(block.src || '') + '" alt="' + escapeHtml(block.alt || '') + '" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit" />';
}

function pluginSummary(block: HcBlock): string {
  const plugin = blockPlugin(block.type);
  if (!plugin) return block.name || block.type;
  const values = plugin.fields
    ?.map(field => String((block.data || {})[field.key] ?? '').trim())
    .filter(Boolean)
    .slice(0, 2);
  return [plugin.label, ...(values || [])].filter(Boolean).join(' · ');
}

const definitions: HcBuiltinBlockDefinition[] = [
  { type: 'html', label: 'HTML', hint: 'Editable HTML block', renderBody: block => block.html || '', summary: block => stripMarkup(block.html || '').slice(0, 100) },
  { type: 'text', label: 'Text', hint: 'Native text block', renderBody: textBody, summary: block => (block.text || '').replace(/\s+/g, ' ').slice(0, 100) },
  { type: 'markdown', label: 'Markdown', hint: 'Markdown block', renderBody: markdownBody, summary: block => stripMarkup(block.markdown || '').slice(0, 100) },
  { type: 'code', label: 'Code', hint: 'Code block', renderBody: codeBody, summary: block => (block.code || '').split('\n')[0]?.slice(0, 100) || 'code' },
  { type: 'image', label: 'Image', hint: 'Image block', renderBody: imageBody, summary: block => block.alt || block.name || 'image' },
  { type: 'math', label: 'Formula', hint: 'LaTeX formula block', renderBody: block => renderMathHtml(String(block.data?.tex || ''), true), summary: block => 'formula · ' + String(block.data?.tex || '').slice(0, 80) },
  { type: 'curve', label: 'Curve', hint: 'Native cubic Bezier curve', renderBody: block => curveSvgMarkup(block), summary: block => 'curve' },
  { type: 'arc', label: 'Arc', hint: 'Native elliptical arc', renderBody: block => arcSvgMarkup(block), summary: block => 'arc' },
  { type: 'shape', label: 'Shape', hint: 'Shape block', renderBody: shapeBody, summary: block => block.text || block.name || ('shape · ' + (block.shape || 'rect')) },
  { type: 'freehand', label: 'Freehand', hint: 'Native freehand stroke', renderBody: block => vectorSvgMarkup(block), summary: () => 'freehand stroke' },
  { type: 'arrow', label: 'Arrow', hint: 'Native arrow', renderBody: block => vectorSvgMarkup(block), summary: () => 'arrow' },
];

const byType = new Map(definitions.map(definition => [definition.type, definition]));

export function listBuiltinBlockDefinitions(): HcBuiltinBlockDefinition[] {
  return [...definitions];
}

export function builtinBlockDefinition(type: string): HcBuiltinBlockDefinition | null {
  return byType.get(type) || null;
}

export function renderBlockBody(block: HcBlock, mode: HcBlockRenderMode = 'export'): string {
  const definition = builtinBlockDefinition(block.type);
  if (definition) return definition.renderBody(block, mode);
  const plugin = blockPlugin(block.type);
  if (plugin) return plugin.renderHtml(block);
  return '<div style="display:grid;place-items:center;height:100%;border:1px dashed #d9d3c7;border-radius:12px;color:#8a8276;font:12px Inter,sans-serif">Unknown block type: ' + escapeHtml(block.type) + '</div>';
}

export function blockAgentSummary(block: HcBlock): string {
  const definition = builtinBlockDefinition(block.type);
  if (definition) return definition.summary(block) || block.name || definition.label;
  return pluginSummary(block) || block.name || block.type;
}