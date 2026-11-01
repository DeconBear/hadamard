import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createAiModelTemplate } from '../canvas/packs/aiModel.js';
import { sceneFromDoc } from '../canvas/excalidrawScene.js';
import { applyHtmlPatches, normalizeHtml } from './html.js';
import {
  DEMO_SLIDE_HTML,
  HCANVAS_SCHEMA,
  hcId,
  nowIso,
  type HcBlock,
  type HcDocument,
  type HcHistoryEntry,
  type HcMaster,
  type HcOp,
  type HcPage,
  type HcProposal,
  type HcPagePreset,
  type HcWhiteboardScene,
} from './types.js';

export class HcNotFoundError extends Error {}
export class HcRevisionConflictError extends Error {
  constructor(public readonly latest: HcDocument) {
    super('Revision conflict: latest revision is ' + latest.revision);
    this.name = 'HcRevisionConflictError';
  }
}
export class HcValidationError extends Error {}

export interface HcActiveState {
  docId: string | null;
  pageId: string | null;
  blockId: string | null;
  actor: string;
  updatedAt: string;
}

export interface HcSession {
  id: string;
  docId: string;
  pageId?: string;
  selection?: string[];
  actor: string;
  createdAt: string;
  updatedAt: string;
}

interface HcStateFile {
  active: HcActiveState;
  sessions: Record<string, HcSession>;
}

export interface HcApplyResult {
  doc: HcDocument;
  dryRun: boolean;
  changed: boolean;
}

export interface HcDocSummary {
  id: string;
  title: string;
  revision: number;
  pages: number;
  updatedAt: string;
  pendingProposals: number;
}

export interface HcResolveCandidate {
  docId: string;
  title: string;
  revision: number;
  confidence: number;
  reason: string;
}

function cleanTitle(title: string | undefined, fallback: string): string {
  return (title || '').trim() || fallback;
}

function normalizeWhiteboardScene(scene: HcWhiteboardScene | undefined): HcWhiteboardScene {
  return {
    elements: Array.isArray(scene?.elements) ? (scene!.elements as unknown[]).slice(0, 10000) : [],
    appState: scene?.appState && typeof scene.appState === 'object' ? { ...scene.appState } : { viewBackgroundColor: '#ffffff' },
    files: scene?.files && typeof scene.files === 'object' ? { ...scene.files } : {},
  };
}

function ensurePage(page: HcPage): HcPage {
  if (!page.id) page.id = hcId('page');
  if (!page.name) page.name = 'Page';
  if (page.mode !== 'canvas' && page.mode !== 'html' && page.mode !== 'infinite' && page.mode !== 'whiteboard') page.mode = 'canvas';
  if (!Number.isFinite(page.width) || page.width <= 0) page.width = 1280;
  if (!Number.isFinite(page.height) || page.height <= 0) page.height = 720;
  if (!page.background) page.background = '#ffffff';
  if (page.mode === 'whiteboard') {
    delete page.blocks;
    delete page.html;
    page.scene = normalizeWhiteboardScene(page.scene);
  } else if (page.mode === 'html') {
    delete page.blocks;
    delete page.scene;
    page.html = normalizeHtml(page.html || '<div style="padding:48px;font-family:Inter,sans-serif"><h1>Untitled page</h1><p>Double-click to edit.</p></div>');
  } else {
    delete page.html;
    delete page.scene;
    page.blocks = (page.blocks || []).map(block => ensureBlock(block));
    if (page.mode === 'infinite') {
      if (!Number.isFinite(page.width) || page.width < 1280) page.width = 4800;
      if (!Number.isFinite(page.height) || page.height < 720) page.height = 3200;
    }
  }
  return page;
}

function ensureBlock(block: HcBlock): HcBlock {
  if (!block.id) block.id = hcId('block');
  if (!block.type) block.type = 'html';
  block.x = Number.isFinite(block.x) ? block.x : 80;
  block.y = Number.isFinite(block.y) ? block.y : 80;
  block.w = Number.isFinite(block.w) && block.w > 0 ? block.w : 320;
  block.h = Number.isFinite(block.h) && block.h > 0 ? block.h : 200;
  block.z = Number.isFinite(block.z) ? block.z : 0;
  if (block.type === 'html') block.html = normalizeHtml(block.html || '<div style="padding:16px;font-family:Inter,sans-serif;color:#1f2937">Edit me</div>');
  if (block.type === 'text' && typeof block.text !== 'string') block.text = 'Double-click to edit';
  if (block.type === 'markdown' && typeof block.markdown !== 'string') block.markdown = '## Markdown block\n\nWrite **markdown** here.';
  if (block.type === 'code' && typeof block.code !== 'string') block.code = 'const answer = 42;';
  if (block.type === 'image' && !block.src) block.src = '';
  if (block.type === 'shape' && !block.shape) block.shape = 'rect';
  return block;
}

