export interface RequestTokenEstimateBreakdown {
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
  uncalibratedTokens: number;
  totalTokens: number;
  multiplier: number;
}

function serializedTokenEstimate(value: unknown): number {
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return 0;
  }
}

export function estimateRequestTokenBreakdown(input: {
  systemPrompt?: string;
  tools?: readonly unknown[];
  messageTokens: number;
  multiplier?: number;
}): RequestTokenEstimateBreakdown {
  const systemTokens = Math.ceil((input.systemPrompt?.length ?? 0) / 4);
  const toolTokens = serializedTokenEstimate(input.tools ?? []);
  const messageTokens = Math.max(0, input.messageTokens);
  const uncalibratedTokens = systemTokens + toolTokens + messageTokens;
  const multiplier = input.multiplier ?? 1;
  return {
    systemTokens,
    toolTokens,
    messageTokens,
    uncalibratedTokens,
    totalTokens: Math.ceil(uncalibratedTokens * multiplier),
    multiplier,
  };
}

export function calibrateRequestTokenMultiplier(input: {
  currentMultiplier: number;
  reportedInputTokens: number;
  uncalibratedRequestTokens: number;
}): number {
  if (input.uncalibratedRequestTokens <= 0) return input.currentMultiplier;
  const observedMultiplier = Math.min(
    Math.max(input.reportedInputTokens / input.uncalibratedRequestTokens, 0.5),
    8,
  );
  return Math.min(
    Math.max((input.currentMultiplier * 0.65) + (observedMultiplier * 0.35), 0.5),
    8,
  );
}
