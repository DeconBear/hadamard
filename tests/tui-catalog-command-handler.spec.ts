import { describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiCatalogCommand,
  type TuiCatalogCommandPort,
} from '../src/tui/tuiCatalogCommandHandler.js';

function createPort(): TuiCatalogCommandPort & { output: string[][] } {
  const output: string[][] = [];
  return {
    output,
    showSkills: vi.fn(async () => undefined),
    showAgents: vi.fn(async () => undefined),
    showAgentRuns: vi.fn(async () => undefined),
    showAgentExecution: vi.fn(async () => undefined),
    openAgentExecution: vi.fn(async () => undefined),
    showMcp: vi.fn(async () => undefined),
    hooks: vi.fn(() => ({
      lifecycle: [{ id: 'audit', event: 'SessionStart', handlerType: 'command' }],
      issues: [],
      preToolUse: [{ matcher: 'Bash', command: 'check-command' }],
      postToolUse: [],
      sessionStart: [],
    })),
    showPlugins: vi.fn(async () => undefined),
    pluginCommand: vi.fn(async () => ({
      message: 'plugins listed',
      items: [{ label: 'plugin-a', description: 'enabled' }],
    })),
    rulesCommand: vi.fn(async () => ({ message: 'rules listed' })),
    appendStatic: lines => output.push([...lines]),
  };
}

function output(port: { output: string[][] }): string {
  return port.output.flat().map(stripAnsi).join('\n');
}

describe('runTuiCatalogCommand', () => {
  it('returns false outside the catalog command domain', async () => {
    expect(await runTuiCatalogCommand('help', '', createPort())).toBe(false);
  });

  it('delegates simple skills, MCP, and plugin catalog views', async () => {
    const port = createPort();
    await runTuiCatalogCommand('skills', '', port);
    await runTuiCatalogCommand('mcp', '', port);
    await runTuiCatalogCommand('plugins', '', port);
    expect(port.showSkills).toHaveBeenCalledOnce();
    expect(port.showMcp).toHaveBeenCalledOnce();
    expect(port.showPlugins).toHaveBeenCalledOnce();
  });

  it('routes agent list, run, show, and open subcommands', async () => {
    const port = createPort();
    await runTuiCatalogCommand('agents', 'list', port);
    await runTuiCatalogCommand('agents', 'runs', port);
    await runTuiCatalogCommand('agents', 'show root-1', port);
    await runTuiCatalogCommand('agents', 'open session-1', port);
    expect(port.showAgents).toHaveBeenCalledOnce();
    expect(port.showAgentRuns).toHaveBeenCalledOnce();
    expect(port.showAgentExecution).toHaveBeenCalledWith('root-1');
    expect(port.openAgentExecution).toHaveBeenCalledWith('session-1');
  });

  it('preserves agent subcommand validation', async () => {
    const port = createPort();
    await runTuiCatalogCommand('agents', 'show', port);
    await runTuiCatalogCommand('agents', 'unknown', port);
    expect(output(port)).toContain('usage: /agents show <root-execution-id>');
    expect(output(port)).toContain('usage: /agents [list|runs');
  });

  it('formats hook categories from a detached snapshot', async () => {
    const port = createPort();
    await runTuiCatalogCommand('hooks', '', port);
    expect(output(port)).toContain('Hooks (2)');
    expect(output(port)).toContain('audit SessionStart -> command');
    expect(output(port)).toContain('PreToolUse (1)');
  });

  it('delegates plugin and rule package commands with their arguments', async () => {
    const port = createPort();
    await runTuiCatalogCommand('plugin', 'install example', port);
    await runTuiCatalogCommand('rules', 'list', port);
    expect(port.pluginCommand).toHaveBeenCalledWith('install example');
    expect(port.rulesCommand).toHaveBeenCalledWith('list');
    expect(output(port)).toContain('plugin-a · enabled');
    expect(output(port)).toContain('rules listed');
  });
});
