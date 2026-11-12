import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { htmlOutline } from './html.js';
import type { HcStore } from './store.js';
import type { HcOp } from './types.js';

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentChatStep {
  type: 'tool' | 'text';
  name?: string;
  input?: unknown;
  result?: unknown;
}

export interface AgentChatResult {
  reply: string;
  steps: AgentChatStep[];
  changed: boolean;
  docId?: string;
}

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: 'openai' | 'anthropic';
  source: 'hcanvas' | 'hadamard' | 'openai';
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

const SYSTEM_PROMPT = [
  'You are Canvas Copilot inside Hadamard Canvas, an AI-native visual canvas.',
  'You can inspect and modify the current canvas through tools. Prefer reading before writing.',
  'Use canvas_read to inspect pages/outline/html. Use canvas_apply with a full valid ops array and the current revision to make changes.',
  'Never invent a revision: call canvas_read first and use the revision it returns. Keep changes focused and explain them briefly.',
  'When the user asks for visual design, prefer HTML pages and the existing slide templates. Draw diagrams with native shape/arrow blocks on Canvas or Infinite pages.',
  'Reply in the same language as the user, concise and concrete.',
].join(' ');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'canvas_read',
      description: 'Read a canvas document. Returns outline/html/page plus current revision. Use this before applying changes.',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'Document id. Omit for the active document.' },
          pageId: { type: 'string', description: 'Optional page id.' },
          format: { type: 'string', enum: ['outline', 'html', 'page'], description: 'Read format.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'canvas_apply',
      description: 'Apply hcanvas ops to a document with revision CAS. Ops use the same schema as the hcanvas CLI.',
      parameters: {
        type: 'object',
        required: ['ops', 'baseRevision'],
        properties: {
          docId: { type: 'string', description: 'Document id. Omit for the active document.' },
          baseRevision: { type: 'number', description: 'Current document revision from canvas_read.' },
          summary: { type: 'string', description: 'Short summary of the change.' },
          ops: { type: 'array', items: { type: 'object' }, description: 'Array of hcanvas ops.' },
        },
      },
    },
  },
];

async function readWorkspaceConfig(workspace: string): Promise<Partial<LlmConfig>> {
  const file = path.join(workspace, 'agent.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<LlmConfig>;
    return parsed;
  } catch { return {}; }
}

interface HadamardSettingsEnv {
  env?: Record<string, string | undefined>;
}

async function readHadamardSettings(): Promise<Record<string, string>> {
  const home = process.env.HADAMARD_HOME || path.join(os.homedir(), '.hadamard');
  const file = path.join(home, 'settings.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as HadamardSettingsEnv;
    return Object.fromEntries(Object.entries(parsed.env || {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}

export async function resolveLlmConfig(workspace: string): Promise<LlmConfig | null> {
  const fileConfig = await readWorkspaceConfig(workspace) as Partial<LlmConfig> & { provider?: string };
  const hcanvasBase = process.env.HCANVAS_LLM_BASE_URL || fileConfig.baseUrl || '';
  const hcanvasKey = process.env.HCANVAS_LLM_API_KEY || fileConfig.apiKey || '';
  const hcanvasModel = process.env.HCANVAS_LLM_MODEL || fileConfig.model || '';
  if (hcanvasBase && hcanvasModel) {
    return {
      baseUrl: hcanvasBase.replace(/\/$/, ''),
      apiKey: hcanvasKey,
      model: hcanvasModel,
      provider: (process.env.HCANVAS_LLM_PROVIDER || fileConfig.provider) === 'anthropic' ? 'anthropic' : 'openai',
      source: 'hcanvas',
    };
  }

  const settings = await readHadamardSettings();
  const baseUrl = process.env.HADAMARD_BASE_URL || settings.HADAMARD_BASE_URL || process.env.ANTHROPIC_BASE_URL || settings.ANTHROPIC_BASE_URL || '';
  const apiKey = process.env.HADAMARD_API_KEY || settings.HADAMARD_API_KEY || process.env.ANTHROPIC_API_KEY || settings.ANTHROPIC_API_KEY || '';
  const model = process.env.HADAMARD_MODEL || settings.HADAMARD_MODEL || settings.ANTHROPIC_MODEL || settings.ACTOVIQ_DEFAULT_MAX_MODEL || '';
  if (baseUrl && model) {
    const providerHint = process.env.HADAMARD_PROVIDER || settings.ACTOVIQ_PROVIDER || '';
    const provider = providerHint.toLowerCase() === 'openai' || providerHint.toLowerCase() === 'openai-compatible'
      ? 'openai'
      : providerHint.toLowerCase() === 'anthropic' || baseUrl.includes('/anthropic')
        ? 'anthropic'
        : 'openai';
    return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, model, provider, source: 'hadamard' };
  }

  const base = process.env.OPENAI_BASE_URL || '';
  const key = process.env.OPENAI_API_KEY || '';
  const openaiModel = process.env.OPENAI_MODEL || '';
  if (base && openaiModel) return { baseUrl: base.replace(/\/$/, ''), apiKey: key, model: openaiModel, provider: 'openai', source: 'openai' };
  return null;
}

async function callModel(config: LlmConfig, messages: OpenAiMessage[]): Promise<OpenAiMessage> {
  const url = config.baseUrl.endsWith('/chat/completions') ? config.baseUrl : config.baseUrl + '/chat/completions';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = 'Bearer ' + config.apiKey;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error('Model request failed (' + response.status + '): ' + body.slice(0, 500));
  }
  const payload = await response.json() as { choices?: Array<{ message?: OpenAiMessage }> };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error('Model returned no message');
  return message;
}

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicContent[] };

interface AnthropicReply {
  content: AnthropicContent[];
  text: string;
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

function anthropicEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  if (base.endsWith('/messages')) return base;
  if (base.endsWith('/v1')) return base + '/messages';
  return base + '/v1/messages';
}

async function callAnthropicModel(config: LlmConfig, system: string, messages: AnthropicMessage[]): Promise<AnthropicReply> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (config.apiKey) headers['x-api-key'] = config.apiKey;
  const response = await fetch(anthropicEndpoint(config.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      temperature: 0.2,
      system,
      messages,
      tools: TOOLS.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })),
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error('Model request failed (' + response.status + '): ' + body.slice(0, 500));
  }
  const payload = await response.json() as { content?: AnthropicContent[] };
  const content = Array.isArray(payload.content) ? payload.content : [];
  return {
    content,
    text: content.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('\n').trim(),
    toolUses: content.filter((block): block is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => block.type === 'tool_use'),
  };
}

