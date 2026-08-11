import type { TeamGraphProposal } from '../team/teamProposalService.js';
import { A } from './ansi.js';
import type { TuiSelectionItem } from './selection.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiManagerStatus {
  model: string;
  readScope: string;
  mirrorDesignToWorkspace: boolean;
  milestones: number;
  today: number;
  upcoming: number;
  designChars: number | null;
}

export interface TuiManagerServicePort {
  listSessions(): Promise<Array<{ id: string; title: string; messageCount: number; active: boolean }>>;
  createSession(): Promise<string>;
  resumeSession(id: string): Promise<{ title: string } | undefined>;
  status(): Promise<TuiManagerStatus>;
  config(): Promise<unknown>;
  setConfig(key: string, value: string): Promise<{ ok: boolean; message: string }>;
  schedules(): Promise<Array<{ name: string; cron?: string; enabled: boolean }>>;
  run(
    kind: 'chat' | 'update' | 'team',
    instruction: string,
    onNotice: (message: string) => void,
    onTool: (name: string) => void,
  ): Promise<{
    text?: string;
    proposals: TeamGraphProposal[];
    designPath?: string;
  }>;
  proposalDiff(proposal: TeamGraphProposal): string[];
  applyProposal(id: string): Promise<{ teamName: string; filePath: string }>;
  rejectProposal(id: string): void;
}

