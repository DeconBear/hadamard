/**
 * Central resolver for the unified reference model (`AgentTargetRef`).
 *
 * Persisted schemas (router routes, graph/workflow nodes, …) store a typed
 * reference instead of a copied provider/baseURL/apiKey snapshot. At runtime a
 * ref is expanded here — bridge configs by name, agent profiles by name (which
 * themselves reference a bridge config by name). `$ENV_VAR` apiKey references
 * are NOT resolved here: the returned `apiKey` is passed through verbatim so
 * downstream builders (`buildRouteModelApi`) keep owning env resolution.
 *
 * A missing target throws `BrokenReferenceError` carrying the target kind and
 * name so callers can surface a precise "broken reference" message.
 */
import type { AgentTargetRef } from '../types.js';
import { findBridgeConfig } from '../parity/bridgeConfigs.js';
import { findAgentProfile, type AgentProfile } from '../config/agentProfiles.js';
import {
  agentDefinitionToProfile,
  readStoredAgentDefinition,
} from '../config/agentDefinitionMigration.js';
import type { HadamardAgentDefinition } from '../types.js';
import { loadTeamDefinition } from '../team/teamDefinitions.js';

/** Target kinds an `AgentTargetRef` (or a legacy name reference) can point at. */
export type BrokenReferenceKind = 'config' | 'agent' | 'team' | 'router';

export class BrokenReferenceError extends Error {
  readonly kind: BrokenReferenceKind;
  /** Name of the missing target (config / agent profile / team / router). */
  readonly targetName: string;

  constructor(kind: BrokenReferenceKind, targetName: string, message?: string) {
    super(message ?? `Broken reference: ${kind} "${targetName}" does not exist`);
    this.name = 'BrokenReferenceError';
    this.kind = kind;
    this.targetName = targetName;
  }
}

/** The expansion of an `AgentTargetRef` into runnable connection parameters. */
export interface ResolvedTargetRef {
  /**
   * Concrete model id. Absent for `team` targets — a team runs its own member
   * models; callers that need a single model must reject team refs.
   */
  model?: string;
  provider?: 'anthropic' | 'openai';
  baseURL?: string;
  /** Raw apiKey from the referenced config; may be a `$ENV_VAR` reference. */
  apiKey?: string;
  /** Human-readable label for UI/status surfaces. */
  label: string;
  /** Present for Agent refs so every execution surface can apply its options. */
  agentProfile?: AgentProfile;
  /** Project/personal definition, including inherit-session-model Agents. */
  agentDefinition?: HadamardAgentDefinition;
}

export interface ResolveTargetRefContext {
  /** OS home / data-root input, same semantics as the storage loaders. */
  homeDir?: string;
  /** Project directory for project-scoped teams. */
  projectDir?: string;
  /**
   * Known team names. When provided, team existence is checked against this
   * list instead of hitting the disk loaders (used by the reference index and
   * tests).
   */
  teamNames?: readonly string[];
}

/**
 * Expand an `AgentTargetRef` into connection parameters.
 *
 * - `model` with a non-empty `config`: the named bridge config must exist; its
 *   provider/baseURL/apiKey are inherited, the ref's `model` selects the model.
 * - `model` with `config: ''` (raw legacy ref): only the model id is known —
 *   the caller falls back to legacy sibling fields or session defaults.
 * - `agent`: the named agent profile must exist, and so must the bridge config
 *   it references (a missing config is reported as a `config` broken ref).
 * - `team`: the named team definition must exist; no model is expanded.
 */
export function resolveTargetRef(
  ref: AgentTargetRef,
  ctx: ResolveTargetRefContext = {},
): ResolvedTargetRef {
  switch (ref.kind) {
    case 'model': {
      if (!ref.config) {
        return { model: ref.model, label: ref.model };
      }
      const config = findBridgeConfig(ref.config, ctx.homeDir);
      if (!config) throw new BrokenReferenceError('config', ref.config);
      return {
        model: ref.model,
        provider: config.provider,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        label: `${ref.config} · ${ref.model}`,
      };
    }
    case 'agent': {
      const definition = readStoredAgentDefinition(ref.name, ctx.homeDir, ctx.projectDir);
      const profile = definition
        ? agentDefinitionToProfile(definition)
        : findAgentProfile(ref.name, ctx.homeDir);
      if (!profile && !definition) throw new BrokenReferenceError('agent', ref.name);
      if (!profile) {
        return {
          model: definition?.model,
          label: ref.name,
          agentDefinition: definition ?? undefined,
        };
      }
      const config = findBridgeConfig(profile.bridgeConfig, ctx.homeDir);
      if (!config) throw new BrokenReferenceError('config', profile.bridgeConfig);
      return {
        model: profile.model,
        provider: config.provider,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        label: profile.name,
        agentProfile: profile,
        agentDefinition: definition ?? undefined,
      };
    }
    case 'team': {
      const exists = ctx.teamNames
        ? ctx.teamNames.includes(ref.name)
        : loadTeamDefinition(ref.name, ctx.projectDir, ctx.homeDir) !== null;
      if (!exists) throw new BrokenReferenceError('team', ref.name);
      return { label: `team:${ref.name}` };
    }
  }
}