async function runAgentChatAnthropic(
  store: HcStore,
  config: LlmConfig,
  docId: string | undefined,
  system: string,
  input: { messages: AgentChatMessage[] },
): Promise<AgentChatResult> {
  const messages: AnthropicMessage[] = input.messages.slice(-20).map(message => ({
    role: message.role,
    content: [{ type: 'text', text: message.content }],
  }));
  const steps: AgentChatStep[] = [];
  let changed = false;
  for (let turn = 0; turn < 8; turn += 1) {
    const reply = await callAnthropicModel(config, system, messages);
    messages.push({ role: 'assistant', content: reply.content });
    if (!reply.toolUses.length) {
      const latest = docId ? await store.readDoc(docId).catch(() => null) : null;
      return { reply: reply.text || 'Done.', steps, changed, docId: latest?.id || docId };
    }
    const results: AnthropicContent[] = [];
    for (const tool of reply.toolUses) {
      steps.push({ type: 'tool', name: tool.name, input: tool.input });
      try {
        if (tool.name !== 'canvas_read' && tool.name !== 'canvas_apply') throw new Error('Unknown tool: ' + tool.name);
        const result = await executeTool(store, tool.input as Parameters<typeof executeTool>[1]);
        if (tool.name === 'canvas_apply') changed = true;
        steps.push({ type: 'text', name: tool.name + ' result', result });
        results.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result).slice(0, 14000) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps.push({ type: 'text', name: tool.name + ' error', result: { error: message } });
        results.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify({ error: message }), is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('Canvas Copilot stopped after too many tool turns');
}

function summarizeDoc(doc: { id: string; title: string; revision: number; pages: Array<{ id: string; name: string; mode: string; width: number; height: number; blocks?: unknown[]; markdown?: string }> }): string {
  return '# ' + doc.title + '\nrevision: ' + doc.revision + '\ndoc: ' + doc.id + '\n\n' + doc.pages.map(page =>
    '- ' + page.name + ' [' + (page.markdown !== undefined ? 'markdown' : page.mode) + ' ' + page.width + 'x' + page.height + '] id=' + page.id + (page.blocks ? ' blocks=' + page.blocks.length : ''),
  ).join('\n');
}

async function executeTool(store: HcStore, args: { docId?: string; pageId?: string; format?: string; ops?: unknown; baseRevision?: number; summary?: string }): Promise<unknown> {
  if (!args.docId) {
    const context = await store.getContext();
    const active = context.active as { docId?: string } | null;
    args.docId = active?.docId || (await store.listDocs())[0]?.id;
  }
  if (!args.docId) throw new Error('No canvas document available');
  const doc = await store.readDoc(args.docId);
  if (args.ops) {
    if (!Array.isArray(args.ops) || args.ops.length === 0) throw new Error('ops must be a non-empty array');
    if (!Number.isFinite(args.baseRevision)) throw new Error('baseRevision is required');
    const result = await store.applyOps(args.docId, {
      baseRevision: args.baseRevision,
      actor: 'canvas-copilot',
      ops: args.ops as HcOp[],
      summary: args.summary || 'Canvas Copilot edit',
    });
    return { ok: true, docId: result.doc.id, revision: result.doc.revision, pages: result.doc.pages.length, title: result.doc.title };
  }
  const page = args.pageId ? doc.pages.find(item => item.id === args.pageId) : doc.pages[0];
  const format = args.format || 'outline';
  if (format === 'outline') {
    return summarizeDoc(doc) + (page ? '\n\n## Active page: ' + page.name + '\n' + (page.markdown !== undefined ? page.markdown.slice(0, 16000) : page.mode === 'html' ? htmlOutline(page.html || '').slice(0, 12000) : JSON.stringify({ mode: page.mode, blocks: page.blocks?.map(block => ({ id: block.id, type: block.type, x: block.x, y: block.y, name: block.name, text: block.text || block.markdown || block.code })) }).slice(0, 12000)) : '');
  }
  if (format === 'html') return page?.markdown ?? page?.html ?? '';
  return page || doc;
}

export async function runAgentChat(store: HcStore, workspace: string, input: { docId?: string; pageId?: string; messages: AgentChatMessage[] }): Promise<AgentChatResult> {
  const config = await resolveLlmConfig(workspace);
  if (!config) throw new Error('Canvas Copilot is not configured. Set HCANVAS_LLM_BASE_URL, HCANVAS_LLM_API_KEY and HCANVAS_LLM_MODEL, or create <workspace>/agent.json with { "baseUrl": "...", "apiKey": "...", "model": "..." }.');
  if (!Array.isArray(input.messages) || !input.messages.length) throw new Error('messages are required');
  const context = await store.getContext();
  const active = context.active as { docId?: string } | null;
  const docId = input.docId || active?.docId || (await store.listDocs())[0]?.id;
  const doc = docId ? await store.readDoc(docId) : null;
  const page = doc?.pages.find(item => item.id === input.pageId) || doc?.pages[0];
  const contextText = doc ? 'Active canvas: ' + doc.title + ' (' + doc.id + '), revision ' + doc.revision + ', page: ' + (page?.name || '') + ' (' + (page?.id || '') + ').' : 'No canvas is active.';
  const systemPrompt = SYSTEM_PROMPT + '\n\n' + contextText;
  if (config.provider === 'anthropic') return runAgentChatAnthropic(store, config, docId, systemPrompt, input);
  const messages: OpenAiMessage[] = [
    { role: 'system', content: systemPrompt },
    ...input.messages.slice(-20).map(message => ({ role: message.role, content: message.content })),
  ];
  const steps: AgentChatStep[] = [];
  let changed = false;
  for (let turn = 0; turn < 8; turn += 1) {
    const reply = await callModel(config, messages);
    if (reply.tool_calls?.length) {
      messages.push({ role: 'assistant', content: reply.content || '', tool_calls: reply.tool_calls });
      for (const call of reply.tool_calls) {
        let args: { docId?: string; pageId?: string; format?: string; ops?: unknown; baseRevision?: number; summary?: string } = {};
        try { args = JSON.parse(call.function.arguments || '{}') as typeof args; } catch { throw new Error('Invalid tool arguments from model'); }
        steps.push({ type: 'tool', name: call.function.name, input: args });
        try {
          if (call.function.name !== 'canvas_read' && call.function.name !== 'canvas_apply') throw new Error('Unknown tool: ' + call.function.name);
          const result = await executeTool(store, args);
          if (call.function.name === 'canvas_apply') changed = true;
          steps.push({ type: 'text', name: call.function.name + ' result', result });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 14000) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          steps.push({ type: 'text', name: call.function.name + ' error', result: { error: message } });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: message }) });
        }
      }
      continue;
    }
    const replyText = (reply.content || '').trim();
    if (replyText) {
      const latest = docId ? await store.readDoc(docId).catch(() => null) : null;
      return { reply: replyText, steps, changed, docId: latest?.id };
    }
    throw new Error('Model returned an empty response');
  }
  throw new Error('Canvas Copilot stopped after too many tool turns');
}
