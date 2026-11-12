import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutoSave, type AutoSaveStatus } from '../src/hcanvas/client/autoSave.js';

describe('hcanvas auto-save', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces consecutive edits before saving', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const autoSave = createAutoSave({ save, onStatus: () => undefined, delay: 400 });
    autoSave.change('first');
    autoSave.change('latest');
    await vi.advanceTimersByTimeAsync(399);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('latest');
  });

  it('flushes edits made while another save is in flight', async () => {
    let release: (() => void) | undefined;
    const values: string[] = [];
    const statuses: AutoSaveStatus[] = [];
    const autoSave = createAutoSave({
      save: async value => {
        values.push(value);
        if (values.length === 1) await new Promise<void>(resolve => { release = resolve; });
      },
      onStatus: status => { statuses.push(status); },
    });
    autoSave.change('first');
    const first = autoSave.flush();
    autoSave.change('second');
    const closing = autoSave.close();
    await vi.waitFor(() => { expect(values).toEqual(['first']); });
    release?.();
    await first;
    await closing;
    expect(values).toEqual(['first', 'second']);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('stays usable after a failed close so the editor can retry', async () => {
    const values: string[] = [];
    let fail = true;
    const autoSave = createAutoSave({
      save: async value => {
        values.push(value);
        if (fail) throw new Error('offline');
      },
      onStatus: () => undefined,
    });
    autoSave.change('first');
    expect(await autoSave.close()).toBe(false);
    fail = false;
    autoSave.change('second');
    expect(await autoSave.close()).toBe(true);
    expect(values.at(-1)).toBe('second');
  });

  it('reports failures and retries only when requested', async () => {
    vi.useFakeTimers();
    const statuses: AutoSaveStatus[] = [];
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) { fail = false; throw new Error('offline'); }
    });
    const autoSave = createAutoSave({ save, onStatus: status => { statuses.push(status); }, delay: 400 });
    autoSave.change('unsaved');
    expect(await autoSave.flush()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe('error');
    expect(await autoSave.flush()).toBe(true);
  });
});
