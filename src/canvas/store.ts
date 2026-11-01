/**
 * Canvas persistence: one JSON document per canvas under
 * `<workDir>/.hadamard/canvas`, atomic writes, revision CAS and an append-only
 * op log. Mirrors the project issue store conventions (no external deps).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { encodeHadamardProjectPath } from '../config/projectSessionDirectory.js';
import { docFromScene, parseExcalidrawScene, sceneFromDoc, type ExcalidrawScene } from './excalidrawScene.js';
import { applyCanvasOps, type CanvasOpResult } from './ops.js';
import {
  CANVAS_DIR,
  CanvasValidationError,
  createEmptyCanvasDoc,
  parseCanvasDoc,
  type CanvasAsset,
  type CanvasDoc,
  type CanvasProposal,
  type CanvasOp,
} from './types.js';

export const CANVAS_DOC_EXTENSION = '.canvas.json';
export const CANVAS_SCENE_EXTENSION = '.scene.json';
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export class CanvasNotFoundError extends Error {
  constructor(readonly docId: string) {
    super('Canvas "' + docId + '" does not exist.');
    this.name = 'CanvasNotFoundError';
  }
}

export class CanvasRevisionConflictError extends Error {
  constructor(
    readonly docId: string,
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super('Canvas "' + docId + '" changed: expected revision ' + expectedRevision + ', current ' + currentRevision + '.');
    this.name = 'CanvasRevisionConflictError';
  }
}

export interface CanvasDocumentSummary {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  frameCount: number;
  nodeCount: number;
  edgeCount: number;
  packIds: string[];
  pendingProposals: number;
}

export function canvasRoot(workDir: string): string {
  return path.join(path.resolve(workDir), CANVAS_DIR);
}

export function assertCanvasDocId(docId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(docId)) {
    throw new CanvasValidationError('Invalid canvas id: use 2-64 lowercase letters, digits or dashes.');
  }
  return docId;
}

export function canvasDocPath(workDir: string, docId: string): string {
  return path.join(canvasRoot(workDir), assertCanvasDocId(docId) + CANVAS_DOC_EXTENSION);
}

export function canvasAssetsDir(workDir: string, docId: string): string {
  return path.join(canvasRoot(workDir), 'assets', assertCanvasDocId(docId));
}

export function canvasScenePath(workDir: string, docId: string): string {
  return path.join(canvasRoot(workDir), assertCanvasDocId(docId) + CANVAS_SCENE_EXTENSION);
}

function slugify(value: string): string {
  const slug = value.toLocaleLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40);
  return slug || 'canvas';
}

function nowIso(): string {
  return new Date().toISOString();
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), '.' + path.basename(filePath) + '.' + randomBytes(6).toString('hex') + '.tmp');
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch { return false; }
}

const writeQueues = new Map<string, Promise<unknown>>();

async function serializeWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  writeQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  }
}

async function readDocFile(filePath: string, docId: string): Promise<CanvasDoc> {
  let raw: string;
  try {
    const info = await stat(filePath);
    if (info.size > MAX_DOC_BYTES) throw new CanvasValidationError('Canvas document exceeds ' + MAX_DOC_BYTES + ' bytes.');
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CanvasNotFoundError(docId);
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new CanvasValidationError('Canvas document is not valid JSON: ' + (error instanceof Error ? error.message : String(error)));
  }
  return parseCanvasDoc(parsed);
}

export async function readCanvasDoc(workDir: string, docId: string): Promise<CanvasDoc> {
  return readDocFile(canvasDocPath(workDir, docId), assertCanvasDocId(docId));
}

export async function listCanvasDocs(workDir: string): Promise<{ documents: CanvasDocumentSummary[]; errors: { file: string; message: string }[] }> {
  const root = canvasRoot(workDir);
  let entries: string[];
  try { entries = await readdir(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { documents: [], errors: [] };
    throw error;
  }
  const documents: CanvasDocumentSummary[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const entry of entries.filter(name => name.endsWith(CANVAS_DOC_EXTENSION)).sort()) {
    const id = entry.slice(0, -CANVAS_DOC_EXTENSION.length);
    try {
      const doc = await readCanvasDoc(workDir, id);
      documents.push({
        id: doc.id, title: doc.title, revision: doc.revision,
        createdAt: doc.createdAt, updatedAt: doc.updatedAt,
        frameCount: doc.frames.length, nodeCount: doc.nodes.length, edgeCount: doc.edges.length,
        packIds: doc.meta.packIds, pendingProposals: doc.proposals.filter(proposal => proposal.status === 'pending').length,
      });
    } catch (error) {
      errors.push({ file: entry, message: error instanceof Error ? error.message : String(error) });
    }
  }
  documents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { documents, errors };
}

async function appendOpLog(workDir: string, docId: string, entry: Record<string, unknown>): Promise<void> {
  const file = path.join(canvasRoot(workDir), assertCanvasDocId(docId) + '.log.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a' });
}

export async function createCanvasDoc(workDir: string, input: {
  title: string;
  packIds?: string[];
  template?: string;
  projectId?: string;
  initialDoc?: CanvasDoc;
}): Promise<CanvasDoc> {
  const title = (input.title ?? '').trim();
  if (!title) throw new CanvasValidationError('Canvas title must not be empty.');
  if (title.length > 200) throw new CanvasValidationError('Canvas title is too long (max 200).');
  const base = slugify(title);
  const id = base + '-' + randomBytes(3).toString('hex');
  const projectId = input.projectId ?? encodeHadamardProjectPath(path.resolve(workDir));
  const doc = input.initialDoc
    ? { ...input.initialDoc, id, projectId, title, revision: 0 }
    : createEmptyCanvasDoc({ id, projectId, title, packIds: input.packIds, template: input.template });
  doc.id = id;
  doc.projectId = projectId;
  doc.title = title;
  doc.revision = 0;
  doc.createdAt = nowIso();
  doc.updatedAt = doc.createdAt;
  const parsed = parseCanvasDoc(doc);
  const filePath = canvasDocPath(workDir, id);
  await serializeWrite(filePath, async () => {
    if (await exists(filePath)) throw new CanvasValidationError('Canvas id collision, retry.');
    await atomicWrite(filePath, JSON.stringify(parsed, null, 2) + '\n');
  });
  await appendOpLog(workDir, id, { at: parsed.updatedAt, revision: parsed.revision, action: 'create', title });
  return parsed;
}

/** Save a full document. Bumps revision by exactly one when expectedRevision matches. */
export async function saveCanvasDoc(workDir: string, doc: CanvasDoc, options: {
  expectedRevision?: number;
  bumpRevision?: boolean;
} = {}): Promise<CanvasDoc> {
  const parsed = parseCanvasDoc(doc);
  const filePath = canvasDocPath(workDir, parsed.id);
  return serializeWrite(filePath, async () => {
    let current: CanvasDoc | null = null;
    try { current = await readDocFile(filePath, parsed.id); } catch (error) {
      if (!(error instanceof CanvasNotFoundError)) throw error;
    }
    if (current) {
      const expected = options.expectedRevision;
      if (expected !== undefined && current.revision !== expected) {
        throw new CanvasRevisionConflictError(parsed.id, expected, current.revision);
      }
      if (parsed.revision !== current.revision && options.expectedRevision === undefined && options.bumpRevision !== false) {
        throw new CanvasRevisionConflictError(parsed.id, parsed.revision, current.revision);
      }
      parsed.createdAt = current.createdAt;
    }
    if (options.bumpRevision !== false) parsed.revision = (current?.revision ?? 0) + 1;
    else if (current) parsed.revision = current.revision;
    parsed.updatedAt = nowIso();
    await atomicWrite(filePath, JSON.stringify(parsed, null, 2) + '\n');
    await appendOpLog(workDir, parsed.id, { at: parsed.updatedAt, revision: parsed.revision, action: 'save' });
    return parsed;
  });
}

