import {
  buildModelConfigurationCatalog,
  findModelConfiguration,
} from '../config/modelConfigurationCatalog.js';
import {
  readBridgeConfigs,
  type InProcessProvider,
  type PersistedBridgeConfig,
} from '../parity/bridgeConfigs.js';
import type {
  HadamardPermissionMode,
  HadamardPermissionRule,
} from '../types.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';
import type { TuiSelectionItem } from './selection.js';

export interface TuiConfigurationCommandPort {
  defaultModel(): { model: string; provider: InProcessProvider; baseURL?: string };
  sessionModel(): string;
  setSessionModel(model: string): Promise<void>;
  disableBridge(): Promise<void>;
  activateBridgeConfig(config: PersistedBridgeConfig): Promise<unknown>;
  activeBridgeConfigName(): string | undefined;
  bridgeModelLabel(): string | null;
  chooseModel(): Promise<void>;
  configureContextWindow(value?: string): Promise<void>;
  configureModelSettings(): Promise<void>;
  chooseRouter(arg: string): Promise<void>;
  chooseEffort(): Promise<void>;
  setEffort(value: string): Promise<void>;
  chooseAgentMode(): Promise<void>;
  currentPermissionMode(): HadamardPermissionMode;
  setPermissionContext(
    mode: HadamardPermissionMode,
    permissions: HadamardPermissionRule[],
  ): Promise<void>;
  selectItem(options: {
    title: string;
    subtitle?: string;
    items: TuiSelectionItem[];
  }): Promise<string | undefined>;
  appendStatic(lines: readonly string[]): void;
}

export async function runTuiConfigurationCommand(
  name: string,
  args: string,
  port: TuiConfigurationCommandPort,
): Promise<boolean> {
  switch (name) {
    case 'model': {
      if (!args) {
        await port.chooseModel();
        return true;
      }
      if (args === 'config') {
        await port.configureModelSettings();
        return true;
      }
      if (args === 'context' || args.startsWith('context ')) {
        await port.configureContextWindow(args.slice('context'.length).trim() || undefined);
        return true;
      }
      if (args === 'router' || args.startsWith('router ')) {
        await port.chooseRouter(args.slice('router'.length).trim());
        return true;
      }
      if (args === 'custom' || args.startsWith('custom ')) {
        const customModel = args.slice('custom'.length).trim();
        if (!customModel) {
          port.appendStatic([...formatErrorLine('usage: /model custom <model-id>'), '']);
          return true;
        }
        await port.disableBridge();
        await port.setSessionModel(customModel);
        await port.configureContextWindow();
        port.appendStatic([...formatInfoLine(`custom model: ${port.sessionModel()}`), '']);
        return true;
      }
      const defaults = port.defaultModel();
      const catalog = buildModelConfigurationCatalog(defaults, readBridgeConfigs().configs);
      let config = findModelConfiguration(catalog, args);
      let explicitModel: string | undefined;
      if (!config) {
        const tokens = args.split(/\s+/u).filter(Boolean);
        for (let index = tokens.length - 1; index >= 1; index -= 1) {
          const candidate = tokens.slice(0, index).join(' ');
          const match = findModelConfiguration(catalog, candidate);
          if (match) {
            config = match;
            explicitModel = tokens.slice(index).join(' ');
            break;
          }
        }
      }
      if (!config) {
        port.appendStatic([
          ...formatErrorLine(`unknown model configuration: ${args}`),
          ...formatInfoLine('Use /model to choose one, or /model custom <model-id>.'),
          '',
        ]);
        return true;
      }
      if (config.source === 'default') {
        await port.disableBridge();
        await port.setSessionModel(explicitModel || defaults.model);
        await port.configureContextWindow();
        port.appendStatic([...formatInfoLine(`model configuration: default · ${port.sessionModel()}`), '']);
        return true;
      }
      if (!config.config) return true;
      let selectedConfig = { ...config.config, model: config.model };
      if (explicitModel) {
        selectedConfig = { ...selectedConfig, model: explicitModel };
      } else if (config.models.length > 1) {
        const model = await port.selectItem({
          title: config.name,
          subtitle: 'Select a model from this configuration',
          items: config.models.map(item => ({
            id: item.name,
            label: item.name,
            description: item.modality ?? 'text',
          })),
        });
        if (!model) return true;
        selectedConfig = { ...selectedConfig, model };
      }
      await port.activateBridgeConfig(selectedConfig);
      await port.configureContextWindow();
      port.appendStatic([
        ...formatInfoLine(`model configuration: ${port.activeBridgeConfigName() ?? config.name} · ${port.bridgeModelLabel() ?? port.sessionModel()}`),
        '',
      ]);
      return true;
    }
    case 'effort':
      if (!args) await port.chooseEffort();
      else await port.setEffort(args.toLowerCase());
      return true;
    case 'mode':
      await port.chooseAgentMode();
      return true;
    case 'permissions': {
      const readonlyDeny = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'PowerShell'];
      const presets: Record<string, {
        mode: HadamardPermissionMode;
        rules: HadamardPermissionRule[];
        label: string;
      }> = {
        'read-only': {
          mode: 'default',
          rules: readonlyDeny.map(toolName => ({
            toolName,
            behavior: 'deny',
            source: 'permissions-preset',
          })),
          label: 'Read-only',
        },
        workspace: { mode: 'acceptEdits', rules: [], label: 'Workspace access' },
        full: { mode: 'bypassPermissions', rules: [], label: 'Full access' },
      };
      let key = args.trim().toLowerCase().replace(/[ _]/g, '-');
      if (!key) {
        const choice = await port.selectItem({
          title: 'Permission mode',
          subtitle: `current: ${port.currentPermissionMode()}`,
          items: [
            { id: 'read-only', label: 'Read-only', description: 'Read, search, and web only — deny Write/Edit/Bash/NotebookEdit/PowerShell' },
            { id: 'workspace', label: 'Workspace access', description: 'Auto-accept edits in the workspace (acceptEdits)' },
            { id: 'full', label: 'Full access', description: 'No prompts — run any tool (bypassPermissions)' },
          ],
        });
        if (!choice) return true;
        key = choice;
      }
      const preset = presets[key];
      if (!preset) {
        port.appendStatic([...formatErrorLine(`unknown permission preset: ${key} (read-only | workspace | full)`), '']);
        return true;
      }
      await port.setPermissionContext(preset.mode, preset.rules);
      port.appendStatic([
        ...formatInfoLine(`permissions: ${preset.label} — ${preset.mode}${preset.rules.length ? ` · ${preset.rules.length} deny rules` : ''}`),
        '',
      ]);
      return true;
    }
    default:
      return false;
  }
}
