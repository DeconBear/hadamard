import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { HcPtyManager } from '../src/hcanvas/sidecar/pty.js';
import { HcRuntimeError } from '../src/hcanvas/sidecar/protocol.js';

interface FakePty {
  written: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
  emitData(data: string): void;
}

function makeFakePtyModule(): { module: Record<string, unknown>; pty: FakePty } {
  const pty: FakePty = { written: [], resizes: [], killed: false, emitData: () => undefined };
  let dataCallback: ((data: string) => void) | null = null;
  let exitCallback: ((event: { exitCode: number }) => void) | null = null;
  const proc = {
    pid: 4242,
    onData: (callback: (data: string) => void) => { dataCallback = callback; },
    onExit: (callback: (event: { exitCode: number }) => void) => { exitCallback = callback; },
    write: (data: string) => { pty.written.push(data); },
    resize: (cols: number, rows: number) => { pty.resizes.push({ cols, rows }); },
    kill: () => { pty.killed = true; },
  };
  pty.emitData = data => dataCallback?.(data);
  (pty as unknown as { exit: (code: number) => void }).exit = (code: number) => exitCallback?.({ exitCode: code });
  const module = {
    spawn: vi.fn((file: string, args: string[], options: unknown) => {
      (module as unknown as { lastSpawn: unknown }).lastSpawn = { file, args, options };
      return proc;
    }),
  };
  return { module, pty };
}

function errorOf(value: unknown): HcRuntimeError {
  expect(value).toBeInstanceOf(HcRuntimeError);
  return value as HcRuntimeError;
}

describe('pty manager', () => {
  it('degrades gracefully when node-pty is unavailable', async () => {
    const manager = new HcPtyManager({ workspaceDir: process.cwd(), loadPty: async () => null });
    await expect(manager.probe()).resolves.toBe(false);
    expect(manager.available).toBe(false);
    const error = errorOf(await manager.create({ command: ['x'] }).catch(value => value));
    expect(error.code).toBe('not_supported');
  });

  it('creates sessions with argv arrays, ring replay, input and resize', async () => {
    const { module, pty } = makeFakePtyModule();
    const events: Array<{ event: string; seq?: number; data?: string }> = [];
    const manager = new HcPtyManager({
      workspaceDir: process.cwd(),
      loadPty: async () => module as never,
      enforceLimitCaps: false,
      limits: { ringBytes: 8, maxSessions: 2, inputBytesPerSecond: 1_000 },
      killImpl: async () => true,
      onEvent: event => events.push({ event: event.event, ...(event.seq === undefined ? {} : { seq: event.seq }), ...(event.data ? { data: event.data } : {}) }),
    });
    const session = await manager.create({ command: ['fake-shell'], cols: 100, rows: 30, label: 'Fake' });
    expect(session.state).toBe('running');
    expect(session.cols).toBe(100);
    expect(session.rows).toBe(30);
    expect(manager.available).toBe(true);
    const spawnOptions = (module as unknown as { lastSpawn: { file: string; args: string[]; options: { cols: number; rows: number; cwd: string } } }).lastSpawn;
    expect(spawnOptions.file).toBe('fake-shell');
    expect(spawnOptions.args).toEqual([]);
    expect(spawnOptions.options.cols).toBe(100);
    expect(spawnOptions.options.rows).toBe(30);

    pty.emitData('hello world');
    // the ring floor is 1 KiB; overflow keeps the tail and counts dropped bytes
    pty.emitData('x'.repeat(1_500) + 'TAIL');
    expect(events.filter(event => event.event === 'data')).toHaveLength(2);
    const buffer = manager.buffer(session.sessionId);
    expect(buffer.bytes).toBe(1_024);
    expect(buffer.data.endsWith('TAIL')).toBe(true);
    expect(buffer.dropped).toBe(11 + 1_500 + 4 - 1_024);
    expect(buffer.base64).toBe(Buffer.from(buffer.data).toString('base64'));

    const accepted = manager.input(session.sessionId, Buffer.from('echo hi\n').toString('base64'));
    expect(accepted.accepted).toBe(8);
    expect(pty.written).toEqual(['echo hi\n']);
    // per-call cap first, then the token bucket for a fast second write
    const tooLarge = errorOf((() => {
      try {
        manager.input(session.sessionId, Buffer.from('x'.repeat(2_000)).toString('base64'));
        return null;
      } catch (caught) {
        return caught;
      }
    })());
    expect(tooLarge.code).toBe('limit_exceeded');
    expect(manager.input(session.sessionId, Buffer.from('z'.repeat(600)).toString('base64')).accepted).toBe(600);
    const rateError = errorOf((() => {
      try {
        manager.input(session.sessionId, Buffer.from('y'.repeat(900)).toString('base64'));
        return null;
      } catch (caught) {
        return caught;
      }
    })());
    expect(rateError.code).toBe('rate_limited');

    const resized = manager.resize(session.sessionId, 120, 40);
    expect(resized.cols).toBe(120);
    expect(pty.resizes).toEqual([{ cols: 120, rows: 40 }]);

    await manager.close(session.sessionId);
    expect(pty.killed).toBe(true);
    expect(manager.get(session.sessionId)).toBeNull();
  });

  it('rejects cwd escapes and invalid commands', async () => {
    const { module } = makeFakePtyModule();
    const manager = new HcPtyManager({
      workspaceDir: process.cwd(),
      loadPty: async () => module as never,
      enforceLimitCaps: false,
      killImpl: async () => true,
    });
    const escape = errorOf(await manager.create({ command: ['x'], cwd: path.resolve(process.cwd(), '..', 'outside') }).catch(value => value));
    expect(escape.code).toBe('path_forbidden');
    const badCommand = errorOf(await manager.create({ command: [] }).catch(value => value));
    expect(badCommand.code).toBe('invalid_params');
  });

  it('enforces the session cap', async () => {
    const { module } = makeFakePtyModule();
    const manager = new HcPtyManager({
      workspaceDir: process.cwd(),
      loadPty: async () => module as never,
      enforceLimitCaps: false,
      limits: { maxSessions: 1 },
      killImpl: async () => true,
    });
    await manager.create({ command: ['one'] });
    const error = errorOf(await manager.create({ command: ['two'] }).catch(value => value));
    expect(error.code).toBe('limit_exceeded');
    await manager.closeAll();
  });
});
