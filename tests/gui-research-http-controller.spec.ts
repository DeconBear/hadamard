import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { GuiHttpRouter } from '../src/gui/guiHttpRouter.js';
import { registerGuiResearchHttpController } from '../src/gui/guiResearchHttpController.js';
import type { ResearchService } from '../src/research/index.js';

function fixture() {
  const service = {
    listManifests: vi.fn(async () => [{ id: 'experiment' }]),
    listRuns: vi.fn(async () => [{ id: 'run', status: 'running' }]),
    getRun: vi.fn(async () => ({ id: 'run' })),
    createManifest: vi.fn(async () => ({ id: 'experiment' })),
    startRun: vi.fn(async () => ({ id: 'run' })),
    rerun: vi.fn(async () => ({ id: 'rerun' })),
    cancel: vi.fn(async () => true),
  };
  const router = new GuiHttpRouter();
  registerGuiResearchHttpController(router, {
    service: async workspace => {
      if (workspace !== '/project') throw new Error('Workspace changed');
      return service as unknown as ResearchService;
    },
  });
  const invoke = async (method: string, suffix = '', body?: unknown) => {
    const req = { method, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } } as unknown as IncomingMessage;
    let status = 0;
    let result: any;
    const res = { writeHead: (code: number) => { status = code; }, end: (raw: string) => { result = JSON.parse(raw); } } as unknown as ServerResponse;
    expect(await router.handle(req, res, new URL('http://localhost/api/research' + suffix))).toBe(true);
    return { status, body: result };
  };
  return { service, invoke };
}

describe('research HTTP controller', () => {
  it('reads canonical manifests and runs only for the current workspace', async () => {
    const { service, invoke } = fixture();
    expect((await invoke('GET', '?workspace=/project')).body.runs[0].status).toBe('running');
    expect((await invoke('GET', '?workspace=/old')).status).toBe(409);
    expect(service.listRuns).toHaveBeenCalledTimes(1);
  });
  it('requires explicit execution confirmation and an idempotency key', async () => {
    const { service, invoke } = fixture();
    const body = { workspace: '/project', action: 'start', id: 'experiment' };
    expect((await invoke('POST', '', body)).status).toBe(409);
    expect((await invoke('POST', '', { ...body, confirmed: true })).status).toBe(409);
    expect(service.startRun).not.toHaveBeenCalled();
    expect((await invoke('POST', '', { ...body, confirmed: true, idempotencyKey: 'request-1' })).status).toBe(202);
    expect(service.startRun).toHaveBeenCalledWith('experiment', { idempotencyKey: 'request-1' });
  });
  it('does not accept stale-workspace mutations or unconfirmed environment probes', async () => {
    const { service, invoke } = fixture();
    expect((await invoke('POST', '', { workspace: '/old', action: 'cancel', id: 'run' })).status).toBe(409);
    expect(service.cancel).not.toHaveBeenCalled();
    expect((await invoke('POST', '', { workspace: '/project', action: 'create', manifest: {} })).status).toBe(409);
    expect(service.createManifest).not.toHaveBeenCalled();
    expect((await invoke('POST', '', { workspace: '/project', action: 'create', confirmed: true, manifest: { title: 'Example' } })).status).toBe(201);
  });
  it('delegates cancellation and new-id reruns without rewriting criteria', async () => {
    const { service, invoke } = fixture();
    await invoke('POST', '', { workspace: '/project', action: 'cancel', id: 'run' });
    await invoke('POST', '', { workspace: '/project', action: 'rerun', id: 'run', confirmed: true, idempotencyKey: 'request-2', acceptanceCriteria: [] });
    expect(service.cancel).toHaveBeenCalledWith('run');
    expect(service.rerun).toHaveBeenCalledWith('run', { idempotencyKey: 'request-2' });
  });
  it('bounds manifest request bodies', async () => {
    const { service, invoke } = fixture();
    const response = await invoke('POST', '', { workspace: '/project', action: 'create', confirmed: true, code: 'x'.repeat(1024 * 1024) });
    expect(response.status).toBe(409);
    expect(service.createManifest).not.toHaveBeenCalled();
  });
});
