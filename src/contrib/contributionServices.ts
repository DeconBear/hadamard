import type { AgentToolDefinition } from '../types.js';
import type { ResolvedProviderRetryPolicy } from '../provider/retryPolicy.js';
import { defineContributionServiceKey } from './contributionHost.js';

/**
 * Service keys and registries shared by the composition root and runtime
 * contributions. Values are Hadamard-owned interfaces so an embedding can
 * supply its own implementation without touching the host.
 */

export interface ContributionToolRegistry {
  add(tool: AgentToolDefinition): void;
  remove(name: string): boolean;
  list(): readonly AgentToolDefinition[];
}

export class InMemoryContributionToolRegistry implements ContributionToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();

  add(tool: AgentToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered in the contribution tool registry.`);
    }
    this.tools.set(tool.name, tool);
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  list(): readonly AgentToolDefinition[] {
    return [...this.tools.values()];
  }
}

/** Global tool registry contributions append into before agent assembly. */
export const contributionToolRegistryKey = defineContributionServiceKey<ContributionToolRegistry>(
  'hadamard.toolRegistry',
);

/** Cross-cutting request retry policy: contributions may override the resolved config value. */
export const contributionRetryPolicyKey = defineContributionServiceKey<ResolvedProviderRetryPolicy | undefined>(
  'hadamard.requestRetryPolicy',
);

