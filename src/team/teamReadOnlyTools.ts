import type { AgentToolDefinition } from '../types.js';

/** Build the default read-only expert tool set without depending on team execution. */
export async function buildReadOnlyExpertTools(cwd: string): Promise<AgentToolDefinition[]> {
  const { createHadamardFileTools } = await import('../tools/hadamardFileTools.js');
  const { createHadamardWebTools } = await import('../tools/hadamardWebTools.js');
  const { createTavilySearchTool } = await import('../tools/tavilySearch.js');
  const readOnlyFileTools = new Set(['Read', 'Glob', 'Grep']);
  return [
    ...createHadamardFileTools({ cwd }).filter(tool => readOnlyFileTools.has(tool.name)),
    ...createHadamardWebTools().filter(tool => tool.name === 'WebFetch'),
    createTavilySearchTool(),
  ];
}