const STARTER_HTML = [
  '<style>',
  '  .hc-starter { box-sizing: border-box; width: 100%; height: 100%; padding: 72px 80px; background: #f7f5f0; color: #1f2430; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }',
  '  .hc-starter h1 { margin: 0 0 14px; font-family: Georgia, serif; font-size: 58px; letter-spacing: -.04em; line-height: 1.05; }',
  '  .hc-starter p { margin: 0; max-width: 560px; font-size: 18px; line-height: 1.6; color: #5d584e; }',
  '  .hc-starter .tag { display: inline-block; margin-bottom: 28px; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #7c3aed; }',
  '</style>',
  '<div class="hc-starter">',
  '  <div class="tag">HTML page · editable</div>',
  '  <h1>Start with a beautiful page.</h1>',
  '  <p>Double-click text to edit in place. Toggle source mode to change HTML/CSS. Agent tools patch the same document with stable data-hc-id selectors.</p>',
  '</div>',
].join('\n');

export function createDocument(title = 'Untitled canvas', preset: HcPagePreset | undefined = undefined): HcDocument {
  const now = nowIso();
  const width = preset?.width ?? 1280;
  const height = preset?.height ?? 720;
  return {
    schema: HCANVAS_SCHEMA,
    id: hcId('doc'),
    title: cleanTitle(title, 'Untitled canvas'),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    pages: [ensurePage({
      id: hcId('page'),
      name: 'Page 1',
      mode: 'html',
      width,
      height,
      background: preset?.background ?? '#ffffff',
      html: STARTER_HTML,
    })],
    proposals: [],
    history: [],
  };
}

