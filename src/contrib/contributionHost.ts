import { HadamardSdkError } from '../errors.js';

/**
 * Minimal runtime contribution host (Hadamard-owned; dsh "everything is a
 * plugin" reduced to the contribution protocol): typed service keys, ordered
 * registration with cycle diagnostics, scoped shadowing, reversible effects,
 * and deterministic failure/unload behavior. This is a runtime assembly seam
 * - package trust and bundle discovery stay separate layers (see
 * contributionLoader.ts), and kernel invariants stay non-contributable.
 *
 * @module src/contrib/contributionHost
 */

export type ContributionScopeName = 'global' | 'agent' | 'session';

/** Typed service key: the stable name is the identity, the type is compile-time only. */
export interface ContributionServiceKey<T> {
  readonly name: string;
}

export function defineContributionServiceKey<T>(name: string): ContributionServiceKey<T> {
  return { name };
}

export interface ContributionEvent {
  type: string;
  payload?: unknown;
}

export type ContributionEventListener = (event: ContributionEvent) => void | Promise<void>;

/** Waterfall listener: call next() to continue; return without calling next() to short-circuit. */
export type ContributionWaterfallListener = (
  event: ContributionEvent,
  next: () => Promise<ContributionEvent>,
) => ContributionEvent | Promise<ContributionEvent>;

export interface ContributionServiceRegistry {
  register<T>(key: ContributionServiceKey<T>, impl: T): void;
  registerLazy<T>(key: ContributionServiceKey<T>, factory: () => T): void;
  get<T>(key: ContributionServiceKey<T>): T | undefined;
  unregister<T>(key: ContributionServiceKey<T>): boolean;
}

export interface ContributionEventBus {
  /** Broadcast in listener registration order, sequentially; a throwing listener aborts and rethrows. */
  emit(type: string, payload?: unknown): Promise<void>;
  on(type: string, listener: ContributionEventListener): () => void;
  onWaterfall(type: string, listener: ContributionWaterfallListener): () => void;
  waterfall(type: string, payload?: unknown): Promise<ContributionEvent>;
}

export interface ContributionApplyContext {
  scope: ContributionScopeName;
  services: ContributionServiceRegistry;
  events: ContributionEventBus;
  onDispose(disposer: () => void | Promise<void>): void;
}

export type ContributionDisposer = () => void | Promise<void>;

export interface HadamardRuntimeContribution {
  id: string;
  requires?: readonly string[];
  apply(ctx: ContributionApplyContext): ContributionDisposer | void | Promise<ContributionDisposer | void>;
}

export interface ContributionHandle {
  readonly id: string;
  readonly scope: ContributionScopeName;
  dispose(): Promise<void>;
}

export interface ContributionLoadOptions {
  scope?: ContributionScopeName;
  /** Unload an already-active contribution with the same id before applying (HMR-style reload). */
  replace?: boolean;
}

interface ActiveContribution {
  id: string;
  scope: ContributionScopeName;
  disposers: Array<() => void | Promise<void>>;
}

const CONTRIBUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class ContributionScopeNode {
  readonly services = new Map<string, unknown>();
  readonly lazyServices = new Map<string, () => unknown>();
  readonly contributions = new Map<string, ActiveContribution>();
  private readonly resolving = new Set<string>();
  private readonly listeners = new Map<string, ContributionEventListener[]>();
  private readonly waterfallListeners = new Map<string, ContributionWaterfallListener[]>();

  constructor(
    readonly name: ContributionScopeName,
    private readonly parent?: ContributionScopeNode,
  ) {}

  register<T>(key: ContributionServiceKey<T>, impl: T): void {
    if (this.services.has(key.name) || this.lazyServices.has(key.name)) {
      throw new HadamardSdkError(
        `Service '${key.name}' is already registered in the ${this.name} scope.`,
        'CONTRIBUTION_DUPLICATE_SERVICE',
      );
    }
    this.services.set(key.name, impl);
  }

  registerLazy<T>(key: ContributionServiceKey<T>, factory: () => T): void {
    if (this.services.has(key.name) || this.lazyServices.has(key.name)) {
      throw new HadamardSdkError(
        `Service '${key.name}' is already registered in the ${this.name} scope.`,
        'CONTRIBUTION_DUPLICATE_SERVICE',
      );
    }
    this.lazyServices.set(key.name, factory);
  }

  unregister(key: { name: string }): boolean {
    return this.services.delete(key.name) || this.lazyServices.delete(key.name);
  }

  /** Nearest scope wins; falls through to parent scopes. */
  get<T>(key: ContributionServiceKey<T>): T | undefined {
    if (this.resolving.has(key.name)) {
      throw new HadamardSdkError(
        `Service '${key.name}' depends on itself (lazy factory cycle).`,
        'CONTRIBUTION_SERVICE_CYCLE',
      );
    }
    if (this.services.has(key.name)) return this.services.get(key.name) as T;
    const factory = this.lazyServices.get(key.name);
    if (factory) {
      this.resolving.add(key.name);
      try {
        const impl = factory();
        this.lazyServices.delete(key.name);
        this.services.set(key.name, impl);
        return impl as T;
      } finally {
        this.resolving.delete(key.name);
      }
    }
    return this.parent?.get(key);
  }

  findActive(id: string): ActiveContribution | undefined {
    return this.contributions.get(id) ?? this.parent?.findActive(id);
  }

  addListener(type: string, listener: ContributionEventListener): () => void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    return () => {
      const current = this.listeners.get(type);
      if (!current) return;
      const index = current.indexOf(listener);
      if (index >= 0) current.splice(index, 1);
    };
  }

  addWaterfallListener(type: string, listener: ContributionWaterfallListener): () => void {
    const list = this.waterfallListeners.get(type) ?? [];
    list.push(listener);
    this.waterfallListeners.set(type, list);
    return () => {
      const current = this.waterfallListeners.get(type);
      if (!current) return;
      const index = current.indexOf(listener);
      if (index >= 0) current.splice(index, 1);
    };
  }

  async emit(type: string, payload?: unknown): Promise<void> {
    const event: ContributionEvent = { type, ...(payload !== undefined ? { payload } : {}) };
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      await listener(event);
    }
  }

  async waterfall(type: string, payload?: unknown): Promise<ContributionEvent> {
    const event: ContributionEvent = { type, ...(payload !== undefined ? { payload } : {}) };
    const chain = [...(this.waterfallListeners.get(type) ?? [])];
    let index = 0;
    const next = async (): Promise<ContributionEvent> => {
      const listener = chain[index++];
      if (!listener) return event;
      return listener(event, next);
    };
    return next();
  }
}

