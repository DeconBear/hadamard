/**
 * Gui canvas HTTP controller. Every route is gated by the canvas module: when
 * the module is not loaded the API answers 404 and the client hides the tab.
 */
import { CANVAS_PACKS, analyzeAiModel, validateCanvas } from '../canvas/index.js';
import { createAiModelTemplate } from '../canvas/packs/aiModel.js';
import { exportPackArtifact } from '../canvas/packs/index.js';
import { fromJsonCanvas, fromMermaid, toJsonCanvas, toMarkdownOutline, toMermaid, toSvg } from '../canvas/serialize.js';
import { parseExcalidrawScene, sceneFromDoc } from '../canvas/excalidrawScene.js';
import {
  CanvasNotFoundError,
  CanvasRevisionConflictError,
  applyCanvasOpsToDoc,
  createCanvasDoc,
  deleteCanvasDoc,
  listCanvasDocs,
  readCanvasAsset,
  readCanvasDoc,
  readCanvasScene,
  resolveCanvasProposal,
  saveCanvasAsset,
  saveCanvasScene,
} from '../canvas/store.js';
import { createEmptyCanvasDoc, CanvasValidationError } from '../canvas/types.js';
import { bytes, json, readJson, text, type GuiHttpRouter } from './guiHttpRouter.js';

export interface GuiCanvasHttpControllerPort {
  isModuleEnabled(): Promise<boolean>;
  resolveProjectPath(rawPath: string | null | undefined): Promise<string | undefined>;
  mutationError?(error: unknown): { status: number; body: unknown };
}

function errorStatus(error: unknown): number {
  if (error instanceof CanvasNotFoundError) return 404;
  if (error instanceof CanvasRevisionConflictError) return 409;
  if (error instanceof CanvasValidationError) return 400;
  if (error instanceof SyntaxError) return 400;
  return 500;
}

function errorBody(error: unknown): Record<string, unknown> {
  if (error instanceof CanvasRevisionConflictError) {
    return { error: error.message, code: 'revision-conflict', currentRevision: error.currentRevision, expectedRevision: error.expectedRevision };
  }
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof CanvasNotFoundError ? { code: 'not-found' } : {}),
    ...(error instanceof CanvasValidationError ? { code: 'invalid' } : {}),
  };
}

function snapshot(doc: Awaited<ReturnType<typeof readCanvasDoc>>) {
  const analysis = analyzeAiModel(doc);
  return { doc, shapes: analysis.shapes, checks: validateCanvas(doc) };
}

