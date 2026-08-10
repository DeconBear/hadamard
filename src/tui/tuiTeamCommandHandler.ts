import {
  cloneTeamDefinition,
  countTeamAgents,
  deleteTeamDefinition,
  getBuiltInTeamDefinition,
  instantiateTeamDefinition,
  listTeamAgentLabels,
  listTeamDefinitions,
  loadTeamDefinition,
} from '../team/teamDefinitions.js';
import type { TeamPreferences } from '../team/teamPreferences.js';
import {
  applyTeamRunEvent,
  createTeamRunViewState,
  formatTeamRunTreeLines,
} from '../team/teamRunView.js';
import type {
  ModelTeamResult,
  TeamDefinition,
  TeamEvent,
} from '../types.js';
import { parseTeamAskArguments } from '../ui/commandSurface.js';
import { A } from './ansi.js';
import type { TuiSelectionItem } from './selection.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiTeamStatePort {
  activeName(): string | null;
  hasActiveTool(): boolean;
  preferences(): TeamPreferences;
  lastRunSummary(): string | null;
  currentModel(): string;
  attach(name: string): TeamDefinition | null;
  clear(): void;
  setLastRunSummary(summary: string): void;
}

export interface TuiTeamExecutionPort {
  ask(
    definition: TeamDefinition,
    prompt: string,
    onEvent: (event: TeamEvent) => void,
  ): Promise<ModelTeamResult>;
}

export interface TuiTeamUiPort {
  selectItem(options: {
    title: string;
    subtitle?: string;
    items: TuiSelectionItem[];
  }): Promise<string | undefined>;
  renderRichText(text: string): string[];
  appendStatic(lines: readonly string[]): void;
}

