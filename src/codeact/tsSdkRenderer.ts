/**
 * TypeScript host-tool SDK renderer for the stateless run_code presentation
 * (dsh ts-types equivalent, Hadamard-owned). Projects host tool schemas into
 * a `declare const tools` block the model programs against inside run_code.
 * Stable byte-for-byte output for a stable tool set: tools are sorted by name
 * and schema fields render in declaration order.
 *
 * @module src/codeact/tsSdkRenderer
 */
import { z } from 'zod';
import type { AgentToolDefinition } from '../types.js';

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const TS_RESERVED_WORDS: ReadonlySet<string> = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval', 'async',
]);

/** Reserved raw-dispatch escape on the tools namespace. */
export const TS_SDK_CALL_MEMBER = 'call';

const MAX_RENDER_DEPTH = 4;
export const DEFAULT_MAX_TS_SDK_CHARS = 24_000;
const MAX_DOC_CHARS = 280;

/** Deterministic sanitization shared by the renderer and any dispatch map. */
export function sanitizeTsName(name: string): string {
  let out = name.replace(/[^A-Za-z0-9_$]+/g, '_');
  if (!/^[A-Za-z_$]/.test(out)) out = '_' + out;
  if (TS_RESERVED_WORDS.has(out)) out = out + '_';
  return /^_*$/.test(out) ? 'tool' : out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonSchemaToTsType(schema: unknown, depth = 0): string {
  if (!isRecord(schema) || depth > MAX_RENDER_DEPTH) return 'unknown';
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals = new Set<string>();
    for (const value of schema.enum.slice(0, 6)) literals.add(JSON.stringify(value));
    if (schema.enum.length > 6) literals.add('unknown');
    return literals.size === 1 ? [...literals][0]! : [...literals].join(' | ');
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return renderUnion(schema.anyOf, depth);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return renderUnion(schema.oneOf, depth);
  if (Array.isArray(schema.type)) return renderUnion(schema.type.map((entry) => ({ type: entry })), depth);
  switch (schema.type) {
    case 'string': return 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': {
      const items = jsonSchemaToTsType(schema.items, depth + 1);
      return items + '[]';
    }
    case 'object': {
      if (depth >= MAX_RENDER_DEPTH) return 'Record<string, unknown>';
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const entries = Object.keys(properties);
      if (entries.length === 0) return 'Record<string, unknown>';
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
      const parts = entries.map((key) => {
        const fieldType = jsonSchemaToTsType(properties[key], depth + 1);
        const safeKey = TS_IDENTIFIER.test(key) ? key : JSON.stringify(key);
        return safeKey + (required.has(key) ? '' : '?') + ': ' + fieldType + ';';
      });
      return '{ ' + parts.join(' ') + ' }';
    }
    default: return 'unknown';
  }
}

function renderUnion(members: readonly unknown[], depth: number): string {
  const types = new Set<string>();
  for (const member of members.slice(0, 5)) types.add(jsonSchemaToTsType(member, depth + 1));
  if (members.length > 5) types.add('unknown');
  return types.size === 1 ? [...types][0]! : [...types].join(' | ');
}

function collapseDoc(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_DOC_CHARS ? collapsed.slice(0, MAX_DOC_CHARS - 3) + '...' : collapsed;
}

function oneLinePurpose(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim();
  return collapsed.length > 90 ? collapsed.slice(0, 87) + '...' : collapsed;
}

interface TsStub {
  memberName: string;
  realName: string;
  signature: string;
  doc: string;
  purpose: string;
}

