/**
 * Hadamard Core Tools — unified factory for all tools.
 *
 * Provides Read, Write, Edit, Glob, Grep, Bash, TodoWrite, AskUserQuestion,
 * WebFetch, WebSearch, NotebookEdit, PowerShell, EnterWorktree, and ExitWorktree
 * by default.
 *
 * The placeholder Task tools (TaskCreate/TaskUpdate/...) and misc tools
 * (Config/ToolSearch/Skill/SendMessage/RemoteTrigger) are opt-in via
 * `taskTools: true` / `miscTools: true`: the SDK client injects real Task,
 * TaskList/TaskGet/TaskStop/TaskOutput, and Skill implementations at runtime,
 * and exposing the no-op stubs alongside them confuses the model and wastes
 * turns. ExaSearch is not registered here — enable the managed plugin "exa"
 * (EXA_API_KEY or ~/.exa/config.json).
 *
 * All schemas, descriptions, and prompts match Claude Code exactly.
 */
import path from 'node:path';
import type { AgentToolDefinition } from '../types.js';
import { WorktreeService } from '../worktree/worktreeService.js';
import { createHadamardFileTools, type HadamardFileToolsOptions } from './hadamardFileTools.js';
import { createHadamardWebTools } from './hadamardWebTools.js';
import { createTavilySearchTool } from './tavilySearch.js';
import { createBashTool } from './bash/BashTool.js';
import { createTodoWriteTool } from './todo/TodoWriteTool.js';
import { createAskUserQuestionTool } from './askUserQuestion/AskUserQuestionTool.js';
import { createPlanModeTools, type PlanModeToolContext } from './planMode/PlanModeTools.js';
import { createHadamardTaskTools } from './hadamardTaskTools.js';
import { createNotebookEditTool } from './hadamardNotebookEdit.js';
import { createPowerShellTool } from './hadamardShellTools.js';
import { createHadamardMiscTools } from './hadamardMiscTools.js';
import { createEnterWorktreeTool } from './enterWorktree.js';
import { createExitWorktreeTool } from './exitWorktree.js';

export interface HadamardCoreToolsOptions extends HadamardFileToolsOptions, PlanModeToolContext {
  bash?: boolean;
  todoWrite?: boolean;
  askUserQuestion?: boolean;
  planModeTools?: boolean;
  webTools?: boolean;
  taskTools?: boolean;
  notebookEdit?: boolean;
  powershell?: boolean;
  miscTools?: boolean;
  /** Register EnterWorktree / ExitWorktree (default true). */
  worktree?: boolean;
  /** Shared worktree stack for mid-session cwd switches. */
  getWorktreeService?: () => WorktreeService | undefined;
}

export function createHadamardCoreTools(
  options: HadamardCoreToolsOptions = {},
): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [
    ...createHadamardFileTools({ cwd: options.cwd }),
  ];

  if (options.bash !== false) tools.push(createBashTool());
  if (options.todoWrite !== false) tools.push(createTodoWriteTool());
  if (options.askUserQuestion !== false) tools.push(createAskUserQuestionTool());
  // Plan-mode tools let the agent enter/exit planning and present a plan.
  if (options.planModeTools !== false && options.cwd) {
    tools.push(...createPlanModeTools(options.cwd, {
      onPlanModeChange: options.onPlanModeChange,
      planDir: options.planDir,
    }));
  }
  if (options.webTools !== false) {
    tools.push(...createHadamardWebTools());
    // Tavily: enabled when TAVILY_API_KEY is set (no Python dependency).
    // Managed plugin "tavily" may also mount the same tool; callers should
    // prefer/dedupe by tool name when combining catalogs.
    if (process.env.TAVILY_API_KEY) tools.push(createTavilySearchTool());
  }
  if (options.taskTools === true) tools.push(...createHadamardTaskTools());
  if (options.notebookEdit !== false) tools.push(createNotebookEditTool());
  if (options.powershell !== false) tools.push(createPowerShellTool());
  if (options.miscTools === true) tools.push(...createHadamardMiscTools());
  if (options.worktree !== false) {
    let lazyService: WorktreeService | undefined;
    const getService = options.getWorktreeService ?? (() => {
      if (!lazyService) {
        lazyService = new WorktreeService(path.resolve(options.cwd ?? process.cwd()));
      }
      return lazyService;
    });
    tools.push(createEnterWorktreeTool(getService), createExitWorktreeTool(getService));
  }

  return tools;
}
