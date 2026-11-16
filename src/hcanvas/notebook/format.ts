// Hcanvas notebook (.hnb.md) parsing/serialization.
//
// Design (plan HCANVAS_NOTEBOOK_EXEC_CELLS_16Nov2026.md section 7.2):
//  - optional YAML-ish frontmatter with a minimal scalar parser (no dependency)
//  - markdown cells = text outside fenced code
//  - executable cells = fenced code whose info string carries exec (or the
//    frontmatter enables execute: all)
//  - optional stable cell id via hc-cell=<id> in the info string
//  - source of truth stays plain text; outputs are never written back here
//
// This module is dependency-free and browser-safe (client notebook viewer and
// server tests share it).

export type NotebookCellKind = 'markdown' | 'code';

export interface NotebookFrontmatter {
  /** Raw frontmatter text between the two --- delimiter lines (without delimiters). */
  raw: string;
  /** Parsed scalar keys. Values are strings; comma-separated lists stay strings. */
  values: Record<string, string>;
  present: boolean;
}

export interface NotebookMarkdownCell {
  kind: 'markdown';
  id?: string;
  source: string;
}

export interface NotebookCodeCell {
  kind: 'code';
  /** Raw info string after the fence marker, e.g. "python hc-cell=cell_1 exec". */
  info: string;
  language: string;
  /** True when the fence opts into execution (or frontmatter execute: all). */
  exec: boolean;
  /** Optional stable id from hc-cell=<id>. */
  id?: string;
  source: string;
}

export type NotebookCell = NotebookMarkdownCell | NotebookCodeCell;

export interface ParsedNotebook {
  frontmatter: NotebookFrontmatter;
  cells: NotebookCell[];
  eol: string;
  /** True when the original text ended with a line break. */
  trailingNewline: boolean;
  warnings: string[];
}

const FENCE = String.fromCharCode(96).repeat(3);
const FRONTMATTER_KEYS = new Set(['hcanvas', 'version', 'title', 'kernel', 'execute']);

function detectEol(text: string): string {
  const index = text.indexOf('\n');
  if (index > 0 && text[index - 1] === '\r') return '\r\n';
  return '\n';
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (trimmed.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Minimal frontmatter parser: key: value scalars only, unknown keys preserved raw. */
export function parseFrontmatter(lines: string[]): { frontmatter: NotebookFrontmatter; bodyStart: number } {
  if (!lines.length || lines[0]!.trim() !== '---') {
    return { frontmatter: { raw: '', values: {}, present: false }, bodyStart: 0 };
  }
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed === '---' || trimmed === '...') { end = index; break; }
  }
  if (end < 0) {
    return { frontmatter: { raw: '', values: {}, present: false }, bodyStart: 0 };
  }
  const rawLines = lines.slice(1, end);
  const values: Record<string, string> = {};
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    if (!FRONTMATTER_KEYS.has(key)) continue;
    values[key] = unquote(trimmed.slice(colon + 1));
  }
  return { frontmatter: { raw: rawLines.join('\n'), values, present: true }, bodyStart: end + 1 };
}

interface FenceInfo {
  language: string;
  exec: boolean;
  id?: string;
}

function parseFenceInfo(info: string, executeAll: boolean): FenceInfo {
  const tokens = info.trim().split(/\s+/u).filter(Boolean);
  let language = '';
  let exec = executeAll;
  let id: string | undefined;
  for (const token of tokens) {
    const cellId = /^hc-cell=([A-Za-z0-9_-]+)$/u.exec(token);
    if (cellId) { id = cellId[1]; continue; }
    if (token === 'exec') { exec = true; continue; }
    if (!language) language = token;
  }
  return { language: language || 'text', exec, ...(id ? { id } : {}) };
}

function fenceOpen(line: string): { char: string; length: number; info: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) return null;
  const marker = match[1]!;
  return { char: marker[0]!, length: marker.length, info: (match[2] || '').trim() };
}

