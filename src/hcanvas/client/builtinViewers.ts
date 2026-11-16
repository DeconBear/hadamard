/**
 * First-party (builtin) viewer registry.
 *
 * Bundled extensions may contribute `viewers[].type = "builtin"` with a
 * `builtinId` (or the viewer id) that the host implements natively. Third-party
 * extensions cannot claim builtin ids (manifest validation + loader source).
 */
export interface BuiltinViewerFileContext {
  rootId: string;
  path: string;
  readOnly?: boolean;
}

export interface BuiltinViewerContext {
  extensionId: string;
  viewId: string;
  surface: string;
  format?: string;
  file?: BuiltinViewerFileContext;
  [key: string]: unknown;
}

export interface BuiltinViewerMounted {
  dispose?(): void;
}

export interface BuiltinViewer {
  mount(host: HTMLElement, context: BuiltinViewerContext): BuiltinViewerMounted | void;
}

const registry = new Map<string, BuiltinViewer>();

export function registerBuiltinViewer(id: string, viewer: BuiltinViewer): void {
  if (!id) throw new Error('Builtin viewer requires an id');
  registry.set(id, viewer);
}

export function builtinViewer(id: string): BuiltinViewer | null {
  return registry.get(id) || null;
}

export function listBuiltinViewers(): string[] {
  return [...registry.keys()];
}
