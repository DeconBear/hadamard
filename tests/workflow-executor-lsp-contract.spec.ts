import { realpath as realpathCallback } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LocalIsolatedProcessWorkflowExecutor,
  TrustedCompatibilityWorkflowExecutor,
  WorkflowAbortedError,
  WorkflowExecutionError,
  type TrustedWorkflowExecutionRequest,
  type UntrustedWorkflowExecutionRequest,
  type WorkflowExecutionRequest,
  type WorkflowExecutionResult,
} from '../src/workflow-v2/index.js';

const realpathNative = promisify(realpathCallback.native);

interface WorkflowExecutorContractHarness {
  name: string;
  trust: 'trusted' | 'untrusted';
  execute(request: WorkflowExecutionRequest): Promise<WorkflowExecutionResult>;
  request(source: string, signal?: AbortSignal): WorkflowExecutionRequest;
}

function workflowExecutorContract(harness: WorkflowExecutorContractHarness): void {
  describe(`Workflow executor LSP contract: ${harness.name}`, () => {
    it('executes the canonical JSON input/output contract', async () => {
      const result = await harness.execute(harness.request(
        'async ({ input }) => ({ echoed: input, stable: true })',
      ));
      expect(result).toMatchObject({
        value: { echoed: null, stable: true },
        trust: harness.trust,
        capabilityCalls: 0,
      });
      expect(result.executor).toBeTruthy();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('rejects empty source through the shared execution error contract', async () => {
      await expect(harness.execute(harness.request('   '))).rejects.toBeInstanceOf(WorkflowExecutionError);
    });

    it('honors a pre-aborted caller signal', async () => {
      const controller = new AbortController();
      controller.abort(new Error('contract abort'));
      await expect(harness.execute(harness.request('async () => null', controller.signal)))
        .rejects.toBeInstanceOf(WorkflowAbortedError);
    });
  });
}

let workspaceDir: string;

beforeAll(async () => {
  workspaceDir = await realpathNative(await mkdtemp(path.join(os.tmpdir(), 'workflow-lsp-contract-')));
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

const trusted = new TrustedCompatibilityWorkflowExecutor();
workflowExecutorContract({
  name: trusted.kind,
  trust: 'trusted',
  execute: request => trusted.execute(request as TrustedWorkflowExecutionRequest),
  request: (source, signal) => ({ trust: 'trusted', source, signal }),
});

const isolated = new LocalIsolatedProcessWorkflowExecutor();
workflowExecutorContract({
  name: isolated.kind,
  trust: 'untrusted',
  execute: request => isolated.execute(request as UntrustedWorkflowExecutionRequest),
  request: (source, signal) => ({ trust: 'untrusted', source, signal, workspaceDir }),
});
