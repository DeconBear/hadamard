import {
  HADAMARD_INTERACTIVE_COMMANDS,
  SUBCOMMANDS,
  SUBCOMMAND_DESCRIPTIONS,
  interactiveCommandUsage,
} from '../ui/commandSurface.js';

export interface ProductCapability {
  id: string;
  title: string;
  summary: string;
  uiLocations: string[];
  prerequisites: string[];
  steps: string[];
  commands: string[];
  examples: string[];
  limitations: string[];
  relatedSettings: string[];
  keywords: string[];
}

const UI_LOCATION_BY_COMMAND: Record<string, string[]> = {
  model: ['Settings > Models', 'Chat composer > model picker'],
  bridge: ['Settings > Models'],
  effort: ['Chat composer > model options'],
  permissions: ['Chat composer > permission picker', 'Settings > Runtime'],
  agents: ['Agents'],
  team: ['Agents > Graph or Workflow'],
  automation: ['Automation'],
  workflows: ['Chat command palette > Workflows'],
  plugins: ['Customize > Plugins'],
  plugin: ['Customize > Plugins'],
  skills: ['Customize > Skills'],
  mcp: ['Settings > MCP'],
  issues: ['Projects > project > Issues'],
  manager: ['Bottom-right Assistant > Project'],
  assistant: ['Bottom-right Assistant > Global'],
  sessions: ['Projects > project > Chats'],
  session: ['Projects > project > Chats'],
  resume: ['Projects > project > Chats'],
  worktree: ['Projects > project > Git', 'Chat command palette'],
  diff: ['Projects > project > Git'],
  review: ['Projects > project > Git'],
  dream: ['Settings > Memory'],
  memory: ['Settings > Memory'],
  compact: ['Chat composer'],
  tools: ['Chat command palette > Tools'],
  hooks: ['Settings > Hooks'],
  rules: ['Settings > Rules'],
  doctor: ['Settings > Diagnostics'],
  help: ['Chat command palette', 'Bottom-right Assistant'],
};

const LIMITATIONS_BY_COMMAND: Record<string, string[]> = {
  bridge: ['External CLI runtimes may require their own installed executable and native login.'],
  workflows: ['Dynamic JavaScript workflows are distinct from Agents-page Workflow trees.'],
  team: ['Nested Graph/Workflow cycles are rejected before execution.'],
  permissions: ['Full access still follows explicit runtime safety rules; workspace access confines available tools.'],
  plugins: ['Project plugins and skills may require an explicit trust decision.'],
  plugin: ['Installing, updating, removing, or trusting a plugin changes local configuration.'],
  mcp: ['A server must be configured and reachable before its tools become available.'],
  assistant: ['Global Assistant manages Hadamard configuration; source-code edits belong in the main chat.'],
};

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).map(part => part ? part[0]!.toUpperCase() + part.slice(1) : '').join(' ');
}

function commandCapability(command: string, summary: string): ProductCapability {
  const subcommands = SUBCOMMANDS[command] ?? [];
  const commands = [interactiveCommandUsage(command), ...subcommands.map(sub => `/${command} ${sub}`)];
  const examples = subcommands.slice(0, 3).map(sub => {
    const detail = SUBCOMMAND_DESCRIPTIONS[`${command} ${sub}`];
    return detail ? `/${command} ${sub} — ${detail}` : `/${command} ${sub}`;
  });
  return {
    id: `command.${command}`,
    title: titleCase(command),
    summary,
    uiLocations: UI_LOCATION_BY_COMMAND[command] ?? ['Chat command palette'],
    prerequisites: command === 'help' ? [] : ['Open a Hadamard project or chat.'],
    steps: [
      `Open ${UI_LOCATION_BY_COMMAND[command]?.[0] ?? 'the chat command palette'}.`,
      `Run ${interactiveCommandUsage(command)} or use the matching visible control.`,
      'Review the resulting status, preview, or confirmation before continuing.',
    ],
    commands,
    examples: examples.length ? examples : [interactiveCommandUsage(command)],
    limitations: LIMITATIONS_BY_COMMAND[command] ?? [],
    relatedSettings: UI_LOCATION_BY_COMMAND[command]?.filter(location => location.startsWith('Settings')) ?? [],
    keywords: [command, summary, ...subcommands],
  };
}

