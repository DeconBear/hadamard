import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAssistantAutomationTools } from '../src/manager/assistantAutomationTools.js';
import { createAssistantMcpTools } from '../src/manager/assistantMcpTools.js';
import { createAssistantProductHelpTools } from '../src/manager/assistantProductHelpTools.js';
import { createAssistantProjectTools } from '../src/manager/assistantProjectTools.js';
import type { AgentToolDefinition } from '../src/types.js';

let homeDir: string;
let workDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-provider-home-'));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-provider-work-'));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function callTool(tool: AgentToolDefinition, input: unknown = {}) {
  return (tool.execute as (value: unknown, context: unknown) => Promise<unknown>)(input, {});
}

describe('Assistant global domain tool providers', () => {
  it('keeps product help tools in a read-only capability provider', async () => {
    const tools = createAssistantProductHelpTools();
    expect(tools.map(tool => tool.name)).toEqual([
      'ListProductCapabilities',
      'SearchProductCapabilities',
      'ReadProductCapability',
    ]);
    const result = await callTool(tools[1]!, { query: 'model configuration' });
    expect(result).toHaveProperty('capabilities');
  });

  it('keeps MCP tools scoped to the Hadamard home directory', async () => {
    const tools = createAssistantMcpTools(homeDir);
    expect(tools.map(tool => tool.name)).toEqual(['ListMcpServers', 'AddMcpServer', 'RemoveMcpServer']);
    await expect(callTool(tools[0]!)).resolves.toEqual({ servers: [] });
  });

  it('keeps automation tools behind a project resolver port', async () => {
    const tools = createAssistantAutomationTools({
      currentWorkDir: workDir,
      assertKnownProject: async value => path.resolve(value),
    });
    expect(tools.map(tool => tool.name)).toEqual([
      'ListScheduledTasks',
      'UpsertScheduledTask',
      'ToggleScheduledTask',
    ]);
    const result = await callTool(tools[0]!);
    expect(result).toMatchObject({ projectPath: path.resolve(workDir), tasks: [] });
  });

  it('keeps project tools behind a narrow host context', async () => {
    const tools = createAssistantProjectTools({ homeDir, currentWorkDir: workDir });
    expect(tools.map(tool => tool.name)).toEqual([
      'ListProjects',
      'GetProjectOverview',
      'GetProjectDocument',
      'ListProjectIssues',
      'GetAppState',
      'GetCurrentEditorContext',
      'OpenProject',
      'UpdateProjectNote',
      'UpdateProjectStatus',
    ]);
    const result = await callTool(tools[0]!);
    expect(result).toMatchObject({ currentWorkDir: workDir });
  });
});