/** Per-apply session: services/events the contribution registers are revoked on dispose. */
class ContributionApplySession {
  private readonly registeredKeys: string[] = [];
  private readonly extraDisposers: Array<() => void | Promise<void>> = [];
  private readonly unsubscribers: Array<() => void> = [];
  readonly context: ContributionApplyContext;

  constructor(
    private readonly node: ContributionScopeNode,
    private readonly id: string,
  ) {
    const services: ContributionServiceRegistry = {
      register: (key, impl) => {
        node.register(key, impl);
        this.registeredKeys.push(key.name);
      },
      registerLazy: (key, factory) => {
        node.registerLazy(key, factory);
        this.registeredKeys.push(key.name);
      },
      get: (key) => node.get(key),
      unregister: (key) => {
        const index = this.registeredKeys.indexOf(key.name);
        if (index >= 0) this.registeredKeys.splice(index, 1);
        return node.unregister(key);
      },
    };
    const events: ContributionEventBus = {
      emit: (type, payload) => node.emit(type, payload),
      on: (type, listener) => {
        const unsubscribe = node.addListener(type, listener);
        this.unsubscribers.push(unsubscribe);
        return unsubscribe;
      },
      onWaterfall: (type, listener) => {
        const unsubscribe = node.addWaterfallListener(type, listener);
        this.unsubscribers.push(unsubscribe);
        return unsubscribe;
      },
      waterfall: (type, payload) => node.waterfall(type, payload),
    };
    this.context = {
      scope: node.name,
      services,
      events,
      onDispose: (disposer) => { this.extraDisposers.push(disposer); },
    };
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0).reverse()) unsubscribe();
    for (const key of this.registeredKeys.splice(0)) this.node.unregister({ name: key });
    const errors: unknown[] = [];
    for (const disposer of [...this.extraDisposers].reverse()) {
      try { await disposer(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Contribution '${this.id}' disposers failed.`);
    }
  }
}

export class HadamardContributionHost {
  private readonly globalNode = new ContributionScopeNode('global');
  private readonly agentNode = new ContributionScopeNode('agent', this.globalNode);
  private readonly sessionNode = new ContributionScopeNode('session', this.agentNode);

  private nodeFor(scope: ContributionScopeName): ContributionScopeNode {
    switch (scope) {
      case 'global': return this.globalNode;
      case 'agent': return this.agentNode;
      case 'session': return this.sessionNode;
    }
  }

  registerService<T>(key: ContributionServiceKey<T>, impl: T): void {
    this.globalNode.register(key, impl);
  }

  getService<T>(key: ContributionServiceKey<T>): T | undefined {
    return this.globalNode.get(key);
  }

  getScopedService<T>(key: ContributionServiceKey<T>, scope: ContributionScopeName): T | undefined {
    return this.nodeFor(scope).get(key);
  }

  /** Direct event-bus access for the composition root and tests. */
  getEventBus(scope: ContributionScopeName = 'global'): ContributionEventBus {
    const node = this.nodeFor(scope);
    return {
      emit: (type, payload) => node.emit(type, payload),
      on: (type, listener) => node.addListener(type, listener),
      onWaterfall: (type, listener) => node.addWaterfallListener(type, listener),
      waterfall: (type, payload) => node.waterfall(type, payload),
    };
  }

  async load(
    contribution: HadamardRuntimeContribution,
    options: ContributionLoadOptions = {},
  ): Promise<ContributionHandle> {
    const scope = options.scope ?? 'global';
    const node = this.nodeFor(scope);
    if (!contribution || typeof contribution.id !== 'string' || !CONTRIBUTION_ID_PATTERN.test(contribution.id)) {
      throw new HadamardSdkError('Contribution id must be a non-empty dotted identifier.', 'CONTRIBUTION_INVALID_ID');
    }
    if (typeof contribution.apply !== 'function') {
      throw new HadamardSdkError(`Contribution '${contribution.id}' has no apply() function.`, 'CONTRIBUTION_INVALID_DEFINITION');
    }
    const existing = node.contributions.get(contribution.id);
    if (existing) {
      if (options.replace !== true) {
        throw new HadamardSdkError(
          `Contribution '${contribution.id}' is already loaded in the ${scope} scope.`,
          'CONTRIBUTION_DUPLICATE_ID',
        );
      }
      await this.disposeContribution(node, existing);
    }
    const missing = (contribution.requires ?? []).filter(
      (required) => !node.findActive(required),
    );
    if (missing.length > 0) {
      throw new HadamardSdkError(
        `Contribution '${contribution.id}' requires missing contribution(s): ${missing.join(', ')}.`,
        'CONTRIBUTION_MISSING_DEPENDENCY',
      );
    }
    const session = new ContributionApplySession(node, contribution.id);
    let disposer: ContributionDisposer | void;
    try {
      disposer = await contribution.apply(session.context);
    } catch (error) {
      try { await session.dispose(); } catch { /* keep the apply error as the cause */ }
      throw new HadamardSdkError(
        `Contribution '${contribution.id}' failed to apply: ${asMessage(error)}`,
        'CONTRIBUTION_APPLY_FAILED',
        { cause: error },
      );
    }
    const active: ActiveContribution = {
      id: contribution.id,
      scope,
      // The session revokes service registrations, event subscriptions, and
      // onDispose effects; the returned disposer runs after those revocations.
      disposers: [() => session.dispose(), ...(disposer ? [disposer] : [])],
    };
    node.contributions.set(contribution.id, active);
    return {
      id: contribution.id,
      scope,
      dispose: () => this.disposeContribution(node, active),
    };
  }

  /**
   * Load a batch with topological ordering by `requires` (stable input order
   * for independent ids). On any failure the batch's applied contributions
   * are disposed in reverse order before the error is rethrown.
   */
  async loadMany(
    contributions: readonly HadamardRuntimeContribution[],
    options: ContributionLoadOptions = {},
  ): Promise<ContributionHandle[]> {
    const order = topoSortContributions(contributions);
    const handles: ContributionHandle[] = [];
    try {
      for (const contribution of order) {
        handles.push(await this.load(contribution, options));
      }
    } catch (error) {
      for (const handle of handles.reverse()) {
        try { await handle.dispose(); } catch { /* rollback best-effort */ }
      }
      throw error;
    }
    return handles;
  }

  /** Dispose every contribution across scopes: session → agent → global, each in reverse load order. */
  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const node of [this.sessionNode, this.agentNode, this.globalNode]) {
      for (const active of [...node.contributions.values()].reverse()) {
        try { await this.disposeContribution(node, active); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more contributions failed to dispose.');
    }
  }

  listLoaded(): Array<{ id: string; scope: ContributionScopeName }> {
    const result: Array<{ id: string; scope: ContributionScopeName }> = [];
    for (const node of [this.globalNode, this.agentNode, this.sessionNode]) {
      for (const active of node.contributions.values()) result.push({ id: active.id, scope: active.scope });
    }
    return result;
  }

  private async disposeContribution(node: ContributionScopeNode, active: ActiveContribution): Promise<void> {
    if (node.contributions.get(active.id) !== active) return; // already disposed
    node.contributions.delete(active.id);
    const errors: unknown[] = [];
    for (const disposer of [...active.disposers].reverse()) {
      try { await disposer(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Contribution '${active.id}' disposers failed.`);
    }
  }
}

