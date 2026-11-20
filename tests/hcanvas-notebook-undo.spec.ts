import { describe, expect, it } from 'vitest';
import { NotebookUndoHistory } from '../src/hcanvas/notebook/undo.js';
import type { NotebookEditorCell } from '../src/hcanvas/client/notebookEditor.js';

describe('notebook structural undo history', () => {
  it('restores cells and shared variables with independent snapshots', () => {
    const history = new NotebookUndoHistory();
    const cells: NotebookEditorCell[] = [{ id: 'a', kind: 'code', source: 'print(a)' }];
    history.capture(cells, { a: 1 });
    cells.push({ id: 'b', kind: 'markdown', source: 'changed' });
    const restored = history.restore();
    expect(restored?.cells).toHaveLength(1);
    expect(restored?.variables).toEqual({ a: 1 });
    expect(restored?.cells[0]).not.toBe(cells[0]);
  });

  it('bounds history and returns null when empty', () => {
    const history = new NotebookUndoHistory(2);
    const cells: NotebookEditorCell[] = [{ id: 'a', kind: 'code', source: '' }];
    history.capture(cells, {});
    history.capture(cells, { a: 2 });
    history.capture(cells, { a: 3 });
    expect(history.size).toBe(2);
    expect(history.restore()?.variables).toEqual({ a: 3 });
    expect(history.restore()?.variables).toEqual({ a: 2 });
    expect(history.restore()).toBeNull();
  });
});
