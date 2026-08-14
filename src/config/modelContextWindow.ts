import type { ProviderModelEntry, PersistedBridgeConfig } from '../parity/bridgeConfigs.js';

export const HADAMARD_CONTEXT_WINDOW_METADATA_KEY = '__hadamardContextWindowTokens';

const STANDARD_CONTEXT_WINDOWS = [
  16_000,
  32_000,
  64_000,
  128_000,
  200_000,
  256_000,
  384_000,
  400_000,
  1_000_000,
  2_000_000,
] as const;

export function parseContextWindowTokens(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replaceAll(',', '');
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/u.exec(normalized);
  if (!match) return undefined;
  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  const tokens = Number(match[1]) * multiplier;
  return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : undefined;
}

export function formatContextWindowTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return tokens.toLocaleString('en-US');
}

export function modelContextWindowLimit(entry: ProviderModelEntry | undefined): number | undefined {
  return entry?.maxContextWindowTokens ?? entry?.contextWindowTokens;
}

export function modelContextWindowOptions(entry: ProviderModelEntry | undefined): number[] {
  const limit = modelContextWindowLimit(entry);
  if (!limit) return [...STANDARD_CONTEXT_WINDOWS];
  return [...new Set([
    ...STANDARD_CONTEXT_WINDOWS.filter(value => value <= limit),
    entry?.contextWindowTokens,
    entry?.maxContextWindowTokens,
    limit,
  ].filter((value): value is number => typeof value === 'number' && value > 0 && value <= limit))]
    .sort((left, right) => left - right);
}

export function resolveModelContextEntry(
  model: string,
  configs: readonly PersistedBridgeConfig[],
  preferredConfig?: PersistedBridgeConfig | null,
): ProviderModelEntry | undefined {
  const normalized = model.trim().toLowerCase();
  const candidates = preferredConfig ? [preferredConfig, ...configs] : configs;
  for (const config of candidates) {
    const found = config.models?.find(entry => entry.name.trim().toLowerCase() === normalized);
    if (found) return found;
    if (config.model?.trim().toLowerCase() === normalized) {
      return { name: config.model };
    }
  }
  return undefined;
}

export function clampContextWindowTokens(
  requested: number,
  entry: ProviderModelEntry | undefined,
): number {
  const normalized = Math.max(1, Math.floor(requested));
  const limit = modelContextWindowLimit(entry);
  return limit ? Math.min(normalized, limit) : normalized;
}

export function readSessionContextWindow(
  metadata: Record<string, unknown> | undefined,
): number | undefined {
  return parseContextWindowTokens(metadata?.[HADAMARD_CONTEXT_WINDOW_METADATA_KEY]);
}
