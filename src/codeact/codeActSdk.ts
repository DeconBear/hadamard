import { z } from 'zod';

import type { AgentToolDefinition } from '../types.js';

/**
 * CodeAct typed host-tool SDK generation: projects host tool schemas into
 * Python stub text the model programs against inside CodeCell code (the dsh
 * tools:sdk equivalent for the Python kernel). One source of truth is the
 * tool definition (inputSchema + outputSchema), so a stub can never drift
 * from the dispatch surface.
 *
 * @module src/codeact/codeActSdk
 */

const PYTHON_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  'match', 'case', 'type',
]);

/** Fixed HadamardHost methods the kernel already implements directly. */
export const RESERVED_HOST_METHODS: ReadonlySet<string> = new Set([
  'call', 'tool', 'tool_schema', 'artifact', 'read', 'write', 'search',
]);

/** Nesting cap: beyond this a schema node degrades to a broad type. */
const MAX_RENDER_DEPTH = 4;
/** Default SDK section size cap before folding kicks in. */
export const DEFAULT_MAX_SDK_CHARS = 24_000;
/** Docstring cap per tool. */
const MAX_DOC_CHARS = 280;

export interface CodeActSdkRenderOptions {
  /** Fold docstrings (then truncate the tool list) beyond this size. */
  maxChars?: number;
}

/** Deterministic sanitization shared by the renderer and the kernel tool map. */
export function sanitizeCodeActName(name: string): string {
  let out = name.replace(/[^A-Za-z0-9_]+/g, '_');
  if (!/^[A-Za-z_]/.test(out)) out = `_${out}`;
  if (PYTHON_KEYWORDS.has(out)) out = `${out}_`;
  return /^_*$/.test(out) ? 'tool' : out;
}

interface SdkStub {
  methodName: string;
  realName: string;
  signature: string;
  doc: string;
  purpose: string;
}

interface SdkReservedNote {
  realName: string;
  note: string;
  purpose: string;
}

/**
 * Render the typed host-tool stubs for the given tools (CodeCell itself is
 * excluded). Stable byte-for-byte output for a stable tool set: tools are
 * sorted by name and schema fields render in declaration order.
 */
