import { normalizeNotebookVariables, parseNotebookVariable, type NotebookVariables } from './variables.js';

function csvRow(line: string): string[] {
  const cells: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { cells.push(value); value = ''; }
    else value += char;
  }
  cells.push(value);
  return cells;
}

export function parseVariablesCsv(text: string): NotebookVariables {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter(line => line.trim());
  if (!lines.length) return {};
  const rows = lines.map(csvRow);
  const header = rows[0]?.map(value => value.trim().toLowerCase());
  const hasHeader = header?.[0] === 'name' && (header[1] === 'value' || header[1] === 'json');
  const variables: NotebookVariables = {};
  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    if (!row[0]?.trim()) continue;
    const name = row[0].trim();
    variables[name] = parseNotebookVariable(name, row[1] ?? '');
  }
  return normalizeNotebookVariables(variables);
}

export function parseVariablesJson(text: string): NotebookVariables {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Variable JSON must be an object of name/value entries.');
  return normalizeNotebookVariables(value);
}

export function serializeVariablesJson(variables: NotebookVariables): string {
  return JSON.stringify(variables, null, 2) + '\n';
}
