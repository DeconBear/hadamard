import {
  HADAMARD_INTERACTIVE_COMMANDS,
  interactiveCommandUsage,
} from '../ui/commandSurface.js';
import type { CostLedgerSummary } from '../extensions/sessionCostTracker.js';
import { A } from './ansi.js';
import { formatInfoLine } from './transcript.js';
import type { TuiSelectionItem } from './selection.js';

interface TuiUsageEntry {
  name: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  cost: string | null;
  active: boolean;
}

interface TuiBasicCommandSnapshot {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  usageByConfiguration: TuiUsageEntry[];
  messages: number;
  toolCount: number;
  mcpToolCount: number;
  bridgeName?: string;
  planMode: boolean;
}

export interface TuiBasicCommandPort {
  selectItem(options: {
    title: string;
    items: TuiSelectionItem[];
  }): Promise<string | undefined>;
  clear(): Promise<void>;
  startRun(prompt: string): Promise<void>;
  shutdown(): void;
  toolNames(): string[];
  snapshot(): TuiBasicCommandSnapshot;
  /** Ledger today/total across sessions; null when the costTracker extension is off. */
  usageLedgerSummary?(): Promise<CostLedgerSummary | null>;
  runGoal(args: string): Promise<string>;
  appendStatic(lines: readonly string[]): void;
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`;
}

export async function runTuiBasicCommand(
  name: string,
  args: string,
  port: TuiBasicCommandPort,
): Promise<boolean> {
  switch (name) {
    case 'help': {
      const selected = await port.selectItem({
        title: 'Help',
        items: Object.entries(HADAMARD_INTERACTIVE_COMMANDS).map(([command, description]) => ({
          id: command,
          label: `/${command}`,
          description,
          detail: interactiveCommandUsage(command),
        })),
      });
      if (selected) {
        port.appendStatic([
          `${A.cyan}${interactiveCommandUsage(selected)}${A.reset}`,
          `${A.dim}${HADAMARD_INTERACTIVE_COMMANDS[selected]}${A.reset}`,
          '',
        ]);
      }
      return true;
    }
    case 'clear':
      await port.clear();
      return true;
    case 'init':
      await port.startRun(
        'Create or update an AGENTS.md at the repo root with concise guidance for AI coding assistants: build/test/lint/run commands, a short architecture overview, key conventions, and non-obvious gotchas. Explore with Glob, Grep, and Read first (package.json, README, existing AGENTS.md, key source dirs). If AGENTS.md already exists, improve it without discarding user-authored sections. Keep it focused and avoid filler.',
      );
      return true;
    case 'exit':
    case 'quit':
      port.shutdown();
      return true;
    case 'tools':
      port.appendStatic([...formatInfoLine(port.toolNames().join(', ')), '']);
      return true;
    case 'cost':
    case 'usage': {
      const snapshot = port.snapshot();
      const cost = snapshot.costUsd === null
        ? `${A.dim}(unknown — model lacks pricing; set ~/.hadamard/pricing.json)${A.reset}`
        : `$${snapshot.costUsd.toFixed(4)}`;
      const lines = [
        `${A.bold}Session usage${A.reset}`,
        `  ${A.dim}tokens${A.reset}   ${formatTokens(snapshot.inputTokens)} in · ${formatTokens(snapshot.outputTokens)} out`,
        `  ${A.dim}cost${A.reset}     ${cost}`,
        `  ${A.dim}model${A.reset}    ${snapshot.model}`,
      ];
      if (snapshot.usageByConfiguration.length > 0) {
        lines.push('', `${A.bold}By config${A.reset}`);
        for (const entry of snapshot.usageByConfiguration) {
          const star = entry.active ? ` ${A.green}*${A.reset}` : '';
          lines.push(`  ${A.bold}${entry.name}${star}${A.reset}  ${A.dim}${entry.turns} turn${entry.turns === 1 ? '' : 's'}${A.reset}  ${formatTokens(entry.inputTokens)} in · ${formatTokens(entry.outputTokens)} out${entry.cost ? `  ${entry.cost}` : ''}`);
        }
      }
      const ledger = port.usageLedgerSummary
        ? await port.usageLedgerSummary().catch(() => null)
        : null;
      if (ledger && ledger.entries > 0) {
        lines.push(
          '',
          `${A.bold}Ledger (all sessions)${A.reset}`,
          `  ${A.dim}today${A.reset}   ${formatTokens(ledger.today.inputTokens)} in · ${formatTokens(ledger.today.outputTokens)} out · $${ledger.today.costUsd.toFixed(4)}`,
          `  ${A.dim}total${A.reset}   ${formatTokens(ledger.total.inputTokens)} in · ${formatTokens(ledger.total.outputTokens)} out · $${ledger.total.costUsd.toFixed(4)} · ${ledger.entries} entries`,
        );
      }
      lines.push('');
      port.appendStatic(lines);
      return true;
    }
    case 'goal':
      port.appendStatic([...formatInfoLine(await port.runGoal(args)), '']);
      return true;
    case 'stats': {
      const snapshot = port.snapshot();
      port.appendStatic([
        `${A.bold}Session stats${A.reset}`,
        `  ${A.dim}messages${A.reset}     ${snapshot.messages}`,
        `  ${A.dim}tokens${A.reset}       ${formatTokens(snapshot.inputTokens)} in · ${formatTokens(snapshot.outputTokens)} out`,
        `  ${A.dim}tools${A.reset}        ${snapshot.toolCount}${snapshot.mcpToolCount ? ` (${snapshot.mcpToolCount} MCP)` : ''}`,
        `  ${A.dim}model${A.reset}       ${snapshot.model}${snapshot.bridgeName ? ` · bridge:${snapshot.bridgeName}` : ''}`,
        `  ${A.dim}plan mode${A.reset}   ${snapshot.planMode ? 'on' : 'off'}`,
        '',
      ]);
      return true;
    }
    case 'batch':
      // Kept in the controller because it owns sequential agent-run coordination.
      return false;
    default:
      return false;
  }
}
