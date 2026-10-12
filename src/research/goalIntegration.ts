import type { GoalService } from '../goal/goalService.js';
import type { GoalTurnOutcome } from '../goal/types.js';
import { researchGoalEvidence } from './service.js';
import { RESEARCH_TERMINAL_STATES, type ResearchRun } from './types.js';

/**
 * Trusted runtime hook for an explicitly associated Goal. Call from onRunSettled,
 * never from model-authored JSON. Idempotent by run ID. Does not complete a Goal
 * or its work items, and does not change ordinary Goal tool semantics.
 */
export async function settleResearchGoalRun(service: GoalService, run: ResearchRun, expectedGoalCreatedAt: string): Promise<void> {
  if (!RESEARCH_TERMINAL_STATES.has(run.status)) throw new Error('Research run has not settled');
  const goal = await service.read();
  if (!goal || goal.status !== 'active') return;
  const evidence = researchGoalEvidence(run);
  const outcome: GoalTurnOutcome = evidence.verified ? 'validated_progress'
    : run.validation.status === 'failed' ? 'validation_failed'
      : run.status === 'cancelled' ? 'interrupted'
        : run.status === 'blocked' ? 'wait' : 'failed';
  await service.recordValidationEvidence({
    expectedGoalCreatedAt,
    receipt: {
      id: `research-goal:${run.id}`, runId: run.id, at: run.completedAt || run.createdAt,
      outcome, evidenceRefs: evidence.verified && evidence.ref ? [evidence.ref] : [],
      validation: { status: evidence.verified ? 'passed' : run.validation.status === 'failed' ? 'failed' : 'not_applicable', reason: run.validation.summary },
      usage: { turns: 0, toolIterations: 0, tokens: 0 },
    },
    evidence: evidence.verified ? [evidence] : [],
  });
}
