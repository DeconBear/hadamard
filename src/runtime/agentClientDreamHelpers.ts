import path from 'node:path';

import type {
  AgentRunResult,
  HadamardToolClassifier,
} from '../types.js';
import { isRecord } from './helpers.js';

export function createHadamardDreamClassifier(paths: {
  memoryDir: string;
  teamMemoryDir: string;
  transcriptDir: string;
  memoryEntrypoint: string;
  memorySummaryPath: string;
}): HadamardToolClassifier {
  const readRoots = [paths.memoryDir, paths.transcriptDir].map(normalizePathForCompare);
  const writeFiles = [paths.memoryEntrypoint, paths.memorySummaryPath].map(normalizePathForCompare);
  return ({ publicName, input }) => {
    const targetPath = extractHadamardDreamTargetPath(publicName, input);
    if (!targetPath) return { behavior: 'deny', reason: `Dream requires an explicit absolute path for ${publicName}.` };
    const normalizedTarget = normalizePathForCompare(targetPath);
    switch (publicName) {
      case 'Read':
      case 'Glob':
      case 'Grep':
        return isWithinAllowedRoots(normalizedTarget, readRoots)
          ? { behavior: 'allow', reason: 'Dream may inspect memory files and session transcripts.' }
          : { behavior: 'deny', reason: `Dream only reads memory and transcript roots: ${targetPath}` };
      case 'Write':
      case 'Edit':
        return writeFiles.includes(normalizedTarget)
          ? { behavior: 'allow', reason: 'Dream may update MEMORY.md and memory_summary.md only.' }
          : { behavior: 'deny', reason: `Dream only writes MEMORY.md and memory_summary.md: ${targetPath}` };
      default:
        return { behavior: 'deny', reason: 'Dream only allows Read, Write, Edit, Glob, and Grep.' };
    }
  };
}

export function extractHadamardDreamTouchedFiles(result: AgentRunResult): string[] {
  const touched = new Set<string>();
  for (const call of result.toolCalls) {
    if (call.publicName !== 'Write' && call.publicName !== 'Edit') continue;
    if (isRecord(call.input) && typeof call.input.file_path === 'string') {
      touched.add(call.input.file_path);
    } else if (isRecord(call.output) && typeof call.output.filePath === 'string') {
      touched.add(call.output.filePath);
    }
  }
  return [...touched];
}

function extractHadamardDreamTargetPath(publicName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  switch (publicName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof input.file_path === 'string' ? input.file_path : undefined;
    case 'Glob':
    case 'Grep':
      return typeof input.path === 'string' ? input.path : undefined;
    default:
      return undefined;
  }
}

function normalizePathForCompare(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithinAllowedRoots(target: string, roots: readonly string[]): boolean {
  return roots.some(root => target === root || target.startsWith(`${root}${path.sep}`));
}
