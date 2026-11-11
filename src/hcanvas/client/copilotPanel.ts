export interface CopilotStep {
  type?: string;
  name?: string;
  result?: unknown;
}

export interface CopilotMessage {
  role: 'user' | 'assistant';
  content: string;
  steps?: CopilotStep[];
  error?: boolean;
}

interface CopilotStatus {
  configured: boolean;
  model?: string | null;
  baseUrl?: string | null;
}

export interface CopilotPanelOptions {
  root: HTMLElement;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  getDocId(): string;
  getPageId(): string;
  onChanged(docId: string): Promise<void> | void;
}

let messages: CopilotMessage[] = [];
let draft = '';
let busy = false;
let status: CopilotStatus | null = null;
let statusError = '';
let statusLoading = false;
let lastContextKey = '';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toolNames(steps: CopilotStep[] | undefined): string[] {
  return (steps || [])
    .filter(step => step.type === 'tool' && step.name)
    .map(step => String(step.name));
}

export function renderCopilotPanel(options: CopilotPanelOptions): void {
  const { root } = options;
  if (!root) return;
  const contextKey = options.getDocId() + ':' + options.getPageId();
  if (lastContextKey && lastContextKey !== contextKey) {
    messages = [];
    draft = '';
  }
  lastContextKey = contextKey;

  function paint(): void {
    if (!root.isConnected) return;
    const configured = status?.configured;
    const badge = statusLoading ? 'checking' : configured ? 'Ready' : 'Setup needed';
    const badgeClass = statusLoading ? '' : configured ? 'ready' : 'setup';
    let html = '<div class="copilot-head"><div><div class="inspector-title">Canvas Copilot</div><small>Chat with an agent that can read and patch this document.</small></div><span class="copilot-badge ' + badgeClass + '">' + badge + '</span></div>';
    if (status?.configured) {
      html += '<div class="copilot-status-line"><span class="agent-dot online"></span><span>' + escapeHtml(status.model || 'model ready') + '</span><span class="copilot-status-sep">·</span><span>revision-checked edits</span></div>';
    } else if (!statusLoading) {
      html += '<div class="copilot-setup"><strong>Configure a model to use Copilot.</strong><p>Set <code>HCANVAS_LLM_BASE_URL</code>, <code>HCANVAS_LLM_API_KEY</code>, <code>HCANVAS_LLM_MODEL</code>, or create <code>&lt;workspace&gt;/agent.json</code>.</p>' + (statusError ? '<p class="copilot-error">' + escapeHtml(statusError) + '</p>' : '') + '</div>';
    }
    html += '<div class="copilot-log">';
    if (!messages.length && !busy) {
      html += '<div class="copilot-welcome"><div class="copilot-mark">✦</div><strong>Make something with the canvas.</strong><p>Ask Copilot to inspect this page, write a section, create a slide, or fix the layout.</p><div class="copilot-suggestions"><button type="button" data-copilot-suggest="Summarize this page">Summarize this page</button><button type="button" data-copilot-suggest="Create a slide about this topic">Create a slide</button><button type="button" data-copilot-suggest="Improve the layout of this page">Improve layout</button></div></div>';
    }
    for (const message of messages) {
      const isError = Boolean(message.error);
      html += '<div class="copilot-message ' + (isError ? 'assistant error' : message.role) + '"><span class="copilot-role">' + (isError ? 'Copilot error' : message.role === 'user' ? 'You' : 'Copilot') + '</span><div class="copilot-bubble">' + escapeHtml(message.content) + '</div>';
      const tools = toolNames(message.steps);
      if (tools.length) html += '<div class="copilot-steps">' + tools.map(name => '<span class="copilot-step tool">' + escapeHtml(name) + '</span>').join('') + '</div>';
      html += '</div>';
    }
    if (busy) html += '<div class="copilot-message assistant"><span class="copilot-role">Copilot</span><div class="copilot-bubble thinking"><span class="agent-dot online"></span>Thinking…</div></div>';
    html += '</div>';
    const sendDisabled = busy || configured === false;
    html += '<div class="copilot-compose"><textarea id="copilotInput" rows="3" placeholder="' + (configured === false ? 'Configure a model to start…' : 'Ask Copilot to change this canvas…') + '"' + (sendDisabled ? ' disabled' : '') + '></textarea><div class="copilot-compose-row"><small>Enter to send · Shift+Enter for a new line</small><button type="button" id="copilotSend" class="btn tiny primary"' + (sendDisabled ? ' disabled' : '') + '>Send</button></div></div>';
    root.innerHTML = html;
    const input = root.querySelector<HTMLTextAreaElement>('#copilotInput');
    if (input) {
      input.value = draft;
      input.addEventListener('input', () => { draft = input.value; });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(draft); }
      });
    }
    root.querySelector('#copilotSend')?.addEventListener('click', () => void send(draft));
    root.querySelectorAll<HTMLButtonElement>('[data-copilot-suggest]').forEach(button => {
      button.addEventListener('click', () => void send(button.dataset.copilotSuggest || ''));
    });
    if (!messages.length && !busy && configured !== false) input?.focus();
  }

  async function loadStatus(): Promise<void> {
    if (statusLoading) return;
    statusLoading = true;
    paint();
    try {
      status = await options.request<CopilotStatus>('/api/agent/status');
      statusError = '';
    } catch (error) {
      statusError = error instanceof Error ? error.message : String(error);
    } finally {
      statusLoading = false;
      paint();
    }
  }

  async function send(text: string): Promise<void> {
    const value = text.trim();
    if (!value || busy) return;
    if (status?.configured === false) return;
    messages.push({ role: 'user', content: value });
    draft = '';
    busy = true;
    paint();
    const history = messages
      .filter(message => !message.error)
      .map(message => ({ role: message.role, content: message.content }));
    try {
      const result = await options.request<{ reply: string; steps?: CopilotStep[]; changed?: boolean; docId?: string }>('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({ docId: options.getDocId(), pageId: options.getPageId(), messages: history }),
      });
      messages.push({ role: 'assistant', content: result.reply, steps: result.steps });
      busy = false;
      if (result.changed && result.docId) {
        await options.onChanged(result.docId);
        if (root.isConnected) paint();
      } else paint();
    } catch (error) {
      messages.push({ role: 'assistant', content: error instanceof Error ? error.message : String(error), error: true });
      busy = false;
      paint();
    }
  }

  if (!status) void loadStatus();
  else paint();
}
