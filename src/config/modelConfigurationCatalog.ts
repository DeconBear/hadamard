import type {
  InProcessProvider,
  PersistedBridgeConfig,
  ProviderModelEntry,
} from '../parity/bridgeConfigs.js';

export interface DefaultModelConfiguration {
  model: string;
  provider: InProcessProvider;
  baseURL?: string;
}

export interface ModelConfigurationCatalogItem {
  id: string;
  name: string;
  source: 'default' | 'named';
  runtime: PersistedBridgeConfig['runtime'];
  execution: NonNullable<PersistedBridgeConfig['execution']>;
  provider: InProcessProvider;
  model?: string;
  models: readonly ProviderModelEntry[];
  config?: PersistedBridgeConfig;
}

export function isModelCredentialConfigured(
  environment: Readonly<Record<string, string | undefined>>,
  resolved: { apiKey?: string; authToken?: string } = {},
): boolean {
  return Boolean(
    environment.HADAMARD_API_KEY?.trim()
    || environment.HADAMARD_AUTH_TOKEN?.trim()
    || environment.ACTOVIQ_API_KEY?.trim()
    || environment.ACTOVIQ_AUTH_TOKEN?.trim()
    || resolved.apiKey?.trim()
    || resolved.authToken?.trim(),
  );
}

/**
 * Shared read model for model-configuration pickers. It deliberately contains
 * no TUI/GUI behavior; each surface decides how compactly to present it.
 */
export function buildModelConfigurationCatalog(
  defaults: DefaultModelConfiguration,
  configs: readonly PersistedBridgeConfig[],
): ModelConfigurationCatalogItem[] {
  const defaultModels = defaults.model ? [{ name: defaults.model }] : [];
  return [
    {
      id: 'default',
      name: 'default',
      source: 'default',
      runtime: 'hadamard',
      execution: 'api',
      provider: defaults.provider,
      model: defaults.model || undefined,
      models: defaultModels,
    },
    ...configs.map(config => ({
      id: `config:${config.name}`,
      name: config.name,
      source: 'named' as const,
      runtime: config.runtime,
      execution: config.execution ?? 'api',
      provider: config.provider,
      model: config.model || config.models?.[0]?.name,
      models: uniqueModels(config),
      config,
    })),
  ];
}

export function findModelConfiguration(
  catalog: readonly ModelConfigurationCatalogItem[],
  name: string,
): ModelConfigurationCatalogItem | undefined {
  const normalized = name.trim().toLowerCase();
  return catalog.find(item => (
    item.id.toLowerCase() === normalized || item.name.toLowerCase() === normalized
  ));
}

export function resolveHadamardConfigurationModel(
  config: PersistedBridgeConfig | null | undefined,
  bridgeMode: boolean,
  selectedModel?: string | null,
): string | undefined {
  if (bridgeMode || config?.runtime !== 'hadamard') return undefined;
  return selectedModel || config.model || config.models?.[0]?.name;
}

function uniqueModels(config: PersistedBridgeConfig): ProviderModelEntry[] {
  const byName = new Map<string, ProviderModelEntry>();
  if (config.model) byName.set(config.model, { name: config.model });
  for (const model of config.models ?? []) {
    if (model.name.trim()) byName.set(model.name, model);
  }
  return [...byName.values()];
}
