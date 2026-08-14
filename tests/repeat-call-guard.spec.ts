import { describe, expect, it } from 'vitest';

import {
  RepeatCallGuard,
  canonicalizeToolArguments,
} from '../src/runtime/repeatCallGuard.js';

describe('canonicalizeToolArguments', () => {
  it('normalizes object key order', () => {
    const a = canonicalizeToolArguments({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalizeToolArguments({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe(JSON.stringify({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe('RepeatCallGuard', () => {
  it('injects gentle-then-detailed reminders and hard-stops at the ceiling', () => {
    const guard = new RepeatCallGuard();
    expect(guard.record('read', { path: 'x' }, true)).toEqual({});
    expect(guard.record('read', { path: 'x' }, true)).toEqual({});
    const third = guard.record('read', { path: 'x' }, true);
    expect(third.reminder).toContain('repeating the exact same tool call');
    expect(third.hardStop).toBeUndefined();
    expect(guard.record('read', { path: 'x' }, true)).toEqual({});
    const fifth = guard.record('read', { path: 'x' }, true);
    expect(fifth.reminder).toContain('Repeated tool call detected');
    expect(fifth.reminder).toContain('- tool: read');
    expect(fifth.hardStop).toBe(true);
  });

  it('resets on a different call identity or on success', () => {
    const guard = new RepeatCallGuard();
    guard.record('read', { path: 'x' }, true);
    guard.record('read', { path: 'x' }, true);
    guard.record('read', { path: 'y' }, true);
    expect(guard.record('read', { path: 'y' }, true)).toEqual({});
    guard.record('read', { path: 'y' }, false);
    expect(guard.record('read', { path: 'y' }, true)).toEqual({});
  });

  it('truncates argument previews in the detailed reminder', () => {
    const guard = new RepeatCallGuard({ argumentsPreviewChars: 10 });
    for (let index = 0; index < 4; index += 1) {
      guard.record('write', { content: 'x'.repeat(100) }, true);
    }
    const fifth = guard.record('write', { content: 'x'.repeat(100) }, true);
    expect(fifth.reminder).toContain('Repeated tool call detected');
    const preview = (fifth.reminder ?? '').split('arguments: ')[1]!.split('\n')[0]!;
    expect(preview).toContain('...');
    expect(preview.length).toBeLessThanOrEqual(13);
    expect(fifth.hardStop).toBe(true);
  });
});
