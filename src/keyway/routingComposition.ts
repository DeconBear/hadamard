export type HadamardRoutingTarget =
  | { kind: 'gateway-route'; routeAlias: string }
  | { kind: 'agent-router'; profileName: string }
  | { kind: 'model-team'; teamName: string };

export interface RoutingSelectionInput {
  gatewayRouteAlias?: string;
  agentRouterProfile?: string;
  modelTeam?: string;
}

/** Prevents two orchestration layers from simultaneously owning top-level dispatch. */
export function resolveRoutingTargetSelection(input: RoutingSelectionInput): HadamardRoutingTarget | undefined {
  const selections: HadamardRoutingTarget[] = [];
  if (input.gatewayRouteAlias?.trim()) {
    selections.push({ kind: 'gateway-route', routeAlias: input.gatewayRouteAlias.trim() });
  }
  if (input.agentRouterProfile?.trim()) {
    selections.push({ kind: 'agent-router', profileName: input.agentRouterProfile.trim() });
  }
  if (input.modelTeam?.trim()) {
    selections.push({ kind: 'model-team', teamName: input.modelTeam.trim() });
  }
  if (selections.length > 1) {
    throw new TypeError(
      'Choose one top-level routing owner: Gateway Route, Agent Router, or Model Team. '
      + 'A Model Team member or Agent Router leaf may still reference a Gateway Route explicitly.',
    );
  }
  return selections[0];
}