export function topoSortContributions(
  contributions: readonly HadamardRuntimeContribution[],
): HadamardRuntimeContribution[] {
  const byId = new Map(contributions.map((contribution) => [contribution.id, contribution]));
  if (byId.size !== contributions.length) {
    const duplicated = contributions
      .map((contribution) => contribution.id)
      .filter((id, index, all) => all.indexOf(id) !== index);
    throw new HadamardSdkError(
      `Batch contains duplicate contribution id(s): ${[...new Set(duplicated)].join(', ')}.`,
      'CONTRIBUTION_DUPLICATE_ID',
    );
  }
  const dependencies = new Map<string, Set<string>>();
  for (const contribution of contributions) {
    const requires = new Set<string>();
    for (const required of contribution.requires ?? []) {
      if (byId.has(required)) requires.add(required);
      // Requires of already-active contributions are handled by load().
    }
    dependencies.set(contribution.id, requires);
  }
  const order: HadamardRuntimeContribution[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id];
      throw new HadamardSdkError(
        `Contribution dependency cycle: ${cycle.join(' -> ')}.`,
        'CONTRIBUTION_CYCLE',
      );
    }
    visiting.add(id);
    stack.push(id);
    for (const required of dependencies.get(id) ?? []) visit(required);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    order.push(byId.get(id)!);
  };
  for (const contribution of contributions) visit(contribution.id);
  return order;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

