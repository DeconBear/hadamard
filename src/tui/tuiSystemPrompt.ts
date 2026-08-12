import { execSync } from 'node:child_process';

import type { ProjectSettings } from '../config/projectSettings.js';
import { appendProjectSettingsToPrompt } from '../config/projectSettings.js';
import { loadProjectContext } from '../memory/projectContext.js';

export function buildTuiSystemPrompt(
  workDir: string,
  projectSettings: Pick<ProjectSettings, 'context' | 'customPrompt' | 'projectRules'>,
  hadamardHomeDir: string,
  projectWorkPaths = [workDir],
): string {
  let isGit = false;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: workDir, stdio: 'ignore' });
    isGit = true;
  } catch {
    // not a git repo
  }
  const project = loadProjectContext(workDir, {
    projectInstructionMode: projectSettings.context.instructionMode,
    hadamardHomeDir,
    projectWorkPaths,
  });
  const projectSection = project.text
    ? `\n\n# Project context (AGENTS.md)\n\nThe following instruction files are authoritative guidance for this workspace.\n\n${project.text}\n`
    : '';
  const base = (
    `You are Hadamard Agent, an interactive CLI agent. Working directory: ${workDir}\n\n` +
    `<env>\nWorking directory: ${workDir}\nIs git repo: ${isGit ? 'Yes' : 'No'}\nPlatform: ${process.platform}\nDate: ${new Date().toISOString().slice(0, 10)}\n</env>\n\n` +
    `# Tone and style\n` +
    `- Only use emojis if the user explicitly requests it.\n` +
    `- Your responses should be short and concise.\n` +
    `- When referencing code include the pattern file_path:line_number.\n\n` +
    `# Doing tasks\n` +
    `- Prefer editing existing files to creating new ones.\n` +
    `- Do not add features, refactor, or introduce abstractions beyond what the task requires.\n` +
    `- Default to writing no comments.\n\n` +
    `# Git Safety Protocol\n` +
    `- NEVER update the git config\n` +
    `- NEVER run destructive git commands unless the user explicitly requests\n` +
    `- NEVER skip hooks unless the user explicitly requests it\n` +
    `- NEVER commit changes unless the user explicitly asks you to\n\n` +
    `# Other\n` +
    `- NEVER create documentation files (*.md) unless explicitly requested.\n` +
    `- When in doubt, use TodoWrite to track progress.`
  );
  return appendProjectSettingsToPrompt(base, projectSettings) + projectSection;
}
