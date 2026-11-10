import { basicSetup, EditorView } from 'codemirror';
import { html as htmlLang } from '@codemirror/lang-html';
import { oneDark } from '@codemirror/theme-one-dark';
import { renderMarkdownHtml, renderMathHtml } from '../markdown.js';
import { installCurveTool } from './curveTool.js';
import { activeLayerId, configureLayersPanel, renderLayersPanel } from './layersPanel.js';
import { blockRenderZ, blocksInStackOrder, isBlockLocked } from '../layers.js';
import { installBlockDirectEdit, updateDirectEditUI } from './blockDirectEdit.js';
import type { HcBlock, HcDocument, HcHtmlPatch, HcOp, HcPage, HcProposal, HcShape } from '../types.js';
import { excalidrawSceneToNativePage, nativeBlocksToExcalidrawScene } from '../sceneBridge.js';
import { boundArrowGeometry, findBindingTarget } from '../bindings.js';
import { HCANVAS_SHAPES, HCANVAS_SHAPE_CATEGORIES, isHcShape, shapeSvgMarkup } from '../shapes.js';
import { insertHtmlPreset, installHtmlHoverHighlight, installHtmlKeyboardShortcuts, type HtmlEditingContext } from './htmlEditing.js';
import { renderHtmlInspectorPanel } from './htmlInspector.js';
import { installFileBrowser, type FileBrowserController } from './fileBrowser.js';
import { createHtmlSelectionEditor } from './htmlSelectionEditor.js';
import { bindSidebarSections } from './sidebarCollapse.js';
import { installPluginSidebar } from './pluginSidebar.js';
import { installPageListInteractions } from './pageListInteractions.js';
import { renderHtmlPageSurface } from './htmlPageReader.js';
import { buildAgentPrompt } from './agentPrompt.js';
import { startShapeTextEdit } from './shapeText.js';
import type { HcBlockPlugin } from '../blockPlugins.js';
import { createShapePicker, type ShapePicker } from './shapePicker.js';
import { createHtmlInsertFlyout } from './htmlInsertFlyout.js';
import { bindComponentPicker, bindPluginInspector, bindPluginPicker, componentPickerMarkup, getPluginCatalog, loadExternalPlugins, pluginInspectorMarkup, pluginPickerMarkup } from './pluginBlocks.js';
import { renderCanvasBlockContent } from './blockRenderers.js';
import { openPluginManager } from './pluginManager.js';
import { openPluginGallery } from './pluginGallery.js';
import { installImageInsert } from './imageInsert.js';
import { bindPluginPagePicker, pluginPagePickerMarkup } from './pluginPages.js';
import { renderPresentCanvasHtml } from './presentCanvas.js';
import { installPresentInteractions, type PresentInteractions } from './presentControls.js';
import { createSliceTool, type SliceTool } from './sliceTool.js';
import { snapMove } from './smartGuides.js';
import { bindResizeHandle as bindBlockResizeHandle, type ResizeDirection } from './resizeHandle.js';
import { addLineEndpointHandles } from './lineEndpoints.js';
import { cloneBlocksForPlacement, parseBlocksFromClipboard, serializeBlocksForClipboard } from '../blockClipboard.js';
import { constrainLinePoint, shapeDragBounds, type HcDragBounds } from '../drawing.js';
import { invertOps as invertDocumentOps } from './documentHistory.js';
import { CANVAS_PAGE_PRESETS, canvasTemplateBlocks, pageTemplateHtml, starterHtml } from './pageTemplates.js';
import { SHORTCUTS_MODAL_HTML } from './shortcuts.js';
import { esc, genId, toHex } from './utils.js';
interface BootConfig { token: string; workspace: string; mode?: string; version?: string; }
interface DocSummary { id: string; title: string; revision: number; pages: number; updatedAt: string; pendingProposals: number; }
interface PresenceEntry { id: string; actor: string; docId: string; docTitle: string; pageId?: string; pageName: string; selection?: string[]; createdAt: string; updatedAt: string; stale: boolean; }
interface MasterSummary { id: string; name: string; mode: string; width: number; height: number; background?: string; createdAt: string; html?: string; blocks?: HcBlock[]; scene?: { elements?: unknown[] }; }
interface ApiErrorShape { error?: string; latestRevision?: number; latestDoc?: HcDocument; }
class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly payload: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}
declare global {
  interface Window {
    hcanvasDesktop?: {
      openProject: (projectPath?: string) => Promise<{ projectPath: string | null; workspace: string } | null>;
      chooseProject: () => Promise<{ projectPath: string | null; workspace: string } | null>;
    chooseDirectory: () => Promise<string | null>;
      listProjects: () => Promise<Array<{ id: string; name: string; projectPath: string; workspacePath: string; runningUrl: string | null; workspaceExists: boolean }>>;
      platform?: string;
    };
  }
}
const boot = JSON.parse(document.getElementById('hc-boot')?.textContent || '{}') as BootConfig;
function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing element #' + id);
  return element as T;
}
function qs<T extends Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}
const clientId = genId('client');
function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
async function api<T = Record<string, unknown>>(pathname: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-hcanvas-token': boot.token };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(pathname, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  const text = await response.text();
  let payload: unknown = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const shape = payload as ApiErrorShape;
    throw new ApiError(shape.error || ('HTTP ' + response.status), response.status, payload);
  }
  return payload as T;
}
interface UiState {
  docs: DocSummary[];
  doc: HcDocument | null;
  activePageId: string | null;
  activeBlockId: string | null;
  selectedBlockIds: string[];
  editing: { pageId: string; blockId?: string } | null;
  selectedHtmlId: string | null;
  iframeDoc: Document | null;
  iframeElement: HTMLIFrameElement | null;
  zoom: number;
  panX: number;
  panY: number;
  fittedPageId: string | null;
  tab: 'inspector' | 'layers' | 'agent' | 'proposals';
  saveKind: 'idle' | 'saving' | 'saved' | 'error';
  context: Record<string, unknown> | null;
  presence: PresenceEntry[];
  masters: MasterSummary[];
  presenting: boolean;
  presentIndex: number;
  sourceModalOpen: boolean;
  tool: 'select' | 'hand' | 'pen' | 'arrow' | 'curve' | 'eraser';
  showGrid: boolean;
  snap: boolean;
  spaceHeld: boolean;
  pendingInsert: HcBlock['type'] | null;
  pendingShape: HcShape | null;
}
interface PageItemCache {
  fingerprint: string;
  item: HTMLDivElement;
  thumb: HTMLDivElement;
  info: HTMLDivElement;
  index: number;
}

const pageItemCache = new Map<string, PageItemCache>();
const htmlCursorCache = new Map<string, { left: number; top: number }>();
let htmlCursorCacheKey = '';
let remoteReloadTimer: ReturnType<typeof setTimeout> | undefined;
let presenceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let pagesRenderTimer: ReturnType<typeof setTimeout> | undefined;

let shapePicker: ShapePicker | null = null;
let fileBrowser: FileBrowserController | null = null;
let presentInteractions: PresentInteractions | null = null;
let sliceTool: SliceTool | null = null;

const state: UiState = {
  docs: [], doc: null, activePageId: null, activeBlockId: null, selectedBlockIds: [], editing: null,
  selectedHtmlId: null, iframeDoc: null, iframeElement: null,
  zoom: 1, panX: 0, panY: 0, fittedPageId: null,
  tab: 'inspector' as 'inspector' | 'layers' | 'agent' | 'proposals', saveKind: 'idle', context: null, presence: [], masters: [],
  presenting: false, presentIndex: 0, sourceModalOpen: false,
  tool: 'select', showGrid: true, snap: true, spaceHeld: false, pendingInsert: null, pendingShape: null,
};
const htmlSelectionEditor = createHtmlSelectionEditor({
  getIframe: () => state.iframeElement || document.querySelector<HTMLIFrameElement>('.html-page-surface iframe'),
  isEditing: () => Boolean(state.editing),
  getDocument: () => state.iframeDoc,
  canEdit: canEditHtmlText,
  startInline: startInlineTextEdit,
  enterEdit: pageId => enterHtmlEdit(pageId),
});
function activePage(): HcPage | null {
  if (!state.doc) return null;
  return state.doc.pages.find(page => page.id === state.activePageId) ?? state.doc.pages[0] ?? null;
}
function activeBlock(): HcBlock | null {
  const page = activePage();
  return page?.blocks?.find(block => block.id === state.activeBlockId) ?? null;
}
function selectedBlocks(): HcBlock[] {
  const page = activePage();
  if (!page?.blocks?.length) return [];
  const ids = new Set(state.selectedBlockIds);
  return page.blocks.filter(block => ids.has(block.id));
}
function setBlockSelection(ids: string[], primaryId?: string | null): void {
  const page = activePage();
  const available = new Set((page?.blocks || []).map(block => block.id));
  const unique = [...new Set(ids)].filter(id => available.has(id));
  state.selectedBlockIds = unique;
  state.activeBlockId = primaryId && unique.includes(primaryId) ? primaryId : unique[unique.length - 1] ?? null;
  state.selectedHtmlId = null;
  document.querySelectorAll<HTMLElement>('.block-wrap').forEach(node => {
    node.classList.toggle('selected', unique.includes(node.dataset.blockId || ''));
  });
  refreshBlockSelectionDecorations();
  if (state.tab === 'layers') renderLayersPanel(); else renderInspector();
  renderTop();
  void syncActive();
}
function expandGroupSelection(block: HcBlock): string[] {
  const page = activePage();
  if (!page || !block.groupId) return [block.id];
  return (page.blocks || []).filter(item => item.groupId === block.groupId).map(item => item.id);
}
function docTitle(): string { return state.doc?.title || 'Untitled canvas'; }
function pageMetrics(page: HcPage): { width: number; height: number; content: { minX: number; minY: number; maxX: number; maxY: number } | null } {
  if (page.mode !== 'infinite') {
    return { width: page.width, height: page.height, content: null };
  }
  const blocks = page.blocks || [];
  if (!blocks.length) return { width: Math.max(3200, page.width), height: Math.max(2400, page.height), content: null };
  const minX = Math.min(...blocks.map(block => block.x));
  const minY = Math.min(...blocks.map(block => block.y));
  const maxX = Math.max(...blocks.map(block => block.x + block.w));
  const maxY = Math.max(...blocks.map(block => block.y + block.h));
  return {
    width: Math.max(3200, Math.ceil(maxX + 1600), page.width),
    height: Math.max(2400, Math.ceil(maxY + 1200), page.height),
    content: { minX, minY, maxX, maxY },
  };
}
function viewportWorldCenter(): { x: number; y: number } {
  const rect = el('viewport').getBoundingClientRect();
  return { x: (rect.width / 2 - state.panX) / state.zoom, y: (rect.height / 2 - state.panY) / state.zoom };
}
function snapCoordinate(value: number): number {
  return state.snap ? Math.round(value / 8) * 8 : Math.round(value);
}
function clampBlockPosition(page: HcPage, block: HcBlock, x: number, y: number): { x: number; y: number } {
  if (page.mode === 'infinite') return { x: snapCoordinate(x), y: snapCoordinate(y) };
  return {
    x: Math.max(0, Math.min(Math.max(0, page.width - block.w), snapCoordinate(x))),
    y: Math.max(0, Math.min(Math.max(0, page.height - block.h), snapCoordinate(y))),
  };
}
function toast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  const root = el('toastRoot');
  Array.from(root.children).find(item => item.textContent === message)?.remove();
  const node = document.createElement('div');
  node.className = 'toast ' + kind;
  node.setAttribute('role', 'status');
  node.textContent = message;
  root.appendChild(node);
  while (root.childElementCount > 3) root.firstElementChild?.remove();
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .2s'; setTimeout(() => node.remove(), 220); }, 3200);
}
function setSaveStatus(message: string, kind: UiState['saveKind'] = 'idle'): void {
  state.saveKind = kind;
  const node = el('saveStatus');
  node.textContent = message;
  node.className = 'save-status' + (kind === 'saving' ? ' saving' : kind === 'error' ? ' error' : '');
}
function patchDocSummary(doc: HcDocument): void {
  const pendingProposals = doc.proposals.filter(proposal => proposal.status === 'pending').length;
  const index = state.docs.findIndex(summary => summary.id === doc.id);
  const summary: DocSummary = { id: doc.id, title: doc.title, revision: doc.revision, pages: doc.pages.length, updatedAt: doc.updatedAt, pendingProposals };
  if (index >= 0) state.docs[index] = summary;
  else state.docs.unshift(summary);
}

async function loadDocs(): Promise<void> {
  const result = await api<{ docs: DocSummary[] }>('/api/docs');
  state.docs = result.docs || [];
}

async function loadMasters(): Promise<void> {
  try {
    const result = await api<{ masters: MasterSummary[] }>('/api/masters');
    state.masters = result.masters || [];
  } catch { /* masters are optional */ }
}

async function openDoc(docId: string, pageId?: string): Promise<void> {
  const result = await api<{ doc: HcDocument }>('/api/docs/' + docId);
  state.doc = result.doc;
  state.activePageId = pageId && result.doc.pages.some(page => page.id === pageId) ? pageId : result.doc.pages[0]?.id || null;
  state.activeBlockId = null;
  state.selectedBlockIds = [];
  state.pendingInsert = null;
  state.pendingShape = null;
  state.editing = null;
  state.selectedHtmlId = null;
  state.iframeDoc = null;
  state.iframeElement = null;
  state.fittedPageId = null;
  undoStack = [];
  redoStack = [];
  patchDocSummary(result.doc);
  renderAll();
  notifyCanvasTab();
  void syncActive();
}

async function initialize(): Promise<void> {
  bindStaticActions();
  const pluginLoad = await loadExternalPlugins(api);
  if (pluginLoad.errors.length) console.warn('hcanvas plugins:', pluginLoad.errors);
  try {
    const context = await api<Record<string, unknown> & { active?: { docId?: string; pageId?: string }; docs?: DocSummary[]; presence?: PresenceEntry[] }>('/api/state');
    state.context = context;
    state.docs = context.docs || [];
    state.presence = context.presence || [];
    const activeId = context.active?.docId || state.docs[0]?.id;
    await loadMasters();
    if (activeId) await openDoc(activeId, context.active?.pageId);
    else renderAll();
    connectEvents();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
    setSaveStatus('Offline', 'error');
  }
  const title = el<HTMLInputElement>('docTitle');
  title.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); title.blur(); }
  });
  title.addEventListener('blur', () => { if (state.doc && title.value.trim() && title.value.trim() !== state.doc.title) void renameDocument(title.value.trim()); });
  window.addEventListener('resize', () => { if (state.presenting) fitPresentPage(); });
  window.addEventListener('keydown', handleGlobalKeydown);
  window.addEventListener('keydown', event => {
    if (event.code !== 'Space') return;
    if (activePage()?.mode === 'whiteboard') return;
    const target = event.target as HTMLElement;
    if (target.matches('input, textarea, [contenteditable="true"], select') || target.closest('.cm-editor')) return;
    state.spaceHeld = true;
    el('viewport').classList.add('tool-hand');
    event.preventDefault();
  });
  window.addEventListener('keyup', event => {
    if (event.code !== 'Space') return;
    state.spaceHeld = false;
    if (state.tool !== 'hand') el('viewport').classList.remove('tool-hand');
  });
  window.addEventListener('beforeunload', () => { if (state.doc) void syncActive(); });
}

