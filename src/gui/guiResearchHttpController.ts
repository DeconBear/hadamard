import type { ResearchService } from '../research/index.js';
import { json, type GuiHttpRouter } from './guiHttpRouter.js';
import type { IncomingMessage } from 'node:http';

export interface GuiResearchHttpControllerOptions {
  /** Must reject stale workspace identities before any read or mutation. */
  service(workspace: string, execution?: boolean): Promise<ResearchService>;
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new Error('Research request exceeds 1 MiB');
    chunks.push(bytes);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object');
  return body as Record<string, unknown>;
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

/** Runs behind the GUI's existing loopback, Origin and per-process-token guard. */
export function registerGuiResearchHttpController(router: GuiHttpRouter, options: GuiResearchHttpControllerOptions): void {
  router.route('GET', '/api/research', async (_req, res, url) => {
    try {
      const workspace = required(url.searchParams.get('workspace'), 'workspace');
      const service = await options.service(workspace);
      const [manifests, runs] = await Promise.all([service.listManifests(), service.listRuns()]);
      json(res, 200, { workspace, manifests, runs });
    } catch (error) { json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
  });
  router.route('GET', '/api/research/run', async (_req, res, url) => {
    try {
      const service = await options.service(required(url.searchParams.get('workspace'), 'workspace'));
      const run = await service.getRun(required(url.searchParams.get('id'), 'id'));
      json(res, run ? 200 : 404, run ? { run } : { error: 'Run not found' });
    } catch (error) { json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
  });
  router.route('POST', '/api/research', async (req, res) => {
    try {
      const body = await bodyOf(req);
      const service = await options.service(required(body.workspace, 'workspace'), ['create', 'start', 'rerun'].includes(String(body.action)));
      if (body.action === 'create') {
        if (body.confirmed !== true) throw new Error('Pinning probes the configured Python environment; confirmation is required');
        const manifest = await service.createManifest(body.manifest as Parameters<ResearchService['createManifest']>[0]);
        return json(res, 201, { manifest });
      }
      if (body.action === 'start' || body.action === 'rerun') {
        if (body.confirmed !== true) throw new Error('Explicit execution confirmation is required');
        const id = required(body.id, 'id');
        const idempotencyKey = required(body.idempotencyKey, 'idempotencyKey');
        const run = body.action === 'start'
          ? await service.startRun(id, { idempotencyKey })
          : await service.rerun(id, { idempotencyKey });
        return json(res, 202, { run });
      }
      if (body.action === 'cancel') {
        const result = await service.cancel(required(body.id, 'id'));
        return json(res, 200, { result });
      }
      throw new Error('Unknown research action');
    } catch (error) { json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
  });
}
