import { describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiContextCommand,
  type TuiContextCommandPort,
} from '../src/tui/tuiContextCommandHandler.js';

function createPort(): TuiContextCommandPort & { output: string[][] } {
  const output: string[][] = [];
  return {
    output,
    configureContext: vi.fn(async () => undefined),
    contextSnapshot: vi.fn(async () => ({
      effectiveWindowTokens: 100_000,
      rawWindowTokens: 120_000,
      autoCompactTokenLimit: 90_000,
      compactSource: 'model',
      usedTokens: 20_000,
      messages: 8,
      systemPromptChars: 2400,
      toolCount: 12,
      mcpToolCount: 2,
      instructionFiles: ['AGENTS.md'],
      model: 'test-model',
      effort: 'high',
      team: 'reviewer',
      router: 'off',
      bridge: 'off',
    })),
    doctorSnapshot: vi.fn(async () => ({
      model: 'test-model',
      provider: 'openai',
      apiKey: 'set (sk-…1234)',
      workDir: 'E:/project',
      isGit: true,
      sessionId: 'session-1',
      messageCount: 8,
      permissionMode: 'default',
      toolCount: 12,
      instructionFiles: ['AGENTS.md'],
      bridgeRuntimes: ['codex'],
    })),
    appendStatic: lines => output.push([...lines]),
  };
}

function output(port: { output: string[][] }): string {
  return port.output.flat().map(stripAnsi).join('\n');
}

describe('runTuiContextCommand', () => {
  it('returns false outside context diagnostics', async () => {
    expect(await runTuiContextCommand('help', '', createPort())).toBe(false);
  });

  it('renders the same context usage breakdown', async () => {
    const port = createPort();
    await runTuiContextCommand('context', '', port);
    expect(output(port)).toContain('20% used (20.0k / 100k tokens)');
    expect(output(port)).toContain('tools           12 (2 MCP)');
    expect(output(port)).toContain('instruction files AGENTS.md');
    expect(output(port)).toContain('model=test-model · effort=high · team=reviewer');
  });

  it('routes settings modes and rejects invalid context arguments', async () => {
    const settings = createPort();
    await runTuiContextCommand('context', 'settings claude', settings);
    expect(settings.configureContext).toHaveBeenCalledWith('claude');

    const invalid = createPort();
    await runTuiContextCommand('context', 'unknown', invalid);
    expect(output(invalid)).toContain('usage: /context [settings');
  });

  it('renders diagnostics from an immutable snapshot', async () => {
    const port = createPort();
    await runTuiContextCommand('doctor', '', port);
    expect(output(port)).toContain('Hadamard diagnostics');
    expect(output(port)).toContain('api key set (sk-…1234)');
    expect(output(port)).toContain('git repo yes');
    expect(output(port)).toContain('bridge runtimes codex');
  });
});