export function createDemoDocument(): HcDocument {
  const now = nowIso();
  const slidePage = ensurePage({
    id: hcId('page'),
    name: 'Welcome',
    mode: 'html',
    width: 1280,
    height: 720,
    background: '#f6f4ef',
    html: DEMO_SLIDE_HTML,
  });
  const playground = ensurePage({
    id: hcId('page'),
    name: 'Canvas playground',
    mode: 'canvas',
    width: 1280,
    height: 720,
    background: '#fbfaf7',
    blocks: [
      ensureBlock({
        id: hcId('block'), type: 'text', x: 72, y: 64, w: 520, h: 120,
        text: 'A page is a canvas.\nDouble-click this text.', z: 0,
        style: { fontSize: 34, fontWeight: 600, color: '#1f2430', fontFamily: 'Georgia, serif' },
      }),
      ensureBlock({
        id: hcId('block'), type: 'markdown', x: 72, y: 216, w: 470, h: 250, z: 1,
        markdown: '## Markdown block\n\nRender **markdown** directly on the canvas.\n\n- headings, lists, links\n- inline code\n- agent-readable source',
        style: { fill: '#ffffff', radius: 18, fontSize: 16, color: '#334155' },
      }),
      ensureBlock({
        id: hcId('block'), type: 'html', x: 590, y: 216, w: 590, h: 250, z: 2,
        html: '<div style="box-sizing:border-box;height:100%;padding:28px 30px;border:1px solid #e7e0d2;border-radius:18px;background:#fffdf8;font-family:Inter,sans-serif;color:#2e2a24"><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#a16207;margin-bottom:14px">HTML block</div><h2 style="margin:0 0 10px;font-family:Georgia,serif;font-weight:500;font-size:30px;letter-spacing:-.03em">Editable HTML, in place.</h2><p style="margin:0;font-size:15px;line-height:1.65;color:#655e52">Click text to edit. Use the source tab for HTML/CSS. AI patches target data-hc-id.</p></div>',
        style: { fill: 'transparent' },
      }),
      ensureBlock({
        id: hcId('block'), type: 'code', x: 72, y: 500, w: 470, h: 160, z: 3,
        code: "const canvas = await hcanvas.open('demo');\nawait canvas.apply({ baseRevision, ops });",
        language: 'ts', style: { fill: '#171923', radius: 16, color: '#e2e8f0', fontSize: 13 },
      }),
      ensureBlock({
        id: hcId('block'), type: 'shape', x: 590, y: 500, w: 590, h: 160, z: 4,
        shape: 'rect', style: { fill: '#f3e8ff', stroke: '#a855f7', strokeWidth: 1, radius: 18 },
      }),
    ],
  });
  const infinitePage = ensurePage({
    id: hcId('page'),
    name: 'Infinite canvas',
    mode: 'infinite',
    width: 4800,
    height: 3200,
    background: '#f8f6f1',
    blocks: [
      ensureBlock({
        id: hcId('block'), type: 'text', x: 160, y: 140, w: 620, h: 120, z: 0,
        text: 'An infinite canvas.\nPan, zoom, think.',
        style: { fontSize: 46, fontWeight: 600, color: '#1f2430', fontFamily: 'Georgia, serif' },
      }),
      ensureBlock({
        id: hcId('block'), type: 'html', x: 900, y: 180, w: 560, h: 230, z: 1,
        html: '<div style="box-sizing:border-box;height:100%;padding:28px 30px;border:1px solid #e7e0d2;border-radius:18px;background:#fffdf8;font-family:Inter,sans-serif;color:#2e2a24"><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7c3aed;margin-bottom:12px">Infinite · HTML</div><h2 style="margin:0 0 8px;font-family:Georgia,serif;font-weight:500;font-size:28px;letter-spacing:-.03em">Everything is a block.</h2><p style="margin:0;font-size:15px;line-height:1.6;color:#655e52">Drop HTML, markdown, code or shapes anywhere on the infinite canvas.</p></div>',
        style: { fill: 'transparent' },
      }),
      ensureBlock({
        id: hcId('block'), type: 'markdown', x: 200, y: 420, w: 520, h: 230, z: 2,
        markdown: '## Why infinite?\n\nBecause thinking is not a 16:9 slide.\n\n- sketch ideas anywhere\n- zoom in for detail\n- present pages when ready',
        style: { fill: '#ffffff', radius: 18 },
      }),
      ensureBlock({
        id: hcId('block'), type: 'shape', x: 1000, y: 500, w: 360, h: 220, z: 3,
        shape: 'ellipse', style: { fill: '#efe9ff', stroke: '#8b5cf6', strokeWidth: 1, radius: 18 },
      }),
    ],
  });
  const template = createAiModelTemplate('hcanvas-demo', 'Transformer whiteboard');
  const templateScene = sceneFromDoc(template);
  const whiteboardPage = ensurePage({
    id: hcId('page'),
    name: 'Whiteboard',
    mode: 'whiteboard',
    width: 1280,
    height: 720,
    background: '#ffffff',
    scene: { elements: templateScene.elements as unknown[], appState: templateScene.appState || { viewBackgroundColor: '#ffffff' }, files: templateScene.files || {} },
  });
  const doc: HcDocument = {
    schema: HCANVAS_SCHEMA,
    id: hcId('doc'),
    title: 'Hadamard Canvas — Welcome',
    revision: 0,
    createdAt: now,
    updatedAt: now,
    pages: [slidePage, playground, infinitePage, whiteboardPage],
    proposals: [],
    history: [],
  };
  return doc;
}

function clone<T>(value: T): T { return structuredClone(value); }

function pageOrThrow(doc: HcDocument, pageId: string): HcPage {
  const page = doc.pages.find(item => item.id === pageId);
  if (!page) throw new HcValidationError('Page not found: ' + pageId);
  return page;
}

function blockOrThrow(page: HcPage, blockId: string): HcBlock {
  const block = (page.blocks || []).find(item => item.id === blockId);
  if (!block) throw new HcValidationError('Block not found: ' + blockId + ' in page ' + page.id);
  return block;
}

