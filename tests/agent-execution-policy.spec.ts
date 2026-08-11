import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  AgentExecutionPolicyError,
  migrateLegacyGraphAgentMode,
  migrateLegacyWorkflowAgentMode,
  parseAgentMode,
  resolveAgentExecutionPolicy,
} from '../src/runtime/agentExecutionPolicy.js';

const fixture = (name: string) => new URL(`./fixtures/compat/${name}`, import.meta.url);

describe('agent execution policy', () => {
  it('normalizes the three reusable Agent modes and rejects Agent-level Single', () => {
    expect(parseAgentMode('react')).toBe('react');
    expect(parseAgentMode('codeact')).toBe('codeact');
    expect(parseAgentMode('hybrid')).toBe('hybrid');
    expect(() => parseAgentMode('single')).toThrow(AgentExecutionPolicyError);
  });

  it('maps the four node modes to one execution policy', () => {
    expect(resolveAgentExecutionPolicy({
      agentMode: 'react',
      ordinaryTools: ['Read', 'Read', 'Grep'],
      codeActEnabled: false,
    })).toEqual({
      actionSpace: 'json-tools',
      turnPolicy: 'iterative',
      ordinaryTools: ['Read', 'Grep'],
    });
    expect(resolveAgentExecutionPolicy({
      agentMode: 'codeact',
      ordinaryTools: ['Read'],
      codeActEnabled: true,
    })).toEqual({
      actionSpace: 'code-cell',
      turnPolicy: 'iterative',
      ordinaryTools: [],
    });
    expect(resolveAgentExecutionPolicy({
      agentMode: 'hybrid',
      ordinaryTools: ['Read'],
      codeActEnabled: true,
    }).actionSpace).toBe('hybrid');
    expect(resolveAgentExecutionPolicy({
      nodeMode: 'single',
      ordinaryTools: ['Read'],
      codeActEnabled: false,
    })).toEqual({
      actionSpace: 'json-tools',
      turnPolicy: 'single',
      ordinaryTools: ['Read'],
      maxOrdinaryToolCalls: 1,
    });
  });

  it('uses node, Agent, session, project, then ReAct inheritance order', () => {
    expect(resolveAgentExecutionPolicy({
      nodeMode: 'single',
      agentMode: 'codeact',
      sessionMode: 'hybrid',
      projectMode: 'react',
      ordinaryTools: [],
      codeActEnabled: true,
    }).turnPolicy).toBe('single');
    expect(resolveAgentExecutionPolicy({
      nodeMode: 'inherit',
      agentMode: 'codeact',
      sessionMode: 'hybrid',
      ordinaryTools: [],
      codeActEnabled: true,
    }).actionSpace).toBe('code-cell');
    expect(resolveAgentExecutionPolicy({
      ordinaryTools: [],
      codeActEnabled: false,
    }).actionSpace).toBe('json-tools');
  });

  it('fails closed when CodeAct is disabled or Single selects multiple tools', () => {
    expectPolicyError(
      () => resolveAgentExecutionPolicy({ agentMode: 'codeact', codeActEnabled: false }),
      'CODEACT_DISABLED',
    );
    expectPolicyError(
      () => resolveAgentExecutionPolicy({
        nodeMode: 'single',
        ordinaryTools: ['Read', 'Grep'],
        codeActEnabled: false,
      }),
      'SINGLE_TOOL_LIMIT',
    );
  });

  it('reads legacy Workflow mode and Graph type fixtures without changing semantics', async () => {
    const workflow = JSON.parse(await readFile(fixture('legacy-workflow.json'), 'utf8'));
    const graphNode = JSON.parse(await readFile(fixture('legacy-team-graph-node.json'), 'utf8'));
    expect(migrateLegacyWorkflowAgentMode(workflow)).toBe('single');
    expect(migrateLegacyGraphAgentMode(graphNode)).toBe('react');
    expect(migrateLegacyGraphAgentMode({ type: 'team' })).toBeUndefined();
    expect(migrateLegacyWorkflowAgentMode({ agentMode: 'hybrid', mode: 'single' })).toBe('hybrid');
  });
});

function expectPolicyError(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error('Expected execution policy resolution to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentExecutionPolicyError);
    expect((error as AgentExecutionPolicyError).code).toBe(code);
  }
}
