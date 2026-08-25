import { describe, expect, it } from 'vitest';

import { resolveRoutingTargetSelection } from '../src/keyway/routingComposition.js';

describe('resolveRoutingTargetSelection', () => {
  it('keeps Gateway Routes, Agent Routers, and Model Teams in explicit namespaces', () => {
    expect(resolveRoutingTargetSelection({ gatewayRouteAlias: 'chat-default' }))
      .toEqual({ kind: 'gateway-route', routeAlias: 'chat-default' });
    expect(resolveRoutingTargetSelection({ agentRouterProfile: 'coding-router' }))
      .toEqual({ kind: 'agent-router', profileName: 'coding-router' });
    expect(resolveRoutingTargetSelection({ modelTeam: 'review-panel' }))
      .toEqual({ kind: 'model-team', teamName: 'review-panel' });
  });

  it('rejects ambiguous top-level composition instead of silently double-routing', () => {
    expect(() => resolveRoutingTargetSelection({
      gatewayRouteAlias: 'chat-default',
      agentRouterProfile: 'coding-router',
    })).toThrow(/one top-level routing owner/u);
    expect(() => resolveRoutingTargetSelection({
      gatewayRouteAlias: 'chat-default',
      modelTeam: 'review-panel',
    })).toThrow(/one top-level routing owner/u);
  });
});
