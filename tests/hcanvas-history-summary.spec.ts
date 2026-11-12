import { describe, expect, it } from 'vitest';
import { historyEntryLabel } from '../src/hcanvas/historySummary.js';

describe('history entry labels', () => {
  it('renders legacy raw operation counts as a readable edit label', () => {
    expect(historyEntryLabel('3 op(s)')).toBe('Canvas edit');
    expect(historyEntryLabel('1 op(s)')).toBe('Canvas edit');
  });

  it('keeps generated summaries unchanged', () => {
    expect(historyEntryLabel('Edit Markdown · Page 1')).toBe('Edit Markdown · Page 1');
    expect(historyEntryLabel('Restore revision 4')).toBe('Restore revision 4');
  });
});
