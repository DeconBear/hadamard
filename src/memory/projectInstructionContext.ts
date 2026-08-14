/**
 * Structured project-instruction context (AGENTS.md / CLAUDE.md).
 *
 * Model-visible text is a user-role `<system-reminder>`. Injection state lives
 * in session metadata (`contextKey` / `contentHash` / compact generation) so
 * duplicate detection never scans message bodies.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ProjectInstructionMode } from '../config/projectSettings.js';
import type { MessageParam } from '../provider/types.js';
import { loadProjectContext, type LoadedProjectContext } from './projectContext.js';

export const HADAMARD_PROJECT_INSTRUCTION_STATE_KEY = '__hadamardProjectInstructionState';

export const PROJECT_INSTRUCTION_HEADING = '# Project instructions';

const HADAMARD_MESSAGE_CONTEXT_KEY = '__hadamardContext';

export type HadamardMessageContextKind =
  | 'project-instructions'
  | 'agent-initial-prompt'
  | 'agent-memory'
  | 'preloaded-skills'
  | 'invoked-skills'
  | 'session-start-hooks';

interface HadamardContextMessage extends MessageParam {
  [HADAMARD_MESSAGE_CONTEXT_KEY]?: {
    kind: HadamardMessageContextKind;
  };
}

const LEGACY_PROJECT_CONTEXT_SCAFFOLD =
  '# Project context (AGENTS.md)\n\nThe following instruction files are authoritative guidance for this workspace.';

const LEGACY_HADAMARD_SYSTEM_PROMPT_PREFIXES = [
  'You are Hadamard Agent, an interactive CLI agent. Working directory: ',
  'You are Hadamard Agent, an interactive GUI agent. Working directory: ',
  'You are an interactive CLI agent powered by the Hadamard Agent SDK. Your working directory is ',
];

export interface AgentProjectInstructionOptions {
  mode?: ProjectInstructionMode;
  workPaths?: string[];
}

export type ProjectInstructionPolicy = 'inherit' | 'omit';

export interface ProjectInstructionStateV1 {
  version: 1;
  contextKey: string;
  contentHash: string;
  sources: string[];
  injectedAtCompactCount: number;
}

export interface PreparedProjectInstructionContext {
  prefixedMessages: MessageParam[];
  metadataPatch: Record<string, unknown>;
  loaded: LoadedProjectContext;
  snapshot: {
    contextKey: string;
    contentHash: string;
    compactCount: number;
    chars: number;
  };
}

export function normalizeProjectContextPath(value: string): string {
  return path.resolve(value).replaceAll('\\', '/').replace(/\/+$/u, '') || '/';
}

export function buildProjectInstructionContextKey(input: {
  workDir: string;
  mode: ProjectInstructionMode;
  workPaths: readonly string[];
}): string {
  const workDir = normalizeProjectContextPath(input.workDir);
  const workPaths = [...new Set(input.workPaths.map(normalizeProjectContextPath))].sort();
  return `${input.mode}\n${workDir}\n${workPaths.join('\n')}`;
}

export function hashProjectInstructionContent(text: string, sources: readonly string[]): string {
  return createHash('sha256')
    .update(`${sources.join('\0')}\n${text}`, 'utf8')
    .digest('hex');
}

export function parseProjectInstructionState(
  metadata: Record<string, unknown> | undefined,
): ProjectInstructionStateV1 | undefined {
  const raw = metadata?.[HADAMARD_PROJECT_INSTRUCTION_STATE_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (typeof record.contextKey !== 'string' || typeof record.contentHash !== 'string') {
    return undefined;
  }
  if (typeof record.injectedAtCompactCount !== 'number') return undefined;
  return {
    version: 1,
    contextKey: record.contextKey,
    contentHash: record.contentHash,
    sources: Array.isArray(record.sources)
      ? record.sources.filter((entry): entry is string => typeof entry === 'string')
      : [],
    injectedAtCompactCount: record.injectedAtCompactCount,
  };
}

export function serializeProjectInstructionState(
  state: ProjectInstructionStateV1,
): Record<string, unknown> {
  return {
    version: 1,
    contextKey: state.contextKey,
    contentHash: state.contentHash,
    sources: [...state.sources],
    injectedAtCompactCount: state.injectedAtCompactCount,
  };
}

/**
 * Strip only the exact Hadamard-generated project-context scaffold that used
 * to live at the end of TUI/GUI/SDK system prompts. Custom user prompts are
 * left untouched.
 */
export function stripLegacyHadamardProjectContextSection(prompt: string): {
  prompt: string;
  stripped: boolean;
} {
  if (!LEGACY_HADAMARD_SYSTEM_PROMPT_PREFIXES.some(prefix => prompt.startsWith(prefix))) {
    return { prompt, stripped: false };
  }
  const marker = `\n\n${LEGACY_PROJECT_CONTEXT_SCAFFOLD}`;
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex < 0) return { prompt, stripped: false };
  const before = prompt.slice(0, markerIndex).replace(/\n+$/u, '');
  return { prompt: before, stripped: true };
}

export function isHadamardProjectInstructionMessage(message: MessageParam): boolean {
  return getHadamardMessageContextKind(message) === 'project-instructions';
}

export function getHadamardMessageContextKind(
  message: MessageParam,
): HadamardMessageContextKind | undefined {
  return (message as HadamardContextMessage)[HADAMARD_MESSAGE_CONTEXT_KEY]?.kind;
}

export function markHadamardContextMessage(
  message: MessageParam,
  kind: HadamardMessageContextKind,
): MessageParam {
  return {
    ...message,
    [HADAMARD_MESSAGE_CONTEXT_KEY]: { kind },
  } as HadamardContextMessage;
}