function isFenceClose(line: string, char: string, length: number): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line);
  return Boolean(match && match[1]![0] === char && match[1]!.length >= length);
}

/** Parse a .hnb.md source file. Never throws; malformed fences become warnings. */
export function parseNotebook(text: string): ParsedNotebook {
  const eol = detectEol(text);
  const trailingNewline = /\r?\n$/u.test(text);
  const lines = splitLines(text);
  const { frontmatter, bodyStart } = parseFrontmatter(lines);
  const executeValue = (frontmatter.values.execute || '').trim().toLowerCase();
  const executeAll = executeValue === 'all' || executeValue === 'true' || executeValue === 'code-fences';
  const cells: NotebookCell[] = [];
  const warnings: string[] = [];
  let markdownLines: string[] = [];
  let codeLines: string[] = [];
  let fence: { char: string; length: number; info: FenceInfo } | null = null;

  const flushMarkdown = (): void => {
    while (markdownLines.length && markdownLines[0]!.trim() === '') markdownLines.shift();
    while (markdownLines.length && markdownLines[markdownLines.length - 1]!.trim() === '') markdownLines.pop();
    if (markdownLines.length) cells.push({ kind: 'markdown', source: markdownLines.join('\n') });
    markdownLines = [];
  };
  const flushCode = (): void => {
    if (!fence) return;
    cells.push({
      kind: 'code',
      info: fence.info.language === 'text' ? '' : fence.info.language,
      language: fence.info.language,
      exec: fence.info.exec,
      ...(fence.info.id ? { id: fence.info.id } : {}),
      source: codeLines.join('\n'),
    });
    fence = null;
    codeLines = [];
  };

  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence) {
      if (isFenceClose(line, fence.char, fence.length)) { flushCode(); continue; }
      codeLines.push(line);
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      flushMarkdown();
      fence = { char: open.char, length: open.length, info: parseFenceInfo(open.info, executeAll) };
      codeLines = [];
      continue;
    }
    markdownLines.push(line);
  }
  if (fence) {
    warnings.push('Unclosed code fence at end of file; treating the remainder as a code cell.');
    flushCode();
  } else {
    flushMarkdown();
  }
  return { frontmatter, cells, eol, trailingNewline, warnings };
}

function codeFenceInfo(cell: NotebookCodeCell): string {
  const parts = [cell.language || 'text'];
  if (cell.id) parts.push('hc-cell=' + cell.id);
  if (cell.exec) parts.push('exec');
  return parts.join(' ');
}

/** Serialize cells back to .hnb.md. Frontmatter raw text is preserved verbatim. */
export function serializeNotebook(parsed: Pick<ParsedNotebook, 'frontmatter' | 'eol' | 'trailingNewline'> & { cells: NotebookCell[] }): string {
  const parts: string[] = [];
  if (parsed.frontmatter.present) {
    parts.push('---');
    if (parsed.frontmatter.raw) parts.push(parsed.frontmatter.raw);
    parts.push('---');
    parts.push('');
  }
  for (const cell of parsed.cells) {
    if (cell.kind === 'markdown') {
      parts.push(cell.source);
      parts.push('');
    } else {
      parts.push(FENCE + codeFenceInfo(cell));
      parts.push(cell.source);
      parts.push(FENCE);
      parts.push('');
    }
  }
  const minimum = parsed.frontmatter.present ? 3 : 0;
  while (parts.length > minimum && parts[parts.length - 1] === '') parts.pop();
  const body = parts.join(parsed.eol);
  return parsed.trailingNewline ? body + parsed.eol : body;
}

/** Stable cache key for outputs: cell ordinal + short content hash. */
export function notebookCellKey(index: number, source: string): string {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return index + ':' + hex;
}

export function notebookCodeCells(parsed: ParsedNotebook): Array<{ cell: NotebookCodeCell; index: number }> {
  const result: Array<{ cell: NotebookCodeCell; index: number }> = [];
  parsed.cells.forEach((cell, index) => { if (cell.kind === 'code') result.push({ cell, index }); });
  return result;
}
