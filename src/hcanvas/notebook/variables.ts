export type NotebookVariableValue = string | number | boolean | null | NotebookVariableValue[] | { [key: string]: NotebookVariableValue };
export type NotebookVariables = Record<string, NotebookVariableValue>;

export const NOTEBOOK_VARIABLES_MIME = 'application/vnd.hcanvas.variables+json';
export const NOTEBOOK_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PYTHON_KEYWORDS = 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case';
const CPP_KEYWORDS = 'alignas alignof and and_eq asm auto bitand bitor bool break case catch char char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq';
const OCTAVE_KEYWORDS = 'break case catch classdef continue do else elseif end end_try_catch end_unwind_protect endclassdef endenumeration endevents endfor endfunction endif endmethods endparfor endproperties endspmd endswitch endwhile enumeration events for function global if methods otherwise parfor persistent properties return spmd switch try until unwind_protect unwind_protect_cleanup while';
const HELPER_NAMES = 'hc_get hc_set hc_vars hc_display main';
const RESERVED_NAMES = new Set((PYTHON_KEYWORDS + ' ' + CPP_KEYWORDS + ' ' + OCTAVE_KEYWORDS + ' ' + HELPER_NAMES).split(' ').filter(Boolean));

export function isNotebookVariableName(name: string): boolean {
  return NOTEBOOK_VARIABLE_NAME.test(name) && !name.startsWith('__') && !RESERVED_NAMES.has(name);
}

function normalizeValue(value: unknown, depth: number): NotebookVariableValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth > 8 || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    const result: NotebookVariableValue[] = [];
    for (const item of value) {
      const normalized = normalizeValue(item, depth + 1);
      if (normalized === undefined) return undefined;
      result.push(normalized);
    }
    return result;
  }
  const result: { [key: string]: NotebookVariableValue } = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizeValue(item, depth + 1);
    if (normalized === undefined) return undefined;
    result[key] = normalized;
  }
  return result;
}

export function normalizeNotebookVariables(raw: unknown): NotebookVariables {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: NotebookVariables = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isNotebookVariableName(name)) continue;
    const normalized = normalizeValue(value, 0);
    if (normalized === undefined) continue;
    result[name] = normalized;
    if (Object.keys(result).length >= 100) break;
  }
  return result;
}

export function parseNotebookVariable(name: string, source: string): NotebookVariableValue {
  const trimmedName = name.trim();
  if (!isNotebookVariableName(trimmedName)) throw new Error('Use a portable name that is not a Python, Octave or C++ keyword, for example distance or total_cost.');
  const text = source.trim();
  let value: unknown = text;
  if (!text) value = '';
  else {
    try { value = JSON.parse(text); } catch { value = text; }
  }
  const normalized = normalizeValue(value, 0);
  if (normalized === undefined) throw new Error('Variables must be finite JSON values with at most eight nested levels.');
  if (JSON.stringify(normalized).length > 256 * 1024) throw new Error('A shared variable cannot exceed 256 KiB.');
  return normalized;
}

interface VariableEvent {
  kind: string;
  data?: Record<string, unknown>;
}

export function variablesFromEvents(events: VariableEvent[]): NotebookVariables {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if ((event.kind !== 'display' && event.kind !== 'result') || !event.data) continue;
    const value = event.data[NOTEBOOK_VARIABLES_MIME];
    if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeNotebookVariables(value);
  }
  return {};
}

export function visibleKernelEvents<T extends VariableEvent>(events: T[]): T[] {
  return events.filter(event => !event.data || !(NOTEBOOK_VARIABLES_MIME in event.data));
}

export function variableValueText(value: NotebookVariableValue): string {
  // JSON quote strings too: editing a value must not turn "42" into the number 42.
  return JSON.stringify(value);
}

export function variableValueKind(value: NotebookVariableValue): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

export interface NotebookVariableState {
  variables?: NotebookVariables;
  initialVariables?: NotebookVariables;
  variablesInitialized?: boolean;
}

export function normalizeNotebookVariableState(data: NotebookVariableState): void {
  const current = normalizeNotebookVariables(data.variables);
  data.initialVariables = normalizeNotebookVariables(data.initialVariables === undefined ? current : data.initialVariables);
  data.variables = current;
  data.variablesInitialized = data.variablesInitialized === true || (data.variablesInitialized === undefined && Object.keys(current).length > 0);
}

export function initializeNotebookVariables(data: NotebookVariableState): NotebookVariables {
  data.variables = normalizeNotebookVariables(data.initialVariables);
  data.variablesInitialized = true;
  return data.variables;
}
