import { resolveTargetRef } from '../manager/resolveTargetRef.js';
import type { AgentTargetRef, TeamDefinition } from '../types.js';
import { loadTeamDefinition } from './teamDefinitions.js';

export interface ResolveExecutorTargetOptions {
  projectDir: string;
  homeDir?: string;
  loadTeam?: (name: string, projectDir: string) => TeamDefinition | null;
}

export type ResolvedExecutorTarget =
  | { kind: 'team'; name: string; definition: TeamDefinition }
  | ({ kind: 'model' | 'agent' } & ReturnType<typeof resolveTargetRef>);

/** Resolve the four Agents-page executor choices through one runtime contract. */
export function resolveExecutorTarget(
  ref: Extract<AgentTargetRef, { kind: 'team' }>,
  options: ResolveExecutorTargetOptions,
): Extract<ResolvedExecutorTarget, { kind: 'team' }>;
export function resolveExecutorTarget(
  ref: Exclude<AgentTargetRef, { kind: 'team' }>,
  options: ResolveExecutorTargetOptions,
): Exclude<ResolvedExecutorTarget, { kind: 'team' }>;
export function resolveExecutorTarget(
  ref: AgentTargetRef,
  options: ResolveExecutorTargetOptions,
): ResolvedExecutorTarget {
  if (ref.kind === 'team') {
    const name = ref.name.trim();
    const definition = options.loadTeam
      ? options.loadTeam(name, options.projectDir)
      : loadTeamDefinition(name, options.projectDir, options.homeDir)?.definition ?? null;
    if (!definition) throw new Error(`team "${name}" not found`);
    return { kind: 'team', name, definition };
  }
  return { kind: ref.kind, ...resolveTargetRef(ref, options) };
}
