import path from 'node:path';

import type { CodeActKernel, CodeActKernelAdapter } from './types.js';

interface KernelEntry {
  kernel: CodeActKernel;
  workDir: string;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface KernelLease {
  kernel: CodeActKernel;
  lifecycle: 'started' | 'restarted' | 'reused';
}

export class CodeActKernelPool {
  private readonly entries = new Map<string, KernelEntry>();
  private readonly generations = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly adapter: CodeActKernelAdapter,
    private readonly idleTimeoutMs: number,
    private readonly environment: Record<string, string>,
    private readonly maxOutputChars: number,
    private readonly maxOutputBytes: number,
    private readonly onStopped?: (sessionId: string, generation: number, reason: string) => void,
  ) {}

  async acquire(sessionId: string, workDir: string): Promise<KernelLease> {
    if (this.closed) throw new Error('CodeAct kernel pool is closed.');
    const resolvedWorkDir = path.resolve(workDir);
    const existing = this.entries.get(sessionId);
    if (existing && existing.workDir === resolvedWorkDir) {
      this.armIdleTimer(sessionId, existing);
      return { kernel: existing.kernel, lifecycle: 'reused' };
    }
    if (existing) await this.invalidate(sessionId, 'workspace changed');
    const previousGeneration = this.generations.get(sessionId) ?? 0;
    const generation = previousGeneration + 1;
    this.generations.set(sessionId, generation);
    const kernel = await this.adapter.start({
      sessionId,
      generation,
      workDir: resolvedWorkDir,
      environment: { ...this.environment },
      maxOutputChars: this.maxOutputChars,
      maxOutputBytes: this.maxOutputBytes,
    });
    const entry: KernelEntry = { kernel, workDir: resolvedWorkDir };
    this.entries.set(sessionId, entry);
    this.armIdleTimer(sessionId, entry);
    return { kernel, lifecycle: previousGeneration === 0 ? 'started' : 'restarted' };
  }

  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) this.armIdleTimer(sessionId, entry);
  }

  status(sessionId: string): { running: boolean; generation?: number; workDir?: string } {
    const entry = this.entries.get(sessionId);
    return entry
      ? { running: true, generation: entry.kernel.generation, workDir: entry.workDir }
      : { running: false, generation: this.generations.get(sessionId) };
  }

  async interrupt(sessionId: string, executionId: string): Promise<boolean> {
    return this.entries.get(sessionId)?.kernel.interrupt(executionId) ?? false;
  }

  async invalidate(sessionId: string, reason: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await entry.kernel.stop(reason);
    this.onStopped?.(sessionId, entry.kernel.generation, reason);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.entries.keys()].map(sessionId => this.invalidate(sessionId, 'pool closed')));
  }

  private armIdleTimer(sessionId: string, entry: KernelEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.invalidate(sessionId, 'idle timeout');
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }
}
