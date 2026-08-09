import { describe, expect, it } from 'vitest';

import { resolveEffectiveAgentRunOptions } from '../src/runtime/effectiveAgentRunOptions.js';

describe('resolveEffectiveAgentRunOptions', () => {
  it('applies every persisted Agent option with Agent values above surface defaults', () => {
    expect(resolveEffectiveAgentRunOptions({
      systemPromptAppend: 'Agent instructions',
      promptMode: 'extend',
      permissionMode: 'acceptEdits',
      effort: 'high',
      maxTokens: 4096,
      temperature: 0.4,
      topP: 0.8,
      allowedTools: ['Read', 'Grep'],
      workspaceAccess: 'workspace',
      maxIterations: 12,
      timeoutMs: 5000,
      subagent: false,
    }, {
      systemPrompt: 'Surface prompt',
      fallbackPermissionMode: 'default',
      fallbackEffort: 'low',
    })).toEqual({
      systemPrompt: 'Surface prompt\n\nAgent instructions',
      permissionMode: 'acceptEdits',
      effort: 'high',
      maxTokens: 4096,
      temperature: 0.4,
      topP: 0.8,
      allowedTools: ['Read', 'Grep'],
      workspaceAccess: 'workspace',
      maxToolIterations: 12,
      timeoutMs: 5000,
      subagent: false,
    });
  });

  it('replaces caller prompts and preserves explicit visible run overrides', () => {
    const effective = resolveEffectiveAgentRunOptions({
      systemPrompt: 'Replacement',
      promptMode: 'replace',
      permissionMode: 'plan',
      effort: 'low',
    }, {
      systemPrompt: 'Must disappear',
      permissionModeOverride: 'bypassPermissions',
      effortOverride: 'max',
    });

    expect(effective.systemPrompt).toBe('Replacement');
    expect(effective.permissionMode).toBe('bypassPermissions');
    expect(effective.effort).toBe('max');
  });
});
