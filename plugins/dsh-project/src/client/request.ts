import { useEffect, useState } from 'react';
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';

export async function request<T>(rpc: ClientConnectionRpc, method: string, payload: object, signal: AbortSignal): Promise<T> {
  const result = await rpc.call('/api', `hadamard-project/${method}`, payload, signal);
  if (!result.ok) throw new Error(result.error.message);
  return result.value as T;
}

/** Poll only the mounted, visible view; never overlap requests or retain late replies. */
export function useProjectData<T>(rpc: ClientConnectionRpc, method: string, payload: object, poll = false) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify(payload);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    const load = async () => {
      if (pending || controller.signal.aborted) return;
      clearTimeout(timer);
      pending = true;
      try {
        const value = await request<T>(rpc, method, JSON.parse(key), controller.signal);
        if (!controller.signal.aborted) { setData(value); setError(''); }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        pending = false;
        if (poll && !controller.signal.aborted) timer = setTimeout(() => {
          if (!document.hidden) void load();
        }, 5000);
      }
    };
    const visible = () => { if (!document.hidden) void load(); };
    setData(undefined); setError('');
    void load();
    if (poll) document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [rpc, method, key, poll, revision]);
  return { data, error, refresh: () => setRevision(value => value + 1) };
}
