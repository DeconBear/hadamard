import { describe, expect, it } from 'vitest';

import {
  getBuiltInExtensionDefinition,
  resolveBuiltInExtensionStates,
  type BuiltInExtensionsApi,
  type BuiltInExtensionState,
} from '../src/extensions/builtInExtensions.js';
import { runExtensionsCommandView } from '../src/ui/extensionsCommandView.js';
import { runLspCommandView } from '../src/ui/lspCommandView.js';
import type { LanguageServerStatus } from '../src/codeIntel/codeIntelligenceService.js';

function createExtensionsApi(
  settingsRaw?: Record<string, unknown>,
): BuiltInExtensionsApi {
  const states = new Map<string, BuiltInExtensionState>(
    resolveBuiltInExtensionStates(settingsRaw).map(state => [state.id, state]),
  );
  return {
    list: () => [...states.values()].map(state => ({ ...state, config: { ...state.config } })),
    isEnabled: id => states.get(id)?.enabled ?? getBuiltInExtensionDefinition(id)?.defaultEnabled ?? false,
    getConfig: id => ({ ...(states.get(id)?.config ?? {}) }),
    setEnabled: async (id, enabled) => {
      const state = states.get(id);
      if (!state) throw new Error(`Unknown built-in extension: ${id}`);
      state.enabled = enabled;
    },
  };
}

describe('runExtensionsCommandView', () => {
  it('lists all built-in extensions with state, defaults, and config summaries', async () => {
    const api = createExtensionsApi({
      extensions: {
        security: { enabled: true, protectedPaths: ['src', 'docs'] },
        notifications: { bell: false, osc: true },
      },
    });
    const result = await runExtensionsCommandView(api, '');
    expect(result.message).toContain('Built-in extensions (5)');
    const items = result.items ?? [];
    expect(items).toHaveLength(5);
    const security = items.find(item => item.label === 'Security Guard (security)');
    expect(security?.description).toContain('on · default off · policy');
    expect(security?.description).toContain('Denies catastrophic shell commands');
    expect(security?.description).toContain('protectedPaths: 2');
    const notifications = items.find(item => item.label === 'Notifications (notifications)');
    expect(notifications?.description).toContain('bell: off · osc: on');
    const usageBar = items.find(item => item.label === 'Usage Bar (usageBar)');
    expect(usageBar?.description).toContain('on · default on · ui');
  });

  it('shows one extension detail when no toggle is given', async () => {
    const api = createExtensionsApi({
      extensions: { filterOutput: { maxChars: 5000 } },
    });
    const result = await runExtensionsCommandView(api, 'filterOutput');
    expect(result.message).toContain('Output Filter (filterOutput)');
    expect(result.message).toContain('off · default off · policy');
    expect(result.message).toContain('maxChars: 5000');
    expect(result.message).toContain('toggle: /extensions filterOutput on');
  });

  it('toggles extensions on and off with kind-specific timing notes', async () => {
    const api = createExtensionsApi();
    const enabled = await runExtensionsCommandView(api, 'security on');
    expect(enabled.message).toContain('Security Guard (security) enabled');
    expect(enabled.message).toContain('policy extension; applies to subsequent agent runs');
    expect(api.isEnabled('security')).toBe(true);

    const disabled = await runExtensionsCommandView(api, 'usageBar off');
    expect(disabled.message).toContain('Usage Bar (usageBar) disabled');
    expect(disabled.message).toContain('applies immediately');
    expect(api.isEnabled('usageBar')).toBe(false);
  });

  it('parses toggle aliases case-insensitively', async () => {
    const api = createExtensionsApi();
    await runExtensionsCommandView(api, 'security ENABLE');
    expect(api.isEnabled('security')).toBe(true);
    await runExtensionsCommandView(api, 'notifications Disable');
    expect(api.isEnabled('notifications')).toBe(false);
  });

  it('rejects unknown ids with the valid id list', async () => {
    const api = createExtensionsApi();
    await expect(runExtensionsCommandView(api, 'nope on')).rejects.toThrow(
      'unknown extension: nope — valid ids: security, filterOutput, costTracker, usageBar, notifications',
    );
  });

  it('rejects invalid toggles and trailing arguments with a usage error', async () => {
    const api = createExtensionsApi();
    await expect(runExtensionsCommandView(api, 'security maybe')).rejects.toThrow('usage: /extensions <id> on|off');
    await expect(runExtensionsCommandView(api, 'security on extra')).rejects.toThrow('usage: /extensions <id> on|off');
  });
});

describe('runLspCommandView', () => {
  it('prints configuration guidance when no code intelligence service exists', async () => {
    const result = await runLspCommandView(undefined);
    expect(result.message).toContain('No language servers configured or detected.');
    expect(result.message).toContain('languageServers in ~/.hadamard/settings.json');
    expect(result.message).toContain('typescript-language-server');
    expect(result.message).toContain('pyright-langserver');
    expect(result.message).toContain('gopls');
    expect(result.message).toContain('rust-analyzer');
  });

  it('lists server status with availability and running state', async () => {
    const statuses: LanguageServerStatus[] = [
      { id: 'typescript', languages: ['typescript', 'javascript'], available: true, running: true },
      {
        id: 'python',
        languages: ['python'],
        available: false,
        reason: 'Configured command is unavailable: pyright-langserver',
        running: false,
      },
    ];
    const result = await runLspCommandView({ serverStatus: async () => statuses });
    expect(result.message).toBe('Language servers (2)');
    expect(result.items).toEqual([
      { label: 'typescript', description: 'typescript, javascript · available · running' },
      {
        label: 'python',
        description: 'python · unavailable (Configured command is unavailable: pyright-langserver) · not started',
      },
    ]);
  });
});
