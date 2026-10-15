import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-commands';
import { createProjectReader } from '../../../src/project/projectReader.js';
import { issuePageSchema, issueSchema, projectSchema } from './schemas.js';

export const name = 'hadamard-project';
export const inject = ['tools'];

export interface Config {
  /** Absolute workspace path. Only this project's state is exposed. */
  workDir: string;
  /** Explicit absolute Hadamard OS-home or data-root input. */
  homeDir: string;
  /** Maximum UTF-8 bytes in one rendered tool result (1024..262144; default 65536). */
  maxOutputBytes?: number;
}

export const Config: Schema<Config> = Schema.object({
  workDir: Schema.string().required().description('Absolute Hadamard workspace path (required).'),
  homeDir: Schema.string().required().description('Absolute home/data-root used by the existing Hadamard stores (required).'),
  maxOutputBytes: Schema.number().min(1024).max(262144).default(65536),
});

/** Reject canceled requests promptly; the existing read-only filesystem call may settle later. */
async function readWithSignal<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const canceled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Project read canceled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([read(), canceled]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function assertScope(config: Config): void {
  for (const key of ['workDir', 'homeDir'] as const) {
    const value = config[key];
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
      throw new Error(`hadamard-project requires an explicit absolute ${key}`);
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  assertScope(config);
  const maxOutputBytes = config.maxOutputBytes ?? 65536;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 262144) {
    throw new Error('maxOutputBytes must be an integer between 1024 and 262144');
  }
  const bounded = <T>(value: T): T => {
    if (Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8') > maxOutputBytes) {
      throw new Error(`Hadamard result exceeds maxOutputBytes (${maxOutputBytes}). Reduce the list limit, or inspect the full issue in Hadamard. No partial issue or acceptance criteria were returned.`);
    }
    return value;
  };
  // Capture scope at load; model arguments and agent working-directory changes cannot replace it.
  const reader = createProjectReader({ workDir: config.workDir, homeDir: config.homeDir });
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort(new Error('Hadamard project plugin unloaded')));
  const read = <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> =>
    readWithSignal(AbortSignal.any([signal, lifetime.signal]), operation);

  ctx.tools.register(defineTool({
    name: 'hadamard_project_get',
    description: 'Read the configured Hadamard project metadata and issue counts. Read-only; does not initialize or migrate storage.',
    parameters: {},
    output: {
      schema: projectSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    execute: (_args, exec) => read(exec.signal, async () => bounded(await reader.getProject())),
  }));

  ctx.tools.register(defineTool({
    name: 'hadamard_issue_list',
    description: 'Read one bounded page of existing issue summaries and complete acceptance criteria for the configured project. Follow nextOffset for more. Uses existing metadata storage selection; never changes state.',
    parameters: {
      limit: { type: 'integer', description: 'Page size, 1..100 (default 20).' },
      offset: { type: 'integer', description: 'Zero-based offset, non-negative (default 0).' },
    },
    output: {
      schema: issuePageSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => read(exec.signal, async () => {
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('limit must be an integer between 1 and 100');
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('offset must be a non-negative safe integer');
      }
      const all = await reader.listIssues();
      const issues = all.slice(offset, offset + limit).map(issue => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        acceptanceCriteria: issue.acceptanceCriteria,
      }));
      const nextOffset = offset + issues.length < all.length ? offset + issues.length : null;
      return bounded({ issues, total: all.length, offset, limit, nextOffset, truncated: offset > 0 || nextOffset !== null });
    }),
  }));

  ctx.tools.register(defineTool({
    name: 'hadamard_issue_get',
    description: 'Read one existing Hadamard issue by its id or positive issue number. Returns null if absent. Never starts execution or changes status.',
    parameters: {
      idOrNumber: {
        oneOf: [{ type: 'string' }, { type: 'integer' }],
        required: true,
        description: 'Existing issue id, ISS-n label, or positive issue number.',
      },
    },
    output: {
      schema: { oneOf: [issueSchema, { type: 'null' }] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => read(exec.signal, async () => bounded(await reader.getIssue(args.idOrNumber))),
  }));

  // Optional service: absence of interactive commands never blocks model-facing tools.
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'project',
      description: 'Show the configured Hadamard project status (read-only)',
      input: { hint: '[status]' },
      async handler(invocation) {
        const input = invocation.rawInput.trim();
        if (input !== '' && input !== 'status') {
          return { kind: 'error', text: 'Usage: /project [status]' };
        }
        const project = bounded(await read(invocation.signal, () => reader.getProject()));
        return {
          kind: 'success',
          text: [
            `${project.name}: ${project.status}`,
            `Workspace: ${project.path}`,
            `Issues: ${project.issueCounts.total} total, ${project.issueCounts.open} open (${project.issueCounts.review} in review), ${project.issueCounts.closed} closed`,
            `Issue storage: ${project.issueStorage}`,
          ].join('\n'),
        };
      },
    });
  });
}