const DEFAULT_VECTOR_STROKE = '#1f2430';
const DEFAULT_VECTOR_STROKE_WIDTH = 2;
function viewportToWorldPoint(clientX: number, clientY: number): { x: number; y: number } {
  const rect = el('viewport').getBoundingClientRect();
  return { x: (clientX - rect.left - state.panX) / state.zoom, y: (clientY - rect.top - state.panY) / state.zoom };
}
function blockAtPoint(clientX: number, clientY: number): HcBlock | null {
  const element = document.elementFromPoint(clientX, clientY) as Element | null;
  const wrap = element?.closest('.block-wrap[data-block-id]') as HTMLElement | null;
  const blockId = wrap?.dataset.blockId;
  if (!blockId) return null;
  return activePage()?.blocks?.find(block => block.id === blockId) || null;
}
function beginErase(event: PointerEvent): void {
  const page = activePage();
  if (!page || (page.mode !== 'infinite' && page.mode !== 'canvas')) return;
  const viewport = el('viewport');
  const erased = new Set<string>();
  let pending: { x: number; y: number } | null = null;
  let busy = false;
  const eraseAt = async (clientX: number, clientY: number): Promise<void> => {
    if (busy) { pending = { x: clientX, y: clientY }; return; }
    busy = true;
    let point: { x: number; y: number } | null = { x: clientX, y: clientY };
    while (point) {
      const block = blockAtPoint(point.x, point.y);
      if (block && !erased.has(block.id)) {
        erased.add(block.id);
        state.activeBlockId = state.activeBlockId === block.id ? null : state.activeBlockId;
        await applyOps([{ op: 'delete_block', pageId: page.id, blockId: block.id } as HcOp], { refreshArtboard: true });
      }
      point = pending;
      pending = null;
    }
    busy = false;
  };
  viewport.classList.add('erasing');
  try { viewport.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  const move = (moveEvent: PointerEvent): void => { if (moveEvent.buttons & 1) void eraseAt(moveEvent.clientX, moveEvent.clientY); };
  const up = (): void => {
    viewport.classList.remove('erasing');
    viewport.removeEventListener('pointermove', move);
    viewport.removeEventListener('pointerup', up);
    try { viewport.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    renderInspector();
  };
  void eraseAt(event.clientX, event.clientY);
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('pointerup', up);
}
function beginShapeDraw(startEvent: PointerEvent): void {
  const page = activePage();
  if (!page || (page.mode !== 'infinite' && page.mode !== 'canvas')) return;
  const shape = state.pendingShape || 'rect';
  const viewport = el('viewport');
  const artboard = el('artboard');
  const preview = document.createElement('div');
  preview.className = 'shape-draw-preview';
  preview.innerHTML = shapeSvgMarkup({ shape, style: { fill: '#f3e8ff', stroke: '#a855f7', strokeWidth: 1, radius: 16 } });
  artboard.appendChild(preview);
  const pointForEvent = (event: PointerEvent): { x: number; y: number } => {
    const point = viewportToWorldPoint(event.clientX, event.clientY);
    const x = snapCoordinate(point.x);
    const y = snapCoordinate(point.y);
    return page.mode === 'canvas'
      ? { x: Math.max(0, Math.min(page.width, x)), y: Math.max(0, Math.min(page.height, y)) }
      : { x, y };
  };
  const start = pointForEvent(startEvent);
  let current = { ...start, square: startEvent.shiftKey, fromCenter: startEvent.altKey };
  let bounds: HcDragBounds;
  const updateBounds = (): void => {
    const next = shapeDragBounds(start, current, {
      square: current.square,
      fromCenter: current.fromCenter,
      defaultWidth: shape === 'frame' ? 480 : 240,
      defaultHeight: shape === 'frame' ? 320 : 160,
    });
    bounds = {
      x: snapCoordinate(next.x),
      y: snapCoordinate(next.y),
      w: Math.max(2, snapCoordinate(next.w)),
      h: Math.max(2, snapCoordinate(next.h)),
    };
  };
  const paint = (): void => {
    preview.style.left = bounds.x + 'px';
    preview.style.top = bounds.y + 'px';
    preview.style.width = bounds.w + 'px';
    preview.style.height = bounds.h + 'px';
  };
  updateBounds();
  paint();
  let frame = 0;
  const schedulePaint = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; paint(); });
  };
  const move = (event: PointerEvent): void => {
    current = { ...pointForEvent(event), square: event.shiftKey, fromCenter: event.altKey };
    updateBounds();
    schedulePaint();
  };
  const cleanup = (): void => {
    if (frame) cancelAnimationFrame(frame);
    viewport.removeEventListener('pointermove', move);
    viewport.removeEventListener('pointerup', up);
    viewport.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', escape, true);
    try { viewport.releasePointerCapture(startEvent.pointerId); } catch { /* ignore */ }
    viewport.classList.remove('drawing-shape');
    preview.remove();
    state.pendingInsert = null;
    state.pendingShape = null;
    renderToolbarState();
  };
  const cancel = (): void => cleanup();
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
  };
  const up = (event: PointerEvent): void => {
    move(event);
    updateBounds();
    cleanup();
    const block: HcBlock = {
      id: genId('block'),
      type: 'shape',
      shape,
      ...bounds,
      z: Math.max(0, ...(page.blocks || []).map(item => item.z)) + 1,
      name: HCANVAS_SHAPES.find(item => item.id === shape)?.label || 'Shape', layerId: activeLayerId(page),
      style: { fill: '#f3e8ff', stroke: '#a855f7', strokeWidth: 1, radius: 16 },
    };
    void applyOps([{ op: 'add_block', pageId: page.id, block }], { refreshArtboard: true }).then(result => {
      if (result) setBlockSelection([block.id], block.id);
    });
  };
  viewport.classList.add('drawing-shape');
  try { viewport.setPointerCapture(startEvent.pointerId); } catch { /* ignore */ }
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('pointerup', up);
  viewport.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', escape, true);
}
function beginVectorDraw(startEvent: PointerEvent): void {
  const page = activePage();
  if (!page || page.mode !== 'infinite') return;
  const viewport = el('viewport');
  const artboard = el('artboard');
  const tool = state.tool === 'pen' ? 'freehand' : 'arrow';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'vector-draw-preview');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  const vector = document.createElementNS('http://www.w3.org/2000/svg', tool === 'freehand' ? 'polyline' : 'line');
  const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  vector.setAttribute('fill', 'none');
  vector.setAttribute('stroke', DEFAULT_VECTOR_STROKE);
  vector.setAttribute('stroke-width', String(DEFAULT_VECTOR_STROKE_WIDTH));
  vector.setAttribute('stroke-linecap', 'round');
  vector.setAttribute('stroke-linejoin', 'round');
  head.setAttribute('fill', DEFAULT_VECTOR_STROKE);
  svg.appendChild(vector);
  if (tool === 'arrow') svg.appendChild(head);
  artboard.appendChild(svg);
  const points: Array<{ x: number; y: number }> = [viewportToWorldPoint(startEvent.clientX, startEvent.clientY)];
  const paint = (): void => {
    if (tool === 'freehand') {
      vector.setAttribute('points', points.map(point => point.x + ',' + point.y).join(' '));
      return;
    }
    const start = points[0]!;
    const end = points[points.length - 1]!;
    vector.setAttribute('x1', String(start.x)); vector.setAttribute('y1', String(start.y));
    vector.setAttribute('x2', String(end.x)); vector.setAttribute('y2', String(end.y));
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > 2) {
      const size = Math.min(16, Math.max(6, length * 0.22));
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const left = { x: end.x - size * Math.cos(angle - Math.PI / 6), y: end.y - size * Math.sin(angle - Math.PI / 6) };
      const right = { x: end.x - size * Math.cos(angle + Math.PI / 6), y: end.y - size * Math.sin(angle + Math.PI / 6) };
      head.setAttribute('points', end.x + ',' + end.y + ' ' + left.x + ',' + left.y + ' ' + right.x + ',' + right.y);
    } else head.setAttribute('points', '');
  };
  let frame = 0;
  const schedulePaint = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; paint(); });
  };
  const collect = (event: PointerEvent): void => {
    const coalesced = tool === 'freehand' && typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    const samples = coalesced.length ? coalesced : [event];
    for (const sample of samples) {
      let point = viewportToWorldPoint(sample.clientX, sample.clientY);
      if (tool === 'arrow') {
        if (event.shiftKey) point = constrainLinePoint(points[0]!, point);
        points.splice(1, points.length, point);
      } else {
        const previous = points[points.length - 1]!;
        if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 1.25 / state.zoom && points.length < 5000) points.push(point);
      }
    }
    schedulePaint();
  };
  const cleanup = (): void => {
    if (frame) cancelAnimationFrame(frame);
    viewport.classList.remove('drawing-vector');
    viewport.removeEventListener('pointermove', move);
    viewport.removeEventListener('pointerup', up);
    viewport.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', escape, true);
    try { viewport.releasePointerCapture(startEvent.pointerId); } catch { /* ignore */ }
    svg.remove();
  };
  const cancel = (): void => cleanup();
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
  };
  const move = (event: PointerEvent): void => collect(event);
  const up = (event: PointerEvent): void => {
    collect(event);
    cleanup();
    if (points.length < 2 || (tool === 'arrow' && Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y) < 2)) return;
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const padding = tool === 'arrow' ? 18 : DEFAULT_VECTOR_STROKE_WIDTH + 4;
    const originX = Math.round(Math.min(...xs) - padding);
    const originY = Math.round(Math.min(...ys) - padding);
    const maxX = Math.max(...xs) + padding;
    const maxY = Math.max(...ys) + padding;
    const block: HcBlock = {
      id: genId('block'), type: tool, x: originX, y: originY,
      w: Math.max(8, Math.round(maxX - originX)), h: Math.max(8, Math.round(maxY - originY)),
      z: Math.max(0, ...(page.blocks || []).map(item => item.z)) + 1,
      name: tool === 'freehand' ? 'Freehand' : 'Arrow',
      points: points.map(point => ({ x: point.x - originX, y: point.y - originY })),
      arrowhead: tool === 'arrow' ? 'arrow' : undefined,
      style: { stroke: DEFAULT_VECTOR_STROKE, strokeWidth: DEFAULT_VECTOR_STROKE_WIDTH },
    };
    if (tool === 'arrow') {
      const start = points[0]!;
      const end = points[points.length - 1]!;
      const startTarget = findBindingTarget(page.blocks || [], start.x, start.y, { padding: 18 });
      const endTarget = findBindingTarget(page.blocks || [], end.x, end.y, { padding: 18 });
      block.startBinding = startTarget?.id ?? null;
      block.endBinding = endTarget?.id ?? null;
      const geometry = boundArrowGeometry(block, page.blocks || []);
      if (geometry) {
        block.x = geometry.x; block.y = geometry.y; block.w = geometry.w; block.h = geometry.h; block.points = geometry.points;
        if (geometry.clearStart) block.startBinding = null;
        if (geometry.clearEnd) block.endBinding = null;
      }
    }
    void applyOps([{ op: 'add_block', pageId: page.id, block } as HcOp], { refreshArtboard: true }).then(result => {
      if (result) setBlockSelection([block.id], block.id);
    });
  };
  paint();
  viewport.classList.add('drawing-vector');
  try { viewport.setPointerCapture(startEvent.pointerId); } catch { /* ignore */ }
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('pointerup', up);
  viewport.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', escape, true);
}
function beginMarquee(event: PointerEvent): void {
  const page = activePage();
  if (!page || (page.mode !== 'infinite' && page.mode !== 'canvas')) return;
  const viewport = el('viewport');
  const box = document.createElement('div');
  box.className = 'marquee-box';
  viewport.appendChild(box);
  const start = { x: event.clientX, y: event.clientY };
  let moved = false;
  const updateBox = (clientX: number, clientY: number): void => {
    const rect = viewport.getBoundingClientRect();
    const left = Math.min(start.x, clientX) - rect.left;
    const top = Math.min(start.y, clientY) - rect.top;
    box.style.left = left + 'px'; box.style.top = top + 'px';
    box.style.width = Math.abs(clientX - start.x) + 'px'; box.style.height = Math.abs(clientY - start.y) + 'px';
  };
  updateBox(start.x, start.y);
  try { viewport.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  const move = (moveEvent: PointerEvent): void => {
    if (Math.abs(moveEvent.clientX - start.x) > 3 || Math.abs(moveEvent.clientY - start.y) > 3) moved = true;
    updateBox(moveEvent.clientX, moveEvent.clientY);
  };
  const up = (upEvent: PointerEvent): void => {
    viewport.removeEventListener('pointermove', move);
    viewport.removeEventListener('pointerup', up);
    try { viewport.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    box.remove();
    if (!moved) { setBlockSelection([]); return; }
    const a = viewportToWorldPoint(start.x, start.y);
    const b = viewportToWorldPoint(upEvent.clientX, upEvent.clientY);
    const minX = Math.min(a.x, b.x); const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y); const maxY = Math.max(a.y, b.y);
    const hits = (page.blocks || []).filter(block => block.x + block.w >= minX && block.x <= maxX && block.y + block.h >= minY && block.y <= maxY);
    const ids = new Set<string>();
    for (const block of hits) for (const id of expandGroupSelection(block)) ids.add(id);
    if (upEvent.shiftKey) for (const id of state.selectedBlockIds) ids.add(id);
    setBlockSelection([...ids], hits[hits.length - 1]?.id ?? null);
  };
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('pointerup', up);
}

interface SidebarPrefs {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}
function initSidebarLayout(): void {
  const app = el('app');
  const defaults: SidebarPrefs = { leftWidth: 244, rightWidth: 326, leftCollapsed: false, rightCollapsed: false };
  let prefs = defaults;
  try {
    const saved = JSON.parse(localStorage.getItem('hcanvas.sidebar.v1') || 'null') as Partial<SidebarPrefs> | null;
    if (saved) prefs = { ...defaults, ...saved };
  } catch { /* ignore */ }
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(value)));
  const apply = (): void => {
    prefs.leftWidth = clamp(prefs.leftWidth, 180, 420);
    prefs.rightWidth = clamp(prefs.rightWidth, 260, 520);
    app.style.gridTemplateColumns = (prefs.leftCollapsed ? '0px' : prefs.leftWidth + 'px') + ' minmax(0, 1fr) ' + (prefs.rightCollapsed ? '0px' : prefs.rightWidth + 'px');
    app.classList.toggle('left-collapsed', prefs.leftCollapsed);
    app.classList.toggle('right-collapsed', prefs.rightCollapsed);
    const leftToggle = qs<HTMLButtonElement>('#toggleLeftSidebarBtn');
    const rightToggle = qs<HTMLButtonElement>('#toggleRightSidebarBtn');
    if (leftToggle) { leftToggle.classList.toggle('active', prefs.leftCollapsed); leftToggle.title = prefs.leftCollapsed ? 'Show left sidebar' : 'Collapse left sidebar'; }
    if (rightToggle) { rightToggle.classList.toggle('active', prefs.rightCollapsed); rightToggle.title = prefs.rightCollapsed ? 'Show right sidebar' : 'Collapse right sidebar'; }
  };
  const save = (): void => { try { localStorage.setItem('hcanvas.sidebar.v1', JSON.stringify(prefs)); } catch { /* ignore */ } };
  const bindResize = (resizerId: string, side: 'left' | 'right'): void => {
    const resizer = qs<HTMLElement>('#' + resizerId);
    if (!resizer) return;
    resizer.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = side === 'left' ? prefs.leftWidth : prefs.rightWidth;
      resizer.setPointerCapture(event.pointerId);
      document.body.classList.add('sidebar-resizing');
      const move = (moveEvent: PointerEvent): void => {
        const delta = moveEvent.clientX - startX;
        if (side === 'left') prefs.leftWidth = clamp(startWidth + delta, 180, 420);
        else prefs.rightWidth = clamp(startWidth - delta, 260, 520);
        apply();
      };
      const up = (): void => {
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', up);
        document.body.classList.remove('sidebar-resizing');
        save();
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', up);
    });
    resizer.addEventListener('dblclick', () => {
      if (side === 'left') prefs.leftCollapsed = !prefs.leftCollapsed;
      else prefs.rightCollapsed = !prefs.rightCollapsed;
      apply();
      save();
    });
  };
  qs<HTMLButtonElement>('#toggleLeftSidebarBtn')?.addEventListener('click', () => { prefs.leftCollapsed = !prefs.leftCollapsed; apply(); save(); });
  qs<HTMLButtonElement>('#toggleRightSidebarBtn')?.addEventListener('click', () => { prefs.rightCollapsed = !prefs.rightCollapsed; apply(); save(); });
  bindResize('leftbarResizer', 'left');
  bindResize('rightbarResizer', 'right');
  apply();
}
function bindStaticActions(): void {
  initSidebarLayout();
  shapePicker = createShapePicker({ onChoose: shape => { state.pendingShape = shape; requestInsert('shape'); } });
  createHtmlInsertFlyout(el('htmlInsertBtn'), htmlEditingContext(), presetId => { void insertHtmlPreset(presetId, htmlEditingContext()); });
  installImageInsert({
    getPage: activePage,
    getPoint: viewportToWorldPoint,
    getCenter: viewportWorldCenter,
    addImage: (src, alt, w, h, point) => addBlock('image', { src, alt, w, h }, point),
    onPasteText: text => {
      const blocks = text ? parseBlocksFromClipboard(text) : null;
      if (blocks?.length) { void pasteBlock(text); return true; }
      if (!text && clipboardBlocks.length) { void pasteBlock(); return true; }
      return false;
    },
    toast,
  });
  el('newDocBtn').addEventListener('click', () => openNewDocModal());
  el('newDocMini').addEventListener('click', () => openNewDocModal());
  el('addPageBtn').addEventListener('click', () => openAddPageModal());
  el('projectMenuBtn').addEventListener('click', event => { event.stopPropagation(); void openProjectHub(); });
  el('openProjectFolderBtn').addEventListener('click', () => { void revealProjectFolder(undefined, 'project'); });
  qs<HTMLButtonElement>('#hubCloseBtn')?.addEventListener('click', () => closeProjectHub());
  qs<HTMLButtonElement>('#hubRefreshBtn')?.addEventListener('click', () => { void renderProjectHub(); });
  qs<HTMLButtonElement>('#hubNewProjectBtn')?.addEventListener('click', () => {
    if (window.hcanvasDesktop) void window.hcanvasDesktop.chooseProject();
    else toast('Browser mode: run hcanvas app --project <folder> to create a project.', 'info');
  });
  el('workspacePath').addEventListener('click', () => { void openWorkspaceModal(); });
  el('addPageMini').addEventListener('click', () => openAddPageModal());
  bindSidebarSections();
  installPageListInteractions({
    root: el('pagesList'),
    onReorder: (pageId, index) => movePageToIndex(pageId, index),
    onDuplicate: pageId => { const page = state.doc?.pages.find(item => item.id === pageId); if (page) duplicatePage(page); },
    onDelete: pageId => { void confirmDialog('Delete this page?').then(ok => { if (ok) void deletePage(pageId); }); },
    canDelete: () => (state.doc?.pages.length || 0) > 1,
  });
  installPluginSidebar({ request: api, openModal: html => openModal(html), closeModal: () => closeModal(), confirm: message => confirmDialog(message), toast, reload: () => loadExternalPlugins(api), onChanged: () => renderInspector() });
  fileBrowser = installFileBrowser({
    mount: el('filesPanel'), tabs: el('workspaceTabs'), viewport: el('viewport'),
    request: api, toast, chooseDirectory: () => window.hcanvasDesktop?.chooseDirectory?.() ?? null,
    serveUrl: (rootId, filePath) => '/api/files/raw/' + encodeURIComponent(rootId) + '/' + encodeURIComponent(boot.token) + '/' + filePath.split('/').map(encodeURIComponent).join('/'),
    canvasLabel: () => activePage()?.name || state.doc?.title || 'Canvas',
    onShowCanvas: () => { renderArtboard(); },
    openCanvas: (docId, pageId) => { void openDoc(docId, pageId); },
  });
  el('presentBtn').addEventListener('click', () => openPresent());
  sliceTool = createSliceTool({
    viewport: el('viewport'),
    getPage: activePage,
    getBlock: id => activePage()?.blocks?.find(block => block.id === id) || null,
    getPoint: viewportToWorldPoint,
    nextId: genId,
    applyOps: ops => applyOps(ops, { refreshArtboard: true }).then(Boolean),
    selectBlocks: (ids, primaryId) => setBlockSelection(ids, primaryId),
    toast,
  });
  installBlockDirectEdit({ viewport: el('viewport'), getPage: activePage, getBlocks: () => activePage()?.blocks || [], getSelectedIds: () => state.selectedBlockIds, getWorldPoint: viewportToWorldPoint, getZoom: () => state.zoom, isLocked: id => { const pg = activePage(); const item = pg?.blocks?.find(block => block.id === id); return Boolean(pg && item && isBlockLocked(pg, item)); }, select: (ids, primary) => setBlockSelection(ids, primary), applyOps: ops => applyOps(ops, { refreshArtboard: true }).then(Boolean), edit: editActiveBlock, duplicate: () => { void duplicateActiveBlock(); }, remove: () => { void deleteSelectedBlocks(); }, toast });
  configureLayersPanel({
    panel: el('layersPanel'), getPage: activePage, getSelectedIds: () => state.selectedBlockIds,
    select: (ids, primary) => setBlockSelection(ids, primary),
    applyOps: ops => applyOps(ops, { refreshArtboard: true }).then(Boolean), toast,
  });
  installCurveTool({
    viewport: el('viewport'), artboard: el('artboard'), getPage: activePage, getWorldPoint: viewportToWorldPoint, getZoom: () => state.zoom, nextId: () => genId('block'), layerId: () => activeLayerId(activePage()),
    canDraw: () => state.tool === 'curve' && !state.editing,
    createBlock: block => { void applyOps([{ op: 'add_block', pageId: activePage()!.id, block } as HcOp], { refreshArtboard: true }).then(result => { if (result) setBlockSelection([block.id], block.id); }); },
  });
  presentInteractions = installPresentInteractions({
    root: el('presentRoot'),
    isActive: () => state.presenting,
    next: delta => nextPresent(delta),
    close: () => closePresent(),
    toggleNotes: () => togglePresentNotes(),
    canPrev: () => Boolean(state.doc && state.presentIndex > 0),
    canNext: () => Boolean(state.doc && state.presentIndex < state.doc.pages.length - 1),
  });
  el('exportBtn').addEventListener('click', event => { event.stopPropagation(); toggleExportMenu(); });
  document.addEventListener('click', event => {
    const menu = el('exportMenu');
    if (!menu.classList.contains('hidden') && !(event.target as Element).closest('.menu-wrap')) toggleExportMenu(false);
  });
  el('exportMenu').addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest('[data-export]') as HTMLElement | null;
    if (!target) return;
    toggleExportMenu(false);
    void exportCurrent(target.dataset.export || 'html', { bleedMm: Number(target.dataset.bleed || 0), cropMarks: target.dataset.crop === '1' });
  });
  el('zoomIn').addEventListener('click', () => setZoom(state.zoom * 1.15));
  el('zoomOut').addEventListener('click', () => setZoom(state.zoom / 1.15));
  el('zoomReset').addEventListener('click', () => setZoom(1));
  el('zoomFit').addEventListener('click', () => fitPage());
  el('doneEditingBtn').addEventListener('click', () => exitHtmlEdit());
  el('editSourceBtn').addEventListener('click', () => {
    if (!state.editing) return;
    openSourceEditor({ pageId: state.editing.pageId, blockId: state.editing.blockId });
  });
  el('toolRail').addEventListener('click', event => {
    const tool = (event.target as HTMLElement).closest('[data-tool]') as HTMLElement | null;
    if (tool) {
      cancelInsert();
      const next = tool.dataset.tool;
      state.tool = next === 'hand' || next === 'pen' || next === 'arrow' || next === 'curve' || next === 'eraser' ? next : 'select';
      renderToolbarState();
      return;
    }
    const blockButton = (event.target as HTMLElement).closest('[data-block]') as HTMLElement | null;
    if (blockButton) {
      const blockType = blockButton.dataset.block as HcBlock['type'];
      if (blockType === 'shape') openShapePicker();
      else requestInsert(blockType);
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest('#toggleGrid')) { state.showGrid = !state.showGrid; renderArtboard(); renderToolbarState(); return; }
    if (target.closest('#toggleSnap')) { state.snap = !state.snap; renderToolbarState(); toast(state.snap ? 'Snap: 8px' : 'Snap off', 'info'); return; }
    if (target.closest('#shortcutsBtn')) { openShortcutsModal(); }
  });
  qs<HTMLButtonElement>('#undoBtn')?.addEventListener('click', () => { void undo(); });
  qs<HTMLButtonElement>('#redoBtn')?.addEventListener('click', () => { void redo(); });
  el('selectionToolbar').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest('[data-sel-action]') as HTMLElement | null;
    if (!button) return;
    const action = button.dataset.selAction;
    if (action === 'edit') { editActiveBlock(); return; }
    if (action === 'slice') { const block = activeBlock(); if (block) sliceTool?.begin(block); return; }
    if (action === 'group') { void groupSelectedBlocks(); return; }
    if (action === 'ungroup') { void ungroupSelectedBlocks(); return; }
    if (action === 'duplicate') { void duplicateActiveBlock(); return; }
    if (action === 'front') { void setActiveBlockLayer('front'); return; }
    if (action === 'back') { void setActiveBlockLayer('back'); return; }
    if (action === 'delete') { void deleteSelectedBlocks(); }
  });
  el('alignSelect').addEventListener('change', event => {
    const value = (event.target as HTMLSelectElement).value;
    if (value) void alignActiveBlock(value);
    (event.target as HTMLSelectElement).value = '';
  });
  qs<HTMLDivElement>('.tabs')?.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
    if (!target) return;
    state.tab = target.dataset.tab as UiState['tab'];
    renderTabs();
    renderActivePanel();
  });
  const viewport = el('viewport');
  const beginPan = (event: PointerEvent): void => {
    const start = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
    viewport.classList.add('panning');
    try { viewport.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    const move = (moveEvent: PointerEvent): void => {
      state.panX = start.panX + moveEvent.clientX - start.x;
      state.panY = start.panY + moveEvent.clientY - start.y;
      scheduleStageTransform();
    };
    const stop = (): void => {
      viewport.classList.remove('panning');
      viewport.removeEventListener('pointermove', move);
      viewport.removeEventListener('pointerup', stop);
      viewport.removeEventListener('pointercancel', stop);
      try { viewport.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    };
    viewport.addEventListener('pointermove', move);
    viewport.addEventListener('pointerup', stop);
    viewport.addEventListener('pointercancel', stop);
  };
  viewport.addEventListener('pointerdown', event => {
    if (!state.pendingInsert || event.button !== 0) return;
    if ((event.target as Element).closest('.tool-rail, .selection-toolbar, .zoom-controls, .editing-banner, .infinite-badge, .block-toolbar, .agent-cursor, .hc-node-handle, .hc-rotate-handle')) return;
    event.preventDefault();
    event.stopPropagation();
    const type = state.pendingInsert;
    if (type === 'shape') {
      beginShapeDraw(event);
      return;
    }
    state.pendingInsert = null;
    state.pendingShape = null;
    const point = viewportToWorldPoint(event.clientX, event.clientY);
    renderToolbarState();
    void addBlock(type, {}, point);
  }, { capture: true });
  viewport.addEventListener('pointerdown', event => {
    const targetElement = event.target as Element;
    if (targetElement.closest('.tool-rail, .selection-toolbar, .zoom-controls, .editing-banner, .infinite-badge, .block-toolbar, .agent-cursor, .hc-node-handle, .hc-rotate-handle')) return;
    if (event.button === 1) {
      if (activePage()?.mode === 'whiteboard' || targetElement.closest('.whiteboard-host')) return;
      event.preventDefault();
      beginPan(event);
      return;
    }
    const panMode = state.tool === 'hand' || state.spaceHeld;
    if (event.button !== 0 || !panMode) return;
    event.preventDefault();
    beginPan(event);
  });
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || state.tool !== 'select' || state.spaceHeld || state.editing) return;
    const target = event.target as Element;
    if (target.closest('.tool-rail, .selection-toolbar, .zoom-controls, .editing-banner, .infinite-badge, .block-toolbar, .agent-cursor, .hc-node-handle, .hc-rotate-handle, .block-wrap')) return;
    event.preventDefault();
    beginMarquee(event);
  });
  viewport.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
  viewport.addEventListener('wheel', event => {
    const targetElement = event.target as Element;
    if (targetElement.closest('.tool-rail, .selection-toolbar, .zoom-controls, .editing-banner, .infinite-badge, .block-toolbar, .agent-cursor, .hc-node-handle, .hc-rotate-handle')) return;
    if (activePage()?.mode === 'whiteboard' || targetElement.closest('.whiteboard-host')) return;
    // Let an HTML page own wheel scrolling in browse mode; canvas zoom remains available in edit mode.
    if (activePage()?.mode === 'html' && !state.editing) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1;
    const deltaX = event.deltaX * unit;
    const deltaY = event.deltaY * unit;
    if (event.shiftKey) {
      state.panX -= Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
      scheduleStageTransform();
      return;
    }
    setZoomAt(state.zoom * Math.exp(-deltaY * 0.002), event.clientX, event.clientY);
  }, { passive: false });
  // Eraser removes blocks under the pointer in a drag gesture.
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || state.tool !== 'eraser') return;
    if (activePage()?.mode !== 'infinite' || state.editing) return;
    if ((event.target as Element).closest('.tool-rail, .selection-toolbar, .zoom-controls, .editing-banner, .block-toolbar, .agent-cursor, .hc-node-handle, .hc-rotate-handle')) return;
    event.preventDefault();
    event.stopPropagation();
    beginErase(event);
  }, { capture: true });
  // Native vector tools draw above existing blocks, so capture the pointer before
  // block selection/drag handlers can claim it.
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (state.tool !== 'pen' && state.tool !== 'arrow')) return;
    if (activePage()?.mode !== 'infinite' || state.editing) return;
    if ((event.target as Element).closest('.tool-rail, .selection-toolbar, .zoom-controls, .editing-banner, .block-toolbar, .agent-cursor, .hc-node-handle, .hc-rotate-handle')) return;
    event.preventDefault();
    event.stopPropagation();
    beginVectorDraw(event);
  }, { capture: true });
  window.addEventListener('resize', () => { resizeWhiteboardSurface(); });
}
function viewportWorldBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
  const rect = el('viewport').getBoundingClientRect();
  return {
    minX: (0 - state.panX) / state.zoom,
    minY: (0 - state.panY) / state.zoom,
    maxX: (rect.width - state.panX) / state.zoom,
    maxY: (rect.height - state.panY) / state.zoom,
  };
}
function renderToolbarState(): void {
  const page = activePage();
  const block = activeBlock();
  document.querySelectorAll<HTMLElement>('[data-tool]').forEach(button => {
    button.classList.toggle('active', button.dataset.tool === state.tool);
    if (button.dataset.tool === 'pen' || button.dataset.tool === 'arrow' || button.dataset.tool === 'eraser') button.classList.toggle('disabled', page?.mode !== 'infinite');
    if (button.dataset.tool === 'curve') button.classList.toggle('disabled', page?.mode !== 'infinite' && page?.mode !== 'canvas');
  });
  updateHistoryButtons();
  const placing = Boolean(state.pendingInsert);
  el('viewport').classList.toggle('placing-block', placing);
  document.querySelectorAll<HTMLElement>('[data-block]').forEach(button => button.classList.toggle('placing', button.dataset.block === state.pendingInsert));
  el('viewport').classList.toggle('tool-pen', state.tool === 'pen' && page?.mode === 'infinite');
  el('viewport').classList.toggle('tool-arrow', state.tool === 'arrow' && page?.mode === 'infinite');
  el('viewport').classList.toggle('tool-curve', state.tool === 'curve' && (page?.mode === 'infinite' || page?.mode === 'canvas'));
  el('viewport').classList.toggle('tool-eraser', state.tool === 'eraser' && page?.mode === 'infinite');
  el('toggleGrid').classList.toggle('active', state.showGrid);
  el('toggleSnap').classList.toggle('active', state.snap);
  el('infiniteBadge').classList.toggle('hidden', page?.mode !== 'infinite');
  document.querySelectorAll<HTMLElement>('[data-block]').forEach(button => {
    button.classList.toggle('disabled', page?.mode === 'whiteboard' || page?.mode === 'html');
  });
  el('viewport').classList.toggle('tool-hand', state.tool === 'hand' || state.spaceHeld);
  const selection = el('selectionToolbar');
  const selectedCount = selectedBlocks().length;
  const showSelection = Boolean(block) && !state.editing && !state.presenting;
  selection.classList.toggle('hidden', !showSelection);
  if (block) {
    const editButton = el('selEditBtn');
    editButton.textContent = block.type === 'html' ? 'Edit HTML' : block.type === 'shape' ? 'Edit text' : block.type === 'math' ? 'Edit formula' : block.type === 'markdown' || block.type === 'code' || block.type === 'text' ? 'Edit source' : block.type === 'image' ? 'Image' : 'Style';
    editButton.style.display = selectedCount > 1 ? 'none' : '';
    const sliceButton = qs<HTMLElement>('#selSliceBtn');
    if (sliceButton) sliceButton.style.display = selectedCount === 1 && block.type === 'shape' && (block.shape === 'rect' || block.shape === 'polygon') && !block.rotation ? '' : 'none';
    qs<HTMLElement>('[data-sel-action="group"]')?.style.setProperty('display', selectedCount > 1 ? '' : 'none');
    qs<HTMLElement>('[data-sel-action="ungroup"]')?.style.setProperty('display', selectedCount > 1 ? '' : 'none');
  }
  updateDirectEditUI();
}
function editActiveBlock(): void {
  const page = activePage();
  const block = activeBlock();
  if (!page || !block) return;
  if (block.type === 'html') enterHtmlEdit(page.id, block.id);
  else if (block.type === 'shape') {
    const wrap = qs<HTMLDivElement>('.block-wrap[data-block-id="' + block.id + '"]');
    if (wrap) startShapeTextEdit(block, wrap, { getDoc: () => state.doc, commit: (target, patch, historyBase) => { void persistBlock(target, patch, historyBase || undefined); } });
  }
  else if (block.type === 'markdown' || block.type === 'code' || block.type === 'text') openSourceEditor({ pageId: page.id, blockId: block.id });
  else if (block.type === 'math') openFormulaModal(block);
  else if (block.type === 'image') openImageModal(block);
  else renderInspector();
}

