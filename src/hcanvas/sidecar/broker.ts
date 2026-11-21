// SidecarBroker — owns every sidecar/kernel process for a workspace.
//
// Resolves manifest declarations through an injected catalog port, dedupes by
// instance key (extensionId + sidecarId + argvHash + cwd), enforces the
// per-extension process cap, and exposes request/cancel/stop/snapshot/audit for
// the HTTP routes. Per-process logic lives in sidecarProcess.ts.
import { spawn } from 'node:child_process';
import path from 'node:path';

import { HcRuntimeError } from './protocol.js';
import { HCANVAS_VERSION } from '../version.js';
import type {
  HcRuntimeDiagnostic,
  HcSidecarAuditEvent,
  HcSidecarAuditKind,
  HcSidecarCatalogEntry,
  HcSidecarCatalogPort,
  HcSidecarClientInfo,
  HcSidecarDeclaration,
  HcSidecarRole,
  HcSidecarRuntimeEvent,
  HcSidecarSnapshot,
  SidecarNotificationListener,
  SidecarRequestOptions,
  SidecarRequestOutcome,
} from './protocol.js';
import { RingBuffer, resolveSidecarLimits, type HcSidecarLimits } from './limits.js';
import {
  buildSandboxEnv,
  resolveSandboxCwd,
  sidecarInstanceKey,
  killProcessTree,
  type SidecarSpawnImpl,
} from './spawn.js';
import { SidecarProcess, type SidecarProcessDeps } from './sidecarProcess.js';

export interface SidecarBrokerOptions {
  workspaceDir: string;
  catalog?: HcSidecarCatalogPort;
  /** Host overrides merged over the spec defaults (clamped to global caps). */
  limits?: Partial<HcSidecarLimits>;
  clientInfo?: HcSidecarClientInfo;
  version?: string;
  onEvent?: (event: HcSidecarRuntimeEvent) => void;
  onAudit?: (event: HcSidecarAuditEvent) => void;
  spawnImpl?: SidecarSpawnImpl;
  killImpl?: (pid: number, signal: NodeJS.Signals) => Promise<boolean>;
  /** Clamp limits to global spec caps (default true; tests may disable). */
  enforceLimitCaps?: boolean;
  now?: () => Date;
  maxFrameBytes?: number;
}

export interface SidecarStartOptions {
  /** Handler id used to address the instance; defaults to the declaration id. */
  handleId?: string;
  /** Reuse an instance with the same instance key (default true for services). */
  dedupe?: boolean;
  /** Restart automatically after an unexpected exit (default true for services). */
  autoRestart?: boolean;
}

export type SidecarEventListener = (event: HcSidecarRuntimeEvent) => void;

export type {
  SidecarNotificationListener,
  SidecarRequestOptions,
  SidecarRequestOutcome,
};

/**
 * Call `stopAll()` on server shutdown. Services are started on demand by
 * `request()`; kernel sessions are started through `startDeclared()` with a
 * unique handle id and autoRestart disabled (the kernel manager owns restarts).
 */
export class SidecarBroker {
  private readonly workspaceDir: string;
  private catalog: HcSidecarCatalogPort | undefined;
  private readonly limitsOverride: Partial<HcSidecarLimits>;
  private readonly clientInfo: HcSidecarClientInfo;
  private readonly spawnImpl: SidecarSpawnImpl;
  private readonly killImpl: (pid: number, signal: NodeJS.Signals) => Promise<boolean>;
  private readonly enforceLimitCaps: boolean;
  private readonly now: () => Date;
  private readonly maxFrameBytes: number;
  private readonly onEventCallback: ((event: HcSidecarRuntimeEvent) => void) | undefined;
  private readonly onAuditCallback: ((event: HcSidecarAuditEvent) => void) | undefined;
  private readonly instances = new Map<string, SidecarProcess>();
  private readonly listeners = new Set<SidecarEventListener>();
  private readonly globalAudit: RingBuffer<HcSidecarAuditEvent>;

  constructor(options: SidecarBrokerOptions) {
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.catalog = options.catalog;
    this.limitsOverride = options.limits ?? {};
    this.clientInfo = options.clientInfo ?? { name: 'hcanvas', version: options.version ?? HCANVAS_VERSION };
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.killImpl = options.killImpl ?? ((pid, signal) => killProcessTree(pid, signal));
    this.enforceLimitCaps = options.enforceLimitCaps !== false;
    this.now = options.now ?? (() => new Date());
    this.maxFrameBytes = options.maxFrameBytes ?? 32 * 1024 * 1024;
    this.onEventCallback = options.onEvent;
    this.onAuditCallback = options.onAudit;
    this.globalAudit = new RingBuffer<HcSidecarAuditEvent>(this.baseLimits().auditRingEntries);
  }