export interface TuiTeamCommandPort {
  workDir: string;
  state: TuiTeamStatePort;
  execution: TuiTeamExecutionPort;
  ui: TuiTeamUiPort;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runTuiTeamCommand(
  name: string,
  args: string,
  port: TuiTeamCommandPort,
): Promise<boolean> {
  if (name !== 'team') return false;

  const { state, ui } = port;
  const preferences = state.preferences();
  const activeName = state.activeName();

  if (args === 'status') {
    ui.appendStatic([
      `${A.bold}Team status${A.reset}`,
      `${A.dim}attached: ${activeName ?? 'none'}${A.reset}`,
      `${A.dim}autoInvoke: ${preferences.autoInvoke ? 'on — the main agent can call the team as a tool' : 'off — manual /team ask only'}${A.reset}`,
      `${A.dim}defaultAttached: ${preferences.defaultAttached ?? 'none'}${preferences.defaultAttached && !activeName ? ' (not found)' : ''}${A.reset}`,
      `${A.dim}last run: ${state.lastRunSummary() ?? 'none'}${A.reset}`,
      '',
    ]);
    return true;
  }
  if (args === 'off') {
    state.clear();
    ui.appendStatic([...formatInfoLine('team: none — the agent works individually'), '']);
    return true;
  }
  if (args === 'list') {
    const teams = listTeamDefinitions(port.workDir);
    ui.appendStatic([
      `${A.bold}Teams${A.reset}`,
      ...teams.map(team =>
        `${team.name === activeName ? `${A.green}*${A.reset}` : ' '}${A.cyan}${team.name}${A.reset}${A.dim} · ${team.definition.mode} · ${team.source} · ${countTeamAgents(team.definition)} agents${A.reset}`,
      ),
      `${A.dim}/team attach <name> · /team ask <name> <prompt> · /team off · /team status${A.reset}`,
      '',
    ]);
    return true;
  }
  if (args.startsWith('attach ')) {
    const teamName = args.slice(7).trim();
    const definition = state.attach(teamName);
    if (!definition) {
      ui.appendStatic([...formatErrorLine(`team not found: ${teamName}`), '']);
      return true;
    }
    ui.appendStatic([
      ...formatInfoLine(`team attached: ${definition.name} (${definition.mode}) · autoInvoke ${preferences.autoInvoke ? 'on' : 'off — run /team ask <name> <prompt> to use it'}`),
      '',
    ]);
    return true;
  }
  if (args.startsWith('clone ')) {
    const parts = args.slice(6).trim().split(/\s+/u);
    if (parts.length !== 2) {
      ui.appendStatic([...formatErrorLine('usage: /team clone <source> <new-name>'), '']);
      return true;
    }
    try {
      const clone = await cloneTeamDefinition(parts[0]!, parts[1]!, { projectDir: port.workDir });
      ui.appendStatic([...formatInfoLine(`team cloned: ${parts[0]} → ${clone.name} (${clone.filePath})`), '']);
    } catch (error) {
      ui.appendStatic([...formatErrorLine(`clone failed: ${errorMessage(error)}`), '']);
    }
    return true;
  }
  if (args.startsWith('delete ')) {
    const teamName = args.slice(7).trim();
    if (!teamName) {
      ui.appendStatic([...formatErrorLine('usage: /team delete <name>'), '']);
      return true;
    }
    if (getBuiltInTeamDefinition(teamName)) {
      ui.appendStatic([...formatErrorLine(`cannot delete built-in team: ${teamName}`), '']);
      return true;
    }
    const removed = await deleteTeamDefinition(teamName, port.workDir);
    if (!removed) {
      ui.appendStatic([...formatErrorLine(`team not found: ${teamName}`), '']);
      return true;
    }
    if (state.activeName() === teamName) state.clear();
    ui.appendStatic([...formatInfoLine(`deleted team: ${teamName}`), '']);
    return true;
  }
  if (args.startsWith('ask ')) {
    const parsed = parseTeamAskArguments(args.slice(4).trim());
    if (!parsed) {
      ui.appendStatic([...formatErrorLine('usage: /team ask <name> <prompt>'), '']);
      return true;
    }
    const loaded = loadTeamDefinition(parsed.name, port.workDir);
    if (!loaded) {
      ui.appendStatic([...formatErrorLine(`team not found: ${parsed.name}`), '']);
      return true;
    }
    const definition = instantiateTeamDefinition(loaded.definition, state.currentModel());
    const memberModels = listTeamAgentLabels(definition);
    if (preferences.confirmBeforeRun) {
      const choice = await ui.selectItem({
        title: `Run team "${definition.name}"?`,
        subtitle: `${definition.mode} · members: ${memberModels.join(', ') || '(none)'}`,
        items: [
          { id: 'run', label: 'Run', description: 'convene the team now' },
          { id: 'cancel', label: 'Cancel', description: 'do nothing' },
        ],
      });
      if (choice !== 'run') return true;
    }
    ui.appendStatic([
      ...formatInfoLine(`asking team "${parsed.name}" (${definition.mode} mode)`),
      `${A.dim}convening: ${memberModels.join(', ') || 'configured members'}${A.reset}`,
      '',
    ]);
    try {
      const teamRunView = createTeamRunViewState(definition.name);
      const printTeamRunTree = (): void => {
        const lines = formatTeamRunTreeLines(teamRunView);
        if (lines.length) ui.appendStatic([...lines.map(line => `${A.dim}${line}${A.reset}`), '']);
      };
      const result = await port.execution.ask(definition, parsed.prompt, event => {
        applyTeamRunEvent(teamRunView, event);
        if (event.type === 'team.synthesis') {
          ui.appendStatic([`${A.dim}  ◈ synthesis round ${event.round}: ${event.decision}${A.reset}`]);
        } else if (
          event.type === 'team.started'
          || event.type === 'team.member.completed'
          || event.type === 'team.edge.triggered'
          || event.type === 'team.completed'
        ) {
          printTeamRunTree();
        }
      });
      state.setLastRunSummary(`${parsed.name} · ${result.mode} · ${Math.round(result.durationMs / 1000)}s`);
      ui.appendStatic([
        `${A.green}✓ team response${A.reset}${A.dim} · ${result.mode} · ${Math.round(result.durationMs / 1000)}s${A.reset}`,
        `${A.dim}cost: ${result.cost.estimatedCost !== null ? `$${result.cost.estimatedCost.toFixed(4)}` : 'N/A'} · ${result.cost.totalInputTokens + result.cost.totalOutputTokens} tokens${A.reset}`,
        '',
        ...ui.renderRichText(result.answer),
        '',
      ]);
    } catch (error) {
      ui.appendStatic([...formatErrorLine(`team error: ${errorMessage(error)}`), '']);
    }
    return true;
  }

  const teams = listTeamDefinitions(port.workDir);
  const choice = await ui.selectItem({
    title: 'Team',
    subtitle: `attach a team (autoInvoke ${preferences.autoInvoke ? 'on' : 'off'} — settings preferences.team)`,
    items: [
      {
        id: '__none__',
        label: state.hasActiveTool() ? `No team — remove "${activeName}"` : 'No team (individual) — current',
        description: 'the agent works solo, no team attached',
      },
      ...teams.map(team => ({
        id: `team:${team.name}`,
        label: `${team.name}${team.name === activeName ? ' — attached' : ''}`,
        description: `${team.source} · ${team.definition.mode} · ${countTeamAgents(team.definition)} agents`,
      })),
    ],
  });
  if (!choice) return true;
  if (choice === '__none__') {
    state.clear();
    ui.appendStatic([...formatInfoLine('team: none — the agent works individually'), '']);
    return true;
  }
  try {
    const definition = state.attach(choice.slice('team:'.length));
    if (!definition) {
      ui.appendStatic([...formatErrorLine('could not load team definition'), '']);
      return true;
    }
    ui.appendStatic([
      ...formatInfoLine(
        preferences.autoInvoke
          ? `team active: ${definition.name} (${definition.mode}) — the agent can now call "${definition.name}" as a tool when it helps`
          : `team attached: ${definition.name} (${definition.mode}) — run /team ask ${definition.name} <prompt> (autoInvoke off)`,
      ),
      '',
    ]);
  } catch (error) {
    ui.appendStatic([...formatErrorLine(`team error: ${errorMessage(error)}`), '']);
  }
  return true;
}