function renderToolSignature(tool: AgentToolDefinition, memberName: string): string {
  const properties = isRecord(tool.inputJsonSchema) && isRecord(tool.inputJsonSchema.properties)
    ? tool.inputJsonSchema.properties
    : {};
  const required = new Set(
    isRecord(tool.inputJsonSchema) && Array.isArray(tool.inputJsonSchema.required)
      ? tool.inputJsonSchema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  const returnType = tool.outputSchema ? jsonSchemaToTsType(z.toJSONSchema(tool.outputSchema)) : 'unknown';
  const entries = Object.keys(properties);
  const argsType = entries.length === 0
    ? 'undefined'
    : '{ ' + entries.map((key) => {
        const fieldType = jsonSchemaToTsType(properties[key]);
        const safeKey = TS_IDENTIFIER.test(key) ? key : JSON.stringify(key);
        return safeKey + (required.has(key) ? '' : '?') + ': ' + fieldType + ';';
      }).join(' ') + ' }';
  return memberName + '(args: ' + argsType + '): Promise<' + returnType + '>;';
}

/**
 * Render the typed host-tool SDK for the TypeScript run_code backend.
 * Byte-stable for a stable tool set; budget folding mirrors the Python SDK.
 */
export function renderTsHostSdk(
  tools: readonly AgentToolDefinition[],
  options: { maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_TS_SDK_CHARS;
  const stubs: TsStub[] = [];
  const omitted: { name: string; purpose: string }[] = [];
  const sortedTools = [...tools].sort((left, right) => left.name.localeCompare(right.name));
  const visibleTools = sortedTools.filter((tool) => tool.name !== 'CodeCell' && tool.name !== 'run_code');
  const untypedCount = visibleTools.filter((tool) => !tool.outputSchema).length;
  const counts = new Map<string, number>();
  for (const tool of visibleTools) {
    if (tool.name === TS_SDK_CALL_MEMBER) continue;
    const member = sanitizeTsName(tool.name);
    counts.set(member, (counts.get(member) ?? 0) + 1);
  }
  for (const tool of visibleTools) {
    if (tool.name === TS_SDK_CALL_MEMBER) {
      omitted.push({ name: tool.name, purpose: oneLinePurpose(tool.description) });
      continue;
    }
    const memberName = sanitizeTsName(tool.name);
    if ((counts.get(memberName) ?? 0) > 1) {
      omitted.push({ name: tool.name, purpose: oneLinePurpose(tool.description) });
      continue;
    }
    stubs.push({
      memberName,
      realName: tool.name,
      signature: renderToolSignature(tool, memberName),
      doc: collapseDoc(tool.description) + ' Host tool: ' + tool.name + '.' + (memberName !== tool.name ? ' Called as tools.' + memberName + '.' : ''),
      purpose: oneLinePurpose(tool.description),
    });
  }

  const headerLines = [
    '// Typed host-tool surface reachable from run_code programs through the global',
    '// `tools` object. Call tools as `await tools.<name>(args)`; signatures are',
    '// authoritative for parameter names. A failed host call rejects with',
    '// ToolCallError carrying the failing tool name on `toolName`.',
  ];
  if (untypedCount > 0) {
    headerLines.push('// Degraded typing: ' + untypedCount + ' of ' + visibleTools.length + ' visible tool(s) declare no output schema, so their results are untyped (unknown).');
  }
  const header = headerLines.join('\n');

  const withDocs = (stubList: readonly TsStub[]): string => {
    const body = stubList.map((stub) => '  /** ' + stub.doc + ' */\n  ' + stub.signature).join('\n');
    return 'declare const tools: {\n' + body + '\n};';
  };
  const withoutDocs = (stubList: readonly TsStub[]): string => {
    const body = stubList.map((stub) => '  ' + stub.signature + ' // ' + stub.realName).join('\n');
    return 'declare const tools: {\n' + body + '\n};';
  };

  let body = withDocs(stubs);
  if (body.length > maxChars) body = withoutDocs(stubs);
  if (body.length > maxChars) {
    const kept: TsStub[] = [];
    let size = 0;
    for (const stub of stubs) {
      const line = '  ' + stub.signature + ' // ' + stub.realName;
      if (size + line.length + 1 > maxChars - 400) break;
      kept.push(stub);
      size += line.length + 1;
    }
    const rest = [...stubs.slice(kept.length), ...omitted.map((entry) => ({ memberName: '', realName: entry.name, signature: '', doc: '', purpose: entry.purpose }))];
    const parts: string[] = ['declare const tools: {'];
    for (const stub of kept) parts.push('  ' + stub.signature + ' // ' + stub.realName);
    if (rest.length > 0) {
      parts.push('  // ' + rest.length + ' further host tool(s) omitted for prompt budget:');
      for (const entry of rest) parts.push('  // ' + entry.realName + ' — ' + entry.purpose);
    }
    parts.push('};');
    body = parts.join('\n');
  }
  const escape = omitted.length > 0
    ? '\n// Name-collision / reserved-member escape: await tools.' + TS_SDK_CALL_MEMBER + '("<ExactToolName>", args).'
    : '';
  if (body.length === 0) return '';
  return header + escape + '\n' + body;
}
