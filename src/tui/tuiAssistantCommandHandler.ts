import type { TeamGraphProposal } from '../team/teamProposalService.js';
import { A } from './ansi.js';
import type { TuiSelectionItem } from './selection.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiAssistantSessionSummary {
  id: string;
  title: string;
  messageCount: number;
  active: boolean;
}

export interface TuiAssistantServicePort {
  initialize(): Promise<void>;
  listSessions(): Promise<TuiAssistantSessionSummary[]>;
  createSession(): Promise<string>;
  resumeSession(id: string): Promise<{ title: string } | undefined>;
  run(
    prompt: string,
    onTool: (name: string) => void,
  ): Promise<{ text?: string; proposals: TeamGraphProposal[] }>;
  proposalDiff(proposal: TeamGraphProposal): string[];
  applyProposal(id: string): Promise<string>;
  rejectProposal(id: string): void;
}

export interface TuiAssistantCommandPort {
  assistant: TuiAssistantServicePort;
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

export async function runTuiAssistantCommand(
  name: string,
  args: string,
  port: TuiAssistantCommandPort,
): Promise<boolean> {
  if (name !== 'assistant') return false;
  await port.assistant.initialize();

  if (args === 'sessions') {
    const sessions = await port.assistant.listSessions();
    port.appendStatic([
      `${A.bold}Global Assistant Sessions${A.reset}`,
      ...sessions.map(item => `${item.active ? A.green + '●' : A.dim + '○'} ${item.id} · ${item.title} · ${item.messageCount} messages${A.reset}`),
      '',
    ]);
    return true;
  }
  if (args === 'new') {
    const id = await port.assistant.createSession();
    port.appendStatic([...formatInfoLine(`Global Assistant Session created: ${id}`), '']);
    return true;
  }
  if (args.startsWith('resume ')) {
    const id = args.slice('resume '.length).trim();
    const resumed = await port.assistant.resumeSession(id);
    if (!resumed) {
      port.appendStatic([...formatErrorLine(`Global Assistant Session not found: ${id}`), '']);
      return true;
    }
    port.appendStatic([...formatInfoLine(`Global Assistant Session selected: ${resumed.title}`), '']);
    return true;
  }

  const isTeam = args === 'team' || args.startsWith('team ');
  const isChat = args === 'chat' || args.startsWith('chat ') || isTeam;
  if (!isChat) {
    port.appendStatic([...formatErrorLine('usage: /assistant [chat <message>|sessions|new|resume <id>|team <request>]'), '']);
    return true;
  }
  const prompt = isTeam
    ? (args === 'team'
      ? ''
      : `Propose a Team Graph for this request. Use an explicit registered projectPath. ${args.slice('team'.length).trim()}`)
    : args.slice('chat'.length).trim();
  if (!prompt) {
    port.appendStatic([...formatErrorLine(isTeam ? 'usage: /assistant team <request>' : 'usage: /assistant chat <message>'), '']);
    return true;
  }

  try {
    const result = await port.assistant.run(prompt, toolName => {
      port.appendStatic([`${A.dim}  ⚙ ${toolName}${A.reset}`]);
    });
    if (result.text) port.appendStatic([...port.renderRichText(result.text), '']);
    for (const proposal of result.proposals) {
      port.appendStatic([
        `${A.bold}Team proposal · ${proposal.teamName}${A.reset}`,
        ...port.assistant.proposalDiff(proposal),
        '',
      ]);
      const choice = await port.selectItem({
        title: `Team proposal "${proposal.teamName}"`,
        subtitle: proposal.problems.length ? proposal.problems.join(' · ') : `Target: ${proposal.projectPath}`,
        items: [
          ...(!proposal.problems.length
            ? [{ id: 'apply', label: 'Apply', description: 'check base version and save' }]
            : []),
          { id: 'reject', label: 'Reject', description: 'no file write' },
          { id: 'later', label: 'Keep pending', description: 'decide later' },
        ],
      });
      if (choice === 'apply') {
        const filePath = await port.assistant.applyProposal(proposal.id);
        port.appendStatic([...formatInfoLine(`Team saved: ${filePath}`), '']);
      } else if (choice === 'reject') {
        port.assistant.rejectProposal(proposal.id);
      }
    }
  } catch (error) {
    port.appendStatic([...formatErrorLine(`Assistant error: ${errorMessage(error)}`), '']);
  }
  return true;
}