async function copySelectedBlocks(cut = false): Promise<void> {
  const page = activePage();
  const blocks = selectedBlocks();
  if (!page || !blocks.length || page.mode === 'html' || page.mode === 'whiteboard') return;
  clipboardBlocks = cloneJson(blocks);
  clipboardPasteCount = 0;
  try { await navigator.clipboard?.writeText(serializeBlocksForClipboard(blocks)); } catch { /* in-memory clipboard remains available */ }
  if (cut) {
    const result = await applyOps(blocks.map(block => ({ op: 'delete_block', pageId: page.id, blockId: block.id } as HcOp)), { refreshArtboard: true });
    if (!result) return;
    setBlockSelection([]);
  }
  toast((cut ? 'Cut ' : 'Copied ') + blocks.length + ' block' + (blocks.length === 1 ? '' : 's'), 'info');
}

async function pasteBlock(clipboardText?: string): Promise<void> {
  const page = activePage();
  if (!page || page.mode === 'html' || page.mode === 'whiteboard') return;
  let source = clipboardText ? (parseBlocksFromClipboard(clipboardText) || []) : clipboardBlocks;
  if (!source.length && !clipboardText) {
    try { source = parseBlocksFromClipboard(await navigator.clipboard?.readText() || '') || []; } catch { source = []; }
  }
  if (!source.length) return;
  clipboardPasteCount += 1;
  const offset = 24 * clipboardPasteCount;
  const copies = cloneBlocksForPlacement(source, {
    offsetX: offset,
    offsetY: offset,
    nextZ: Math.max(0, ...(page.blocks || []).map(block => block.z)) + 1,
    createId: genId,
  });
  for (const copy of copies) {
    const next = clampBlockPosition(page, copy, copy.x, copy.y);
    copy.x = next.x;
    copy.y = next.y;
  }
  const result = await applyOps(copies.map(copy => ({ op: 'add_block', pageId: page.id, block: copy } as HcOp)), { refreshArtboard: true });
  if (result) setBlockSelection(copies.map(copy => copy.id), copies[copies.length - 1]?.id ?? null);
}

async function groupSelectedBlocks(): Promise<void> {
  const page = activePage();
  const blocks = selectedBlocks();
  if (!page || blocks.length < 2) { toast('Select at least two blocks to group.', 'info'); return; }
  const groupId = genId('group');
  await applyOps(blocks.map(block => ({ op: 'update_block', pageId: page.id, blockId: block.id, patch: { groupId } } as HcOp)), { refreshArtboard: true });
  renderInspector();
  toast('Grouped ' + blocks.length + ' blocks', 'success');
}

async function ungroupSelectedBlocks(): Promise<void> {
  const page = activePage();
  const blocks = selectedBlocks().filter(block => block.groupId);
  if (!page || !blocks.length) { toast('No grouped blocks selected.', 'info'); return; }
  await applyOps(blocks.map(block => ({ op: 'update_block', pageId: page.id, blockId: block.id, patch: { groupId: null } } as HcOp)), { refreshArtboard: true });
  renderInspector();
  toast('Ungrouped ' + blocks.length + ' blocks', 'success');
}

async function deleteSelectedBlocks(): Promise<void> {
  const page = activePage();
  const blocks = selectedBlocks();
  if (!page || !blocks.length) return;
  await applyOps(blocks.map(block => ({ op: 'delete_block', pageId: page.id, blockId: block.id } as HcOp)), { refreshArtboard: true });
  setBlockSelection([]);
}

async function duplicateActiveBlock(): Promise<void> {
  const page = activePage();
  const blocks = selectedBlocks();
  if (!page || !blocks.length) return;
  const copies = cloneBlocksForPlacement(blocks, {
    offsetX: 24,
    offsetY: 24,
    nextZ: Math.max(0, ...(page.blocks || []).map(item => item.z)) + 1,
    createId: genId,
  });
  for (const copy of copies) {
    const next = clampBlockPosition(page, copy, copy.x, copy.y);
    copy.x = next.x;
    copy.y = next.y;
  }
  const result = await applyOps(copies.map(copy => ({ op: 'add_block', pageId: page.id, block: copy } as HcOp)), { refreshArtboard: true });
  if (result) setBlockSelection(copies.map(copy => copy.id), copies[copies.length - 1]?.id ?? null);
}

async function setActiveBlockLayer(direction: 'front' | 'back'): Promise<void> {
  const page = activePage();
  const blocks = selectedBlocks();
  if (!page || !blocks.length) return;
  const z = direction === 'front' ? Math.max(0, ...(page.blocks || []).map(item => item.z)) + 1 : Math.min(0, ...(page.blocks || []).map(item => item.z)) - 1;
  await applyOps(blocks.map((block, index) => ({ op: 'update_block', pageId: page.id, blockId: block.id, patch: { z: z + index } } as HcOp)), { refreshArtboard: true });
  renderInspector();
}

async function alignActiveBlock(mode: string): Promise<void> {
  const page = activePage();
  const block = activeBlock();
  if (!page || !block) return;
  const bounds = page.mode === 'infinite' ? viewportWorldBounds() : { minX: 24, minY: 24, maxX: page.width - 24, maxY: page.height - 24 };
  let x = block.x;
  let y = block.y;
  if (mode === 'left') x = bounds.minX;
  if (mode === 'center') x = (bounds.minX + bounds.maxX) / 2 - block.w / 2;
  if (mode === 'right') x = bounds.maxX - block.w;
  if (mode === 'top') y = bounds.minY;
  if (mode === 'middle') y = (bounds.minY + bounds.maxY) / 2 - block.h / 2;
  if (mode === 'bottom') y = bounds.maxY - block.h;
  const next = clampBlockPosition(page, block, x, y);
  const historyBase = cloneJson(state.doc);
  block.x = next.x; block.y = next.y;
  await applyOps([{ op: 'update_block', pageId: page.id, blockId: block.id, patch: { x: next.x, y: next.y } }], { refreshArtboard: true, historyBase: historyBase || undefined });
  renderInspector();
}

async function nudgeSelectedBlocks(dx: number, dy: number): Promise<void> {
  const page = activePage();
  const blocks = selectedBlocks();
  if (!page || !blocks.length) return;
  const historyBase = cloneJson(state.doc);
  await applyOps(blocks.map(block => {
    const next = clampBlockPosition(page, block, block.x + dx, block.y + dy);
    block.x = next.x; block.y = next.y;
    const wrap = qs<HTMLElement>('.block-wrap[data-block-id="' + block.id + '"]');
    if (wrap) { wrap.style.left = next.x + 'px'; wrap.style.top = next.y + 'px'; }
    return { op: 'update_block', pageId: page.id, blockId: block.id, patch: { x: next.x, y: next.y } } as HcOp;
  }), { refreshArtboard: false, historyBase: historyBase || undefined });
}

async function nudgeActiveBlock(dx: number, dy: number): Promise<void> {
  const page = activePage();
  const block = activeBlock();
  if (!page || !block) return;
  const next = clampBlockPosition(page, block, block.x + dx, block.y + dy);
  const historyBase = cloneJson(state.doc);
  block.x = next.x; block.y = next.y;
  const wrap = qs<HTMLElement>('.block-wrap[data-block-id="' + block.id + '"]');
  if (wrap) { wrap.style.left = next.x + 'px'; wrap.style.top = next.y + 'px'; }
  await applyOps([{ op: 'update_block', pageId: page.id, blockId: block.id, patch: { x: next.x, y: next.y } }], { refreshArtboard: false, historyBase: historyBase || undefined });
}
function openShortcutsModal(): void {
  openModal(SHORTCUTS_MODAL_HTML);
}
function handleGlobalKeydown(event: KeyboardEvent): void {
  const hub = qs<HTMLElement>('#projectHub');
  if (hub && !hub.classList.contains('hidden')) {
    if (event.key === 'Escape') closeProjectHub();
    return;
  }
  if (state.presenting) {
    if (event.key === 'Escape') closePresent();
    else if (event.key === 'ArrowRight' || event.key === 'PageDown') nextPresent(1);
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') nextPresent(-1);
    return;
  }
  if (el('modalRoot').childElementCount) {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
    return;
  }
  const target = event.target as HTMLElement;
  const typing = target.matches('input, textarea, [contenteditable="true"]') || Boolean(target.closest('.cm-editor'));
  if (target.matches('[contenteditable="true"]') && target.closest('.block-wrap') && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    target.blur();
    if (event.shiftKey) void redo(); else void undo();
    return;
  }
  if (event.key === 'Escape') {
    if (typing) { target.blur(); return; }
    if (state.editing) { exitHtmlEdit(); return; }
    if (state.pendingInsert) { cancelInsert(); return; }
    if (state.selectedBlockIds.length) { setBlockSelection([]); return; }
    if (state.tool !== 'select') { state.tool = 'select'; renderToolbarState(); }
    return;
  }
  if (typing || activePage()?.mode === 'whiteboard') return;
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (command && key === 'z') {
    event.preventDefault();
    if (event.shiftKey) void redo(); else void undo();
    return;
  }
  if (command && key === 'y') {
    event.preventDefault();
    void redo();
    return;
  }
  if (command && key === 'a') {
    const page = activePage();
    if (page?.blocks?.length) {
      event.preventDefault();
      setBlockSelection(page.blocks.map(block => block.id), page.blocks[page.blocks.length - 1]!.id);
    }
    return;
  }
  if (command && key === 'c') {
    if (state.selectedBlockIds.length) { event.preventDefault(); void copySelectedBlocks(); }
    return;
  }
  if (command && key === 'x') {
    if (state.selectedBlockIds.length) { event.preventDefault(); void copySelectedBlocks(true); }
    return;
  }
  if (command && key === 'd') {
    event.preventDefault();
    void duplicateActiveBlock();
    return;
  }
  if (command && key === 'g') {
    event.preventDefault();
    if (event.shiftKey) void ungroupSelectedBlocks(); else void groupSelectedBlocks();
    return;
  }
  if (command && key === 'p') {
    event.preventDefault();
    void exportCurrent('pdf');
    return;
  }
  if (command && (event.code === 'Digit0' || event.code === 'Digit1')) {
    event.preventDefault();
    if (event.code === 'Digit0') setZoom(1); else fitPage();
    return;
  }
  if (command && (event.code === 'Equal' || event.code === 'Minus')) {
    event.preventDefault();
    setZoom(state.zoom * (event.code === 'Equal' ? 1.15 : 1 / 1.15));
    return;
  }
  if (command || event.altKey) return;
  if (event.shiftKey && event.code === 'Digit1') {
    event.preventDefault();
    fitPage();
    return;
  }
  if (key === 'v' || key === 'h') {
    cancelInsert();
    state.tool = key === 'h' ? 'hand' : 'select';
    renderToolbarState();
    return;
  }
  if (key === 'p' || key === 'a' || key === 'c' || key === 'e') {
    if (activePage()?.mode === 'infinite' || (key === 'c' && activePage()?.mode === 'canvas')) {
      cancelInsert();
      state.tool = key === 'p' ? 'pen' : key === 'a' ? 'arrow' : key === 'c' ? 'curve' : 'eraser';
      renderToolbarState();
    }
    return;
  }
  if (key === 'r' || key === 'o') {
    event.preventDefault();
    state.pendingShape = key === 'r' ? 'rect' : 'ellipse';
    requestInsert('shape');
    return;
  }
  if (key === 't') {
    event.preventDefault();
    requestInsert('text');
    return;
  }
  if (key === 'g') { state.showGrid = !state.showGrid; renderArtboard(); return; }
  if (key === 's') { state.snap = !state.snap; renderToolbarState(); return; }
  if (event.key === '?') { openShortcutsModal(); return; }
  if (/^Digit[1-6]$/.test(event.code) && !event.shiftKey) {
    const map: Record<string, HcBlock['type']> = { Digit1: 'html', Digit2: 'text', Digit3: 'markdown', Digit4: 'code', Digit6: 'shape', Digit7: 'math' };
    const type = map[event.code];
    if (!type) return;
    event.preventDefault();
    if (type === 'shape') openShapePicker();
    else requestInsert(type);
    return;
  }
  if (event.key.startsWith('Arrow') && state.selectedBlockIds.length) {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    void nudgeSelectedBlocks(dx, dy);
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedBlockIds.length) {
    event.preventDefault();
    void deleteSelectedBlocks();
  }
}
function renderActivePanel(): void {
  if (state.tab === 'agent') renderAgent();
  else if (state.tab === 'proposals') renderProposals();
  else if (state.tab === 'layers') renderLayersPanel();
  else renderInspector();
}
function renderAll(): void {
  renderTop();
  renderToolbarState();
  renderDocs();
  renderPages();
  renderArtboard();
  renderProposalBadge();
  renderActivePanel();
  renderTabs();
}
function renderTop(): void {
  const title = el<HTMLInputElement>('docTitle');
  if (document.activeElement !== title) title.value = docTitle();
  el('docRevision').textContent = 'rev ' + (state.doc?.revision ?? 0);
  el('workspacePath').textContent = boot.workspace || '';
  renderPresence();
  const banner = el('editingBanner');
  if (state.editing) banner.classList.remove('hidden'); else banner.classList.add('hidden');
  el('editingLabel').textContent = state.editing?.blockId ? 'Editing HTML block' : 'Editing HTML page';
  el('addPageBtn').style.display = state.doc ? '' : 'none';
  el('presentBtn').style.display = state.doc ? '' : 'none';
  el('exportBtn').style.display = state.doc ? '' : 'none';
  fileBrowser?.syncCanvasTab(state.doc?.id || '', state.activePageId || '', activePage()?.name || state.doc?.title || 'Canvas');
  renderToolbarState();
}
function renderTabs(): void {
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === state.tab);
  });
  el('inspectorPanel').classList.toggle('hidden', state.tab !== 'inspector');
  el('layersPanel').classList.toggle('hidden', state.tab !== 'layers');
  el('agentPanel').classList.toggle('hidden', state.tab !== 'agent');
  el('proposalsPanel').classList.toggle('hidden', state.tab !== 'proposals');
}
function renderDocs(): void {
  const root = el('docsList');
  root.textContent = '';
  if (!state.docs.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No canvases yet. Create one to start.';
    root.appendChild(empty);
    return;
  }
  for (const doc of state.docs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'doc-item' + (state.doc?.id === doc.id ? ' active' : '');
    button.innerHTML = '<strong>' + esc(doc.title) + '</strong><small>rev ' + doc.revision + ' · ' + doc.pages + ' page' + (doc.pages === 1 ? '' : 's') + (doc.pendingProposals ? ' · ' + doc.pendingProposals + ' pending' : '') + '</small>';
    button.addEventListener('click', () => {
      if (state.doc?.id === doc.id) return;
      void openDoc(doc.id);
    });
    root.appendChild(button);
  }
}
function pageThumbHtml(page: HcPage): string {
  const ratio = Math.min(46 / page.width, 30 / page.height);
  if (page.mode === 'html' && page.html) {
    return '<iframe sandbox srcdoc="' + esc(page.html) + '" style="width:' + page.width + 'px;height:' + page.height + 'px;transform:scale(' + ratio + ');transform-origin:top left" tabindex="-1"></iframe>';
  }
  if (page.mode === 'canvas' || page.mode === 'infinite' || page.mode === 'whiteboard') {
    const native = page.mode === 'whiteboard' ? legacyWhiteboardNativePage(page) : page;
    const source = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}*{box-sizing:border-box}</style></head><body>' + renderPresentCanvasHtml(exportPageForThumb(native)) + '</body></html>';
    return '<iframe sandbox srcdoc="' + esc(source) + '" style="width:' + native.width + 'px;height:' + native.height + 'px;transform:scale(' + Math.min(46 / native.width, 30 / native.height) + ');transform-origin:top left" tabindex="-1"></iframe>';
  }
  return '<div class="page-thumb-placeholder">Page</div>';
}
function exportPageForThumb(page: HcPage): HcPage {
  if (page.mode !== 'infinite' && page.mode !== 'whiteboard') return page;
  const blocks = page.blocks || [];
  if (!blocks.length) return { ...page, width: 1280, height: 720 };
  const minX = Math.min(...blocks.map(block => block.x));
  const minY = Math.min(...blocks.map(block => block.y));
  const maxX = Math.max(...blocks.map(block => block.x + block.w));
  const maxY = Math.max(...blocks.map(block => block.y + block.h));
  const padding = 60;
  return { ...page, width: Math.max(320, Math.ceil(maxX - minX) + padding * 2), height: Math.max(240, Math.ceil(maxY - minY) + padding * 2), blocks: blocks.map(block => ({ ...block, x: block.x - minX + padding, y: block.y - minY + padding })) };
}
function duplicatePage(page: HcPage): void {
  if (!state.doc) return;
  const copy = JSON.parse(JSON.stringify(page)) as HcPage;
  copy.id = genId('page');
  copy.name = 'Copy of ' + page.name;
  if (copy.blocks) copy.blocks = copy.blocks.map(block => ({ ...block, id: genId('block') }));
  const index = state.doc.pages.findIndex(item => item.id === page.id);
  void applyOps([{ op: 'add_page', page: copy, index: index + 1 }], { refreshArtboard: false }).then(result => {
    if (!result) return;
    state.activePageId = copy.id;
    state.activeBlockId = null;
  state.selectedBlockIds = [];
    state.fittedPageId = null;
    renderAll();
    toast('Page duplicated', 'success');
  });
}
function movePageToIndex(pageId: string, toIndex: number): void {
  const pages = state.doc?.pages;
  if (!pages) return;
  const from = pages.findIndex(page => page.id === pageId);
  const target = Math.max(0, Math.min(pages.length - 1, toIndex));
  if (from < 0 || from === target) return;
  const direction = target > from ? 'down' : 'up';
  const ops = Array.from({ length: Math.abs(target - from) }, () => ({ op: 'reorder_page' as const, pageId, direction: direction as 'up' | 'down' }));
  void applyOps(ops, { refreshArtboard: false }).then(result => {
    if (!result) return;
    renderPages();
    renderTop();
  });
}
function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36) + ':' + value.length;
}
function pageFingerprint(page: HcPage): string {
  const base = page.name + '|' + page.mode + '|' + page.width + '|' + page.height + '|' + page.background;
  if (page.mode === 'whiteboard') return base + '|' + (page.scene?.elements?.length || 0);
  if (page.mode === 'html') return base + '|' + hashString(page.html || '');
  return base + '|' + hashString(JSON.stringify(page.blocks || []));
}
const pageThumbHydrators = new WeakMap<HTMLElement, () => void>();
let pageThumbObserver: IntersectionObserver | null = null;
function observePageThumb(item: HTMLElement, thumb: HTMLDivElement, page: HcPage, force = false): void {
  if (thumb.dataset.hydrated === '1') return;
  const hydrate = (): void => {
    if (thumb.dataset.hydrated === '1') return;
    thumb.dataset.hydrated = '1';
    thumb.innerHTML = pageThumbHtml(page);
  };
  pageThumbHydrators.set(item, hydrate);
  if (force) {
    hydrate();
    pageThumbObserver?.unobserve(item);
    return;
  }
  if (!('IntersectionObserver' in window)) { hydrate(); return; }
  if (!pageThumbObserver) {
    pageThumbObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const hydrateEntry = pageThumbHydrators.get(entry.target as HTMLElement);
        hydrateEntry?.();
        pageThumbObserver?.unobserve(entry.target);
      }
    }, { root: el('pagesList'), rootMargin: '240px 0px' });
  }
  pageThumbObserver.observe(item);
}
function createPageItem(page: HcPage, index: number): PageItemCache {
  const item = document.createElement('div');
  item.className = 'page-item' + (page.id === state.activePageId ? ' active' : '');
  item.dataset.pageId = page.id;
  item.style.order = String(index);
  item.title = 'Drag to reorder · right-click for actions';
  const thumb = document.createElement('div');
  thumb.className = 'page-thumb';
  thumb.innerHTML = '<div class="page-thumb-loading"></div>';
  const info = document.createElement('div');
  info.className = 'page-info';
  const meta = page.mode === 'infinite' ? '∞ · no page bounds' : page.mode === 'whiteboard' ? 'legacy · convert to native' : esc(page.mode) + ' · ' + page.width + '×' + page.height;
  info.innerHTML = '<strong>' + esc(page.name || 'Page ' + (index + 1)) + '</strong><small>' + meta + '</small>';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'page-open';
  button.append(thumb, info);
  item.appendChild(button);
  item.addEventListener('click', () => selectPage(page.id));
  return { fingerprint: pageFingerprint(page), item, thumb, info, index };
}
function schedulePagesRender(): void {
  if (pagesRenderTimer !== undefined) return;
  pagesRenderTimer = setTimeout(() => {
    pagesRenderTimer = undefined;
    renderPages();
  }, 160);
}
function renderPages(): void {
  if (pagesRenderTimer !== undefined) {
    clearTimeout(pagesRenderTimer);
    pagesRenderTimer = undefined;
  }
  const root = el('pagesList');
  const pages = state.doc?.pages || [];
  if (!pages.length) {
    root.textContent = '';
    pageItemCache.clear();
    return;
  }
  if (!pageItemCache.size && root.childElementCount) root.textContent = '';
  const pageIds = new Set(pages.map(page => page.id));
  for (const [pageId, cached] of pageItemCache) {
    if (!pageIds.has(pageId)) {
      pageThumbObserver?.unobserve(cached.item);
      pageThumbHydrators.delete(cached.item);
      cached.item.remove();
      pageItemCache.delete(pageId);
    }
  }
  pages.forEach((page, index) => {
    const fingerprint = pageFingerprint(page);
    const editingThisPage = state.editing?.pageId === page.id;
    let cached = pageItemCache.get(page.id);
    if (!cached || (cached.fingerprint !== fingerprint && !editingThisPage)) {
      const previous = cached;
      if (previous) {
        pageThumbObserver?.unobserve(previous.item);
        pageThumbHydrators.delete(previous.item);
      }
      const next = createPageItem(page, index);
      if (previous) previous.item.replaceWith(next.item);
      else root.appendChild(next.item);
      pageItemCache.set(page.id, next);
      observePageThumb(next.item, next.thumb, page, page.id === state.activePageId);
      cached = next;
    } else if (page.id === state.activePageId) {
      observePageThumb(cached.item, cached.thumb, page, true);
    }
    cached.index = index;
    cached.item.style.order = String(index);
    cached.item.classList.toggle('active', page.id === state.activePageId);
  });
}
function notifyCanvasTab(): void {
  window.dispatchEvent(new CustomEvent('hcanvas:canvas-opened', { detail: { docId: state.doc?.id, pageId: state.activePageId, label: activePage()?.name || 'Canvas' } }));
}
function selectPage(pageId: string): void {
  if (state.activePageId === pageId) { notifyCanvasTab(); return; }
  if (state.editing) state.editing = null;
  state.pendingInsert = null;
  state.activePageId = pageId;
  state.activeBlockId = null;
  state.selectedBlockIds = [];
  state.selectedHtmlId = null;
  state.iframeDoc = null;
  state.iframeElement = null;
  state.fittedPageId = null;
  renderPages();
  renderArtboard();
  renderInspector();
  renderTop();
  notifyCanvasTab();
  void syncActive();
}

