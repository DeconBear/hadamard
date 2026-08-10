import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelTeamResult, TeamDefinition } from '../src/types.js';
import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiTeamCommand,
  type TuiTeamCommandPort,
} from '../src/tui/tuiTeamCommandHandler.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function createPort(): Promise<TuiTeamCommandPort & {
  output: string[][];
  attached: { name: string | null; value: boolean };
}> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-tui-team-'));
  roots.push(workDir);
  const output: string[][] = [];
  const attached = { name: null as string | null, value: false };
  let lastRunSummary: string | null = null;
  const fakeDefinition: TeamDefinition = {
    name: 'fake',
    mode: 'analysis',
    members: [{ model: 'test-model', name: 'member' }],
  };
  const result: ModelTeamResult = {
    answer: 'team answer',
    mode: 'graph',
    cost: {
      totalInputTokens: 10,
      totalOutputTokens: 5,
      estimatedCost: 0.25,
      breakdown: [],
    },
    durationMs: 1500,
    reports: [],
    skippedNodes: [],
  };
  return {
    workDir,
    output,
    attached,
    state: {
      activeName: () => attached.name,
      hasActiveTool: () => attached.value,
      preferences: () => ({ autoInvoke: false, defaultAttached: null, confirmBeforeRun: false }),
      lastRunSummary: () => lastRunSummary,
      currentModel: () => 'test-model',
      attach: name => {
        if (name !== 'fake') return null;
        attached.name = name;
        attached.value = true;
        return fakeDefinition;
      },
      clear: () => {
        attached.name = null;
        attached.value = false;
      },
      setLastRunSummary: summary => { lastRunSummary = summary; },
    },
    execution: {
      ask: vi.fn(async () => result),
    },
    ui: {
      selectItem: vi.fn(async () => undefined),
      renderRichText: text => text.split('\n'),
      appendStatic: lines => output.push([...lines]),
    },
  };
}

function textOutput(port: { output: string[][] }): string {
  return port.output.flat().map(stripAnsi).join('\n');
}

describe('runTuiTeamCommand', () => {
  it('returns false outside the team command domain', async () => {
    expect(await runTuiTeamCommand('help', '', await createPort())).toBe(false);
  });

  it('reports and clears the attached team through the state port', async () => {
    const port = await createPort();
    port.attached.name = 'fake';
    port.attached.value = true;

    await runTuiTeamCommand('team', 'status', port);
    expect(textOutput(port)).toContain('attached: fake');

    await runTuiTeamCommand('team', 'off', port);
    expect(port.attached).toEqual({ name: null, value: false });
    expect(textOutput(port)).toContain('the agent works individually');
  });

  it('keeps attach validation and output behavior', async () => {
    const missing = await createPort();
    await runTuiTeamCommand('team', 'attach missing', missing);
    expect(textOutput(missing)).toContain('team not found: missing');

    const found = await createPort();
    await runTuiTeamCommand('team', 'attach fake', found);
    expect(found.attached.name).toBe('fake');
    expect(textOutput(found)).toContain('team attached: fake (analysis)');
  });

  it('runs a built-in team through the execution port and renders its result', async () => {
    const port = await createPort();
    await runTuiTeamCommand('team', 'ask analysis inspect this', port);

    expect(port.execution.ask).toHaveBeenCalledOnce();
    expect(textOutput(port)).toContain('asking team "analysis"');
    expect(textOutput(port)).toContain('team answer');
    expect(textOutput(port)).toContain('cost: $0.2500 · 15 tokens');
  });

  it('keeps invalid ask and built-in deletion safeguards', async () => {
    const port = await createPort();
    await runTuiTeamCommand('team', 'ask only-a-name', port);
    await runTuiTeamCommand('team', 'delete analysis', port);

    expect(port.execution.ask).not.toHaveBeenCalled();
    expect(textOutput(port)).toContain('usage: /team ask <name> <prompt>');
    expect(textOutput(port)).toContain('cannot delete built-in team: analysis');
  });
});
