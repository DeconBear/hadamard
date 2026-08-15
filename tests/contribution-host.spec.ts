import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  HadamardContributionHost,
  defineContributionServiceKey,
} from '../src/contrib/contributionHost.js';
import type { HadamardRuntimeContribution } from '../src/contrib/contributionHost.js';
import {
  InMemoryContributionToolRegistry,
  contributionRetryPolicyKey,
  contributionToolRegistryKey,
} from '../src/contrib/contributionServices.js';
import {
  createExaSearchContribution,
  createRequestRetryPolicyContribution,
  createTavilySearchContribution,
} from '../src/plugins/managedContributions.js';
import { patchManagedPluginSettings } from '../src/plugins/managedPluginCatalog.js';
import { resolveProviderRetryPolicy } from '../src/provider/retryPolicy.js';
import { tool } from '../src/runtime/tools.js';

const probeKey = defineContributionServiceKey<{ label: string }>('test.probe');
const shadowKey = defineContributionServiceKey<{ label: string }>('test.shadow');

function probe(id: string, apply: HadamardRuntimeContribution['apply'], requires?: string[]): HadamardRuntimeContribution {
  return { id, requires, apply };
}

describe('HadamardContributionHost', () => {
  it('applies contributions and revokes every registration on dispose', async () => {
    const host = new HadamardContributionHost();
    const seen: string[] = [];
    const handle = await host.load(probe('test.revoke', async (ctx) => {
      ctx.services.register(probeKey, { label: 'revoked-service' });
      ctx.events.on('probe.event', (event) => { seen.push(String(event.payload)); });
      ctx.onDispose(() => { seen.push('disposed'); });
      return () => { seen.push('returned-disposer'); };
    }));
    expect(host.getService(probeKey)?.label).toBe('revoked-service');
    await host.getEventBus().emit('probe.event', 'payload');
    expect(seen).toEqual(['payload']);
    await handle.dispose();
    expect(host.getService(probeKey)).toBeUndefined();
    // The returned disposer runs before the apply-session revocation.
    expect(seen).toEqual(['payload', 'returned-disposer', 'disposed']);
    // The listener no longer fires after unload.
    await host.getEventBus().emit('probe.event', 'after-unload');
    expect(seen).toEqual(['payload', 'returned-disposer', 'disposed']);
    expect(host.listLoaded()).toEqual([]);
  });

  it('loads a batch in topological order and reports dependency cycles', async () => {
    const host = new HadamardContributionHost();
    const applied: string[] = [];
    await host.loadMany([
      probe('test.leaf', () => { applied.push('test.leaf'); }, ['test.base']),
      probe('test.base', () => { applied.push('test.base'); }),
    ]);
    expect(applied).toEqual(['test.base', 'test.leaf']);
    await expect(host.loadMany([
      probe('test.a', () => undefined, ['test.b']),
      probe('test.b', () => undefined, ['test.a']),
    ])).rejects.toMatchObject({ code: 'CONTRIBUTION_CYCLE' });
  });

  it('rejects duplicate ids deterministically and supports HMR-style replace', async () => {
    const host = new HadamardContributionHost();
    const disposed: string[] = [];
    const contribution = (generation: string) => probe('test.dupe', () => () => { disposed.push(generation); });
    await host.load(contribution('v1'));
    await expect(host.load(contribution('v2'))).rejects.toMatchObject({ code: 'CONTRIBUTION_DUPLICATE_ID' });
    await host.load(contribution('v2'), { replace: true });
    expect(disposed).toEqual(['v1']);
    expect(host.listLoaded()).toEqual([{ id: 'test.dupe', scope: 'global' }]);
    await host.dispose();
    expect(disposed).toEqual(['v1', 'v2']);
    expect(host.listLoaded()).toEqual([]);
  });

  it('rolls back a failed apply and stays usable', async () => {
    const host = new HadamardContributionHost();
    await expect(host.load(probe('test.fail', (ctx) => {
      ctx.services.register(probeKey, { label: 'must-be-revoked' });
      throw new Error('boom');
    }))).rejects.toMatchObject({ code: 'CONTRIBUTION_APPLY_FAILED' });
    expect(host.getService(probeKey)).toBeUndefined();
    // The host still accepts new contributions after a failure.
    const handle = await host.load(probe('test.after-fail', (ctx) => {
      ctx.services.register(probeKey, { label: 'recovered' });
    }));
    expect(host.getService(probeKey)?.label).toBe('recovered');
    await handle.dispose();
    expect(host.getService(probeKey)).toBeUndefined();
  });

  it('rolls back a failed loadMany batch in reverse order', async () => {
    const host = new HadamardContributionHost();
    const disposed: string[] = [];
    await expect(host.loadMany([
      probe('test.batch-a', () => () => { disposed.push('a'); }),
      probe('test.batch-b', () => () => { disposed.push('b'); }),
      probe('test.batch-c', () => { throw new Error('late failure'); }),
    ])).rejects.toMatchObject({ code: 'CONTRIBUTION_APPLY_FAILED' });
    expect(disposed).toEqual(['b', 'a']);
    expect(host.listLoaded()).toEqual([]);
  });

  it('requires loaded dependencies and reports missing ones', async () => {
    const host = new HadamardContributionHost();
    await host.load(probe('test.base', () => undefined));
    await host.load(probe('test.child', () => undefined, ['test.base']));
    await expect(host.load(probe('test.orphan', () => undefined, ['test.ghost']))).rejects.toMatchObject({
      code: 'CONTRIBUTION_MISSING_DEPENDENCY',
    });
  });

  it('shadows parent-scope services with the nearest registration', async () => {
    const host = new HadamardContributionHost();
    await host.load(probe('test.global-shadow', (ctx) => {
      ctx.services.register(shadowKey, { label: 'global' });
    }));
    const agentHandle = await host.load(probe('test.agent-shadow', (ctx) => {
      ctx.services.register(shadowKey, { label: 'agent' });
    }), { scope: 'agent' });
    expect(host.getScopedService(shadowKey, 'global')?.label).toBe('global');
    expect(host.getScopedService(shadowKey, 'agent')?.label).toBe('agent');
    expect(host.getScopedService(shadowKey, 'session')?.label).toBe('agent');
    // Unloading the nearer scope falls back to the parent registration.
    await agentHandle.dispose();
    expect(host.getScopedService(shadowKey, 'agent')?.label).toBe('global');
    expect(host.getScopedService(shadowKey, 'session')?.label).toBe('global');
  });

  it('runs observe events sequentially in registration order and waterfall short-circuits', async () => {
    const host = new HadamardContributionHost();
    const order: string[] = [];
    await host.load(probe('test.events', (ctx) => {
      ctx.events.on('probe.event', () => { order.push('first'); });
      ctx.events.on('probe.event', async () => { order.push('second'); });
      ctx.events.onWaterfall('probe.waterfall', (event, next) => {
        order.push('w1');
        return { type: event.type, payload: 'short-circuited' };
      });
      ctx.events.onWaterfall('probe.waterfall', () => {
        order.push('w2-never');
        return { type: 'probe.waterfall' };
      });
    }));
    await host.getEventBus().emit('probe.event', 'payload');
    expect(order).toEqual(['first', 'second']);
    const result = await host.getEventBus().waterfall('probe.waterfall');
    expect(result.payload).toBe('short-circuited');
    expect(order).not.toContain('w2-never');
  });

  it('diagnoses lazy service self-dependency cycles', async () => {
    const host = new HadamardContributionHost();
    await host.load(probe('test.lazy-cycle', (ctx) => {
      ctx.services.registerLazy(probeKey, () => ctx.services.get(probeKey) ?? { label: 'unreachable' });
    }));
    expect(() => host.getService(probeKey)).toThrow(/depends on itself/);
  });

  it('rejects duplicate service registrations deterministically', async () => {
    const host = new HadamardContributionHost();
    await host.load(probe('test.svc-a', (ctx) => {
      ctx.services.register(probeKey, { label: 'a' });
    }));
    await expect(host.load(probe('test.svc-b', (ctx) => {
      ctx.services.register(probeKey, { label: 'b' });
    }))).rejects.toMatchObject({ code: 'CONTRIBUTION_APPLY_FAILED' });
  });
});