let stageFrame = 0;
let undoStack: HcOp[][] = [];
let redoStack: HcOp[][] = [];
let applyingHistory = false;
let pendingHistoryUndo = 0;
let pendingHistoryRedo = 0;
let opQueue: Promise<unknown> = Promise.resolve();
let clipboardBlocks: HcBlock[] = [];
let clipboardPasteCount = 0;
function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const next = opQueue.then(task, task);
  opQueue = next.then(() => undefined, () => undefined);
  return next;
}
function scheduleStageTransform(): void {
  if (stageFrame) return;
  stageFrame = requestAnimationFrame(() => {
    stageFrame = 0;
    applyStageTransform();
  });
}
function applyStageTransform(): void {
  const stage = el('stage');
  stage.style.transform = 'translate(' + state.panX + 'px,' + state.panY + 'px) scale(' + state.zoom + ')';
  el('zoomReset').textContent = Math.round(state.zoom * 100) + '%';
  const viewport = el('viewport');
  if (viewport.classList.contains('infinite-surface')) {
    const gridSize = 22 * state.zoom;
    viewport.style.backgroundSize = gridSize + 'px ' + gridSize + 'px';
    viewport.style.backgroundPosition = state.panX + 'px ' + state.panY + 'px';
  }
}
function setZoomAt(next: number, clientX?: number, clientY?: number): void {
  const target = Math.max(0.1, Math.min(3, next));
  if (clientX === undefined || clientY === undefined) {
    state.zoom = target;
    scheduleStageTransform();
    return;
  }
  const rect = el('viewport').getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const worldX = (localX - state.panX) / state.zoom;
  const worldY = (localY - state.panY) / state.zoom;
  state.zoom = target;
  state.panX = localX - worldX * target;
  state.panY = localY - worldY * target;
  scheduleStageTransform();
}
function setZoom(next: number): void {
  const rect = el('viewport').getBoundingClientRect();
  setZoomAt(next, rect.left + rect.width / 2, rect.top + rect.height / 2);
}
function fitPage(): void {
  const page = activePage();
  if (!page) return;
  const viewport = el('viewport').getBoundingClientRect();
  const metrics = pageMetrics(page);
  const padding = 84;
  if (page.mode === 'infinite') {
    if (metrics.content) {
      const contentWidth = Math.max(120, metrics.content.maxX - metrics.content.minX);
      const contentHeight = Math.max(120, metrics.content.maxY - metrics.content.minY);
      const zoom = Math.max(0.12, Math.min(1.15, Math.min((viewport.width - padding * 2) / contentWidth, (viewport.height - padding * 2) / contentHeight)));
      state.zoom = zoom;
      state.panX = (viewport.width - contentWidth * zoom) / 2 - metrics.content.minX * zoom;
      state.panY = (viewport.height - contentHeight * zoom) / 2 - metrics.content.minY * zoom;
    } else {
      state.zoom = 0.8;
      state.panX = viewport.width / 2 - (metrics.width / 2) * state.zoom;
      state.panY = viewport.height / 2 - (metrics.height / 2) * state.zoom;
    }
    state.fittedPageId = state.activePageId;
    applyStageTransform();
    return;
  }
  const zoom = Math.max(0.08, Math.min(1.4, Math.min((viewport.width - padding * 2) / metrics.width, (viewport.height - padding * 2) / metrics.height)));
  state.zoom = zoom;
  state.panX = Math.max(20, (viewport.width - metrics.width * zoom) / 2);
  state.panY = Math.max(20, (viewport.height - metrics.height * zoom) / 2);
  state.fittedPageId = state.activePageId;
  applyStageTransform();
}
function renderArtboard(): void {
  htmlSelectionEditor.hide();
  const artboard = el('artboard'), viewport = el('viewport');
  const page = activePage();
  artboard.textContent = '';
  if (!page) return;
  document.body.classList.toggle('html-page-mode', page.mode === 'html');
  viewport.classList.toggle('html-page-mode', page.mode === 'html');
  if (page.mode === 'html') {
    artboard.style.display = 'none';
    renderHtmlPageSurface(viewport, page, {
      editing: Boolean(state.editing),
      onLoad: iframe => { if (state.editing) setupHtmlEditing(iframe, page.id); htmlSelectionEditor.applyPending(page.id); },
      onEdit: pageId => enterHtmlEdit(pageId),
    });
    renderToolbarState();
    return;
  }
  viewport.querySelectorAll('.html-page-surface, .html-reader-badge').forEach(node => node.remove());
  artboard.style.display = '';
  const whiteboardSurface = page.mode === 'whiteboard';
  const infiniteSurface = page.mode === 'infinite';
  const viewportRect = viewport.getBoundingClientRect();
  const metrics = whiteboardSurface || infiniteSurface ? { width: Math.max(320, viewportRect.width), height: Math.max(240, viewportRect.height) } : pageMetrics(page);
  viewport.classList.toggle('whiteboard-surface', whiteboardSurface);
  viewport.classList.toggle('infinite-surface', infiniteSurface);
  artboard.className = 'artboard mode-' + page.mode + (state.editing ? ' editing' : '') + (whiteboardSurface ? ' whiteboard-surface' : '') + (infiniteSurface ? ' infinite-surface' : '');
  artboard.style.width = metrics.width + 'px';
  artboard.style.height = metrics.height + 'px';
  artboard.style.background = infiniteSurface ? 'transparent' : page.background;
  if (infiniteSurface) {
    viewport.style.backgroundColor = page.background;
    viewport.style.backgroundImage = state.showGrid ? 'radial-gradient(rgba(80,70,55,.14) 1px, transparent 1px)' : 'none';
    viewport.style.backgroundSize = '22px 22px';
    artboard.style.backgroundImage = '';
    artboard.style.backgroundSize = '';
  } else {
    viewport.style.backgroundColor = '';
    viewport.style.backgroundImage = '';
    viewport.style.backgroundSize = '';
  }
  if (whiteboardSurface) {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.fittedPageId = state.activePageId;
    artboard.style.backgroundImage = '';
    artboard.style.backgroundSize = '';
  } else if (page.mode === 'infinite') {
    artboard.style.backgroundImage = '';
    artboard.style.backgroundSize = '';
  } else {
    artboard.style.backgroundImage = '';
    artboard.style.backgroundSize = '';
  }
  if (whiteboardSurface) renderWhiteboardPage(artboard, page);
  else renderCanvasPage(artboard, page);
  renderAgentCursors(artboard, page);
  if (whiteboardSurface) applyStageTransform();
  else if (state.fittedPageId !== state.activePageId) fitPage();
  else applyStageTransform();
  renderToolbarState();
}

let whiteboardResizing = false;
function resizeWhiteboardSurface(): void {
  if (whiteboardResizing || state.presenting) return;
  const page = activePage();
  if (!page || page.mode !== 'whiteboard') return;
  const artboard = el('artboard');
  const rect = el('viewport').getBoundingClientRect();
  const nextWidth = Math.max(320, rect.width);
  const nextHeight = Math.max(240, rect.height);
  if (Math.abs(Number.parseFloat(artboard.style.width) - nextWidth) < 0.5 && Math.abs(Number.parseFloat(artboard.style.height) - nextHeight) < 0.5) return;
  whiteboardResizing = true;
  try {
    artboard.style.width = nextWidth + 'px';
    artboard.style.height = nextHeight + 'px';
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyStageTransform();
  } finally {
    whiteboardResizing = false;
  }
}
function legacyWhiteboardNativePage(page: HcPage): HcPage {
  const native = excalidrawSceneToNativePage({ elements: (page.scene?.elements || []) as never[], appState: page.scene?.appState, files: page.scene?.files }, page.name || 'Legacy whiteboard');
  native.id = page.id;
  native.background = page.scene?.appState && typeof (page.scene.appState as { viewBackgroundColor?: unknown }).viewBackgroundColor === 'string'
    ? String((page.scene.appState as { viewBackgroundColor?: unknown }).viewBackgroundColor)
    : page.background || '#ffffff';
  return native;
}
function renderWhiteboardPage(container: HTMLElement, page: HcPage): void {
  const native = legacyWhiteboardNativePage(page);
  const blocks = native.blocks || [];
  if (!blocks.length) {
    container.innerHTML = '<div class="legacy-whiteboard-empty">This legacy whiteboard is empty. Use <strong>Convert to native Infinite</strong> to start a native page.</div>';
    return;
  }
  const host = document.createElement('div');
  host.className = 'legacy-whiteboard-preview';
  host.style.width = native.width + 'px';
  host.style.height = native.height + 'px';
  container.appendChild(host);
  renderCanvasPage(host, native);
  host.querySelectorAll<HTMLElement>('.block-wrap').forEach(node => { node.style.pointerEvents = 'none'; node.classList.remove('selected'); });
  const bounds = pageMetrics(native).content || { minX: 0, minY: 0, maxX: native.width, maxY: native.height };
  const rect = container.getBoundingClientRect();
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(1, (rect.width - 120) / contentWidth, (rect.height - 140) / contentHeight);
  host.style.left = ((rect.width - contentWidth * scale) / 2 - bounds.minX * scale) + 'px';
  host.style.top = ((rect.height - contentHeight * scale) / 2 - bounds.minY * scale) + 'px';
  host.style.transform = 'scale(' + scale + ')';
  const banner = document.createElement('div');
  banner.className = 'legacy-whiteboard-banner';
  banner.innerHTML = '<strong>Legacy whiteboard preview</strong><span>' + blocks.length + ' native blocks · read-only</span><button type="button" id="legacyConvertBtn" class="btn tiny primary">Convert to native Infinite</button>';
  container.appendChild(banner);
  qs<HTMLButtonElement>('#legacyConvertBtn')?.addEventListener('click', () => { void convertWhiteboardPage(page); });
}
function whiteboardSceneJson(page: HcPage): string {
  return JSON.stringify({ type: 'excalidraw', version: 2, source: 'hcanvas', elements: page.scene?.elements || [], appState: page.scene?.appState || {}, files: page.scene?.files || {} }, null, 2);
}

async function convertWhiteboardPage(page: HcPage): Promise<void> {
  if (page.mode !== 'whiteboard') return;
  const elements = page.scene?.elements || [];
  if (!elements.length) { toast('This whiteboard has no elements to convert.', 'info'); return; }
  const nativePage = excalidrawSceneToNativePage({ elements: elements as never[], appState: page.scene?.appState, files: page.scene?.files }, (page.name || 'Whiteboard') + ' · Native');
  nativePage.background = page.scene?.appState && typeof (page.scene.appState as { viewBackgroundColor?: unknown }).viewBackgroundColor === 'string'
    ? String((page.scene.appState as { viewBackgroundColor?: unknown }).viewBackgroundColor)
    : page.background || '#ffffff';
  const result = await applyOps([{ op: 'add_page', page: nativePage } as HcOp], { refreshArtboard: false });
  if (!result) return;
  state.activePageId = nativePage.id;
  state.activeBlockId = null;
  state.selectedBlockIds = [];
  state.tool = 'select';
  renderAll();
  void syncActive();
  toast('Converted to a native Infinite page: ' + (nativePage.blocks?.length || 0) + ' blocks', 'success');
}
function downloadWhiteboardScene(): void {
  const page = activePage();
  if (!page || page.mode !== 'whiteboard') return;
  const blob = new Blob([whiteboardSceneJson(page)], { type: 'application/vnd.excalidraw+json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = (page.name || 'whiteboard').replace(/[^a-z0-9_-]+/gi, '-') + '.excalidraw';
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 2000);
}
function agentHue(actor: string): number {
  return actor.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;
}

async function followAgent(session: PresenceEntry): Promise<void> {
  if (!state.doc || session.docId !== state.doc.id) {
    await openDoc(session.docId, session.pageId);
  } else if (session.pageId && session.pageId !== state.activePageId) {
    state.activePageId = session.pageId;
    state.fittedPageId = null;
    state.activeBlockId = null;
  state.selectedBlockIds = [];
    state.selectedHtmlId = null;
    renderAll();
  }
  const selection = session.selection?.[0];
  const page = activePage();
  if (selection && page) {
    if (page.mode === 'html') state.selectedHtmlId = selection;
    else if (page.blocks?.some(block => block.id === selection)) {
      const block = page.blocks.find(item => item.id === selection)!;
      setBlockSelection(expandGroupSelection(block), block.id);
    }
  }
  renderArtboard();
  renderInspector();
  toast('Following ' + session.actor + (page ? ' on ' + page.name : ''), 'info');
}
function renderAgentCursors(container: HTMLElement, page: HcPage): void {
  if (!state.doc) return;
  const sessions = state.presence.filter(session => session.docId === state.doc?.id && (!session.pageId || session.pageId === page.id));
  if (!sessions.length) return;
  const overlay = document.createElement('div');
  overlay.className = 'agent-cursors';
  sessions.forEach((session, index) => {
    const hue = agentHue(session.actor);
    const cursor = document.createElement('button');
    cursor.type = 'button';
    cursor.className = 'agent-cursor';
    cursor.dataset.agentSession = session.id;
    cursor.style.color = 'hsl(' + hue + ', 60%, 42%)';
    let left = 20 + index * 8;
    let top = 16 + index * 30;
    const selection = session.selection?.[0];
    if (selection && page.mode !== 'html') {
      const block = (page.blocks || []).find(item => item.id === selection);
      if (block) {
        left = Math.max(4, block.x + block.w - 8);
        top = Math.max(24, block.y - 6);
      }
    } else if (page.mode === 'whiteboard') {
      left = page.width - 190;
      top = 18 + index * 30;
    } else if (page.mode === 'html') {
      left = 18;
      top = 14 + index * 30;
    }
    cursor.style.left = left + 'px';
    cursor.style.top = top + 'px';
    cursor.title = session.actor + ' · ' + (selection || page.name) + ' · click to follow';
    cursor.innerHTML = '<span class="agent-cursor-label" style="background:hsl(' + hue + ', 55%, 38%)">' + esc(session.actor) + '</span><span class="agent-cursor-dot" style="background:hsl(' + hue + ', 65%, 50%)"></span>';
    cursor.addEventListener('click', event => { event.stopPropagation(); void followAgent(session); });
    overlay.appendChild(cursor);
  });
  container.appendChild(overlay);
  if (page.mode === 'html' && page.html) {
    const htmlSessions = sessions.filter(session => session.selection?.[0]);
    if (htmlSessions.length) {
      const cursorKey = page.id + '|' + page.width + 'x' + page.height + '|' + hashString(page.html) + '|' + htmlSessions.map(session => session.id + ':' + (session.selection?.[0] || '')).join(',');
      if (htmlCursorCacheKey === cursorKey && htmlCursorCache.size) {
        for (const session of htmlSessions) {
          const position = htmlCursorCache.get(session.id);
          const cursor = overlay.querySelector<HTMLElement>('[data-agent-session="' + CSS.escape(session.id) + '"]');
          if (!position || !cursor) continue;
          cursor.style.left = position.left + 'px';
          cursor.style.top = position.top + 'px';
        }
        return;
      }
      htmlCursorCacheKey = cursorKey;
      htmlCursorCache.clear();
      const measure = document.createElement('iframe');
      measure.className = 'agent-measure-frame';
      measure.setAttribute('sandbox', 'allow-same-origin');
      measure.setAttribute('title', 'Agent selection measurement');
      measure.style.width = page.width + 'px';
      measure.style.height = page.height + 'px';
      measure.srcdoc = page.html;
      measure.addEventListener('load', () => {
        try {
          const frameDoc = measure.contentDocument;
          if (!frameDoc) return;
          for (const session of htmlSessions) {
            const selection = session.selection?.[0];
            if (!selection) continue;
            const target = frameDoc.querySelector('[data-hc-id="' + CSS.escape(selection) + '"]');
            const cursor = overlay.querySelector<HTMLElement>('[data-agent-session="' + CSS.escape(session.id) + '"]');
            if (!target || !cursor) continue;
            const rect = target.getBoundingClientRect();
            const position = { left: rect.left + rect.width / 2, top: Math.max(22, rect.top + 2) };
            htmlCursorCache.set(session.id, position);
            cursor.style.left = position.left + 'px';
            cursor.style.top = position.top + 'px';
          }
        } catch { /* measurement is best effort */ }
        setTimeout(() => measure.remove(), 0);
      });
      container.appendChild(measure);
    }
  }
}
window.addEventListener('message', event => {
  const data = event.data as { type?: string; pageId?: string; text?: string; hcId?: string; rect?: { left: number; top: number; width: number; height: number } } | null;
  if (data?.type === 'hcanvas:html-selection') {
    if (state.editing || !data.pageId || data.pageId !== state.activePageId || activePage()?.mode !== 'html' || !data.text || !data.hcId || !data.rect) { htmlSelectionEditor.hide(); return; }
    htmlSelectionEditor.show(data.pageId, data.hcId, data.rect);
    return;
  }
  if (!data || data.type !== 'hcanvas:edit-html' || typeof data.pageId !== 'string') return;
  if (state.editing || !state.doc?.pages.some(page => page.id === data.pageId)) return;
  enterHtmlEdit(data.pageId);
});
function blockWrapper(block: HcBlock, page: HcPage): HTMLDivElement {
  const editing = state.editing?.pageId === page.id && state.editing?.blockId === block.id;
  const wrap = document.createElement('div');
  wrap.className = 'block-wrap type-' + block.type + (block.shape ? ' shape-' + block.shape : '') + (state.selectedBlockIds.includes(block.id) ? ' selected' : '') + (editing ? ' editing' : '');
  wrap.dataset.blockId = block.id;
  wrap.style.left = block.x + 'px';
  wrap.style.top = block.y + 'px';
  wrap.style.width = block.w + 'px';
  wrap.style.height = block.h + 'px';
  wrap.style.zIndex = String(blockRenderZ(page, block));
  if (block.rotation || block.style?.flipX || block.style?.flipY) { wrap.style.transform = (block.rotation ? 'rotate(' + block.rotation + 'deg) ' : '') + (block.style?.flipX ? 'scaleX(-1) ' : '') + (block.style?.flipY ? 'scaleY(-1)' : ''); wrap.style.transformOrigin = 'center center'; }
  if (block.style?.opacity !== undefined) wrap.style.opacity = String(block.style.opacity);
  return wrap;
}
function renderCanvasPage(container: HTMLElement, page: HcPage): void {
  const blocks = blocksInStackOrder(page);
  for (const block of blocks) {
    const wrap = blockWrapper(block, page);
    const editing = state.editing?.pageId === page.id && state.editing?.blockId === block.id;
    const content = document.createElement('div');
    content.className = 'block-content';
    content.appendChild(renderCanvasBlockContent(block, page, { editing, wrapHtml: wrapBlockHtml, setupHtmlEditing }));
    wrap.appendChild(content);
    if (!editing) {
      const hit = document.createElement('div');
      hit.className = 'block-hit';
      wrap.appendChild(hit);
    }
    if (state.activeBlockId === block.id && state.selectedBlockIds.length <= 1 && !editing) addBlockSelectionDecorations(wrap, block);
    bindBlockEvents(wrap, block);
    container.appendChild(wrap);
  }
}
function wrapBlockHtml(html: string): string {
  return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;font-family:Inter,ui-sans-serif,system-ui,sans-serif}</style></head><body>' + html + '</body></html>';
}
function cycleBlockSelectionAt(clientX: number, clientY: number, currentId: string): void {
  const page = activePage();
  if (!page) return;
  const nodes = document.elementsFromPoint(clientX, clientY)
    .map(node => (node as Element).closest?.('.block-wrap') as HTMLElement | null)
    .filter((node): node is HTMLElement => Boolean(node));
  const ids = [...new Set(nodes.map(node => node.dataset.blockId).filter((id): id is string => Boolean(id)))];
  const index = ids.indexOf(currentId);
  const nextId = ids[(index + 1) % ids.length] || currentId;
  const block = (page.blocks || []).find(item => item.id === nextId);
  if (block) selectBlock(block.id);
}
function beginBlockDrag(event: PointerEvent, block: HcBlock, handle: HTMLElement, wrap: HTMLDivElement): void {
  const page = activePage();
  if (!page) return;
  const dragBlocks = selectedBlocks();
  if (block.shape === 'frame') {
    for (const child of page.blocks || []) {
      if (child.frameId === block.id && !dragBlocks.some(item => item.id === child.id)) dragBlocks.push(child);
    }
  }
  const starts = new Map(dragBlocks.map(item => [item.id, { x: item.x, y: item.y, w: item.w, h: item.h }]));
  const historyBase = cloneJson(state.doc);
  const start = { x: event.clientX, y: event.clientY, moved: false }; const duplicateOnDrag = event.ctrlKey || event.metaKey;
  const guideLayer = el('artboard');
  const guideNodes: HTMLElement[] = [];
  const showGuides = (guides: Array<{ axis: 'x' | 'y'; value: number }>): void => {
    for (const node of guideNodes) node.remove();
    guideNodes.length = 0;
    for (const guide of guides) {
      const node = document.createElement('div');
      node.className = 'alignment-guide ' + (guide.axis === 'x' ? 'vertical' : 'horizontal');
      node.style[guide.axis === 'x' ? 'left' : 'top'] = guide.value + 'px';
      guideLayer.appendChild(node);
      guideNodes.push(node);
    }
  };
  try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  let dragFrame = 0;
  const paintDrag = (): void => {
    for (const item of dragBlocks) {
      const node = qs<HTMLElement>('.block-wrap[data-block-id="' + item.id + '"]');
      if (node) { node.style.left = item.x + 'px'; node.style.top = item.y + 'px'; }
    }
  };
  const move = (moveEvent: PointerEvent): void => {
    const rawX = (moveEvent.clientX - start.x) / state.zoom;
    const rawY = (moveEvent.clientY - start.y) / state.zoom;
    if (Math.abs(rawX) < 2 && Math.abs(rawY) < 2) return;
    start.moved = true;
    const lockX = moveEvent.shiftKey && Math.abs(rawX) >= Math.abs(rawY);
    const lockY = moveEvent.shiftKey && !lockX;
    const origins = dragBlocks.map(item => { const origin = starts.get(item.id)!; return { id: item.id, x: origin.x, y: origin.y, w: item.w, h: item.h }; });
    const snap = snapMove(page, origins, lockY ? 0 : rawX, lockX ? 0 : rawY, state.zoom, state.snap);
    showGuides(snap.guides);
    for (const item of dragBlocks) {
      const origin = starts.get(item.id)!;
      const next = clampBlockPosition(page, item, lockY ? origin.x : origin.x + snap.dx, lockX ? origin.y : origin.y + snap.dy);
      item.x = next.x; item.y = next.y;
    }
    if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; paintDrag(); });
  };
  const up = (): void => {
    for (const node of guideNodes) node.remove();
    guideNodes.length = 0;
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
    paintDrag();
    if (start.moved) {
      const movedIds = new Set(dragBlocks.map(item => item.id));
      const hasBoundArrows = (page.blocks || []).some(item => item.type === 'arrow' && ((item.startBinding && movedIds.has(item.startBinding)) || (item.endBinding && movedIds.has(item.endBinding))));
      const copies = duplicateOnDrag ? dragBlocks.map(item => { const origin = starts.get(item.id)!; return { ...cloneJson(item), id: genId('block'), x: origin.x, y: origin.y, z: Math.max(0, ...(page.blocks || []).map(block => block.z)) + 1, name: (item.name || 'Block') + ' copy' } as HcBlock; }) : [];
      const ops: HcOp[] = [...dragBlocks.map(item => ({ op: 'update_block' as const, pageId: page.id, blockId: item.id, patch: { x: item.x, y: item.y } })), ...copies.map(block => ({ op: 'add_block' as const, pageId: page.id, block }))];
      void applyOps(ops, { refreshArtboard: hasBoundArrows || Boolean(copies.length), historyBase: historyBase || undefined });
    }
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
}
function bindBlockEvents(wrap: HTMLDivElement, block: HcBlock): void {
  const hit = qs<HTMLElement>('.block-hit', wrap);
  if (!hit) return;
  hit.addEventListener('pointerdown', event => {
    if (event.button !== 0 || state.tool !== 'select' || state.spaceHeld) return;
    event.stopPropagation();
    if (event.altKey) {
      cycleBlockSelectionAt(event.clientX, event.clientY, block.id);
      return;
    }
    selectBlock(block.id, { additive: event.shiftKey && !state.selectedBlockIds.includes(block.id) });
    if (!state.selectedBlockIds.includes(block.id)) return;
    beginBlockDrag(event, block, hit, wrap);
  });
  hit.addEventListener('dblclick', event => {
    event.stopPropagation();
    if (block.type === 'html') enterHtmlEdit(activePage()!.id, block.id);
    else if (block.type === 'shape') startShapeTextEdit(block, wrap, { getDoc: () => state.doc, commit: (target, patch, historyBase) => { void persistBlock(target, patch, historyBase || undefined); } });
    else if (block.type === 'text') {
      const text = qs<HTMLElement>('.block-text', wrap);
      if (!text) return;
      wrap.classList.add('text-editing');
      text.contentEditable = 'true';
      text.focus();
      const finish = (): void => {
        if (!text.isContentEditable) return;
        text.contentEditable = 'false';
        wrap.classList.remove('text-editing');
        const value = text.innerText;
        if (value !== (block.text || '')) {
          const historyBase = cloneJson(state.doc);
          block.text = value;
          void persistBlock(block, { text: value }, historyBase || undefined);
        }
      };
      text.addEventListener('blur', finish, { once: true });
      text.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); text.blur(); }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); text.blur(); }
      });
    } else if (block.type === 'markdown' || block.type === 'code') openSourceEditor({ pageId: activePage()!.id, blockId: block.id });
    else if (block.type === 'math') openFormulaModal(block);
    else if (block.type === 'image') openImageModal(block);
  });
}
function clearBlockSelectionDecorations(): void {
  document.querySelectorAll('.block-label, .resize-handle, .line-endpoint').forEach(node => node.remove());
}
function addBlockSelectionDecorations(wrap: HTMLDivElement, block: HcBlock): void {
  if (wrap.querySelector(':scope > .block-label')) return;
  const label = document.createElement('span');
  label.className = 'block-label';
  label.textContent = block.name || block.type;
  label.title = 'Drag to move; Alt+click the block to cycle overlapping layers';
  label.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!state.selectedBlockIds.includes(block.id)) selectBlock(block.id);
    beginBlockDrag(event, block, label, wrap);
  });
  wrap.appendChild(label);
  if (block.type === 'shape' && block.shape === 'line') {
    addLineEndpointHandles(wrap, block, {
      getZoom: () => state.zoom,
      getHistoryBase: () => cloneJson(state.doc),
      onChange: (target: HcBlock, node: HTMLElement) => {
        const host = node.querySelector<HTMLElement>('.block-shape-host');
        if (host) host.innerHTML = shapeSvgMarkup(target);
      },
      commit: (target: HcBlock, patch: Partial<HcBlock>, historyBase: HcDocument | null) => { void persistBlock(target, patch, historyBase || undefined); },
    });
    return;
  }
  if (block.type === 'curve') return;
  const directions: ResizeDirection[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const resizeContext = {
    getZoom: () => state.zoom,
    getHistoryBase: () => cloneJson(state.doc),
    commit: (target: HcBlock, patch: Partial<HcBlock>, historyBase: HcDocument | null) => { void persistBlock(target, patch, historyBase || undefined); },
  };
  for (const direction of directions) {
    const resize = document.createElement('div');
    resize.className = 'resize-handle handle-' + direction;
    wrap.appendChild(resize);
    bindBlockResizeHandle(resize, wrap, block, direction, resizeContext);
  }
}
function refreshBlockSelectionDecorations(): void {
  clearBlockSelectionDecorations();
  if (state.editing) return;
  const selected = selectedBlocks();
  if (selected.length !== 1) return;
  const block = selected[0]!;
  const wrap = qs<HTMLDivElement>('.block-wrap[data-block-id="' + block.id + '"]');
  if (wrap) addBlockSelectionDecorations(wrap, block);
}
function selectBlock(blockId: string | null, options: { additive?: boolean } = {}): void {
  if (!blockId) { setBlockSelection([]); return; }
  const block = activePage()?.blocks?.find(item => item.id === blockId);
  if (!block) { setBlockSelection([]); return; }
  if (isBlockLocked(activePage()!, block)) { toast('This block is on a locked layer.', 'info'); return; }
  const groupIds = expandGroupSelection(block);
  if (options.additive) {
    const current = new Set(state.selectedBlockIds);
    const allSelected = groupIds.every(id => current.has(id));
    for (const id of groupIds) { if (allSelected) current.delete(id); else current.add(id); }
    setBlockSelection([...current], allSelected ? null : blockId);
    return;
  }
  setBlockSelection(groupIds, blockId);
}

