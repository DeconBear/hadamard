import { describe, expect, it } from 'vitest';
import { initializeNotebookVariables, normalizeNotebookVariableState, type NotebookVariableState } from '../src/hcanvas/notebook/variables.js';

describe('notebook initial and current variables', () => {
  it('does not initialize current values from editable initial values', () => {
    const data: NotebookVariableState = { initialVariables: { distance: 2 } };
    normalizeNotebookVariableState(data);
    expect(data.variables).toEqual({});
    expect(data.variablesInitialized).toBe(false);
    expect(data.initialVariables).toEqual({ distance: 2 });
  });

  it('initializes with an independent snapshot and preserves initial values', () => {
    const data: NotebookVariableState = { initialVariables: { distance: 2, nested: [1, 2] }, variables: { distance: 9 }, variablesInitialized: true };
    initializeNotebookVariables(data);
    expect(data.variables).toEqual({ distance: 2, nested: [1, 2] });
    expect(data.variables).not.toBe(data.initialVariables);
    data.variables!.distance = 4;
    expect(data.initialVariables).toEqual({ distance: 2, nested: [1, 2] });
  });

  it('keeps persisted current values and an explicit uninitialized state', () => {
    const saved: NotebookVariableState = { initialVariables: { distance: 2 }, variables: { distance: 4 }, variablesInitialized: true };
    normalizeNotebookVariableState(saved);
    expect(saved.variables).toEqual({ distance: 4 });
    expect(saved.variablesInitialized).toBe(true);
    const pending: NotebookVariableState = { initialVariables: { distance: 2 }, variables: { derived: 8 }, variablesInitialized: false };
    normalizeNotebookVariableState(pending);
    expect(pending.variablesInitialized).toBe(false);
  });
});
