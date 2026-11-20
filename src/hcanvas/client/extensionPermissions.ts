export interface WorkspaceFileGrantContext {
  rootId: string;
  filePath: string;
  mode: 'read' | 'write';
  workspaceRootId: string;
  currentFile?: { rootId: string; path: string };
  workspace?: { read?: unknown; write?: unknown };
}

export function normalizeCapabilityPath(value: string): string | null {
  const parts: string[] = [];
  for (const part of value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.join('/');
}

export function pathAllowed(filePath: string, entries: unknown): boolean {
  if (!Array.isArray(entries) || !entries.length) return false;
  const file = normalizeCapabilityPath(filePath);
  if (file === null) return false;
  return entries.some(entry => {
    if (typeof entry !== 'string') return false;
    const allowed = normalizeCapabilityPath(entry);
    if (allowed === null) return false;
    return allowed === '' || file === allowed || file.startsWith(allowed + '/');
  });
}

export function workspaceFileAllowed(context: WorkspaceFileGrantContext): boolean {
  if (context.mode === 'read' && context.currentFile?.rootId === context.rootId && context.currentFile.path === context.filePath) return true;
  if (context.rootId !== context.workspaceRootId) return false;
  return pathAllowed(context.filePath, context.workspace?.[context.mode]);
}
