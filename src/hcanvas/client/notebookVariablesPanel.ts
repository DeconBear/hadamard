import type { NotebookEditorData } from '../notebook/types.js';
import { variableValueKind, variableValueText } from '../notebook/variables.js';
import { esc } from './utils.js';

export function notebookVariableNames(data: NotebookEditorData): string[] {
  return [...new Set([...Object.keys(data.initialVariables || {}), ...Object.keys(data.variables || {})])];
}

export function renderNotebookVariablesPanel(data: NotebookEditorData): string {
  const initial = data.initialVariables || {};
  const current = data.variables || {};
  const initialized = data.variablesInitialized === true;
  const rows = notebookVariableNames(data).map(name => {
    const hasInitial = Object.prototype.hasOwnProperty.call(initial, name);
    const hasCurrent = Object.prototype.hasOwnProperty.call(current, name);
    const initialValue = hasInitial ? initial[name]! : current[name]!;
    const currentText = hasCurrent ? variableValueText(current[name]!) : '—';
    return '<div class="nb-variable-row" data-nb-variable-row="' + esc(name) + '">' +
      '<input class="nb-variable-name" data-nb-variable-name value="' + esc(name) + '" aria-label="Variable name"' + (hasInitial ? '' : ' readonly title="Derived by code; no initial value"') + '>' +
      (hasInitial
        ? '<input class="nb-variable-value" data-nb-variable-value value="' + esc(variableValueText(initial[name]!)) + '" aria-label="Initial value of ' + esc(name) + '" spellcheck="false">'
        : '<span class="nb-variable-unset" title="No initial value; this variable is derived by code">—</span>') +
      '<output class="nb-variable-current" data-nb-variable-current data-set="' + String(hasCurrent) + '" title="' + esc(currentText) + '">' + esc(currentText) + '</output>' +
      '<span class="nb-variable-kind">' + esc(variableValueKind(hasCurrent ? current[name]! : initialValue)) + '</span>' +
      (hasInitial ? '<button type="button" class="nb-icon-btn danger" data-nb-variable-delete="' + esc(name) + '" title="Remove initial value" aria-label="Remove ' + esc(name) + '">×</button>' : '<span></span>') +
      '</div>';
  }).join('');
  return '<div class="nb-variable-intro"><div><strong>Variables</strong><small>Edit initial values. Initialize or Run all applies them; code updates current values.</small></div><div class="nb-variable-settings"><span class="nb-variable-state" data-nb-variable-state data-state="' + String(initialized) + '">' + (initialized ? 'Initialized' : 'Not initialized') + '</span><button type="button" class="btn tiny primary" data-nb-variable-initialize title="Copy initial values to current values without running cells">Initialize</button></div></div>' +
    '<div class="nb-variable-head"><span>Name</span><span>Initial value</span><span>Current value</span><span>Type</span><span></span></div>' +
    (rows || '<p class="nb-variable-empty">No initial values yet. Add one below, or publish a current value with <code>hc_set("answer", 42)</code>.</p>') +
    '<div class="nb-variable-add"><input data-nb-new-name placeholder="distance" aria-label="New variable name" spellcheck="false"><input data-nb-new-value placeholder="120.5" aria-label="New initial value" spellcheck="false"><button type="button" class="btn tiny" data-nb-variable-add>Add initial</button></div>' +
    '<div class="nb-variable-io"><button type="button" class="btn tiny" data-nb-variable-import>Import initial JSON / CSV</button><button type="button" class="btn tiny" data-nb-variable-export>Export initial JSON</button><input type="file" data-nb-variable-file accept=".json,.csv,application/json,text/csv" hidden></div>';
}
