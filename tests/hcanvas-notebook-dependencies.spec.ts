import { describe, expect, it } from 'vitest';
import { affectedCellIds, cellVariableAccess } from '../src/hcanvas/notebook/cellDependencies.js';
import type { NotebookEditorCell } from '../src/hcanvas/notebook/types.js';

const variables = { omega0: 2, period: 3, derived: 4 };
const cells: NotebookEditorCell[] = [
  { id: 'intro', kind: 'markdown', source: 'omega0 should not execute' },
  { id: 'first', kind: 'code', source: 'period = 2 * pi / omega0\nhc_set("period", period)' },
  { id: 'second', kind: 'code', source: 'derived = period * 2\nhc_set("derived", derived)' },
  { id: 'third', kind: 'code', source: 'print("independent")' },
];

describe('notebook variable dependency analysis', () => {
  it('finds direct reads and explicit writes', () => {
    const access = cellVariableAccess(cells[1]!, variables);
    expect(access.reads).toEqual(new Set(['omega0']));
    expect(access.writes).toEqual(new Set(['period']));
  });

  it('keeps an explicit shared read when the cell writes the same name', () => {
    const cell: NotebookEditorCell = { id: 'parameter', kind: 'code', source: 'distance = hc_get("distance", 2)\nhc_set("distance", distance)' };
    const access = cellVariableAccess(cell, { distance: 2 });
    expect(access.reads).toEqual(new Set(['distance']));
    expect(affectedCellIds([cell], [], ['distance'], { distance: 4 })).toEqual(new Set(['parameter']));
  });

  it('marks changed variables and downstream producers as affected', () => {
    expect(affectedCellIds(cells, [], ['omega0'], variables)).toEqual(new Set(['first', 'second']));
    expect(affectedCellIds(cells, ['first'], [], variables)).toEqual(new Set(['first', 'second']));
  });

  it('leaves independent cells alone', () => {
    expect(affectedCellIds(cells, [], ['missing'], variables)).toEqual(new Set());
    expect(affectedCellIds(cells, ['third'], [], variables)).toEqual(new Set(['third']));
  });
});
