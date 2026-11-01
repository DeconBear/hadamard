import { randomUUID } from 'node:crypto';

export const HCANVAS_SCHEMA = 'hadamard-canvas/1';

export type HcPageMode = 'canvas' | 'html' | 'infinite' | 'whiteboard';
export type HcBlockType = 'html' | 'text' | 'markdown' | 'code' | 'image' | 'shape';
export type HcShape = 'rect' | 'ellipse' | 'line';

export interface HcBlockStyle {
  fill?: string;
  color?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  align?: 'left' | 'center' | 'right';
  opacity?: number;
  [key: string]: unknown;
}

export interface HcBlock {
  id: string;
  type: HcBlockType;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  rotation?: number;
  locked?: boolean;
  name?: string;
  /** html block / page block source */
  html?: string;
  /** plain text block source */
  text?: string;
  /** markdown block source */
  markdown?: string;
  /** code block source */
  code?: string;
  language?: string;
  /** image block source */
  src?: string;
  alt?: string;
  /** shape block */
  shape?: HcShape;
  style?: HcBlockStyle;
}

export interface HcWhiteboardScene {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export interface HcPage {
  id: string;
  name: string;
  mode: HcPageMode;
  width: number;
  height: number;
  background: string;
  /** full page HTML source when mode === 'html' */
  html?: string;
  /** blocks when mode === 'canvas' or 'infinite' */
  blocks?: HcBlock[];
  /** Excalidraw scene when mode === 'whiteboard' */
  scene?: HcWhiteboardScene;
  notes?: string;
  hidden?: boolean;
}

/** Reusable page layout saved from any page; workspace-scoped. */
export interface HcMaster {
  id: string;
  name: string;
  mode: HcPageMode;
  width: number;
  height: number;
  background: string;
  html?: string;
  blocks?: HcBlock[];
  scene?: HcWhiteboardScene;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HcProposal {
  id: string;
  actor: string;
  intent: string;
  baseRevision: number;
  ops: HcOp[];
  status: 'pending' | 'accepted' | 'rejected' | 'conflicted';
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  conflict?: string;
}

export interface HcHistoryEntry {
  revision: number;
  actor: string;
  summary: string;
  createdAt: string;
  opCount: number;
}

export interface HcDocument {
  schema: typeof HCANVAS_SCHEMA;
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  pages: HcPage[];
  proposals: HcProposal[];
  history: HcHistoryEntry[];
}

export interface HcHtmlPatch {
  op: 'set_text' | 'set_html' | 'set_style' | 'set_attr' | 'remove_attr' | 'insert_html' | 'remove_node';
  /** stable data-hc-id */
  target?: string;
  /** CSS selector fallback */
  selector?: string;
  text?: string;
  html?: string;
  styles?: Record<string, string | number>;
  name?: string;
  value?: string;
  position?: 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend';
}

export type HcOp =
  | { op: 'add_page'; page: HcPage; index?: number }
  | { op: 'update_page'; pageId: string; patch: Partial<Pick<HcPage, 'name' | 'mode' | 'width' | 'height' | 'background' | 'html' | 'notes' | 'hidden'>> }
  | { op: 'delete_page'; pageId: string }
  | { op: 'add_block'; pageId: string; block: HcBlock; index?: number }
  | { op: 'update_block'; pageId: string; blockId: string; patch: Partial<Omit<HcBlock, 'id' | 'type'>> }
  | { op: 'delete_block'; pageId: string; blockId: string }
  | { op: 'set_page_html'; pageId: string; html: string }
  | { op: 'set_whiteboard_scene'; pageId: string; scene: HcWhiteboardScene }
  | { op: 'set_block_html'; pageId: string; blockId: string; html: string }
  | { op: 'set_block_text'; pageId: string; blockId: string; text: string }
  | { op: 'set_block_markdown'; pageId: string; blockId: string; markdown: string }
  | { op: 'set_block_code'; pageId: string; blockId: string; code: string; language?: string }
  | { op: 'html_patch'; pageId: string; blockId?: string; patches: HcHtmlPatch[] }
  | { op: 'reorder_block'; pageId: string; blockId: string; direction: 'up' | 'down' }
  | { op: 'reorder_page'; pageId: string; direction: 'up' | 'down' };

export interface HcPagePreset {
  id: string;
  title: string;
  width: number;
  height: number;
  background: string;
}

export const HCANVAS_PAGE_PRESETS: HcPagePreset[] = [
  { id: 'slide', title: 'Slide · 16:9', width: 1280, height: 720, background: '#ffffff' },
  { id: 'a4', title: 'A4 portrait', width: 794, height: 1123, background: '#ffffff' },
  { id: 'poster', title: 'Poster · 4:5', width: 1080, height: 1350, background: '#ffffff' },
  { id: 'square', title: 'Square · 1:1', width: 1080, height: 1080, background: '#ffffff' },
  { id: 'wide', title: 'Wide · 1920×1080', width: 1920, height: 1080, background: '#ffffff' },
];

export function hcId(prefix = 'hc'): string {
  return prefix + '_' + randomUUID().replace(/-/g, '').slice(0, 12);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export const DEMO_SLIDE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; }
  body {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #1f2430;
    background: #f6f4ef;
    overflow: hidden;
  }
  .slide { position: relative; width: 100%; height: 100%; padding: 64px 72px; display: flex; flex-direction: column; }
  .grain { position: absolute; inset: 0; background-image: radial-gradient(rgba(0,0,0,.055) 1px, transparent 1px); background-size: 22px 22px; opacity: .5; pointer-events: none; }
  .top { display: flex; align-items: center; justify-content: space-between; position: relative; z-index: 1; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -.02em; font-size: 18px; }
  .mark { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; color: white; background: linear-gradient(135deg, #7c3aed, #2563eb); font-size: 15px; }
  .tag { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #7a7468; border: 1px solid #d9d3c7; border-radius: 999px; padding: 6px 10px; background: rgba(255,255,255,.55); }
  h1 { position: relative; z-index: 1; font-family: Georgia, "Times New Roman", serif; font-weight: 500; font-size: 62px; line-height: 1.02; letter-spacing: -.045em; margin: 42px 0 18px; max-width: 760px; }
  h1 em { color: #6d28d9; font-style: italic; }
  .lede { position: relative; z-index: 1; font-size: 18px; line-height: 1.55; color: #5d584e; max-width: 560px; margin: 0; }
  .cards { position: relative; z-index: 1; margin-top: auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .card { background: rgba(255,255,255,.8); border: 1px solid #d9d3c7; border-radius: 16px; padding: 15px 16px; box-shadow: 0 1px 0 rgba(255,255,255,.8) inset; }
  .card b { display: block; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #8a8276; margin-bottom: 6px; }
  .card span { font-size: 14px; color: #2c313c; line-height: 1.45; }
  .dot { color: #7c3aed; }
  .foot { position: absolute; right: 72px; bottom: 28px; font-size: 11px; letter-spacing: .1em; color: #a39b8c; text-transform: uppercase; }
</style>
</head>
<body>
  <div class="slide">
    <div class="grain"></div>
    <div class="top">
      <div class="brand"><span class="mark">H</span> Hadamard Canvas</div>
      <span class="tag">HTML page · editable</span>
    </div>
    <h1>An <em>AI-native</em> canvas for serious visual work.</h1>
    <p class="lede">Double-click any text to edit it in place. Toggle source mode to change HTML and CSS. The agent reads and patches the same document through the hcanvas CLI.</p>
    <div class="cards">
      <div class="card"><b>For humans</b><span>Direct manipulation, real typography, HTML/CSS.</span></div>
      <div class="card"><b>For agents</b><span>Stable data-hc-id, structured patches, revisions.</span></div>
      <div class="card"><b>For everyone</b><span>One document, visual and textual, no lock-in.</span></div>
    </div>
    <div class="foot">hcanvas · 2026</div>
  </div>
</body>
</html>`;