describe('pilot contributions', () => {
  it('mounts Tavily and Exa search tools through the contribution host', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'tavily', { enabled: true, apiKey: 'tvly-secret' });
    patchManagedPluginSettings(raw, 'exa', { enabled: true, apiKey: 'exa-secret' });
    const host = new HadamardContributionHost();
    const registry = new InMemoryContributionToolRegistry();
    host.registerService(contributionToolRegistryKey, registry);
    const handles = await host.loadMany([
      createRequestRetryPolicyContribution(undefined),
      createTavilySearchContribution(raw),
      createExaSearchContribution(raw),
    ]);
    expect(registry.list().map((entry) => entry.name).sort()).toEqual(['ExaSearch', 'TavilySearch']);
    expect(host.getService(contributionRetryPolicyKey)).toBeUndefined();
    // Disposing the pilot contributions fully revokes the contributed tools.
    await handles[2]!.dispose();
    expect(registry.list().map((entry) => entry.name)).toEqual(['TavilySearch']);
    await handles[1]!.dispose();
    expect(registry.list()).toEqual([]);
    await handles[0]!.dispose();
  });

  it('contributes the resolved retry policy as a cross-cutting strategy', async () => {
    const host = new HadamardContributionHost();
    const registry = new InMemoryContributionToolRegistry();
    host.registerService(contributionToolRegistryKey, registry);
    const policy = resolveProviderRetryPolicy({ mode: 'always' }, 2);
    const handle = await host.load(createRequestRetryPolicyContribution(policy));
    expect(host.getService(contributionRetryPolicyKey)).toEqual(policy);
    await handle.dispose();
    expect(host.getService(contributionRetryPolicyKey)).toBeUndefined();
  });

  it('skips search tools that are disabled or lack credentials', async () => {
    const host = new HadamardContributionHost();
    const registry = new InMemoryContributionToolRegistry();
    host.registerService(contributionToolRegistryKey, registry);
    await host.loadMany([
      createTavilySearchContribution({}),
      createExaSearchContribution({}),
    ]);
    expect(registry.list()).toEqual([]);
  });
});

describe('contribution tool definitions', () => {
  it('keeps contributed tools fully formed for the agent assembly', () => {
    const definition = tool({
      name: 'Probe',
      description: 'Probe tool.',
      inputSchema: z.strictObject({ value: z.string() }),
      isReadOnly: () => true,
    }, async () => ({ ok: true }));
    expect(definition.name).toBe('Probe');
    expect(definition.isReadOnly?.()).toBe(true);
  });
});