async function persistBlock(block: HcBlock, patch: Partial<HcBlock>, historyBase?: HcDocument): Promise<void> {
  const page = activePage();
  if (!page) return;
  await applyOps([{ op: 'update_block', pageId: page.id, blockId: block.id, patch } as HcOp], { refreshArtboard: false, ...(historyBase ? { historyBase } : {}) });
  renderInspector();
}
function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
function invertOps(ops: HcOp[], baseDoc: HcDocument | null = state.doc): HcOp[] | null {
  return invertDocumentOps(ops, baseDoc);
}
function updateHistoryButtons(): void {
  const undoBtn = qs<HTMLButtonElement>('#undoBtn');
  const redoBtn = qs<HTMLButtonElement>('#redoBtn');
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

async function undo(): Promise<void> {
  if (!undoStack.length || !state.doc) return;
  if (applyingHistory) { pendingHistoryUndo = Math.min(pendingHistoryUndo + 1, 10); return; }
  applyingHistory = true;
  updateHistoryButtons();
  try {
    await enqueueMutation(async () => {
      if (!undoStack.length || !state.doc) return;
      const ops = undoStack.pop()!;
      const redoOps = invertOps(ops);
      const result = await applyOpsNow(ops, { recordHistory: false, refreshArtboard: true });
      if (!result) { undoStack.push(ops); return; }
      if (redoOps) redoStack.push(redoOps);
    });
  } finally {
    applyingHistory = false;
    updateHistoryButtons();
    if (pendingHistoryUndo > 0 && undoStack.length) { pendingHistoryUndo -= 1; void undo(); }
    else pendingHistoryUndo = 0;
  }
}

async function redo(): Promise<void> {
  if (!redoStack.length || !state.doc) return;
  if (applyingHistory) { pendingHistoryRedo = Math.min(pendingHistoryRedo + 1, 10); return; }
  applyingHistory = true;
  updateHistoryButtons();
  try {
    await enqueueMutation(async () => {
      if (!redoStack.length || !state.doc) return;
      const ops = redoStack.pop()!;
      const undoOps = invertOps(ops);
      const result = await applyOpsNow(ops, { recordHistory: false, refreshArtboard: true });
      if (!result) { redoStack.push(ops); return; }
      if (undoOps) undoStack.push(undoOps);
    });
  } finally {
    applyingHistory = false;
    updateHistoryButtons();
    if (pendingHistoryRedo > 0 && redoStack.length) { pendingHistoryRedo -= 1; void redo(); }
    else pendingHistoryRedo = 0;
  }
}
function augmentBindingOps(ops: HcOp[]): HcOp[] {
  if (!state.doc) return ops;
  const changed = new Map<string, Set<string>>();
  for (const op of ops) {
    if (op.op !== 'update_block' && op.op !== 'delete_block') continue;
    if (!changed.has(op.pageId)) changed.set(op.pageId, new Set());
    changed.get(op.pageId)!.add(op.blockId);
  }
  if (!changed.size) return ops;
  let hasAffectedArrow = false;
  for (const [pageId, touched] of changed) {
    const page = state.doc.pages.find(item => item.id === pageId);
    if ((page?.blocks || []).some(arrow => arrow.type === 'arrow' && (arrow.startBinding || arrow.endBinding)
      && (touched.has(arrow.id) || Boolean(arrow.startBinding && touched.has(arrow.startBinding)) || Boolean(arrow.endBinding && touched.has(arrow.endBinding))))) {
      hasAffectedArrow = true;
      break;
    }
  }
  if (!hasAffectedArrow) return ops;
  const working = cloneJson(state.doc);
  for (const op of ops) applyOpLocally(working, op);
  const extra: HcOp[] = [];
  for (const page of working.pages) {
    const touched = changed.get(page.id);
    if (!touched) continue;
    for (const arrow of page.blocks || []) {
      if (arrow.type !== 'arrow' || (!arrow.startBinding && !arrow.endBinding)) continue;
      if (!(arrow.startBinding && touched.has(arrow.startBinding)) && !(arrow.endBinding && touched.has(arrow.endBinding)) && touched.has(arrow.id) === false) continue;
      const geometry = boundArrowGeometry(arrow, page.blocks || []);
      if (!geometry) continue;
      const patch: Partial<HcBlock> = { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h, points: geometry.points };
      if (geometry.clearStart) patch.startBinding = null;
      if (geometry.clearEnd) patch.endBinding = null;
      if (JSON.stringify({ x: arrow.x, y: arrow.y, w: arrow.w, h: arrow.h, points: arrow.points, startBinding: arrow.startBinding ?? null, endBinding: arrow.endBinding ?? null })
        === JSON.stringify({ x: patch.x, y: patch.y, w: patch.w, h: patch.h, points: patch.points, startBinding: patch.startBinding === undefined ? arrow.startBinding ?? null : patch.startBinding, endBinding: patch.endBinding === undefined ? arrow.endBinding ?? null : patch.endBinding })) continue;
      extra.push({ op: 'update_block', pageId: page.id, blockId: arrow.id, patch });
    }
  }
  return extra.length ? [...ops, ...extra] : ops;
}

type ApplyOptions = { refreshArtboard?: boolean; actor?: string; silent?: boolean; recordHistory?: boolean; historyBase?: HcDocument };
function applyOps(ops: HcOp[], options: ApplyOptions = {}): Promise<HcDocument | null> {
  return enqueueMutation(() => applyOpsNow(ops, options));
}

async function applyOpsNow(ops: HcOp[], options: ApplyOptions = {}): Promise<HcDocument | null> {
  if (!state.doc) return null;
  const finalOps = augmentBindingOps(ops);
  const historyInverse = options.recordHistory !== false && options.silent !== true && !applyingHistory ? invertOps(finalOps, options.historyBase || state.doc) : null;
  setSaveStatus('Saving…', 'saving');
  try {
    const result = await api<{ doc: HcDocument }>('/api/docs/' + state.doc.id + '/apply', {
      method: 'POST',
      body: JSON.stringify({ ops: finalOps, baseRevision: state.doc.revision, actor: options.actor || 'human', source: clientId }),
    });
    state.doc = result.doc;
    if (historyInverse) {
      undoStack.push(historyInverse);
      if (undoStack.length > 60) undoStack.shift();
      redoStack = [];
      updateHistoryButtons();
    }
    patchDocSummary(result.doc);
    setSaveStatus('Saved · rev ' + result.doc.revision, 'saved');
    if (options.silent) {
      renderTop();
      return result.doc;
    }
    renderTop();
    renderDocs();
    schedulePagesRender();
    renderProposalBadge();
    if (state.tab === 'proposals') renderProposals();
    if (options.refreshArtboard !== false) renderArtboard();
    if (state.tab === 'inspector' && !(state.editing && options.refreshArtboard === false)) renderInspector();
    else if (state.tab === 'layers') renderLayersPanel();
    void syncActive();
    return result.doc;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      setSaveStatus('Revision conflict — reloading', 'error');
      toast('Someone else changed this canvas. Reloading the latest revision.', 'error');
      await reloadActiveDoc();
      return null;
    }
    setSaveStatus('Save failed', 'error');
    toast(error instanceof Error ? error.message : String(error), 'error');
    return null;
  }
}

async function reloadActiveDoc(): Promise<void> {
  if (!state.doc) return;
  const docId = state.doc.id;
  const pageId = state.activePageId || undefined;
  await openDoc(docId, pageId);
  setSaveStatus('Reloaded', 'idle');
}

let activeSyncKey = '';
let activeSyncInFlight = false;
let activeSyncQueued = false;

async function syncActive(): Promise<void> {
  if (!state.doc) return;
  const key = JSON.stringify([state.doc.id, state.activePageId, state.selectedHtmlId || state.activeBlockId]);
  if (key === activeSyncKey) return;
  activeSyncKey = key;
  activeSyncQueued = true;
  if (activeSyncInFlight) return;
  activeSyncInFlight = true;
  try {
    while (activeSyncQueued && state.doc) {
      activeSyncQueued = false;
      const snapshot = { docId: state.doc.id, pageId: state.activePageId, blockId: state.selectedHtmlId || state.activeBlockId, actor: 'human' };
      await api('/api/context/activate', { method: 'POST', body: JSON.stringify(snapshot) });
    }
  } catch {
    activeSyncKey = '';
  } finally {
    activeSyncInFlight = false;
  }
}

