import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildAgentModePrompt,
  filterToolsForExecutionPolicy,
  resolveAgentExecutionPolicy,
  tool,
} from '../src/index.js';
import { CODE_CELL_TOOL_NAME } from '../src/codeact/index.js';

const ordinary = tool(
  { name: 'Read', description: 'read', inputSchema: z.strictObject({}), isReadOnly: () => true },
  async () => 'ok',
);
const codeCell = tool(
  { name: CODE_CELL_TOOL_NAME, description: 'cell', inputSchema: z.strictObject({ code: z.string() }) },
  async () => 'ok',
);

describe('CodeAct mode prompt and tool pruning', () => {
  it('keeps ReAct free of kernel instructions and removes CodeCell', () => {
    const policy = resolveAgentExecutionPolicy({
      agentMode: 'react', ordinaryTools: ['Read'], codeActEnabled: false,
    });
    const prompt = buildAgentModePrompt(policy);
    expect(prompt).toContain('ordinary JSON tools');
    expect(prompt).not.toMatch(/CodeCell|kernel|host RPC/i);
    expect(filterToolsForExecutionPolicy([ordinary, codeCell], policy).map(tool => tool.name)).toEqual(['Read']);
  });

  it('keeps CodeAct free of ordinary JSON tool guidance and only exposes CodeCell', () => {
    const policy = resolveAgentExecutionPolicy({
      agentMode: 'codeact', ordinaryTools: ['Read'], codeActEnabled: true,
    });
    const prompt = buildAgentModePrompt(policy);
    expect(prompt).toContain('CodeCell');
    expect(prompt).not.toContain('ordinary JSON tools');
    expect(filterToolsForExecutionPolicy([ordinary, codeCell], policy).map(tool => tool.name)).toEqual(['CodeCell']);
  });

  it('routes Hybrid explicitly and bounds Single to zero or one ordinary tool', () => {
    const hybrid = resolveAgentExecutionPolicy({
      agentMode: 'hybrid', ordinaryTools: ['Read'], codeActEnabled: true,
    });
    expect(buildAgentModePrompt(hybrid)).toContain('two action planes');
    expect(filterToolsForExecutionPolicy([ordinary, codeCell], hybrid).map(tool => tool.name)).toEqual([
      'Read', 'CodeCell',
    ]);
    const single = resolveAgentExecutionPolicy({
      nodeMode: 'single', ordinaryTools: ['Read'], codeActEnabled: false,
    });
    expect(buildAgentModePrompt(single)).toContain('at most one ordinary tool');
    expect(buildAgentModePrompt(single)).not.toMatch(/CodeCell|kernel/i);
    expect(filterToolsForExecutionPolicy([ordinary, codeCell], single).map(tool => tool.name)).toEqual(['Read']);
  });
});
