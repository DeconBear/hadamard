import type { HcStoredOutput } from '../execOutputs.js';
import { normalizeNotebookVariables } from './variables.js';
import type { NotebookEditorCell, NotebookEditorData } from './types.js';

interface IpynbOutput {
  output_type: string;
  name?: string;
  text?: unknown;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface IpynbCell {
  id?: string;
  cell_type: string;
  source: unknown;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: IpynbOutput[];
}

interface IpynbDocument {
  cells: IpynbCell[];
  metadata?: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

function sourceText(source: unknown): string {
  return typeof source === 'string' ? source : Array.isArray(source) ? source.map(String).join('') : '';
}

function sourceLines(source: string): string[] {
  if (!source) return [];
  const lines = source.split('\n');
  return lines.map((line, index) => index < lines.length - 1 ? line + '\n' : line);
}

function imageUrl(mime: string, value: string): string {
  if (mime !== 'image/svg+xml') return 'data:' + mime + ';base64,' + value;
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(value)));
}

function mimeToStored(data: Record<string, unknown>, id: string): HcStoredOutput | null {
  for (const mime of ['image/png', 'image/svg+xml', 'image/jpeg', 'text/html', 'application/json', 'text/latex', 'application/x-latex', 'text/markdown', 'text/plain']) {
    if (!(mime in data)) continue;
    const value = data[mime];
    if (mime === 'application/json') return { id, kind: 'json', value };
    if (typeof value !== 'string') continue;
    if (mime.startsWith('image/')) return { id, kind: 'image', mime: mime as 'image/png' | 'image/jpeg' | 'image/svg+xml', url: imageUrl(mime, value) };
    if (mime === 'text/html') return { id, kind: 'html', html: value };
    if (mime === 'text/markdown') return { id, kind: 'markdown', text: value };
    if (mime === 'text/plain') return { id, kind: 'text', text: value };
    return { id, kind: 'math', tex: value, display: true };
  }
  return null;
}

function outputToStored(output: IpynbOutput, index: number): HcStoredOutput | null {
  const id = 'out_' + index;
  if (output.output_type === 'stream') return { id, kind: 'stream', name: output.name === 'stderr' ? 'stderr' : 'stdout', text: sourceText(output.text) };
  if (output.output_type === 'error') return { id, kind: 'error', ename: output.ename || 'Error', evalue: output.evalue || '', traceback: Array.isArray(output.traceback) ? output.traceback.map(String) : [] };
  if (output.output_type === 'display_data' || output.output_type === 'execute_result') return output.data ? mimeToStored(output.data, id) : null;
  return null;
}

function languageName(kernelId: string | undefined): string {
  if (kernelId === 'cpp' || kernelId === 'c++') return 'cpp';
  if (kernelId === 'octave') return 'octave';
  return kernelId || 'python';
}

