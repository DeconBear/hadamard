import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  HADAMARD_INTERACTIVE_COMMANDS,
  SUBCOMMANDS,
} from '../src/ui/commandSurface.js';

const root = new URL('../', import.meta.url);

async function readTuiSources(): Promise<string> {
  return (await Promise.all([
    readFile(new URL('src/tui/hadamardTui.ts', root), 'utf8'),
    readFile(new URL('src/tui/hadamardTuiController.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiTextPresenter.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiSystemPrompt.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiRuntimeLifecycle.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiFramePresenter.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiInputController.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiMemoryCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiConfigurationCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiBasicCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiPlanCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiSessionCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiWorkflowCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiWorktreeCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiBridgeCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiTeamCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiIssueCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiAssistantCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiManagerCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiWorkspaceCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiContextCommandHandler.ts', root), 'utf8'),
    readFile(new URL('src/tui/tuiCatalogCommandHandler.ts', root), 'utf8'),
  ])).join('\n');
}

async function readGuiSources(): Promise<string> {
  return (await Promise.all([
    readFile(new URL('src/gui/hadamardGui.ts', root), 'utf8'),
    readFile(new URL('src/gui/hadamardGuiAssets.ts', root), 'utf8'),
    readFile(new URL('src/gui/guiHttpRouter.ts', root), 'utf8'),
    readFile(new URL('src/gui/guiShellHttpController.ts', root), 'utf8'),
    readFile(new URL('src/gui/guiChatHttpController.ts', root), 'utf8'),
    readFile(new URL('src/gui/guiSettingsHttpController.ts', root), 'utf8'),
    readFile(new URL('src/gui/guiTeamHttpController.ts', root), 'utf8'),
    readFile(new URL('src/gui/guiAgentHttpController.ts', root), 'utf8'),
  ])).join('\n');
}

function commandCase(
  source: string,
  marker: string,
  indent: string,
  command: string,
): string {
  const handlerStart = source.indexOf(marker);
  expect(handlerStart, `${marker} exists`).toBeGreaterThanOrEqual(0);
  const lines = source.slice(handlerStart).split(/\r?\n/u);
  const start = lines.findIndex(line => line.trimStart().startsWith(`case '${command}'`));
  if (start < 0) {
    const guardedHandler = lines.findIndex(line => line.includes(`name !== '${command}'`));
    expect(guardedHandler, `/${command} handler exists`).toBeGreaterThanOrEqual(0);
    return lines.slice(guardedHandler).join('\n');
  }
  const next = lines.slice(start + 1).findIndex(line => {
    const trimmed = line.trimStart();
    return trimmed.startsWith("case '") || trimmed.startsWith('default:');
  });
  return lines.slice(start, next === -1 ? undefined : start + 1 + next).join('\n');
}

