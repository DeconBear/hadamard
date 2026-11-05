import type { HcBlock, HcShape } from './types.js';
import { blockFill, gradientSvgDefs, normalizeGradient } from './fill.js';

export type HcShapeCategory = 'Basic' | 'Lines' | 'Flowchart' | 'Stars & Banners' | 'Callouts' | 'Action Buttons';

export const HCANVAS_SHAPE_CATEGORIES: HcShapeCategory[] = ['Basic', 'Lines', 'Flowchart', 'Stars & Banners', 'Callouts', 'Action Buttons'];

export interface HcShapeDefinition {
  id: HcShape;
  label: string;
  hint: string;
  category: HcShapeCategory;
  /** Internal geometry, never offered by the shape picker. */
  hidden?: boolean;
}

export const HCANVAS_SHAPES: HcShapeDefinition[] = [
  { id: 'rect', label: 'Rectangle', hint: 'Rounded card, panel or band', category: 'Basic' },
  { id: 'roundRect', label: 'Rounded rectangle', hint: 'Pill or soft panel', category: 'Basic' },
  { id: 'ellipse', label: 'Ellipse', hint: 'Circle or oval', category: 'Basic' },
  { id: 'triangle', label: 'Triangle', hint: 'Direction / pyramid', category: 'Basic' },
  { id: 'rightTriangle', label: 'Right triangle', hint: 'Corner / ramp', category: 'Basic' },
  { id: 'diamond', label: 'Diamond', hint: 'Decision / emphasis', category: 'Basic' },
  { id: 'parallelogram', label: 'Parallelogram', hint: 'Process step', category: 'Basic' },
  { id: 'trapezoid', label: 'Trapezoid', hint: 'Funnel stage', category: 'Basic' },
  { id: 'pentagon', label: 'Pentagon', hint: 'Badge / node', category: 'Basic' },
  { id: 'hexagon', label: 'Hexagon', hint: 'Node / badge', category: 'Basic' },
  { id: 'octagon', label: 'Octagon', hint: 'Stop / callout', category: 'Basic' },
  { id: 'cross', label: 'Cross', hint: 'Plus / medical', category: 'Basic' },
  { id: 'plus', label: 'Plus', hint: 'Add / expand', category: 'Basic' },
  { id: 'minus', label: 'Minus', hint: 'Remove / collapse', category: 'Basic' },
  { id: 'multiply', label: 'Multiply', hint: 'Close / reject', category: 'Basic' },
  { id: 'divide', label: 'Divide', hint: 'Split / ratio', category: 'Basic' },
  { id: 'equal', label: 'Equals', hint: 'Balance / result', category: 'Basic' },
  { id: 'notEqual', label: 'Not equal', hint: 'Difference / unequal', category: 'Basic' },
  { id: 'heart', label: 'Heart', hint: 'Favorite / like', category: 'Basic' },
  { id: 'cloud', label: 'Cloud', hint: 'Network / idea', category: 'Basic' },
  { id: 'can', label: 'Cylinder', hint: 'Storage / stack', category: 'Basic' },
  { id: 'cube', label: 'Cube', hint: '3D block / package', category: 'Basic' },
  { id: 'note', label: 'Note', hint: 'Sticky note / memo', category: 'Basic' },
  { id: 'arrowRight', label: 'Arrow right', hint: 'Direction / next', category: 'Basic' },
  { id: 'arrowLeft', label: 'Arrow left', hint: 'Direction / back', category: 'Basic' },
  { id: 'chevron', label: 'Chevron', hint: 'Process arrow / banner', category: 'Basic' },
  { id: 'home', label: 'Home', hint: 'Start / house', category: 'Basic' },
  { id: 'pie', label: 'Pie', hint: 'Share / proportion', category: 'Basic' },
  { id: 'donut', label: 'Donut', hint: 'Ratio / ring', category: 'Basic' },
  { id: 'arc', label: 'Arc', hint: 'Segment / gauge', category: 'Basic' },
  { id: 'frame', label: 'Frame', hint: 'Visual container', category: 'Basic' },
  { id: 'line', label: 'Line', hint: 'Divider / connector', category: 'Lines' },
  { id: 'doubleArrow', label: 'Double arrow', hint: 'Two-way connector', category: 'Lines' },
  { id: 'arcLine', label: 'Arc line', hint: 'Curved connector / arc', category: 'Lines' },
  { id: 'polyline', label: 'Polyline', hint: 'Bent multi-point connector', category: 'Lines' },
  { id: 'elbow', label: 'Elbow connector', hint: 'Right-angle connector', category: 'Lines' },
  { id: 'curveLine', label: 'Curve line', hint: 'Smooth connector', category: 'Lines' },
  { id: 'process', label: 'Process', hint: 'Workflow step', category: 'Flowchart' },
  { id: 'decision', label: 'Decision', hint: 'Branch / yes-no', category: 'Flowchart' },
  { id: 'terminator', label: 'Terminator', hint: 'Start / end', category: 'Flowchart' },
  { id: 'data', label: 'Data', hint: 'Input / output', category: 'Flowchart' },
  { id: 'document', label: 'Document', hint: 'Report / output', category: 'Flowchart' },
  { id: 'database', label: 'Database', hint: 'Store / cylinder', category: 'Flowchart' },
  { id: 'manualInput', label: 'Manual input', hint: 'Entry / form', category: 'Flowchart' },
  { id: 'preparation', label: 'Preparation', hint: 'Setup / condition', category: 'Flowchart' },
  { id: 'star', label: 'Star', hint: 'Highlight / rating', category: 'Stars & Banners' },
  { id: 'star4', label: '4-point star', hint: 'Spark / emphasis', category: 'Stars & Banners' },
  { id: 'star5', label: '5-point star', hint: 'Rating / award', category: 'Stars & Banners' },
  { id: 'star6', label: '6-point star', hint: 'Badge / seal', category: 'Stars & Banners' },
  { id: 'star8', label: '8-point star', hint: 'Burst / badge', category: 'Stars & Banners' },
  { id: 'star12', label: '12-point star', hint: 'Seal / highlight', category: 'Stars & Banners' },
  { id: 'star16', label: '16-point star', hint: 'Rosette / seal', category: 'Stars & Banners' },
  { id: 'star24', label: '24-point star', hint: 'Sunburst / seal', category: 'Stars & Banners' },
  { id: 'star32', label: '32-point star', hint: 'Fine sunburst', category: 'Stars & Banners' },
  { id: 'ribbon', label: 'Ribbon', hint: 'Banner / label', category: 'Stars & Banners' },
  { id: 'explosion', label: 'Explosion', hint: 'Impact / burst', category: 'Stars & Banners' },
  { id: 'rectCallout', label: 'Rectangle callout', hint: 'Speech bubble', category: 'Callouts' },
  { id: 'roundCallout', label: 'Rounded callout', hint: 'Soft speech bubble', category: 'Callouts' },
  { id: 'cloudCallout', label: 'Cloud callout', hint: 'Idea bubble', category: 'Callouts' },
  { id: 'thought', label: 'Thought', hint: 'Thinking bubble', category: 'Callouts' },
  { id: 'buttonPlay', label: 'Play button', hint: 'Media / start action', category: 'Action Buttons' },
  { id: 'buttonNext', label: 'Next button', hint: 'Advance / continue', category: 'Action Buttons' },
  { id: 'buttonPrev', label: 'Previous button', hint: 'Go back', category: 'Action Buttons' },
  { id: 'buttonHome', label: 'Home button', hint: 'Return to start', category: 'Action Buttons' },
  { id: 'buttonInfo', label: 'Info button', hint: 'Details / help', category: 'Action Buttons' },
  { id: 'buttonHelp', label: 'Help button', hint: 'Support / question', category: 'Action Buttons' },
  { id: 'polygon', label: 'Polygon', hint: 'Editable cut / point shape', category: 'Basic', hidden: true },
];