export interface ApplyCanvasOpsResult extends CanvasOpResult {
  logEntry: { at: string; revision: number; action: 'ops'; summary: string[] };
}

export async function applyCanvasOpsToDoc(workDir: string, docId: string, ops: unknown, options: {
  expectedRevision?: number;
  actor?: 'user' | 'agent';
} = {}): Promise<ApplyCanvasOpsResult> {
  const id = assertCanvasDocId(docId);
  const filePath = canvasDocPath(workDir, id);
  return serializeWrite(filePath, async () => {
    const current = await readDocFile(filePath, id);
    const expected = options.expectedRevision;
    if (expected !== undefined && current.revision !== expected) {
      throw new CanvasRevisionConflictError(id, expected, current.revision);
    }
    const result = applyCanvasOps(current, ops);
    const saved = await saveCanvasDocLocked(workDir, result.doc, current.revision);
    await syncSceneFromDocLocked(workDir, saved);
    await appendOpLog(workDir, id, { at: saved.updatedAt, revision: saved.revision, action: 'ops', summary: result.summary, actor: options.actor ?? 'user' });
    return {
      ...result,
      doc: saved,
      logEntry: { at: saved.updatedAt, revision: saved.revision, action: 'ops', summary: result.summary },
    };
  });
}

/** Caller must already hold the document write lock (serializeWrite). */
async function saveCanvasDocLocked(workDir: string, doc: CanvasDoc, previousRevision: number): Promise<CanvasDoc> {
  const filePath = canvasDocPath(workDir, doc.id);
  const saved = { ...doc, revision: previousRevision + 1, updatedAt: nowIso() };
  const parsed = parseCanvasDoc(saved);
  await atomicWrite(filePath, JSON.stringify(parsed, null, 2) + '\n');
  await appendOpLog(workDir, parsed.id, { at: parsed.updatedAt, revision: parsed.revision, action: 'save' });
  return parsed;
}