export function applyOpsToDocument(doc: HcDocument, ops: HcOp[]): HcDocument {
  const next = clone(doc);
  for (const op of ops) {
    switch (op.op) {
      case 'add_page': {
        const page = ensurePage(clone(op.page));
        if (next.pages.some(item => item.id === page.id)) throw new HcValidationError('Duplicate page id: ' + page.id);
        const index = op.index === undefined ? next.pages.length : Math.max(0, Math.min(next.pages.length, op.index));
        next.pages.splice(index, 0, page);
        break;
      }
      case 'update_page': {
        const page = pageOrThrow(next, op.pageId);
        Object.assign(page, op.patch);
        ensurePage(page);
        break;
      }
      case 'delete_page': {
        if (next.pages.length <= 1) throw new HcValidationError('Cannot delete the last page');
        const index = next.pages.findIndex(item => item.id === op.pageId);
        if (index < 0) throw new HcValidationError('Page not found: ' + op.pageId);
        next.pages.splice(index, 1);
        break;
      }
      case 'add_block': {
        const page = pageOrThrow(next, op.pageId);
        if (page.mode === 'html' || page.mode === 'whiteboard') throw new HcValidationError('Blocks require a canvas or infinite page');
        const block = ensureBlock(clone(op.block));
        if (block.id && (page.blocks || []).some(item => item.id === block.id)) throw new HcValidationError('Duplicate block id: ' + block.id);
        page.blocks = page.blocks || [];
        const index = op.index === undefined ? page.blocks.length : Math.max(0, Math.min(page.blocks.length, op.index));
        page.blocks.splice(index, 0, block);
        break;
      }
      case 'update_block': {
        const page = pageOrThrow(next, op.pageId);
        const block = blockOrThrow(page, op.blockId);
        Object.assign(block, op.patch);
        ensureBlock(block);
        break;
      }
      case 'delete_block': {
        const page = pageOrThrow(next, op.pageId);
        page.blocks = (page.blocks || []).filter(item => item.id !== op.blockId);
        break;
      }
      case 'set_page_html': {
        const page = pageOrThrow(next, op.pageId);
        page.mode = 'html';
        page.html = normalizeHtml(op.html);
        delete page.blocks;
        delete page.scene;
        break;
      }
      case 'set_whiteboard_scene': {
        const page = pageOrThrow(next, op.pageId);
        page.mode = 'whiteboard';
        page.scene = normalizeWhiteboardScene(op.scene);
        delete page.blocks;
        delete page.html;
        break;
      }
      case 'set_block_html': {
        const page = pageOrThrow(next, op.pageId);
        const block = blockOrThrow(page, op.blockId);
        block.html = normalizeHtml(op.html);
        break;
      }
      case 'set_block_text': {
        const page = pageOrThrow(next, op.pageId);
        const block = blockOrThrow(page, op.blockId);
        block.text = op.text;
        break;
      }
      case 'set_block_markdown': {
        const page = pageOrThrow(next, op.pageId);
        blockOrThrow(page, op.blockId).markdown = op.markdown;
        break;
      }
      case 'set_block_code': {
        const page = pageOrThrow(next, op.pageId);
        const block = blockOrThrow(page, op.blockId);
        block.code = op.code;
        if (op.language !== undefined) block.language = op.language;
        break;
      }
      case 'html_patch': {
        const page = pageOrThrow(next, op.pageId);
        if (op.blockId) {
          const block = blockOrThrow(page, op.blockId);
          block.html = applyHtmlPatches(block.html || '', op.patches);
        } else if (page.mode === 'html') {
          page.html = applyHtmlPatches(page.html || '', op.patches);
        } else {
          throw new HcValidationError('html_patch requires blockId on a canvas page');
        }
        break;
      }
      case 'reorder_block': {
        const page = pageOrThrow(next, op.pageId);
        const blocks = page.blocks || [];
        const index = blocks.findIndex(item => item.id === op.blockId);
        if (index < 0) throw new HcValidationError('Block not found: ' + op.blockId);
        const target = op.direction === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= blocks.length) break;
        const currentBlock = blocks[index]!;
        blocks[index] = blocks[target]!;
        blocks[target] = currentBlock;
        blocks.forEach((block, order) => { block.z = order; });
        break;
      }
      case 'reorder_page': {
        const index = next.pages.findIndex(item => item.id === op.pageId);
        if (index < 0) throw new HcValidationError('Page not found: ' + op.pageId);
        const target = op.direction === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= next.pages.length) break;
        const currentPage = next.pages[index]!;
        next.pages[index] = next.pages[target]!;
        next.pages[target] = currentPage;
        break;
      }
      default:
        throw new HcValidationError('Unknown op: ' + String((op as { op?: string }).op));
    }
  }
  return next;
}

export class HcStore {
  readonly docsDir: string;
  readonly exportsDir: string;
  readonly statePath: string;
  readonly mastersPath: string;
  readonly events = new EventEmitter();
  private masters: HcMaster[] = [];
  private state: HcStateFile = {
    active: { docId: null, pageId: null, blockId: null, actor: 'human', updatedAt: nowIso() },
    sessions: {},
  };
  private locks = new Map<string, Promise<unknown>>();

  constructor(public readonly root: string) {
    this.docsDir = path.join(root, 'docs');
    this.exportsDir = path.join(root, 'exports');
    this.statePath = path.join(root, 'state.json');
    this.mastersPath = path.join(root, 'masters.json');
  }