export function renderCodeActHostSdk(
  tools: readonly AgentToolDefinition[],
  options: CodeActSdkRenderOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_SDK_CHARS;
  const stubs: SdkStub[] = [];
  const reservedNotes: SdkReservedNote[] = [];
  const sortedTools = [...tools].sort((left, right) => left.name.localeCompare(right.name));
  const sanitizedCounts = countDynamicMethodNames(sortedTools);
  const visibleTools = sortedTools.filter((tool) => tool.name !== 'CodeCell' && tool.name !== 'run_code');
  const untypedCount = visibleTools.filter((tool) => !tool.outputSchema).length;

  for (const tool of sortedTools) {
    if (tool.name === 'CodeCell' || tool.name === 'run_code') continue;
    const fixedMethodName = FIXED_HELPER_METHODS[tool.name];
    if (fixedMethodName) {
      stubs.push({
        methodName: fixedMethodName,
        realName: tool.name,
        signature: renderToolSignature(tool, fixedMethodName),
        doc: `${collapseDoc(tool.description)} Host tool: ${tool.name}.`,
        purpose: oneLinePurpose(tool.description),
      });
      continue;
    }
    const methodName = sanitizeCodeActName(tool.name);
    if (RESERVED_HOST_METHODS.has(methodName)) {
      reservedNotes.push({
        realName: tool.name,
        note: `# Host tool "${tool.name}" collides with the reserved ${methodName} helper; call hadamard.tool("${tool.name}", {...}) with: ${describeSchema(tool.inputJsonSchema)}.`,
        purpose: oneLinePurpose(tool.description),
      });
      continue;
    }
    if ((sanitizedCounts.get(methodName) ?? 0) > 1) {
      reservedNotes.push({
        realName: tool.name,
        note: `# Host tool "${tool.name}" and another host tool share the sanitized Python name ${methodName}; call hadamard.tool("${tool.name}", {...}) with: ${describeSchema(tool.inputJsonSchema)}.`,
        purpose: oneLinePurpose(tool.description),
      });
      continue;
    }
    const { omitted } = renderParams(tool.inputJsonSchema);
    const docParts = [collapseDoc(tool.description), `Host tool: ${tool.name}.`];
    if (methodName !== tool.name) docParts.push(`Called as hadamard.${methodName}.`);
    if (omitted.length > 0) {
      docParts.push(`Not keyword-accessible (invalid Python identifiers): ${omitted.join(', ')}.`);
    }
    stubs.push({
      methodName,
      realName: tool.name,
      signature: renderToolSignature(tool, methodName),
      doc: docParts.join(' '),
      purpose: oneLinePurpose(tool.description),
    });
  }

  const header = [
    '# Typed host-tool stubs reachable from CodeCell code through the global',
    '# `hadamard` object. Signatures are authoritative for parameter names; every',
    '# method dispatches the matching host tool, and `hadamard.tool("<name>", {...})` stays',
    '# available for tools without a typed stub.',
    '# A failed host call raises HadamardToolError with a `tool_name` attribute;',
    '# catch it to branch on which tool failed.',
    '# Any tool schema is queryable on demand with hadamard.tool_schema("<ToolName>").',
    ...(untypedCount > 0
      ? [`# Degraded typing: ${untypedCount} of ${visibleTools.length} visible tool(s) declare no output schema, so their results are untyped (Any) — treat them as opaque and degrade accordingly.`]
      : []),
  ].join('\n');

  let body = renderStubClass(stubs, reservedNotes, true);
  if (body.length > maxChars) {
    body = renderStubClass(stubs, reservedNotes, false);
  }
  if (body.length > maxChars) {
    const truncated: string[] = [];
    let size = 0;
    for (const stub of stubs) {
      const line = `    def ${stub.signature}: ...  # ${stub.realName}`;
      if (size + line.length + 1 > maxChars - 400) break;
      truncated.push(line);
      size += line.length + 1;
    }
    const omittedIndex = [
      ...stubs.slice(truncated.length).map(stub => ({ name: stub.realName, purpose: stub.purpose })),
      ...reservedNotes.map(note => ({ name: note.realName, purpose: note.purpose })),
    ];
    const lines: string[] = [
      'class HadamardHost:',
      '    """Host-tool bridge (truncated typed surface)."""',
      ...truncated,
    ];
    const noteLines = [
      `    # ${omittedIndex.length} further host tool(s) omitted for prompt budget; the index below keeps every remaining tool discoverable.`,
      '    # Query any tool schema on demand with hadamard.tool_schema("<ToolName>").',
    ];
    const budget = Math.max(0, maxChars - lines.join('\n').length - noteLines.join('\n').length - 2);
    const indexLines: string[] = [];
    let used = 0;
    for (const entry of omittedIndex) {
      const line = `    # ${entry.name} — ${entry.purpose}`;
      if (used + line.length + 1 > budget) break;
      indexLines.push(line);
      used += line.length + 1;
    }
    const rest = omittedIndex.slice(indexLines.length).map(entry => entry.name);
    if (rest.length > 0) {
      // Discovery floor: every remaining name stays visible in a compact
      // budget-exempt index (names are short; the cap protects against
      // doc/schema blowup, which is the actual prompt-flooding risk).
      const prefix = '    # Compact name index: ';
      let current = prefix;
      for (const name of rest) {
        const piece = (current === prefix ? '' : ', ') + name;
        if (current.length + piece.length > 96) {
          indexLines.push(current);
          current = `    # ${name}`;
        } else {
          current += piece;
        }
      }
      indexLines.push(current);
      indexLines.push('    # (schema on demand: hadamard.tool_schema("<name>"))');
    }
    body = [...lines, ...noteLines, ...indexLines].join('\n');
  }
  if (body.length === 0) return '';
  return `${header}\n${body}`;
}

function renderStubClass(
  stubs: readonly SdkStub[],
  reservedNotes: readonly SdkReservedNote[],
  withDocs: boolean,
): string {
  const lines: string[] = [
    'class HadamardHost:',
    '    """Host-tool bridge (typed surface)."""',
  ];
  if (!withDocs) {
    lines.push('    # Docstrings folded for prompt budget; parameter names remain authoritative.');
  }
  for (const stub of stubs) {
    if (withDocs) {
      lines.push('');
      lines.push(`    def ${stub.signature}:`);
      lines.push(`        """${stub.doc}"""`);
      lines.push('        ...');
    } else {
      lines.push(`    def ${stub.signature}: ...`);
    }
  }
  for (const note of reservedNotes) {
    lines.push('');
    lines.push(`    ${note.note}`);
  }
  return lines.join('\n');
}

/** Fixed kernel helpers whose behavior is wired in the kernel program itself. */
const FIXED_HELPER_METHODS: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Grep: 'search',
};

function renderToolSignature(tool: AgentToolDefinition, methodName: string): string {
  const { params } = renderParams(tool.inputJsonSchema);
  const returnType = tool.outputSchema
    ? jsonSchemaToPythonType(z.toJSONSchema(tool.outputSchema))
    : 'Any';
  return params.length > 0
    ? `${methodName}(self, ${params.join(', ')}) -> ${returnType}`
    : `${methodName}(self) -> ${returnType}`;
}

