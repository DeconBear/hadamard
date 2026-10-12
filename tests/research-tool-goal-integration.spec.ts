import { describe, expect, it, vi } from 'vitest';
import { createResearchTools } from '../src/research/tools.js';
import { settleResearchGoalRun } from '../src/research/goalIntegration.js';
import type { ResearchService } from '../src/research/service.js';
import type { ResearchRun } from '../src/research/types.js';
import { GoalService } from '../src/goal/goalService.js';
import { settleGoalRun } from '../src/goal/goalController.js';
import type { Goal } from '../src/goal/types.js';
import type { AgentRunResult, ToolExecutionContext } from '../src/types.js';

function goalService() {
  let goal: Goal | undefined;
  return new GoalService({ port: { readGoalMetadata: () => goal, writeGoalMetadata: async next => { goal = next; } } });
}
const context: ToolExecutionContext = { runId: 'agent-run', cwd: '/project', prompt: '', iteration: 0, metadata: {} };
function settledRun(passed: boolean): ResearchRun {
  return {
    id: 'research-1', manifestId: 'manifest-1', manifestDigest: 'digest', status: passed ? 'passed' : 'failed',
    createdAt: '2026-10-12T00:00:00Z', completedAt: '2026-10-12T00:00:01Z',
    execution: { status: 'completed' },
    validation: { status: passed ? 'passed' : 'failed', summary: passed ? 'Pinned criteria passed' : 'Value differs', criteria: [] },
    artifacts: [],
  } as unknown as ResearchRun;
}

describe('research tools and Goal boundary', () => {
  it('keeps execution and environment probes behind normal permission checks', async () => {
    const tools = createResearchTools({} as ResearchService);
    for (const name of ['ResearchCreate', 'ResearchRun']) {
      const definition = tools.find(item => item.name === name)!;
      expect(definition.isReadOnly?.()).toBe(false);
      expect(await definition.checkPermissions?.({ mode: 'default', runId: 'r' })).toBe('ask');
      expect(await definition.checkPermissions?.({ mode: 'plan', runId: 'r' })).toBe('deny');
    }
    expect(tools.find(item => item.name === 'ResearchStatus')?.isReadOnly?.()).toBe(true);
  });
  it('rejects ambiguous run requests and propagates idempotency keys without criteria changes', async () => {
    const startRun = vi.fn(async () => ({ id: 'new-run', status: 'queued' }));
    const rerun = vi.fn(async () => ({ id: 'rerun', status: 'queued' }));
    const definition = createResearchTools({ startRun, rerun } as unknown as ResearchService).find(item => item.name === 'ResearchRun')!;
    await expect(definition.execute({ manifestId: 'm', rerunOf: 'r', idempotencyKey: 'key' }, context)).rejects.toThrow('exactly one');
    await definition.execute({ manifestId: 'm', idempotencyKey: 'key' }, context);
    expect(startRun).toHaveBeenCalledWith('m', { idempotencyKey: 'key' });
    await definition.execute({ rerunOf: 'r', idempotencyKey: 'key2' }, context);
    expect(rerun).toHaveBeenCalledWith('r', { idempotencyKey: 'key2' });
  });
  it('does not promote successful lifecycle operations to validated progress or completion', async () => {
    const service = goalService();
    await service.create({ objective: 'Research', completionCriteria: 'independent checks pass' });
    await service.requestWorkItemUpdate({ workItemId: 'goal-work:1', status: 'done', note: 'queued', evidenceRefs: ['tool:queued'], noFollowupReason: 'none' });
    await service.requestCompletion({ note: 'queued', evidenceRefs: ['tool:queued'] });
    await settleGoalRun(service, {
      runId: 'agent-run', completedAt: '2026-10-12T00:00:01Z', usage: {},
      toolCalls: [{ id: 'queued', name: 'ResearchRun', publicName: 'ResearchRun', isError: false, completedAt: '2026-10-12T00:00:01Z' }],
    } as unknown as AgentRunResult);
    const goal = (await service.read())!;
    expect(goal.status).toBe('active');
    expect(goal.delivery.validatedTurns).toBe(0);
    expect(goal.evidence).toEqual([]);
  });
  it('settles independently validated evidence once without completing the Goal', async () => {
    const service = goalService();
    await service.create({ objective: 'Research' });
    await settleResearchGoalRun(service, settledRun(true), (await service.read())!.createdAt);
    await settleResearchGoalRun(service, settledRun(true), (await service.read())!.createdAt);
    const goal = (await service.read())!;
    expect(goal.status).toBe('active');
    expect(goal.evidence).toHaveLength(1);
    expect(goal.evidence[0]?.verified).toBe(true);
    expect(goal.delivery.validatedTurns).toBe(1);
    expect(goal.consumption.turns).toBe(0);
  });
  it.each([true, false])('preserves pending completion/work requests on independent settlement (%s)', async passed => {
    const service = goalService();
    await service.create({ objective: 'Research', completionCriteria: 'checks pass' });
    const createdAt = (await service.read())!.createdAt;
    await service.requestWorkItemUpdate({ workItemId: 'goal-work:1', status: 'done', note: 'pending', evidenceRefs: ['research-run:research-1'], noFollowupReason: 'none' });
    await service.requestCompletion({ note: 'pending', evidenceRefs: ['research-run:research-1'] });
    const before = (await service.read())!;
    await settleResearchGoalRun(service, settledRun(passed), createdAt);
    const after = (await service.read())!;
    expect(after.status).toBe('active');
    expect(after.workItems).toEqual(before.workItems);
    expect(after.workItemRequests).toEqual(before.workItemRequests);
    expect(after.completionRequest).toEqual(before.completionRequest);
  });
  it('rejects evidence when the originally associated Goal has been replaced', async () => {
    const service = goalService();
    await service.create({ objective: 'New goal' });
    await settleResearchGoalRun(service, settledRun(true), '2000-01-01T00:00:00Z');
    expect((await service.read())!.evidence).toEqual([]);
  });
  it('does not offer failed research evidence as a completion reference', async () => {
    const service = goalService();
    await service.create({ objective: 'Research' });
    await settleResearchGoalRun(service, settledRun(false), (await service.read())!.createdAt);
    const goal = (await service.read())!;
    expect(goal.evidence).toHaveLength(0);
    expect(goal.turnReceipts.at(-1)?.outcome).toBe('validation_failed');
    expect(goal.delivery.validatedTurns).toBe(0);
  });
});
