import type { HadamardMemoryCommandResult } from '../memory/memoryCommandTypes.js';
import { A } from './ansi.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiMemoryCommandPort {
  runMemoryCommand(input: string): Promise<HadamardMemoryCommandResult>;
  compact(summaryInstructions?: string): Promise<{
    compacted: boolean;
    error?: string;
    reason: string;
    messagesRemoved?: number;
  }>;
  compactPromptMode(): string;
  dreamState(): Promise<unknown>;
  dream(): Promise<{
    reason?: string;
    skipped: boolean;
    success: boolean;
  }>;
  selectDreamAction(): Promise<string | undefined>;
  appendStatic(lines: readonly string[]): void;
}

async function runDreamCommand(action: string, port: TuiMemoryCommandPort): Promise<void> {
  if (action === 'status') {
    const state = await port.dreamState();
    port.appendStatic([`${A.dim}${JSON.stringify(state, null, 2)}${A.reset}`, '']);
    return;
  }
  if (action !== 'run') {
    port.appendStatic([...formatErrorLine('usage: /dream [run|status]'), '']);
    return;
  }
  const result = await port.dream();
  port.appendStatic([
    ...formatInfoLine(
      result.reason ?? (result.skipped ? 'dream skipped' : result.success ? 'dream completed' : 'dream failed'),
    ),
    '',
  ]);
}

export async function runTuiMemoryCommand(
  name: string,
  args: string,
  port: TuiMemoryCommandPort,
): Promise<boolean> {
  switch (name) {
    case 'memory': {
      try {
        const result = await port.runMemoryCommand(args || 'status');
        port.appendStatic([
          `${A.bold}${result.title}${A.reset}`,
          ...formatInfoLine(result.message),
          ...(result.text ? result.text.split('\n').map(line => `${A.dim}${line}${A.reset}`) : []),
          ...(result.items ?? []).flatMap(item => [
            `  ${A.bold}${item.label}${A.reset}${item.description ? ` ${A.dim}· ${item.description}${A.reset}` : ''}`,
            ...(item.detail ? [`    ${A.dim}${item.detail}${A.reset}`] : []),
          ]),
          '',
        ]);
      } catch (error) {
        port.appendStatic([...formatErrorLine(error instanceof Error ? error.message : String(error)), '']);
      }
      return true;
    }
    case 'compact': {
      try {
        const result = await port.compact(args || undefined);
        if (!result.compacted) {
          port.appendStatic([
            ...formatErrorLine(result.error ?? `compact skipped: ${result.reason}`),
            '',
          ]);
          return true;
        }
        port.appendStatic([
          `${A.green}\u2713 compacted${A.reset}${A.dim} \u00b7 ${result.messagesRemoved ?? '?'} messages summarized \u00b7 mode: ${port.compactPromptMode()}${A.reset}`,
          '',
        ]);
      } catch (error) {
        port.appendStatic([...formatErrorLine((error as Error).message), '']);
      }
      return true;
    }
    case 'dream': {
      try {
        const action = args || await port.selectDreamAction();
        if (action) await runDreamCommand(action.toLowerCase(), port);
      } catch (error) {
        port.appendStatic([...formatErrorLine((error as Error).message), '']);
      }
      return true;
    }
    default:
      return false;
  }
}