export async function readCanvasScene(workDir: string, docId: string): Promise<ExcalidrawScene | null> {
  const file = canvasScenePath(workDir, docId);
  let raw: string;
  try {
    const info = await stat(file);
    if (info.size > 4 * 1024 * 1024) throw new CanvasValidationError('Canvas scene exceeds 4 MiB.');
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return parseExcalidrawScene(JSON.parse(raw));
  } catch (error) {
    throw new CanvasValidationError('Canvas scene is invalid: ' + (error instanceof Error ? error.message : String(error)));
  }
}

async function writeSceneFile(workDir: string, docId: string, scene: ExcalidrawScene): Promise<void> {
  const parsed = parseExcalidrawScene(scene);
  await mkdir(canvasRoot(workDir), { recursive: true });
  await atomicWrite(canvasScenePath(workDir, docId), JSON.stringify(parsed) + '\n');
}

/** Persist an Excalidraw scene and rebuild the agent-readable document projection. */
export async function saveCanvasScene(workDir: string, docId: string, scene: unknown, options: {
  expectedRevision?: number;
} = {}): Promise<{ doc: CanvasDoc; scene: ExcalidrawScene }> {
  const id = assertCanvasDocId(docId);
  const parsedScene = parseExcalidrawScene(scene);
  const filePath = canvasDocPath(workDir, id);
  return serializeWrite(filePath, async () => {
    const current = await readDocFile(filePath, id);
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      throw new CanvasRevisionConflictError(id, options.expectedRevision, current.revision);
    }
    const projected = docFromScene(parsedScene, current);
    projected.revision = current.revision + 1;
    projected.updatedAt = nowIso();
    const parsedDoc = parseCanvasDoc(projected);
    await atomicWrite(filePath, JSON.stringify(parsedDoc, null, 2) + '\n');
    await writeSceneFile(workDir, id, parsedScene);
    await appendOpLog(workDir, id, { at: parsedDoc.updatedAt, revision: parsedDoc.revision, action: 'scene' });
    return { doc: parsedDoc, scene: parsedScene };
  });
}

/** Regenerate the scene from the committed document projection (after agent edits). */
async function syncSceneFromDocLocked(workDir: string, doc: CanvasDoc): Promise<void> {
  const file = canvasScenePath(workDir, doc.id);
  const exists = await stat(file).then(() => true).catch(() => false);
  if (exists) await writeSceneFile(workDir, doc.id, sceneFromDoc(doc));
}

export async function deleteCanvasDoc(workDir: string, docId: string): Promise<void> {
  const id = assertCanvasDocId(docId);
  await serializeWrite(canvasDocPath(workDir, id), async () => {
    await rm(canvasDocPath(workDir, id), { force: true });
    await rm(canvasScenePath(workDir, id), { force: true });
    await rm(path.join(canvasRoot(workDir), id + '.log.jsonl'), { force: true });
    await rm(canvasAssetsDir(workDir, id), { recursive: true, force: true });
  });
}

// ── Proposals ────────────────────────────────────────────────────────────────

export async function createCanvasProposal(workDir: string, docId: string, input: {
  intent: string;
  ops: CanvasOp[];
  sessionId?: string;
  authorName?: string;
}): Promise<{ doc: CanvasDoc; proposal: CanvasProposal }> {
  const id = assertCanvasDocId(docId);
  const intent = (input.intent ?? '').trim();
  if (!intent) throw new CanvasValidationError('Proposal intent must not be empty.');
  if (intent.length > 2000) throw new CanvasValidationError('Proposal intent is too long (max 2000).');
  const filePath = canvasDocPath(workDir, id);
  return serializeWrite(filePath, async () => {
    const current = await readDocFile(filePath, id);
    // Validate the ops without persisting their effect: apply to a throwaway copy.
    applyCanvasOps(current, input.ops);
    const proposal: CanvasProposal = {
      id: 'proposal-' + randomBytes(4).toString('hex'),
      intent,
      baseRevision: current.revision,
      ops: input.ops,
      status: 'pending',
      author: { kind: 'agent', ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.authorName ? { name: input.authorName } : {}) },
      createdAt: nowIso(),
    };
    const next: CanvasDoc = { ...current, proposals: [...current.proposals, proposal], updatedAt: nowIso() };
    // Proposals are metadata: do not consume a content revision.
    await atomicWrite(filePath, JSON.stringify(parseCanvasDoc(next), null, 2) + '\n');
    await appendOpLog(workDir, id, { at: proposal.createdAt, revision: current.revision, action: 'propose', proposalId: proposal.id });
    return { doc: next, proposal };
  });
}

