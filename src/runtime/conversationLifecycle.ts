import { HadamardSdkError } from '../errors.js';
import type { HadamardLifecycleEvent, TypedHookOutput } from '../hooks/hookTypes.js';
import { nowIso } from './helpers.js';
import type {
  ConversationInputOptions,
  ConversationLifecycleOptions,
  ConversationPersistenceOptions,
  ConversationRuntimeDependencies,
} from './conversationPorts.js';

type ConversationLifecycleContext = ConversationLifecycleOptions
  & Pick<ConversationInputOptions, 'runId' | 'sessionId' | 'signal'>
  & Pick<ConversationPersistenceOptions, 'sessionWorkDir'>
  & Pick<ConversationRuntimeDependencies, 'config'>;

export async function runTypedLifecycleHooks(
  options: ConversationLifecycleContext,
  event: HadamardLifecycleEvent,
  payload: Record<string, unknown>,
  toolName?: string,
): Promise<TypedHookOutput[]> {
  if (!options.typedHookRunner) return [];
  const outputs = await options.typedHookRunner.run({
    event,
    runId: options.runId,
    sessionId: options.sessionId,
    cwd: options.sessionWorkDir ?? options.config.workDir,
    toolName,
    payload,
    signal: options.signal,
  });
  if (outputs.length > 0) {
    options.emit?.({
      type: 'hook.lifecycle',
      runId: options.runId,
      sessionId: options.sessionId,
      lifecycleEvent: event,
      outputs,
      timestamp: nowIso(),
    });
  }
  return outputs;
}

export async function requireLifecycleContinue(
  options: ConversationLifecycleContext,
  event: HadamardLifecycleEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const outputs = await runTypedLifecycleHooks(options, event, payload);
  if (hasLifecycleBlock(outputs)) {
    throw new HadamardSdkError(lifecycleBlockReason(event, outputs));
  }
}

export function hasLifecycleBlock(outputs: TypedHookOutput[]): boolean {
  return outputs.some(output => output.behavior === 'block');
}

export function lifecycleBlockReason(
  event: HadamardLifecycleEvent,
  outputs: TypedHookOutput[],
): string {
  const blocked = outputs.find(output => output.behavior === 'block');
  return blocked?.feedback
    ? `${event} hook "${blocked.hookId}" blocked: ${blocked.feedback}`
    : `${event} hook "${blocked?.hookId ?? 'unknown'}" blocked.`;
}