export interface TuiManagerCommandPort {
  manager: TuiManagerServicePort;
  selectItem(options: {
    title: string;
    subtitle?: string;
    items: TuiSelectionItem[];
  }): Promise<string | undefined>;
  renderRichText(text: string): string[];
  appendStatic(lines: readonly string[]): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runTuiManagerCommand(
  name: string,
  args: string,
  port: TuiManagerCommandPort,
): Promise<boolean> {
  if (name !== 'manager') return false;

  if (args === 'sessions') {
    const sessions = await port.manager.listSessions();
    port.appendStatic([
      `${A.bold}Manager Sessions${A.reset}`,
      ...sessions.map(item => `${item.active ? A.green + '●' : A.dim + '○'} ${item.id} · ${item.title} · ${item.messageCount} messages${A.reset}`),
      '',
    ]);
    return true;
  }
  if (args === 'new') {
    const id = await port.manager.createSession();
    port.appendStatic([...formatInfoLine(`Manager Session created: ${id}`), '']);
    return true;
  }
  if (args.startsWith('resume ')) {
    const id = args.slice('resume '.length).trim();
    const resumed = await port.manager.resumeSession(id);
    if (!resumed) port.appendStatic([...formatErrorLine(`Manager Session not found: ${id}`), '']);
    else port.appendStatic([...formatInfoLine(`Manager Session selected: ${resumed.title}`), '']);
    return true;
  }
  if (!args || args === 'status') {
    const status = await port.manager.status();
    port.appendStatic([
      `${A.bold}Manager${A.reset}`,
      `${A.dim}model: ${status.model}${A.reset}`,
      `${A.dim}readScope: ${status.readScope}${A.reset}`,
      `${A.dim}mirror to workspace: ${status.mirrorDesignToWorkspace ? 'on' : 'off'}${A.reset}`,
      `${A.dim}plan.json: ${status.milestones} milestones · ${status.today} today · ${status.upcoming} upcoming${A.reset}`,
      `${A.dim}DESIGN.md: ${status.designChars === null ? '(none yet — /manager update)' : `${status.designChars} chars`}${A.reset}`,
      '',
    ]);
    return true;
  }
  if (args === 'config') {
    const config = await port.manager.config();
    port.appendStatic([
      ...JSON.stringify(config, null, 2).split('\n').map(line => `${A.dim}${line}${A.reset}`),
      `${A.dim}Set: /manager config set <model|bridgeConfig|readScope|mirror|allow> <value>${A.reset}`,
      `${A.dim}The Manager always runs read-only regardless of model.${A.reset}`,
      '',
    ]);
    return true;
  }
  if (args.startsWith('config set ')) {
    const rest = args.slice('config set '.length).trim();
    const space = rest.indexOf(' ');
    const key = space === -1 ? rest : rest.slice(0, space);
    const value = space === -1 ? '' : rest.slice(space + 1).trim();
    const result = await port.manager.setConfig(key, value);
    port.appendStatic([...(result.ok ? formatInfoLine(result.message) : formatErrorLine(result.message)), '']);
    return true;
  }
  if (args === 'schedule') {
    const tasks = await port.manager.schedules();
    port.appendStatic([
      `${A.bold}Manager schedules${A.reset}`,
      ...(tasks.length === 0
        ? [`${A.dim}none — add kind:"manager" tasks to .hadamard/scheduled-tasks.json${A.reset}`]
        : tasks.map(task => `${A.cyan}${task.name}${A.reset}${A.dim} · ${task.cron} · ${task.enabled ? 'enabled' : 'paused'}${A.reset}`)),
      '',
    ]);
    return true;
  }

  const kind = args === 'update' || args.startsWith('update ')
    ? 'update'
    : args === 'team' || args.startsWith('team ')
      ? 'team'
      : args === 'chat' || args.startsWith('chat ')
        ? 'chat'
        : undefined;
  if (!kind) {
    port.appendStatic([...formatErrorLine('usage: /manager [status|chat <message>|update [instruction]|sessions|new|resume <id>|team <request>|config|schedule]'), '']);
    return true;
  }
  const instruction = kind === 'update'
    ? (args === 'update' ? '' : args.slice('update'.length).trim())
    : kind === 'team'
      ? (args === 'team' ? '' : args.slice('team'.length).trim())
      : args.slice('chat'.length).trim();
  if ((kind === 'chat' || kind === 'team') && !instruction) {
    port.appendStatic([...formatErrorLine(kind === 'team' ? 'usage: /manager team <request>' : 'usage: /manager chat <message>'), '']);
    return true;
  }
  if (kind === 'update') {
    port.appendStatic([...formatInfoLine('Manager: updating Design and plan documents…'), '']);
  }

  try {
    const result = await port.manager.run(
      kind,
      instruction,
      notice => { port.appendStatic([...formatInfoLine(notice), '']); },
      toolName => { port.appendStatic([`${A.dim}  ⚡ ${toolName}${A.reset}`]); },
    );
    if (result.text) port.appendStatic([...port.renderRichText(result.text), '']);
    for (const proposal of result.proposals) {
      port.appendStatic([
        `${A.bold}Team proposal · ${proposal.teamName}${A.reset}`,
        ...port.manager.proposalDiff(proposal),
        '',
      ]);
      const choice = await port.selectItem({
        title: `Team proposal "${proposal.teamName}"`,
        subtitle: proposal.problems.length
          ? 'Invalid proposal — Apply is unavailable'
          : `Target: ${proposal.projectPath}`,
        items: [
          ...(!proposal.problems.length
            ? [{ id: 'apply', label: 'Apply', description: 'validate base version and write the Team definition' }]
            : []),
          { id: 'reject', label: 'Reject', description: 'discard without writing' },
          { id: 'later', label: 'Keep pending', description: 'do not write now' },
        ],
      });
      if (choice === 'apply') {
        try {
          const applied = await port.manager.applyProposal(proposal.id);
          port.appendStatic([...formatInfoLine(`Team saved: ${applied.teamName} (${applied.filePath})`), '']);
        } catch (error) {
          port.appendStatic([...formatErrorLine(`Team apply failed: ${errorMessage(error)}`), '']);
        }
      } else if (choice === 'reject') {
        port.manager.rejectProposal(proposal.id);
        port.appendStatic([...formatInfoLine('Team proposal rejected; no file was written.'), '']);
      }
    }
    if (kind === 'update' && result.designPath) {
      port.appendStatic([...formatInfoLine(`Design updated · ${result.designPath}`), '']);
    }
  } catch (error) {
    port.appendStatic([...formatErrorLine(`manager error: ${errorMessage(error)}`), '']);
  }
  return true;
}
