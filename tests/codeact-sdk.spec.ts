import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from '../src/index.js';
import {
  buildCodeActToolNameMap,
  DEFAULT_MAX_SDK_CHARS,
  jsonSchemaToPythonType,
  renderCodeActHostSdk,
  sanitizeCodeActName,
} from '../src/codeact/codeActSdk.js';
import type { AgentToolDefinition } from '../src/types.js';

function makeTool(
  name: string,
  schema: z.ZodType,
  description = 'A test tool.',
): AgentToolDefinition {
  return tool({ name, description, inputSchema: schema as never }, async () => 'ok') as AgentToolDefinition;
}

const probeTools = () => [
  makeTool('Grep', z.strictObject({ pattern: z.string(), path: z.string().optional(), include: z.string().optional() }), 'Search file contents with a ripgrep regular expression.'),
  makeTool('Read', z.strictObject({ file_path: z.string(), offset: z.number().int().optional() }), 'Read a UTF-8 text file.'),
  makeTool('weather_lookup', z.strictObject({ city: z.string(), units: z.enum(['c', 'f']).optional(), tags: z.array(z.string()).optional() }), 'Look up current weather.'),
  makeTool('bad-tool', z.strictObject({ 'not-valid': z.string() }), 'Tool with an invalid identifier param.'),
  makeTool('type', z.strictObject({ x: z.string() }), 'Keyword-named tool.'),
];

const golden = "# Typed host-tool stubs reachable from CodeCell code through the global\n# `hadamard` object. Signatures are authoritative for parameter names; every\n# method dispatches the matching host tool, and `hadamard.tool(\"<name>\", {...})` stays\n# available for tools without a typed stub.\n# A failed host call raises HadamardToolError with a `tool_name` attribute;\n# catch it to branch on which tool failed.\n# Any tool schema is queryable on demand with hadamard.tool_schema(\"<ToolName>\").\n# Degraded typing: 5 of 5 visible tool(s) declare no output schema, so their results are untyped (Any) — treat them as opaque and degrade accordingly.\nclass HadamardHost:\n    \"\"\"Host-tool bridge (typed surface).\"\"\"\n\n    def bad_tool(self) -> Any:\n        \"\"\"Tool with an invalid identifier param. Host tool: bad-tool. Called as hadamard.bad_tool. Not keyword-accessible (invalid Python identifiers): not-valid.\"\"\"\n        ...\n\n    def search(self, pattern: str, path: str | None = None, include: str | None = None) -> Any:\n        \"\"\"Search file contents with a ripgrep regular expression. Host tool: Grep.\"\"\"\n        ...\n\n    def read(self, file_path: str, offset: int | None = None) -> Any:\n        \"\"\"Read a UTF-8 text file. Host tool: Read.\"\"\"\n        ...\n\n    def type_(self, x: str) -> Any:\n        \"\"\"Keyword-named tool. Host tool: type. Called as hadamard.type_.\"\"\"\n        ...\n\n    def weather_lookup(self, city: str, units: Literal['c'] | Literal['f'] | None = None, tags: list[str] | None = None) -> Any:\n        \"\"\"Look up current weather. Host tool: weather_lookup.\"\"\"\n        ...";