/**
 * Keep persistent Hadamard-generated context unique without rewriting normal
 * user/assistant/tool history. Unchanged context stays at its original position
 * (preserving provider prefix caches); changed context replaces the stale copy.
 */
export function reconcileHadamardContextMessages(
  messages: MessageParam[],
  prefixedMessages: MessageParam[],
): { messages: MessageParam[]; prefixedMessages: MessageParam[] } {
  const kinds = new Set(
    prefixedMessages
      .map(getHadamardMessageContextKind)
      .filter((kind): kind is HadamardMessageContextKind => Boolean(kind)),
  );
  if (kinds.size === 0) return { messages, prefixedMessages };

  let nextMessages = messages;
  let nextPrefixes = prefixedMessages;
  for (const kind of kinds) {
    const existing = nextMessages.filter(message => getHadamardMessageContextKind(message) === kind);
    const pending = nextPrefixes.filter(message => getHadamardMessageContextKind(message) === kind);
    const unchanged = existing.length === pending.length
      && existing.every((message, index) =>
        JSON.stringify(stripHadamardMessageProvenance(message))
          === JSON.stringify(stripHadamardMessageProvenance(pending[index]!)),
      );
    if (unchanged) {
      nextPrefixes = nextPrefixes.filter(message => getHadamardMessageContextKind(message) !== kind);
      continue;
    }
    nextMessages = nextMessages.filter(message => getHadamardMessageContextKind(message) !== kind);
  }
  return { messages: nextMessages, prefixedMessages: nextPrefixes };
}

/** Remove Hadamard-only message provenance before constructing provider payloads. */
export function stripHadamardMessageProvenance(message: MessageParam): MessageParam {
  if (!(HADAMARD_MESSAGE_CONTEXT_KEY in message)) return message;
  const clean = { ...(message as HadamardContextMessage) };
  delete clean[HADAMARD_MESSAGE_CONTEXT_KEY];
  return clean;
}

export function prepareProjectInstructionContext(input: {
  workDir: string;
  homeDir: string;
  mode: ProjectInstructionMode;
  workPaths: readonly string[];
  compactCount: number;
  previousState?: ProjectInstructionStateV1;
  persistState: boolean;
  omit?: boolean;
}): PreparedProjectInstructionContext {
  const workPaths = input.workPaths.length > 0 ? [...input.workPaths] : [input.workDir];
  const contextKey = buildProjectInstructionContextKey({
    workDir: input.workDir,
    mode: input.mode,
    workPaths,
  });
  const loaded = input.omit
    ? { text: '', sources: [] }
    : loadProjectContext(input.workDir, {
      projectInstructionMode: input.mode,
      hadamardHomeDir: input.homeDir,
      projectWorkPaths: workPaths,
    });
  const contentHash = hashProjectInstructionContent(loaded.text, loaded.sources);
  const snapshot = {
    contextKey,
    contentHash,
    compactCount: input.compactCount,
    chars: loaded.text.length,
  };
  const empty = {
    prefixedMessages: [] as MessageParam[],
    metadataPatch: {} as Record<string, unknown>,
    loaded,
    snapshot,
  };

  if (input.omit) return empty;

  const nextState: ProjectInstructionStateV1 = {
    version: 1,
    contextKey,
    contentHash,
    sources: [...loaded.sources],
    injectedAtCompactCount: input.compactCount,
  };
  const metadataPatch = input.persistState
    ? { [HADAMARD_PROJECT_INSTRUCTION_STATE_KEY]: serializeProjectInstructionState(nextState) }
    : {};

  const previous = input.previousState;
  const hasContent = loaded.text.trim().length > 0;

  if (!previous) {
    if (!hasContent) return empty;
    return {
      prefixedMessages: [buildProjectInstructionMessage({
        kind: 'initial',
        text: loaded.text,
        sources: loaded.sources,
      })],
      metadataPatch,
      loaded,
      snapshot,
    };
  }

  const compactReplay = input.compactCount > previous.injectedAtCompactCount;
  const changed = previous.contextKey !== contextKey || previous.contentHash !== contentHash;
  if (!compactReplay && !changed) {
    return empty;
  }

  if (!hasContent) {
    return {
      prefixedMessages: [buildProjectInstructionMessage({
        kind: 'clear',
        text: '',
        sources: loaded.sources,
      })],
      metadataPatch,
      loaded,
      snapshot,
    };
  }

  return {
    prefixedMessages: [buildProjectInstructionMessage({
      kind: compactReplay && !changed ? 'restore' : 'supersede',
      text: loaded.text,
      sources: loaded.sources,
    })],
    metadataPatch,
    loaded,
    snapshot,
  };
}

function buildProjectInstructionMessage(input: {
  kind: 'initial' | 'supersede' | 'restore' | 'clear';
  text: string;
  sources: readonly string[];
}): MessageParam {
  const intro = input.kind === 'supersede'
    ? 'These instructions supersede previously injected project instructions.'
    : input.kind === 'restore'
      ? 'Restored after context compaction. These remain the current project instructions.'
      : input.kind === 'clear'
        ? 'Previously injected project instructions no longer apply. No project instruction files are currently loaded for this workspace.'
        : 'The following instruction files are authoritative guidance for their documented scope.';
  const body = input.kind === 'clear'
    ? intro
    : `${intro}\n\n${input.text.trim()}`;
  const message: HadamardContextMessage = {
    role: 'user',
    content: [
      '<system-reminder>',
      PROJECT_INSTRUCTION_HEADING,
      body,
      'IMPORTANT: this context may or may not be relevant to the current task. You should not respond to this context unless it is highly relevant to your task.',
      '</system-reminder>',
    ].join('\n'),
    [HADAMARD_MESSAGE_CONTEXT_KEY]: { kind: 'project-instructions' },
  };
  return message;
}
