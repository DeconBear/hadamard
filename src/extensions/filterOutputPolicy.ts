/**
 * Output Filter built-in extension (Hadamard-owned, pi-agent style): an
 * opt-in POST tool-policy listener that redacts secrets/credentials from tool
 * results before they reach the model, and optionally hard-truncates
 * oversized text. Runs as the innermost waterfall stage (after the built-in
 * spill/PostToolUse listeners) and only rewrites the pipeline decision — the
 * durable execution record stays untouched.
 *
 * @module src/extensions/filterOutputPolicy
 */
import type { ToolResultBlockParam } from '../provider/types.js';
import type { ContributionApplyContext, HadamardRuntimeContribution } from '../contrib/contributionHost.js';
import {
  toolPolicyListenerRegistryKey,
  type ToolPostPolicyListener,
} from '../runtime/toolPolicyPipeline.js';
import type { BuiltInExtensionToggles } from './builtInExtensions.js';

interface RedactionRule {
  label: string;
  pattern: RegExp;
  /** When true, group 1 is a prefix to keep and only the remainder is redacted. */
  keepPrefix?: boolean;
  /** When true, group 1 supplies the label (lowercased); group 2 is the kept prefix. */
  labelFromMatch?: boolean;
}

const REDACTION_RULES: readonly RedactionRule[] = [
  // PEM private keys (multi-line; runs first so inner assignments are consumed).
  {
    label: 'private-key',
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { label: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { label: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  // OpenAI/Anthropic-style API keys (sk-ant-... included).
  { label: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // Bearer tokens: keep the scheme, redact the token.
  { label: 'bearer-token', pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, keepPrefix: true },
  // Generic secret assignments: keep `key=` prefix, redact the value.
  {
    label: 'secret',
    pattern:
      /\b(password|passwd|pwd|api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token)\b(\s*[:=]\s*['"]?)([^\s'"]{8,})/gi,
    keepPrefix: true,
    labelFromMatch: true,
  },
];

function compileExtraPatterns(extraPatterns?: readonly string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const source of extraPatterns ?? []) {
    if (typeof source !== 'string' || !source) continue;
    try {
      compiled.push(new RegExp(source, 'g'));
    } catch {
      // Invalid user regex: skip rather than break tool results.
    }
  }
  return compiled;
}

/**
 * Redact known secret shapes from `text`. `extraPatterns` are user regex
 * strings (compiled with `g`; invalid ones skipped) whose whole match is
 * replaced with `[REDACTED:custom]`.
 */
export function redactSensitiveText(text: string, extraPatterns?: readonly string[]): string {
  let redacted = text;
  for (const rule of REDACTION_RULES) {
    redacted = redacted.replace(rule.pattern, (...args) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as Array<string | undefined>;
      if (rule.labelFromMatch) {
        const key = groups[0] ?? 'secret';
        const separator = groups[1] ?? '';
        const value = groups[2] ?? '';
        if (value.startsWith('[REDACTED:')) return match;
        return `${key}${separator}[REDACTED:${key.toLowerCase()}]`;
      }
      if (rule.keepPrefix) {
        const prefix = groups[0] ?? '';
        const value = match.slice(prefix.length);
        if (value.startsWith('[REDACTED:')) return match;
        return `${prefix}[REDACTED:${rule.label}]`;
      }
      return `[REDACTED:${rule.label}]`;
    });
  }
  for (const pattern of compileExtraPatterns(extraPatterns)) {
    redacted = redacted.replace(pattern, '[REDACTED:custom]');
  }
  return redacted;
}

/** Hard-truncate to `maxChars` (when > 0), marking the cut. */
export function truncateText(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [truncated by filter-output extension]`;
}

export interface FilterOutputExtensionConfig {
  extraPatterns?: string[];
  /** 0 (default) disables truncation; the upstream spill listener still artifacts huge outputs. */
  maxChars?: number;
}

function transformContent(
  content: ToolResultBlockParam['content'],
  transform: (text: string) => string,
): ToolResultBlockParam['content'] {
  if (typeof content === 'string') return transform(content);
  if (Array.isArray(content)) {
    return content.map((block) =>
      block && typeof block === 'object' && block.type === 'text' && typeof (block as { text?: unknown }).text === 'string'
        ? { ...block, text: transform((block as { text: string }).text) }
        : block,
    );
  }
  return content;
}

/** Post-listener: redacts and truncates accepted results (success and error). No-op when disabled. */
export function createFilterOutputPostListener(toggles: BuiltInExtensionToggles): ToolPostPolicyListener {
  return async (_call, _execution, next) => {
    if (!toggles.isEnabled('filterOutput')) return next();
    const config = toggles.getConfig<FilterOutputExtensionConfig>('filterOutput');
    const maxChars = typeof config.maxChars === 'number' ? config.maxChars : 0;
    const transform = (text: string): string => truncateText(redactSensitiveText(text, config.extraPatterns), maxChars);
    const inner = await next();
    if (inner.kind !== 'accept') return inner;
    return {
      kind: 'accept',
      ...(inner.content !== undefined ? { content: transformContent(inner.content, transform) } : {}),
      ...(inner.additionalContexts !== undefined
        ? { additionalContexts: inner.additionalContexts.map((entry) => ({ ...entry, text: transform(entry.text) })) }
        : {}),
    };
  };
}

/** Contribution: attaches the filter-output post-listener to the tool-policy listener registry. */
export function createFilterOutputPolicyContribution(toggles: BuiltInExtensionToggles): HadamardRuntimeContribution {
  return {
    id: 'hadamard.ext.filter-output',
    apply(ctx: ContributionApplyContext) {
      const registry = ctx.services.get(toolPolicyListenerRegistryKey);
      if (!registry) return;
      const listener = createFilterOutputPostListener(toggles);
      registry.addPost(listener);
      return () => { registry.removePost(listener); };
    },
  };
}
