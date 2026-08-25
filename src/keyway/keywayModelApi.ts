import { randomUUID } from 'node:crypto';

import type { Message, MessageParam, MessageStreamEvent } from '../provider/types.js';
import type { ModelApi, ModelRequest, ModelStreamHandle } from '../types.js';
import type { UsageCounters } from '../usage/contracts.js';
import {
  keywayDataToMessageStreamEvent,
  keywayOutputToMessage,
} from './keywayProviderExecutor.js';
import type {
  KeywayCorePort,
  KeywayExecutionHandlePort,
  KeywayExecutionResultPort,
  KeywayJson,
} from './keywayPorts.js';

export interface KeywayModelApiOptions {
  core: KeywayCorePort;
  routeAlias: string;
  configurationId?: string;
  projectId?: string;
  agentId?: string;
  sessionId?: string;
  workDir?: string;
}

/** Legacy ModelApi facade so clean SDK/TUI/GUI can select a Keyway gateway route. */
export class KeywayModelApi implements ModelApi {
  private nativeSessionId?: string;

  constructor(private readonly options: KeywayModelApiOptions) {}

  async createMessage(request: ModelRequest): Promise<Message> {
    const execution = this.start(request, 'generate');
    return this.finalMessage(await execution.result, request.model);
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    const execution = this.start(request, 'stream');
    const result = execution.result.then(value => this.finalMessage(value, request.model));
    void result.catch(() => undefined);
    return {
      [Symbol.asyncIterator]: () => this.streamEvents(execution),
      finalMessage: () => result,
    };
  }

  private start(request: ModelRequest, operation: 'generate' | 'stream'): KeywayExecutionHandlePort {
    const requestId = randomUUID();
    return this.options.core.execute({
      requestId,
      correlationId: this.options.sessionId ?? requestId,
      routeAlias: this.options.routeAlias,
      requestedModel: request.model,
      operation,
      payload: toJson({
        modelRequest: stripSignal(request),
        prompt: lastUserPrompt(request.messages),
        ...(this.nativeSessionId ? { resume: this.nativeSessionId } : {}),
        ...(this.options.workDir ? { workDir: this.options.workDir } : {}),
      }),
      estimatedUsage: { requests: 1 },
      metadata: {
        ...(this.options.configurationId ? { configurationId: this.options.configurationId } : {}),
        ...(this.options.projectId ? { projectId: this.options.projectId } : {}),
        ...(this.options.agentId ? { agentId: this.options.agentId } : {}),
        ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  private streamEvents(execution: KeywayExecutionHandlePort): AsyncIterator<MessageStreamEvent> {
    return (async function* () {
      for await (const event of execution) {
        if (event.type !== 'data') continue;
        const mapped = keywayDataToMessageStreamEvent(event.value);
        if (mapped) yield mapped;
      }
    })();
  }

  private finalMessage(result: KeywayExecutionResultPort, model: string): Message {
    const output = asRecord(result.output);
    const nativeSessionId = optionalString(output?.sessionId);
    if (nativeSessionId) this.nativeSessionId = nativeSessionId;
    const message = keywayOutputToMessage(result.output, model);
    message.usage = providerUsageShape(result.usage);
    return message;
  }
}

function stripSignal(request: ModelRequest): Omit<ModelRequest, 'signal'> {
  const { signal: _signal, ...value } = request;
  return value;
}

function lastUserPrompt(messages: readonly MessageParam[]): string {
  const user = [...messages].reverse().find(message => message.role === 'user');
  if (!user) return '';
  if (typeof user.content === 'string') return user.content;
  return user.content.map(block => {
    if (typeof block === 'string') return block;
    if (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string') {
      return block.text;
    }
    return '';
  }).filter(Boolean).join('\n');
}

function providerUsageShape(usage: UsageCounters): NonNullable<Message['usage']> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
  };
}

function toJson(value: unknown): KeywayJson {
  return JSON.parse(JSON.stringify(value)) as KeywayJson;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