export function parseIpynb(text: string): { data: NotebookEditorData; metadata: Record<string, unknown> } {
  const raw = JSON.parse(text) as IpynbDocument;
  if (!raw || raw.nbformat !== 4 || !Array.isArray(raw.cells)) throw new Error('Not a valid Jupyter nbformat 4 notebook.');
  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
  const kernelSpec = metadata.kernelspec && typeof metadata.kernelspec === 'object' ? metadata.kernelspec as Record<string, unknown> : {};
  const languageInfo = metadata.language_info && typeof metadata.language_info === 'object' ? metadata.language_info as Record<string, unknown> : {};
  const hcanvas = metadata.hcanvas && typeof metadata.hcanvas === 'object' ? metadata.hcanvas as Record<string, unknown> : {};
  const defaultKernelId = typeof hcanvas.defaultKernelId === 'string' ? hcanvas.defaultKernelId : typeof kernelSpec.name === 'string' ? kernelSpec.name : typeof languageInfo.name === 'string' ? languageInfo.name : 'python';
  const cells = raw.cells.map((cell, index): NotebookEditorCell | null => {
    if (cell.cell_type !== 'markdown' && cell.cell_type !== 'code') return null;
    const kind = cell.cell_type === 'markdown' ? 'markdown' : 'code';
    const outputs = kind === 'code' && Array.isArray(cell.outputs)
      ? cell.outputs.map((output, outputIndex) => outputToStored(output, outputIndex)).filter((output): output is HcStoredOutput => Boolean(output))
      : [];
    const cellMetadata = cell.metadata && typeof cell.metadata === 'object' ? cell.metadata : {};
    const hc = cellMetadata.hcanvas && typeof cellMetadata.hcanvas === 'object' ? cellMetadata.hcanvas as Record<string, unknown> : {};
    return {
      id: cell.id || 'nbcell_' + (index + 1),
      kind,
      source: sourceText(cell.source),
      ...(kind === 'code' ? {
        kernelId: typeof hc.kernelId === 'string' ? hc.kernelId : defaultKernelId,
        language: languageName(typeof hc.kernelId === 'string' ? hc.kernelId : defaultKernelId),
        executable: hc.executable !== false,
        outputs,
        executionCount: typeof cell.execution_count === 'number' ? cell.execution_count : 0,
      } : {}),
      ...(Object.keys(cellMetadata).length ? { metadata: cellMetadata } : {}),
    };
  }).filter((cell): cell is NotebookEditorCell => Boolean(cell));
  return {
    data: {
      cells,
      ...(defaultKernelId ? { defaultKernelId } : {}),
      variables: normalizeNotebookVariables(hcanvas.variables),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    },
    metadata,
  };
}

function storedToNbOutput(output: HcStoredOutput): IpynbOutput | null {
  if (output.kind === 'stream') return { output_type: 'stream', name: output.name, text: output.text };
  if (output.kind === 'error') return { output_type: 'error', ename: output.ename, evalue: output.evalue, traceback: output.traceback };
  if (output.kind === 'notice') return { output_type: 'stream', name: 'stdout', text: output.text };
  if (output.kind === 'text') return { output_type: 'display_data', data: { 'text/plain': output.text }, metadata: {} };
  if (output.kind === 'markdown') return { output_type: 'display_data', data: { 'text/markdown': output.text }, metadata: {} };
  if (output.kind === 'math') return { output_type: 'display_data', data: { 'text/latex': output.tex }, metadata: {} };
  if (output.kind === 'html') return { output_type: 'display_data', data: { 'text/html': output.html }, metadata: {} };
  if (output.kind === 'json') return { output_type: 'display_data', data: { 'application/json': output.value }, metadata: {} };
  if (output.kind === 'image') {
    return {
      output_type: 'display_data',
      data: { [output.mime]: output.url.startsWith('data:') ? output.url.slice(output.url.indexOf(',') + 1) : output.url },
      metadata: { ...(output.assetId ? { assetId: output.assetId } : {}), ...(output.alt ? { alt: output.alt } : {}) },
    };
  }
  return null;
}

export function serializeIpynb(data: NotebookEditorData, metadata: Record<string, unknown> = data.metadata || {}): string {
  const defaultKernelId = data.defaultKernelId || 'python';
  const language = languageName(defaultKernelId);
  const kernelName = defaultKernelId === 'python' ? 'python3' : defaultKernelId;
  const document: IpynbDocument = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      ...metadata,
      kernelspec: { name: kernelName, display_name: defaultKernelId, language },
      language_info: { name: language },
      hcanvas: {
        defaultKernelId,
        ...(Object.keys(data.variables || {}).length ? { variables: data.variables } : {}),
      },
    },
    cells: data.cells.map(cell => {
      const base: IpynbCell = {
        id: cell.id,
        cell_type: cell.kind,
        source: sourceLines(cell.source),
        metadata: { ...(cell.metadata || {}) },
      };
      if (cell.kind === 'code') {
        base.metadata = { ...base.metadata, hcanvas: { kernelId: cell.kernelId || defaultKernelId, executable: cell.executable !== false } };
        base.execution_count = cell.executionCount || null;
        base.outputs = (cell.outputs || []).map(storedToNbOutput).filter((output): output is IpynbOutput => Boolean(output));
      }
      return base;
    }),
  };
  return JSON.stringify(document, null, 2) + '\n';
}
