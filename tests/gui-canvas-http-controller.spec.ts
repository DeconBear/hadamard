import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCanvasDoc, createCanvasProposal, readCanvasDoc } from '../src/canvas/store.js';
import { GuiHttpRouter } from '../src/gui/guiHttpRouter.js';
import { registerGuiCanvasHttpController } from '../src/gui/guiCanvasHttpController.js';

let root: string;
let workDir: string;
let moduleEnabled: boolean;
let router: GuiHttpRouter;

function request(method: string, body?: unknown): IncomingMessage {
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  } as unknown as IncomingMessage;
}
type CapturedResponse = ServerResponse & {
  status?: number;
  headers?: Record<string, string | number>;
  body?: string | Buffer;
};
function response(): CapturedResponse {
  const res = {
    status: undefined as number | undefined,
    headers: undefined as Record<string, string | number> | undefined,
    body: undefined as string | Buffer | undefined,
    writeHead(status: number, headers: Record<string, string | number>) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    end(body?: string | Buffer) {
      res.body = body;
      return res;
    },
  };
  return res as unknown as CapturedResponse;
}
async function call(method: string, pathname: string, body?: unknown) {
  const res = response();
  const matched = await router.handle(request(method, body), res, new URL('http://localhost' + pathname));
  return { matched, res };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hadamard-canvas-http-'));
  workDir = path.join(root, 'project');
  await import('node:fs/promises').then(fs => fs.mkdir(workDir, { recursive: true }));
  moduleEnabled = false;
  router = new GuiHttpRouter();
  registerGuiCanvasHttpController(router, {
    isModuleEnabled: async () => moduleEnabled,
    resolveProjectPath: async () => workDir,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GUI canvas HTTP controller', () => {
  it('answers 404 while the canvas module is not loaded', async () => {
    const { res } = await call('GET', '/api/canvas/list?projectPath=' + encodeURIComponent(workDir));
    expect(res.status).toBe(404);
    expect(String(res.body)).toContain('Canvas module is not loaded');
  });

  it('creates, reads, lists, imports, exports and mutates a canvas when enabled', async () => {
    moduleEnabled = true;
    const projectQuery = '?projectPath=' + encodeURIComponent(workDir);
    const created = await call('POST', '/api/canvas/create', { projectPath: workDir, title: 'GUI canvas', template: 'ai-model-transformer' });
    expect(created.res.status).toBe(200);
    const createdBody = JSON.parse(String(created.res.body));
    expect(createdBody.doc.title).toBe('GUI canvas');
    const docId = createdBody.doc.id;

    const list = await call('GET', '/api/canvas/list' + projectQuery);
    expect(list.res.status).toBe(200);
    expect(JSON.parse(String(list.res.body)).documents).toHaveLength(1);

    const read = await call('GET', '/api/canvas/get' + projectQuery + '&docId=' + docId);
    expect(read.res.status).toBe(200);
    const readBody = JSON.parse(String(read.res.body));
    expect(readBody.doc.revision).toBe(0);
    expect(Object.keys(readBody.shapes).length).toBeGreaterThan(0);

    const ops = await call('POST', '/api/canvas/ops', {
      projectPath: workDir,
      docId,
      baseRevision: 0,
      ops: [{ op: 'update_node', nodeId: readBody.doc.nodes[0].id, patch: { text: 'Renamed input' } }],
    });
    expect(ops.res.status).toBe(200);
    expect(JSON.parse(String(ops.res.body)).doc.revision).toBe(1);

    const conflict = await call('POST', '/api/canvas/ops', {
      projectPath: workDir, docId, baseRevision: 0,
      ops: [{ op: 'delete_node', nodeId: readBody.doc.nodes[0].id }],
    });
    expect(conflict.res.status).toBe(409);

    const exported = await call('GET', '/api/canvas/export' + projectQuery + '&docId=' + docId + '&format=mermaid');
    expect(exported.res.status).toBe(200);
    expect(String(exported.res.body)).toContain('flowchart TD');

    const imported = await call('POST', '/api/canvas/import', {
      projectPath: workDir, title: 'Imported flow', format: 'mermaid',
      content: 'flowchart TD\n  A[Input] --> B[Output]',
    });
    expect(imported.res.status).toBe(200);
    expect(JSON.parse(String(imported.res.body)).doc.nodes).toHaveLength(2);

    const badImport = await call('POST', '/api/canvas/import', { projectPath: workDir, title: 'Bad', format: 'bogus', content: 'x' });
    expect(badImport.res.status).toBe(400);

    const kinds = await call('GET', '/api/canvas/kinds');
    expect(kinds.res.status).toBe(200);
    expect(JSON.parse(String(kinds.res.body)).packs[0].id).toBe('ai.model');
  });

  it('accepts proposals through the API', async () => {
    moduleEnabled = true;
    const doc = await createCanvasDoc(workDir, { title: 'Proposal API', packIds: ['ai.model'] });
    const proposal = await createCanvasProposal(workDir, doc.id, {
      intent: 'Add node',
      ops: [{ op: 'create_node', node: { id: 'p1', kind: 'ai.tensor', bounds: { x: 0, y: 0, w: 100, h: 60 }, z: 0, text: 'p1', data: { shape: ['batch', 4] } } }],
    });
    const accepted = await call('POST', '/api/canvas/proposal', {
      projectPath: workDir, docId: doc.id, proposalId: proposal.proposal.id, action: 'accept',
    });
    expect(accepted.res.status).toBe(200);
    expect(JSON.parse(String(accepted.res.body)).proposal.status).toBe('accepted');
    const after = await readCanvasDoc(workDir, doc.id);
    expect(after.nodes.map(node => node.id)).toEqual(['p1']);
  });

  it('rejects unknown project paths and malformed bodies without writing', async () => {
    const router2 = new GuiHttpRouter();
    registerGuiCanvasHttpController(router2, {
      isModuleEnabled: async () => true,
      resolveProjectPath: async () => undefined,
    });
    const res = response();
    await router2.handle(request('GET'), res, new URL('http://localhost/api/canvas/list?projectPath=' + encodeURIComponent(workDir)));
    expect(res.status).toBe(400);
  });
});
