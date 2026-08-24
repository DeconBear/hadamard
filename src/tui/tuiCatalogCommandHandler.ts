import { A, truncateToWidth } from './ansi.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiHookSnapshot {
  lifecycle: Array<{ id: string; event: string; handlerType: string }>;
  issues: string[];
  preToolUse: Array<{ matcher: string; command: string }>;
  postToolUse: Array<{ matcher: string; command: string }>;
  sessionStart: Array<{ command: string }>;
}

export interface TuiCatalogCommandResult {
  message: string;
  items?: Array<{ label: string; description?: string }>;
}

export interface TuiCatalogCommandPort {
  showSkills(): Promise<void>;
  showAgents(): Promise<void>;
  showAgentRuns(): Promise<void>;
  showAgentExecution(id: string): Promise<void>;
  openAgentExecution(id: string): Promise<void>;
  showMcp(): Promise<void>;
  hooks(): TuiHookSnapshot;
  showPlugins(): Promise<void>;
  pluginCommand(args: string): Promise<TuiCatalogCommandResult>;
  rulesCommand(args: string): Promise<TuiCatalogCommandResult>;
  extensionsCommand(args: string): Promise<TuiCatalogCommandResult>;
  lspCommand(): Promise<TuiCatalogCommandResult>;
  appendStatic(lines: readonly string[]): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendCommandResult(result: TuiCatalogCommandResult, port: TuiCatalogCommandPort): void {
  port.appendStatic([
    ...formatInfoLine(result.message),
    ...(result.items ?? []).map(item => `  ${A.bold}${item.label}${A.reset}${item.description ? ` ${A.dim}· ${item.description}${A.reset}` : ''}`),
    '',
  ]);
}

export async function runTuiCatalogCommand(
  name: string,
  args: string,
  port: TuiCatalogCommandPort,
): Promise<boolean> {
  if (name !== 'skills' && name !== 'agents' && name !== 'mcp' && name !== 'hooks' && name !== 'plugins' && name !== 'plugin' && name !== 'rules' && name !== 'extensions' && name !== 'lsp') return false;

  if (name === 'skills') {
    await port.showSkills();
    return true;
  }
  if (name === 'agents') {
    const trimmedArgs = args.trim();
    const subcommandEnd = trimmedArgs.search(/\s/u);
    const subcommand = (subcommandEnd < 0 ? trimmedArgs : trimmedArgs.slice(0, subcommandEnd))
      .toLowerCase() || 'list';
    const target = subcommandEnd < 0 ? '' : trimmedArgs.slice(subcommandEnd + 1).trim();
    if (subcommand === 'list') {
      if (target) port.appendStatic([...formatErrorLine('usage: /agents [list|runs|show <root-execution-id>|open <session-or-execution-id>]'), '']);
      else await port.showAgents();
      return true;
    }
    if (subcommand === 'runs') {
      if (target) await port.showAgentExecution(target);
      else await port.showAgentRuns();
      return true;
    }
    if (subcommand === 'show') {
      if (!target) port.appendStatic([...formatErrorLine('usage: /agents show <root-execution-id>'), '']);
      else await port.showAgentExecution(target);
      return true;
    }
    if (subcommand === 'open') {
      if (!target) port.appendStatic([...formatErrorLine('usage: /agents open <session-or-execution-id>'), '']);
      else await port.openAgentExecution(target);
      return true;
    }
    port.appendStatic([...formatErrorLine('usage: /agents [list|runs|show <root-execution-id>|open <session-or-execution-id>]'), '']);
    return true;
  }
  if (name === 'mcp') {
    await port.showMcp();
    return true;
  }
  if (name === 'hooks') {
    const hooks = port.hooks();
    const total = hooks.lifecycle.length + hooks.preToolUse.length + hooks.postToolUse.length + hooks.sessionStart.length;
    if (total === 0) {
      port.appendStatic([
        ...formatInfoLine('no hooks configured'),
        ...formatInfoLine('open GUI Settings > Hooks or add typedHooks to ~/.hadamard/settings.json'),
        '',
      ]);
      return true;
    }
    const lines: string[] = [`${A.bold}Hooks${A.reset} ${A.dim}(${total})${A.reset}`];
    if (hooks.lifecycle.length > 0) {
      lines.push(`${A.bold}  Lifecycle${A.reset} ${A.dim}(${hooks.lifecycle.length})${A.reset}`);
      hooks.lifecycle.forEach((hook, index) => lines.push(
        `    ${A.dim}${index + 1}.${A.reset} ${A.bold}${hook.id}${A.reset} ${hook.event} ${A.dim}-> ${hook.handlerType}${A.reset}`,
      ));
    }
    hooks.issues.forEach(issue => lines.push(`    ${A.yellow}[invalid] ${issue}${A.reset}`));
    if (hooks.preToolUse.length > 0) {
      lines.push(`${A.bold}  PreToolUse${A.reset} ${A.dim}(${hooks.preToolUse.length}) — blocks tool on non-zero exit or "BLOCK" stdout${A.reset}`);
      hooks.preToolUse.forEach((hook, index) => lines.push(`    ${A.dim}${index + 1}.${A.reset} ${A.bold}${hook.matcher}${A.reset} ${A.dim}→${A.reset} ${truncateToWidth(hook.command, 50)}`));
    }
    if (hooks.postToolUse.length > 0) {
      lines.push(`${A.bold}  PostToolUse${A.reset} ${A.dim}(${hooks.postToolUse.length}) — fire-and-forget after tool completes${A.reset}`);
      hooks.postToolUse.forEach((hook, index) => lines.push(`    ${A.dim}${index + 1}.${A.reset} ${A.bold}${hook.matcher}${A.reset} ${A.dim}→${A.reset} ${truncateToWidth(hook.command, 50)}`));
    }
    if (hooks.sessionStart.length > 0) {
      lines.push(`${A.bold}  SessionStart${A.reset} ${A.dim}(${hooks.sessionStart.length}) — fire-and-forget on session init${A.reset}`);
      hooks.sessionStart.forEach((hook, index) => lines.push(`    ${A.dim}${index + 1}.${A.reset} ${A.dim}→${A.reset} ${truncateToWidth(hook.command, 50)}`));
    }
    lines.push('');
    port.appendStatic(lines);
    return true;
  }
  if (name === 'plugins') {
    await port.showPlugins();
    return true;
  }
  if (name === 'extensions' || name === 'lsp') {
    try {
      appendCommandResult(
        name === 'extensions' ? await port.extensionsCommand(args) : await port.lspCommand(),
        port,
      );
    } catch (error) {
      port.appendStatic([...formatErrorLine(errorMessage(error)), '']);
    }
    return true;
  }
  try {
    appendCommandResult(
      name === 'plugin'
        ? await port.pluginCommand(args || 'list')
        : await port.rulesCommand(args || 'list'),
      port,
    );
  } catch (error) {
    port.appendStatic([...formatErrorLine(errorMessage(error)), '']);
  }
  return true;
}
