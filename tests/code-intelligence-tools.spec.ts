import { describe, expect, it, vi } from 'vitest';

import { createCodeIntelligenceTools } from '../src/codeIntel/codeIntelligenceTools.js';

describe('code intelligence tools', () => {
  it('exposes five read-only semantic queries', async () => {
    const service = {
      workspaceSymbols: vi.fn(async () => []),
      definition: vi.fn(async () => []),
      references: vi.fn(async () => []),
      hover: vi.fn(async () => ''),
      diagnostics: vi.fn(async () => []),
    };
    const tools = createCodeIntelligenceTools(service as never);
    expect(tools.map(tool => tool.name)).toEqual([
      'FindSymbol',
      'GoToDefinition',
      'FindReferences',
      'GetHover',
      'GetDiagnostics',
    ]);
    expect(tools.every(tool => tool.isReadOnly?.({}) === true)).toBe(true);
    await tools[0]!.execute({ query: 'name' }, {} as never);
    expect(service.workspaceSymbols).toHaveBeenCalledWith('name');
  });

  it('routes GetHover to the service hover query', async () => {
    const service = {
      workspaceSymbols: vi.fn(async () => []),
      definition: vi.fn(async () => []),
      references: vi.fn(async () => []),
      hover: vi.fn(async () => '**docs**'),
      diagnostics: vi.fn(async () => []),
    };
    const tools = createCodeIntelligenceTools(service as never);
    const hover = tools.find(tool => tool.name === 'GetHover')!;
    await expect(hover.execute({ filePath: 'src/a.ts', line: 3, character: 7 }, {} as never))
      .resolves.toBe('**docs**');
    expect(service.hover).toHaveBeenCalledWith('src/a.ts', 3, 7);
  });
});
