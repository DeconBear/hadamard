import { describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiConfigurationCommand,
  type TuiConfigurationCommandPort,
} from '../src/tui/tuiConfigurationCommandHandler.js';

function createPort(): TuiConfigurationCommandPort & { output: string[][] } {
  const output: string[][] = [];
  let model = 'default-model';
  return {
    output,
    defaultModel: () => ({ model: 'default-model', provider: 'anthropic' }),
    sessionModel: () => model,
    setSessionModel: vi.fn(async value => { model = value; }),
    disableBridge: vi.fn(async () => undefined),
    activateBridgeConfig: vi.fn(async () => undefined),
    activeBridgeConfigName: () => undefined,
    bridgeModelLabel: () => null,
    chooseModel: vi.fn(async () => undefined),
    configureContextWindow: vi.fn(async () => undefined),
    configureModelSettings: vi.fn(async () => undefined),
    chooseRouter: vi.fn(async () => undefined),
    chooseEffort: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    chooseAgentMode: vi.fn(async () => undefined),
  chooseToolPresentation: vi.fn(async () => undefined),
    currentPermissionMode: () => 'default',
    setPermissionContext: vi.fn(async () => undefined),
    selectItem: vi.fn(async () => undefined),
    appendStatic: lines => output.push([...lines]),
  };
}

describe('runTuiConfigurationCommand', () => {
  it('keeps the bare model command as the configuration picker', async () => {
    const port = createPort();
    expect(await runTuiConfigurationCommand('model', '', port)).toBe(true);
    expect(port.chooseModel).toHaveBeenCalledTimes(1);
  });

  it('supports explicit custom models without a configuration', async () => {
    const port = createPort();
    await runTuiConfigurationCommand('model', 'custom vendor/model-x', port);

    expect(port.disableBridge).toHaveBeenCalledTimes(1);
    expect(port.setSessionModel).toHaveBeenCalledWith('vendor/model-x');
    expect(port.configureContextWindow).toHaveBeenCalledTimes(1);
    expect(port.output.flat().map(stripAnsi).join('\n')).toContain('custom model: vendor/model-x');
  });

  it('applies permission presets through the permission port', async () => {
    const port = createPort();
    await runTuiConfigurationCommand('permissions', 'read only', port);

    expect(port.setPermissionContext).toHaveBeenCalledWith(
      'default',
      expect.arrayContaining([
        expect.objectContaining({ toolName: 'Write', behavior: 'deny' }),
        expect.objectContaining({ toolName: 'Bash', behavior: 'deny' }),
      ]),
    );
    expect(port.output.flat().map(stripAnsi).join('\n')).toContain('permissions: Read-only');
  });

  it('applies the approve-for-me preset', async () => {
    const port = createPort();
    await runTuiConfigurationCommand('permissions', 'approve-for-me', port);

    expect(port.setPermissionContext).toHaveBeenCalledWith('approveForMe', []);
    expect(port.output.flat().map(stripAnsi).join('\n')).toContain('permissions: Approve for me');
  });

  it('warns once before enabling full access', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const home = mkdtempSync(path.join(tmpdir(), 'hadamard-permissions-'));
    const previousHome = process.env.HADAMARD_HOME;
    process.env.HADAMARD_HOME = home;
    try {
      const first = createPort();
      await runTuiConfigurationCommand('permissions', 'full', first);
      const firstOutput = first.output.flat().map(stripAnsi).join('\n');
      expect(first.setPermissionContext).toHaveBeenCalledWith('bypassPermissions', []);
      expect(firstOutput).toContain('WARNING:');
      expect(firstOutput).toContain('Full access runs every command without asking');

      const second = createPort();
      await runTuiConfigurationCommand('permissions', 'full', second);
      expect(second.output.flat().map(stripAnsi).join('\n')).not.toContain('WARNING:');
    } finally {
      if (previousHome === undefined) delete process.env.HADAMARD_HOME;
      else process.env.HADAMARD_HOME = previousHome;
    }
  });

  it('routes model context selection through the shared model command', async () => {
    const port = createPort();
    await runTuiConfigurationCommand('model', 'context 128k', port);
    expect(port.configureContextWindow).toHaveBeenCalledWith('128k');
  });

  it('opens the shared ReAct and CodeAct mode selector', async () => {
    const port = createPort();
    expect(await runTuiConfigurationCommand('mode', '', port)).toBe(true);
    expect(port.chooseAgentMode).toHaveBeenCalledTimes(1);
  });

  it('returns false for commands outside configuration', async () => {
    expect(await runTuiConfigurationCommand('help', '', createPort())).toBe(false);
  });
});
