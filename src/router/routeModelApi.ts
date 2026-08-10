import { resolveRuntimeConfig } from '../config/resolveRuntimeConfig.js';
import { createOpenaiModelApi } from '../provider/openai-model-api.js';
import { createHadamardModelApi } from '../runtime/hadamardModelApi.js';
import type { ModelApi, RouterModelRef } from '../types.js';

export interface RoutedModel {
  model: string;
  modelApi: ModelApi;
  maxTokens: number;
}

export function resolveRouteApiKey(apiKey?: string): string | undefined {
  if (!apiKey) return undefined;
  return apiKey.startsWith('$') ? process.env[apiKey.slice(1)] : apiKey;
}

/** Build a model client for a route/target (resolves provider, baseURL, key). */
export async function buildRouteModelApi(ref: RouterModelRef): Promise<RoutedModel> {
  const resolved = await resolveRuntimeConfig({
    model: ref.model,
    provider: ref.provider,
    baseURL: ref.baseURL,
    authToken: resolveRouteApiKey(ref.apiKey),
    maxTokens: ref.maxTokens ?? 32000,
    workDir: process.cwd(),
  });
  const api = resolved.provider === 'openai'
    ? createOpenaiModelApi(resolved)
    : createHadamardModelApi(resolved);
  return { model: resolved.model, modelApi: api, maxTokens: ref.maxTokens ?? 32000 };
}