describe('renderCodeActHostSdk', () => {
  it('renders byte-stable typed stubs for a fixed tool set', () => {
    expect(renderCodeActHostSdk(probeTools())).toBe(golden);
  });

  it('excludes CodeCell and documents reserved helper collisions', () => {
    const sdk = renderCodeActHostSdk([
      makeTool('artifact', z.strictObject({ name: z.string() }), 'Puts an artifact.'),
      makeTool('CodeCell', z.strictObject({ code: z.string() })),
    ]);
    expect(sdk).not.toContain('def code_cell');
    expect(sdk).not.toContain('def artifact(');
    expect(sdk).toContain('collides with the reserved artifact helper');
    expect(sdk).toContain('hadamard.tool("artifact", {...})');
  });

  it('omits sanitized-name collisions from both typed stubs and dispatch map', () => {
    const tools = [
      makeTool('foo-bar', z.strictObject({ value: z.string() })),
      makeTool('foo_bar', z.strictObject({ count: z.number() })),
    ];
    const sdk = renderCodeActHostSdk(tools);
    const map = buildCodeActToolNameMap(tools);

    expect(sdk).not.toContain('def foo_bar(');
    expect(sdk).toContain('share the sanitized Python name foo_bar');
    expect(sdk).toContain('hadamard.tool("foo-bar", {...})');
    expect(sdk).toContain('hadamard.tool("foo_bar", {...})');
    expect(map).not.toHaveProperty('foo_bar');
  });

  it('derives fixed-helper signatures from the registered tool schema', () => {
    const sdk = renderCodeActHostSdk(probeTools());
    expect(sdk).toContain('def search(self, pattern: str, path: str | None = None, include: str | None = None)');
  });

  it('folds docstrings when the body exceeds the budget', () => {
    const weather = makeTool(
      'weather_lookup',
      z.strictObject({ city: z.string() }),
      'Look up current weather for a city.',
    );
    const sdk = renderCodeActHostSdk([weather], { maxChars: 200 });
    expect(sdk).toContain('Docstrings folded');
    expect(sdk).toContain('def weather_lookup(self, city: str) -> Any: ...');
    expect(sdk).not.toContain('Look up current weather');
  });

  it('truncates the tool list but keeps every remaining tool discoverable', () => {
    const weather = makeTool(
      'weather_lookup',
      z.strictObject({ city: z.string() }),
      'Look up current weather for a city.',
    );
    const sdk = renderCodeActHostSdk([weather], { maxChars: 80 });
    expect(sdk).toContain('truncated typed surface');
    expect(sdk).toContain('omitted for prompt budget');
    expect(sdk).toContain('weather_lookup');
    expect(sdk).toContain('hadamard.tool_schema');
  });

  it('emits a complete compact index for omitted and reserved tools', () => {
    const longPurpose = (word: string) => `${word} performs a long multi-step operation over the workspace so the purpose line in the truncated index exercises its full width budget.`;
    const wideSchema = z.strictObject({
      p1: z.string(), p2: z.string(), p3: z.string(), p4: z.string(),
      p5: z.string(), p6: z.string(), p7: z.string(), p8: z.string(),
    });
    const tools = [
      makeTool('alpha_tool', wideSchema, longPurpose('Alpha')),
      makeTool('bravo_tool', wideSchema, longPurpose('Bravo')),
      makeTool('charlie_tool', wideSchema, longPurpose('Charlie')),
      makeTool('delta_tool', wideSchema, longPurpose('Delta')),
      makeTool('echo_tool', wideSchema, longPurpose('Echo')),
      makeTool('foxtrot_tool', wideSchema, longPurpose('Foxtrot')),
    ];
    const sdk = renderCodeActHostSdk(tools, { maxChars: 500 });
    expect(sdk).toContain('truncated typed surface');
    expect(sdk).toContain('index below keeps every remaining tool discoverable');
    expect(sdk).toContain('Compact name index');
    // Every remaining name stays visible: purposes render as a one-line index,
    // and names that no longer fit fall back to the compact name index.
    for (const name of ['alpha_tool', 'bravo_tool', 'charlie_tool', 'delta_tool', 'echo_tool', 'foxtrot_tool']) {
      expect(sdk).toContain(name);
    }
  });

  it('uses the declared default budget', () => {
    expect(DEFAULT_MAX_SDK_CHARS).toBe(24_000);
  });
});

describe('jsonSchemaToPythonType', () => {
  it('maps scalars, arrays, unions, and bounded objects', () => {
    expect(jsonSchemaToPythonType({ type: 'string' })).toBe('str');
    expect(jsonSchemaToPythonType({ type: 'integer' })).toBe('int');
    expect(jsonSchemaToPythonType({ type: 'number' })).toBe('float');
    expect(jsonSchemaToPythonType({ type: 'boolean' })).toBe('bool');
    expect(jsonSchemaToPythonType({ type: 'array', items: { type: 'string' } })).toBe('list[str]');
    expect(jsonSchemaToPythonType({ enum: ['a', 'b'] })).toBe("Literal['a'] | Literal['b']");
    expect(jsonSchemaToPythonType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('str | None');
    expect(jsonSchemaToPythonType({ type: 'object', properties: {} })).toBe('dict[str, Any]');
    expect(jsonSchemaToPythonType({ type: 'object', properties: { x: { type: 'string' } } })).toBe('dict[str, str]');
    expect(jsonSchemaToPythonType('not a schema')).toBe('Any');
  });
});

describe('sanitizeCodeActName', () => {
  it('normalizes names deterministically', () => {
    expect(sanitizeCodeActName('weather_lookup')).toBe('weather_lookup');
    expect(sanitizeCodeActName('bad-tool')).toBe('bad_tool');
    expect(sanitizeCodeActName('type')).toBe('type_');
    expect(sanitizeCodeActName('2tool')).toBe('_2tool');
    expect(sanitizeCodeActName('')).toBe('tool');
    expect(sanitizeCodeActName('multi word tool')).toBe('multi_word_tool');
  });
});
