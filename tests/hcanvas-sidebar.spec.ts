import { describe, expect, it } from 'vitest';
import { nextSidebarSection } from '../src/hcanvas/client/sidebarLayout.js';

describe('hcanvas sidebar navigation', () => {
  it('moves in both directions and wraps at the ends', () => {
    expect(nextSidebarSection(0, 'ArrowLeft', 5)).toBe(4);
    expect(nextSidebarSection(4, 'ArrowRight', 5)).toBe(0);
    expect(nextSidebarSection(2, 'ArrowDown', 5)).toBe(3);
    expect(nextSidebarSection(2, 'ArrowUp', 5)).toBe(1);
  });

  it('supports first and last section shortcuts', () => {
    expect(nextSidebarSection(3, 'Home', 5)).toBe(0);
    expect(nextSidebarSection(1, 'End', 5)).toBe(4);
    expect(nextSidebarSection(1, 'Enter', 5)).toBe(-1);
    expect(nextSidebarSection(0, 'ArrowLeft', 0)).toBe(-1);
  });
});
