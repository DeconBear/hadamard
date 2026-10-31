import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { ISSUE_STATUSES, type ProjectIssue } from '../../../src/issues/issueStore.js';
import type { ProjectSource } from './projectSource.js';
import { listDocuments, readDocument } from './documents.js';

export type IssueSummary = Pick<ProjectIssue, 'id' | 'number' | 'title' | 'status' | 'priority' | 'labels' | 'updatedAt'>;
export interface IssuePage {
  issues: IssueSummary[];
  total: number;
  offset: number;
  limit: number;
}

/** UI requests use DSH's authenticated carrier and never enter the model/tool loop. */
export function registerProjectWebApi(
  ctx: Context,
  source: ProjectSource,
  lifetime: AbortSignal,
  maxOutputBytes: number,
): void {
  ctx.inject(['connection'], webCtx => {
    for (const endpoint of ['projects', 'board', 'board-action', 'overview', 'issues', 'issue', 'documents', 'document']) {
      // Exact routes compose with the Gateway and Connection admits owner peers only.
      webCtx.connection.fetch.register({
        path: `/api/hadamard-project/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          let envelope: { rpcId: string; payload: unknown };
          try {
            const body = await request.json();
            if (!body || body.type !== 'client-request' || typeof body.rpcId !== 'string' ||
                body.method !== `hadamard-project/${endpoint}`) throw new Error('Invalid RPC envelope.');
            envelope = body;
          } catch {
            return new Response('Invalid project request.', { status: 400 });
          }
          const signal = AbortSignal.any([request.signal, lifetime]);
          const reply = (result: object) => Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
          try {
            const operation = async () => {
              signal.throwIfAborted();
              const payload = envelope.payload;
              if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid project request.');
              const args = payload as Record<string, unknown>;
              if (endpoint === 'projects') return source.catalog(signal);
              if (endpoint === 'board') return source.getBoard(args.projectId, signal);
              if (endpoint === 'board-action') { await source.act(args, signal); return null; }
              const { project, reader } = await source.resolve(args.projectId, signal);
              if (endpoint === 'documents') return listDocuments(project.path, source.homeDir);
              if (endpoint === 'document') return readDocument(project.path, source.homeDir, args.id, signal);
              if (endpoint === 'overview') return reader.getProject();
              if (endpoint === 'issue') {
                if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('Issue id is required.');
                return reader.getIssue(args.id);
              }
              const { query = '', status = '', offset = 0, limit = 20 } = args;
              if (typeof query !== 'string' || query.length > 200 ||
                  typeof status !== 'string' || (status !== '' && !ISSUE_STATUSES.includes(status as ProjectIssue['status'])) ||
                  typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
                  typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
                throw new Error('Invalid issue search or pagination.');
              }
              const needle = query.trim().toLocaleLowerCase();
              const issues = (await reader.listIssues()).filter(issue =>
                (!status || issue.status === status) &&
                (!needle || `${issue.title}\n${issue.id}\nISS-${issue.number}\n${issue.labels.join(' ')}`.toLocaleLowerCase().includes(needle)));
              return {
                issues: issues.slice(offset, offset + limit).map(({ id, number, title, status, priority, labels, updatedAt }) =>
                  ({ id, number, title, status, priority, labels, updatedAt })),
                total: issues.length, offset, limit,
              } satisfies IssuePage;
            };
            const value = await operation();
            signal.throwIfAborted();
            if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxOutputBytes) {
              throw new Error(`Result exceeds maxOutputBytes (${maxOutputBytes}); no partial content was returned.`);
            }
            return reply({ ok: true, value });
          } catch (error) {
            return reply({ ok: false, error: {
              code: signal.aborted ? 'cancelled' : 'project-read-failed',
              message: error instanceof Error ? error.message : 'Unable to read the project.',
              details: {},
            } });
          }
        },
      });
    }
  });
}