function countDynamicMethodNames(tools: readonly AgentToolDefinition[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    if (tool.name === 'CodeCell' || FIXED_HELPER_METHODS[tool.name]) continue;
    const methodName = sanitizeCodeActName(tool.name);
    if (RESERVED_HOST_METHODS.has(methodName)) continue;
    counts.set(methodName, (counts.get(methodName) ?? 0) + 1);
  }
  return counts;
}

/** Build the collision-safe typed-method dispatch map used by the kernel. */
export function buildCodeActToolNameMap(
  tools: readonly AgentToolDefinition[],
): Record<string, string> {
  const counts = countDynamicMethodNames(tools);
  const result: Record<string, string> = {};
  for (const tool of [...tools].sort((left, right) => left.name.localeCompare(right.name))) {
    if (tool.name === 'CodeCell' || FIXED_HELPER_METHODS[tool.name]) continue;
    const methodName = sanitizeCodeActName(tool.name);
    if (RESERVED_HOST_METHODS.has(methodName) || counts.get(methodName) !== 1) continue;
    result[methodName] = tool.name;
  }
  return result;
}

function collapseDoc(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim().replace(/"""/g, "''\"");
  return collapsed.length > MAX_DOC_CHARS ? `${collapsed.slice(0, MAX_DOC_CHARS - 3)}...` : collapsed;
}

/** Compact one-line purpose for the truncated-discovery index. */
function oneLinePurpose(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim();
  return collapsed.length > 90 ? `${collapsed.slice(0, 87)}...` : collapsed;
}

function describeSchema(schema: unknown): string {
  const record = isRecord(schema) ? schema : {};
  const properties = isRecord(record.properties) ? record.properties : {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    parts.push(`${key}: ${jsonSchemaToPythonType(value)}`);
  }
  return parts.length > 0 ? parts.join(', ') : jsonSchemaToPythonType(schema);
}

function renderParams(schema: unknown): { params: string[]; omitted: string[] } {
  if (!isRecord(schema)) return { params: [], omitted: [] };
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  const params: string[] = [];
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (!PYTHON_IDENTIFIER.test(key)) {
      omitted.push(key);
      continue;
    }
    const type = jsonSchemaToPythonType(value);
    if (required.has(key)) {
      params.push(`${key}: ${type}`);
    } else {
      params.push(`${key}: ${type} | None = None`);
    }
  }
  return { params, omitted };
}

/** Render one JSON Schema node as a Python type annotation (bounded depth). */
export function jsonSchemaToPythonType(schema: unknown, depth = 0): string {
  if (!isRecord(schema) || depth > MAX_RENDER_DEPTH) return 'Any';
  if (schema.const !== undefined) return renderLiteral(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return renderLiteralUnion(schema.enum);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return renderSchemaUnion(schema.anyOf, depth);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return renderSchemaUnion(schema.oneOf, depth);
  }
  if (Array.isArray(schema.type)) {
    return renderSchemaUnion(schema.type.map((entry) => ({ type: entry })), depth);
  }
  switch (schema.type) {
    case 'string': return 'str';
    case 'integer': return 'int';
    case 'number': return 'float';
    case 'boolean': return 'bool';
    case 'null': return 'None';
    case 'array': {
      const items = jsonSchemaToPythonType(schema.items, depth + 1);
      return `list[${items}]`;
    }
    case 'object': {
      if (depth >= MAX_RENDER_DEPTH) return 'dict[str, Any]';
      const properties = isRecord(schema.properties) ? schema.properties : {};
      if (Object.keys(properties).length === 0) return 'dict[str, Any]';
      // Nested objects stay bounded: dict with an item type when homogeneous.
      const itemTypes = new Set(Object.values(properties).map((entry) => jsonSchemaToPythonType(entry, depth + 1)));
      if (itemTypes.size === 1) return `dict[str, ${[...itemTypes][0]}]`;
      return 'dict[str, Any]';
    }
    default: return 'Any';
  }
}

function renderSchemaUnion(members: readonly unknown[], depth: number): string {
  const types = new Set<string>();
  for (const member of members.slice(0, 5)) {
    types.add(jsonSchemaToPythonType(member, depth + 1));
  }
  if (members.length > 5) types.add('Any');
  return types.size === 1 ? [...types][0]! : [...types].join(' | ');
}

function renderLiteralUnion(values: readonly unknown[]): string {
  const literals = new Set<string>();
  for (const value of values.slice(0, 6)) {
    literals.add(renderLiteral(value));
  }
  if (values.length > 6) literals.add('Any');
  return literals.size === 1 ? [...literals][0]! : [...literals].join(' | ');
}

function renderLiteral(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'string') return `Literal['${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
  if (typeof value === 'number') return `Literal[${value}]`;
  if (typeof value === 'boolean') return `Literal[${value ? 'True' : 'False'}]`;
  return 'Any';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