  async init(): Promise<void> {
    await mkdir(this.docsDir, { recursive: true });
    await mkdir(this.exportsDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<HcStateFile>;
      if (parsed.active) this.state.active = { ...this.state.active, ...parsed.active };
      if (parsed.sessions) this.state.sessions = parsed.sessions;
    } catch { /* first run */ }
    try {
      const parsedMasters = JSON.parse(await readFile(this.mastersPath, 'utf8')) as { masters?: HcMaster[] };
      this.masters = Array.isArray(parsedMasters.masters) ? parsedMasters.masters : [];
    } catch { /* first run */ }
    const docs = await this.listDocs();
    if (docs.length === 0) {
      const demo = createDemoDocument();
      await this.saveDocument(demo);
      this.state.active = { docId: demo.id, pageId: demo.pages[0]!.id, blockId: null, actor: 'human', updatedAt: nowIso() };
      await this.saveState();
    } else {
      const activeExists = this.state.active.docId && docs.some(doc => doc.id === this.state.active.docId);
      if (!activeExists) {
        const latest = docs[0]!;
        const full = await this.readDoc(latest.id);
        this.state.active = { docId: full.id, pageId: full.pages[0]?.id ?? null, blockId: null, actor: 'human', updatedAt: nowIso() };
        await this.saveState();
      }
    }
  }

  private docPath(docId: string): string {
    if (!/^doc_[A-Za-z0-9]+$/.test(docId)) throw new HcNotFoundError('Invalid document id: ' + docId);
    return path.join(this.docsDir, docId + '.json');
  }