async function renameDocument(title: string): Promise<void> {
  if (!state.doc) return;
  const result = await api<{ doc: HcDocument }>('/api/docs/' + state.doc.id, { method: 'PATCH', body: JSON.stringify({ title, source: clientId }) });
  state.doc = result.doc;
  patchDocSummary(result.doc);
  renderTop(); renderDocs();
  setSaveStatus('Renamed', 'saved');
}
function enterHtmlEdit(pageId: string, blockId?: string): void {
  const page = state.doc?.pages.find(item => item.id === pageId);
  if (!page) return;
  htmlSelectionEditor.hide();
  state.editing = blockId ? { pageId, blockId } : { pageId };
  state.activeBlockId = blockId || null;
  state.fittedPageId = null;
  state.selectedHtmlId = null;
  state.iframeDoc = null;
  state.iframeElement = null;
  renderTop();
  renderArtboard();
  renderInspector();
}
function exitHtmlEdit(): void {
  if (!state.editing) return;
  htmlSelectionEditor.hide();
  const active = state.iframeDoc?.querySelector<HTMLElement>('[contenteditable="true"]');
  if (active) void commitHtmlElement(active);
  state.editing = null;
  state.selectedHtmlId = null;
  state.iframeDoc = null;
  state.iframeElement = null;
  renderTop();
  renderArtboard();
  renderPages();
  renderInspector();
}
function canEditHtmlText(element: Element): boolean {
  if (element === element.ownerDocument.body) return false;
  const tag = element.tagName.toLowerCase();
  if (['img', 'br', 'hr', 'input', 'textarea', 'select', 'option', 'iframe', 'svg', 'path', 'style', 'script'].includes(tag)) return false;
  if (!element.textContent?.trim()) return false;
  const inlineTags = new Set(['A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'BR', 'CODE', 'SMALL', 'MARK', 'U', 'S']);
  return Array.from(element.children).every(child => inlineTags.has(child.tagName));
}

function setupHtmlEditing(iframe: HTMLIFrameElement, pageId: string, blockId?: string): void {
  const contentDocument = iframe.contentDocument;
  if (!contentDocument) { toast('Cannot enter HTML edit mode.', 'error'); return; }
  state.iframeDoc = contentDocument;
  state.iframeElement = iframe;
  const style = contentDocument.createElement('style');
  style.setAttribute('data-hc-editor', '');
  style.textContent = '[data-hc-hover]{outline:1px solid rgba(109,91,208,.52) !important;outline-offset:3px !important;}[data-hc-selected]{outline:2px solid #6d5bd0 !important;outline-offset:3px !important;}[data-hc-editing]{outline:2px dashed #7c3aed !important;outline-offset:4px !important;cursor:text !important;}a[href]{cursor:default !important;}';
  contentDocument.head?.appendChild(style);
  installHtmlHoverHighlight(contentDocument);
  installHtmlKeyboardShortcuts(contentDocument, htmlEditingContext());
  contentDocument.addEventListener('click', event => {
    const target = event.target as Element;
    if (target.closest('[contenteditable="true"]')) return;
    event.preventDefault(); event.stopPropagation();
    const candidate = target.closest('[data-hc-id]') || contentDocument.body;
    if (candidate === selectedHtmlElement() && canEditHtmlText(candidate)) {
      startInlineTextEdit(candidate as HTMLElement);
      return;
    }
    selectHtmlElement(candidate);
  }, true);
  contentDocument.addEventListener('dblclick', event => {
    event.preventDefault(); event.stopPropagation();
    const target = event.target as Element;
    startInlineTextEdit((target.closest('[data-hc-id]') || contentDocument.body) as HTMLElement);
  }, true);
  contentDocument.addEventListener('input', event => {
    const target = (event.target as Element).closest('[contenteditable="true"]');
    if (target) scheduleHtmlCommit(target as HTMLElement);
  }, true);
  contentDocument.addEventListener('blur', event => {
    const target = event.target as HTMLElement;
    if (target && target.getAttribute && target.getAttribute('contenteditable') === 'true') void commitHtmlElement(target);
  }, true);
  contentDocument.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !(event.target as Element).closest('input, textarea, select, [contenteditable="true"]')) {
      const selected = selectedHtmlElement();
      if (selected && canEditHtmlText(selected)) {
        event.preventDefault();
        startInlineTextEdit(selected as HTMLElement);
      }
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    const active = contentDocument.activeElement as HTMLElement | null;
    if (active && active.getAttribute('contenteditable') === 'true') {
      active.setAttribute('contenteditable', 'false');
      active.removeAttribute('data-hc-editing');
      void commitHtmlElement(active);
    } else exitHtmlEdit();
  }, true);
  contentDocument.addEventListener('selectionchange', () => {
    if (!state.editing) return;
    const selection = contentDocument.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { htmlSelectionEditor.hide(); return; }
    const node = selection.anchorNode?.nodeType === 3 ? selection.anchorNode.parentElement : selection.anchorNode as Element | null;
    const element = node?.closest?.('[data-hc-id]') || null;
    if (!element) { htmlSelectionEditor.hide(); return; }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    htmlSelectionEditor.show(state.activePageId || '', element.getAttribute('data-hc-id') || '', rect);
  }, true);
  contentDocument.addEventListener('submit', event => { event.preventDefault(); }, true);
  renderInspector();
}
function selectHtmlElement(element: Element): void {
  const contentDocument = state.iframeDoc;
  if (!contentDocument) return;
  contentDocument.querySelectorAll('[data-hc-selected]').forEach(node => node.removeAttribute('data-hc-selected'));
  element.setAttribute('data-hc-selected', 'true');
  state.selectedHtmlId = element.getAttribute('data-hc-id');
  renderInspector();
  void syncActive();
}
function startInlineTextEdit(element: HTMLElement): void {
  if (!state.iframeDoc) return;
  const previous = state.iframeDoc.querySelector('[contenteditable="true"]') as HTMLElement | null;
  if (previous && previous !== element) {
    previous.setAttribute('contenteditable', 'false');
    previous.removeAttribute('data-hc-editing');
    void commitHtmlElement(previous);
  }
  selectHtmlElement(element);
  element.setAttribute('contenteditable', 'true');
  element.setAttribute('data-hc-editing', 'true');
  element.focus();
  try {
    const range = state.iframeDoc.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = state.iframeDoc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch { /* caret fallback */ }
}

let htmlCommitTimer: ReturnType<typeof setTimeout> | undefined;
let htmlCommitElement: HTMLElement | null = null;
function scheduleHtmlCommit(element: HTMLElement): void {
  htmlCommitElement = element;
  if (htmlCommitTimer) clearTimeout(htmlCommitTimer);
  htmlCommitTimer = setTimeout(() => { if (htmlCommitElement) void commitHtmlElement(htmlCommitElement); }, 700);
}

async function commitHtmlElement(element: HTMLElement): Promise<void> {
  if (!state.doc || !state.editing || !element.isConnected) return;
  const targetId = element.getAttribute('data-hc-id');
  if (!targetId) return;
  if (htmlCommitTimer) { clearTimeout(htmlCommitTimer); htmlCommitTimer = undefined; }
  const clone = element.cloneNode(true) as HTMLElement;
  clone.removeAttribute('contenteditable');
  clone.removeAttribute('data-hc-selected');
  clone.removeAttribute('data-hc-editing');
  const pageId = state.editing.pageId;
  const blockId = state.editing.blockId;
  const op: HcOp = { op: 'html_patch', pageId, ...(blockId ? { blockId } : {}), patches: [{ op: 'set_html', target: targetId, html: clone.innerHTML }] };
  await applyOps([op], { refreshArtboard: false });
}
function selectedHtmlElement(): Element | null {
  if (!state.iframeDoc || !state.selectedHtmlId) return null;
  return state.iframeDoc.querySelector('[data-hc-id="' + state.selectedHtmlId.replace(/"/g, '\\"') + '"]');
}
function htmlEditingContext(): HtmlEditingContext {
  return {
    getEditing: () => state.editing,
    getIframeDoc: () => state.iframeDoc,
    getSelectedElement: () => selectedHtmlElement(),
    selectElement: element => selectHtmlElement(element),
    applyOps: (ops, options) => applyOps(ops, options),
    toast,
    renderInspector,
    newId: genId,
    undo: () => { void undo(); },
    redo: () => { void redo(); },
  };
}
function renderHtmlInspector(): void {
  renderHtmlInspectorPanel({
    root: el('inspectorPanel'), contentDocument: state.iframeDoc, editing: state.editing, context: htmlEditingContext(),
    editText: element => startInlineTextEdit(element),
    openSource: target => openSourceEditor(target),
  });
}
function field(id: string, label: string, inputHtml: string): string {
  return '<div class="field"><span>' + esc(label) + '</span>' + inputHtml + '</div>';
}
function renderInspector(): void {
  if (state.editing) { renderHtmlInspector(); return; }
  if (!state.doc) return;
  const selected = selectedBlocks();
  if (selected.length > 1) { renderMultiSelectionInspector(selected); return; }
  const block = activeBlock();
  if (block) { renderBlockInspector(); return; }
  renderPageInspector();
}
function renderMultiSelectionInspector(blocks: HcBlock[]): void {
  const root = el('inspectorPanel');
  const groupIds = new Set(blocks.map(block => block.groupId).filter(Boolean));
  let html = '<section class="inspector-section"><div class="inspector-title">Selection · ' + blocks.length + ' blocks</div>';
  html += '<p class="muted">' + blocks.map(block => esc(block.name || block.type)).join(' · ') + '</p>';
  if (groupIds.size) html += '<p class="muted">Group: ' + esc([...groupIds].join(', ')) + '</p>';
  html += '<div class="actions-row"><button id="multiGroupBtn" class="btn tiny">Group</button><button id="multiUngroupBtn" class="btn tiny">Ungroup</button><button id="multiDuplicateBtn" class="btn tiny">Duplicate</button><button id="multiClearBtn" class="btn tiny">Clear</button><button id="multiDeleteBtn" class="btn tiny danger">Delete</button></div></section>';
  html += '<section class="inspector-section"><div class="inspector-title">Multi-transform</div><div class="hint-card">Drag any selected block to move the whole selection. Arrow keys nudge all selected blocks. Group keeps them selectable as one unit. Click empty canvas and drag to marquee-select.</div></section>';
  root.innerHTML = html;
  qs<HTMLButtonElement>('#multiGroupBtn')?.addEventListener('click', () => { void groupSelectedBlocks(); });
  qs<HTMLButtonElement>('#multiUngroupBtn')?.addEventListener('click', () => { void ungroupSelectedBlocks(); });
  qs<HTMLButtonElement>('#multiDuplicateBtn')?.addEventListener('click', () => { void duplicateActiveBlock(); });
  qs<HTMLButtonElement>('#multiClearBtn')?.addEventListener('click', () => setBlockSelection([]));
  qs<HTMLButtonElement>('#multiDeleteBtn')?.addEventListener('click', () => { void deleteSelectedBlocks(); });
}
function renderPageInspector(): void {
  const root = el('inspectorPanel');
  const page = activePage();
  if (!page) { root.innerHTML = '<p class="empty-state">No canvas open.</p>'; return; }
  const blocks = page.blocks || [];
  let html = '<section class="inspector-section"><div class="inspector-title">Page</div>';
  html += field('pageName', 'Name', '<input id="pageName" value="' + esc(page.name) + '">');
  if (page.mode === 'infinite') html += field('pageSurface', 'Surface', '<input id="pageSurface" readonly value="Infinite · no page bounds">');
  else if (page.mode === 'whiteboard') html += field('pageSurface', 'Surface', '<input id="pageSurface" readonly value="Legacy preview · native blocks">');
  else html += '<div class="field-row">' + field('pageWidth', 'Width', '<input id="pageWidth" type="number" value="' + page.width + '">') + field('pageHeight', 'Height', '<input id="pageHeight" type="number" value="' + page.height + '">') + '</div>';
  html += '<div class="field"><span>Background</span><div class="swatch-row"><input id="pageBgPicker" type="color" value="' + esc(toHex(page.background)) + '"><input id="pageBg" value="' + esc(page.background) + '"></div></div>';
  html += '<div class="field"><span>Mode</span><input readonly value="' + esc(page.mode === 'infinite' ? 'infinite canvas' : page.mode) + '"></div>';
  html += '<div class="field"><span>Notes for agent</span><textarea id="pageNotes" rows="2">' + esc(page.notes || '') + '</textarea></div>';
  html += '<div class="actions-row">';
  if (page.mode === 'html') html += '<button id="pageSourceBtn" class="btn tiny">Edit HTML source</button>';
  else if (page.mode !== 'whiteboard') html += '<button id="pageAddHtmlBtn" class="btn tiny">Add HTML block</button><button id="pageAddTextBtn" class="btn tiny">Add text</button>';
  if (page.mode === 'infinite') html += '<button id="pageFitContentBtn" class="btn tiny">Fit content</button>';
  if (page.mode === 'whiteboard') html += '<button id="pageConvertWhiteboardBtn" class="btn tiny primary">Convert to native Infinite</button><button id="pageWhiteboardDownload" class="btn tiny">Download .excalidraw</button>';
  html += '<button id="pageOpenFolderBtn" class="btn tiny">Open page files</button>';
  html += '<button id="pageSaveMasterBtn" class="btn tiny">Save as master</button>';
  html += '<button id="pageDeleteBtn" class="btn tiny danger">Delete page</button></div></section>';
  html += '<section class="inspector-section"><div class="inspector-title">Page structure</div><p class="muted">' + (page.mode === 'html' ? 'HTML page · direct edit enabled' : page.mode === 'infinite' ? 'Infinite canvas · ' + blocks.length + ' block' + (blocks.length === 1 ? '' : 's') + ' · no page bounds' : page.mode === 'whiteboard' ? 'Legacy whiteboard · native read-only preview · ' + ((page.scene?.elements || []).length) + ' scene element' + ((page.scene?.elements || []).length === 1 ? '' : 's') : blocks.length + ' block' + (blocks.length === 1 ? '' : 's') + ' · double-click a block to edit') + '</p>';
  if (page.mode === 'html') html += '<div class="hint-card">Double-click anywhere in the page to enter HTML edit mode. Esc exits. The Agent tab exposes the CLI protocol.</div>';
  if (page.mode === 'infinite') html += '<div class="hint-card">Wheel to zoom at the pointer; Shift+Wheel or Hand tool to pan. Hold Space or middle-drag for temporary panning. Drag shapes to size them; exports crop to content.</div>';
  if (page.mode === 'whiteboard') html += '<div class="hint-card"><strong>Legacy whiteboard.</strong> This page is rendered from its Excalidraw scene through the native block renderer — no Excalidraw runtime is loaded. Convert it with <strong>Convert to native Infinite</strong> above; use <code>hcanvas read &lt;doc&gt; --format scene --page ' + esc(page.id) + '</code> for raw scene access.</div>';
  html += '</section>';
  if (page.mode === 'canvas' || page.mode === 'infinite') { html += componentPickerMarkup(); html += pluginPickerMarkup(); }
  root.innerHTML = html;
  bindPageInspector(page);
}

function bindPageInspector(page: HcPage): void {
  const applyPage = async (patch: Record<string, unknown>, refresh = false): Promise<void> => {
    await applyOps([{ op: 'update_page', pageId: page.id, patch } as HcOp], { refreshArtboard: refresh });
  };
  el<HTMLInputElement>('pageName').addEventListener('change', event => { void applyPage({ name: (event.target as HTMLInputElement).value }); });
  qs<HTMLInputElement>('#pageWidth')?.addEventListener('change', event => { void applyPage({ width: Math.max(100, Number((event.target as HTMLInputElement).value) || page.width) }, true); });
  qs<HTMLInputElement>('#pageHeight')?.addEventListener('change', event => { void applyPage({ height: Math.max(100, Number((event.target as HTMLInputElement).value) || page.height) }, true); });
  const bg = el<HTMLInputElement>('pageBg');
  const picker = el<HTMLInputElement>('pageBgPicker');
  picker.addEventListener('input', () => { bg.value = picker.value; });
  bg.addEventListener('change', () => { picker.value = toHex(bg.value); void applyPage({ background: bg.value }, true); });
  el<HTMLTextAreaElement>('pageNotes').addEventListener('change', event => { void applyPage({ notes: (event.target as HTMLTextAreaElement).value }); });
  qs<HTMLButtonElement>('#pageSourceBtn')?.addEventListener('click', () => openSourceEditor({ pageId: page.id }));
  qs<HTMLButtonElement>('#pageAddHtmlBtn')?.addEventListener('click', () => requestInsert('html'));
  qs<HTMLButtonElement>('#pageAddTextBtn')?.addEventListener('click', () => requestInsert('text'));
  qs<HTMLButtonElement>('#pageFitContentBtn')?.addEventListener('click', () => fitPage());
  qs<HTMLButtonElement>('#pageWhiteboardDownload')?.addEventListener('click', () => downloadWhiteboardScene());
  qs<HTMLButtonElement>('#pageConvertWhiteboardBtn')?.addEventListener('click', () => { void convertWhiteboardPage(page); });
  qs<HTMLButtonElement>('#pageOpenFolderBtn')?.addEventListener('click', () => { void revealProjectFolder(undefined, 'documents'); });
  qs<HTMLButtonElement>('#pageSaveMasterBtn')?.addEventListener('click', () => openSaveMasterModal(page));
  qs<HTMLButtonElement>('#pageDeleteBtn')?.addEventListener('click', () => { void confirmDialog('Delete this page?').then(ok => { if (ok) void deletePage(page.id); }); });
  const openGallery = (): void => openPluginGallery({
    request: api,
    reload: () => loadExternalPlugins(api),
    onChanged: renderInspector,
    open: openGallery,
    close: () => closeModal(),
    openManager,
    openModal: html => openModal(html),
    toast,
  });
  const openManager = (): void => openPluginManager({
    catalog: getPluginCatalog(),
    request: api,
    reload: () => loadExternalPlugins(api),
    onChanged: renderInspector,
    open: openManager,
    openGallery,
    confirm: message => confirmDialog(message),
    close: () => closeModal(),
    openModal: html => openModal(html),
    toast,
  });
  const addPluginBlock = (plugin: HcBlockPlugin): void => {
    const extra: Partial<HcBlock> = { data: plugin.defaultData(), name: plugin.label };
    if (plugin.defaultSize) { extra.w = plugin.defaultSize.w; extra.h = plugin.defaultSize.h; }
    void addBlock(plugin.type, extra);
  };
  bindComponentPicker(el('inspectorPanel'), addPluginBlock);
  bindPluginPicker(el('inspectorPanel'), plugin => {
    addPluginBlock(plugin);
  }, async () => {
    const result = await loadExternalPlugins(api);
    toast('Plugins: ' + result.loaded + ' block' + (result.loaded === 1 ? '' : 's') + ' loaded' + (result.errors.length ? ' · ' + result.errors.length + ' error' + (result.errors.length === 1 ? '' : 's') : ''), result.errors.length ? 'error' : 'success');
    renderInspector();
  }, () => openManager());
}

function renderBlockInspector(): void {
  const block = activeBlock();
  const page = activePage();
  if (!block || !page) return;
  const root = el('inspectorPanel');
  let html = '<section class="inspector-section"><div class="inspector-title">Block · ' + esc(block.type) + '</div>';
  html += field('blockName', 'Name', '<input id="blockName" value="' + esc(block.name || '') + '" placeholder="Optional label">');
  html += '<div class="field-row">' + field('blockX', 'X', '<input id="blockX" type="number" value="' + block.x + '">') + field('blockY', 'Y', '<input id="blockY" type="number" value="' + block.y + '">') + '</div>';
  html += '<div class="field-row">' + field('blockW', 'W', '<input id="blockW" type="number" value="' + block.w + '">') + field('blockH', 'H', '<input id="blockH" type="number" value="' + block.h + '">') + '</div>';
  if (block.type === 'html') html += '<div class="hint-card">Double-click the block to edit HTML in place. Stable IDs stay attached to elements.</div>';
  if (block.shape === 'frame') html += '<div class="hint-card">A frame is a visual container, not a canvas boundary. It does not clip content. Drag the frame to move its <code>frameId</code> children, or <strong>Dissolve frame</strong> to keep children and remove the frame.</div>';
  html += '<div class="actions-row">';
  if (block.type === 'html') html += '<button id="blockEditHtmlBtn" class="btn tiny primary">Edit HTML</button><button id="blockSourceBtn" class="btn tiny">Source</button>';
  if (block.type === 'markdown' || block.type === 'code' || block.type === 'text') html += '<button id="blockSourceBtn" class="btn tiny">Edit source</button>';
  if (block.type === 'math') html += '<button id="blockMathEditBtn" class="btn tiny primary">Edit formula</button>';
  if (block.type === 'image') html += '<button id="blockImageBtn" class="btn tiny">Set image URL</button>';
  if (block.shape === 'frame') html += '<button id="blockDissolveFrameBtn" class="btn tiny">Dissolve frame</button>';
  html += '<button id="blockFrontBtn" class="btn tiny">Front</button><button id="blockBackBtn" class="btn tiny">Back</button><button id="blockDeleteBtn" class="btn tiny danger">Delete</button></div></section>';
  html += '<section class="inspector-section"><div class="inspector-title">Style</div>';
  html += '<div class="field"><span>Rotation</span><input id="blockRotation" type="number" step="1" value="' + (Number(block.rotation) || 0) + '"></div>';
  if (block.type === 'math') html += '<div class="field"><span>LaTeX</span><textarea id="blockMathTex" rows="3">' + esc(String(block.data?.tex || '')) + '</textarea></div>';
  if (block.type === 'shape') {
    const shapeOptions = HCANVAS_SHAPE_CATEGORIES.map(category => '<optgroup label="' + esc(category) + '">' + HCANVAS_SHAPES.filter(shape => !shape.hidden && shape.category === category).map(shape => '<option value="' + shape.id + '"' + (block.shape === shape.id ? ' selected' : '') + '>' + esc(shape.label) + '</option>').join('') + '</optgroup>').join('');
    html += '<div class="field"><span>Shape</span><select id="blockShape">' + shapeOptions + (block.shape === 'polygon' ? '<optgroup label="Cut"><option value="polygon" selected>Polygon</option></optgroup>' : '') + '</select></div>';
    html += '<div class="field"><span>Shape text</span><textarea id="blockShapeText" rows="2">' + esc(block.text || '') + '</textarea></div>';
  }
  if (block.type === 'text' || block.type === 'markdown' || block.type === 'shape') {
    html += '<div class="field-row">' + field('blockFontSize', 'Font size', '<input id="blockFontSize" type="number" value="' + (block.style?.fontSize || (block.type === 'shape' ? 18 : 20)) + '">') + field('blockColor', 'Color', '<input id="blockColor" type="color" value="' + esc(toHex(String(block.style?.color || '#1d232e'))) + '">') + '</div>';
  }
  if (block.type === 'shape' || block.type === 'html' || block.type === 'markdown') {
    html += '<div class="field-row">' + field('blockFill', 'Fill', '<input id="blockFill" type="color" value="' + esc(toHex(String(block.style?.fill || '#f3e8ff'))) + '">') + field('blockStroke', 'Stroke', '<input id="blockStroke" type="color" value="' + esc(toHex(String(block.style?.stroke || '#a855f7'))) + '">') + '</div>';
  }
  if (block.type === 'freehand' || block.type === 'arrow' || block.type === 'curve' || block.type === 'arc') {
    html += '<div class="field-row">' + field('blockStroke', 'Stroke', '<input id="blockStroke" type="color" value="' + esc(toHex(String(block.style?.stroke || block.style?.color || '#1f2430'))) + '">') + field('blockVectorWidth', 'Width', '<input id="blockVectorWidth" type="number" min="1" max="40" value="' + (block.style?.strokeWidth || 2) + '">') + '</div>';
    if (block.type === 'arrow') html += '<div class="field">' + '<span>Arrowhead</span><select id="blockArrowhead"><option value="arrow"' + ((block.arrowhead ?? 'arrow') === 'arrow' ? ' selected' : '') + '>Arrow</option><option value="none"' + (block.arrowhead === 'none' ? ' selected' : '') + '>None</option></select></div>';
  }
  html += '</section>';
  html += pluginInspectorMarkup(block);
  root.innerHTML = html;
  bindBlockInspector(block);
}

function bindBlockInspector(block: HcBlock): void {
  const page = activePage();
  if (!page) return;
  const update = async (patch: Partial<HcBlock>, refresh = true): Promise<void> => {
    await applyOps([{ op: 'update_block', pageId: page.id, blockId: block.id, patch } as HcOp], { refreshArtboard: refresh });
    renderInspector();
  };
  bindPluginInspector(el('inspectorPanel'), block, data => { void update({ data }); });
  el<HTMLInputElement>('blockName').addEventListener('change', event => { void update({ name: (event.target as HTMLInputElement).value }, false); });
  el<HTMLInputElement>('blockX').addEventListener('change', event => { void update({ x: Number((event.target as HTMLInputElement).value) || 0 }); });
  el<HTMLInputElement>('blockY').addEventListener('change', event => { void update({ y: Number((event.target as HTMLInputElement).value) || 0 }); });
  const resizeVector = (nextW: number, nextH: number): Partial<HcBlock> => {
    if ((block.type !== 'freehand' && block.type !== 'arrow' && block.type !== 'curve') || !block.points?.length) return { w: nextW, h: nextH };
    return { w: nextW, h: nextH, points: block.points.map(point => ({ x: point.x * nextW / block.w, y: point.y * nextH / block.h })) };
  };
  el<HTMLInputElement>('blockW').addEventListener('change', event => { const nextW = Math.max(20, Number((event.target as HTMLInputElement).value) || block.w); void update(resizeVector(nextW, block.h)); });
  el<HTMLInputElement>('blockH').addEventListener('change', event => { const nextH = Math.max(20, Number((event.target as HTMLInputElement).value) || block.h); void update(resizeVector(block.w, nextH)); });
  qs<HTMLButtonElement>('#blockEditHtmlBtn')?.addEventListener('click', () => enterHtmlEdit(page.id, block.id));
  qs<HTMLButtonElement>('#blockSourceBtn')?.addEventListener('click', () => openSourceEditor({ pageId: page.id, blockId: block.id }));
  qs<HTMLButtonElement>('#blockImageBtn')?.addEventListener('click', () => openImageModal(block));
  qs<HTMLInputElement>('#blockRotation')?.addEventListener('change', event => { void update({ rotation: Number((event.target as HTMLInputElement).value) || 0 }); });
  qs<HTMLButtonElement>('#blockMathEditBtn')?.addEventListener('click', () => openFormulaModal(block));
  qs<HTMLTextAreaElement>('#blockMathTex')?.addEventListener('change', event => { void update({ data: { ...(block.data || {}), tex: (event.target as HTMLTextAreaElement).value } }); });
  qs<HTMLButtonElement>('#blockDissolveFrameBtn')?.addEventListener('click', () => { void dissolveFrame(block); });
  qs<HTMLButtonElement>('#blockDeleteBtn')?.addEventListener('click', () => { void confirmDialog('Delete this block?').then(ok => { if (ok) void deleteBlock(page.id, block.id); }); });
  qs<HTMLButtonElement>('#blockFrontBtn')?.addEventListener('click', () => { void update({ z: Math.max(...(page.blocks || []).map(item => item.z)) + 1 }); });
  qs<HTMLButtonElement>('#blockBackBtn')?.addEventListener('click', () => { void update({ z: Math.min(...(page.blocks || []).map(item => item.z)) - 1 }); });
  const fontSize = qs<HTMLInputElement>('#blockFontSize');
  const color = qs<HTMLInputElement>('#blockColor');
  const fill = qs<HTMLInputElement>('#blockFill');
  const stroke = qs<HTMLInputElement>('#blockStroke');
  const vectorWidth = qs<HTMLInputElement>('#blockVectorWidth');
  const arrowhead = qs<HTMLSelectElement>('#blockArrowhead');
  const shapeSelect = qs<HTMLSelectElement>('#blockShape');
  if (shapeSelect) shapeSelect.addEventListener('change', () => { if (isHcShape(shapeSelect.value)) void update({ shape: shapeSelect.value }, true); });
  qs<HTMLTextAreaElement>('#blockShapeText')?.addEventListener('change', () => { void update({ text: qs<HTMLTextAreaElement>('#blockShapeText')?.value || '' }); });
  if (fontSize) fontSize.addEventListener('change', () => { void update({ style: { ...(block.style || {}), fontSize: Number(fontSize.value) || 20 } }); });
  if (color) color.addEventListener('change', () => { void update({ style: { ...(block.style || {}), color: color.value } }); });
  if (fill) fill.addEventListener('change', () => { void update({ style: { ...(block.style || {}), fill: fill.value } }); });
  if (stroke) stroke.addEventListener('change', () => { void update({ style: { ...(block.style || {}), stroke: stroke.value } }); });
  if (vectorWidth) vectorWidth.addEventListener('change', () => { void update({ style: { ...(block.style || {}), strokeWidth: Math.max(1, Math.min(40, Number(vectorWidth.value) || 2)) } }); });
  if (arrowhead) arrowhead.addEventListener('change', () => { void update({ arrowhead: arrowhead.value === 'none' ? 'none' : 'arrow' }); });
}

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return 'unknown';
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return Math.round(delta / 60_000) + 'm ago';
  if (delta < 86_400_000) return Math.round(delta / 3_600_000) + 'h ago';
  return Math.round(delta / 86_400_000) + 'd ago';
}

function initials(value: string): string {
  return value.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || 'A';
}

function renderPresence(): void {
  const agentBadge = qs<HTMLElement>('#agentCount');
  if (agentBadge) {
    const connected = state.presence.filter(item => !item.stale).length;
    agentBadge.textContent = String(connected);
    agentBadge.classList.toggle('hidden', connected === 0);
  }
  const bar = el('presenceBar');
  if (!bar) return;
  const active = state.presence.filter(item => !item.stale);
  bar.textContent = '';
  if (!active.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.title = active.map(item => item.actor + ' · ' + item.docTitle + (item.pageName ? ' / ' + item.pageName : '')).join('\n');
  active.slice(0, 5).forEach(item => {
    const avatar = document.createElement('span');
    avatar.className = 'presence-avatar';
    avatar.style.background = 'hsl(' + (item.actor.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360) + ', 55%, 58%)';
    avatar.textContent = initials(item.actor);
    bar.appendChild(avatar);
  });
  if (active.length > 5) {
    const more = document.createElement('span');
    more.className = 'presence-more';
    more.textContent = '+' + (active.length - 5);
    bar.appendChild(more);
  }
  bar.onclick = () => { state.tab = 'agent'; renderTabs(); renderAgent(); };
}

async function refreshPresence(): Promise<void> {
  try {
    const snapshot = await api<{ presence?: PresenceEntry[]; docs?: DocSummary[] }>('/api/state');
    state.presence = snapshot.presence || [];
    if (snapshot.docs) state.docs = snapshot.docs;
    renderPresence();
    if (state.tab === 'agent') renderAgent();
    renderDocs();

  } catch { /* presence is best effort */ }
}

function renderAgent(): void {
  const root = el('agentPanel');
  const page = activePage();
  const activeSessions = state.presence.filter(item => !item.stale);
  const allSessions = state.presence;
  const context = {
    workspace: boot.workspace,
    active: state.doc && page ? { docId: state.doc.id, title: state.doc.title, revision: state.doc.revision, pageId: page.id, pageName: page.name, pageMode: page.mode, blockId: state.activeBlockId, selection: state.selectedHtmlId ? [state.selectedHtmlId] : [] } : null,
    protocol: { cli: 'hcanvas', read: 'hcanvas read <doc> --format outline', write: 'hcanvas apply <doc> --ops-file ops.json --base-revision <rev>', propose: 'hcanvas propose <doc> ...' },
  };
  const docId = state.doc?.id || '<docId>';
  const revision = state.doc?.revision ?? 0;
  const agentPrompt = buildAgentPrompt({
    workspace: boot.workspace,
    docId,
    title: state.doc?.title,
    revision,
    pageId: page?.id,
    pageName: page?.name,
    pageMode: page?.mode,
  });
  const contextText = JSON.stringify(context, null, 2);
  const count = activeSessions.length;
  const agentCount = el('agentCount');
  if (agentCount) {
    agentCount.textContent = String(count);
    agentCount.classList.toggle('hidden', count === 0);
  }

  let html = '<section class="inspector-section agent-hero">';
  html += '<div class="agent-hero-head"><span class="agent-mark">A</span><div><div class="inspector-title">Agent bridge</div><p class="agent-lede">Copy the prompt and send it to your coding agent in its chat. hcanvas does not start an agent; it observes the sessions and changes they report.</p></div></div>';
  html += '<div class="agent-status-row">';
  html += '<span class="agent-chip ' + (count ? 'online' : 'off') + '"><span class="agent-dot"></span>' + (count ? count + ' connected' : 'No agent connected') + '</span>';
  html += '<span class="agent-chip">rev ' + revision + '</span>';
  html += '<span class="agent-chip">' + esc(page ? page.name : 'No page') + '</span>';
  html += '</div>';
  html += '<div class="agent-hero-actions"><button id="copyConnectBtn" class="btn tiny primary">Copy agent prompt</button><button id="refreshPresenceBtn" class="btn tiny">Refresh</button></div>';
  html += '</section>';

  html += '<section class="inspector-section"><div class="inspector-title">Live sessions <span class="presence-count">' + count + '</span></div>';
  html += '<p class="agent-section-lede">Each row is a terminal or API client that has recently read or written this document.</p>';
  html += '<div class="presence-list">';
  html += '<div class="presence-card human"><span class="presence-avatar" style="background:#1f2430">Y</span><div class="presence-copy"><strong>You · this window</strong><small>' + esc(page ? page.name : 'No page') + ' · editing in the browser</small></div><span class="presence-status">local</span></div>';
  for (const session of allSessions) {
    html += '<div class="presence-card' + (session.stale ? ' stale' : '') + '" data-session-id="' + esc(session.id) + '">' +
      '<span class="presence-avatar" style="background:hsl(' + (session.actor.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360) + ',55%,58%)">' + esc(initials(session.actor)) + '</span>' +
      '<div class="presence-copy"><strong>' + esc(session.actor) + '</strong><small>' + esc(session.docTitle) + (session.pageName ? ' / ' + esc(session.pageName) : '') + ' · ' + relativeTime(session.updatedAt) + '</small>' +
      (session.selection && session.selection.length ? '<small class="presence-selection">selection: ' + esc(session.selection.join(', ')) + '</small>' : '') +
      '</div><span class="presence-status ' + (session.stale ? 'idle' : 'online') + '">' + (session.stale ? 'idle' : 'active') + '</span>' +
      '<button class="presence-copy-btn" data-copy-session="' + esc(session.id) + '" title="Copy session id">⧉</button></div>';
  }
  if (!allSessions.length) {
    html += '<div class="agent-empty"><strong>No agent sessions yet</strong><p>Copy the agent prompt above and send it to your coding agent in its chat. It will read the document and can optionally create a live session.</p><button type="button" class="btn tiny" data-copy-command="' + esc(agentPrompt) + '">Copy agent prompt</button></div>';
  }
  html += '</div></section>';

  html += '<section class="inspector-section"><div class="inspector-title">Recent edits</div>';
  const history = state.doc?.history?.slice(-8).reverse() || [];
  if (history.length) {
    html += '<div class="history-list">';
    for (const entry of history) {
      html += '<div class="history-row"><span class="history-actor">' + esc(entry.actor) + '</span><span class="history-summary">' + esc(entry.summary) + '</span><span class="history-time">rev ' + entry.revision + ' · ' + relativeTime(entry.createdAt) + '</span></div>';
    }
    html += '</div>';
  } else {
    html += '<p class="agent-muted">No edits recorded yet. Changes made by this window or by an agent will appear here.</p>';
  }
  html += '</section>';

  html += '<section class="inspector-section"><details class="agent-context-details" open><summary><span>Agent prompt</span><span class="agent-summary-meta">paste into the agent chat</span></summary>';
  html += '<p class="agent-muted">Ready-to-send prompt with the current workspace, document, page and revision.</p>';
  html += '<pre class="agent-context-pre">' + esc(agentPrompt) + '</pre>';
  html += '<div class="agent-copy"><button id="copyAgentPromptBtn" class="btn tiny primary">Copy agent prompt</button></div></details></section>';
  html += '<section class="inspector-section"><details class="agent-context-details"><summary><span>Context JSON</span><span class="agent-summary-meta">' + (state.doc ? 'current doc/page' : 'no active doc') + '</span></summary>';
  html += '<p class="agent-muted">Paste this into an agent prompt, or let it run <code>hcanvas context --json</code>.</p>';
  html += '<pre class="agent-context-pre">' + esc(contextText) + '</pre>';
  html += '<div class="agent-copy"><button id="copyContextBtn" class="btn tiny">Copy context JSON</button></div></details></section>';

  html += '<section class="inspector-section"><div class="inspector-title">CLI reference</div>';
  html += '<p class="agent-section-lede">The prompt already contains these commands. Use them in the terminal only when you want to drive hcanvas yourself.</p>';
  html += '<ol class="agent-steps">';
  const commands: Array<[string, string, string]> = [
    ['1', 'Optional: live presence session', 'hcanvas sessions create ' + docId + ' --actor <your-agent-name>'],
    ['2', 'Use the session id', 'export HCANVAS_SESSION=<sessionId>'],
    ['3', 'Read the current page', 'hcanvas context --json'],
    ['4', 'Inspect the document', 'hcanvas read ' + docId + ' --format outline'],
    ['5', 'Apply changes safely', 'hcanvas apply ' + docId + ' --ops-file ops.json --base-revision ' + revision],
  ];
  for (const [step, label, command] of commands) {
    html += '<li><span class="agent-step-no">' + step + '</span><div class="agent-step-body"><strong>' + label + '</strong><code>' + esc(command) + '</code></div><button type="button" class="agent-copy-btn" data-copy-command="' + esc(command) + '" title="Copy command">Copy</button></li>';
  }
  html += '</ol>';
  html += '<p class="agent-muted">Always read first and pass the returned revision to <code>apply</code>. Sessions heartbeat automatically on context/read/apply.</p>';
  html += '</section>';
  root.innerHTML = html;

  qs<HTMLButtonElement>('#copyConnectBtn')?.addEventListener('click', () => { void copyText(agentPrompt); });
  qs<HTMLButtonElement>('#copyAgentPromptBtn')?.addEventListener('click', () => { void copyText(agentPrompt); });
  qs<HTMLButtonElement>('#copyContextBtn')?.addEventListener('click', () => { void copyText(contextText); });
  qs<HTMLButtonElement>('#refreshPresenceBtn')?.addEventListener('click', () => { void refreshPresence(); });
  root.querySelectorAll<HTMLButtonElement>('[data-copy-session]').forEach(button => {
    button.addEventListener('click', event => { event.stopPropagation(); void copyText(button.dataset.copySession || ''); });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-copy-command]').forEach(button => {
    button.addEventListener('click', () => { void copyText(button.dataset.copyCommand || ''); });
  });
}


function renderProposalBadge(): void {
  const proposals = state.doc?.proposals || [];
  const pending = proposals.filter(proposal => proposal.status === 'pending');
  const badge = el('proposalCount');
  badge.textContent = String(pending.length);
  badge.classList.toggle('hidden', pending.length === 0);
}

function renderProposals(): void {
  const root = el('proposalsPanel');
  if (!state.doc) return;
  const proposals = state.doc.proposals;
  renderProposalBadge();
  if (!proposals.length) { root.innerHTML = '<p class="empty-state">No proposals yet. Agents can submit changes with <code>hcanvas propose</code>.</p>'; return; }
  let html = '';
  for (const proposal of proposals.slice().reverse()) {
    html += '<div class="proposal-card"><strong>' + esc(proposal.intent) + '</strong><div class="proposal-meta">' + esc(proposal.actor) + ' · base rev ' + proposal.baseRevision + ' · ' + esc(proposal.status) + '</div><div class="proposal-ops">' + esc(JSON.stringify(proposal.ops, null, 2)).slice(0, 1200) + '</div>';
    if (proposal.status === 'pending') html += '<div class="proposal-actions"><button class="btn tiny primary" data-accept="' + esc(proposal.id) + '">Accept</button><button class="btn tiny" data-reject="' + esc(proposal.id) + '">Reject</button></div>';
    if (proposal.conflict) html += '<p class="inspector-note">Conflict: ' + esc(proposal.conflict) + '</p>';
    html += '</div>';
  }
  root.innerHTML = html;
  root.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach(button => button.addEventListener('click', () => { void resolveProposal(button.dataset.accept || '', true); }));
  root.querySelectorAll<HTMLButtonElement>('[data-reject]').forEach(button => button.addEventListener('click', () => { void resolveProposal(button.dataset.reject || '', false); }));
}

async function resolveProposal(proposalId: string, accept: boolean): Promise<void> {
  if (!state.doc) return;
  try {
    const result = await api<{ doc: HcDocument; conflict?: string }>('/api/docs/' + state.doc.id + '/proposals/' + proposalId + '/' + (accept ? 'accept' : 'reject'), { method: 'POST', body: JSON.stringify({ actor: 'human' }) });
    state.doc = result.doc;
    patchDocSummary(result.doc);
    renderAll();
    toast(result.conflict ? 'Proposal conflicted: ' + result.conflict : accept ? 'Proposal accepted' : 'Proposal rejected', result.conflict ? 'error' : 'success');
  } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
}

function connectEvents(): void {
  try {
    const source = new EventSource('/api/events?token=' + encodeURIComponent(boot.token));
    source.addEventListener('canvas', event => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse((event as MessageEvent).data) as Record<string, unknown>; } catch { return; }
      if (payload.type === 'doc.changed' && payload.docId === state.doc?.id) {
        if (payload.source === clientId) return;
        if (state.editing) { toast('Canvas changed elsewhere. Exit HTML edit to reload.', 'info'); return; }
        if (remoteReloadTimer) clearTimeout(remoteReloadTimer);
        remoteReloadTimer = setTimeout(() => { remoteReloadTimer = undefined; void reloadActiveDoc(); }, 120);
      }
      if (payload.type === 'session.changed') {
        if (presenceRefreshTimer) clearTimeout(presenceRefreshTimer);
        presenceRefreshTimer = setTimeout(() => { presenceRefreshTimer = undefined; void refreshPresence(); }, 250);
      }
      if ((payload.type === 'proposal.created' || payload.type === 'proposal.resolved') && state.doc) {
        void api<{ doc: HcDocument }>('/api/docs/' + state.doc.id).then(result => { state.doc = result.doc; renderProposals(); renderAll(); }).catch(() => undefined);
      }
    });
  } catch { /* SSE optional */ }
}

