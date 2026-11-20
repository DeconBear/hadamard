import type { NotebookEditorCell } from './types.js';
import type { NotebookVariables } from './variables.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function identifiers(source: string): Set<string> {
  return new Set((source.match(/[A-Za-z_][A-Za-z0-9_]*/gu) || []).filter(name => IDENTIFIER.test(name)));
}

export function cellVariableAccess(cell: NotebookEditorCell, variables: NotebookVariables): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  if (cell.kind !== 'code') return { reads, writes };
  const source = cell.source;
  for (const match of source.matchAll(/\bhc_set\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gu)) writes.add(match[1]!);
  for (const match of source.matchAll(/(?:^|\n)\s*(?:const\s+)?(?:double|float|int|long|bool|auto|std::string|string|var)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+=|-=|\*=|\/=|=[^=])/gu)) writes.add(match[1]!);
  const known = new Set(Object.keys(variables));
  for (const name of identifiers(source)) if (known.has(name)) reads.add(name);
  for (const name of writes) reads.delete(name);
  for (const match of source.matchAll(/\bhc_get\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gu)) reads.add(match[1]!);
  return { reads, writes };
}

export function affectedCellIds(cells: NotebookEditorCell[], changedCellIds: Iterable<string> = [], changedVariables: Iterable<string> = [], variables: NotebookVariables = {}): Set<string> {
  const changedCells = new Set(changedCellIds);
  const dirtyVariables = new Set(changedVariables);
  const affected = new Set<string>();
  for (const cell of cells) {
    if (cell.kind !== 'code') continue;
    const access = cellVariableAccess(cell, variables);
    const directlyChanged = changedCells.has(cell.id);
    const readsDirty = [...access.reads].some(name => dirtyVariables.has(name));
    if (directlyChanged || readsDirty) affected.add(cell.id);
    if (affected.has(cell.id)) for (const name of access.writes) dirtyVariables.add(name);
  }
  return affected;
}
