import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';
import type { ResearchRun } from '../src/research/types.js';

it('executes the offline manifest through the authenticated GUI API, then reruns without changing criteria', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-research-api-'));
  const workDir = path.join(root, 'project');
  const homeDir = path.join(root, 'home');
  await mkdir(workDir); await mkdir(homeDir);
  const configPath = path.join(homeDir, 'settings.json');
  await writeFile(configPath, '{}');
  const server = await startHadamardGuiServer({ workDir, homeDir, configPath, port: 0 });
  const request = async (url: string, body?: unknown) => {
    const response = await fetch(server.url + url, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-hadamard-token': server.token, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const wait = async (id: string): Promise<ResearchRun> => {
    const startedAt = Date.now();
    const deadline = startedAt + 15000;
    let lastRun: ResearchRun | undefined;
    while (Date.now() < deadline) {
      const result = await request(`api/research/run?workspace=${encodeURIComponent(workDir)}&id=${id}`);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      lastRun = result.body.run;
      if (!['queued', 'running', 'validating'].includes(result.body.run.status)) return result.body.run;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Research run did not settle within 15 seconds: ${JSON.stringify({
      elapsedMs: Date.now() - startedAt, id, status: lastRun?.status, reason: lastRun?.reason,
      execution: lastRun?.execution, startedAt: lastRun?.startedAt, completedAt: lastRun?.completedAt,
    })}`);
  };
  try {
    expect((await fetch(`${server.url}api/research?workspace=${encodeURIComponent(workDir)}`)).status).toBe(403);
    const created = await request('api/research', {
      workspace: workDir, action: 'create', confirmed: true,
      manifest: { title: 'Offline scan', objective: 'Check five deterministic values',
        code: 'import json, pathlib\nxs = RESEARCH_PARAMETERS["xs"]\npathlib.Path("artifacts/metrics.json").write_text(json.dumps({"minimum": min((x-2)**2 for x in xs), "samples": len(xs)}))\nprint("scan complete")',
        parameters: { xs: [0, 1, 2, 3, 4] }, seeds: [7],
        acceptanceCriteria: [{ id: 'minimum', kind: 'numeric', artifact: 'metrics.json', path: 'minimum', expected: 0, tolerance: 0 }],
        budget: { timeoutMs: 10000, maxRuns: 3, maxArtifactBytes: 10000 },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const start = { workspace: workDir, action: 'start', confirmed: true, id: created.body.manifest.id, idempotencyKey: 'request-1' };
    const started = await request('api/research', start);
    expect(started.status).toBe(202);
    expect((await request('api/research', start)).status).toBe(409);
    const first = await wait(started.body.run.id);
    expect(first.status, first.reason || '').toBe('passed');
    expect(first.execution.stdout).toContain('scan complete');
    expect(first.validation.status).toBe('passed');
    expect(first.validation.criteria[0]?.observed).toBe(0);
    expect(first.artifacts).toHaveLength(1);
    const rerun = await request('api/research', { workspace: workDir, action: 'rerun', confirmed: true, id: first.id, idempotencyKey: 'request-2' });
    expect(rerun.status).toBe(202);
    const second = await wait(rerun.body.run.id);
    expect(second.status).toBe('passed');
    expect(second.id).not.toBe(first.id);
    expect(second.rerunOf).toBe(first.id);
    expect(second.manifestDigest).toBe(first.manifestDigest);
    expect(second.artifacts[0]?.sha256).toBe(first.artifacts[0]?.sha256);
    expect((await request('api/research', { ...start, workspace: root })).status).toBe(409);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