export async function resolveCanvasProposal(workDir: string, docId: string, proposalId: string, action: 'accept' | 'reject', options: {
  note?: string;
  reviewer?: 'user';
} = {}): Promise<{ doc: CanvasDoc; proposal: CanvasProposal; conflicted?: boolean }> {
  const id = assertCanvasDocId(docId);
  const filePath = canvasDocPath(workDir, id);
  return serializeWrite(filePath, async () => {
    const current = await readDocFile(filePath, id);
    const proposal = current.proposals.find(item => item.id === proposalId);
    if (!proposal) throw new CanvasValidationError('Unknown proposal id "' + proposalId + '".');
    if (proposal.status !== 'pending') throw new CanvasValidationError('Proposal is already ' + proposal.status + '.');
    if (action === 'reject') {
      const rejected: CanvasProposal = { ...proposal, status: 'rejected', reviewedAt: nowIso(), ...(options.note ? { reviewNote: options.note } : {}) };
      const next: CanvasDoc = { ...current, proposals: current.proposals.map(item => item.id === proposal.id ? rejected : item), updatedAt: nowIso() };
      await atomicWrite(filePath, JSON.stringify(parseCanvasDoc(next), null, 2) + '\n');
      return { doc: next, proposal: rejected };
    }
    if (current.revision !== proposal.baseRevision) {
      const conflicted: CanvasProposal = { ...proposal, status: 'conflicted', reviewedAt: nowIso(), reviewNote: options.note ?? ('Canvas revision changed from ' + proposal.baseRevision + ' to ' + current.revision) };
      const next: CanvasDoc = { ...current, proposals: current.proposals.map(item => item.id === proposal.id ? conflicted : item), updatedAt: nowIso() };
      await atomicWrite(filePath, JSON.stringify(parseCanvasDoc(next), null, 2) + '\n');
      return { doc: next, proposal: conflicted, conflicted: true };
    }
    const applied = applyCanvasOps(current, proposal.ops);
    const accepted: CanvasProposal = { ...proposal, status: 'accepted', reviewedAt: nowIso(), ...(options.note ? { reviewNote: options.note } : {}) };
    applied.doc.proposals = current.proposals.map(item => item.id === proposal.id ? accepted : item);
    const saved = await saveCanvasDocLocked(workDir, applied.doc, current.revision);
    await syncSceneFromDocLocked(workDir, saved);
    return { doc: saved, proposal: accepted };
  });
}

// ── Assets ───────────────────────────────────────────────────────────────────

export async function saveCanvasAsset(workDir: string, docId: string, data: Buffer, mediaType: string): Promise<{ asset: CanvasAsset; relativePath: string }> {
  if (data.length === 0) throw new CanvasValidationError('Asset is empty.');
  if (data.length > MAX_ASSET_BYTES) throw new CanvasValidationError('Asset exceeds ' + MAX_ASSET_BYTES + ' bytes.');
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' } as Record<string, string>)[mediaType] ?? 'bin';
  const sha256 = createHash('sha256').update(data).digest('hex');
  const fileName = sha256 + '.' + extension;
  const directory = canvasAssetsDir(workDir, docId);
  const filePath = path.join(directory, fileName);
  await mkdir(directory, { recursive: true });
  if (!(await exists(filePath))) await writeFile(filePath, data, { flag: 'wx' });
  return { asset: { mediaType, sha256, bytes: data.length }, relativePath: 'assets/' + assertCanvasDocId(docId) + '/' + fileName };
}

export async function readCanvasAsset(workDir: string, docId: string, fileName: string): Promise<{ data: Buffer; mediaType: string }> {
  if (!/^[a-z0-9]+.(png|jpg|webp|svg|bin)$/u.test(fileName)) throw new CanvasValidationError('Invalid asset name.');
  const filePath = path.join(canvasAssetsDir(workDir, docId), fileName);
  const data = await readFile(filePath);
  if (data.length > MAX_ASSET_BYTES) throw new CanvasValidationError('Asset exceeds ' + MAX_ASSET_BYTES + ' bytes.');
  const extension = fileName.split('.').pop() ?? 'bin';
  const mediaType = ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', bin: 'application/octet-stream' } as Record<string, string>)[extension] ?? 'application/octet-stream';
  return { data, mediaType };
}