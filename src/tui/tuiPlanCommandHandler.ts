import type { HadamardPermissionMode } from '../types.js';
import { A } from './ansi.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiPlanCommandPort {
  defaultPermissionMode(): HadamardPermissionMode;
  currentPermissionMode(): HadamardPermissionMode;
  setPermissionMode(mode: HadamardPermissionMode): Promise<void>;
  readPlan(): string | null;
  planFile(): string;
  openPlanFile(): boolean;
  startRun(prompt: string): Promise<void>;
  renderRichText(text: string): string[];
  appendStatic(lines: readonly string[]): void;
}

export async function runTuiPlanCommand(
  name: string,
  args: string,
  port: TuiPlanCommandPort,
): Promise<boolean> {
  if (name !== 'plan') return false;
  const action = args.trim().toLowerCase();
  if (action === 'off' || action === 'approve') {
    if (action === 'approve' && !port.readPlan()) {
      port.appendStatic([...formatErrorLine('there is no saved plan to approve'), '']);
      return true;
    }
    await port.setPermissionMode(
      port.defaultPermissionMode() === 'bypassPermissions' ? 'bypassPermissions' : 'default',
    );
    port.appendStatic([
      ...formatInfoLine(action === 'approve'
        ? 'plan approved — implementation permissions restored'
        : 'plan mode off without approval'),
      '',
    ]);
    return true;
  }
  if (action === 'view') {
    const plan = port.readPlan();
    port.appendStatic(plan
      ? [`${A.bold}Current plan · awaiting approval${A.reset}`, '', ...port.renderRichText(plan), '']
      : [...formatInfoLine('no saved plan yet'), '']);
    return true;
  }
  if (action === 'revise' || action.startsWith('revise ')) {
    if (port.currentPermissionMode() !== 'plan') await port.setPermissionMode('plan');
    const feedback = args.trim().slice('revise'.length).trim();
    if (!feedback) {
      port.appendStatic([...formatInfoLine('plan remains read-only; use /plan revise <feedback>'), '']);
      return true;
    }
    await port.startRun(
      `Revise the saved plan using this feedback. Stay in Plan mode and call ExitPlanMode again when ready:\n\n${feedback}`,
    );
    return true;
  }
  if (action === 'open') {
    if (!port.openPlanFile()) {
      port.appendStatic([...formatErrorLine(`could not open plan file: ${port.planFile()}`), '']);
    }
    return true;
  }
  if (port.currentPermissionMode() !== 'plan') {
    await port.setPermissionMode('plan');
    port.appendStatic([...formatInfoLine('plan mode on — mutating tools blocked; research, then ExitPlanMode'), '']);
  }
  const plan = port.readPlan();
  if (plan) {
    port.appendStatic([
      `${A.bold}Current plan${A.reset} ${A.dim}(${port.planFile()})${A.reset}`,
      '',
      ...port.renderRichText(plan),
      '',
    ]);
  } else {
    port.appendStatic([...formatInfoLine('no plan yet — ask the agent to plan a task (it will call ExitPlanMode)'), '']);
  }
  return true;
}
