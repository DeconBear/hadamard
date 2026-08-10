import { A, truncateToWidth } from './ansi.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiWorkspaceDiffFile {
  status: string;
  path: string;
  additions: number;
  deletions: number;
}

export interface TuiWorkspaceCommandPort {
  readFile(file: string): string;
  gitDiff(): string;
  exportConversation(file: string): void;
  getSessionDiff(): Promise<{ files: TuiWorkspaceDiffFile[] }>;
  applySessionDiff(): Promise<{ applied: boolean; message: string }>;
  startRun(prompt: string): Promise<void>;
  appendStatic(lines: readonly string[]): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runTuiWorkspaceCommand(
  name: string,
  args: string,
  port: TuiWorkspaceCommandPort,
): Promise<boolean> {
  if (name !== 'batch' && name !== 'review' && name !== 'export' && name !== 'diff') return false;
  if (name === 'batch') {
    const file = args.trim();
    if (!file) {
      port.appendStatic([...formatErrorLine('usage: /batch <file> — runs each line as a separate turn'), '']);
      return true;
    }
    let prompts: string[];
    try {
      prompts = port.readFile(file)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    } catch (error) {
      port.appendStatic([...formatErrorLine(`cannot read batch file: ${errorMessage(error)}`), '']);
      return true;
    }
    if (!prompts.length) {
      port.appendStatic([...formatInfoLine('batch file is empty'), '']);
      return true;
    }
    port.appendStatic([...formatInfoLine(`batch: ${prompts.length} prompt${prompts.length === 1 ? '' : 's'} from ${file}`), '']);
    for (let index = 0; index < prompts.length; index += 1) {
      port.appendStatic([`${A.dim}[${index + 1}/${prompts.length}]${A.reset} ${A.bold}>${A.reset} ${truncateToWidth(prompts[index]!, 60)}`, '']);
      await port.startRun(prompts[index]!);
    }
    port.appendStatic([...formatInfoLine(`batch complete — ${prompts.length} prompt${prompts.length === 1 ? '' : 's'} done`), '']);
    return true;
  }
  if (name === 'review') {
    const diff = port.gitDiff();
    if (!diff) {
      port.appendStatic([...formatInfoLine('no uncommitted changes to review — working tree is clean'), '']);
      return true;
    }
    await port.startRun(
      'Review this code change for correctness bugs, security issues, and simplification opportunities. '
      + 'File-by-file, note any real problems with file_path:line_number. Skip trivial style nits.\n\n```diff\n'
      + diff.slice(0, 80_000) + '\n```',
    );
    return true;
  }
  if (name === 'export') {
    const file = args.trim() || `session-${new Date().toISOString().replace(/[:.]/gu, '-')}.md`;
    try {
      port.exportConversation(file);
      port.appendStatic([...formatInfoLine(`conversation exported to ${file}`), '']);
    } catch (error) {
      port.appendStatic([...formatErrorLine(`export failed: ${errorMessage(error)}`), '']);
    }
    return true;
  }
  if (name === 'diff') {
    const subcommand = args || 'show';
    try {
      if (subcommand === 'show') {
        const diff = await port.getSessionDiff();
        port.appendStatic([
          `${A.bold}Session Diff${A.reset}`,
          ...(diff.files.length
            ? diff.files.map(file => `  ${file.status} ${file.path} ${A.green}+${file.additions}${A.reset} ${A.red}-${file.deletions}${A.reset}`)
            : [`  ${A.dim}(no changes)${A.reset}`]),
          '',
        ]);
        return true;
      }
      if (subcommand === 'apply --confirm') {
        const result = await port.applySessionDiff();
        port.appendStatic([
          ...(result.applied ? formatInfoLine(result.message) : formatErrorLine(result.message)),
          '',
        ]);
        return true;
      }
      port.appendStatic([...formatErrorLine('usage: /diff show | apply --confirm'), '']);
    } catch (error) {
      port.appendStatic([...formatErrorLine(errorMessage(error)), '']);
    }
    return true;
  }
  return false;
}