describe('interactive CLI convergence', () => {
  it('publishes hadamard and actoviq as aliases for the TUI entry point', async () => {
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      bin: Record<string, string>;
    };

    expect(pkg.bin['hadamard-tui']).toBe('./bin/hadamard-tui.js');
    expect(pkg.bin.hadamard).toBe('./bin/hadamard-tui.js');
    expect(pkg.bin.actoviq).toBe('./bin/hadamard-tui.js');
    expect(pkg.bin).not.toHaveProperty('hadamard-react');
    expect(pkg.bin).not.toHaveProperty('hadamard-interactive-agent');
    await expect(access(new URL('src/cli/hadamard-react.ts', root))).rejects.toThrow();
    await expect(access(new URL('src/cli/bridge-interactive-agent.ts', root))).rejects.toThrow();
    await expect(access(new URL('bin/hadamard-react.js', root))).rejects.toThrow();
    await expect(access(new URL('bin/hadamard-interactive-agent.js', root))).rejects.toThrow();
  });

  it('keeps every shared top-level and second-level command wired in TUI and GUI', async () => {
    const [tui, gui] = await Promise.all([
      readTuiSources(),
      readGuiSources(),
    ]);

    const tuiCases = new Map(Object.keys(HADAMARD_INTERACTIVE_COMMANDS).map(command => [
      command,
      commandCase(tui, 'async function runSlashCommand(raw: string)', '        ', command),
    ]));
    const guiCases = new Map(Object.keys(HADAMARD_INTERACTIVE_COMMANDS).map(command => [
      command,
      commandCase(gui, 'async function runSlashCommand(raw: string)', '      ', command),
    ]));
    const browserRouted = new Map([
      ['issues:start', "input.match(/^\\/issues\\s+start"],
      ['manager:chat', `input.startsWith('/manager chat ')`],
      ['manager:update', `input.startsWith('/manager update ')`],
      ['manager:team', `input.startsWith('/manager team ')`],
      ['assistant:chat', `input.startsWith('/assistant chat ')`],
      ['assistant:team', `input.startsWith('/assistant team ')`],
    ]);
    for (const [command, subcommands] of Object.entries(SUBCOMMANDS)) {
      const tuiCase = tuiCases.get(command)!;
      const guiCase = guiCases.get(command)!;
      if (command === 'plugin' || command === 'rules') {
        expect(tuiCase, `TUI /${command} delegates its argument`).toContain(
          command === 'plugin'
            ? "port.pluginCommand(args || 'list')"
            : "port.rulesCommand(args || 'list')",
        );
        expect(guiCase, `GUI /${command} delegates its argument`).toContain(".execute(args || 'list')");
        continue;
      }
      if (command === 'memory') {
        expect(tuiCase).toContain('port.runMemoryCommand');
        expect(tui).toContain('HadamardMemoryCommandService');
        expect(guiCase).toContain('HadamardMemoryCommandService');
        expect(tuiCase).toContain("args || 'status'");
        expect(guiCase).toContain(".execute(args || 'status')");
        continue;
      }
      if (command === 'dream') {
        expect(tuiCase).toContain('runDreamCommand(action.toLowerCase(), port)');
        expect(tui).toContain("if (action === 'status')");
        expect(tui).toContain("if (action !== 'run')");
      }
      if (command === 'permissions') {
        expect(guiCase).toContain('setPermissionPreset(args.toLowerCase()');
        expect(gui).toContain("'read-only': {");
        expect(gui).toContain("workspace: { mode: 'acceptEdits'");
        expect(gui).toContain("full: { mode: 'bypassPermissions'");
      }
      for (const subcommand of subcommands) {
        const token = new RegExp(`(?:['"]${subcommand}(?:\\s|['"])|\\b${subcommand}\\s*:)`, 'u');
        if (command !== 'dream') {
          expect(tuiCase, `TUI /${command} ${subcommand}`).toMatch(token);
        }
        const browserRoute = browserRouted.get(`${command}:${subcommand}`);
        if (browserRoute) {
          expect(gui, `GUI /${command} ${subcommand} is routed by the browser command dispatcher`)
            .toContain(browserRoute);
        } else if (command !== 'permissions') {
          expect(guiCase, `GUI /${command} ${subcommand}`).toMatch(token);
        }
      }
    }
  });

  it('creates Automation targets from Agent-page workflows on both interactive surfaces', async () => {
    const [tui, gui] = await Promise.all([
      readTuiSources(),
      readGuiSources(),
    ]);
    const tuiAutomation = commandCase(tui, 'async function runSlashCommand(raw: string)', '        ', 'automation');
    const guiAutomation = commandCase(gui, 'async function runSlashCommand(raw: string)', '      ', 'automation');

    expect(tuiAutomation).toContain("team.definition.squadType === 'workflow'");
    expect(tuiAutomation).toContain("workflowSource = 'agent'");
    expect(tuiAutomation).toContain('upsertScheduledAutomationTask');
    expect(guiAutomation).toContain("args === 'new'");
    expect(gui).toContain("trimmed === '/automation list'");
    expect(gui).toContain("trimmed === '/automation new'");
  });
});
