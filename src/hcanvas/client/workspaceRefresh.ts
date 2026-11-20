export interface WorkspaceRefreshOptions<Context> {
  button: HTMLButtonElement;
  editing(): boolean;
  request<T>(pathname: string): Promise<T>;
  flush(): Promise<void>;
  loadMasters(): Promise<void>;
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  apply(context: Context): Promise<number | null>;
  status(text: string, tone: 'saved' | 'error'): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export async function refreshWorkspace<Context>(options: WorkspaceRefreshOptions<Context>): Promise<void> {
  if (options.editing()) {
    options.toast('Finish editing before refreshing the canvas.', 'info');
    return;
  }
  options.button.disabled = true;
  try {
    await options.flush();
    await options.loadMasters();
    const revision = await options.enqueue(async () => {
      const context = await options.request<Context>('/api/state');
      return options.apply(context);
    });
    options.status('Refreshed' + (revision !== null ? ' · rev ' + revision : ''), 'saved');
  } catch (error) {
    options.status('Refresh failed', 'error');
    options.toast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    options.button.disabled = false;
  }
}