const navigationCapabilities: ProductCapability[] = [
  {
    id: 'gui.projects', title: 'Projects and workspaces', summary: 'Open projects and use chats, documents, issues, Git, terminal, files, Agents, and settings.',
    uiLocations: ['Projects'], prerequisites: [],
    steps: ['Open Projects.', 'Select or add a workspace.', 'Choose a project detail tab or start a chat.'],
    commands: ['/sessions', '/issues', '/diff', '/worktree'], examples: ['Open a project, then select Issues to assign work to an Agent.'],
    limitations: ['Terminal and Git actions depend on tools installed on the local machine.'], relatedSettings: ['Settings > Data root'],
    keywords: ['projects', 'workspace', 'files', 'terminal', 'git', 'issues', 'documents'],
  },
  {
    id: 'gui.agents', title: 'Agents, Graphs, and Workflows', summary: 'Configure reusable Agents and compose executable Graph and Workflow definitions.',
    uiLocations: ['Agents'], prerequisites: ['Configure at least one model configuration for direct model nodes.'],
    steps: ['Open Agents.', 'Create an Agent, Graph, Workflow, or Router.', 'Choose a model configuration, Agent, Graph, or Workflow for each executor node.', 'Save and run the definition.'],
    commands: ['/agents', '/team'], examples: ['Create a Workflow whose first executor uses a saved Agent and whose continuation invokes a Graph.'],
    limitations: ['Recursive Graph/Workflow references are rejected.', 'Branch and parallel nodes do not own model settings.'], relatedSettings: ['Settings > Models'],
    keywords: ['agent', 'subagent', 'graph', 'workflow', 'router', 'model configuration', 'used by'],
  },
  {
    id: 'gui.automation', title: 'Automation', summary: 'Run prompts, Agents-page definitions, or dynamic workflows on a schedule or webhook.',
    uiLocations: ['Automation'], prerequisites: ['The referenced target must exist.'],
    steps: ['Open Automation.', 'Select New task.', 'Choose a trigger and action target.', 'Save, enable, and optionally run the task now.'],
    commands: ['/automation'], examples: ['/automation new'], limitations: ['Deleting a referenced workflow is blocked until tasks are re-pointed or removed.'], relatedSettings: [],
    keywords: ['automation', 'schedule', 'cron', 'webhook', 'task'],
  },
  {
    id: 'gui.customize', title: 'Customize', summary: 'Browse and manage plugins, skills, tools, and MCP integrations.',
    uiLocations: ['Customize', 'Settings > MCP'], prerequisites: [],
    steps: ['Open Customize.', 'Choose Plugins or Skills.', 'Review trust and enablement state before activating an item.'],
    commands: ['/plugins', '/plugin', '/skills', '/tools', '/mcp'], examples: ['/plugin list', '/skills'], limitations: ['Some integrations require credentials or a running local server.'], relatedSettings: ['Settings > MCP'],
    keywords: ['customize', 'plugins', 'skills', 'tools', 'mcp'],
  },
  {
    id: 'gui.assistant', title: 'Global Assistant', summary: 'Inspect and manage Hadamard configuration and get grounded instructions for every registered capability.',
    uiLocations: ['Bottom-right Assistant > Global'], prerequisites: ['Configure a working model for the Assistant.'],
    steps: ['Open the bottom-right Assistant.', 'Select Global.', 'Ask for a configuration change or how-to instructions.', 'Preview and apply staged destructive or editor changes.'],
    commands: ['/assistant chat'], examples: ['How do I create a Workflow that invokes an Agent?', 'Show broken references and help me fix them.'],
    limitations: ['It does not edit project source code.', 'Changes that can destroy or overwrite data require confirmation.'], relatedSettings: ['Assistant configuration', 'Settings > Models'],
    keywords: ['assistant', 'global agent', 'help', 'teach', 'configuration'],
  },
  {
    id: 'gui.settings', title: 'Settings and data root', summary: 'Configure models, runtime, permissions, memory, MCP, hooks, rules, appearance, and storage.',
    uiLocations: ['Settings'], prerequisites: [],
    steps: ['Open Settings.', 'Choose a section.', 'Review validation and save the change.'],
    commands: ['/model config', '/permissions', '/memory', '/mcp', '/hooks', '/rules', '/doctor'], examples: ['/doctor'],
    limitations: ['Credential values are write-only in Assistant results and should use environment references where supported.'], relatedSettings: ['Settings'],
    keywords: ['settings', 'data root', 'models', 'runtime', 'permissions', 'memory', 'hooks', 'rules'],
  },
];

export const productCapabilities: readonly ProductCapability[] = Object.freeze([
  ...navigationCapabilities,
  ...Object.entries(HADAMARD_INTERACTIVE_COMMANDS).map(([command, summary]) => commandCapability(command, summary)),
]);

export function getProductCapability(id: string): ProductCapability | null {
  const normalized = id.trim().toLowerCase();
  const found = productCapabilities.find(capability => capability.id.toLowerCase() === normalized);
  return found ? structuredClone(found) : null;
}

export function searchProductCapabilities(query: string, limit = 12): ProductCapability[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored = productCapabilities.map(capability => {
    const title = capability.title.toLowerCase();
    const haystack = [
      capability.id,
      capability.title,
      capability.summary,
      ...capability.keywords,
      ...capability.commands,
      ...capability.uiLocations,
    ].join('\n').toLowerCase();
    const score = terms.length === 0 ? 1 : terms.reduce((total, term) =>
      total + (title.includes(term) ? 4 : 0) + (capability.id.includes(term) ? 3 : 0) + (haystack.includes(term) ? 1 : 0), 0);
    return { capability, score };
  }).filter(item => item.score > 0);
  scored.sort((left, right) => right.score - left.score || left.capability.id.localeCompare(right.capability.id));
  return scored.slice(0, Math.max(1, Math.min(limit, 50))).map(item => structuredClone(item.capability));
}
