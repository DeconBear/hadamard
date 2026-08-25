import { describe, expect, it } from 'vitest';

import {
  formatTokenCount,
  formatUsageBar,
  usageBarColorLevel,
  usageBarPercent,
} from '../src/extensions/usageBar.js';

describe('formatTokenCount', () => {
  it('formats small counts as-is and large counts in k', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(842)).toBe('842');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(90_200)).toBe('90.2k');
    expect(formatTokenCount(120_100)).toBe('120.1k');
  });
});

describe('formatUsageBar', () => {
  it('renders bar, pct, cost, and token segments', () => {
    const text = formatUsageBar({
      contextUsedTokens: 90_200,
      contextWindowTokens: 200_000,
      sessionCostUsd: 0.0234,
      inputTokens: 120_100,
      outputTokens: 8_400,
    });
    expect(text).toBe('ctx [█████░░░░░] 45% (90.2k) · $0.0234 · ↑120.1k ↓8.4k');
  });

  it('omits the cost segment when sessionCostUsd is undefined', () => {
    const text = formatUsageBar({
      contextUsedTokens: 90_200,
      contextWindowTokens: 200_000,
      inputTokens: 100,
    });
    expect(text).toBe('ctx [█████░░░░░] 45% (90.2k) · ↑100');
    expect(text).not.toContain('$');
  });

  it('omits token segments when undefined', () => {
    const text = formatUsageBar({ contextUsedTokens: 50, contextWindowTokens: 100 });
    expect(text).toBe('ctx [█████░░░░░] 50% (50)');
  });

  it('renders without bar or pct when the window is 0/invalid', () => {
    expect(formatUsageBar({ contextUsedTokens: 90_200, contextWindowTokens: 0 }))
      .toBe('ctx 90.2k');
    expect(formatUsageBar({
      contextUsedTokens: 100,
      contextWindowTokens: Number.NaN,
      sessionCostUsd: 0.5,
    })).toBe('ctx 100 · $0.5000');
  });

  it('clamps the bar at 100% when usage exceeds the window', () => {
    const text = formatUsageBar({ contextUsedTokens: 300, contextWindowTokens: 200 });
    expect(text).toBe('ctx [██████████] 100% (300)');
  });

  it('honors a custom bar width', () => {
    const text = formatUsageBar({ contextUsedTokens: 45, contextWindowTokens: 100, width: 20 });
    expect(text).toBe('ctx [█████████░░░░░░░░░░░] 45% (45)');
  });

  it('shows the active budget state when supplied', () => {
    const text = formatUsageBar({
      contextUsedTokens: 45,
      contextWindowTokens: 100,
      budgetRemainingPercent: 12,
      budgetState: 'warn',
    });
    expect(text).toBe('ctx [█████░░░░░] 45% (45) · budget 12% left !');
  });
});

describe('usageBarColorLevel', () => {
  it('applies the 70/90 thresholds', () => {
    expect(usageBarColorLevel(0)).toBe('ok');
    expect(usageBarColorLevel(69)).toBe('ok');
    expect(usageBarColorLevel(70)).toBe('warn');
    expect(usageBarColorLevel(89)).toBe('warn');
    expect(usageBarColorLevel(90)).toBe('critical');
    expect(usageBarColorLevel(100)).toBe('critical');
  });
});

describe('usageBarPercent', () => {
  it('rounds and clamps the percentage', () => {
    expect(usageBarPercent(45, 100)).toBe(45);
    expect(usageBarPercent(150, 100)).toBe(100);
    expect(usageBarPercent(10, 0)).toBe(0);
    expect(usageBarPercent(10, Number.NaN)).toBe(0);
  });
});
