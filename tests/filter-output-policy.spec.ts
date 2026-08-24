import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  BuiltInExtensionToggles,
  ToolPolicyPipeline,
  resolveBuiltInExtensionStates,
  tool,
  type ToolPolicyCall,
} from '../src/index.js';
import {
  createFilterOutputPostListener,
  redactSensitiveText,
  truncateText,
} from '../src/extensions/filterOutputPolicy.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-filter-ext-'));
  tempDirs.push(directory);
  return directory;
}

function togglesWith(config: Record<string, unknown> = {}, enabled = true): BuiltInExtensionToggles {
  return new BuiltInExtensionToggles(
    resolveBuiltInExtensionStates({ extensions: { filterOutput: { enabled, ...config } } }),
  );
}

describe('redactSensitiveText', () => {
  it('redacts AWS access keys', () => {
    expect(redactSensitiveText('key: AKIAIOSFODNN7EXAMPLE done')).toBe('key: [REDACTED:aws-access-key] done');
    expect(redactSensitiveText('ASIAIOSFODNN7EXAMPLE')).toBe('[REDACTED:aws-access-key]');
  });

  it('redacts GitHub tokens', () => {
    expect(redactSensitiveText(`ghp_${'a'.repeat(36)}`)).toBe('[REDACTED:github-token]');
    expect(redactSensitiveText(`github_pat_${'b'.repeat(22)}`)).toBe('[REDACTED:github-token]');
  });

  it('redacts sk- API keys including sk-ant-', () => {
    expect(redactSensitiveText(`sk-${'x'.repeat(24)}`)).toBe('[REDACTED:api-key]');
    expect(redactSensitiveText(`sk-ant-api03-${'y'.repeat(30)}`)).toBe('[REDACTED:api-key]');
  });

  it('redacts Bearer tokens but keeps the scheme prefix', () => {
    const result = redactSensitiveText(`Authorization: Bearer ${'t'.repeat(30)}`);
    expect(result).toBe('Authorization: Bearer [REDACTED:bearer-token]');
  });

  it('redacts PEM private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nline2\n-----END RSA PRIVATE KEY-----';
    expect(redactSensitiveText(`before ${pem} after`)).toBe('before [REDACTED:private-key] after');
  });

  it('redacts generic secret assignments, keeping the key= prefix', () => {
    expect(redactSensitiveText('password=sup3rsaf3secret')).toBe('password=[REDACTED:password]');
    expect(redactSensitiveText('API_KEY: "abcdefghijklm"')).toBe('API_KEY: "[REDACTED:api_key]"');
    expect(redactSensitiveText('access_token = tok_12345678')).toBe('access_token = [REDACTED:access_token]');
  });

  it('leaves ordinary code and prose untouched', () => {
    const normal = 'const password = "short";\n// TODO: rotate keys\nexport function main() { return 1; }';
    expect(redactSensitiveText(normal)).toBe(normal);
  });

  it('applies extraPatterns and skips invalid regexes', () => {
    expect(redactSensitiveText('token-12345 here', ['token-[0-9]+'])).toBe('[REDACTED:custom] here');
    expect(redactSensitiveText('token-12345 here', ['['])).toBe('token-12345 here');
  });
});

describe('truncateText', () => {
  it('truncates with a marker only when maxChars > 0 and exceeded', () => {
    expect(truncateText('hello world', 0)).toBe('hello world');
    expect(truncateText('hello', 10)).toBe('hello');
    expect(truncateText('hello world', 5)).toBe('hello\n… [truncated by filter-output extension]');
  });
});

function fakeAdapter(name: string): ToolPolicyCall['adapter'] {
  const definition = tool(
    { name, description: `${name} tool.`, inputSchema: z.object({ value: z.string().optional() }) },
    async (input) => input,
  );
  return {
    publicName: name,
    sourceName: name,
    provider: 'local',
    providerTool: { name, description: definition.description, input_schema: definition.inputJsonSchema },
    execute: async (input: unknown) => ({ content: 'ok', text: 'ok', rawOutput: input }),
    isReadOnly: () => false,
  } as unknown as ToolPolicyCall['adapter'];
}

