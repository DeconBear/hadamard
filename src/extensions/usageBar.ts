/**
 * Usage bar (built-in `usageBar` extension): formats the live context/token
 * usage segment for interactive surfaces (TUI mode line, GUI statusbar).
 * Example: `ctx [██████░░░░] 45% (90.2k) · $0.0234 · ↑120.1k ↓8.4k`.
 *
 * @module src/extensions/usageBar
 */

export interface FormatUsageBarInput {
  contextUsedTokens: number;
  contextWindowTokens: number;
  /** Session cost; segment omitted when undefined (unknown pricing / disabled). */
  sessionCostUsd?: number;
  /** Session input tokens; segment omitted when undefined. */
  inputTokens?: number;
  /** Session output tokens; segment omitted when undefined. */
  outputTokens?: number;
  /** Bar width in cells. Default 10. */
  width?: number;
}

export type UsageBarColorLevel = 'ok' | 'warn' | 'critical';

const FULL_BLOCK = '█';
const EMPTY_BLOCK = '░';

/** Compact token count: `842` → `842`, `90_200` → `90.2k`. */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.max(0, Math.round(value));
  return rounded >= 1000 ? `${(rounded / 1000).toFixed(1)}k` : `${rounded}`;
}

/** Matches the TUI mode-line thresholds: 70% warn, 90% critical. */
export function usageBarColorLevel(pct: number): UsageBarColorLevel {
  if (pct >= 90) return 'critical';
  if (pct >= 70) return 'warn';
  return 'ok';
}

/**
 * Percentage of the context window used (0–100). Returns 0 when the window is
 * unknown/zero so callers can render without a bar.
 */
export function usageBarPercent(usedTokens: number, windowTokens: number): number {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return 0;
  return Math.min(100, Math.round((Math.max(0, usedTokens) / windowTokens) * 100));
}

export function formatUsageBar(input: FormatUsageBarInput): string {
  const segments: string[] = [];
  const used = Math.max(0, Math.round(input.contextUsedTokens));
  const window = input.contextWindowTokens;
  if (Number.isFinite(window) && window > 0) {
    const pct = usageBarPercent(used, window);
    const width = Math.max(1, Math.floor(input.width ?? 10));
    const filled = Math.round((pct / 100) * width);
    const bar = FULL_BLOCK.repeat(filled) + EMPTY_BLOCK.repeat(width - filled);
    segments.push(`ctx [${bar}] ${pct}% (${formatTokenCount(used)})`);
  } else {
    segments.push(`ctx ${formatTokenCount(used)}`);
  }
  if (typeof input.sessionCostUsd === 'number' && Number.isFinite(input.sessionCostUsd)) {
    segments.push(`$${input.sessionCostUsd.toFixed(4)}`);
  }
  const tokenSegments: string[] = [];
  if (typeof input.inputTokens === 'number' && Number.isFinite(input.inputTokens)) {
    tokenSegments.push(`↑${formatTokenCount(input.inputTokens)}`);
  }
  if (typeof input.outputTokens === 'number' && Number.isFinite(input.outputTokens)) {
    tokenSegments.push(`↓${formatTokenCount(input.outputTokens)}`);
  }
  if (tokenSegments.length > 0) segments.push(tokenSegments.join(' '));
  return segments.join(' · ');
}
