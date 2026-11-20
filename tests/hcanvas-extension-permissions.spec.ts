import { describe, expect, it } from 'vitest';
import { normalizeCapabilityPath, pathAllowed, workspaceFileAllowed } from '../src/hcanvas/client/extensionPermissions.js';

describe('extension workspace file permissions', () => {
  it('normalizes relative paths and grants directory prefixes only', () => {
    expect(normalizeCapabilityPath('./docs/notebook.hnb.md')).toBe('docs/notebook.hnb.md');
    expect(normalizeCapabilityPath('../secret')).toBeNull();
    expect(pathAllowed('docs/demo.txt', ['docs'])).toBe(true);
    expect(pathAllowed('docs-old/demo.txt', ['docs'])).toBe(false);
    expect(pathAllowed('README.md', ['.'])).toBe(true);
  });

  it('binds grants to the active workspace root', () => {
    const workspace = { read: ['.'], write: ['docs'] };
    expect(workspaceFileAllowed({ rootId: 'root_default', workspaceRootId: 'root_default', filePath: 'README.md', mode: 'read', workspace })).toBe(true);
    expect(workspaceFileAllowed({ rootId: 'root_other', workspaceRootId: 'root_default', filePath: 'README.md', mode: 'read', workspace })).toBe(false);
    expect(workspaceFileAllowed({ rootId: 'root_other', workspaceRootId: 'root_default', filePath: 'docs/demo.txt', mode: 'write', workspace })).toBe(false);
    expect(workspaceFileAllowed({ rootId: 'root_default', workspaceRootId: 'root_default', filePath: '../secret', mode: 'read', workspace })).toBe(false);
  });

  it('allows the viewer current file read without widening write access', () => {
    const currentFile = { rootId: 'root_other', path: 'viewer.svg' };
    expect(workspaceFileAllowed({ rootId: 'root_other', workspaceRootId: 'root_default', filePath: 'viewer.svg', mode: 'read', currentFile, workspace: {} })).toBe(true);
    expect(workspaceFileAllowed({ rootId: 'root_other', workspaceRootId: 'root_default', filePath: 'viewer.svg', mode: 'write', currentFile, workspace: { write: ['.'] } })).toBe(false);
  });
});
