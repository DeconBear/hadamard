import type { HcBlock, HcShape } from './types.js';

export interface HcShapeDefinition {
  id: HcShape;
  label: string;
  hint: string;
}

export const HCANVAS_SHAPES: HcShapeDefinition[] = [
  { id: 'rect', label: 'Rectangle', hint: 'Rounded card, panel or band' },
  { id: 'ellipse', label: 'Ellipse', hint: 'Circle or oval' },
  { id: 'diamond', label: 'Diamond', hint: 'Decision / emphasis' },
  { id: 'triangle', label: 'Triangle', hint: 'Direction / pyramid' },
  { id: 'parallelogram', label: 'Parallelogram', hint: 'Process step' },
  { id: 'trapezoid', label: 'Trapezoid', hint: 'Funnel stage' },
  { id: 'hexagon', label: 'Hexagon', hint: 'Node / badge' },
  { id: 'octagon', label: 'Octagon', hint: 'Stop / callout' },
  { id: 'star', label: 'Star', hint: 'Highlight / rating' },
  { id: 'cross', label: 'Cross', hint: 'Plus / medical' },
  { id: 'line', label: 'Line', hint: 'Divider / connector' },
  { id: 'frame', label: 'Frame', hint: 'Visual container' },
];

export function isHcShape(value: string | undefined): value is HcShape {
  return Boolean(value && HCANVAS_SHAPES.some(shape => shape.id === value));
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function polygonPoints(shape: HcShape): string {
  switch (shape) {
    case 'triangle': return '50,2 98,98 2,98';
    case 'parallelogram': return '24,3 98,3 76,97 2,97';
    case 'trapezoid': return '24,3 76,3 98,97 2,97';
    case 'hexagon': return '25,3 75,3 98,50 75,97 25,97 2,50';
    case 'octagon': return '30,2 70,2 98,30 98,70 70,98 30,98 2,70 2,30';
    case 'diamond': return '50,2 98,50 50,98 2,50';
    case 'cross': return '35,2 65,2 65,35 98,35 98,65 65,65 65,98 35,98 35,65 2,65 2,35 35,35';
    case 'star': {
      const points: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const radius = index % 2 === 0 ? 48 : 21;
        const angle = -Math.PI / 2 + index * Math.PI / 5;
        points.push((50 + Math.cos(angle) * radius).toFixed(2) + ',' + (50 + Math.sin(angle) * radius).toFixed(2));
      }
      return points.join(' ');
    }
    default: return '';
  }
}

/**
 * Canonical shape geometry for the canvas editor, exports and presentation.
 * Coordinates use a 100x100 viewBox with preserveAspectRatio=none; stroke uses
 * vector-effect=non-scaling-stroke so the visible border keeps its px width.
 */
export function shapeSvgMarkup(block: Pick<HcBlock, 'shape' | 'style'>): string {
  const shape = isHcShape(block.shape) ? block.shape : 'rect';
  const style = block.style || {};
  const fillRaw = shape === 'frame' || shape === 'line' ? 'transparent' : String(style.fill || '#f3e8ff');
  const fill = fillRaw === 'transparent' ? 'none' : escapeAttribute(fillRaw);
  const strokeWidth = Number(style.strokeWidth ?? 0);
  const strokeColor = String(style.stroke || '');
  const hasStroke = strokeWidth > 0 && strokeColor !== '';
  const stroke = hasStroke ? ' stroke="' + escapeAttribute(strokeColor) + '" stroke-width="' + strokeWidth + '" stroke-linejoin="round" vector-effect="non-scaling-stroke"' : ' stroke="none"';
  const dash = hasStroke && style.strokeStyle === 'dashed' ? ' stroke-dasharray="7 5"' : hasStroke && style.strokeStyle === 'dotted' ? ' stroke-dasharray="2 4"' : '';
  const opacity = style.opacity === undefined ? '' : ' opacity="' + Math.max(0, Math.min(1, Number(style.opacity))) + '"';
  const common = ' fill="' + fill + '"' + stroke + dash + opacity;
  let geometry = '';
  if (shape === 'ellipse') {
    geometry = '<ellipse cx="50" cy="50" rx="49" ry="49"' + common + '/>';
  } else if (shape === 'line') {
    geometry = '<line x1="2" y1="98" x2="98" y2="2"' + common + ' stroke-linecap="round"/>';
  } else if (shape === 'rect' || shape === 'frame') {
    const radius = shape === 'frame' ? 8 : Math.max(0, Math.min(50, Number(style.radius ?? 14)));
    const line = hasStroke ? stroke : (shape === 'frame' ? ' stroke="#8a8276" stroke-width="1"' : ' stroke="none"');
    const dashed = shape === 'frame' ? ' stroke-dasharray="7 5"' : dash;
    geometry = '<rect x="1" y="1" width="98" height="98" rx="' + radius + '" fill="' + fill + '"' + line + dashed + opacity + '/>';
  } else {
    geometry = '<polygon points="' + polygonPoints(shape) + '"' + common + '/>';
  }
  return '<svg class="block-shape-svg" width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style="display:block;overflow:visible" aria-hidden="true">' + geometry + '</svg>';
}
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Text overlay used by PowerPoint-style shape labels in editor, exports and Present. */
export function shapeTextMarkup(block: Pick<HcBlock, 'text' | 'style'>): string {
  const style = block.style || {};
  const align = style.align === 'left' ? 'flex-start' : style.align === 'right' ? 'flex-end' : 'center';
  const textAlign = style.align || 'center';
  const font = style.fontFamily ? String(style.fontFamily) : 'Inter, ui-sans-serif, system-ui, sans-serif';
  return '<div class="block-shape-text" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:' + align + ';padding:12px;text-align:' + textAlign + ';font-family:' + escapeAttribute(font) + ';font-size:' + Number(style.fontSize || 18) + 'px;font-weight:' + Number(style.fontWeight || 500) + ';line-height:' + Number(style.lineHeight || 1.25) + ';color:' + escapeAttribute(String(style.color || '#1d232e')) + ';white-space:pre-wrap;pointer-events:none;overflow:hidden">' + escapeText(block.text || '') + '</div>';
}
