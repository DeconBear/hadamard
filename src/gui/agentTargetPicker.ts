import type { AgentTargetRef, TeamDefinition } from '../types.js';

export interface AgentTargetPickerTeam {
  name: string;
  squadType?: TeamDefinition['squadType'];
  definition?: TeamDefinition;
}

export interface AgentTargetPickerProfile {
  name: string;
  model?: string;
}

export interface AgentTargetPickerModelGroup {
  config: string;
  models: string[];
}

export interface AgentTargetPickerOption {
  value: string;
  label: string;
  group: string;
  disabled?: boolean;
}

export function encodeConfigModelTarget(config: string, model: string): string {
  return `model:${config}:${model}`;
}

export function targetRefToPickerValue(ref?: AgentTargetRef | null): string {
  if (!ref) return '';
  if (ref.kind === 'agent') return `agent:${ref.name}`;
  if (ref.kind === 'team') return `team:${ref.name}`;
  return encodeConfigModelTarget(ref.config ?? '', ref.model);
}

export function pickerValueToTargetRef(value: string): AgentTargetRef | null {
  const normalized = String(value || '');
  if (normalized.startsWith('agent:')) {
    return normalized.length > 6 ? { kind: 'agent', name: normalized.slice(6) } : null;
  }
  if (normalized.startsWith('team:')) {
    return normalized.length > 5 ? { kind: 'team', name: normalized.slice(5) } : null;
  }
  if (normalized.startsWith('model:')) {
    const remainder = normalized.slice(6);
    const separator = remainder.indexOf(':');
    if (separator < 0) return remainder ? { kind: 'model', config: '', model: remainder } : null;
    const model = remainder.slice(separator + 1);
    return model ? { kind: 'model', config: remainder.slice(0, separator), model } : null;
  }
  return normalized ? { kind: 'model', config: '', model: normalized } : null;
}

export function nestedTeamRefsInDefinition(definition?: TeamDefinition): string[] {
  const refs = new Set<string>();
  const add = (ref?: AgentTargetRef): void => {
    if (ref?.kind === 'team' && ref.name.trim()) refs.add(ref.name.trim());
  };
  for (const node of definition?.nodes ?? []) {
    add(node.targetRef);
    if (node.type === 'team' && node.teamRef?.trim()) refs.add(node.teamRef.trim());
  }
  const visitWorkflow = (node: TeamDefinition['workflowTree']): void => {
    if (!node) return;
    add(node.targetRef);
    for (const child of node.children ?? []) visitWorkflow(child);
  };
  visitWorkflow(definition?.workflowTree);
  return [...refs];
}

export function teamDefinitionReaches(
  definitions: readonly AgentTargetPickerTeam[],
  fromName: string,
  targetName: string,
  visited = new Set<string>(),
): boolean {
  if (fromName === targetName) return true;
  if (visited.has(fromName)) return false;
  visited.add(fromName);
  const definition = definitions.find(team => team.name === fromName)?.definition;
  if (!definition) return false;
  return nestedTeamRefsInDefinition(definition)
    .some(name => teamDefinitionReaches(definitions, name, targetName, visited));
}

export function buildAgentTargetPickerOptions(input: {
  modelGroups: readonly AgentTargetPickerModelGroup[];
  profiles: readonly AgentTargetPickerProfile[];
  teams?: readonly AgentTargetPickerTeam[];
  excludeTeam?: string;
}): AgentTargetPickerOption[] {
  const options: AgentTargetPickerOption[] = [];
  for (const group of input.modelGroups) {
    for (const model of group.models) {
      options.push({
        value: encodeConfigModelTarget(group.config, model),
        label: model,
        group: `Model configurations · ${group.config}`,
      });
    }
  }
  for (const profile of input.profiles) {
    if (!profile.name) continue;
    options.push({
      value: `agent:${profile.name}`,
      label: profile.name + (profile.model ? ` (${profile.model})` : ''),
      group: 'Agents',
    });
  }
  const teams = input.teams ?? [];
  for (const team of teams) {
    if (!team.name || team.name === input.excludeTeam) continue;
    const disabled = Boolean(input.excludeTeam
      && teamDefinitionReaches(teams, team.name, input.excludeTeam));
    options.push({
      value: `team:${team.name}`,
      label: team.name + (disabled ? ' (would create cycle)' : ''),
      group: team.squadType === 'workflow' ? 'Workflows' : 'Graphs',
      disabled,
    });
  }
  return options;
}
