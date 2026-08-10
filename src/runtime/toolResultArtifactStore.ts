import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ToolResultBlockParam } from '../provider/types.js';
import type { ResolvedToolExecutionResult } from '../types.js';
import { extractTextFromToolResultContent } from './messageUtils.js';

const ARTIFACTED_OUTPUT_MARKER = 'Tool output was large (';

export async function artifactToolExecutionIfLarge(
  execution: ResolvedToolExecutionResult,
  options: {
    runId: string;
    iteration: number;
    toolUseId: string;
    toolName: string;
    workDir: string;
    maxChars: number;
  },
): Promise<{ text: string; content: ToolResultBlockParam['content'] | undefined }> {
  if (options.maxChars <= 0 || execution.text.length <= options.maxChars) {
    return { text: execution.text, content: execution.content };
  }

  const summary = await writeToolResultArtifact(execution.text, {
    runId: options.runId,
    iteration: options.iteration,
    toolUseId: options.toolUseId,
    toolName: options.toolName,
    workDir: options.workDir,
    previewChars: Math.min(options.maxChars, 4_000),
  });
  return { text: summary, content: summary };
}

export async function enforceToolResultsAggregateBudget(
  toolResults: ToolResultBlockParam[],
  options: {
    runId: string;
    iteration: number;
    workDir: string;
    maxTotalChars: number;
    nameByToolUseId: Map<string, string>;
  },
): Promise<void> {
  if (options.maxTotalChars <= 0 || toolResults.length === 0) return;

  const measured = toolResults.map(block => ({
    block,
    length: extractTextFromToolResultContent(block.content).length,
  }));
  let totalChars = measured.reduce((sum, entry) => sum + entry.length, 0);
  if (totalChars <= options.maxTotalChars) return;

  const candidates = measured
    .filter(entry => !entry.block.is_error
      && !extractTextFromToolResultContent(entry.block.content).startsWith(ARTIFACTED_OUTPUT_MARKER))
    .sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    if (totalChars <= options.maxTotalChars) break;
    const text = extractTextFromToolResultContent(candidate.block.content);
    if (!text) continue;
    const summary = await writeToolResultArtifact(text, {
      runId: options.runId,
      iteration: options.iteration,
      toolUseId: candidate.block.tool_use_id,
      toolName: options.nameByToolUseId.get(candidate.block.tool_use_id) ?? 'tool',
      workDir: options.workDir,
      previewChars: 2_000,
    });
    candidate.block.content = summary;
    totalChars = totalChars - text.length + summary.length;
  }
}

async function writeToolResultArtifact(
  text: string,
  options: {
    runId: string;
    iteration: number;
    toolUseId: string;
    toolName: string;
    workDir: string;
    previewChars: number;
  },
): Promise<string> {
  const artifactDir = path.join(
    options.workDir,
    '.hadamard-artifacts',
    'tool-results',
    sanitizeArtifactSegment(options.runId),
  );
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(
    artifactDir,
    `${String(options.iteration).padStart(3, '0')}-${sanitizeArtifactSegment(options.toolUseId)}-${sanitizeArtifactSegment(options.toolName)}.txt`,
  );
  await writeFile(artifactPath, text, 'utf8');
  const preview = text.slice(0, Math.max(options.previewChars, 0));
  const omittedChars = Math.max(text.length - preview.length, 0);
  return [
    `${ARTIFACTED_OUTPUT_MARKER}${text.length} characters).`,
    `Full output saved to: ${artifactPath}`,
    omittedChars > 0 ? `Preview (${preview.length} characters, ${omittedChars} omitted):` : 'Preview:',
    preview,
  ].join('\n');
}

function sanitizeArtifactSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'artifact';
}
