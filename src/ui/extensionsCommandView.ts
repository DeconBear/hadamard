/**
 * Shared /extensions view model for the TUI and GUI slash commands: list the
 * built-in extension catalog with live state, show one extension's detail, or
 * toggle an extension via `client.builtInExtensions.setEnabled` (which also
 * persists to ~/.hadamard/settings.json).
 *
 * @module src/ui/extensionsCommandView
 */
import {
  getBuiltInExtensionDefinition,
  type BuiltInExtensionsApi,
} from '../extensions/builtInExtensions.js';

export interface ExtensionsCommandViewResult {
  message: string;
  items?: Array<{ label: string; description?: string }>;
}

function formatConfigSummary(config: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) parts.push(`${key}: ${value.length}`);
    else if (typeof value === 'boolean') parts.push(`${key}: ${value ? 'on' : 'off'}`);
    else if (typeof value === 'number') parts.push(`${key}: ${value}`);
  }
  return parts.join(' · ');
}

function parseToggle(value: string): boolean | undefined {
  const normalized = value.toLowerCase();
  if (normalized === 'on' || normalized === 'enable') return true;
  if (normalized === 'off' || normalized === 'disable') return false;
  return undefined;
}

function describeState(enabled: boolean, defaultEnabled: boolean, kind: string): string {
  return `${enabled ? 'on' : 'off'} · default ${defaultEnabled ? 'on' : 'off'} · ${kind}`;
}

export async function runExtensionsCommandView(
  extensions: BuiltInExtensionsApi,
  args: string,
): Promise<ExtensionsCommandViewResult> {
  const [id = '', toggle = '', ...rest] = args.trim().split(/\s+/u).filter(Boolean);
  const validIds = extensions.list().map(state => state.id).join(', ');
  if (id && !getBuiltInExtensionDefinition(id)) {
    throw new Error(`unknown extension: ${id} — valid ids: ${validIds}`);
  }
  if (!id) {
    const states = extensions.list();
    return {
      message: `Built-in extensions (${states.length}) — toggle with /extensions <id> on|off`,
      items: states.map(state => {
        const definition = getBuiltInExtensionDefinition(state.id)!;
        const configSummary = formatConfigSummary(extensions.getConfig(state.id));
        return {
          label: `${definition.title} (${state.id})`,
          description: [
            describeState(state.enabled, definition.defaultEnabled, definition.kind),
            definition.description,
            ...(configSummary ? [`config: ${configSummary}`] : []),
          ].join(' — '),
        };
      }),
    };
  }
  const definition = getBuiltInExtensionDefinition(id)!;
  if (!toggle) {
    const state = extensions.list().find(item => item.id === id)!;
    const configSummary = formatConfigSummary(extensions.getConfig(id));
    return {
      message: [
        `${definition.title} (${id}) — ${describeState(state.enabled, definition.defaultEnabled, definition.kind)}`,
        definition.description,
        ...(configSummary
          ? [`config: ${configSummary}`]
          : [definition.configurableKeys.length > 0 ? 'config: defaults (no overrides)' : 'no configurable keys']),
        `toggle: /extensions ${id} ${state.enabled ? 'off' : 'on'}`,
      ].join('\n'),
    };
  }
  const enabled = rest.length === 0 ? parseToggle(toggle) : undefined;
  if (enabled === undefined) {
    throw new Error(`usage: /extensions <id> on|off — valid ids: ${validIds}`);
  }
  await extensions.setEnabled(id, enabled);
  const timing = definition.kind === 'policy'
    ? 'policy extension; applies to subsequent agent runs'
    : 'applies immediately';
  return { message: `${definition.title} (${id}) ${enabled ? 'enabled' : 'disabled'} — ${timing}` };
}
