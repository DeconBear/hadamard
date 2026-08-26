import { describe, expect, it, vi } from 'vitest';

import { runUsageRoutingCommand, type UsageRoutingCommandAdminPort } from '../src/ui/usageRoutingCommand.js';

function admin(): UsageRoutingCommandAdminPort {
  return {
    overview: vi.fn(() => ({
      summary: {
        entries: 1, requests: 2, inputTokens: 100, outputTokens: 20, totalTokens: 120,
        cacheReadTokens: 40, cacheWriteTokens: 5, reasoningTokens: 0,
        audioInputTokens: 0, audioOutputTokens: 0, costUsd: 0.01, accuracy: 'actual' as const,
      },
      trend: [], byProvider: [], unknownUsageEntries: 0,
    })),
    catalog: vi.fn(async () => ({
      targets: [{ kind: 'managed-api' as const, id: 'target.ark', providerId: 'ark', protocol: 'openai' as const, baseUrl: 'https://ark.example.test/v1', enabled: true }],
      routes: [{ id: 'route.chat', alias: 'chat', mode: 'direct' as const, enabled: true, createdAt: '', updatedAt: '', candidates: [{ id: 'candidate.1', targetId: 'target.ark', upstreamModel: 'glm-5.2', priority: 0, weight: 1, enabled: true }] }],
      budgets: [],
      credentials: [{ id: 'credential.ark', providerId: 'ark', label: 'Primary', priority: 0, weight: 1, enabled: true, createdAt: '', updatedAt: '', secretConfigured: true, health: { credentialId: 'credential.ark', state: 'healthy' as const, consecutiveFailures: 0 } }],
    })),
    saveBudget: vi.fn(() => ({ id: 'budget' })),
    deleteBudget: vi.fn(() => true),
    saveCredential: vi.fn(async () => ({ id: 'credential.ark' })),
    testCredential: vi.fn(async id => ({ id, state: 'healthy', tested: true })),
    saveRoute: vi.fn(async () => ({ id: 'route.chat' })),
    testTarget: vi.fn(async id => ({ id, state: 'authenticated' })),
  };
}

describe('shared Usage & Routing commands', () => {
  it('queries the unified ledger with range and provider filters', async () => {
    const target = admin();
    const lines = await runUsageRoutingCommand('usage', '7d --provider ark --model glm-5.2', { admin: async () => target });
    expect(target.overview).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'ark', model: 'glm-5.2' }));
    expect(lines).toContain('  tokens    120 (100 in / 20 out)');
  });

  it('lists credential health without returning secret values', async () => {
    const target = admin();
    const lines = await runUsageRoutingCommand('keys', 'list', { admin: async () => target });
    expect(lines?.join('\n')).toContain('credential.ark');
    expect(lines?.join('\n')).toContain('healthy');
    expect(JSON.stringify(lines)).not.toContain('secretRef');
  });

  it('uses masked TUI input for add/rotate and never prints the supplied secret', async () => {
    const target = admin();
    const lines = await runUsageRoutingCommand('keys', 'add credential.backup ark Backup', {
      admin: async () => target,
      promptSecret: async () => 'write-only-canary',
    });
    expect(target.saveCredential).toHaveBeenCalledWith(expect.objectContaining({
      id: 'credential.backup', providerId: 'ark', secret: 'write-only-canary',
    }));
    expect(JSON.stringify(lines)).not.toContain('write-only-canary');
  });
});
