import type {
  AgentTargetRef,
  HadamardRunEffort,
  ModelApi,
  RouterDecision,
  RouterProfile,
  RouterRoute,
} from '../types.js';
import { resolveTargetRef } from '../manager/resolveTargetRef.js';
import { classifyRoute } from './modelRouter.js';
import { buildRouteModelApi } from './routeModelApi.js';

/** Classify a turn and resolve its selected model/agent execution target. */
export async function resolveRoutedRun(
  profile: RouterProfile,
  userInput: string,
  signal?: AbortSignal,
  options: { homeDir?: string; projectDir?: string } = {},
): Promise<{
  model: string;
  modelApi: ModelApi;
  label: string;
  decision: RouterDecision;
  effort?: HadamardRunEffort;
}> {
  const decision = await classifyRoute(profile, userInput, signal);
  const targetRef: AgentTargetRef | undefined = decision.matched || !profile.fallback
    ? (decision.target as RouterRoute).target
    : profile.fallbackTarget;
  if (targetRef) {
    if (targetRef.kind === 'team') {
      throw new Error(`Router target "${targetRef.name}" is a team; team targets are not supported as router execution targets.`);
    }
    const resolved = resolveTargetRef(targetRef, {
      homeDir: options.homeDir,
      projectDir: options.projectDir,
    });
    const legacy = decision.target;
    const routed = await buildRouteModelApi({
      model: resolved.model ?? legacy.model,
      provider: resolved.provider ?? legacy.provider,
      baseURL: resolved.baseURL ?? legacy.baseURL,
      apiKey: resolved.apiKey ?? legacy.apiKey,
      maxTokens: legacy.maxTokens,
    });
    return {
      model: routed.model,
      modelApi: routed.modelApi,
      label: decision.label,
      decision,
      effort: decision.effort,
    };
  }
  const routed = await buildRouteModelApi(decision.target);
  return {
    model: routed.model,
    modelApi: routed.modelApi,
    label: decision.label,
    decision,
    effort: decision.effort,
  };
}
