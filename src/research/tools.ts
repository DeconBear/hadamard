import { z } from 'zod';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import type { ResearchService } from './service.js';
import type { ResearchManifestInput } from './types.js';

/** Opt-in tools bound to one workspace service; register through the normal permission pipeline. */
export function createResearchTools(service: ResearchService): AgentToolDefinition[] {
  const read = { isReadOnly: () => true, isConcurrencySafe: () => true };
  const execute = {
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: ({ mode }: { mode: string }) => mode === 'plan' ? 'deny' as const : 'ask' as const,
  };
  return [
    tool({ name: 'ResearchList', description: 'List immutable experiment manifests and canonical run states for this workspace. Operational observation, not scientific validation.', inputSchema: z.object({}).strict(), ...read }, async () => ({ manifests: await service.listManifests(), runs: await service.listRuns() })),
    tool({ name: 'ResearchStatus', description: 'Read a recorded research run, including independent criteria results and artifact digests. Do not treat command completion or these tool calls as scientific proof.', inputSchema: z.object({ runId: z.string().min(1) }).strict(), ...read }, async ({ runId }) => {
      const run = await service.getRun(runId);
      if (!run) throw new Error('Research run not found');
      return run;
    }),
    tool({ name: 'ResearchCreate', description: 'Pin an immutable Python experiment manifest. Runs a metadata-only CodeAct environment probe. Requires title, objective, code, acceptanceCriteria and optional inputs, parameters, seeds, environment and budget. Does not execute experiment code. Process backend is trusted-only.', inputSchema: z.object({ manifest: z.record(z.string(), z.json()) }).strict(), ...execute }, async ({ manifest }, context) => {
      context.signal?.throwIfAborted();
      return service.createManifest(manifest as unknown as ResearchManifestInput);
    }),
    tool({ name: 'ResearchRun', description: 'Start a pinned experiment or explicitly rerun an old run in a fresh execution namespace. Returns queued state, never proof of success. Poll ResearchStatus, cancel with ResearchCancel. No automatic external host tools. Process mode executes trusted Python on the host. Reuse the same idempotency key only when retrying the same request; duplicate keys are rejected.', inputSchema: z.object({ manifestId: z.string().optional(), rerunOf: z.string().optional(), idempotencyKey: z.string().min(1).max(200) }).strict(), ...execute }, async (input, context) => {
      context.signal?.throwIfAborted();
      if (Boolean(input.manifestId) === Boolean(input.rerunOf)) throw new Error('Supply exactly one of manifestId or rerunOf');
      return input.rerunOf
        ? service.rerun(input.rerunOf, { idempotencyKey: input.idempotencyKey })
        : service.startRun(input.manifestId!, { idempotencyKey: input.idempotencyKey });
    }),
    tool({ name: 'ResearchCancel', description: 'Cancel a queued or active research run; preserve its record and artifacts. Read ResearchStatus for final settlement.', inputSchema: z.object({ runId: z.string().min(1) }).strict(), isReadOnly: () => false, isConcurrencySafe: () => true }, async ({ runId }) => ({ cancelled: await service.cancel(runId) })),
  ];
}
