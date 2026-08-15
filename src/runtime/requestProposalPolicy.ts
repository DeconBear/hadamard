import { ConfigurationError } from '../errors.js';
import type {
  HadamardEffort,
  HadamardRequestProposal,
  HadamardRequestProposalContext,
} from '../types.js';

const VALID_EFFORTS = new Set<HadamardEffort>(['low', 'medium', 'high', 'max']);

export interface HadamardRequestSettings {
  model: string;
  effort?: HadamardEffort;
  maxTokens: number;
}

type RequestProposalHook = (
  context: HadamardRequestProposalContext,
) => HadamardRequestProposal | void | Promise<HadamardRequestProposal | void>;

export async function resolveHadamardRequestProposal(
  hook: RequestProposalHook | undefined,
  context: HadamardRequestProposalContext,
): Promise<HadamardRequestSettings & { maxTokensProposed: boolean }> {
  const proposal = await hook?.(context);
  return {
    ...applyHadamardRequestProposal(context, proposal),
    maxTokensProposed: proposal?.maxTokens !== undefined,
  };
}

/** Validate untrusted hook output before it can mutate a provider request. */
export function applyHadamardRequestProposal(
  current: HadamardRequestSettings,
  proposal: HadamardRequestProposal | void,
): HadamardRequestSettings {
  if (!proposal) return current;

  let model = current.model;
  if (proposal.model !== undefined) {
    if (typeof proposal.model !== 'string' || !proposal.model.trim()) {
      throw new ConfigurationError('requestProposal model must be a non-empty string.');
    }
    model = proposal.model.trim();
  }

  let effort = current.effort;
  if (proposal.effort !== undefined) {
    if (!VALID_EFFORTS.has(proposal.effort)) {
      throw new ConfigurationError('requestProposal effort must be low, medium, high, or max.');
    }
    effort = proposal.effort;
  }

  let maxTokens = current.maxTokens;
  if (proposal.maxTokens !== undefined) {
    if (!Number.isSafeInteger(proposal.maxTokens) || proposal.maxTokens <= 0) {
      throw new ConfigurationError('requestProposal maxTokens must be a positive integer.');
    }
    maxTokens = proposal.maxTokens;
  }

  return { model, effort, maxTokens };
}
