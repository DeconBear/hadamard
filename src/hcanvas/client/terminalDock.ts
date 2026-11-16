/**
 * Bottom terminal/output dock for Hcanvas.
 *
 * Renders a real PTY session with xterm.js (server: HcPtyManager), streams
 * terminal data over the runtime SSE hub, and keeps a lightweight Output tab fed
 * by sidecar stderr/log runtime events. PTY availability is reported by the
 * server; when node-pty is missing the dock shows a diagnostic instead.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { extensionContributions, type ExtensionTerminalContribution } from './extensionCatalog.js';
import { esc } from './utils.js';

export interface TerminalDockDeps {
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  token(): string;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export interface TerminalProblem {
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface TerminalDockController {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  appendOutput(line: string): void;
  appendProblem(problem: TerminalProblem): void;
  showOutput(): void;
  dispose(): void;
}

interface TerminalProfileChoice {
  id: string;
  label: string;
  command?: string[];
}

interface TerminalSessionResponse {
  session?: { sessionId?: string; label?: string };
  buffer?: { base64?: string; data?: string };
}

const MAX_OUTPUT_LINES = 400;

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function defaultShellCommand(): string[] {
  if (/Windows/i.test(navigator.userAgent)) return ['powershell.exe', '-NoLogo', '-NoProfile'];
  return ['bash', '-l'];
}

export function createTerminalDock(deps: TerminalDockDeps): TerminalDockController {
  let dock: HTMLElement | null = null;
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let sessionId = '';
  let profileId = '__default';
  let source: EventSource | null = null;
  let fitObserver: ResizeObserver | null = null;
  let outputLines: string[] = [];
  let problems: TerminalProblem[] = [];
  let activeTab: 'terminal' | 'output' | 'problems' = 'terminal';
  let disposed = false;

  function profiles(): TerminalProfileChoice[] {
    const list: TerminalProfileChoice[] = [{ id: '__default', label: 'Default shell', command: defaultShellCommand() }];
    for (const item of extensionContributions<ExtensionTerminalContribution>('terminals')) {
      list.push({ id: item.contribution.id, label: item.contribution.label || item.contribution.id });
    }
    return list;
  }

  function profileById(id: string): TerminalProfileChoice | null {
    return profiles().find(item => item.id === id) || null;
  }

  function setStatus(text: string): void {
    const status = dock?.querySelector<HTMLElement>('[data-terminal-status]');
    if (status) status.textContent = text;
  }

  function appendOutput(line: string): void {
    outputLines.push(line);
    if (outputLines.length > MAX_OUTPUT_LINES) outputLines = outputLines.slice(-MAX_OUTPUT_LINES);
    const host = dock?.querySelector<HTMLElement>('[data-terminal-output]');
    if (host) {
      host.textContent = outputLines.join('\n');
      host.scrollTop = host.scrollHeight;
    }
  }

  function renderProblems(): void {
    const host = dock?.querySelector<HTMLElement>('[data-terminal-problems]');
    if (!host) return;
    host.innerHTML = problems.length
      ? problems.map(problem => '<div class="terminal-problem ' + problem.severity + '"><span class="terminal-problem-sev">' + esc(problem.severity) + '</span><span class="terminal-problem-loc">' + esc((problem.file || '') + (problem.line ? ':' + problem.line + (problem.column ? ':' + problem.column : '') : '')) + '</span><span>' + esc(problem.message) + '</span></div>').join('')
      : '<div class="terminal-problem-empty">No problems reported by user tools yet.</div>';
    const count = dock?.querySelector<HTMLElement>('[data-terminal-problem-count]');
    if (count) count.textContent = problems.length ? String(problems.length) : '';
  }

  function setActiveTab(tab: 'terminal' | 'output' | 'problems'): void {
    activeTab = tab;
    dock?.querySelectorAll<HTMLElement>('[data-terminal-tab]').forEach(item => item.classList.toggle('active', item.dataset.terminalTab === tab));
    dock?.querySelector<HTMLElement>('[data-terminal-host]')?.classList.toggle('hidden', tab !== 'terminal');
    dock?.querySelector<HTMLElement>('[data-terminal-output]')?.classList.toggle('hidden', tab !== 'output');
    dock?.querySelector<HTMLElement>('[data-terminal-problems]')?.classList.toggle('hidden', tab !== 'problems');
  }

  function closeSession(): void {
    source?.close();
    source = null;
    if (sessionId) {
      const id = sessionId;
      sessionId = '';
      void deps.request('/api/terminal/sessions/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => undefined);
    }
  }

  async function ensureSession(): Promise<void> {
    if (!term) return;
    closeSession();
    setStatus('starting…');
    try {
      const profile = profileById(profileId) || profiles()[0]!;
      const result = await deps.request<TerminalSessionResponse>('/api/terminal/sessions', {
        method: 'POST',
        body: JSON.stringify({
          ...(profile.command ? { command: profile.command } : { profileId: profile.id }),
          cols: term.cols,
          rows: term.rows,
          label: profile.label,
        }),
      });
      const id = result.session?.sessionId;
      if (!id) throw new Error('The server did not create a terminal session.');
      sessionId = id;
      setStatus(profile.label);
      if (result.buffer?.base64) term.write(decodeBase64Utf8(result.buffer.base64));
      term.focus();
      source = new EventSource('/api/runtime/events?after=0&token=' + encodeURIComponent(deps.token()));
      source.onmessage = event => {
        let record: Record<string, unknown> | null = null;
        try { record = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
        if (!record) return;
        if (record.kind === 'terminal' && record.sessionId === sessionId) {
          if (record.event === 'data' && typeof record.data === 'string') term?.write(record.data);
          else if (record.event === 'exit') term?.writeln('\r\n[terminal exited' + (typeof record.code === 'number' ? ' with code ' + record.code : '') + ']');
          else if (record.event === 'state' && typeof record.state === 'string') setStatus('terminal · ' + record.state);
          return;
        }
        if (record.kind === 'sidecar' && (record.event === 'stderr' || record.event === 'log')) {
          const payload = record.payload;
          const text = typeof payload === 'string'
            ? payload
            : payload && typeof payload === 'object'
              ? String((payload as Record<string, unknown>).text ?? (payload as Record<string, unknown>).message ?? JSON.stringify(payload))
              : '';
          if (text) appendOutput('[' + String(record.sidecarId || 'sidecar') + '] ' + text);
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus('unavailable');
      term.writeln('\r\n[Hcanvas terminal unavailable: ' + message + ']');
      appendOutput('terminal: ' + message);
    }
  }

  function ensureDock(): void {
    if (dock) return;
    dock = document.createElement('section');
    dock.id = 'terminalDock';
    dock.className = 'terminal-dock hidden';
    const profileOptions = profiles().map(profile => '<option value="' + esc(profile.id) + '">' + esc(profile.label) + '</option>').join('');
    dock.innerHTML = '<header class="terminal-dock-head"><div class="terminal-tabs"><button type="button" class="terminal-tab active" data-terminal-tab="terminal">Terminal</button><button type="button" class="terminal-tab" data-terminal-tab="output">Output</button><button type="button" class="terminal-tab" data-terminal-tab="problems">Problems<span class="terminal-problem-badge" data-terminal-problem-count></span></button></div>' +
      '<select class="terminal-profile" data-terminal-profile aria-label="Terminal profile">' + profileOptions + '</select>' +
      '<span class="terminal-status" data-terminal-status>idle</span>' +
      '<button type="button" class="btn tiny" data-terminal-restart>Restart</button>' +
      '<button type="button" class="icon-btn" data-terminal-close aria-label="Close terminal">×</button></header>' +
      '<div class="terminal-dock-body"><div class="terminal-xterm" data-terminal-host></div><pre class="terminal-output hidden" data-terminal-output></pre><div class="terminal-problems hidden" data-terminal-problems></div></div>';
    document.body.appendChild(dock);
    term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Consolas, "Cascadia Mono", ui-monospace, monospace',
      theme: { background: '#11141c', foreground: '#d8dee9', cursor: '#7c8cff' },
      scrollback: 3000,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    const host = dock.querySelector<HTMLElement>('[data-terminal-host]');
    if (host) term.open(host);
    try { fit.fit(); } catch { /* host may be hidden */ }
    term.onData(data => {
      if (!sessionId) return;
      void deps.request('/api/terminal/sessions/' + encodeURIComponent(sessionId) + '/input', {
        method: 'POST',
        body: JSON.stringify({ data: base64Utf8(data) }),
      }).catch(() => undefined);
    });
    fitObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          try { fit?.fit(); } catch { /* ignore */ }
          if (sessionId && term) {
            void deps.request('/api/terminal/sessions/' + encodeURIComponent(sessionId) + '/resize', {
              method: 'POST',
              body: JSON.stringify({ cols: term.cols, rows: term.rows }),
            }).catch(() => undefined);
          }
        })
      : null;
    if (fitObserver && host) fitObserver.observe(host);
    dock.querySelectorAll<HTMLButtonElement>('[data-terminal-tab]').forEach(button => {
      button.addEventListener('click', () => {
        const tab = button.dataset.terminalTab;
        setActiveTab(tab === 'output' ? 'output' : tab === 'problems' ? 'problems' : 'terminal');
      });
    });
    dock.querySelector<HTMLSelectElement>('[data-terminal-profile]')?.addEventListener('change', event => {
      profileId = (event.target as HTMLSelectElement).value;
      void ensureSession();
    });
    dock.querySelector<HTMLButtonElement>('[data-terminal-restart]')?.addEventListener('click', () => { void ensureSession(); });
    dock.querySelector<HTMLButtonElement>('[data-terminal-close]')?.addEventListener('click', () => { controller.close(); });
    const output = dock.querySelector<HTMLElement>('[data-terminal-output]');
    if (output) output.textContent = outputLines.join('\n');
    renderProblems();
  }

  const controller: TerminalDockController = {
    open() {
      if (disposed) return;
      ensureDock();
      dock?.classList.remove('hidden');
      document.body.classList.add('terminal-dock-open');
      requestAnimationFrame(() => {
        try { fit?.fit(); } catch { /* ignore */ }
        term?.focus();
        void ensureSession();
      });
    },
    close() {
      closeSession();
      dock?.classList.add('hidden');
      document.body.classList.remove('terminal-dock-open');
    },
    toggle() {
      if (controller.isOpen()) controller.close();
      else controller.open();
    },
    isOpen() {
      return Boolean(dock && !dock.classList.contains('hidden'));
    },
    appendOutput(line: string) {
      appendOutput(line);
    },
    appendProblem(problem: TerminalProblem) {
      problems.push(problem);
      if (problems.length > 200) problems = problems.slice(-200);
      renderProblems();
    },
    showOutput() {
      ensureDock();
      dock?.classList.remove('hidden');
      document.body.classList.add('terminal-dock-open');
      setActiveTab('output');
    },
    dispose() {
      disposed = true;
      closeSession();
      fitObserver?.disconnect();
      fitObserver = null;
      term?.dispose();
      term = null;
      dock?.remove();
      dock = null;
    },
  };
  return controller;
}