async function deletePage(pageId: string): Promise<void> {
  const result = await applyOps([{ op: 'delete_page', pageId }], { refreshArtboard: false });
  if (!result) return;
  state.activePageId = result.pages[0]?.id || null;
  state.activeBlockId = null;
  state.selectedBlockIds = [];
  renderAll();
}

async function deleteActiveBlock(): Promise<void> {
  const page = activePage();
  if (!page || !state.activeBlockId) return;
  await deleteBlock(page.id, state.activeBlockId);
}

async function deleteBlock(pageId: string, blockId: string): Promise<void> {
  state.activeBlockId = null;
  state.selectedBlockIds = [];
  await applyOps([{ op: 'delete_block', pageId, blockId }], { refreshArtboard: true });
  renderInspector();
}

function openShapePicker(): void {
  shapePicker?.open();
}

function requestInsert(type: HcBlock['type']): void {
  if (type === 'image') { openImageModal(); return; }
  const page = activePage();
  if (!page) return;
  if (page.mode === 'html' || page.mode === 'whiteboard') { toast('Switch to a Canvas or Infinite page to add blocks.', 'info'); return; }
  state.pendingInsert = type;
  state.tool = 'select';
  setBlockSelection([]);
  toast(type === 'shape' ? 'Click for a default shape or drag to draw it. Esc cancels.' : 'Click the canvas to place ' + type + '. Esc cancels.', 'info');
}

function cancelInsert(): void {
  if (!state.pendingInsert) return;
  state.pendingInsert = null;
  state.pendingShape = null;
  renderToolbarState();
}

async function dissolveFrame(block: HcBlock): Promise<void> {
  const page = activePage();
  if (!page || block.shape !== 'frame') return;
  const children = (page.blocks || []).filter(item => item.frameId === block.id);
  const ops: HcOp[] = children.map(child => ({ op: 'update_block', pageId: page.id, blockId: child.id, patch: { frameId: null } } as HcOp));
  ops.push({ op: 'delete_block', pageId: page.id, blockId: block.id } as HcOp);
  const result = await applyOps(ops, { refreshArtboard: true });
  if (!result) return;
  setBlockSelection(children.map(child => child.id));
  toast('Frame dissolved; ' + children.length + ' child block(s) kept', 'success');
}

async function addBlock(type: HcBlock['type'], extra: Partial<HcBlock> = {}, position?: { x: number; y: number }): Promise<void> {
  const page = activePage();
  if (!page) return;
  if (page.mode === 'html') { toast('Add blocks on a canvas or infinite page, not an HTML page.', 'error'); return; }
  const z = Math.max(0, ...(page.blocks || []).map(block => block.z)) + 1;
  const center = position || (page.mode === 'infinite' ? viewportWorldCenter() : { x: page.width / 2, y: page.height / 2 });
  const blockW = Number(extra.w) || 420;
  const blockH = Number(extra.h) || 240;
  const startX = page.mode === 'infinite' ? snapCoordinate(center.x - blockW / 2) : Math.max(0, Math.min(Math.max(0, page.width - blockW), Math.round(center.x - blockW / 2)));
  const startY = page.mode === 'infinite' ? snapCoordinate(center.y - blockH / 2) : Math.max(0, Math.min(Math.max(0, page.height - blockH), Math.round(center.y - blockH / 2)));
  const block: HcBlock = {
    id: genId('block'), type, x: startX, y: startY, w: blockW, h: blockH, z, layerId: activeLayerId(page), name: type + ' block',
    ...(type === 'html' ? { html: '<div style="box-sizing:border-box;height:100%;padding:28px;border:1px solid #e7e0d2;border-radius:18px;background:#fffdf8;font-family:Inter,sans-serif;color:#2e2a24"><h2 style="margin:0 0 8px;font-family:Georgia,serif;font-weight:500;font-size:28px;letter-spacing:-.03em">New HTML block</h2><p style="margin:0;font-size:15px;line-height:1.6;color:#655e52">Double-click to edit text directly.</p></div>' } : {}),
    ...(type === 'text' ? { text: 'New text block', style: { fontSize: 30, fontWeight: 600, color: '#1d232e' } } : {}),
    ...(type === 'markdown' ? { markdown: '## New markdown block\n\nWrite **markdown** here.', style: { fill: '#ffffff', radius: 16 } } : {}),
    ...(type === 'code' ? { code: 'const answer = 42;', language: 'ts', style: { fill: '#171923', color: '#e2e8f0', radius: 14 } } : {}),
    ...(type === 'image' ? { src: 'https://images.unsplash.com/photo-1518005020951-eccb494ad742?w=1200&q=80', alt: 'Image' } : {}),
    ...(type === 'shape' ? { shape: 'rect', style: { fill: '#f3e8ff', stroke: '#a855f7', strokeWidth: 1, radius: 16 } } : {}),
    ...(type === 'math' ? { data: { tex: 'E = mc^2' }, w: 520, h: 160 } : {}),
    ...extra,
  };
  const result = await applyOps([{ op: 'add_block', pageId: page.id, block }], { refreshArtboard: true });
  if (result) setBlockSelection([block.id], block.id);
}

function openImageModal(block?: HcBlock): void {
  const page = activePage();
  if (!page) return;
  const html = '<div class="modal small"><div class="modal-head"><div><strong>' + (block ? 'Set image URL' : 'Add image block') + '</strong><small>Use a public URL or data URL.</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="field"><span>Image URL</span><input id="imageUrlInput" value="' + esc(block?.src || '') + '" placeholder="https://..."></div><div class="field"><span>Alt text</span><input id="imageAltInput" value="' + esc(block?.alt || '') + '"></div></div><div class="modal-foot"><button class="btn" data-close>Cancel</button><button id="imageSaveBtn" class="btn primary">Apply</button></div></div>';
  openModal(html);
  qs<HTMLButtonElement>('#imageSaveBtn')?.addEventListener('click', () => {
    const src = qs<HTMLInputElement>('#imageUrlInput')?.value || '';
    const alt = qs<HTMLInputElement>('#imageAltInput')?.value || '';
    closeModal();
    if (block) void applyOps([{ op: 'update_block', pageId: page.id, blockId: block.id, patch: { src, alt } }], { refreshArtboard: true }).then(renderInspector);
    else void addBlock('image', { src, alt, w: 420, h: 260 });
  });
}

function closeProjectHub(): void {
  el('projectHub').classList.add('hidden');
}

async function openProjectHub(): Promise<void> {
  el('projectHub').classList.remove('hidden');
  await renderProjectHub();
}

async function revealProjectFolder(projectPath?: string, kind: 'project' | 'workspace' | 'documents' = 'project'): Promise<void> {
  try {
    const result = await api<{ ok: boolean; path: string }>('/api/projects/reveal', { method: 'POST', body: JSON.stringify({ projectPath: projectPath || '', kind }) });
    toast('Opened folder: ' + result.path, 'success');
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function renderProjectHub(): Promise<void> {
  const grid = el('hubProjectGrid');
  const current = await api<{ current: { workspace: string; project?: string | null }; projects: Array<{ id: string; name: string; projectPath: string; workspacePath: string; runningUrl: string | null; workspaceExists: boolean }> }>('/api/projects').catch(() => null);
  if (!current) { grid.innerHTML = '<p class="empty-state">Could not read the project registry.</p>'; return; }
  let projects = current.projects;
  if (window.hcanvasDesktop) {
    try {
      const nativeProjects = await window.hcanvasDesktop.listProjects();
      if (nativeProjects.length) projects = nativeProjects.map(project => ({ ...project, workspaceExists: project.workspaceExists, runningUrl: project.runningUrl }));
    } catch { /* use server registry */ }
  }
  el('hubCurrentWorkspace').textContent = 'Current workspace: ' + current.current.workspace;
  if (!projects.length) {
    grid.innerHTML = '<div class="hub-empty"><h2>No projects yet</h2><p>Create a project from a folder. hcanvas will initialize <code>.hcanvas/</code> inside it and keep all data there.</p><button id="hubEmptyNewBtn" class="btn primary">Choose a project folder…</button></div>';
    qs<HTMLButtonElement>('#hubEmptyNewBtn')?.addEventListener('click', () => { if (window.hcanvasDesktop) void window.hcanvasDesktop.chooseProject(); else toast('Browser mode: run hcanvas app --project <folder>.', 'info'); });
    return;
  }
  grid.innerHTML = projects.map(project => {
    const active = current.current.project === project.projectPath;
    const running = Boolean(project.runningUrl);
    const action = active ? 'Return to this canvas →' : window.hcanvasDesktop ? 'Open in new window ↗' : running ? 'Open in new tab ↗' : 'Not running';
    return '<article class="hub-card' + (active ? ' current' : '') + '" role="button" tabindex="0" data-hub-project="' + esc(project.projectPath) + '">' +
      '<div class="hub-card-top"><strong>' + esc(project.name) + '</strong><span class="hub-badge ' + (active ? 'current' : running ? 'running' : 'idle') + '">' + (active ? 'current' : running ? 'running' : 'closed') + '</span></div>' +
      '<small class="hub-card-path">' + esc(project.projectPath) + '</small>' +
      '<small class="hub-card-workspace">' + esc(project.workspacePath) + '</small>' +
      '<div class="hub-card-actions"><span class="hub-card-action">' + action + '</span><button type="button" class="hub-folder-btn" data-hub-folder="' + esc(project.projectPath) + '" title="Open project folder">📁 Open folder</button></div></article>';
  }).join('');
  grid.querySelectorAll<HTMLElement>('[data-hub-project]').forEach(card => {
    const openProject = (): void => {
      const projectPath = card.dataset.hubProject!;
      if (current.current.project === projectPath) { closeProjectHub(); return; }
      if (window.hcanvasDesktop) { void window.hcanvasDesktop.openProject(projectPath); return; }
      const record = projects.find(project => project.projectPath === projectPath);
      if (record?.runningUrl) window.open(record.runningUrl, '_blank', 'noopener');
      else toast('Project is not running. Start it with: hcanvas app --project ' + projectPath, 'info');
    };
    card.addEventListener('click', openProject);
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProject(); } });
  });
  grid.querySelectorAll<HTMLButtonElement>('[data-hub-folder]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    void revealProjectFolder(button.dataset.hubFolder!);
  }));
}

