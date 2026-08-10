import { z } from 'zod';

import { addMcpServer, readMcpServerConfig, removeMcpServer } from '../mcp/mcpServerConfig.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';

export function createAssistantMcpTools(homeDir: string): AgentToolDefinition[] {
  const list = tool(
    {
      name: 'ListMcpServers',
      description: 'List configured MCP servers.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({ servers: readMcpServerConfig(homeDir).servers }),
  );

  const add = tool(
    {
      name: 'AddMcpServer',
      description: 'Add an MCP server to ~/.hadamard/mcp.json.',
      inputSchema: z.strictObject({
        name: z.string(),
        type: z.enum(['stdio', 'http']),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        url: z.string().optional(),
      }),
    },
    async input => {
      if (input.type === 'stdio') {
        if (!input.command?.trim()) throw new Error('stdio MCP servers require command');
        addMcpServer({
          name: input.name.trim(),
          command: input.command.trim(),
          args: input.args,
        }, homeDir);
      } else {
        if (!input.url?.trim()) throw new Error('http MCP servers require url');
        addMcpServer({ name: input.name.trim(), url: input.url.trim() }, homeDir);
      }
      return { ok: true, servers: readMcpServerConfig(homeDir).servers };
    },
  );

  const remove = tool(
    {
      name: 'RemoveMcpServer',
      description: 'Remove an MCP server by name.',
      inputSchema: z.strictObject({ name: z.string() }),
    },
    async input => {
      removeMcpServer(input.name.trim(), homeDir);
      return { ok: true, servers: readMcpServerConfig(homeDir).servers };
    },
  );

  return [list, add, remove];
}
