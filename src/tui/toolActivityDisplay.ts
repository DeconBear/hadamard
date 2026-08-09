/** Keeps tool lifecycle rows idempotent without suppressing distinct calls. */
export class ToolActivityDisplayState {
  private readonly calls = new Map<string, 'started' | 'terminal'>();

  markStarted(callId: string): boolean {
    if (!callId) return true;
    if (this.calls.has(callId)) return false;
    this.calls.set(callId, 'started');
    return true;
  }

  markTerminal(callId: string): boolean {
    if (!callId) return true;
    if (this.calls.get(callId) === 'terminal') return false;
    this.calls.set(callId, 'terminal');
    return true;
  }

  reset(): void {
    this.calls.clear();
  }
}
