import type { ProviderModelEntry, PersistedBridgeConfig } from '../parity/bridgeConfigs.js';

export const HADAMARD_CONTEXT_WINDOW_METADATA_KEY = '__hadamardContextWindowTokens';

export const STANDARD_CONTEXT_WINDOWS = [
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

export function modelContextWindowOptions(_entry: ProviderModelEntry | undefined): number[] {
  // Every model can select any standard window up to 2m. The declared limit
  // is ADVISORY (shown as a warning): an unsupported selection fails at the
  // provider with a clear context-length message instead of being hidden.
  return [...STANDARD_CONTEXT_WINDOWS];
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
  _entry: ProviderModelEntry | undefined,
): number {
  // Deliberately NOT clamped to the model limit: the user may select any
  // standard window (up to 2m) and gets a provider-side error with
  // guidance when the choice is unsupported (see the request-error
  // extension's context-length mismatch handling).
  return Math.max(1, Math.floor(requested));
}

export function readSessionContextWindow(
  metadata: Record<string, unknown> | undefined,
): number | undefined {
  return parseContextWindowTokens(metadata?.[HADAMARD_CONTEXT_WINDOW_METADATA_KEY]);
}