function policyCall(workDir: string, adapter: ToolPolicyCall['adapter']): ToolPolicyCall {
  return {
    iteration: 1,
    toolUseId: 'tu-1',
    toolName: adapter.sourceName,
    publicName: adapter.publicName,
    input: {},
    adapter,
    workDir,
    prompt: 'probe prompt',
  };
}

describe('filter-output post-listener', () => {
  it('redacts string content, block content, and additionalContexts', async () => {
    const cwd = await workspace();
    const pipeline = new ToolPolicyPipeline([], [createFilterOutputPostListener(togglesWith())]);
    const call = policyCall(cwd, fakeAdapter('Bash'));
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const stringResult = await pipeline.runPost(call, { content: `leak ${secret}`, text: '', rawOutput: {} });
    expect(stringResult.kind).toBe('accept');
    expect(stringResult.kind === 'accept' && stringResult.content).toBe('leak [REDACTED:aws-access-key]');

    const blockPipeline = new ToolPolicyPipeline([], [
      createFilterOutputPostListener(togglesWith()),
      async (_call, _execution, next) => {
        const inner = await next();
        if (inner.kind !== 'accept') return inner;
        return {
          kind: 'accept',
          content: inner.content,
          additionalContexts: [{ type: 'text', text: `ctx ${secret}` }],
        };
      },
    ]);
    const withContexts = await blockPipeline.runPost(call, {
      content: [{ type: 'text', text: `block ${secret}` }, { type: 'image', data: 'binary' }],
      text: '',
      rawOutput: {},
    });
    expect(withContexts.kind).toBe('accept');
    if (withContexts.kind === 'accept') {
      const blocks = withContexts.content as Array<{ type: string; text?: string }>;
      expect(blocks[0]).toEqual({ type: 'text', text: 'block [REDACTED:aws-access-key]' });
      expect(blocks[1]).toEqual({ type: 'image', data: 'binary' });
      expect(withContexts.additionalContexts).toEqual([{ type: 'text', text: 'ctx [REDACTED:aws-access-key]' }]);
    }
  });

  it('redacts error results too', async () => {
    const cwd = await workspace();
    const pipeline = new ToolPolicyPipeline([], [createFilterOutputPostListener(togglesWith())]);
    const decision = await pipeline.runPost(policyCall(cwd, fakeAdapter('Bash')), {
      content: 'Error: auth failed for sk-abcdefghij0123456789',
      text: '',
      rawOutput: {},
      isError: true,
    });
    expect(decision.kind).toBe('accept');
    expect(decision.kind === 'accept' && decision.content).toBe('Error: auth failed for [REDACTED:api-key]');
  });

  it('passes block decisions through untouched', async () => {
    const cwd = await workspace();
    const pipeline = new ToolPolicyPipeline([], [
      createFilterOutputPostListener(togglesWith()),
      async () => ({ kind: 'block', reason: 'hook refused' }),
    ]);
    const decision = await pipeline.runPost(policyCall(cwd, fakeAdapter('Bash')), {
      content: 'AKIAIOSFODNN7EXAMPLE',
      text: '',
      rawOutput: {},
    });
    expect(decision).toEqual({ kind: 'block', reason: 'hook refused' });
  });

  it('truncates to maxChars when configured', async () => {
    const cwd = await workspace();
    const pipeline = new ToolPolicyPipeline([], [createFilterOutputPostListener(togglesWith({ maxChars: 10 }))]);
    const decision = await pipeline.runPost(policyCall(cwd, fakeAdapter('Bash')), {
      content: 'x'.repeat(100),
      text: '',
      rawOutput: {},
    });
    expect(decision.kind).toBe('accept');
    expect(decision.kind === 'accept' && decision.content).toBe('xxxxxxxxxx\n… [truncated by filter-output extension]');
  });

  it('is a passthrough when disabled (default off)', async () => {
    const cwd = await workspace();
    const pipeline = new ToolPolicyPipeline([], [createFilterOutputPostListener(togglesWith({}, false))]);
    const decision = await pipeline.runPost(policyCall(cwd, fakeAdapter('Bash')), {
      content: 'AKIAIOSFODNN7EXAMPLE',
      text: '',
      rawOutput: {},
    });
    expect(decision.kind).toBe('accept');
    expect(decision.kind === 'accept' && decision.content).toBe('AKIAIOSFODNN7EXAMPLE');
  });
});
