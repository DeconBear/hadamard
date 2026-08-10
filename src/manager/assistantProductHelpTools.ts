import { z } from 'zod';

import {
  getProductCapability,
  productCapabilities,
  searchProductCapabilities,
} from '../help/productCapabilities.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';

export function createAssistantProductHelpTools(): AgentToolDefinition[] {
  const list = tool(
    {
      name: 'ListProductCapabilities',
      description: 'List the machine-readable Hadamard capability catalog. Use this, SearchProductCapabilities, or ReadProductCapability before answering product how-to questions.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({
      capabilities: productCapabilities.map(capability => ({
        id: capability.id,
        title: capability.title,
        summary: capability.summary,
        uiLocations: capability.uiLocations,
        commands: capability.commands,
      })),
    }),
  );

  const search = tool(
    {
      name: 'SearchProductCapabilities',
      description: 'Search grounded product instructions by feature, UI label, command, or user goal.',
      inputSchema: z.strictObject({
        query: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      isReadOnly: () => true,
    },
    async input => ({ capabilities: searchProductCapabilities(input.query, input.limit) }),
  );

  const read = tool(
    {
      name: 'ReadProductCapability',
      description: 'Read complete current instructions for one capability id returned by List/SearchProductCapabilities.',
      inputSchema: z.strictObject({ id: z.string() }),
      isReadOnly: () => true,
    },
    async input => {
      const capability = getProductCapability(input.id);
      if (!capability) throw new Error(`Unknown product capability: ${input.id}`);
      return { capability };
    },
  );

  return [list, search, read];
}
