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
    extensionsCommand: vi.fn(async (commandArgs: string) => ({
      message: commandArgs ? `extensions ${commandArgs}` : 'extensions listed',
    })),
    lspCommand: vi.fn(async () => ({
      message: 'Language servers (1)',
      items: [{ label: 'typescript', description: 'available · running' }],
    })),
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

  it('routes extensions list/toggle and lsp status to their port commands', async () => {
    const port = createPort();
    expect(await runTuiCatalogCommand('extensions', '', port)).toBe(true);
    expect(await runTuiCatalogCommand('extensions', 'security on', port)).toBe(true);
    expect(await runTuiCatalogCommand('lsp', '', port)).toBe(true);
    expect(port.extensionsCommand).toHaveBeenNthCalledWith(1, '');
    expect(port.extensionsCommand).toHaveBeenNthCalledWith(2, 'security on');
    expect(port.lspCommand).toHaveBeenCalledOnce();
    expect(output(port)).toContain('extensions listed');
    expect(output(port)).toContain('extensions security on');
    expect(output(port)).toContain('Language servers (1)');
    expect(output(port)).toContain('typescript · available · running');
  });

  it('renders extensions and lsp failures as inline errors', async () => {
    const port = createPort();
    port.extensionsCommand = vi.fn(async () => {
      throw new Error('unknown extension: foo — valid ids: security, filterOutput');
    });
    port.lspCommand = vi.fn(async () => {
      throw new Error('status failed');
    });
    await runTuiCatalogCommand('extensions', 'foo on', port);
    await runTuiCatalogCommand('lsp', '', port);
    expect(output(port)).toContain('unknown extension: foo — valid ids: security, filterOutput');
    expect(output(port)).toContain('status failed');
  });
});