export function registerGuiCanvasHttpController(
  router: GuiHttpRouter,
  port: GuiCanvasHttpControllerPort,
): void {
  const guard = async (res: Parameters<typeof json>[0]): Promise<boolean> => {
    if (await port.isModuleEnabled()) return false;
    json(res, 404, { error: 'Canvas module is not loaded. Enable it in Settings -> Personalization -> Modules.' });
    return true;
  };
  const projectPath = async (raw: string | null): Promise<string> => {
    const resolved = await port.resolveProjectPath(raw);
    if (!resolved) throw new CanvasValidationError('Unknown project path.');
    return resolved;
  };

  router.route('GET', '/api/canvas/list', async (req, res, url) => {
    if (await guard(res)) return;
    try {
      const workDir = await projectPath(url.searchParams.get('projectPath'));
      const result = await listCanvasDocs(workDir);
      json(res, 200, { ok: true, workDir, ...result });
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('GET', '/api/canvas/kinds', async (req, res) => {
    if (await guard(res)) return;
    json(res, 200, {
      ok: true,
      packs: CANVAS_PACKS.map(pack => ({
        id: pack.id,
        title: pack.title,
        nodeKinds: pack.nodeKinds,
        edgeKinds: pack.edgeKinds,
        ...(pack.promptHints ? { promptHints: pack.promptHints } : {}),
      })),
    });
  });

  router.route('POST', '/api/canvas/create', async (req, res) => {
    if (await guard(res)) return;
    try {
      const body = await readJson(req);
      const workDir = await projectPath(typeof body.projectPath === 'string' ? body.projectPath : null);
      const title = typeof body.title === 'string' ? body.title : '';
      const template = body.template === 'ai-model-transformer' ? 'ai-model-transformer' : 'blank-design';
      const initialDoc = template === 'ai-model-transformer'
        ? createAiModelTemplate('pending', title || 'AI model')
        : { ...createEmptyCanvasDoc({ id: 'blank', projectId: 'blank', title: title || 'Untitled canvas', packIds: [] }), frames: [] };
      const doc = await createCanvasDoc(workDir, {
        title: title || 'Untitled canvas',
        packIds: template === 'ai-model-transformer' ? ['ai.model'] : [],
        template,
        ...(initialDoc ? { initialDoc } : {}),
      });
      json(res, 200, { ok: true, ...snapshot(doc) });
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('POST', '/api/canvas/import', async (req, res) => {
    if (await guard(res)) return;
    try {
      const body = await readJson(req);
      const workDir = await projectPath(typeof body.projectPath === 'string' ? body.projectPath : null);
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Imported canvas';
      const format = body.format === 'json-canvas' ? 'json-canvas' : body.format === 'mermaid' ? 'mermaid' : undefined;
      if (!format) throw new SyntaxError('format must be json-canvas or mermaid');
      if (typeof body.content !== 'string' || !body.content.trim()) throw new SyntaxError('content is required');
      const base = { id: 'import', projectId: 'import', title };
      const initialDoc = format === 'json-canvas'
        ? fromJsonCanvas(JSON.parse(body.content) as unknown, base)
        : fromMermaid(body.content, base);
      const doc = await createCanvasDoc(workDir, { title, packIds: ['ai.model'], initialDoc });
      json(res, 200, { ok: true, ...snapshot(doc) });
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('GET', '/api/canvas/scene', async (req, res, url) => {
    if (await guard(res)) return;
    try {
      const workDir = await projectPath(url.searchParams.get('projectPath'));
      const docId = url.searchParams.get('docId') ?? '';
      const doc = await readCanvasDoc(workDir, docId);
      const scene = (await readCanvasScene(workDir, docId)) ?? sceneFromDoc(doc);
      json(res, 200, { ok: true, doc, scene, checks: validateCanvas(doc) });
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('POST', '/api/canvas/scene', async (req, res) => {
    if (await guard(res)) return;
    try {
      const body = await readJson(req);
      const workDir = await projectPath(typeof body.projectPath === 'string' ? body.projectPath : null);
      const docId = typeof body.docId === 'string' ? body.docId : '';
      const baseRevision = typeof body.baseRevision === 'number' ? body.baseRevision : undefined;
      const scene = parseExcalidrawScene(body.scene);
      const saved = await saveCanvasScene(workDir, docId, scene, {
        ...(baseRevision !== undefined ? { expectedRevision: baseRevision } : {}),
      });
      const analysis = snapshot(saved.doc);
      json(res, 200, { ok: true, ...analysis, scene: saved.scene });
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('GET', '/api/canvas/get', async (req, res, url) => {
    if (await guard(res)) return;
    try {
      const workDir = await projectPath(url.searchParams.get('projectPath'));
      const docId = url.searchParams.get('docId') ?? '';
      const doc = await readCanvasDoc(workDir, docId);
      const analysis = analyzeAiModel(doc);
      json(res, 200, { ok: true, doc, shapes: analysis.shapes, checks: analysis.checks.length ? analysis.checks : [] });
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('POST', '/api/canvas/ops', async (req, res) => {
    if (await guard(res)) return;
    try {
      const body = await readJson(req);
      const workDir = await projectPath(typeof body.projectPath === 'string' ? body.projectPath : null);
      const docId = typeof body.docId === 'string' ? body.docId : '';
      const baseRevision = typeof body.baseRevision === 'number' ? body.baseRevision : undefined;
      const result = await applyCanvasOpsToDoc(workDir, docId, body.ops, {
        ...(baseRevision !== undefined ? { expectedRevision: baseRevision } : {}),
        actor: 'user',
      });
      const analysis = analyzeAiModel(result.doc);
      json(res, 200, { ok: true, doc: result.doc, summary: result.summary, shapes: analysis.shapes, checks: analysis.checks });
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('POST', '/api/canvas/proposal', async (req, res) => {
    if (await guard(res)) return;
    try {
      const body = await readJson(req);
      const workDir = await projectPath(typeof body.projectPath === 'string' ? body.projectPath : null);
      const docId = typeof body.docId === 'string' ? body.docId : '';
      const proposalId = typeof body.proposalId === 'string' ? body.proposalId : '';
      const action = body.action === 'accept' ? 'accept' : body.action === 'reject' ? 'reject' : undefined;
      if (!action) throw new SyntaxError('action must be accept or reject');
      const result = await resolveCanvasProposal(workDir, docId, proposalId, action, {
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
      });
      const analysis = analyzeAiModel(result.doc);
      json(res, 200, { ok: true, doc: result.doc, proposal: result.proposal, conflicted: result.conflicted === true, shapes: analysis.shapes, checks: analysis.checks });
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('GET', '/api/canvas/export', async (req, res, url) => {
    if (await guard(res)) return;
    try {
      const workDir = await projectPath(url.searchParams.get('projectPath'));
      const docId = url.searchParams.get('docId') ?? '';
      const format = url.searchParams.get('format') ?? 'mermaid';
      const doc = await readCanvasDoc(workDir, docId);
      let content: string;
      let extension = 'txt';
      if (format === 'json-canvas') { content = JSON.stringify(toJsonCanvas(doc), null, 2); extension = 'canvas'; }
      else if (format === 'markdown') { content = toMarkdownOutline(doc); extension = 'md'; }
      else if (format === 'svg') { content = toSvg(doc); extension = 'svg'; }
      else if (format === 'pytorch') { content = exportPackArtifact(doc, 'pytorch') ?? ''; extension = 'py'; }
      else { content = exportPackArtifact(doc, 'mermaid') ?? toMermaid(doc); extension = 'mmd'; }
      if (format === 'json-canvas') {
        json(res, 200, { ok: true, fileName: doc.id + '.canvas', content });
        return;
      }
      const contentType = format === 'markdown' ? 'text/markdown' : format === 'pytorch' ? 'text/x-python' : format === 'svg' ? 'image/svg+xml' : 'text/plain';
      text(res, 200, content, contentType);
      void extension;
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('GET', '/api/canvas/asset', async (req, res, url) => {
    if (await guard(res)) return;
    try {
      const workDir = await projectPath(url.searchParams.get('projectPath'));
      const docId = url.searchParams.get('docId') ?? '';
      const name = url.searchParams.get('name') ?? '';
      const asset = await readCanvasAsset(workDir, docId, name);
      bytes(res, 200, asset.data, asset.mediaType);
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('POST', '/api/canvas/asset', async (req, res) => {
    if (await guard(res)) return;
    try {
      const body = await readJson(req);
      const workDir = await projectPath(typeof body.projectPath === 'string' ? body.projectPath : null);
      const docId = typeof body.docId === 'string' ? body.docId : '';
      const mediaType = typeof body.mediaType === 'string' ? body.mediaType : '';
      if (typeof body.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(body.contentBase64)) throw new SyntaxError('contentBase64 is required');
      const data = Buffer.from(body.contentBase64, 'base64');
      const saved = await saveCanvasAsset(workDir, docId, data, mediaType);
      json(res, 200, { ok: true, ...saved });
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });

  router.route('DELETE', '/api/canvas', async (req, res, url) => {
    if (await guard(res)) return;
    try {
      const workDir = await projectPath(url.searchParams.get('projectPath'));
      const docId = url.searchParams.get('docId') ?? '';
      await deleteCanvasDoc(workDir, docId);
      json(res, 200, { ok: true });
    } catch (error) { json(res, errorStatus(error), errorBody(error)); }
  });
}
