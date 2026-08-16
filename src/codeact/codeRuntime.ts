/**
 * CodeRuntime seam: the language-portable contract a stateless program
 * execution backend implements (dsh CodeRuntime equivalent, Hadamard-owned).
 * Runtimes know nothing about tools or sessions; consumers bridge host tool
 * calls through the bindings they pass in. An error is a RESULT FIELD, never
 * a rejection: a failed program is the caller's job to report.
 *
 * @module src/codeact/codeRuntime
 */

/** A lossless JSON value transferable across the runtime boundary. */
export type CodeJsonValue =
  | null
  | boolean
  | number
  | string
  | CodeJsonValue[]
  | { [key: string]: CodeJsonValue };

/** Why a run failed; kinds are orthogonal outcomes, never aliases. */
export interface CodeRunFailure {
  kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit';
  message: string;
}

/** Program-visible typed rejection for one binding namespace. */
export interface CodeBindingErrorClass {
  /** Constructor global and resulting Error.name; portable identifier rules apply. */
  name: string;
  /** Non-empty own property exposing the failing member name. */
  memberNameProperty: string;
}

/**
 * A named group of host functions exposed to the program as one global
 * object (e.g. `tools`). Function names are arbitrary strings and must be
 * treated as ordinary own properties (null-prototype construction).
 */
export interface CodeBindingNamespace {
  global: string;
  functions: Record<string, (args: unknown) => Promise<CodeJsonValue>>;
  errorClass?: CodeBindingErrorClass;
}

/** One run: the program source plus everything the runtime acts on. */
export interface CodeRunRequest {
  /** Program source in the runtime's language: runs as an async function body. */
  program: string;
  bindings: CodeBindingNamespace[];
  /** Abort the run: stops the program hard and resolves with kind 'abort'. */
  signal?: AbortSignal;
}

/** The outcome of one run. `error` is a field on a resolved result, never a rejection. */
export interface CodeRunResult {
  /** The completion value when it crossed the lossless-JSON boundary. */
  value?: CodeJsonValue;
  /** Ordered text the program emitted. */
  logs: string[];
  error?: CodeRunFailure;
}

/**
 * Stateless program execution backend. Implementations isolate runs from
 * one another, treat programs as hostile peers, bound output/time/heap,
 * and terminate in-flight runs on disposal.
 */
export interface CodeRuntime {
  /** Source language identifier ('typescript' | 'python'). */
  readonly language: string;
  /** Execution substrate ('worker-thread' | 'process' | 'container'). */
  readonly isolation: string;
  run(request: CodeRunRequest): Promise<CodeRunResult>;
}

/**
 * Binding globals EVERY backend refuses because SOME backend owns the slot
 * in the program namespace. One shared set keeps the portability promise
 * real: a namespace list valid on one backend is valid on all.
 */
export const RESERVED_BINDING_GLOBALS: ReadonlySet<string> = new Set([
  'console',
  '__hadamard_main__', '__builtins__', '__name__', '__debug__',
]);

/** Error members every backend refuses (own-protocol slots on Error). */
export const RESERVED_ERROR_MEMBERS: ReadonlySet<string> = new Set([
  'name', 'message', 'stack',
  'args', 'with_traceback', 'add_note',
]);

/** Dunder form (`__x__`, non-empty middle): refused as error members on every backend. */
export const DUNDER_MEMBER = /^__.+__$/;

/**
 * Reserved words of every portable target language (ECMAScript ∪ Python),
 * refused as binding globals / error-class names by all backends.
 */
export const PORTABLE_RESERVED_WORDS: ReadonlySet<string> = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'def', 'del', 'elif', 'except', 'from',
  'global', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'match', 'type', '_',
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate one namespace list against the portable identifier contract. */
export function validateCodeBindingNamespace(namespace: CodeBindingNamespace): void {
  if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
    throw new Error(`binding global ${JSON.stringify(namespace.global)} is not a usable identifier`);
  }
  if (RESERVED_BINDING_GLOBALS.has(namespace.global)) {
    throw new Error(`reserved binding global ${JSON.stringify(namespace.global)}`);
  }
  const errorClass = namespace.errorClass;
  if (errorClass) {
    if (!IDENTIFIER.test(errorClass.name) || PORTABLE_RESERVED_WORDS.has(errorClass.name)) {
      throw new Error(`binding error class ${JSON.stringify(errorClass.name)} is not a usable identifier`);
    }
    if (RESERVED_BINDING_GLOBALS.has(errorClass.name)) {
      throw new Error(`reserved binding global ${JSON.stringify(errorClass.name)}`);
    }
    const member = errorClass.memberNameProperty;
    if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
      throw new Error(`binding error member property ${JSON.stringify(errorClass.memberNameProperty)} is not usable`);
    }
  }
}

/**
 * Snapshot a value as detached, lossless JSON; returns undefined when the
 * value cannot cross the boundary (functions, cycles, bigints, symbols).
 */
export function snapshotCodeJsonValue(value: unknown): CodeJsonValue | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    return JSON.parse(serialized) as CodeJsonValue;
  } catch {
    return undefined;
  }
}