  private async saveState(): Promise<void> {
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  private async saveMasters(): Promise<void> {
    await writeFile(this.mastersPath, JSON.stringify({ schema: 'hadamard-canvas-masters/1', masters: this.masters }, null, 2), 'utf8');
  }

  async listMasters(): Promise<HcMaster[]> {
    return JSON.parse(JSON.stringify(this.masters)) as HcMaster[];
  }

  async saveMaster(input: { docId: string; pageId: string; name?: string }): Promise<HcMaster> {
    const doc = await this.readDoc(input.docId);
    const page = doc.pages.find(item => item.id === input.pageId);
    if (!page) throw new HcNotFoundError('Page not found: ' + input.pageId);
    const name = cleanTitle(input.name, page.name || 'Master');
    const master: HcMaster = {
      id: hcId('master'),
      name,
      mode: page.mode,
      width: page.width,
      height: page.height,
      background: page.background,
      html: page.html,
      blocks: page.blocks ? JSON.parse(JSON.stringify(page.blocks)) as HcBlock[] : undefined,
      scene: page.scene ? JSON.parse(JSON.stringify(page.scene)) as HcWhiteboardScene : undefined,
      notes: page.notes,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.masters = [master, ...this.masters].slice(0, 100);
    await this.saveMasters();
    this.emit({ type: 'master.changed', masterId: master.id, action: 'created' });
    return master;
  }

  async deleteMaster(masterId: string): Promise<void> {
    if (!this.masters.some(master => master.id === masterId)) throw new HcNotFoundError('Master not found: ' + masterId);
    this.masters = this.masters.filter(master => master.id !== masterId);
    await this.saveMasters();
    this.emit({ type: 'master.changed', masterId, action: 'deleted' });
  }

  async addPageFromMaster(docId: string, masterId: string, options: { baseRevision?: number; actor?: string; name?: string } = {}): Promise<{ doc: HcDocument; page: HcPage }> {
    const master = this.masters.find(item => item.id === masterId);
    if (!master) throw new HcNotFoundError('Master not found: ' + masterId);
    const page: HcPage = {
      id: hcId('page'),
      name: cleanTitle(options.name, master.name),
      mode: master.mode,
      width: master.width,
      height: master.height,
      background: master.background,
      html: master.html,
      blocks: master.blocks ? master.blocks.map(block => ({ ...JSON.parse(JSON.stringify(block)) as HcBlock, id: hcId('block') })) : undefined,
      scene: master.scene ? JSON.parse(JSON.stringify(master.scene)) as HcWhiteboardScene : undefined,
      notes: master.notes,
    };
    const result = await this.applyOps(docId, {
      baseRevision: options.baseRevision,
      actor: options.actor || 'human',
      ops: [{ op: 'add_page', page }],
      summary: 'Add page from master "' + master.name + '"',
    });
    const created = result.doc.pages.find(item => item.id === page.id)!;
    return { doc: result.doc, page: created };
  }

  async listDocs(): Promise<HcDocSummary[]> {
    const entries = await readdir(this.docsDir).catch(() => [] as string[]);
    const summaries: HcDocSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const doc = JSON.parse(await readFile(path.join(this.docsDir, entry), 'utf8')) as HcDocument;
        if (doc.schema !== HCANVAS_SCHEMA) continue;
        summaries.push({
          id: doc.id, title: doc.title, revision: doc.revision, pages: doc.pages.length,
          updatedAt: doc.updatedAt,
          pendingProposals: doc.proposals.filter(proposal => proposal.status === 'pending').length,
        });
      } catch { /* skip corrupt */ }
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readDoc(docId: string): Promise<HcDocument> {
    try {
      const raw = await readFile(this.docPath(docId), 'utf8');
      const doc = JSON.parse(raw) as HcDocument;
      if (doc.schema !== HCANVAS_SCHEMA) throw new HcValidationError('Unsupported document schema');
      return doc;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HcNotFoundError('Document not found: ' + docId);
      throw error;
    }
  }

  async saveDocument(doc: HcDocument): Promise<void> {
    const file = this.docPath(doc.id);
    const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(doc, null, 2), 'utf8');
    await rename(temp, file);
  }

  async createDoc(input: { title?: string; preset?: HcPagePreset } = {}): Promise<HcDocument> {
    const doc = createDocument(input.title, input.preset);
    await this.saveDocument(doc);
    this.state.active = { docId: doc.id, pageId: doc.pages[0]?.id ?? null, blockId: null, actor: 'human', updatedAt: nowIso() };
    await this.saveState();
    this.emit({ type: 'doc.created', docId: doc.id });
    return doc;
  }

  async deleteDoc(docId: string): Promise<void> {
    const file = this.docPath(docId);
    const temp = file + '.deleted.' + randomUUID();
    await rename(file, temp);
    await rm(temp, { force: true });
    const docs = await this.listDocs();
    if (this.state.active.docId === docId) {
      const next = docs[0];
      const nextDoc = next ? await this.readDoc(next.id) : null;
      this.state.active = { docId: nextDoc?.id ?? null, pageId: nextDoc?.pages[0]?.id ?? null, blockId: null, actor: 'human', updatedAt: nowIso() };
      await this.saveState();
    }
    this.emit({ type: 'doc.deleted', docId });
  }

  async updateTitle(docId: string, title: string): Promise<HcDocument> {
    return this.withLock(docId, async () => {
      const doc = await this.readDoc(docId);
      doc.title = cleanTitle(title, doc.title);
      doc.updatedAt = nowIso();
      await this.saveDocument(doc);
      this.emit({ type: 'doc.changed', docId, revision: doc.revision });
      return doc;
    });
  }

  private async withLock<T>(docId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(docId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(docId, next.catch(() => undefined));
    return next;
  }

  async applyOps(docId: string, input: { baseRevision?: number; actor?: string; ops: HcOp[]; dryRun?: boolean; summary?: string }): Promise<HcApplyResult> {
    return this.withLock(docId, async () => {
      const doc = await this.readDoc(docId);
      if (input.baseRevision !== undefined && input.baseRevision !== doc.revision) throw new HcRevisionConflictError(doc);
      if (!Array.isArray(input.ops) || input.ops.length === 0) throw new HcValidationError('ops must be a non-empty array');
      const next = applyOpsToDocument(doc, input.ops);
      if (input.dryRun) return { doc: next, dryRun: true, changed: true };
      next.revision = doc.revision + 1;
      next.updatedAt = nowIso();
      next.history = [...next.history, {
        revision: next.revision, actor: input.actor || 'human',
        summary: input.summary || (input.ops.length + ' op(s)'),
        createdAt: next.updatedAt, opCount: input.ops.length,
      } satisfies HcHistoryEntry].slice(-200);
      await this.saveDocument(next);
      if (this.state.active.docId === docId) {
        this.state.active.actor = input.actor || this.state.active.actor;
        this.state.active.updatedAt = nowIso();
        await this.saveState();
      }
      this.emit({ type: 'doc.changed', docId, revision: next.revision, actor: input.actor || 'human' });
      return { doc: next, dryRun: false, changed: true };
    });
  }

  async createProposal(docId: string, input: { baseRevision: number; actor?: string; intent: string; ops: HcOp[] }): Promise<HcProposal> {
    return this.withLock(docId, async () => {
      const doc = await this.readDoc(docId);
      if (input.baseRevision !== doc.revision) throw new HcRevisionConflictError(doc);
      if (!input.ops.length) throw new HcValidationError('proposal requires at least one op');
      applyOpsToDocument(doc, input.ops);
      const proposal: HcProposal = {
        id: hcId('proposal'), actor: input.actor || 'agent', intent: input.intent || 'Agent proposal',
        baseRevision: input.baseRevision, ops: input.ops, status: 'pending', createdAt: nowIso(),
      };
      doc.proposals.push(proposal);
      doc.updatedAt = nowIso();
      await this.saveDocument(doc);
      this.emit({ type: 'proposal.created', docId, proposalId: proposal.id });
      return proposal;
    });
  }

  async resolveProposal(docId: string, proposalId: string, action: 'accept' | 'reject', actor = 'human'): Promise<{ doc: HcDocument; proposal: HcProposal; conflict?: string }> {
    return this.withLock(docId, async () => {
      const doc = await this.readDoc(docId);
      const proposal = doc.proposals.find(item => item.id === proposalId);
      if (!proposal) throw new HcNotFoundError('Proposal not found: ' + proposalId);
      if (proposal.status !== 'pending') throw new HcValidationError('Proposal already ' + proposal.status);
      if (action === 'reject') {
        proposal.status = 'rejected';
        proposal.resolvedAt = nowIso();
        proposal.resolvedBy = actor;
        doc.updatedAt = nowIso();
        await this.saveDocument(doc);
        this.emit({ type: 'proposal.resolved', docId, proposalId, status: 'rejected' });
        return { doc, proposal };
      }
      let next: HcDocument;
      try {
        if (proposal.baseRevision !== doc.revision) throw new HcRevisionConflictError(doc);
        next = applyOpsToDocument(doc, proposal.ops);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        proposal.status = 'conflicted';
        proposal.conflict = message;
        proposal.resolvedAt = nowIso();
        proposal.resolvedBy = actor;
        await this.saveDocument(doc);
        this.emit({ type: 'proposal.resolved', docId, proposalId, status: 'conflicted' });
        return { doc, proposal, conflict: message };
      }
      next.revision = doc.revision + 1;
      next.updatedAt = nowIso();
      const resolved = next.proposals.find(item => item.id === proposalId);
      if (resolved) {
        resolved.status = 'accepted';
        resolved.resolvedAt = nowIso();
        resolved.resolvedBy = actor;
      }
      next.history = [...next.history, {
        revision: next.revision, actor, summary: 'accepted proposal: ' + proposal.intent,
        createdAt: next.updatedAt, opCount: proposal.ops.length,
      } satisfies HcHistoryEntry].slice(-200);
      await this.saveDocument(next);
      this.emit({ type: 'proposal.resolved', docId, proposalId, status: 'accepted' });
      this.emit({ type: 'doc.changed', docId, revision: next.revision, actor });
      return { doc: next, proposal: resolved ?? proposal };
    });
  }

  async listSessions(): Promise<Array<HcSession & { docTitle: string; pageName: string; stale: boolean }>> {
    const docs = await this.listDocs();
    const docTitles = new Map(docs.map(doc => [doc.id, doc.title]));
    const pageNames = new Map<string, string>();
    for (const doc of docs) {
      try {
        const full = await this.readDoc(doc.id);
        for (const page of full.pages) pageNames.set(page.id, page.name);
      } catch { /* ignore */ }
    }
    const now = Date.now();
    return Object.values(this.state.sessions)
      .map(session => ({
        ...session,
        docTitle: docTitles.get(session.docId) || session.docId,
        pageName: session.pageId ? pageNames.get(session.pageId) || session.pageId : '',
        stale: now - new Date(session.updatedAt).getTime() > 10 * 60 * 1000,
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async touchSession(sessionId: string, patch: { docId?: string; pageId?: string; selection?: string[]; actor?: string } = {}): Promise<HcSession> {
    const session = this.state.sessions[sessionId];
    if (!session) throw new HcNotFoundError('Session not found: ' + sessionId);
    if (patch.docId) session.docId = patch.docId;
    if (patch.pageId) session.pageId = patch.pageId;
    if (patch.selection) session.selection = patch.selection;
    if (patch.actor) session.actor = patch.actor;
    session.updatedAt = nowIso();
    this.state.sessions[sessionId] = session;
    await this.saveState();
    this.emit({ type: 'session.changed', sessionId, actor: session.actor, docId: session.docId });
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.state.sessions[sessionId]) throw new HcNotFoundError('Session not found: ' + sessionId);
    delete this.state.sessions[sessionId];
    await this.saveState();
    this.emit({ type: 'session.changed', sessionId, actor: 'human', removed: true });
  }

  async getState(): Promise<HcStateFile> { return clone(this.state); }

  async activate(input: { docId?: string; pageId?: string; blockId?: string; actor?: string; sessionId?: string }): Promise<HcActiveState> {
    const docId = input.docId ?? (input.sessionId ? this.state.sessions[input.sessionId]?.docId : undefined) ?? this.state.active.docId;
    if (!docId) throw new HcValidationError('No active document');
    let pageId = input.pageId;
    if (!pageId) {
      const doc = await this.readDoc(docId);
      pageId = doc.pages[0]?.id;
    }
    this.state.active = { docId, pageId: pageId ?? null, blockId: input.blockId ?? null, actor: input.actor || 'human', updatedAt: nowIso() };
    if (input.sessionId) {
      const existing = this.state.sessions[input.sessionId];
      this.state.sessions[input.sessionId] = {
        id: input.sessionId, docId, pageId: pageId ?? undefined,
        selection: this.state.active.blockId ? [this.state.active.blockId] : [],
        actor: input.actor || existing?.actor || 'human',
        createdAt: existing?.createdAt ?? nowIso(), updatedAt: nowIso(),
      };
    }
    await this.saveState();
    this.emit({ type: 'active.changed', docId, pageId: pageId ?? null });
    if (input.sessionId) this.emit({ type: 'session.changed', sessionId: input.sessionId, docId, pageId: pageId ?? null });
    return this.state.active;
  }

  async createSession(docId: string, actor: string): Promise<HcSession> {
    const doc = await this.readDoc(docId);
    const session: HcSession = {
      id: hcId('session'), docId, pageId: doc.pages[0]?.id, selection: [], actor,
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    this.state.sessions[session.id] = session;
    await this.saveState();
    this.emit({ type: 'session.changed', sessionId: session.id, actor: session.actor, docId: session.docId });
    return session;
  }

  async getContext(sessionId?: string): Promise<Record<string, unknown>> {
    const session = sessionId ? this.state.sessions[sessionId] : undefined;
    const activeDocId = session?.docId ?? this.state.active.docId;
    const activeDoc = activeDocId ? await this.readDoc(activeDocId).catch(() => null) : null;
    const pageId = session?.pageId ?? this.state.active.pageId;
    const page = activeDoc?.pages.find(item => item.id === pageId) ?? activeDoc?.pages[0] ?? null;
    const docs = await this.listDocs();
    return {
      workspace: this.root,
      active: activeDoc ? {
        docId: activeDoc.id, title: activeDoc.title, revision: activeDoc.revision,
        pageId: page?.id ?? null, pageName: page?.name ?? null, pageMode: page?.mode ?? null,
        blockId: this.state.active.blockId, selection: session?.selection ?? [],
        actor: session?.actor ?? this.state.active.actor,
      } : null,
      session: session ?? null,
      sessions: Object.values(this.state.sessions),
      presence: await this.listSessions(),
      docs,
    };
  }

  async resolve(query: string): Promise<{ query: string; matches: HcResolveCandidate[]; ambiguous: boolean }> {
    const normalized = query.trim().toLowerCase();
    const docs = await this.listDocs();
    const matches: HcResolveCandidate[] = [];
    for (const doc of docs) {
      const title = doc.title.toLowerCase();
      let confidence = 0;
      let reason = '';
      if (normalized === doc.id.toLowerCase()) { confidence = 1; reason = 'exact id'; }
      else if (normalized === title) { confidence = 0.98; reason = 'exact title'; }
      else if (title.includes(normalized)) { confidence = 0.75; reason = 'title contains query'; }
      else if (normalized.split(/\s+/).filter(Boolean).every(part => title.includes(part))) { confidence = 0.6; reason = 'all query terms in title'; }
      if (confidence > 0) matches.push({ docId: doc.id, title: doc.title, revision: doc.revision, confidence, reason });
    }
    matches.sort((left, right) => right.confidence - left.confidence);
    const near = matches.slice(0, 5);
    return { query, matches: near, ambiguous: near.length !== 1 };
  }

  emit(event: Record<string, unknown>): void { this.events.emit('event', event); }

  subscribe(listener: (event: Record<string, unknown>) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  async ensureActiveDoc(): Promise<HcDocument | null> {
    return this.state.active.docId ? this.readDoc(this.state.active.docId).catch(() => null) : null;
  }
}
