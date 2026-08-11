import type { IncomingMessage, ServerResponse } from 'node:http';

import { json, readJson, type GuiHttpRouter } from './guiHttpRouter.js';

export type GuiPendingInputMode = 'followUp' | 'steer';
export type GuiPermissionDecision = 'allow' | 'always' | 'always-user' | 'deny';

export interface GuiChatHttpControllerPort {
  runtimeMutationInProgress(): boolean;
  send(
    input: string,
    res: ServerResponse,
    clientRequestId?: string,
    expectedSessionId?: string,
  ): Promise<void>;
  sendIssue(id: string, agentConfig: string | undefined, res: ServerResponse): Promise<void>;
  submitPendingInput(input: string, mode: GuiPendingInputMode): {
    active: boolean;
    pendingInputCount: number;
  };
  createSession(): Promise<unknown>;
  resumeSession(req: IncomingMessage): Promise<{ status: number; error?: string; state?: unknown }>;
  resolvePermission(
    id: string,
    decision: GuiPermissionDecision,
    answers: Record<string, string> | undefined,
  ): boolean;
  replayRun(runId: string, after: number): unknown | undefined;
  abortRun(runId: string | undefined): boolean;
  mutationError(error: unknown): { status: number; body: unknown };
}

const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export function registerGuiChatHttpController(
  router: GuiHttpRouter,
  port: GuiChatHttpControllerPort,
): void {
  router.route('POST', '/api/send', async (req, res) => {
    if (port.runtimeMutationInProgress()) {
      return json(res, 409, { error: 'Runtime configuration is being updated. Try again in a moment.' });
    }
    const body = await readJson(req);
    const input = typeof body.text === 'string' ? body.text.trim() : '';
    const clientRequestId = typeof body.clientRequestId === 'string'
      && CLIENT_REQUEST_ID.test(body.clientRequestId)
      ? body.clientRequestId
      : undefined;
    const expectedSessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
      ? body.sessionId.trim()
      : undefined;
    if (!input) return json(res, 400, { error: 'Missing text' });
    const issueStart = input.match(/^\/issues\s+start\s+(\S+)(?:\s+(\S+))?\s*$/iu);
    if (issueStart) {
      await port.sendIssue(issueStart[1]!, issueStart[2], res);
      return;
    }
    await port.send(input, res, clientRequestId, expectedSessionId);
  });

  router.route('POST', '/api/session/input', async (req, res) => {
    const body = await readJson(req);
    const input = typeof body.text === 'string' ? body.text.trim() : '';
    const mode: GuiPendingInputMode = body.mode === 'steer' ? 'steer' : 'followUp';
    if (!input) return json(res, 400, { error: 'Missing text' });
    const result = port.submitPendingInput(input, mode);
    if (!result.active) return json(res, 409, { error: 'No active run for this session' });
    json(res, 202, {
      ok: true,
      mode,
      pendingInputCount: result.pendingInputCount,
    });
  });

  router.route('POST', '/api/session/new', async (_req, res) => {
    try {
      json(res, 200, await port.createSession());
    } catch (error) {
      const mapped = port.mutationError(error);
      json(res, mapped.status, mapped.body);
    }
  });

  router.route('POST', '/api/session/resume', async (req, res) => {
    try {
      const result = await port.resumeSession(req);
      if (result.status !== 200) return json(res, result.status, { error: result.error });
      json(res, 200, result.state);
    } catch (error) {
      const mapped = port.mutationError(error);
      json(res, mapped.status, mapped.body);
    }
  });

  router.route('POST', '/api/permission', async (req, res) => {
    const body = await readJson(req);
    const id = typeof body.id === 'string' ? body.id : '';
    const decision = body.decision;
    if (decision !== 'allow' && decision !== 'always' && decision !== 'always-user' && decision !== 'deny') {
      return json(res, 400, { error: 'Invalid decision' });
    }
    const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
      ? Object.fromEntries(
          Object.entries(body.answers as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string')
            .map(([key, value]) => [key, String(value)]),
        )
      : undefined;
    if (!port.resolvePermission(id, decision, answers)) {
      return json(res, 404, { error: 'Permission request not found' });
    }
    json(res, 200, { ok: true });
  });

  router.route('GET', '/api/run/events', (_req, res, url) => {
    const runId = url.searchParams.get('runId')?.trim() ?? '';
    const afterRaw = Number(url.searchParams.get('after') ?? 0);
    const after = Number.isSafeInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
    const replay = port.replayRun(runId, after);
    if (!replay) return json(res, 404, { active: false, events: [] });
    json(res, 200, replay);
  });

  router.route('POST', '/api/abort', async (req, res) => {
    const body = await readJson(req);
    const runId = typeof body.runId === 'string' && body.runId ? body.runId : undefined;
    json(res, 200, { ok: true, aborted: port.abortRun(runId) });
  });
}
