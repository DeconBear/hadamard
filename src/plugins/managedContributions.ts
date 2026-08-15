import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { ResolvedProviderRetryPolicy } from '../provider/retryPolicy.js';
import { createExaSearchTool } from '../tools/exaSearch.js';
import { createTavilySearchTool } from '../tools/tavilySearch.js';
import {
  contributionRetryPolicyKey,
  contributionToolRegistryKey,
} from '../contrib/contributionServices.js';
import { HadamardSdkError } from '../errors.js';
import type { ContributionApplyContext, HadamardRuntimeContribution } from '../contrib/contributionHost.js';
import { readStoredManagedPluginConfig } from './managedPluginCatalog.js';

/**
 * Built-in pilot contributions: the read-only search providers (Tavily/Exa)
 * and the cross-cutting request retry policy, contributed through the
 * runtime contribution host instead of the central managed-plugin switch.
 */

export function createRequestRetryPolicyContribution(
  policy: ResolvedProviderRetryPolicy | undefined,
): HadamardRuntimeContribution {
  return {
    id: 'hadamard.request-retry-policy',
    async apply(ctx: ContributionApplyContext) {
      ctx.services.register(contributionRetryPolicyKey, policy);
      return () => { ctx.services.unregister(contributionRetryPolicyKey); };
    },
  };
}

export function createTavilySearchContribution(
  rawSettings: Record<string, unknown>,
): HadamardRuntimeContribution {
  const stored = readStoredManagedPluginConfig(rawSettings, 'tavily');
  return {
    id: 'hadamard.tavily-search',
    async apply(ctx: ContributionApplyContext) {
      if (stored.enabled !== true || !searchCredentialAvailable('tavily', stringValue(stored.apiKey))) {
        return () => undefined;
      }
      const registry = requireToolRegistry(ctx, 'hadamard.tavily-search');
      const definition = createTavilySearchTool({
        apiKey: stringValue(stored.apiKey) || undefined,
        timeoutMs: numberValue(stored.timeoutMs),
      });
      registry.add(definition);
      return () => { registry.remove(definition.name); };
    },
  };
}

export function createExaSearchContribution(
  rawSettings: Record<string, unknown>,
): HadamardRuntimeContribution {
  const stored = readStoredManagedPluginConfig(rawSettings, 'exa');
  return {
    id: 'hadamard.exa-search',
    async apply(ctx: ContributionApplyContext) {
      if (stored.enabled !== true || !searchCredentialAvailable('exa', stringValue(stored.apiKey))) {
        return () => undefined;
      }
      const registry = requireToolRegistry(ctx, 'hadamard.exa-search');
      const definition = createExaSearchTool({
        apiKey: stringValue(stored.apiKey) || undefined,
        timeoutMs: numberValue(stored.timeoutMs),
      });
      registry.add(definition);
      return () => { registry.remove(definition.name); };
    },
  };
}

function requireToolRegistry(ctx: ContributionApplyContext, contributionId: string) {
  const registry = ctx.services.get(contributionToolRegistryKey);
  if (!registry) {
    throw new HadamardSdkError(
      `Contribution '${contributionId}' requires the hadamard.toolRegistry service.`,
      'CONTRIBUTION_MISSING_SERVICE',
    );
  }
  return registry;
}

export function searchCredentialAvailable(
  pluginId: 'tavily' | 'exa',
  configuredKey: string,
): boolean {
  if (configuredKey.trim()) return true;
  if (pluginId === 'tavily') {
    if (process.env.TAVILY_API_KEY?.trim()) return true;
    try {
      return existsSync(path.join(homedir(), '.tavily', 'config.json'));
    } catch {
      return false;
    }
  }
  if (process.env.EXA_API_KEY?.trim()) return true;
  try {
    return existsSync(path.join(homedir(), '.exa', 'config.json'));
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

