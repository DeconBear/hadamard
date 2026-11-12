export type AutoSaveStatus = 'pending' | 'saving' | 'saved' | 'error';

export interface AutoSaveOptions {
  delay?: number;
  save(value: string): Promise<void>;
  onStatus(status: AutoSaveStatus): void;
}

export interface AutoSaveController {
  change(value: string): void;
  flush(): Promise<boolean>;
  close(): Promise<boolean>;
}

export function createAutoSave(options: AutoSaveOptions): AutoSaveController {
  const delay = options.delay ?? 600;
  let latest = '';
  let revision = 0;
  let savedRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  let closed = false;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const flush = (): Promise<boolean> => {
    clearTimer();
    const savingRevision = revision;
    if (savingRevision === savedRevision) return queue.then(() => savedRevision === revision);
    const value = latest;
    options.onStatus('saving');
    const result = queue.then(async () => {
      try {
        await options.save(value);
        savedRevision = savingRevision;
        options.onStatus(savedRevision === revision ? 'saved' : 'pending');
        return true;
      } catch {
        options.onStatus('error');
        return false;
      }
    });
    queue = result.then(() => undefined);
    return result;
  };

  const change = (value: string): void => {
    if (closed || value === latest) return;
    latest = value;
    revision += 1;
    options.onStatus('pending');
    clearTimer();
    timer = setTimeout(() => { void flush(); }, delay);
  };

  const close = async (): Promise<boolean> => {
    clearTimer();
    let saved = await flush();
    await queue;
    if (savedRevision !== revision) saved = (await flush()) && saved;
    await queue;
    const complete = saved && savedRevision === revision;
    if (complete) {
      closed = true;
      clearTimer();
    }
    return complete;
  };

  return { change, flush, close };
}
