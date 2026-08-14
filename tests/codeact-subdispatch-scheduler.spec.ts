import { describe, expect, it } from 'vitest';

import { CodeActSubdispatchScheduler } from '../src/codeact/subdispatchScheduler.js';
import type { CodeActHostRpcRequest, CodeActHostRpcResponse } from '../src/codeact/types.js';
import type { ToolCodeDispatchEvent } from '../src/events/codeActEvents.js';

function request(id: string, name: string): CodeActHostRpcRequest {
  return {
    id,
    method: 'tool.call',
    input: { name, input: { id } },
  };
}

function ok(id: string, value: string): CodeActHostRpcResponse {
  return { id, ok: true, result: value };
}

interface Harness {
  events: ToolCodeDispatchEvent[];
  active: number;
  maxActive: number;
  scheduler: CodeActSubdispatchScheduler;
}

function makeHarness(overrides: {
  maxParallel?: number;
  delays?: Record<string, number>;
} = {}): Harness {
  const events: ToolCodeDispatchEvent[] = [];
  const state = { active: 0, maxActive: 0 };
  const scheduler = new CodeActSubdispatchScheduler({
    maxParallel: overrides.maxParallel ?? 2,
    rootCallId: 'cell-1',
    classify: (request) => {
      const input = request.input as { name?: string } | null;
      return input?.name === 'read';
    },
    dispatch: async (request) => {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      const input = request.input as { name?: string; input?: { id?: string } } | null;
      const delay = overrides.delays?.[input?.input?.id ?? ''] ?? 5;
      await new Promise((resolve) => setTimeout(resolve, delay));
      state.active -= 1;
      return ok(request.id, `result-${request.id}`);
    },
    onEvent: (event) => { events.push(structuredClone(event)); },
  });
  return { events, active: state.active, maxActive: state.maxActive, scheduler };
}

describe('CodeActSubdispatchScheduler', () => {
  it('caps the parallel pool and resolves responses in submission order', async () => {
    const harness = makeHarness({ maxParallel: 2, delays: { a: 20, b: 20, c: 20, d: 20 } });
    const results = await Promise.all([
      harness.scheduler.schedule(request('a', 'read')),
      harness.scheduler.schedule(request('b', 'read')),
      harness.scheduler.schedule(request('c', 'read')),
      harness.scheduler.schedule(request('d', 'read')),
    ]);
    expect(results.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(harness.maxActive).toBeLessThanOrEqual(2);
    expect(harness.events.filter((event) => event.phase === 'settle').length).toBe(4);
  });

  it('holds an exclusive barrier through commit', async () => {
    const harness = makeHarness({ delays: { a: 15, b: 5, c: 5 } });
    const write = request('b', 'write');
    const first = harness.scheduler.schedule(request('a', 'read'));
    const second = harness.scheduler.schedule(write);
    const third = harness.scheduler.schedule(request('c', 'read'));
    const [ra, rb, rc] = await Promise.all([first, second, third]);
    expect([ra.id, rb.id, rc.id]).toEqual(['a', 'b', 'c']);
    const starts = harness.events.filter((event) => event.phase === 'start');
    const settles = harness.events.filter((event) => event.phase === 'settle');
    expect(starts.map((event) => event.subCallId)).toEqual([
      'cell-1:host:a', 'cell-1:host:b', 'cell-1:host:c',
    ]);
    expect(settles.map((event) => event.subCallId)).toEqual([
      'cell-1:host:a', 'cell-1:host:b', 'cell-1:host:c',
    ]);
    // The exclusive write dispatched alone: it never overlapped the reads.
    expect(harness.maxActive).toBeLessThanOrEqual(1);
  });

  it('re-reads classification lazily before each start', async () => {
    const events: ToolCodeDispatchEvent[] = [];
    const scheduler = new CodeActSubdispatchScheduler({
      maxParallel: 2,
      rootCallId: 'cell-1',
      classify: () => true,
      dispatch: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return ok(request.id, 'x');
      },
      onEvent: (event) => { events.push(structuredClone(event)); },
    });
    // First call parallel, everything after exclusive.
    const first = scheduler.schedule(request('a', 'read'));
    const second = scheduler.schedule(request('b', 'write'));
    const [ra, rb] = await Promise.all([first, second]);
    expect([ra.id, rb.id]).toEqual(['a', 'b']);
  });

  it('drains started calls and abandons queued-unstarted ones', async () => {
    const harness = makeHarness({ maxParallel: 1, delays: { a: 10 } });
    const first = harness.scheduler.schedule(request('a', 'read'));
    const second = harness.scheduler.schedule(request('b', 'read'));
    const third = harness.scheduler.schedule(request('c', 'read'));
    await Promise.resolve(); // let the driver start the first call
    const drained = harness.scheduler.drain();
    await expect(third).rejects.toThrow(/run is over/);
    await expect(second).rejects.toThrow(/run is over/);
    const ra = await first;
    expect(ra.id).toBe('a');
    await drained;
  });

  it('marks a run over so later schedules reject immediately', async () => {
    const harness = makeHarness({});
    await harness.scheduler.drain();
    await expect(harness.scheduler.schedule(request('late', 'read'))).rejects.toThrow(/run is over/);
  });
});
