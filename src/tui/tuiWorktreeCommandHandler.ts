import { WorktreeService } from '../worktree/worktreeService.js';
import { A } from './ansi.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiWorktreeCommandPort {
  workDir: string;
  appendStatic(lines: readonly string[]): void;
}

export async function runTuiWorktreeCommand(
  name: string,
  args: string,
  port: TuiWorktreeCommandPort,
): Promise<boolean> {
  if (name !== 'worktree') return false;
  const service = new WorktreeService(port.workDir);
  if (args === 'list') {
    await service.init();
    const trees = await service.listWorktrees();
    port.appendStatic(trees.length === 0
      ? [...formatInfoLine('no worktrees'), '']
      : [
          ...trees.map(tree =>
            `${A.dim}${tree.path}${A.reset} · ${tree.isDirty ? `${A.yellow}dirty${A.reset}` : `${A.green}clean${A.reset}`}`,
          ),
          '',
        ]);
    return true;
  }
  if (args === 'exit') {
    try {
      service.exitWorktree();
      port.appendStatic([...formatInfoLine(`exited worktree, cwd: ${service.currentWorkDir}`), '']);
    } catch (error) {
      port.appendStatic([...formatErrorLine(error instanceof Error ? error.message : String(error)), '']);
    }
    return true;
  }
  if (args.startsWith('enter ')) {
    const worktreeName = args.slice(6).trim();
    try {
      await service.init();
      await service.createAndEnterWorktree({ name: worktreeName });
      port.appendStatic([...formatInfoLine(`entered worktree: ${worktreeName} (${service.currentWorkDir})`), '']);
    } catch (error) {
      port.appendStatic([...formatErrorLine(error instanceof Error ? error.message : String(error)), '']);
    }
    return true;
  }
  port.appendStatic([...formatInfoLine('usage: /worktree [enter <name>|exit|list]'), '']);
  return true;
}