  /** Replace the registry adapter (e.g. after extension reload). */
  setCatalog(catalog: HcSidecarCatalogPort | undefined): void {
    this.catalog = catalog;
  }

  /** Subscribe to broker runtime events; returns an unsubscribe function. */
  subscribe(listener: SidecarEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Recent audit trail (dropped entries are counted), optionally per extension. */
  auditLog(extensionId?: string): { events: HcSidecarAuditEvent[]; dropped: number } {
    const events = this.globalAudit.toArray();
    return {
      events: extensionId ? events.filter(event => event.extensionId === extensionId) : events,
      dropped: this.globalAudit.dropped,
    };
  }

  /** Resolve + start a manifest sidecar by id through the catalog port. */
  async start(sidecarId: string): Promise<HcSidecarSnapshot> {
    const entry = await this.resolveCatalogEntry(sidecarId);
    return this.startDeclared(entry, {
      handleId: sidecarId,
      dedupe: true,
      autoRestart: entry.declaration.role !== 'kernel',
    });
  }

  /** Start an explicitly resolved catalog entry (no registry lookup). */
  async startDeclared(entry: HcSidecarCatalogEntry, options: SidecarStartOptions = {}): Promise<HcSidecarSnapshot> {
    this.validateEntry(entry);
    const declaration = entry.declaration;
    const handleId = options.handleId ?? declaration.id;
    if (!handleId) throw new HcRuntimeError('invalid_manifest', 'Sidecar handle id is required');
    const command = [...declaration.command];
    const cwd = await resolveSandboxCwd({
      extensionDir: entry.extensionDir,
      workspaceDir: this.workspaceDir,
      requested: declaration.cwd,
    });
    const env = buildSandboxEnv({ literals: declaration.env });
    const instanceKey = sidecarInstanceKey(entry.extensionId, declaration.id, command, cwd);
    const role: HcSidecarRole = declaration.role === 'kernel' ? 'kernel' : 'service';
    const limits = this.limitsFor(declaration);

    const existing = this.instances.get(handleId);
    if (existing) {
      if (existing.instanceKey === instanceKey && (existing.ready || existing.isPendingStart)) {
        existing.autoRestart = options.autoRestart ?? existing.autoRestart;
        if (!existing.ready) await existing.waitForReady();
        return existing.snapshot();
      }
      await this.stopProcess(existing, 'replaced');
    }
    if (options.dedupe !== false) {
      const duplicate = this.findByInstanceKey(instanceKey);
      if (duplicate && duplicate.handleId !== handleId) {
        this.instances.set(handleId, duplicate);
        if (!duplicate.ready) await duplicate.waitForReady();
        return duplicate.snapshot();
      }
    }
    const liveForExtension = [...new Set(this.instances.values())]
      .filter(instance => instance.extensionId === entry.extensionId && instance.state !== 'stopped' && instance.state !== 'failed').length;
    if (liveForExtension >= limits.maxProcessesPerExtension) {
      throw new HcRuntimeError(
        'limit_exceeded',
        'Extension ' + entry.extensionId + ' already runs ' + liveForExtension + ' sidecar processes (max ' + limits.maxProcessesPerExtension + ')',
      );
    }
    const instance = this.createProcess(entry, {
      handleId,
      command,
      cwd,
      env,
      instanceKey,
      role,
      limits,
      autoRestart: options.autoRestart ?? role !== 'kernel',
    });
    this.instances.set(handleId, instance);
    try {
      await instance.launch();
    } catch (error) {
      throw error instanceof HcRuntimeError ? error : new HcRuntimeError('sidecar_spawn_failed', error instanceof Error ? error.message : String(error));
    }
    return instance.snapshot();
  }

  /** Send a manifest-declared request; auto-starts / waits for the instance. */
  async request(
    handleId: string,
    method: string,
    params?: unknown,
    options: SidecarRequestOptions = {},
  ): Promise<SidecarRequestOutcome> {
    const instance = await this.ensureRunning(handleId);
    try {
      return await instance.request(method, params, options);
    } catch (error) {
      throw toRuntimeError(error);
    }
  }

  notify(handleId: string, method: string, params?: unknown): boolean {
    return this.instances.get(handleId)?.notify(method, params) ?? false;
  }

  /** Cancel an in-flight request by JSON-RPC id. Returns false when unknown. */
  cancel(requestId: string | number, reason = 'cancelled'): boolean {
    let found = false;
    for (const instance of new Set(this.instances.values())) {
      if (instance.cancel(requestId, reason)) found = true;
    }
    return found;
  }

  cancelFor(handleId: string, requestId: string | number, reason = 'cancelled'): boolean {
    return this.instances.get(handleId)?.cancel(requestId, reason) ?? false;
  }

  cancelInstanceRequests(handleId: string, reason = 'cancelled'): number {
    return this.instances.get(handleId)?.cancelAllRequests(reason) ?? 0;
  }

  signal(handleId: string, signal: NodeJS.Signals): boolean {
    return this.instances.get(handleId)?.signal(signal) ?? false;
  }

  /** Graceful shutdown with SIGTERM / tree kill / SIGKILL escalation. */
  async stop(handleId: string, reason = 'requested'): Promise<void> {
    const instance = this.instances.get(handleId);
    if (!instance) return;
    await this.stopProcess(instance, reason);
  }

  /** Stop every process owned by one extension (extension update/uninstall). */
  async stopExtension(extensionId: string, reason = 'extension removed'): Promise<number> {
    const unique = [...new Set(this.instances.values())].filter(instance => instance.extensionId === extensionId);
    await Promise.all(unique.map(instance => this.stopProcess(instance, reason).catch(() => undefined)));
    return unique.length;
  }

  /** Stop every process owned by the broker (server shutdown). */
  async stopAll(reason = 'shutdown'): Promise<void> {
    const unique = [...new Set(this.instances.values())];
    await Promise.all(unique.map(instance => this.stopProcess(instance, reason).catch(() => undefined)));
    this.instances.clear();
  }

  snapshot(handleId: string): HcSidecarSnapshot | null {
    return this.instances.get(handleId)?.snapshot() ?? null;
  }

  list(): HcSidecarSnapshot[] {
    return [...new Set(this.instances.values())].map(instance => instance.snapshot());
  }

  /** The raw initialize result (service serverInfo or kernel HKP payload). */
  initializeResult(handleId: string): unknown {
    return this.instances.get(handleId)?.initializeResult();
  }

  /** Listen to sidecar notifications unknown to the broker (kernel/*). */
  subscribeNotifications(handleId: string, listener: SidecarNotificationListener): () => void {
    return this.instances.get(handleId)?.subscribeNotifications(listener) ?? (() => undefined);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private baseLimits(): HcSidecarLimits {
    return resolveSidecarLimits(undefined, this.limitsOverride, {
      enforceCaps: this.enforceLimitCaps,
      enforceIdleFloor: this.enforceLimitCaps,
    });
  }

  private limitsFor(declaration: HcSidecarDeclaration): HcSidecarLimits {
    return resolveSidecarLimits(declaration.limits, this.limitsOverride, {
      enforceCaps: this.enforceLimitCaps,
      enforceIdleFloor: this.enforceLimitCaps,
    });
  }

  private validateEntry(entry: HcSidecarCatalogEntry): void {
    if (!entry || typeof entry !== 'object') throw new HcRuntimeError('invalid_manifest', 'Sidecar catalog entry is required');
    if (entry.enabled === false) throw new HcRuntimeError('sidecar_not_found', 'Sidecar is disabled');
    if (entry.trusted === false) throw new HcRuntimeError('trusted_required', 'Workspace is not trusted; sidecars are disabled in Restricted Mode');
    if (entry.granted === false) throw new HcRuntimeError('consent_required', 'Sidecar requires user consent (process capability)');
    const declaration = entry.declaration;
    if (!declaration || typeof declaration !== 'object') throw new HcRuntimeError('invalid_manifest', 'Sidecar declaration is required');
    if (typeof declaration.id !== 'string' || !declaration.id) throw new HcRuntimeError('invalid_manifest', 'Sidecar declaration id is required');
    if (!Array.isArray(declaration.command) || declaration.command.length === 0) {
      throw new HcRuntimeError('invalid_manifest', 'Sidecar ' + declaration.id + ' command must be a non-empty argv array');
    }
    for (const arg of declaration.command) {
      if (typeof arg !== 'string') throw new HcRuntimeError('invalid_manifest', 'Sidecar command arguments must be strings (shell:false)');
      if (arg.includes('\u0000')) throw new HcRuntimeError('invalid_manifest', 'Sidecar command arguments must not contain NUL bytes');
    }
    if (!entry.extensionDir || !path.isAbsolute(entry.extensionDir)) {
      throw new HcRuntimeError('invalid_manifest', 'Sidecar extension directory must be an absolute path');
    }
  }

  private async resolveCatalogEntry(sidecarId: string): Promise<HcSidecarCatalogEntry> {
    if (!this.catalog) throw new HcRuntimeError('not_supported', 'No sidecar catalog is configured');
    const entry = await this.catalog.resolveSidecar(sidecarId);
    if (!entry) throw new HcRuntimeError('sidecar_not_found', 'Unknown sidecar ' + JSON.stringify(sidecarId));
    return entry;
  }

  private createProcess(
    entry: HcSidecarCatalogEntry,
    resolved: {
      handleId: string;
      command: string[];
      cwd: string;
      env: Record<string, string>;
      instanceKey: string;
      role: HcSidecarRole;
      limits: HcSidecarLimits;
      autoRestart: boolean;
    },
  ): SidecarProcess {
    let created: SidecarProcess | null = null;
    const deps: SidecarProcessDeps = {
      spawnImpl: this.spawnImpl,
      killImpl: this.killImpl,
      now: this.now,
      clientInfo: this.clientInfo,
      maxFrameBytes: this.maxFrameBytes,
      onEvent: event => this.emit(event),
      onAudit: event => this.recordAudit(event),
      onIdleTimeout: () => {
        // Kernel sidecars are owned by HcKernelManager; idle-stopping them would
        // leave the kernel session pointing at a dead process. Service sidecars
        // still use the normal idle timeout.
        if (!created || created.role === 'kernel') return;
        void this.stopProcess(created, 'idle timeout').catch(() => undefined);
      },
    };
    created = new SidecarProcess(
      {
        handleId: resolved.handleId,
        sidecarId: entry.declaration.id,
        extensionId: entry.extensionId,
        extensionDir: path.resolve(entry.extensionDir),
        workspaceDir: this.workspaceDir,
        entry,
        declaration: entry.declaration,
        role: resolved.role,
        instanceKey: resolved.instanceKey,
        command: resolved.command,
        cwd: resolved.cwd,
        env: resolved.env,
        envKeys: Object.keys(resolved.env).sort(),
        limits: resolved.limits,
        autoRestart: resolved.autoRestart,
      },
      deps,
    );
    return created;
  }

  private findByInstanceKey(instanceKey: string): SidecarProcess | undefined {
    for (const instance of new Set(this.instances.values())) {
      if (instance.instanceKey === instanceKey && instance.state !== 'stopped' && instance.state !== 'failed') return instance;
    }
    return undefined;
  }

  private async ensureRunning(handleId: string): Promise<SidecarProcess> {
    const instance = this.instances.get(handleId);
    if (instance && instance.ready) return instance;
    if (instance && instance.isPendingStart) {
      await instance.waitForReady();
      return instance;
    }
    if (instance && instance.state === 'failed') {
      // SPEC-7.4: consecutive failures end in `failed`; a manual start is required.
      const diagnostic = instance.diagnosticsSnapshot().at(-1);
      throw new HcRuntimeError(
        'sidecar_crash',
        'Sidecar ' + instance.sidecarId + ' is failed' + (diagnostic ? ' (' + diagnostic.code + ': ' + diagnostic.message + ')' : ''),
      );
    }
    if (instance && (instance.state === 'stopped' || instance.state === 'crashed')) {
      await this.startDeclared(instance.entry, { handleId, dedupe: false, autoRestart: instance.autoRestart });
      const relaunched = this.instances.get(handleId);
      if (relaunched) return relaunched;
    }
    await this.start(handleId);
    const started = this.instances.get(handleId);
    if (!started) throw new HcRuntimeError('sidecar_not_found', 'Unknown sidecar ' + JSON.stringify(handleId));
    await started.waitForReady();
    return started;
  }

  private async stopProcess(instance: SidecarProcess, reason: string): Promise<void> {
    await instance.stop(reason);
    for (const [handle, mapped] of [...this.instances.entries()]) {
      if (mapped === instance) this.instances.delete(handle);
    }
  }

  private emit(event: HcSidecarRuntimeEvent): void {
    if (this.onEventCallback) {
      try {
        this.onEventCallback(event);
      } catch {
        /* ignore */
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
  }

  private recordAudit(event: HcSidecarAuditEvent): void {
    this.globalAudit.push(event);
    if (this.onAuditCallback) {
      try {
        this.onAuditCallback(event);
      } catch {
        /* ignore */
      }
    }
  }
}

function toRuntimeError(error: unknown): HcRuntimeError {
  if (error instanceof HcRuntimeError) return error;
  return new HcRuntimeError('internal_error', error instanceof Error ? error.message : String(error));
}

/** Convenience diagnostic formatter for route handlers / logs. */
export function formatDiagnostics(diagnostics: HcRuntimeDiagnostic[]): string {
  return diagnostics.map(item => '[' + item.code + '] ' + item.message).join('; ');
}

export type { HcSidecarAuditKind };