export function isHcShape(value: string | undefined): value is HcShape {
  return Boolean(value && HCANVAS_SHAPES.some(shape => shape.id === value));
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const STATIC_POLYGON_POINTS: Partial<Record<HcShape, string>> = {
  triangle: '50,2 98,98 2,98',
  rightTriangle: '2,98 98,98 98,2',
  parallelogram: '24,3 98,3 76,97 2,97',
  trapezoid: '24,3 76,3 98,97 2,97',
  pentagon: '50,2 97,36 79,95 21,95 3,36',
  hexagon: '25,3 75,3 98,50 75,97 25,97 2,50',
  octagon: '30,2 70,2 98,30 98,70 70,98 30,98 2,70 2,30',
  diamond: '50,2 98,50 50,98 2,50',
  cross: '35,2 65,2 65,35 98,35 98,65 65,65 65,98 35,98 35,65 2,65 2,35 35,35',
  plus: '38,2 62,2 62,38 98,38 98,62 62,62 62,98 38,98 38,62 2,62 2,38 38,38',
  minus: '12,38 88,38 88,62 12,62',
  multiply: '20,2 50,32 80,2 98,20 68,50 98,80 80,98 50,68 20,98 2,80 32,50 2,20',
  arrowRight: '2,36 62,36 62,14 98,50 62,86 62,64 2,64',
  arrowLeft: '98,36 38,36 38,14 2,50 38,86 38,64 98,64',
  chevron: '2,2 70,2 98,50 70,98 2,98 30,50',
  home: '50,2 98,42 82,42 82,98 58,98 58,64 42,64 42,98 18,98 18,42 2,42',
  doubleArrow: '2,50 26,18 26,38 74,38 74,18 98,50 74,82 74,62 26,62 26,82',
  ribbon: '2,16 98,16 84,50 98,84 2,84 16,50',
  decision: '50,2 98,50 50,98 2,50',
  data: '24,3 98,3 76,97 2,97',
  manualInput: '2,22 98,2 98,98 2,98',
  preparation: '22,6 78,6 98,50 78,94 22,94 2,50',
};

interface StarSpec {
  spikes: number;
  inner: number;
  outer?: number;
}

const STAR_SPECS: Partial<Record<HcShape, StarSpec>> = {
  star: { spikes: 5, inner: 21 },
  star4: { spikes: 4, inner: 18 },
  star5: { spikes: 5, inner: 23 },
  star6: { spikes: 6, inner: 24 },
  star8: { spikes: 8, inner: 28 },
  star12: { spikes: 12, inner: 30 },
  star16: { spikes: 16, inner: 32 },
  star24: { spikes: 24, inner: 33 },
  star32: { spikes: 32, inner: 34 },
  explosion: { spikes: 12, inner: 24, outer: 49 },
};

function starPolygonPoints(spikes: number, inner: number, outer = 48): string {
  const points: string[] = [];
  for (let index = 0; index < spikes * 2; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + index * Math.PI / spikes;
    points.push((50 + Math.cos(angle) * radius).toFixed(2) + ',' + (50 + Math.sin(angle) * radius).toFixed(2));
  }
  return points.join(' ');
}

function polygonPoints(shape: HcShape): string {
  const staticPoints = STATIC_POLYGON_POINTS[shape];
  if (staticPoints) return staticPoints;
  const star = STAR_SPECS[shape];
  if (star) return starPolygonPoints(star.spikes, star.inner, star.outer);
  return '';
}

const CLOUD_PATH = 'M26,74 C10,74 4,62 6,52 C8,42 18,38 26,40 C28,22 44,12 58,18 C68,6 88,12 90,30 C100,34 98,52 90,58 C94,72 82,80 70,76 C62,86 46,86 38,78 C34,82 28,82 26,74 Z';
const THOUGHT_CLOUD_PATH = 'M28,58 C14,58 8,48 10,40 C12,31 21,28 28,30 C30,15 44,8 56,13 C65,3 82,8 84,23 C93,26 91,41 84,46 C87,58 76,64 66,61 C59,69 45,69 38,62 C34,66 29,64 28,58 Z';
const CLOUD_CALLOUT_PATH = 'M24,70 C9,70 3,59 5,49 C7,39 16,35 24,37 C26,20 41,11 54,17 C64,5 84,11 86,28 C97,32 95,49 87,55 C91,68 79,76 67,72 C59,82 43,82 35,74 C31,78 25,76 24,70 Z';

interface HcShapePaint {
  fill: string;
  hasStroke: boolean;
  strokeColor: string;
  strokeWidth: number;
  stroke: string;
  dash: string;
  opacity: string;
  common: string;
}

function shapePaint(shape: HcShape, block: ShapeGeometryBlock): HcShapePaint {
  const blockStyle = block.style || {};
  const fillRaw = shape === 'frame' || shape === 'line' || shape === 'arcLine' || shape === 'polyline' || shape === 'elbow' || shape === 'curveLine' ? 'transparent' : (normalizeGradient(block.fillGradient) ? blockFill(block as HcBlock) : String(blockStyle.fill || '#f3e8ff'));
  const fill = fillRaw === 'transparent' ? 'none' : escapeAttribute(fillRaw);
  const strokeWidth = Number(blockStyle.strokeWidth ?? 0);
  const strokeColor = String(blockStyle.stroke || '');
  const hasStroke = strokeWidth > 0 && strokeColor !== '';
  const stroke = hasStroke ? ' stroke="' + escapeAttribute(strokeColor) + '" stroke-width="' + strokeWidth + '" stroke-linejoin="round" vector-effect="non-scaling-stroke"' : ' stroke="none"';
  const dash = hasStroke && blockStyle.strokeStyle === 'dashed' ? ' stroke-dasharray="7 5"' : hasStroke && blockStyle.strokeStyle === 'dotted' ? ' stroke-dasharray="2 4"' : '';
  const opacity = blockStyle.opacity === undefined ? '' : ' opacity="' + Math.max(0, Math.min(1, Number(blockStyle.opacity))) + '"';
  const common = ' fill="' + fill + '"' + stroke + dash + opacity;
  return { fill, hasStroke, strokeColor, strokeWidth, stroke, dash, opacity, common };
}

function actionButtonGeometry(shape: HcShape, paint: HcShapePaint): string {
  const glyph = ' fill="#ffffff" stroke="none"' + paint.opacity;
  const disc = '<circle cx="50" cy="50" r="46"' + paint.common + '/>';
  switch (shape) {
    case 'buttonPlay':
      return disc + '<polygon points="39,29 73,50 39,71"' + glyph + '/>';
    case 'buttonNext':
      return disc + '<polygon points="28,29 52,50 28,71"' + glyph + '/><polygon points="52,29 76,50 52,71"' + glyph + '/>';
    case 'buttonPrev':
      return disc + '<polygon points="72,29 48,50 72,71"' + glyph + '/><polygon points="48,29 24,50 48,71"' + glyph + '/>';
    case 'buttonHome':
      return disc + '<polygon points="50,27 72,45 66,45 66,72 56,72 56,58 44,58 44,72 34,72 34,45 28,45"' + glyph + '/>';
    case 'buttonInfo':
      return disc + '<rect x="45" y="43" width="10" height="30" rx="4"' + glyph + '/><circle cx="50" cy="29" r="6"' + glyph + '/>';
    case 'buttonHelp':
      return disc + '<path d="M39,35 C39,24 61,24 61,36 C61,45 51,45 51,54" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round"' + paint.opacity + '/><circle cx="50" cy="68" r="6"' + glyph + '/>';
    default:
      return disc;
  }
}

/**
 * Canonical shape geometry for the canvas editor, exports and presentation.
 * Coordinates use a 100x100 viewBox with preserveAspectRatio=none; stroke uses
 * vector-effect=non-scaling-stroke so the visible border keeps its px width.
 */
type ShapeGeometryBlock = Pick<HcBlock, 'shape' | 'style'> & Partial<Pick<HcBlock, 'id' | 'points' | 'w' | 'h' | 'fillGradient'>>;

export function linePoints(block: Pick<HcBlock, 'points'> & Partial<Pick<HcBlock, 'w' | 'h'>>): Array<{ x: number; y: number }> {
  if (block.points && block.points.length >= 2) return [{ x: block.points[0]!.x, y: block.points[0]!.y }, { x: block.points[1]!.x, y: block.points[1]!.y }];
  return [{ x: 0, y: block.h ?? 100 }, { x: block.w ?? 100, y: 0 }];
}

export function shapeSvgMarkup(block: ShapeGeometryBlock): string {
  const shape = isHcShape(block.shape) ? block.shape : 'rect';
  const style = block.style || {};
  const paint = shapePaint(shape, block);
  const common = paint.common;
  let geometry = '';

  switch (shape) {
    case 'ellipse':
      geometry = '<ellipse cx="50" cy="50" rx="49" ry="49"' + common + '/>';
      break;
    case 'line': {
      const points = linePoints(block);
      const width = Math.max(1, Number(block.w || 100));
      const height = Math.max(1, Number(block.h || 100));
      const x1 = points[0]!.x / width * 100;
      const y1 = points[0]!.y / height * 100;
      const x2 = points[1]!.x / width * 100;
      const y2 = points[1]!.y / height * 100;
      geometry = '<line x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) + '" x2="' + x2.toFixed(2) + '" y2="' + y2.toFixed(2) + '"' + common + ' stroke-linecap="round"/>';
      break;
    }
    case 'arcLine':
      geometry = '<path d="M6,82 A44,44 0 0 1 94,82"' + common + ' stroke-linecap="round"/>';
      break;
    case 'polyline':
      geometry = '<path d="M6,82 L28,38 L52,64 L76,28 L94,52"' + common + ' stroke-linecap="round"/>';
      break;
    case 'elbow':
      geometry = '<path d="M8,80 L8,28 L92,28 L92,76"' + common + ' stroke-linecap="round"/>';
      break;
    case 'curveLine':
      geometry = '<path d="M8,78 C28,10 72,10 92,78"' + common + ' stroke-linecap="round"/>';
      break;
    case 'rect':
    case 'frame': {
      const radius = shape === 'frame' ? 8 : Math.max(0, Math.min(50, Number(style.radius ?? 14)));
      const line = paint.hasStroke ? paint.stroke : (shape === 'frame' ? ' stroke="#8a8276" stroke-width="1"' : ' stroke="none"');
      const dashed = shape === 'frame' ? ' stroke-dasharray="7 5"' : paint.dash;
      geometry = '<rect x="1" y="1" width="98" height="98" rx="' + radius + '" fill="' + paint.fill + '"' + line + dashed + paint.opacity + '/>';
      break;
    }
    case 'roundRect': {
      const radius = Math.max(0, Math.min(50, Number(style.radius ?? 28)));
      geometry = '<rect x="1" y="1" width="98" height="98" rx="' + radius + '"' + common + '/>';
      break;
    }
    case 'process':
      geometry = '<rect x="1" y="1" width="98" height="98" rx="0"' + common + '/>';
      break;
    case 'terminator':
      geometry = '<rect x="1" y="1" width="98" height="98" rx="49"' + common + '/>';
      break;
    case 'can':
    case 'database':
      geometry = '<path d="M12,18 L12,82 A38,12 0 0 0 88,82 L88,18 Z"' + common + '/><ellipse cx="50" cy="18" rx="38" ry="12"' + common + '/>';
      break;
    case 'cube':
      geometry = '<polygon points="18,38 50,20 82,38 50,56"' + common + '/>'
        + '<polygon points="18,38 50,56 50,94 18,76"' + common + '/>'
        + '<polygon points="50,56 82,38 82,76 50,94"' + common + '/>';
      break;
    case 'note':
      geometry = '<polygon points="4,4 74,4 96,26 96,96 4,96"' + common + '/>'
        + '<polygon points="74,4 96,26 74,26"' + common + '/>';
      break;
    case 'document':
      geometry = '<path d="M6,4 L94,4 L94,84 C78,70 62,98 46,84 C32,72 18,94 6,84 Z"' + common + '/>';
      break;
    case 'heart':
      geometry = '<path d="M50,92 C24,72 4,54 4,34 C4,16 20,6 34,10 C42,12 48,18 50,24 C52,18 58,12 66,10 C80,6 96,16 96,34 C96,54 76,72 50,92 Z"' + common + '/>';
      break;
    case 'cloud':
      geometry = '<path d="' + CLOUD_PATH + '"' + common + '/>';
      break;
    case 'pie':
      geometry = '<path d="M50,50 L50,2 A48,48 0 1 1 2,50 Z"' + common + '/>';
      break;
    case 'donut':
      geometry = '<path d="M50,2 A48,48 0 1 0 50,98 A48,48 0 1 0 50,2 Z M50,28 A22,22 0 1 1 50,72 A22,22 0 1 1 50,28 Z" fill-rule="evenodd"' + common + '/>';
      break;
    case 'arc':
      geometry = '<path d="M2,50 A48,48 0 0 1 98,50 L74,50 A24,24 0 0 0 26,50 Z"' + common + '/>';
      break;
    case 'equal':
      geometry = '<rect x="14" y="28" width="72" height="12" rx="4"' + common + '/><rect x="14" y="60" width="72" height="12" rx="4"' + common + '/>';
      break;
    case 'notEqual': {
      const slashColor = paint.hasStroke ? paint.strokeColor : '#1f2430';
      const slashWidth = paint.hasStroke ? paint.strokeWidth : 3;
      geometry = '<rect x="14" y="28" width="72" height="12" rx="4"' + common + '/><rect x="14" y="60" width="72" height="12" rx="4"' + common + '/>'
        + '<line x1="24" y1="84" x2="76" y2="16" stroke="' + escapeAttribute(slashColor) + '" stroke-width="' + slashWidth + '" stroke-linecap="round"' + paint.opacity + '/>';
      break;
    }
    case 'divide':
      geometry = '<circle cx="50" cy="24" r="9"' + common + '/><circle cx="50" cy="76" r="9"' + common + '/><rect x="12" y="44" width="76" height="12" rx="4"' + common + '/>';
      break;
    case 'rectCallout':
      geometry = '<path d="M14,6 H86 A8,8 0 0 1 94,14 V66 A8,8 0 0 1 86,74 H46 L26,94 L30,74 H14 A8,8 0 0 1 6,66 V14 A8,8 0 0 1 14,6 Z"' + common + '/>';
      break;
    case 'roundCallout':
      geometry = '<path d="M50,6 C76,6 96,19 96,40 C96,61 77,74 52,74 C45,74 39,73 34,71 L17,92 L22,66 C10,58 4,49 4,40 C4,19 24,6 50,6 Z"' + common + '/>';
      break;
    case 'cloudCallout':
      geometry = '<path d="' + CLOUD_CALLOUT_PATH + '"' + common + '/><polygon points="30,72 19,96 48,82"' + common + '/>';
      break;
    case 'thought':
      geometry = '<path d="' + THOUGHT_CLOUD_PATH + '"' + common + '/>'
        + '<circle cx="26" cy="78" r="7"' + common + '/>'
        + '<circle cx="17" cy="88" r="5"' + common + '/>'
        + '<circle cx="10" cy="95" r="3.5"' + common + '/>';
      break;
    case 'buttonPlay':
    case 'buttonNext':
    case 'buttonPrev':
    case 'buttonHome':
    case 'buttonInfo':
    case 'buttonHelp':
      geometry = actionButtonGeometry(shape, paint);
      break;
    case 'polygon': {
      const width = Number(block.w || 0);
      const height = Number(block.h || 0);
      const points = (block.points || []).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length >= 3 && width > 0 && height > 0) {
        geometry = '<polygon points="' + points.map(point => (point.x / width * 100).toFixed(2) + ',' + (point.y / height * 100).toFixed(2)).join(' ') + '"' + common + '/>';
      } else {
        geometry = '<polygon points="2,2 98,2 98,98 2,98"' + common + '/>';
      }
      break;
    }
    default: {
      const points = polygonPoints(shape);
      geometry = '<polygon points="' + (points || '2,2 98,2 98,98 2,98') + '"' + common + '/>';
      break;
    }
  }

  return '<svg class="block-shape-svg" width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style="display:block;overflow:visible" aria-hidden="true">' + gradientSvgDefs(block as HcBlock) + geometry + '</svg>';
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