import type { HcStoredOutput } from '../execOutputs.js';

export interface KernelOutputRequest {
  <T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
}

export interface KernelOutputExecutionRef {
  sessionId: string;
  executionId: string;
}

/**
 * Persist raster kernel outputs as workspace assets and rewrite their stored
 * form to the tokenized asset URL. Falls back to the inline data URL when the
 * server asset sink is unavailable; SVG stays inline because it is text.
 */
export async function persistKernelOutputAssets(
  outputs: HcStoredOutput[],
  ref: KernelOutputExecutionRef,
  deps: { request: KernelOutputRequest },
): Promise<HcStoredOutput[]> {
  if (!ref.sessionId || !ref.executionId) return outputs;
  const result: HcStoredOutput[] = [];
  for (const output of outputs) {
    if (output.kind !== 'image' || output.assetId || output.mime === 'image/svg+xml') {
      result.push(output);
      continue;
    }
    const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(output.url);
    if (!match) {
      result.push(output);
      continue;
    }
    try {
      const created = await deps.request<{ asset?: { id?: string; url?: string; mime?: string; size?: number } }>('/api/kernel-outputs', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: ref.sessionId,
          executionId: ref.executionId,
          mime: match[1],
          name: 'kernel-output.' + (match[1] === 'image/png' ? 'png' : 'jpg'),
          base64: match[2],
        }),
      });
      if (created.asset?.url) {
        result.push({ ...output, url: created.asset.url, assetId: created.asset.id, size: created.asset.size });
        continue;
      }
    } catch {
      /* keep the inline data URL */
    }
    result.push(output);
  }
  return result;
}