async function openWorkspaceModal(): Promise<void> {
  try {
    const info = await api<{ workspace: string; project?: string | null; guidePath: string; guide: string }>('/api/workspace');
    const canOpen = Boolean(window.hcanvasDesktop);
    const html = '<div class="modal"><div class="modal-head"><div><strong>Workspace</strong><small>All hcanvas content lives in this directory.</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-body">' +
      '<div class="field"><span>Workspace</span><input readonly value="' + esc(info.workspace) + '"></div>' +
      (info.project ? '<div class="field"><span>Project</span><input readonly value="' + esc(info.project) + '"></div>' : '') +
      '<div class="field"><span>CLI guide</span><input readonly value="' + esc(info.guidePath) + '"></div>' +
      '<div class="hint-card">Start another app on a project folder:<br><br><code>hcanvas app --project /path/to/project</code><br><br>The project gets a <code>.hcanvas/</code> directory with docs, state, masters, exports and CLI.md.</div>' +
      '<div class="workspace-guide">' + esc(info.guide) + '</div>' +
      '</div><div class="modal-foot"><button id="revealWorkspaceFolderBtn" class="btn">Open project folder</button>' + (canOpen ? '<button id="workspaceOpenProjectBtn" class="btn">Open Project…</button>' : '') + '<button id="copyWorkspaceGuideBtn" class="btn">Copy CLI guide</button><button class="btn" data-close>Close</button></div></div>';
    openModal(html);
    qs<HTMLButtonElement>('#copyWorkspaceGuideBtn')?.addEventListener('click', () => { void copyText(info.guide); });
    qs<HTMLButtonElement>('#revealWorkspaceFolderBtn')?.addEventListener('click', () => { void revealProjectFolder(info.project || undefined); });
    qs<HTMLButtonElement>('#workspaceOpenProjectBtn')?.addEventListener('click', () => { if (window.hcanvasDesktop) void window.hcanvasDesktop.chooseProject(); });
  } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
}

function openSaveMasterModal(page: HcPage): void {
  const html = '<div class="modal small"><div class="modal-head"><div><strong>Save page as master</strong><small>Reuse this layout across documents in this workspace.</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="field"><span>Master name</span><input id="masterNameInput" value="' + esc(page.name) + '" placeholder="e.g. Title slide"></div></div><div class="modal-foot"><button class="btn" data-close>Cancel</button><button id="saveMasterBtn" class="btn primary">Save master</button></div></div>';
  openModal(html);
  qs<HTMLButtonElement>('#saveMasterBtn')?.addEventListener('click', async () => {
    if (!state.doc) return;
    const name = qs<HTMLInputElement>('#masterNameInput')?.value || page.name;
    try {
      closeModal();
      await api('/api/masters', { method: 'POST', body: JSON.stringify({ docId: state.doc.id, pageId: page.id, name }) });
      await loadMasters();
      toast('Page saved as master', 'success');
    } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
  });
}

function masterPreviewHtml(master: MasterSummary): string {
  const ratio = Math.min(150 / master.width, 84 / master.height);
  const width = master.width * ratio;
  const height = master.height * ratio;
  if (master.html) {
    return '<div class="master-thumb"><iframe sandbox srcdoc="' + esc(master.html) + '" style="width:' + master.width + 'px;height:' + master.height + 'px;transform:scale(' + ratio + ');transform-origin:top left;border:0;pointer-events:none" tabindex="-1"></iframe><span class="master-thumb-label">' + esc(master.mode) + '</span></div>';
  }
  if (master.blocks?.length) {
    const page: HcPage = { id: 'master_preview', name: master.name, mode: master.mode as HcPage['mode'], width: master.width, height: master.height, background: master.background || '#ffffff', blocks: master.blocks };
    const source = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}*{box-sizing:border-box}</style></head><body>' + renderPresentCanvasHtml(page) + '</body></html>';
    return '<div class="master-thumb"><iframe sandbox srcdoc="' + esc(source) + '" style="width:' + master.width + 'px;height:' + master.height + 'px;transform:scale(' + ratio + ');transform-origin:top left;border:0;pointer-events:none" tabindex="-1"></iframe><span class="master-thumb-label">' + esc(master.mode) + '</span></div>';
  }
  return '<div class="master-thumb placeholder" style="width:' + width + 'px;height:' + height + 'px"><span>' + esc(master.mode === 'whiteboard' ? 'Whiteboard scene' : 'Page master') + '</span></div>';
}

async function openAddPageModal(): Promise<void> {
  if (!state.doc) return;
  await loadMasters();
  let html = '<div class="modal"><div class="modal-head"><div><strong>Add a page</strong><small>HTML pages are directly editable; canvas pages accept blocks.</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="preset-grid">';
  for (const preset of CANVAS_PAGE_PRESETS) html += '<button type="button" class="preset-btn" data-preset="' + esc(preset.id) + '"><strong>' + esc(preset.title) + '</strong><small>' + esc(preset.hint) + '</small></button>';
  html += '</div>';
  html += pluginPagePickerMarkup(pageThumbHtml);
  if (state.masters.length) {
    html += '<div class="masters-head"><strong>My page masters</strong><small>Reusable layouts saved from this workspace</small></div><div class="masters-grid">';
    for (const master of state.masters) html += '<div class="master-card">' + masterPreviewHtml(master) + '<div class="master-info"><strong>' + esc(master.name) + '</strong><small>' + esc(master.mode) + ' · ' + master.width + '×' + master.height + '</small></div><div class="master-actions"><button type="button" class="btn tiny primary" data-master="' + esc(master.id) + '">Use</button><button type="button" class="btn tiny danger" data-delete-master="' + esc(master.id) + '">Delete</button></div></div>';
    html += '</div>';
  } else {
    html += '<div class="hint-card" style="margin-top:14px">Save any page as a reusable master from the Page inspector, then it appears here.</div>';
  }
  html += '</div><div class="modal-foot"><button class="btn" data-close>Cancel</button></div></div>';
  openModal(html);
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => {
    button.addEventListener('click', () => {
      const preset = CANVAS_PAGE_PRESETS.find(item => item.id === button.dataset.preset);
      if (!preset) return;
      closeModal();
      void createPage(preset);
    });
  });
  bindPluginPagePicker(document, page => { closeModal(); void addPluginPage(page); });
  document.querySelectorAll<HTMLButtonElement>('[data-master]').forEach(button => {
    button.addEventListener('click', async () => {
      const masterId = button.dataset.master;
      if (!masterId || !state.doc) return;
      try {
        closeModal();
        const result = await api<{ doc: HcDocument; page: HcPage }>('/api/masters/' + masterId + '/pages', {
          method: 'POST',
          body: JSON.stringify({ docId: state.doc.id, baseRevision: state.doc.revision, actor: 'human' }),
        });
        await openDoc(result.doc.id, result.page.id);
        toast('Page created from master', 'success');
      } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-delete-master]').forEach(button => {
    button.addEventListener('click', async event => {
      event.stopPropagation();
      const masterId = button.dataset.deleteMaster;
      if (!masterId) return;
      const master = state.masters.find(item => item.id === masterId);
      const ok = await confirmDialog('Delete master "' + (master?.name || 'this master') + '"?');
      if (!ok) return;
      try {
        await api('/api/masters/' + masterId, { method: 'DELETE' });
        await loadMasters();
        await openAddPageModal();
        toast('Master deleted', 'success');
      } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
    });
  });
}

async function addPluginPage(page: HcPage): Promise<void> {
  const result = await applyOps([{ op: 'add_page', page }], { refreshArtboard: false });
  if (result) { state.activePageId = page.id; state.activeBlockId = null; state.fittedPageId = null; renderAll(); void syncActive(); }
}

async function createPage(preset: typeof CANVAS_PAGE_PRESETS[number]): Promise<void> {
  if (!state.doc) return;
  const page: HcPage = {
    id: genId('page'), name: preset.title, mode: preset.mode,
    width: preset.width, height: preset.height, background: preset.background,
    ...(preset.mode === 'html' ? { html: preset.template ? pageTemplateHtml(preset.template, '') : starterHtml(preset.title) } : { blocks: preset.template?.startsWith('canvas-') ? canvasTemplateBlocks(preset.template, preset.width, preset.height) : [] }),
  };
  const result = await applyOps([{ op: 'add_page', page }], { refreshArtboard: false });
  if (result) { state.activePageId = page.id; state.activeBlockId = null; state.fittedPageId = null; renderAll(); void syncActive(); }
}

function openNewDocModal(): void {
  let html = '<div class="modal small"><div class="modal-head"><div><strong>New canvas</strong><small>Start with a canvas size.</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="field"><span>Title</span><input id="newDocTitle" value="Untitled canvas"></div><div class="field"><span>First page</span><select id="newDocPreset">';
  for (const preset of CANVAS_PAGE_PRESETS) html += '<option value="' + esc(preset.id) + '">' + esc(preset.title) + ' · ' + esc(preset.hint) + '</option>';
  html += '</select></div></div><div class="modal-foot"><button class="btn" data-close>Cancel</button><button id="createDocBtn" class="btn primary">Create</button></div></div>';
  openModal(html);
  qs<HTMLButtonElement>('#createDocBtn')?.addEventListener('click', async () => {
    const title = qs<HTMLInputElement>('#newDocTitle')?.value || 'Untitled canvas';
    const presetId = qs<HTMLSelectElement>('#newDocPreset')?.value || 'canvas-16-9';
    const preset = CANVAS_PAGE_PRESETS.find(item => item.id === presetId);
    closeModal();
    try {
      const result = await api<{ doc: HcDocument }>('/api/docs', {
        method: 'POST',
        body: JSON.stringify({
          title,
          preset: preset ? {
            id: preset.id,
            title: preset.title,
            width: preset.width,
            height: preset.height,
            background: preset.background,
            mode: preset.mode,
            html: preset.mode === 'html' ? preset.template ? pageTemplateHtml(preset.template, '') : starterHtml(preset.title) : undefined,
            blocks: preset.mode === 'canvas' || preset.mode === 'infinite'
              ? preset.template?.startsWith('canvas-') ? canvasTemplateBlocks(preset.template, preset.width, preset.height) : []
              : undefined,
          } : undefined,
        }),
      });
      await openDoc(result.doc.id);
    } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
  });
}

function openSourceEditor(target: { pageId: string; blockId?: string }): void {
  const page = state.doc?.pages.find(item => item.id === target.pageId);
  if (!page) return;
  if (target.blockId) {
    const block = page.blocks?.find(item => item.id === target.blockId);
    if (!block) return;
    const kind = block.type;
    const value = kind === 'markdown' ? (block.markdown || '') : kind === 'code' ? (block.code || '') : kind === 'text' ? (block.text || '') : (block.html || '');
    openCodeModal({
      title: block.name || kind + ' block', kind, value,
      language: kind === 'markdown' ? 'markdown' : kind === 'code' ? 'code' : kind === 'text' ? 'text' : 'html',
      save: async next => {
        const op: HcOp = kind === 'markdown' ? { op: 'set_block_markdown', pageId: page.id, blockId: block.id, markdown: next }
          : kind === 'code' ? { op: 'set_block_code', pageId: page.id, blockId: block.id, code: next }
          : kind === 'text' ? { op: 'set_block_text', pageId: page.id, blockId: block.id, text: next }
          : { op: 'set_block_html', pageId: page.id, blockId: block.id, html: next };
        await applyOps([op], { refreshArtboard: true });
      },
    });
    return;
  }
  openCodeModal({ title: page.name + ' · HTML source', kind: 'html', value: page.html || '', language: 'html', save: async next => { await applyOps([{ op: 'set_page_html', pageId: page.id, html: next }], { refreshArtboard: true }); } });
}

function openFormulaModal(block: HcBlock): void {
  openCodeModal({
    title: block.name || 'LaTeX formula',
    kind: 'math',
    value: String(block.data?.tex || ''),
    language: 'tex',
    save: async next => {
      await applyOps([{ op: 'update_block', pageId: activePage()!.id, blockId: block.id, patch: { data: { ...(block.data || {}), tex: next } } } as HcOp], { refreshArtboard: true });
    },
  });
}

function openCodeModal(options: { title: string; kind: string; value: string; language: string; save: (next: string) => Promise<void> }): void {
  const modalClass = 'modal split' + (options.kind === 'markdown' ? ' markdown-workspace' : '');
  const modalHtml = '<div class="' + modalClass + '"><div class="modal-head"><div><strong>' + esc(options.title) + '</strong><small>' + esc(options.kind.toUpperCase()) + ' · source and live preview</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="editor-pane"><span>Source</span><div id="codeEditorHost" class="editor-host"></div></div><div class="editor-pane"><span>Preview</span><div class="preview-host"><iframe id="codePreview" sandbox="allow-scripts"></iframe></div></div></div><div class="modal-foot"><button class="btn" data-close>Cancel</button><button id="saveCodeBtn" class="btn primary">Save changes</button></div></div>';
  openModal(modalHtml);
  state.sourceModalOpen = true;
  const host = el('codeEditorHost');
  const extensions = [basicSetup, EditorView.lineWrapping, oneDark];
  if (options.language === 'html') extensions.push(htmlLang());
  const view = new EditorView({ doc: options.value, extensions, parent: host });
  const preview = el<HTMLIFrameElement>('codePreview');
  const setPreview = (kind: string, value: string): void => {
    try { preview.srcdoc = previewHtmlFor(kind, value); }
    catch (error) { preview.srcdoc = '<!doctype html><html><body style="margin:0;padding:16px;color:#b42318;font:12px Inter,sans-serif">Preview unavailable: ' + esc(error instanceof Error ? error.message : String(error)) + '</body></html>'; }
  };
  const updatePreview = debounce(() => { setPreview(options.kind, view.state.doc.toString()); }, 280);
  setPreview(options.kind, options.value);
  view.dom.addEventListener('keyup', updatePreview);
  const originalClose = closeModal;
  const realClose = (): void => { view.destroy(); state.sourceModalOpen = false; originalClose(); };
  (window as unknown as { __hcCloseModal?: () => void }).__hcCloseModal = realClose;
  qs<HTMLButtonElement>('#saveCodeBtn')?.addEventListener('click', async () => {
    const next = view.state.doc.toString();
    realClose();
    try { await options.save(next); toast('Saved', 'success'); } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
  });
  document.querySelectorAll<HTMLElement>('[data-close]').forEach(button => button.addEventListener('click', () => realClose()));
}

function previewHtmlFor(kind: string, value: string): string {
  if (kind === 'html') return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head><body>' + value + '</body></html>';
  if (kind === 'markdown') return '<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px/1.6 Inter,sans-serif;padding:24px;color:#334155}h1,h2,h3{font-family:Georgia,serif}code{background:#f1f5f9;padding:1px 4px;border-radius:4px}blockquote{margin:12px 0;padding:10px 14px;border-left:3px solid #a855f7;background:#faf7ff;color:#4b4058}blockquote p{margin:0}.hc-math-block{margin:14px 0;overflow-x:auto}.hc-math-inline{display:inline-block;vertical-align:middle}</style></head><body>' + renderMarkdownHtml(value) + '</body></html>';
  if (kind === 'math') return '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:24px;color:#1f2430;font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;box-sizing:border-box}.katex-display{margin:0;font-size:1.35em}</style></head><body>' + renderMathHtml(value, true) + '</body></html>';
  return '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#171923;color:#e2e8f0;font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap}</style></head><body>' + esc(value) + '</body></html>';
}

function openModal(html: string): void {
  closeModal();
  const root = el('modalRoot');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = html;
  backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(); });
  root.appendChild(backdrop);
  document.body.classList.add('modal-open');
  backdrop.querySelectorAll<HTMLElement>('[data-close]').forEach(button => button.addEventListener('click', () => closeModal()));
}

function closeModal(): void {
  if (state.sourceModalOpen) {
    const custom = (window as unknown as { __hcCloseModal?: () => void }).__hcCloseModal;
    if (custom) { custom(); return; }
  }
  el('modalRoot').textContent = '';
  document.body.classList.remove('modal-open');
}

function confirmDialog(message: string): Promise<boolean> {
  return new Promise(resolve => {
    const html = '<div class="modal small"><div class="modal-head"><div><strong>Confirm</strong><small>' + esc(message) + '</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-foot"><button class="btn" id="confirmCancel">Cancel</button><button class="btn primary" id="confirmOk">Confirm</button></div></div>';
    openModal(html);
    let settled = false;
    const finish = (value: boolean): void => { if (settled) return; settled = true; closeModal(); resolve(value); };
    qs<HTMLButtonElement>('#confirmCancel')?.addEventListener('click', () => finish(false));
    qs<HTMLButtonElement>('#confirmOk')?.addEventListener('click', () => finish(true));
    document.querySelectorAll<HTMLElement>('[data-close]').forEach(button => button.addEventListener('click', () => finish(false)));
  });
}

function toggleExportMenu(force?: boolean): void {
  const menu = el('exportMenu');
  const show = force === undefined ? menu.classList.contains('hidden') : force;
  menu.classList.toggle('hidden', !show);
  el('exportBtn').setAttribute('aria-expanded', String(show));
}

async function exportCurrent(format: string, options: { bleedMm?: number; cropMarks?: boolean } = {}): Promise<void> {
  if (!state.doc) return;
  const page = activePage();
  if (format === 'scene') {
    if (!page) { toast('Open a page first.', 'error'); return; }
    if (page.mode === 'whiteboard') { downloadWhiteboardScene(); return; }
    if (page.mode === 'infinite') {
      const scene = nativeBlocksToExcalidrawScene(page);
      const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/vnd.excalidraw+json' });
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      anchor.download = (page.name || 'infinite').replace(/[^a-z0-9_-]+/gi, '-') + '.excalidraw';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(anchor.href), 2000);
      return;
    }
    toast('Scene export is available for Infinite and Whiteboard pages.', 'error');
    return;
  }
  try {
    toast('Rendering ' + format.toUpperCase() + '…', 'info');
    const result = await api<{ downloadUrl?: string; path?: string; format: string }>('/api/export', { method: 'POST', body: JSON.stringify({ docId: state.doc.id, format, pageId: format === 'pptx' || format === 'pptx-editable' ? undefined : page?.id, bleedMm: options.bleedMm || undefined, cropMarks: options.cropMarks || undefined }) });
    if (result.downloadUrl) {
      const anchor = document.createElement('a');
      anchor.href = result.downloadUrl + (result.downloadUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(boot.token);
      anchor.download = '';
      anchor.style.display = 'none';
      document.body.appendChild(anchor); anchor.click();
      setTimeout(() => anchor.remove(), 5000);
      toast('Export ready: ' + (result.path || format), 'success');
    } else toast('Export failed', 'error');
  } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
}

function openPresent(): void {
  if (!state.doc) return;
  state.presenting = true;
  state.presentIndex = Math.max(0, state.doc.pages.findIndex(page => page.id === state.activePageId));
  presentInteractions?.reset();
  renderPresent();
}
function closePresent(): void {
  state.presenting = false;
  presentInteractions?.reset();
  const root = el('presentRoot');
  root.classList.add('hidden');
  root.textContent = '';
  renderToolbarState();
}
function togglePresentNotes(): void {
  const notes = el('presentNotes');
  const page = state.doc?.pages[state.presentIndex];
  notes.classList.toggle('hidden');
  notes.textContent = page?.notes || 'No speaker notes for this page.';
  fitPresentPage();
}
function nextPresent(delta: number): void {
  if (!state.doc) return;
  state.presentIndex = Math.max(0, Math.min(state.doc.pages.length - 1, state.presentIndex + delta));
  renderPresent();
}
function renderPresent(): void {
  const doc = state.doc;
  if (!doc) return;
  let page = doc.pages[state.presentIndex];
  if (!page) return;
  if (page.mode === 'whiteboard') page = legacyWhiteboardNativePage(page);
  const root = el('presentRoot');
  root.classList.remove('hidden');
  root.innerHTML = '<div class="present-stage"><div id="presentFit" class="present-fit"><div id="presentPage" class="present-page"></div></div></div><div id="presentNotes" class="present-notes hidden"></div><div class="present-bar"><span>' + esc(doc.title) + ' · ' + esc(page.name) + ' · ' + (state.presentIndex + 1) + ' / ' + doc.pages.length + '</span><span><button id="presentNotesBtn" class="btn">Notes</button> <button id="presentPrev" class="btn">← Previous</button> <button id="presentNext" class="btn">Next →</button> <button id="presentClose" class="btn">Exit</button></span></div>';
  qs<HTMLButtonElement>('#presentPrev')?.addEventListener('click', () => nextPresent(-1));
  qs<HTMLButtonElement>('#presentNext')?.addEventListener('click', () => nextPresent(1));
  qs<HTMLButtonElement>('#presentClose')?.addEventListener('click', () => closePresent());
  qs<HTMLButtonElement>('#presentNotesBtn')?.addEventListener('click', () => togglePresentNotes());
  el('presentNotes').textContent = page.notes || '';
  const presentPage = page.mode === 'infinite' ? (() => {
    const metrics = pageMetrics(page);
    const content = metrics.content;
    if (!content) return { ...page, width: 1280, height: 720 };
    const padding = 80;
    return {
      ...page,
      width: Math.max(640, Math.ceil(content.maxX - content.minX) + padding * 2),
      height: Math.max(480, Math.ceil(content.maxY - content.minY) + padding * 2),
      blocks: (page.blocks || []).map(block => ({ ...block, x: block.x - content.minX + padding, y: block.y - content.minY + padding })),
    };
  })() : page;
  const host = el('presentPage');
  host.style.width = presentPage.width + 'px';
  host.style.height = presentPage.height + 'px';
  host.style.transformOrigin = 'top left';
  if (page.mode === 'html') {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.srcdoc = page.html || '';
    host.appendChild(iframe);
  } else host.innerHTML = renderPresentCanvasHtml(presentPage);
  fitPresentPage();
}

function fitPresentPage(): void {
  const stage = qs<HTMLElement>('.present-stage');
  const fit = qs<HTMLElement>('#presentFit');
  const host = qs<HTMLElement>('#presentPage');
  if (!stage || !fit || !host) return;
  const pageWidth = host.offsetWidth;
  const pageHeight = host.offsetHeight;
  if (!pageWidth || !pageHeight) return;
  const rect = stage.getBoundingClientRect();
  const scale = Math.min((rect.width - 56) / pageWidth, (rect.height - 56) / pageHeight);
  fit.style.width = Math.max(1, pageWidth * scale) + 'px';
  fit.style.height = Math.max(1, pageHeight * scale) + 'px';
  host.style.transform = 'scale(' + scale + ')';
}
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'success'); }
  catch { toast('Clipboard unavailable', 'error'); }
}

void initialize();
