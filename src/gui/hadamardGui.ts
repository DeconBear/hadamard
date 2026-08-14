#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { z } from 'zod';
import { captureDesktopRegionScreenshot, captureDesktopScreenshot, ScreenshotCancelledError } from '../computer/hadamardComputerUse.js';
import { tool } from '../runtime/tools.js';
import { TerminalManager, ptyAvailable, isWindowsTerminalShellPreference, type WindowsTerminalShellPreference } from './terminalManager.js';
import {
  parseGitCommitLog,
  readGitDiffAsync,
  readWorkspaceFile,
  writeWorkspaceFile,
} from './projectWorkbench.js';
import {
  buildGraphTeamFromTemplate,
  insertLoopAsNestedTeam,
  insertLoopBlock,
  insertParallelAsNestedTeam,
  insertParallelBlock,
  type GraphTeamTemplate,
} from '../team/teamGraphScaffold.js';
import {
  isSingleAgentSquadType,
} from '../team/teamPropose.js';

/**
 * Agent TUI vision (plan phase 6). The TerminalSnapshot tool lets the chat
 * agent read a workbench terminal's screen as text — so it can answer
 * "what's on my terminal?" about a TUI (htop, a REPL) or command output. It
 * reads the offscreen @xterm/headless buffer the TerminalManager keeps per pty.
 * Omit terminalId to snapshot the most recently opened terminal.
 */
function createTerminalVisionTools(tm: TerminalManager): AgentToolDefinition[] {
  return [
    tool(
      {
        name: 'TerminalSnapshot',
        description:
          'Capture the current screen of a workbench terminal pane as text, so you can read TUI output (e.g. htop, a REPL, a pager) or command output the user is looking at. Call with no arguments to snapshot the most recently opened terminal. The terminal is live — output may have moved on by the time you read it. Returns the visible rows joined by newlines, plus the terminal cwd and command.',
        inputSchema: z.strictObject({
          terminalId: z.string().optional().describe('A specific terminal id (from the list). Omit to use the most recently opened terminal.'),
          rows: z.number().int().positive().max(200).optional().describe('Maximum number of rows to return (default 50, the visible viewport).'),
        }),
        isReadOnly: () => true,
      },
      async (input) => {
        const list = tm.list();
        if (list.length === 0) {
          return { type: 'text', ok: false, error: 'No terminal sessions are open in the workbench. Ask the user to open a terminal pane first.' };
        }
        const target = (typeof input.terminalId === 'string' && input.terminalId)
          ? list.find((t) => t.id === input.terminalId)
          : list[list.length - 1];
        if (!target) {
          return { type: 'text', ok: false, error: `Terminal not found: ${input.terminalId}. Open terminals: ${list.map((t) => t.id).join(', ')}` };
        }
        const screen = tm.snapshot(target.id, input.rows ?? 50) ?? '';
        return {
          type: 'text',
          ok: true,
          terminalId: target.id,
          cwd: target.cwd,
          cmd: target.cmd,
          cols: target.cols,
          rows: target.rows,
          alive: target.alive,
          screen,
        };
      },
    ),
  ];
}

import {
  createHadamardCoreTools,
  createAgentSdk,
  readHadamardBrowserSettings,
  writeHadamardBrowserSettings,
  askTeamDefinition,
  createTeamTool,
  detectBridgeProviders,
  discoverAgentRuntimes,
  detectRuntimeLocalConfig,
  updateRuntimeLocalConfig,
  listRouterProfiles,
  listTeamDefinitions,
  listWorkflows,
  loadDefaultHadamardSettings,
  loadHadamardExternalSkillDefinitions,
  loadJsonConfigFile,
  loadRouterProfile,
  saveRouterProfile,
  deleteRouterProfile,
  loadTeamDefinition,
  cloneTeamDefinition,
  instantiateTeamDefinition,
  getBuiltInTeamDefinition,
  ensureConfiguredTeamGraph,
  canonicalizeTeamDefinition,
  validateTeamGraph,
  migrateTeamDefinitionToGraph,
  readTeamPreferences,
  writeTeamPreferences,
  createManagerTools,
  buildDecomposeIssuePrompt,
  buildManagerSystemPrompt,
  buildUpdateDesignPrompt,
  formatManagerUpdatePreview,
  resolveGitHubDigestForUpdate,
  readManagerConfig,
  writeManagerConfig,
  createAssistantGlobalTools,
  buildAssistantGlobalSystemPrompt,
  createAssistantTeamTools,
  buildAssistantTeamSystemPrompt,
  TeamProposalStore,
  AssistantProposalStore,
  SessionCatalog,
  readAssistantConfig,
  writeAssistantConfig,
  isAssistantScope,
  readProjectPlanFile,
  writeProjectPlanFile,
  readDesignFile,
  managerDesignPath,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  addIssueComment,
  createProjectIssue,
  deleteProjectIssue,
  isIssuePriority,
  isIssueStatus,
  isIssueStorageMode,
  listProjectIssues,
  migrateIssueStore,
  resolveIssueStorePath,
  loadWorkflow,
  listScheduledAutomationTasks,
  resolveScheduledAutomationWorkflow,
  resolveRoutedRun,
  recordScheduledAutomationRun,
  getHadamardHomePointerPath,
  listHadamardHomeTopLevelEntries,
  migrateHadamardHomeData,
  migrateLegacyProjectActoviqDirIfNeeded,
  resolveHadamardHome,
  externalSkillPreferencesToRuntimeOptions,
  readHadamardExternalSkillPreferences,
  setHadamardExternalSkillDisabled,
  setHadamardPreferredExternalSkill,
  clearHadamardPreferredExternalSkill,
  writeHadamardExternalSkillPreferences,
  summarizeHadamardHome,
  saveTeamDefinition,
  deleteTeamDefinition,
  deleteWorkflow,
  saveWorkflow,
  setScheduledAutomationEnabled,
  TaskScheduler,
  upsertScheduledAutomationTask,
  deleteScheduledAutomationTask,
  deleteAgentProfile,
  findSelectableAgent,
  getScheduledAutomationTask,
  listAgentProfiles,
  listSelectableAgents,
  resolveSelectableAgentRun,
  agentProfileRunOverrides,
  resolveEffectiveAgentRunOptions,
  transitionProjectIssue,
  updateProjectIssue,
  upsertAgentProfile,
  validateAgentProfile,
  writeAgentProfileMarkdown,
  writeAgentDefinitionMarkdown,
  readAgentDefinitionMarkdown,
  deleteAgentProfileMarkdown,
  getHadamardAgentTemplate,
  getHadamardAgentTemplates,
  loadHadamardAgentDefinitions,
  getDefaultHadamardAgents,
  summarizeHadamardAgentDefinition,
  readAllAgentReferenceProfiles,
  listAgentDefinitionNames,
  WorktreeService,
  decideGoalExecution,
  type Goal,
  HADAMARD_SESSION_PERMISSION_STATE_KEY,
  serializeHadamardSessionPermissionState,
  type HadamardAgentClient,
  type AgentProfile,
  type AgentDefinitionExtraFields,
  type AssistantEditorContext,
  type ManagerConfig,
  type IssueCommentKind,
  type IssueStorageMode,
  type ProjectIssue,
  isManagerReadScope,
} from '../index.js';
import {
  addBridgeConfig,
  findBridgeConfig,
  maskApiKey,
  readBridgeConfigs,
  removeBridgeConfig,
  isManagedExternalCliRuntime,
  VALID_RUNTIMES,
  type BridgeRuntime,
  type ModelModality,
  type PersistedBridgeConfig,
  type ManagedExternalCliRuntime,
} from '../parity/bridgeConfigs.js';
import {
  externalCliSessionMatchesConfig,
  listExternalCliSessions,
  readExternalCliSession,
  type ExternalCliSessionSummary,
  type ExternalCliRuntime,
} from '../parity/externalCliSessions.js';
import { parseCrushSessionReferenceDetails } from '../parity/crushSessionHistory.js';
import { probeExternalCliAuth } from '../parity/externalCliAuth.js';
import {
  ExternalCliRuntimeManager,
  type ExternalCliRunSnapshot,
} from '../parity/externalCliRuntimeManager.js';
import {
  bridgeEventToAgentEvents,
  createBridgeEventAdapterState,
} from '../parity/bridgeEventAdapter.js';
import { buildRouteModelApi } from '../router/modelRouter.js';
import {
  buildReferenceIndex,
} from '../manager/referenceIndex.js';
import {
  applyDeleteFallback,
  convertAgentSquadToAgentDefinition,
  renameDefinitionAndReferences,
  repointConfigModel,
  type DeleteFallbackStrategy,
} from '../manager/referenceOperations.js';
import { BrokenReferenceError } from '../manager/resolveTargetRef.js';
import {
  DurableIssueCoordinator,
  type DurableIssueExecutionRequest,
} from '../issues/durableIssueCoordinator.js';
import { SqliteDurableChildStore } from '../node/sqliteDurableChildStore.js';
import { SqliteStorageV2 } from '../storage-v2/sqliteStorage.js';
import {
  emptyUsage,
  type AgentSpec,
  type JsonValue,
  type Usage,
} from '../core/index.js';
import { estimateCost } from '../team/pricing.js';
import {
  validateWorkflowSquad,
} from '../team/workflowSquad.js';
import { listPlanFiles, planDirFor, planFilePath, readPlanFile } from '../tools/planMode/PlanModeTools.js';
import { isReadOnlyBashCommand } from '../runtime/bashClassification.js';
import { loadProjectContext } from '../memory/projectContext.js';
import {
  hashProjectInstructionContent,
  parseProjectInstructionState,
} from '../memory/projectInstructionContext.js';
import { recordTurn } from '../memory/sessionHistory.js';
import {
  addMcpServer,
  readMcpServerConfig,
  removeMcpServer,
  type PersistedMcpServer,
} from '../mcp/mcpServerConfig.js';
import {
  createPreToolUseHookClassifier,
  normalizeUserHooksConfig,
  readPostToolUseHooks,
  readPreToolUseHooks,
  readSessionStartHooks,
  readUserHooksConfig,
  runPostToolUseHooks,
  runSessionStartHooks,
  toSettingsHooksBlock,
} from '../hooks/userHooks.js';
import { parseTypedHooks } from '../hooks/hookConfig.js';
import { clearLoadedJsonConfig, getLoadedJsonConfig } from '../config/loadJsonConfigFile.js';
import {
  getHadamardProjectSessionDirectory,
  migrateLegacyHadamardProjectData,
} from '../config/projectSessionDirectory.js';
import {
  persistHadamardSettingsStore,
  resolveHadamardSettingsStore,
} from '../config/hadamardSettingsStore.js';
import {
  MANAGED_PLUGIN_IDS,
  patchManagedPluginSettings,
  readManagedPluginCatalog,
  type ManagedPluginHealth,
  type ManagedPluginId,
} from '../plugins/managedPluginCatalog.js';
import { probeManagedPlugin } from '../plugins/managedPluginHealth.js';
import { PluginPackageManager } from '../plugins/pluginManager.js';
import { readPackageVersion } from '../cli/version.js';
import {
  createUnsupportedAppUpdateController,
  type AppUpdateController,
} from '../update/appUpdateService.js';
import { discoverHadamardPlugins } from '../tui/pluginCatalog.js';
import {
  HADAMARD_GUI_INTERACTIVE_COMMANDS,
  interactiveCommandUsage,
  parseTeamAskArguments,
} from '../ui/commandSurface.js';
import {
  createAgentExecutionProjectView,
  createAgentExecutionRootView,
} from '../ui/agentExecutionView.js';
import { createExternalCliAgentExecutionSnapshots } from './externalCliAgentMonitor.js';
import {
  ContextRailReminderScheduler,
  normalizeContextRailStore,
  readContextRailStore,
  sortContextRailItems,
  writeContextRailStore,
} from './contextRailStore.js';
import { readWorkspaceNote, writeWorkspaceNote } from './workspaceNote.js';
import {
  LegacySurfaceEventPipeline,
  type SurfaceSemanticEvent,
} from '../surfaces/index.js';
import {
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES,
  isProjectStatus,
  readProjectMeta,
  writeProjectMeta,
  type ProjectStatus,
} from './projectMeta.js';
import {
  DEFAULT_PROJECT_SETTINGS,
  appendProjectSettingsToPrompt,
  encodeDreamProfileValue,
  readProjectSettings,
  writeProjectSettings,
  type ProjectMemorySettingsPatch,
  type ProjectSettings,
} from '../config/projectSettings.js';
import {
  readSessionAgentMode,
  sessionAgentModePatch,
} from '../runtime/agentModeService.js';
import {
  formatContextWindowTokens,
  HADAMARD_CONTEXT_WINDOW_METADATA_KEY,
  modelContextWindowLimit,
  modelContextWindowOptions,
  parseContextWindowTokens,
  readSessionContextWindow,
  resolveModelContextEntry,
} from '../config/modelContextWindow.js';
import { applyResolvedToolDescriptions } from '../runtime/agentClientRunHelpers.js';
import { estimateRequestTokenBreakdown } from '../runtime/requestTokenEstimate.js';
import { estimateHadamardConversationTokens } from '../memory/hadamardSessionMemoryState.js';
import { isAgentMode } from '../runtime/agentExecutionPolicy.js';
import {
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
} from './promptTemplates.js';
import {
  addProjectWorkPath,
  findWorkspaceProject,
  forgetWorkspaceFromRegistry,
  readWorkspaceRegistry,
  removeProjectWorkPath,
  rememberWorkspace,
  setProjectActiveWorkPath,
  setWorkspacePinned,
  workspaceActiveWorkPath,
  workspaceWorkPaths,
} from './workspaceRegistry.js';
import { GuiHttpRouter, json, readJson, text } from './guiHttpRouter.js';
import { GuiDeviceLinkHttpController } from './guiDeviceLinkHttpController.js';
import { registerGuiShellHttpController } from './guiShellHttpController.js';
import { registerGuiChatHttpController } from './guiChatHttpController.js';
import { rejectMismatchedGuiSession } from './guiSessionHttpGuard.js';
import { registerGuiSettingsHttpController } from './guiSettingsHttpController.js';
import { registerGuiTeamHttpController } from './guiTeamHttpController.js';
import { registerGuiAgentHttpController } from './guiAgentHttpController.js';
import { registerGuiReferenceHttpController } from './guiReferenceHttpController.js';
import { registerGuiDesignHttpController } from './guiDesignHttpController.js';
import { DesignDocumentService } from '../design/designDocumentService.js';
import { ProjectRuleCatalogService } from '../rules/projectRuleCatalog.js';
import {
  createGuiReferenceHttpService,
  type GuiReferenceSnapshot,
} from './guiReferenceHttpService.js';
import type {
  HadamardCanUseTool,
  HadamardEffort,
  HadamardPermissionMode,
  HadamardPermissionRule,
  HadamardRunEffort,
  HadamardToolApprover,
  AgentEvent,
  AgentRunResult,
  AgentToolDefinition,
  AgentTargetRef,
  RouterModelRef,
  RouterProfile,
  RouterRoute,
  ScheduledAutomationTask,
  ScheduledAutomationTaskInput,
  TeamDefinition,
  HadamardAgentDefinition,
  TeamEvent,
  SessionSummary,
  SessionCreateOptions,
  SessionResumeOptions,
  ModelTeamResult,
  StoredSession,
} from '../types.js';
import { AgentSession } from '../runtime/agentSession.js';
import { SessionStore } from '../storage/sessionStore.js';
import {
  isEmptyUserSessionSummary,
  isEmptyUserStoredSession,
} from '../storage/sessionVisibility.js';
import { discoverProjectSessions } from '../storage/sessionDiscovery.js';
import { AgentExecutionStore } from '../storage/agentExecutionStore.js';
import { BackgroundTaskStore } from '../storage/backgroundTaskStore.js';
import { assertSafeStorageSegment } from '../storage/pathSafety.js';
import { extractConversationBrief, extractPreviewFromMessages } from '../runtime/messageUtils.js';
import { truncateText } from '../runtime/helpers.js';
import { generateReviewSummary } from '../review/reviewSummaryService.js';
import type { ContentBlockParam } from '../provider/types.js';
import { buildSessionTranscriptEvents } from '../ui/sessionTranscriptView.js';

const DEFAULT_PORT = 4174;
const EFFORT_LEVELS: readonly HadamardEffort[] = ['low', 'medium', 'high', 'max'];
const READONLY_DENY = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'PowerShell'];
const PERMISSION_MODES = new Set<HadamardPermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'auto',
]);

function isExternalCliHistorySecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return normalized === 'key'
    || /(?:apikey|accesskey|privatekey|token|authorization|auth|password|passwd|secret|cookie|credential)/u
      .test(normalized);
}

function redactExternalCliHistoryString(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted
    .replace(/Bearer\s+[^\s"',;}\]]+/giu, 'Bearer [REDACTED]')
    .replace(
      /(\b(?:api[\s_-]*key|access[\s_-]*token|auth[\s_-]*token|authorization|password|passwd|secret|token|key)\s*["']?\s*[:=]\s*["']?)([^"'\s,;}\]]+)/giu,
      '$1[REDACTED]',
    );
}

function redactExternalCliHistoryDto<T>(
  value: T,
  secrets: readonly string[],
  seen = new WeakSet<object>(),
): T {
  if (typeof value === 'string') {
    return redactExternalCliHistoryString(value, secrets) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]' as T;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map(item => redactExternalCliHistoryDto(item, secrets, seen)) as T;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = isExternalCliHistorySecretKey(key)
      ? '[REDACTED]'
      : redactExternalCliHistoryDto(child, secrets, seen);
  }
  return redacted as T;
}

function externalCliHistorySecrets(homeDir: string): string[] {
  return readBridgeConfigs(homeDir).configs
    .map(config => config.apiKey)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((left, right) => right.length - left.length);
}

function externalCliHistorySourceLabel(
  summary: Pick<ExternalCliSessionSummary, 'runtime' | 'path'>,
): string | undefined {
  if (summary.runtime !== 'crush') return undefined;
  const reference = parseCrushSessionReferenceDetails(summary.path);
  if (!reference) return undefined;
  return reference.managedProfileId
    ? `Managed profile \u00b7 ${reference.managedProfileId.slice(0, 8)}`
    : 'Native login';
}

export interface HadamardGuiOptions {
  workDir?: string;
  homeDir?: string;
  host?: string;
  port?: number;
  /** Test/embedding hook for the external CLI supervisor. */
  externalCliRuntimeManager?: ExternalCliRuntimeManager;
  configPath?: string;
  permissionMode?: HadamardPermissionMode;
  model?: string;
  resumeSessionId?: string;
  continueMostRecent?: boolean;
  /** Electron-only update bridge. Browser/dev launches receive a read-only unsupported state. */
  appUpdater?: AppUpdateController;
}

export interface HadamardGuiServer {
  url: string;
  /** Per-process secret required on every `/api/*` request (defeats other local processes / CSRF). */
  token: string;
  close(): Promise<void>;
}

interface GuiRunEvent {
  type: string;
  [key: string]: unknown;
}

interface PendingPermission {
  id: string;
  toolName: string;
  summary: string;
  input?: unknown;
  resolve: (outcome: {
    decision: 'allow' | 'always' | 'always-user' | 'deny';
    answers?: Record<string, string>;
  }) => void;
}

// RunRegistry — tracks every active agent run so the GUI can host concurrent
// runs (chat + future team/background) and the Monitor pane can show them live.
// Replaces the single foreground runAbort/eventSink singletons (plan phase 2).
type GuiRunKind = 'chat' | 'team' | 'background' | 'manager';

/** Compact "what happens next" projection of the session Goal for the composer banner. */
interface GuiGoalNext {
  kind: 'run' | 'replan' | 'stop';
  text: string;
  workItemId?: string;
  reason?: string;
}

/** Whether the Goal loop currently owns this session, and how the last one ended. */
interface GuiGoalLoopStatus {
  running: boolean;
  startedAt?: string;
  turns?: number;
  reason?: string;
  endedAt?: string;
}

class GuiRuntimeMutationConflictError extends Error {
  override readonly name = 'GuiRuntimeMutationConflictError';
}

interface GuiRunDescriptor {
  runId: string;
  clientRequestId?: string;
  kind: GuiRunKind;
  label: string;
  sessionId: string;
  model: string | null;
  startedAt: number;
  status: 'running' | 'done' | 'aborted' | 'error';
  toolCalls: number;
  tokenUsage: { input: number; output: number };
  currentTool?: string;
  lastText?: string;
  // Team runs only: live member/round state for the Monitor pane and the
  // conversation rail's Team Run tree (plan phase 4/5).
  team?: {
    mode: string;
    round: number;
    members: Array<{ id: string; model: string; status: string; role?: string; currentTool?: string; error?: string; toolCalls?: number; durationMs?: number }>;
    /** Fired graph/communication edges, in trigger order (Team Run tree structure). */
    edges?: Array<{ from: string; to: string; trigger: string; channel: string }>;
    incompleteReason?: string;
  };
}
interface GuiRunRecord {
  desc: GuiRunDescriptor;
  abort: AbortController;
  sink: (event: GuiRunEvent) => void;
  /** Bounded replay buffer used when the renderer reconnects after transport loss. */
  events?: Array<GuiRunEvent & { sequence: number }>;
}

interface GuiDurableIssueContext {
  targetPath: string;
  homeDir: string;
  storage: IssueStorageMode;
  issueId: string;
  issueNumber: number;
  sessionId: string;
  requestedProfile: string | null;
  bridgeConfigName: string | null;
  workerModel: string | null;
  permissionMode: HadamardPermissionMode;
  effort: string;
  systemPrompt: string;
  prompt: string;
}

const GUI_DURABLE_ISSUE_AGENT: AgentSpec<JsonValue | undefined, JsonValue> = Object.freeze({
  id: 'product:gui-issue-worker',
  name: 'GUI issue worker',
  instructions: 'Execute one persisted GUI issue dispatch through the compatibility runtime adapter.',
});

function parseDurableIssueContext(value: JsonValue | undefined): GuiDurableIssueContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Durable issue child context is missing or invalid.');
  }
  const record = value as Record<string, JsonValue>;
  const requiredString = (key: string): string => {
    const item = record[key];
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Durable issue child context.${key} must be a non-empty string.`);
    }
    return item;
  };
  const nullableString = (key: string): string | null => {
    const item = record[key];
    if (item === null || item === undefined) return null;
    if (typeof item !== 'string') throw new Error(`Durable issue child context.${key} is invalid.`);
    return item;
  };
  const storage = requiredString('storage');
  if (!isIssueStorageMode(storage)) throw new Error(`Invalid durable issue storage mode: ${storage}`);
  const permissionMode = requiredString('permissionMode');
  if (!['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'].includes(permissionMode)) {
    throw new Error(`Invalid durable issue permission mode: ${permissionMode}`);
  }
  const issueNumber = record.issueNumber;
  if (!Number.isSafeInteger(issueNumber) || Number(issueNumber) < 1) {
    throw new Error('Durable issue child context.issueNumber must be a positive safe integer.');
  }
  return {
    targetPath: requiredString('targetPath'),
    homeDir: requiredString('homeDir'),
    storage,
    issueId: requiredString('issueId'),
    issueNumber: Number(issueNumber),
    sessionId: requiredString('sessionId'),
    requestedProfile: nullableString('requestedProfile'),
    bridgeConfigName: nullableString('bridgeConfigName'),
    workerModel: nullableString('workerModel'),
    permissionMode: permissionMode as HadamardPermissionMode,
    effort: requiredString('effort'),
    systemPrompt: requiredString('systemPrompt'),
    prompt: requiredString('prompt'),
  };
}

function canonicalGuiUsage(value: unknown): Usage {
  const record = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const count = (key: string): number => {
    const candidate = record[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : 0;
  };
  const inputTokens = count('input_tokens');
  const outputTokens = count('output_tokens');
  const cacheReadTokens = count('cache_read_input_tokens') || count('prompt_cache_hit_tokens');
  const cacheWriteTokens = count('cache_creation_input_tokens');
  return {
    ...emptyUsage(),
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

interface GuiPreferences {
  theme: 'system' | 'light' | 'dark';
  density: 'comfortable' | 'compact';
  enterToSend: boolean;
  autoScroll: boolean;
  developerTools: boolean;
  showBranchInComposer: boolean;
  showProviderConfigsInComposer: boolean;
  showAgentProfilesInComposer: boolean;
  showRouterProfilesInComposer: boolean;
  /** §3.5: when off (or no default model configured), broken references fail loudly instead of silently falling back. */
  useDefaultModelAsFallback: boolean;
  /** §6-2: show built-in subagents (general-purpose, Explore) in the Agents panel Subagents group. Default off. */
  showBuiltInSubagents: boolean;
  /** Windows only. Ignored on Linux/macOS. */
  windowsTerminalShell: WindowsTerminalShellPreference;
  shortcuts: GuiShortcuts;
}

type GuiShortcutAction =
  | 'newChat'
  | 'cycleModel'
  | 'openReview'
  | 'openBrowser'
  | 'openFiles'
  | 'toggleTerminal'
  | 'openSettings'
  | 'takeScreenshot';

type GuiShortcuts = Record<GuiShortcutAction, string>;

const DEFAULT_GUI_SHORTCUTS: GuiShortcuts = {
  newChat: 'Mod+N',
  cycleModel: 'Mod+/',
  openReview: 'Mod+Shift+G',
  openBrowser: 'Mod+T',
  openFiles: 'Mod+P',
  toggleTerminal: 'Mod+Backquote',
  openSettings: 'Mod+,',
  takeScreenshot: 'Mod+Shift+S',
};

const DEFAULT_GUI_PREFERENCES: GuiPreferences = {
  theme: 'system',
  density: 'comfortable',
  enterToSend: true,
  autoScroll: true,
  developerTools: false,
  showBranchInComposer: true,
  showProviderConfigsInComposer: true,
  showAgentProfilesInComposer: true,
  showRouterProfilesInComposer: true,
  useDefaultModelAsFallback: true,
  showBuiltInSubagents: false,
  windowsTerminalShell: 'powershell',
  shortcuts: DEFAULT_GUI_SHORTCUTS,
};

function buildGuiSystemPrompt(
  workDir: string,
  settings: Pick<ProjectSettings, 'workMode' | 'customPrompt' | 'projectRules' | 'context'> = DEFAULT_PROJECT_SETTINGS,
  _hadamardHomeDir = path.join(os.homedir(), '.hadamard'),
  _projectWorkPaths = [workDir],
): string {
  let gitProbe = path.resolve(workDir);
  let isGit = false;
  while (true) {
    if (existsSync(path.join(gitProbe, '.git'))) { isGit = true; break; }
    const parent = path.dirname(gitProbe);
    if (parent === gitProbe) break;
    gitProbe = parent;
  }
  const base = (
    `You are Hadamard Agent, an interactive GUI agent. Working directory: ${workDir}\n\n` +
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
    `- NEVER update the git config.\n` +
    `- NEVER run destructive git commands unless the user explicitly requests them.\n` +
    `- NEVER skip hooks unless the user explicitly requests it.\n` +
    `- NEVER commit changes unless the user explicitly asks you to.\n\n` +
    `# Other\n` +
    `- NEVER create documentation files (*.md) unless explicitly requested.\n` +
    `- When in doubt, use TodoWrite to track progress.` +
    (settings.workMode === 'daily'
      ? `\n\n# Work mode: For daily work\n` +
        `- The user prefers an everyday-assistant style: reply in plain language, keep it concise, and minimize jargon, file paths, and raw code unless they ask for them.\n` +
        `- You are equally capable in this mode — only the presentation is less technical. Still use tools and do the real work; just summarize results in accessible terms.`
      : ``)
  );
  return appendProjectSettingsToPrompt(base, settings);
}

/** Read the raw request body as a string (for webhook filter matching). */
async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
}

function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'notebook_path', 'url', 'path']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  try {
    return JSON.stringify(record);
  } catch {
    return '';
  }
}

/**
 * Expand @<image-path> tokens into Anthropic image content blocks so the user
 * can attach screenshots/designs inline. Returns the string unchanged when no
 * image actually loads (the @tokens stay literal). Mirrors the TUI's
 * expandImageRefs — the @path route only (clipboard capture is platform-specific).
 */
function expandImageRefs(text: string, workDir: string): string | ContentBlockParam[] {
  const refs = text.match(/@([\w./\\-]+\.(?:png|jpe?g|gif|webp|bmp))/gi);
  if (!refs) return text;
  const blocks: ContentBlockParam[] = [];
  let cursor = 0;
  const seen = new Set<string>();
  let imagesAdded = 0;
  for (const ref of refs) {
    const raw = ref.slice(1); // strip @
    const resolved = path.resolve(workDir, raw);
    if (seen.has(resolved)) continue;
    let data: string;
    try {
      data = readFileSync(resolved).toString('base64');
    } catch {
      continue; // not readable — leave the @token in the text below
    }
    const at = text.indexOf(ref, cursor);
    if (at > cursor) blocks.push({ type: 'text', text: text.slice(cursor, at) });
    const ext = path.extname(raw).slice(1).toLowerCase();
    const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    cursor = at + ref.length;
    seen.add(resolved);
    imagesAdded++;
  }
  if (cursor < text.length) blocks.push({ type: 'text', text: text.slice(cursor) });
  return imagesAdded > 0 ? blocks : text;
}

function commandUsage(command: string): string {
  return interactiveCommandUsage(command);
}

function isEffort(value: unknown): value is HadamardEffort {
  return typeof value === 'string' && EFFORT_LEVELS.includes(value as HadamardEffort);
}

function readEnvFromSettings(raw: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (/^[A-Z0-9_]+$/.test(key) && typeof value === 'string') env[key] = value;
  }
  if (isPlainRecord(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  return env;
}

export function shouldShowDefaultModelOnboarding(
  raw: Record<string, unknown>,
  bridgeConfigCount: number,
): boolean {
  const env = readEnvFromSettings(raw);
  const settingsModelFields = [
    'HADAMARD_API_KEY',
    'HADAMARD_AUTH_TOKEN',
    'HADAMARD_BASE_URL',
    'HADAMARD_MODEL',
    'HADAMARD_DEFAULT_MIN_MODEL',
    'HADAMARD_DEFAULT_MEDIUM_MODEL',
    'HADAMARD_DEFAULT_MAX_MODEL',
  ];
  const hasSettingsModelConfig = settingsModelFields.some(key => Boolean(env[key]?.trim()));
  return !hasSettingsModelConfig && bridgeConfigCount === 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readGuiPreferences(raw: Record<string, unknown>): GuiPreferences {
  const source = isPlainRecord(raw.gui) ? raw.gui : {};
  const theme = source.theme === 'light' || source.theme === 'dark' ? source.theme : 'system';
  const density = source.density === 'compact' ? 'compact' : 'comfortable';
  const shortcutSource = isPlainRecord(source.shortcuts) ? source.shortcuts : {};
  const shortcuts = Object.fromEntries(
    Object.entries(DEFAULT_GUI_SHORTCUTS).map(([action, fallback]) => {
      const value = shortcutSource[action];
      return [action, typeof value === 'string' && value.length <= 64 ? value.trim() : fallback];
    }),
  ) as GuiShortcuts;
  return {
    theme,
    density,
    enterToSend: typeof source.enterToSend === 'boolean'
      ? source.enterToSend
      : DEFAULT_GUI_PREFERENCES.enterToSend,
    autoScroll: typeof source.autoScroll === 'boolean'
      ? source.autoScroll
      : DEFAULT_GUI_PREFERENCES.autoScroll,
    developerTools: typeof source.developerTools === 'boolean'
      ? source.developerTools
      : DEFAULT_GUI_PREFERENCES.developerTools,
    showBranchInComposer: typeof source.showBranchInComposer === 'boolean'
      ? source.showBranchInComposer
      : DEFAULT_GUI_PREFERENCES.showBranchInComposer,
    showProviderConfigsInComposer: typeof source.showProviderConfigsInComposer === 'boolean'
      ? source.showProviderConfigsInComposer
      : DEFAULT_GUI_PREFERENCES.showProviderConfigsInComposer,
    showAgentProfilesInComposer: typeof source.showAgentProfilesInComposer === 'boolean'
      ? source.showAgentProfilesInComposer
      : DEFAULT_GUI_PREFERENCES.showAgentProfilesInComposer,
    showRouterProfilesInComposer: typeof source.showRouterProfilesInComposer === 'boolean'
      ? source.showRouterProfilesInComposer
      : DEFAULT_GUI_PREFERENCES.showRouterProfilesInComposer,
    useDefaultModelAsFallback: typeof source.useDefaultModelAsFallback === 'boolean'
      ? source.useDefaultModelAsFallback
      : DEFAULT_GUI_PREFERENCES.useDefaultModelAsFallback,
    showBuiltInSubagents: typeof source.showBuiltInSubagents === 'boolean'
      ? source.showBuiltInSubagents
      : DEFAULT_GUI_PREFERENCES.showBuiltInSubagents,
    windowsTerminalShell: isWindowsTerminalShellPreference(source.windowsTerminalShell)
      ? source.windowsTerminalShell
      : DEFAULT_GUI_PREFERENCES.windowsTerminalShell,
    shortcuts,
  };
}

function normalizeFsPath(value: string): string {
  const resolved = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** Normalize pasted/picked workspace paths (quotes, file://, resolve) and require a directory. */
function normalizeWorkspacePathInput(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (/^file:/i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      throw new Error(`Invalid file URL: ${raw.trim()}`);
    }
  }
  if (!value) throw new Error('Missing project path');
  return path.resolve(value);
}

async function resolveWorkspaceDirectory(raw: string): Promise<string> {
  const resolved = normalizeWorkspacePathInput(raw);
  let st;
  try {
    st = await stat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Workspace does not exist: ${resolved}`);
    }
    throw error;
  }
  if (!st.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

interface StoredSessionFile {
  id: string;
  storageId: string;
  filePath: string;
  messageCount: number;
  runCount: number;
  title?: string;
  brief?: string;
  workDir?: string;
  kind?: SessionSummary['kind'];
  updatedAt?: string;
}

/** Manager and delegated-agent sessions have dedicated surfaces, never the chat list. */
function isVisibleChatSession(item: Pick<SessionSummary, 'kind'>): boolean {
  return item.kind !== 'manager' && item.kind !== 'agent';
}

function inferStoredSessionKind(
  explicitKind: unknown,
  metadata: Record<string, unknown>,
): SessionSummary['kind'] | undefined {
  const kindRaw = typeof explicitKind === 'string' ? explicitKind : metadata.__hadamardKind;
  if (
    kindRaw === 'manager'
    || kindRaw === 'worktree'
    || kindRaw === 'main'
    || kindRaw === 'agent'
  ) {
    return kindRaw;
  }
  return typeof metadata.__hadamardAgentDefinition === 'string' ? 'agent' : undefined;
}

function jsonStorageId(fileName: string): string | undefined {
  if (!fileName.endsWith('.json')) return undefined;
  try {
    return assertSafeStorageSegment(
      'session JSON storage id',
      fileName.slice(0, -'.json'.length),
    );
  } catch {
    return undefined;
  }
}

async function hasUnreadableAgentExecutionFiles(
  projectRoot: string,
  store: AgentExecutionStore,
): Promise<boolean> {
  const directory = path.join(projectRoot, 'agent-executions');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const rootExecutionId = jsonStorageId(file);
    if (!rootExecutionId) return true;
    try {
      if (!await store.getSnapshot(rootExecutionId)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function issueSessionFieldsFromMetadata(metadata: Record<string, unknown> | undefined): Partial<SessionSummary> {
  if (!metadata) return {};
  const issueId = typeof metadata.__hadamardIssueId === 'string' && metadata.__hadamardIssueId.trim()
    ? metadata.__hadamardIssueId.trim()
    : undefined;
  const rawNumber = metadata.__hadamardIssueNumber;
  const issueNumber = typeof rawNumber === 'number'
    ? rawNumber
    : typeof rawNumber === 'string' && Number.isFinite(Number(rawNumber))
      ? Number(rawNumber)
      : undefined;
  const issueKey = typeof metadata.__hadamardIssueKey === 'string' && metadata.__hadamardIssueKey.trim()
    ? metadata.__hadamardIssueKey.trim()
    : issueNumber !== undefined
      ? `ISS-${issueNumber}`
      : undefined;
  const agentProfile = typeof metadata.__hadamardAgentProfile === 'string' && metadata.__hadamardAgentProfile.trim()
    ? metadata.__hadamardAgentProfile.trim()
    : undefined;
  return {
    ...(issueId ? { issueId } : {}),
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(issueKey ? { issueKey } : {}),
    ...(agentProfile ? { agentProfile } : {}),
  };
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    const key = normalizeFsPath(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

async function listStoredSessionFiles(projectRoot: string): Promise<StoredSessionFile[]> {
  const sessionsDir = path.join(projectRoot, 'sessions');
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const sessions: StoredSessionFile[] = [];
  for (const file of files) {
    const storageId = jsonStorageId(file);
    if (!storageId) continue;
    const filePath = path.join(sessionsDir, file);
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      const metadata = isPlainRecord(raw) && isPlainRecord(raw.metadata) ? raw.metadata : {};
      const messages = isPlainRecord(raw) && Array.isArray(raw.messages) ? raw.messages : [];
      const runs = isPlainRecord(raw) && Array.isArray(raw.runs) ? raw.runs : [];
      const kind = inferStoredSessionKind(isPlainRecord(raw) ? raw.kind : undefined, metadata);
      const updatedAt = isPlainRecord(raw) && typeof raw.updatedAt === 'string'
        ? raw.updatedAt
        : (typeof metadata.__hadamardUpdatedAt === 'string' ? metadata.__hadamardUpdatedAt : '');
      const title = isPlainRecord(raw) && typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim()
        : undefined;
      const briefRaw = extractConversationBrief(messages as import('../provider/types.js').MessageParam[]);
      const brief = briefRaw ? truncateText(briefRaw, 100) : '';
      sessions.push({
        id: isPlainRecord(raw) && typeof raw.id === 'string' ? raw.id : storageId,
        storageId,
        filePath,
        messageCount: messages.length,
        runCount: runs.length,
        ...(title ? { title } : {}),
        ...(brief ? { brief } : {}),
        workDir: typeof metadata.__hadamardWorkDir === 'string' ? metadata.__hadamardWorkDir : undefined,
        updatedAt,
        ...(kind ? { kind } : {}),
      });
    } catch {
      // Ignore unreadable historical sessions while building GUI state.
    }
  }
  return sessions;
}

function storedJsonToSessionSummary(raw: unknown, archived = false): SessionSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const session = raw as {
    id?: unknown;
    title?: unknown;
    titleSource?: unknown;
    model?: unknown;
    metadata?: Record<string, unknown>;
    createdAt?: unknown;
    updatedAt?: unknown;
    lastRunAt?: unknown;
    lastActiveAt?: unknown;
    status?: unknown;
    tags?: unknown;
    messages?: unknown;
    runs?: unknown;
    kind?: unknown;
  };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const runs = Array.isArray(session.runs) ? session.runs : [];
  const runtimeRaw = session.metadata?.__hadamardRuntime;
  const configRaw = session.metadata?.__hadamardConfigName;
  const kind = inferStoredSessionKind(session.kind, session.metadata ?? {});
  const id = typeof session.id === 'string' ? session.id : '';
  if (!id) return null;
  return {
    ...issueSessionFieldsFromMetadata(session.metadata),
    id,
    title: typeof session.title === 'string' ? session.title : 'Untitled',
    titleSource: session.titleSource === 'manual' ? 'manual' : 'auto',
    model: typeof session.model === 'string' ? session.model : 'unknown',
    runtime: typeof runtimeRaw === 'string' && runtimeRaw.trim() ? runtimeRaw.trim() : 'hadamard',
    configName: typeof configRaw === 'string' && configRaw.trim() ? configRaw.trim() : null,
    createdAt: typeof session.createdAt === 'string' ? session.createdAt : '',
    updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : '',
    lastRunAt: typeof session.lastRunAt === 'string' ? session.lastRunAt : undefined,
    lastActiveAt: typeof session.lastActiveAt === 'string' ? session.lastActiveAt : undefined,
    status: session.status === 'idle' || session.status === 'closed' ? session.status : 'active',
    tags: Array.isArray(session.tags) ? session.tags.filter((t): t is string => typeof t === 'string') : [],
    preview: truncateText(extractPreviewFromMessages(messages as import('../provider/types.js').MessageParam[]), 160),
    brief: truncateText(extractConversationBrief(messages as import('../provider/types.js').MessageParam[]), 100),
    messageCount: messages.length,
    runCount: runs.length,
    archived,
    ...(kind ? { kind } : {}),
  };
}

async function listArchivedSessionsForWorkDir(
  projectWorkDir: string,
  homeDir: string,
): Promise<SessionSummary[]> {
  const projectRoot = getHadamardProjectSessionDirectory(projectWorkDir, homeDir);
  const archiveDir = path.join(projectRoot, 'archive');
  const sessions: SessionSummary[] = [];
  let files: string[];
  try {
    files = await readdir(archiveDir);
  } catch {
    return [];
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(archiveDir, file), 'utf8')) as unknown;
      const summary = storedJsonToSessionSummary(raw, true);
      if (summary && !isEmptyUserSessionSummary(summary) && isVisibleChatSession(summary)) {
        sessions.push(summary);
      }
    } catch {
      // Skip unreadable archived sessions.
    }
  }
  sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return sessions;
}

async function cleanupStoredEmptySessions(
  projectRoots: string[],
  protectedSessionIds: ReadonlySet<string>,
): Promise<number> {
  let deleted = 0;
  for (const projectRoot of projectRoots) {
    const runtimeProtectedSessionIds = new Set(protectedSessionIds);
    let executionSnapshots: Awaited<ReturnType<AgentExecutionStore['listSnapshots']>>;
    let backgroundTasks: Awaited<ReturnType<BackgroundTaskStore['list']>>;
    try {
      const executionStore = new AgentExecutionStore(projectRoot);
      if (await hasUnreadableAgentExecutionFiles(projectRoot, executionStore)) {
        console.warn(
          `Skipping empty-session cleanup for ${projectRoot}: unreadable Agent execution state`,
        );
        continue;
      }
      [executionSnapshots, backgroundTasks] = await Promise.all([
        executionStore.listSnapshots(),
        new BackgroundTaskStore(projectRoot).list(),
      ]);
    } catch (error) {
      console.warn(
        `Skipping empty-session cleanup for ${projectRoot}: ${(error as Error).message}`,
      );
      continue;
    }
    for (const snapshot of executionSnapshots) {
      const active = snapshot.nodes.some(node =>
        node.agentStatus === 'pending_init'
        || node.agentStatus === 'running'
        || node.threadStatus === 'active');
      if (!active) continue;
      for (const node of snapshot.nodes) {
        runtimeProtectedSessionIds.add(node.sessionId);
      }
      for (const edge of snapshot.edges) {
        if (edge.sourceSessionId) runtimeProtectedSessionIds.add(edge.sourceSessionId);
        if (edge.targetSessionId) runtimeProtectedSessionIds.add(edge.targetSessionId);
      }
    }
    for (const task of backgroundTasks) {
      if (task.status !== 'queued' && task.status !== 'running') continue;
      if (task.parentSessionId) runtimeProtectedSessionIds.add(task.parentSessionId);
      if (task.sessionId) runtimeProtectedSessionIds.add(task.sessionId);
    }
    for (const item of await listStoredSessionFiles(projectRoot)) {
      if (
        runtimeProtectedSessionIds.has(item.id)
        || runtimeProtectedSessionIds.has(item.storageId)
        || item.kind === 'agent'
        || item.messageCount > 0
        || item.runCount > 0
      ) continue;
      await rm(item.filePath, { force: true });
      await rm(path.join(projectRoot, 'sessions', '.checkpoints', item.storageId), {
        recursive: true,
        force: true,
      });
      deleted += 1;
    }
  }
  return deleted;
}

async function collectSessionStoreRoots(homeDir: string, currentSessionDirectory: string): Promise<string[]> {
  // Hot paths (state refresh / project open) must not readdir every hash under
  // ~/.hadamard/projects — bench runs leave hundreds of dirs and dominate latency.
  void homeDir;
  return uniquePaths([currentSessionDirectory]);
}

type SidebarRecentSession = {
  id: string;
  title: string;
  brief?: string;
  updatedAt: string;
};

type SidebarUnregisteredSession = SidebarRecentSession & {
  projectPath: string;
};

async function listUnregisteredGuiSessions(
  homeDir: string,
  registeredProjectPaths: readonly string[],
  limit = 12,
): Promise<SidebarUnregisteredSession[]> {
  const registeredKeys = new Set(registeredProjectPaths.map(normalizeFsPath));
  const candidates: SidebarUnregisteredSession[] = [];
  for (const item of await discoverProjectSessions(homeDir)) {
    const summary = item.summary;
    if (
      isEmptyUserSessionSummary(summary)
      || summary.kind === 'manager'
      || summary.kind === 'agent'
      || registeredKeys.has(normalizeFsPath(item.projectPath))
    ) continue;
    candidates.push({
      id: summary.id,
      title: summary.title || summary.id,
      ...(summary.brief ? { brief: summary.brief } : {}),
      updatedAt: summary.updatedAt || '',
      projectPath: item.projectPath,
    });
  }
  return candidates.slice(0, Math.max(0, limit));
}

async function projectSessionOverview(
  workDir: string,
  homeDir: string,
  recentLimit = 3,
  workPaths: string[] = [workDir],
): Promise<{ count: number; lastUsedAt: string; recentSessions: SidebarRecentSession[] }> {
  const projectRoot = getHadamardProjectSessionDirectory(workDir, homeDir);
  const workKeys = new Set(workPaths.map(normalizeFsPath));
  let count = 0;
  let lastUsedAt = '';
  const maxIso = (a: string, b: string) => (!a ? b : !b ? a : (a > b ? a : b));
  const candidates: SidebarRecentSession[] = [];
  // Single directory pass — previously stats + recents each readdir+parsed every JSON.
  for (const item of await listStoredSessionFiles(projectRoot)) {
    if ((item.messageCount === 0 && item.runCount === 0) || !isVisibleChatSession(item)) continue;
    if (item.workDir && !workKeys.has(normalizeFsPath(item.workDir))) continue;
    count += 1;
    lastUsedAt = maxIso(lastUsedAt, item.updatedAt || '');
    candidates.push({
      id: item.id,
      title: item.title || item.id,
      ...(item.brief ? { brief: item.brief } : {}),
      updatedAt: item.updatedAt || '',
    });
  }
  candidates.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return {
    count,
    lastUsedAt,
    recentSessions: candidates.slice(0, Math.max(0, recentLimit)),
  };
}

// --- Project plan (plan/UI_PLAN §4.2): a light per-workspace plan.json. ---
// Stored at ~/.hadamard/projects/<hash>/plan.json. Shared read/write helpers
// live in src/manager/projectManager.ts (the Manager's PlanWrite tool writes
// the same file); the GUI delegates so both stay schema-compatible.
type ProjectPlan = import('../manager/projectManager.js').ProjectPlan;

const readProjectPlan = readProjectPlanFile;
const writeProjectPlan = writeProjectPlanFile;

async function listKnownProjects(homeDir: string, currentWorkDir: string) {
  const current = path.resolve(currentWorkDir);
  const projects = new Map<string, {
    name: string;
    path: string;
    workPaths: string[];
    activeWorkPath: string;
    sessionCount: number;
    active: boolean;
    pinned: boolean;
    lastUsedAt: string;
    note: string;
    status: ProjectStatus;
    recentSessions: SidebarRecentSession[];
    issueCounts: { total: number; open: number; review: number; closed: number };
  }>();
  const maxIso = (a: string, b: string) => (!a ? b : !b ? a : (a > b ? a : b));
  const addProject = (
    projectPath: string,
    sessionCount = 0,
    lastUsedAt = '',
    pinned = false,
    workPaths: string[] = [projectPath],
    activeWorkPath = projectPath,
  ) => {
    const resolved = path.resolve(projectPath);
    const resolvedWorkPaths = [...new Set(workPaths.map(candidate => path.resolve(candidate)))];
    const resolvedActiveWorkPath = resolvedWorkPaths.find(candidate =>
      normalizeFsPath(candidate) === normalizeFsPath(activeWorkPath)
    ) ?? resolved;
    const key = normalizeFsPath(resolved);
    const existing = projects.get(key);
    projects.set(key, {
      name: path.basename(resolved) || resolved,
      path: resolved,
      workPaths: existing?.workPaths ?? resolvedWorkPaths,
      activeWorkPath: normalizeFsPath(current) === normalizeFsPath(resolvedActiveWorkPath)
        ? current
        : (existing?.activeWorkPath ?? resolvedActiveWorkPath),
      sessionCount: Math.max(existing?.sessionCount ?? 0, sessionCount),
      active: resolvedWorkPaths.some(candidate => normalizeFsPath(candidate) === normalizeFsPath(current)),
      pinned: Boolean(existing?.pinned || pinned),
      lastUsedAt: maxIso(existing?.lastUsedAt ?? '', lastUsedAt),
      note: existing?.note ?? '',
      status: existing?.status ?? 'not_started',
      recentSessions: existing?.recentSessions ?? [],
      issueCounts: existing?.issueCounts ?? { total: 0, open: 0, review: 0, closed: 0 },
    });
  };

  // Only remembered + current workspaces — never scan every ~/.hadamard/projects/*
  // hash (bench pollution made project open O(all historical dirs)).
  // Do not invent a project from process.cwd() / install dir: first launch should
  // show an empty Projects list until the user opens or creates one.
  const registry = await readWorkspaceRegistry(homeDir);
  const currentProject = findWorkspaceProject(registry, current);
  if (currentProject) {
    addProject(
      currentProject.path,
      0,
      currentProject.lastOpenedAt,
      currentProject.pinned === true,
      workspaceWorkPaths(currentProject),
      current,
    );
  }
  await Promise.all(registry.map(async (entry) => {
    if (!(await pathExists(entry.path))) return;
    addProject(
      entry.path,
      0,
      entry.lastOpenedAt,
      entry.pinned === true,
      workspaceWorkPaths(entry),
      workspaceActiveWorkPath(entry),
    );
  }));

  const rows = [...projects.values()];
  await Promise.all(rows.map(async (project) => {
    await migrateLegacyHadamardProjectData({
      homeDir,
      workDir: project.path,
      targetDirectory: getHadamardProjectSessionDirectory(project.path, homeDir),
    }).catch(error => {
      console.warn(
        `Could not migrate legacy project data for ${project.path}: ${(error as Error).message}`,
      );
    });
    const [note, overview, meta] = await Promise.all([
      readWorkspaceNote(project.path, homeDir),
      projectSessionOverview(project.path, homeDir, 3, project.workPaths),
      readProjectMeta(project.path, homeDir),
    ]);
    project.note = note;
    project.sessionCount = Math.max(project.sessionCount, overview.count);
    project.lastUsedAt = maxIso(project.lastUsedAt, overview.lastUsedAt);
    project.status = meta.status;
    project.recentSessions = overview.recentSessions;
    const issues = await listProjectIssues(
      project.path,
      homeDir,
      isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home',
    ).catch(() => []);
    project.issueCounts = {
      total: issues.length,
      open: issues.filter(issue => issue.status !== 'done' && issue.status !== 'cancelled').length,
      review: issues.filter(issue => issue.status === 'in_review').length,
      closed: issues.filter(issue => issue.status === 'done' || issue.status === 'cancelled').length,
    };
  }));
  return rows.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.active !== right.active) return left.active ? -1 : 1;
    const leftTs = Date.parse(left.lastUsedAt || '') || 0;
    const rightTs = Date.parse(right.lastUsedAt || '') || 0;
    if (leftTs !== rightTs) return rightTs - leftTs;
    return left.name.localeCompare(right.name);
  });
}

function openPathInSystem(targetPath: string): void {
  const command = process.platform === 'win32'
    ? 'explorer.exe'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const child = spawn(command, [targetPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

/**
 * Open a native folder-picker dialog and return the selected directory path,
 * or null if the user cancelled.
 *
 * Prefer Electron's Common Item Dialog (modern explorer-style picker) when
 * running inside the desktop app. Outside Electron, fall back to each OS's
 * built-in picker — on Windows that is IFileOpenDialog (same modern UI), not
 * the legacy FolderBrowserDialog tree.
 */
const execFileAsync = promisify(execFile);

async function pickFolderViaElectron(): Promise<string | null | undefined> {
  if (!process.versions.electron) return undefined;
  try {
    const { BrowserWindow, dialog } = await import('electron');
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Select workspace folder',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  } catch {
    // Electron module unavailable or dialog failed — fall through to OS picker.
    return undefined;
  }
}

/** Temporarily hide Electron windows so they are not included in screenshots. */
async function withHiddenGuiWindows<T>(fn: () => Promise<T>): Promise<T> {
  if (!process.versions.electron) return fn();
  try {
    const { BrowserWindow } = await import('electron');
    const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());
    const snapshot = windows.map(win => ({
      win,
      wasVisible: win.isVisible(),
      opacity: typeof win.getOpacity === 'function' ? win.getOpacity() : 1,
    }));
    for (const { win } of snapshot) {
      try {
        if (typeof win.setOpacity === 'function') win.setOpacity(0);
        else win.hide();
      } catch {
        try { win.hide(); } catch { /* ignore */ }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 160));
    try {
      return await fn();
    } finally {
      for (const { win, wasVisible, opacity } of snapshot) {
        if (win.isDestroyed()) continue;
        try {
          if (typeof win.setOpacity === 'function') win.setOpacity(opacity || 1);
          if (wasVisible) win.show();
        } catch { /* ignore */ }
      }
    }
  } catch {
    return fn();
  }
}

/** Windows Vista+ IFileOpenDialog (explorer-style), via PowerShell Add-Type. */
function windowsModernFolderPickerScript(): string {
  // Keep the C# compact: IFileDialog vtable must match the COM layout exactly.
  // Guard Add-Type so a second pick in the same PowerShell process does not fail.
  return `
$ErrorActionPreference = 'Stop'
if (-not ('HadamardFolderPicker' -as [type])) {
$code = @'
using System;
using System.Runtime.InteropServices;
public static class HadamardFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialogRCW {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  const uint FOS_PICKFOLDERS = 0x20;
  const uint FOS_FORCEFILESYSTEM = 0x40;
  const uint SIGDN_FILESYSPATH = 0x80058000;
  public static string Pick(string title) {
    var dialog = (IFileDialog)new FileOpenDialogRCW();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
    if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
    if (dialog.Show(IntPtr.Zero) != 0) return null;
    IShellItem item;
    dialog.GetResult(out item);
    IntPtr ptr;
    item.GetDisplayName(SIGDN_FILESYSPATH, out ptr);
    string path = Marshal.PtrToStringUni(ptr);
    Marshal.FreeCoTaskMem(ptr);
    return path;
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp -ErrorAction Stop
}
$path = [HadamardFolderPicker]::Pick('Select workspace folder')
if ($path) { Write-Output $path }
`;
}

async function pickFolder(): Promise<string | null> {
  const electronPick = await pickFolderViaElectron();
  if (electronPick !== undefined) return electronPick;

  try {
    if (process.platform === 'win32') {
      // Modern Common Item Dialog (same UI as Electron / Explorer "选择文件夹").
      // NB: use Write-Output WITHOUT -NoNewline — Windows PowerShell 5.1's
      // Write-Output has no -NoNewline parameter; a trailing newline is trimmed.
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', windowsModernFolderPickerScript()],
        { encoding: 'utf-8', windowsHide: true },
      );
      const trimmed = stdout.trim();
      return trimmed ? trimmed : null;
    }
    if (process.platform === 'darwin') {
      // osascript — choose folder.
      const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select workspace folder")'], { encoding: 'utf-8' });
      const trimmed = stdout.trim();
      return trimmed ? trimmed : null;
    }
    // Linux: prefer zenity, fall back to kdialog.
    try {
      const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=Select workspace folder'], { encoding: 'utf-8' });
      const trimmed = stdout.trim();
      return trimmed ? trimmed : null;
    } catch {
      const { stdout } = await execFileAsync('kdialog', ['--getexistingdirectory', '.', '--title=Select workspace folder'], { encoding: 'utf-8' });
      const trimmed = stdout.trim();
      return trimmed ? trimmed : null;
    }
  } catch {
    // User cancelled, or the dialog tool isn't installed — no selection.
    return null;
  }
}

export type BrowseEntryKind = 'drive' | 'folder' | 'file';
export type BrowseEntry = { name: string; path: string; kind: BrowseEntryKind; hidden?: boolean };
export type BrowseDirectoryResult = {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
};

function isWindowsDriveRoot(value: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(value.replace(/\\/g, '/'));
}

async function listWindowsDrives(): Promise<BrowseEntry[]> {
  const drives: BrowseEntry[] = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const drivePath = `${letter}:\\`;
    try {
      await access(drivePath);
      drives.push({ name: `${letter}:`, path: drivePath, kind: 'drive' });
    } catch {
      // drive letter not mounted
    }
  }
  return drives;
}

function browseParentPath(resolved: string): string | null {
  if (process.platform === 'win32' && isWindowsDriveRoot(resolved)) {
    return '';
  }
  const parent = path.dirname(resolved);
  if (parent === resolved) return null;
  return parent;
}

/** List folders for the in-app workspace browser (GET /api/browse). */
export async function browseDirectory(requestPath?: string): Promise<BrowseDirectoryResult> {
  const trimmed = requestPath?.trim() ?? '';
  if (!trimmed) {
    if (process.platform === 'win32') {
      return { path: '', parent: null, entries: await listWindowsDrives() };
    }
    const home = os.homedir();
    return { path: '', parent: null, entries: [{ name: path.basename(home) || home, path: home, kind: 'folder' }] };
  }

  const resolved = path.resolve(trimmed);
  let stats;
  try {
    stats = await stat(resolved);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') throw new Error(`Folder not found: ${resolved}`);
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  const parent = browseParentPath(resolved);
  const entries: BrowseEntry[] = [];
  if (parent !== null) {
    entries.push({ name: '..', path: parent, kind: 'folder' });
  }

  const children = await readdir(resolved, { withFileTypes: true });
  for (const entry of children) {
    if (!entry.isDirectory()) continue;
    entries.push({
      name: entry.name,
      path: path.join(resolved, entry.name),
      kind: 'folder',
    });
  }
  entries.sort((left, right) => {
    if (left.name === '..') return -1;
    if (right.name === '..') return 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });

  return { path: resolved, parent, entries };
}

/** List folders + files for the conversation Files panel. */
export async function listWorkspaceFiles(requestPath?: string, fallbackRoot?: string): Promise<BrowseDirectoryResult> {
  const trimmed = requestPath?.trim() || fallbackRoot?.trim() || '';
  if (!trimmed) {
    throw new Error('No workspace path');
  }
  const resolved = path.resolve(trimmed);
  let stats;
  try {
    stats = await stat(resolved);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') throw new Error(`Folder not found: ${resolved}`);
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  const parent = browseParentPath(resolved);
  const entries: BrowseEntry[] = [];
  const children = await readdir(resolved, { withFileTypes: true });
  for (const entry of children) {
    if (entry.name === '.' || entry.name === '..') continue;
    entries.push({
      name: entry.name,
      path: path.join(resolved, entry.name),
      kind: entry.isDirectory() ? 'folder' : 'file',
      ...(entry.name.startsWith('.') ? { hidden: true } : {}),
    });
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
  return { path: resolved, parent, entries };
}

function sessionView(session: AgentSession | undefined) {
  if (!session) return null;
  return {
    ...issueSessionFieldsFromMetadata(session.metadata),
    id: session.id,
    title: session.title,
    model: session.model,
    contextWindowTokens: readSessionContextWindow(session.metadata) ?? null,
    messages: session.messages.length,
    permissionContext: session.permissionContext,
  };
}

/**
 * Flatten a stored conversation into the same event shapes the live stream emits,
 * so the client can replay history through its normal render path when a chat is
 * opened or resumed.
 */
function renderableHistory(session: AgentSession): GuiRunEvent[] {
  return buildSessionTranscriptEvents(session.messages);
}

/** Flatten a manager session into panel rows (user/assistant/tool), newest capped. */
function managerPanelTranscript(session: AgentSession, limit = 48): Array<{ kind: string; text: string }> {
  const items: Array<{ kind: string; text: string }> = [];
  for (const event of renderableHistory(session)) {
    if (event.type === 'user') items.push({ kind: 'user', text: typeof event.text === 'string' ? event.text : '' });
    else if (event.type === 'assistant') items.push({ kind: 'assistant', text: typeof event.text === 'string' ? event.text : '' });
    else if (event.type === 'tool') items.push({ kind: 'tool', text: `manager · ${typeof event.name === 'string' ? event.name : 'tool'}` });
  }
  return items.slice(-limit);
}

/**
 * Resolve a team definition by name (project → personal → built-in presets)
 * and fill `model: ''` placeholders with the session model. Replaces the old
 * GUI-local buildDefaultTeam — built-ins now live in
 * BUILT_IN_TEAM_DEFINITIONS (src/team/teamDefinitions.ts) shared by all
 * surfaces.
 */
function resolveTeamDefinition(name: string, workDir: string, model: string): TeamDefinition | undefined {
  const loaded = loadTeamDefinition(name, workDir);
  if (!loaded) return undefined;
  return instantiateTeamDefinition(loaded.definition, model);
}

async function listenWithFallback(
  server: ReturnType<typeof createServer>,
  host: string,
  startPort: number,
  attempts = 50,
): Promise<number> {
  const tryListen = async (candidate: number): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, host);
    });
    if (candidate === 0) {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve an ephemeral GUI listen port.');
      }
      return address.port;
    }
    return candidate;
  };

  if (startPort <= 0) {
    return tryListen(0);
  }

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = startPort + offset;
    try {
      return await tryListen(candidate);
    } catch (error) {
      // EACCES happens on Windows when a candidate falls in an excluded port range.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
      if (code === 'EACCES') {
        // Excluded ranges are contiguous; skip ahead instead of probing each port.
        offset += 24;
      }
    }
  }

  // Last resort: ask the OS for an ephemeral port.
  try {
    return await tryListen(0);
  } catch {
    throw new Error(`No free port found near ${startPort} (tried ${attempts} candidates).`);
  }
}

export async function startHadamardGuiServer(options: HadamardGuiOptions = {}): Promise<HadamardGuiServer> {
  const explicitStartupWorkDir = options.workDir !== undefined && String(options.workDir).trim() !== '';
  let workDir = path.resolve(options.workDir ?? process.cwd());
  const host = options.host ?? '127.0.0.1';
  const normalizedHost = host.trim().toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalizedHost !== 'localhost' && normalizedHost !== '::1' && normalizedHost !== '127.0.0.1') {
    throw new Error(
      'The Hadamard GUI may bind only to localhost, 127.0.0.1, or ::1 because its browser token grants local runtime control.',
    );
  }
  const urlHost = normalizedHost.includes(':') ? `[${normalizedHost}]` : host;
  const port = options.port ?? DEFAULT_PORT;
  const permissionMode: HadamardPermissionMode = options.permissionMode ?? 'bypassPermissions';
  const authToken = randomBytes(32).toString('hex');
  const appUpdater = options.appUpdater ?? createUnsupportedAppUpdateController(
    readPackageVersion(import.meta.url),
    'Automatic updates are available only in a packaged Hadamard desktop app.',
  );
  let projectSettings: ProjectSettings = { ...DEFAULT_PROJECT_SETTINGS };
  let systemPrompt = buildGuiSystemPrompt(workDir, projectSettings);
  let guiHomeOverride: string | undefined;
  const currentHomeInput = () => guiHomeOverride ?? options.homeDir;
  const pointerHomeDir = () => {
    if (!options.homeDir) return os.homedir();
    const normalized = path.normalize(options.homeDir);
    return path.basename(normalized).toLowerCase() === '.hadamard'
      ? path.dirname(normalized)
      : normalized;
  };
  const externalCliConfigPaths = {
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
  };
  const resolveGuiHomeDir = () =>
    guiHomeOverride
      ? resolveHadamardHome(guiHomeOverride, { inputKind: 'dataRoot' })
      : resolveHadamardHome(options.homeDir);
  let projectPrimaryPath = workDir;
  let projectRegisteredWorkPaths = [workDir];
  const refreshProjectPrimaryPath = async (
    candidateWorkPath = workDir,
    homeDir = resolveGuiHomeDir(),
  ): Promise<string> => {
    const registered = findWorkspaceProject(
      await readWorkspaceRegistry(homeDir),
      candidateWorkPath,
    );
    projectPrimaryPath = registered?.path ?? path.resolve(candidateWorkPath);
    projectRegisteredWorkPaths = registered ? workspaceWorkPaths(registered) : [projectPrimaryPath];
    return projectPrimaryPath;
  };
  await refreshProjectPrimaryPath();
  const migratedProjectData = new Set<string>();
  const ensureProjectDataMigrated = async (
    projectPath: string,
    homeDir = resolveGuiHomeDir(),
  ): Promise<string> => {
    const targetDirectory = getHadamardProjectSessionDirectory(projectPath, homeDir);
    const key = normalizeFsPath(targetDirectory);
    if (!migratedProjectData.has(key)) {
      try {
        const summary = await migrateLegacyHadamardProjectData({
          homeDir,
          workDir: projectPath,
          targetDirectory,
        });
        migratedProjectData.add(key);
        if (summary.retainedUnassignedArtifacts.length > 0) {
          console.warn(
            `Legacy project data retained without automatic ownership for ${projectPath}: ` +
            summary.retainedUnassignedArtifacts.join(', '),
          );
        }
      } catch (error) {
        console.warn(
          `Could not migrate legacy project data for ${projectPath}: ${(error as Error).message}`,
        );
      }
    }
    return targetDirectory;
  };

  try {
    if (options.configPath) await loadJsonConfigFile(options.configPath);
    else await loadDefaultHadamardSettings({ homeDir: currentHomeInput() });
  } catch {
    // Missing local config is fine; env vars may carry credentials.
  }

  try {
    projectSettings = await readProjectSettings(workDir, resolveGuiHomeDir());
    systemPrompt = buildGuiSystemPrompt(workDir, projectSettings, resolveGuiHomeDir(), projectRegisteredWorkPaths);
  } catch {
    // Keep defaults when settings cannot be read.
  }

  // Plan mode tools (EnterPlanMode / ExitPlanMode) give the agent a structured
  // research-then-propose flow. onPlanModeChange flips the session into plan
  // permission mode so mutating tools are blocked while the agent researches;
  // the holder is assigned after the session + approver exist.
  let applyPlanPermission: (() => Promise<void>) | null = null;
  // Terminal engine (plan phase 3). Declared here (before buildTools) so the
  // TerminalSnapshot vision tool (plan phase 6) can close over it at build time.
  const terminalManager = new TerminalManager();
  let terminalCapable = false;
  let managedPluginSettings: Record<string, unknown> = {};
  const rebuildTools = async () => {
    const base = [
      ...createHadamardCoreTools({
        cwd: workDir,
        onPlanModeChange: async (mode) => { if (mode === 'plan') await applyPlanPermission?.(); },
      }),
      ...createTerminalVisionTools(terminalManager),
    ];
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    }).catch(() => undefined);
    if (!store) {
      tools = base;
      managedPluginSettings = {};
      return;
    }
    tools = base;
    managedPluginSettings = store.raw;
  };
  let tools = [
    ...createHadamardCoreTools({
      cwd: workDir,
      onPlanModeChange: async (mode) => { if (mode === 'plan') await applyPlanPermission?.(); },
    }),
    ...createTerminalVisionTools(terminalManager),
  ];
  await rebuildTools();
  const createCleanSdk = async () => {
    const externalSkillPreferences = await readHadamardExternalSkillPreferences({
      hadamardHomeDir: resolveGuiHomeDir(),
      workDir,
    });
    return createAgentSdk({
      ...(currentHomeInput() ? { homeDir: currentHomeInput() } : {}),
      workDir,
      sessionDirectory: getHadamardProjectSessionDirectory(projectPrimaryPath, resolveGuiHomeDir()),
      tools,
      managedPlugins: managedPluginSettings,
      permissionMode,
      externalSkills: externalSkillPreferencesToRuntimeOptions(externalSkillPreferences),
      ...(options.model ? { model: options.model } : {}),
    });
  };
  // Credential-tolerant start: if no API key is configured (e.g. first run
  // before the user enters one in Settings), boot the HTTP server anyway so the
  // GUI can show a "needs credentials" hint instead of Fatal-quitting. The SDK
  // + session are created once the user saves a key (saveSettings → reloadSdk).
  let needsCredentials = false;
  let sdk: HadamardAgentClient | null;
  let toolMetadata: Awaited<ReturnType<HadamardAgentClient['listToolMetadata']>> = [];
  let session: AgentSession;
  let serverSessionResumeQueue: Promise<void> = Promise.resolve();
  function enqueueServerSessionResume<T>(operation: () => Promise<T>): Promise<T> {
    const pending = serverSessionResumeQueue.then(operation);
    serverSessionResumeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  let credentiallessSessionStore = new SessionStore(
    await ensureProjectDataMigrated(projectPrimaryPath),
  );
  const unavailableWithoutHadamardCredential = (): never => {
    throw new Error('This operation requires a configured Hadamard provider credential.');
  };
  let credentiallessBindings: ConstructorParameters<typeof AgentSession>[0];
  const hydrateCredentiallessSession = (stored: StoredSession): AgentSession =>
    new AgentSession(credentiallessBindings, credentiallessSessionStore, stored);
  const updateCredentiallessSession = async (
    current: AgentSession,
    mutate: (stored: StoredSession) => void,
  ): Promise<StoredSession> => {
    const stored = current.snapshot();
    mutate(stored);
    stored.updatedAt = new Date().toISOString();
    await credentiallessSessionStore.save(stored);
    return stored;
  };
  credentiallessBindings = {
    runSession: async () => unavailableWithoutHadamardCredential(),
    streamSession: () => unavailableWithoutHadamardCredential(),
    runSkillOnSession: async () => unavailableWithoutHadamardCredential(),
    streamSkillOnSession: () => unavailableWithoutHadamardCredential(),
    runDream: async () => unavailableWithoutHadamardCredential(),
    maybeAutoDream: async () => unavailableWithoutHadamardCredential(),
    getDreamState: async () => unavailableWithoutHadamardCredential(),
    compactSession: async () => unavailableWithoutHadamardCredential(),
    getCompactState: async () => unavailableWithoutHadamardCredential(),
    getAgentContinuity: async () => unavailableWithoutHadamardCredential(),
    setRuntimeHooks: () => undefined,
    clearRuntimeHooks: () => undefined,
    setModel: (current, model) => updateCredentiallessSession(current, stored => {
      stored.model = model;
    }),
    setRuntimePermissionContext: (current, context) =>
      updateCredentiallessSession(current, stored => {
        stored.metadata[HADAMARD_SESSION_PERMISSION_STATE_KEY] =
          serializeHadamardSessionPermissionState({
            mode: context.mode,
            permissions: context.permissions ?? [],
          });
      }),
    clearRuntimePermissionContext: current => updateCredentiallessSession(current, stored => {
      delete stored.metadata[HADAMARD_SESSION_PERMISSION_STATE_KEY];
    }),
    hydrate: hydrateCredentiallessSession,
    saveCheckpoint: (current, label) => credentiallessSessionStore.saveCheckpoint(current.id, label),
    restoreCheckpoint: async () => unavailableWithoutHadamardCredential(),
    listCheckpoints: current => credentiallessSessionStore.listCheckpoints(current.id),
    deleteCheckpoint: (current, checkpointId) =>
      credentiallessSessionStore.deleteCheckpoint(current.id, checkpointId),
  };
  const createCredentiallessSession = async (): Promise<AgentSession> => {
    if (options.resumeSessionId) {
      const requested = await credentiallessSessionStore.load(options.resumeSessionId);
      if (isEmptyUserStoredSession(requested)) {
        await credentiallessSessionStore.delete(requested.id).catch(() => undefined);
        throw new Error(`Session '${requested.id}' is empty and cannot be resumed.`);
      }
      return hydrateCredentiallessSession(requested);
    }
    if (options.continueMostRecent) {
      const mostRecent = (await credentiallessSessionStore.list())
        .find(item => !isEmptyUserSessionSummary(item));
      if (mostRecent) {
        return hydrateCredentiallessSession(
          await credentiallessSessionStore.load(mostRecent.id),
        );
      }
    }
    return hydrateCredentiallessSession(await credentiallessSessionStore.create({
      title: 'External CLI chat',
      model: options.model ?? 'external-cli',
      metadata: { __hadamardWorkDir: workDir },
    }));
  };
  const durableIssueResources = new Map<string, {
    coordinator: DurableIssueCoordinator;
    storage: SqliteStorageV2;
  }>();
  const durableIssueResourcePending = new Map<string, Promise<{
    coordinator: DurableIssueCoordinator;
    storage: SqliteStorageV2;
  }>>();
  const durableIssueSinks = new Map<string, (event: GuiRunEvent) => void>();
  const durableIssueReported = new Set<string>();
  try {
    const createdSdk = await createCleanSdk();
    sdk = createdSdk;
    toolMetadata = await createdSdk.listToolMetadata();
    if (options.resumeSessionId) {
      const requested = (await createdSdk.sessions.list())
        .find(item => item.id === options.resumeSessionId);
      if (requested && isEmptyUserSessionSummary(requested)) {
        await createdSdk.sessions.delete(requested.id).catch(() => undefined);
        await createdSdk.close().catch(() => undefined);
        throw new Error(`Session '${requested.id}' is empty and cannot be resumed.`);
      }
    }
    session = options.resumeSessionId
      ? await createdSdk.resumeSession(options.resumeSessionId, {
          model: options.model,
          permissionMode: options.permissionMode,
        })
      : options.continueMostRecent
        ? await createdSdk.sessions.continueMostRecent({
            model: options.model,
            permissionMode: options.permissionMode,
          })
        : await createdSdk.createSession({
            model: options.model,
            permissionMode,
          });
  } catch (error) {
    if (!/No Hadamard credential|credential was found/i.test((error as Error).message)) {
      throw error; // genuine error → propagate (existing Fatal handler)
    }
    needsCredentials = true;
    sdk = null;
    // A throw from createAgentSdk happens before a session is created. Keep a
    // stable, in-memory conversation shell so External CLI mode remains fully
    // usable without a Hadamard credential. It intentionally persists no
    // provider secrets; a real session replaces it after reloadSdk succeeds.
    session = await createCredentiallessSession();
  }
  const deviceLinkController = new GuiDeviceLinkHttpController({
    rootDirectory: path.join(resolveGuiHomeDir(), 'device-link'),
    deviceName: os.hostname(), workspaceRoot: workDir,
  });
  await deviceLinkController.setSdk(sdk);

  const listGuiSessions = (): Promise<SessionSummary[]> =>
    sdk ? sdk.sessions.list() : credentiallessSessionStore.list();
  const createGuiSession = async (
    createOptions: SessionCreateOptions = {},
  ): Promise<AgentSession> => {
    if (sdk) return sdk.createSession(createOptions);
    const stored = await credentiallessSessionStore.create({
      ...createOptions,
      model: createOptions.model ?? options.model ?? 'external-cli',
      metadata: {
        ...(createOptions.metadata ?? {}),
        __hadamardWorkDir: workDir,
        ...(createOptions.permissionMode
          ? {
              [HADAMARD_SESSION_PERMISSION_STATE_KEY]:
                serializeHadamardSessionPermissionState({
                  mode: createOptions.permissionMode,
                  permissions: createOptions.permissions ?? [],
                }),
            }
          : {}),
      },
    });
    return hydrateCredentiallessSession(stored);
  };
  const resumeGuiSession = async (
    sessionId: string,
    resumeOptions: SessionResumeOptions = {},
  ): Promise<AgentSession> => {
    if (sdk) return sdk.resumeSession(sessionId, resumeOptions);
    const loaded = resumeOptions.fork
      ? await credentiallessSessionStore.fork(sessionId, {
          title: resumeOptions.title,
          tags: resumeOptions.tags,
          metadata: resumeOptions.metadata,
        })
      : await credentiallessSessionStore.load(sessionId);
    if (resumeOptions.model) loaded.model = resumeOptions.model;
    if (resumeOptions.permissionMode !== undefined || resumeOptions.permissions !== undefined) {
      loaded.metadata[HADAMARD_SESSION_PERMISSION_STATE_KEY] =
        serializeHadamardSessionPermissionState({
          mode: resumeOptions.permissionMode,
          permissions: resumeOptions.permissions ?? [],
        });
    }
    return hydrateCredentiallessSession(loaded);
  };
  const deleteEmptyGuiSession = async (target: AgentSession): Promise<void> => {
    if (isEmptyUserStoredSession(target.snapshot())) {
      await target.delete().catch(() => undefined);
    }
  };
  const replaceGuiSession = async (next: AgentSession): Promise<void> => {
    const previous = session;
    session = next;
    if (previous.id !== next.id) await deleteEmptyGuiSession(previous);
  };

  // Only persist an explicitly requested startup workspace (CLI `hadamard-gui <dir>`
  // or tests). Packaged / bare launches use process.cwd() as a transient runtime
  // root and must not pollute Projects with the install or source tree.
  await migrateLegacyProjectActoviqDirIfNeeded(workDir).catch(() => undefined);
  if (explicitStartupWorkDir) {
    try {
      const bootHome = (await resolveHadamardSettingsStore({
        configPath: options.configPath,
        homeDir: currentHomeInput(),
      }).catch(() => undefined))?.homeDir
        ?? resolveGuiHomeDir();
      await rememberWorkspace(workDir, bootHome);
    } catch {
      // Registry write is best-effort.
    }
  }

  // Fire SessionStart hooks (best-effort, fire-and-forget) on the initial session.
  runSessionStartHooks(() => readSessionStartHooks(getLoadedJsonConfig()?.raw), workDir);

  // Team state. The attached team's tool is only injected into main-agent runs
  // when preferences.team.autoInvoke is on; otherwise attach is a selection and
  // /team ask stays the manual run path.
  let teamPrefs = readTeamPreferences(getLoadedJsonConfig()?.raw);
  let activeTeamTool: AgentToolDefinition | null = null;
  let activeTeamName: string | null = null;
  let lastTeamRunSummary: string | null = null;
  const attachTeamByName = (name: string): TeamDefinition | undefined => {
    const definition = resolveTeamDefinition(name, workDir, session.model);
    if (!definition) return undefined;
    activeTeamTool = createTeamTool(definition);
    activeTeamName = definition.name;
    session.metadata.__hadamardLastTeamName = definition.name;
    return definition;
  };
  if (!needsCredentials && teamPrefs.defaultAttached) {
    // Unresolvable default names are ignored; /team status surfaces the hint.
    try { attachTeamByName(teamPrefs.defaultAttached); } catch { /* ignore */ }
  }
  let activeRouter: RouterProfile | null = null;
  let routedModelLabel: string | null = null;
  // RunRegistry: active runs keyed by runId. foregroundRunId is the chat run the
  // main view tracks; permissions and /api/abort fall back to it for back-compat.
  const runs = new Map<string, GuiRunRecord>();
  const runReplayTombstones = new Map<string, GuiRunRecord>();
  let foregroundRunId: string | null = null;
  const foregroundRun = (): GuiRunRecord | undefined => (foregroundRunId ? runs.get(foregroundRunId) : undefined);
  const liveRunState = () => ({
    running: [...runs.values()].some(run => run.desc.status === 'running'),
    runs: [...runs.values()].map(run => run.desc),
    foregroundRunId,
    recentRuns: [...runReplayTombstones.values()]
      .map(run => run.desc)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, 20),
  });
  const retainRunReplay = (run: GuiRunRecord): void => {
    if (!run.events?.length) return;
    runReplayTombstones.set(run.desc.runId, run);
    while (runReplayTombstones.size > 20) {
      const oldest = runReplayTombstones.keys().next().value as string | undefined;
      if (!oldest) break;
      runReplayTombstones.delete(oldest);
    }
    const timer = setTimeout(() => {
      if (runReplayTombstones.get(run.desc.runId) === run) {
        runReplayTombstones.delete(run.desc.runId);
      }
    }, 5 * 60 * 1000);
    timer.unref?.();
  };
  const automationScheduler = new TaskScheduler({ defaultTimeoutMs: 30 * 60 * 1000 });
  const scheduledAutomationIds = new Set<string>();
  const railReminderScheduler = new ContextRailReminderScheduler();
  railReminderScheduler.setOnFire(async (wd, hd, item) => {
    const store = await readContextRailStore(wd, hd);
    const firedAt = item.firedAt ?? new Date().toISOString();
    const next = store.items.map(entry =>
      entry.id === item.id ? { ...entry, firedAt, updatedAt: firedAt } : entry,
    );
    await writeContextRailStore(wd, hd, { items: next });
  });
  async function syncRailReminders(targetWorkDir = workDir, homeDir = resolveGuiHomeDir()) {
    const store = await readContextRailStore(targetWorkDir, homeDir);
    await railReminderScheduler.sync(targetWorkDir, homeDir, store);
  }
  await syncRailReminders().catch(() => undefined);
  const pendingPermissions = new Map<string, PendingPermission>();
  // Terminal engine (plan phase 3). node-pty is probed once; terminalCapable
  // tells the renderer whether to show the terminal tab (false hides it even when
  // developer tools are on — the runtime fallback, plan R1 F2).
  // (terminalManager is declared above, near buildTools, for the vision tool.)

  // Bridge mode — in-process: a named config pre-builds a ModelApi via
  // buildRouteModelApi and is injected per-run into session.stream({model, modelApi}).
  // Same session → context survives switching bridge↔hadamard. No child process.
  let bridgeMode = false;
  let activeBridgeConfig: PersistedBridgeConfig | null = null;
  // Set only when the user selected a named picker entry. A plain config/model
  // selection must not inherit sampling overrides from a profile that happens
  // to reference the same model.
  let activeAgentSelectionName: string | null = null;
  let activeBridgeModelApi: Awaited<ReturnType<typeof buildRouteModelApi>> | null = null;
  let bridgeModelLabel: string | null = null;
  const externalCliRuntimeManager = options.externalCliRuntimeManager
    ?? new ExternalCliRuntimeManager();
  let runtimeMutationInProgress = false;
  const runtimeRunLeases = new Map<number, string>();
  let nextRuntimeRunLeaseId = 0;
  const activeRuntimeBlocker = (): string | undefined => {
    // A run remains a blocker until its record is removed in `finally`. Several
    // paths mark the visible status done before their final SDK/state awaits.
    const sdkRun = runs.values().next().value as GuiRunRecord | undefined;
    if (sdkRun) return sdkRun.desc.label;
    const leasedRun = runtimeRunLeases.values().next().value as string | undefined;
    if (leasedRun) return leasedRun;
    const externalRun = externalCliRuntimeManager.list().find(run =>
      run.status === 'queued' || run.status === 'running'
    );
    return externalRun ? `External CLI ${externalRun.runId}` : undefined;
  };
  const beginRuntimeMutation = (): (() => void) => {
    const blocker = activeRuntimeBlocker();
    if (runtimeMutationInProgress || blocker) {
      throw new GuiRuntimeMutationConflictError(
        runtimeMutationInProgress
          ? 'Runtime configuration is already being updated. Try again in a moment.'
          : `Wait for ${blocker} to finish, or stop it before changing runtime configuration.`,
      );
    }
    runtimeMutationInProgress = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      runtimeMutationInProgress = false;
    };
  };
  const withRuntimeMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = beginRuntimeMutation();
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const assertSessionNavigationAllowed = (): void => {
    const nonChatRun = [...runs.values()].find(run =>
      run.desc.status === 'running' && run.desc.kind !== 'chat'
    );
    const leasedRun = runtimeRunLeases.values().next().value as string | undefined;
    const externalRun = externalCliRuntimeManager.list().find(run =>
      run.status === 'queued' || run.status === 'running'
    );
    if (nonChatRun || leasedRun || externalRun) {
      const blocker = nonChatRun?.desc.label ?? leasedRun ?? `External CLI ${externalRun!.runId}`;
      throw new GuiRuntimeMutationConflictError(
        `Wait for ${blocker} to finish, or stop it before switching conversations.`,
      );
    }
  };
  const assertRunCanStart = (): void => {
    if (runtimeMutationInProgress) {
      throw new GuiRuntimeMutationConflictError(
        'Runtime configuration is being updated. Try starting the run again in a moment.',
      );
    }
  };
  const beginRuntimeRun = (label: string): (() => void) => {
    assertRunCanStart();
    const leaseId = ++nextRuntimeRunLeaseId;
    runtimeRunLeases.set(leaseId, label);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      runtimeRunLeases.delete(leaseId);
    };
  };
  const withRuntimeRun = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    const release = beginRuntimeRun(label);
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const runtimeMutationErrorStatus = (error: unknown): number =>
    error instanceof GuiRuntimeMutationConflictError ? 409 : 400;
  const runtimeMutationErrorBody = (error: unknown): { error: string } => ({
    error: error instanceof Error ? error.message : String(error),
  });
  const runtimeMutationCommand = async (
    operation: () => Promise<GuiRunEvent[]>,
  ): Promise<GuiRunEvent[]> => {
    try {
      return await withRuntimeMutation(operation);
    } catch (error) {
      if (error instanceof GuiRuntimeMutationConflictError) {
        return [{ type: 'error', message: error.message }];
      }
      throw error;
    }
  };
  const externalCliConfigIdentities = new Map<string, { signature: string; id: string }>();
  const externalCliRunConfigNames = new Map<string, string>();
  const externalCliProtectedSessionIds = new Set<string>();
  const externalCliSessionIdSecret = randomBytes(32);
  const externalCliSessionPaths = new Map<string, string>();
  function registerExternalCliSessionPath(sessionPath: string): string {
    const id = createHmac('sha256', externalCliSessionIdSecret)
      .update(path.resolve(sessionPath))
      .digest('base64url');
    externalCliSessionPaths.set(id, sessionPath);
    return id;
  }
  function resolveExternalCliSessionPath(id: string): string | undefined {
    return externalCliSessionPaths.get(id);
  }
  async function reloadProjectSystemPrompt(nextWorkDir = workDir): Promise<ProjectSettings> {
    projectSettings = await readProjectSettings(nextWorkDir, resolveGuiHomeDir());
    systemPrompt = buildGuiSystemPrompt(nextWorkDir, projectSettings, resolveGuiHomeDir(), projectRegisteredWorkPaths);
    return projectSettings;
  }
  // Usage totals for /cost, /usage, /stats. Per-config breakdown attributes spend
  // to each bridge config so the user can compare backends (mirrors the TUI).
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd: number | null = 0;
  const configUsage = new Map<string, { inputTokens: number; outputTokens: number; turns: number }>();

  function recordUsage(model: string, usage: { input_tokens?: number; output_tokens?: number } | undefined): void {
    const inT = usage?.input_tokens ?? 0;
    const outT = usage?.output_tokens ?? 0;
    totalInputTokens += inT;
    totalOutputTokens += outT;
    const cost = estimateCost(model, inT, outT, resolveGuiHomeDir());
    totalCostUsd = cost === null ? null : (totalCostUsd === null ? cost : totalCostUsd + cost);
    if (bridgeMode && activeBridgeConfig) {
      const rec = configUsage.get(activeBridgeConfig.name) ?? { inputTokens: 0, outputTokens: 0, turns: 0 };
      rec.inputTokens += inT;
      rec.outputTokens += outT;
      rec.turns += 1;
      configUsage.set(activeBridgeConfig.name, rec);
    }
  }
  function configCost(name: string, rec: { inputTokens: number; outputTokens: number }): string | null {
    const cfg = findBridgeConfig(name, resolveGuiHomeDir());
    if (!cfg?.model) return null;
    const cost = estimateCost(cfg.model, rec.inputTokens, rec.outputTokens, resolveGuiHomeDir());
    return cost !== null ? `$${cost.toFixed(4)}` : null;
  }

  // The project/plugin/empty-session scans walk every project on disk. Cache them
  // briefly (and invalidate on mutations) so `/api/state` is cheap on every turn.
  type HeavyState = {
    key: string;
    at: number;
    projects: Awaited<ReturnType<typeof listKnownProjects>>;
    plugins: Awaited<ReturnType<typeof discoverHadamardPlugins>>;
  };
  let heavyStateCache: HeavyState | null = null;
  const invalidateHeavyState = (): void => {
    heavyStateCache = null;
  };

  async function reloadSdk(): Promise<void> {
    await rebuildTools();
    const previousSdk = sdk;
    const nextSdk = await createCleanSdk();
    try {
      // When recovering from a no-credential state the session is a stub (id: ''),
      // so create a fresh session instead of trying to resume an empty id.
      session = needsCredentials
        ? await nextSdk.createSession({ model: options.model, permissionMode })
        : await nextSdk.resumeSession(session.id, {
          model: options.model,
          permissionMode: options.permissionMode,
        });
      toolMetadata = await nextSdk.listToolMetadata();
      sdk = nextSdk;
      needsCredentials = false;
      await restoreSessionRuntimeSelection();
    } catch (error) {
      await nextSdk.close().catch(() => undefined);
      throw error;
    }
    await deviceLinkController.setSdk(nextSdk);
    if (previousSdk) await previousSdk.close().catch(() => undefined);
    await resetManagerAndAssistantSessions();
  }

  async function externalSkillCatalogSnapshot() {
    const location = { hadamardHomeDir: resolveGuiHomeDir(), workDir };
    const preferences = await readHadamardExternalSkillPreferences(location);
    const runtime = await loadHadamardExternalSkillDefinitions({
      hadamardHomeDir: location.hadamardHomeDir,
      workDir,
      externalSkills: externalSkillPreferencesToRuntimeOptions(preferences),
    });
    const activeSkillIds = new Set<string>();
    if (sdk) {
      for (const skill of runtime.catalog.skills) {
        const definition = sdk.getSkillDefinition(skill.name);
        if (definition?.metadata?.__hadamardExternalSkillId === skill.id) activeSkillIds.add(skill.id);
      }
    } else {
      for (const skillId of runtime.loadedSkillIds) activeSkillIds.add(skillId);
    }
    return {
      catalog: runtime.catalog,
      preferences,
      activeSkillIds: [...activeSkillIds].sort(),
      skippedConflicts: runtime.skippedConflicts,
      skippedUntrustedSourceIds: runtime.skippedUntrustedSourceIds,
      loadErrors: runtime.loadErrors,
    };
  }

  async function updateExternalSkillPreferences(body: Record<string, unknown>) {
    const current = await externalSkillCatalogSnapshot();
    const preferences = current.preferences;
    const action = typeof body.action === 'string' ? body.action : '';
    if (action === 'source') {
      const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
      const source = current.catalog.sources.find(item => item.id === sourceId);
      if (!source) throw new Error('Unknown skill source. Refresh Customize and try again.');
      const disabledSourceIds = new Set(preferences.disabledSourceIds);
      const trustedProjectSourceIds = new Set(preferences.trustedProjectSourceIds);
      if (body.enabled === true) disabledSourceIds.delete(sourceId);
      else disabledSourceIds.add(sourceId);
      if (body.trust === true) {
        if (source.scope !== 'project') throw new Error('Only project skill sources require trust.');
        trustedProjectSourceIds.add(sourceId);
      } else if (body.trust === false) {
        if (source.scope !== 'project') throw new Error('Only project skill sources have revocable trust.');
        trustedProjectSourceIds.delete(sourceId);
        disabledSourceIds.add(sourceId);
      }
      await writeHadamardExternalSkillPreferences(
        { hadamardHomeDir: resolveGuiHomeDir(), workDir },
        {
          ...preferences,
          disabledSourceIds: [...disabledSourceIds],
          trustedProjectSourceIds: [...trustedProjectSourceIds],
        },
      );
    } else if (action === 'skill') {
      const skillId = typeof body.skillId === 'string' ? body.skillId.trim() : '';
      const selected = current.catalog.skills.find(skill => skill.id === skillId);
      if (!selected) throw new Error('Unknown skill. Refresh Customize and try again.');
      await setHadamardExternalSkillDisabled(
        { hadamardHomeDir: resolveGuiHomeDir(), workDir },
        skillId,
        body.enabled !== true,
      );
    } else if (action === 'prefer') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (body.clear === true) {
        const conflict = current.catalog.conflicts.find(item => item.name === name);
        if (!conflict && !preferences.preferredSkillIds[name]) {
          throw new Error('Unknown skill conflict. Refresh Customize and try again.');
        }
        await clearHadamardPreferredExternalSkill(
          { hadamardHomeDir: resolveGuiHomeDir(), workDir },
          name,
        );
      } else {
        const skillId = typeof body.skillId === 'string' ? body.skillId.trim() : '';
        const selected = current.catalog.skills.find(skill => skill.id === skillId && skill.name === name);
        if (!selected || !selected.conflict) {
          throw new Error('The selected skill is not a current conflict variant. Refresh Customize and try again.');
        }
        await setHadamardPreferredExternalSkill(
          { hadamardHomeDir: resolveGuiHomeDir(), workDir },
          name,
          skillId,
        );
      }
    } else {
      throw new Error('Unknown skill preference action.');
    }
    if (sdk && !needsCredentials) await reloadSdk();
    invalidateHeavyState();
    return externalSkillCatalogSnapshot();
  }

  const managedPluginHealthCache = new Map<ManagedPluginId, ManagedPluginHealth>();

  function managedPluginId(value: unknown): ManagedPluginId {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!(MANAGED_PLUGIN_IDS as readonly string[]).includes(id)) {
      throw new Error('Unknown managed plugin. Refresh Customize and try again.');
    }
    return id as ManagedPluginId;
  }

  async function managedPluginCatalogSnapshot() {
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    });
    const configuredDirs = Array.isArray(store.raw.pluginDirs)
      ? store.raw.pluginDirs.filter((value): value is string => typeof value === 'string')
      : [];
    const health = Object.fromEntries(managedPluginHealthCache) as Partial<
      Record<ManagedPluginId, ManagedPluginHealth>
    >;
    const packageManager = new PluginPackageManager(
      path.join(store.homeDir, 'plugin-packages'),
      process.env.HADAMARD_PLUGIN_REGISTRY,
      sdk?.config.effectivePolicy,
    );
    return {
      ...readManagedPluginCatalog(store.raw, { health }),
      packages: await packageManager.snapshot(),
      localPlugins: await discoverHadamardPlugins({
        workDir,
        homeDir: store.homeDir,
        configuredDirs,
      }),
    };
  }

  async function updateManagedPlugin(body: Record<string, unknown>) {
    if (typeof body.packageId === 'string') {
      const packageId = body.packageId.trim();
      const action = typeof body.action === 'string' ? body.action : '';
      if (!/^[a-z0-9][a-z0-9._-]*$/u.test(packageId)
        || !['trust', 'enable', 'disable', 'remove'].includes(action)) {
        throw new Error('Unknown plugin package action.');
      }
      const manager = new PluginPackageManager(
        path.join(resolveGuiHomeDir(), 'plugin-packages'),
        process.env.HADAMARD_PLUGIN_REGISTRY,
        sdk?.config.effectivePolicy,
      );
      const result = await manager.execute(`${action} ${packageId}`);
      if (result.runtimeChanged && sdk && !needsCredentials) await reloadSdk();
      invalidateHeavyState();
      return managedPluginCatalogSnapshot();
    }
    const id = managedPluginId(body.id);
    const action = typeof body.action === 'string' ? body.action : '';
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    });
    const raw = structuredClone(store.raw);
    if (action === 'install') {
      patchManagedPluginSettings(raw, id, { enabled: true });
    } else if (action === 'enable') {
      if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
      patchManagedPluginSettings(raw, id, { enabled: body.enabled });
    } else if (action === 'save') {
      patchManagedPluginSettings(raw, id, {
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(isPlainRecord(body.config) ? { config: body.config } : {}),
        clearSecret: body.clearSecret === true,
      });
    } else {
      throw new Error('Unknown managed plugin action.');
    }

    await persistHadamardSettingsStore(store.configPath, raw);
    await loadJsonConfigFile(store.configPath);
    managedPluginHealthCache.delete(id);
    if (sdk && !needsCredentials) await reloadSdk();
    invalidateHeavyState();
    return managedPluginCatalogSnapshot();
  }

  async function testManagedPlugin(body: Record<string, unknown>) {
    const id = managedPluginId(body.id);
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    });
    const health = await probeManagedPlugin(store.raw, id, { cwd: workDir });
    managedPluginHealthCache.set(id, health);
    return {
      id,
      health,
      catalog: await managedPluginCatalogSnapshot(),
    };
  }

  async function switchProject(
    nextWorkDir: string,
    switchOptions: { remember?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    if (foregroundRun()) {
      throw new Error('Cannot switch projects while a run is active. Stop the run, then open the workspace again.');
    }
    const resolved = await resolveWorkspaceDirectory(nextWorkDir);
    await migrateLegacyProjectActoviqDirIfNeeded(resolved).catch(() => undefined);
    const previousWorkDir = workDir;
    const previousProjectPrimaryPath = projectPrimaryPath;
    const previousSystemPrompt = systemPrompt;
    const previousSdk = sdk;
    const previousSession = session;
    const previousNeedsCredentials = needsCredentials;
    const previousToolMetadata = toolMetadata;
    workDir = resolved;
    await refreshProjectPrimaryPath(resolved);
    await reloadProjectSystemPrompt(resolved);
    activeTeamTool = null;
    activeTeamName = null;
    activeRouter = null;
    routedModelLabel = null;
    managerGuiSession = null;
    try {
      await rebuildTools();
      try {
        const nextSdk = await createCleanSdk();
        try {
          const sessions = await nextSdk.sessions.list();
          const resumable = sessions.find(item =>
            !isEmptyUserSessionSummary(item) && item.status !== 'closed' && isVisibleChatSession(item)
          ) ?? sessions.find(item => !isEmptyUserSessionSummary(item) && isVisibleChatSession(item));
          const nextSession = resumable
            ? await nextSdk.resumeSession(resumable.id, { model: options.model, permissionMode: options.permissionMode })
            : await nextSdk.createSession({ model: options.model, permissionMode });
          session = nextSession;
          // Tool metadata is not needed to paint project detail; fill after open returns.
          toolMetadata = [];
          sdk = nextSdk;
          needsCredentials = false;
          await restoreSessionRuntimeSelection();
          await deleteEmptyGuiSession(previousSession);
          if (previousSdk) await previousSdk.close().catch(() => undefined);
          void nextSdk.listToolMetadata().then((meta) => { toolMetadata = meta; }).catch(() => undefined);
        } catch (error) {
          await nextSdk.close().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (!/No Hadamard credential|credential was found/i.test((error as Error).message)) {
          throw error;
        }
        // Match boot: allow opening a workspace without Hadamard credentials
        // (External CLI / browse-only). Point the credentialless store at the
        // new project so sessions stay scoped correctly.
        credentiallessSessionStore = new SessionStore(
          await ensureProjectDataMigrated(projectPrimaryPath),
        );
        needsCredentials = true;
        sdk = null;
        toolMetadata = [];
        session = hydrateCredentiallessSession(await credentiallessSessionStore.create({
          title: 'External CLI chat',
          model: options.model ?? 'external-cli',
          metadata: { __hadamardWorkDir: workDir },
        }));
        await deleteEmptyGuiSession(previousSession);
        if (previousSdk) await previousSdk.close().catch(() => undefined);
      }
    } catch (error) {
      workDir = previousWorkDir;
      projectPrimaryPath = previousProjectPrimaryPath;
      systemPrompt = previousSystemPrompt;
      sdk = previousSdk;
      session = previousSession;
      needsCredentials = previousNeedsCredentials;
      toolMetadata = previousToolMetadata;
      await rebuildTools().catch(() => undefined);
      throw error;
    }
    const storeHome = (await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    }).catch(() => undefined))?.homeDir
      ?? resolveGuiHomeDir();
    invalidateHeavyState();
    // Opening an unregistered Session must not silently turn its workspace into
    // a Project. Explicit project opens keep the existing remember behavior.
    if (switchOptions.remember !== false) {
      await rememberWorkspace(workDir, storeHome).catch(() => undefined);
    }
    void Promise.all([
      resyncAutomationScheduler().catch(() => undefined),
      syncRailReminders().catch(() => undefined),
    ]);
    return state({ light: true });
  }

  const currentPermissionMode = (): HadamardPermissionMode =>
    session?.permissionContext?.mode ?? permissionMode;
  const currentEffort = (): HadamardRunEffort | undefined => {
    const stored = session?.metadata?.__hadamardEffort;
    if (stored === 'auto') return 'auto';
    return isEffort(stored) ? stored : sdk?.config.effort;
  };
  const currentAgentMode = () => readSessionAgentMode(session?.metadata, projectSettings.agentMode);
  const currentContextWindow = () => readSessionContextWindow(session?.metadata);
  const currentEffectiveAgentRunOptions = () => {
    const agent = activeAgentSelectionName
      ? findSelectableAgent(activeAgentSelectionName, resolveGuiHomeDir())
      : undefined;
    if (!agent) {
      return {
        systemPrompt,
        ...(currentContextWindow() ? { contextWindowTokens: currentContextWindow() } : {}),
        permissionMode: currentPermissionMode(),
        effort: currentEffort(),
        agentMode: currentAgentMode(),
        projectInstructions: {
          mode: projectSettings.context.instructionMode,
          workPaths: projectRegisteredWorkPaths,
        },
      };
    }
    const effective = resolveEffectiveAgentRunOptions(agent, {
      systemPrompt,
      fallbackPermissionMode: currentPermissionMode(),
      fallbackEffort: currentEffort(),
    });
    const allowedTools = effective.allowedTools
      ? [...effective.allowedTools]
      : undefined;
    if (allowedTools && activeTeamTool && teamPrefs.autoInvoke) {
      allowedTools.push(activeTeamTool.name);
    }
    return {
      systemPrompt: effective.systemPrompt,
      ...(currentContextWindow() ? { contextWindowTokens: currentContextWindow() } : {}),
      agentMode: effective.agentMode ?? currentAgentMode(),
      permissionMode: effective.permissionMode,
      effort: effective.effort,
      projectInstructions: {
        mode: projectSettings.context.instructionMode,
        workPaths: projectRegisteredWorkPaths,
      },
      ...(typeof effective.maxTokens === 'number' ? { maxTokens: effective.maxTokens } : {}),
      ...(typeof effective.temperature === 'number' ? { temperature: effective.temperature } : {}),
      ...(typeof effective.topP === 'number' ? { topP: effective.topP } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      workspaceAccess: effective.workspaceAccess,
      ...(typeof effective.maxToolIterations === 'number'
        ? { maxToolIterations: effective.maxToolIterations }
        : {}),
    };
  };
  // P2: an active agent profile may restrict the toolset (allowedTools). The
  // attached team tool (autoInvoke) always survives the filter.
  const currentRunTools = (): AgentToolDefinition[] | null => {
    const agent = activeAgentSelectionName
      ? findSelectableAgent(activeAgentSelectionName, resolveGuiHomeDir())
      : undefined;
    const allowed = Array.isArray(agent?.allowedTools) && agent.allowedTools.length
      ? agent.allowedTools
      : null;
    const teamTool = activeTeamTool && teamPrefs.autoInvoke ? activeTeamTool : null;
    if (!allowed) return teamTool ? [...tools, teamTool] : null;
    const filtered = tools.filter((tool) => allowed.includes(tool.name));
    return teamTool ? [...filtered, teamTool] : filtered;
  };
  // P2 follow-up: an active agent profile may also cap tool iterations and set
  // a per-turn timeout — applied to the same runs as the sampling overrides.
  const withAgentRunTimeout = (signal: AbortSignal): AbortSignal => {
    const agent = activeAgentSelectionName
      ? findSelectableAgent(activeAgentSelectionName, resolveGuiHomeDir())
      : undefined;
    return typeof agent?.timeoutMs === 'number' && agent.timeoutMs > 0
      ? AbortSignal.any([signal, AbortSignal.timeout(agent.timeoutMs)])
      : signal;
  };

  const approver: HadamardToolApprover = async (context) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const pending = await new Promise<{
      decision: 'allow' | 'always' | 'always-user' | 'deny';
      answers?: Record<string, string>;
    }>((resolve) => {
      const request: PendingPermission = {
        id,
        toolName: context.publicName,
        summary: summarizeInput(context.input),
        input: context.input,
        resolve,
      };
      pendingPermissions.set(id, request);
      foregroundRun()?.sink({
        type: 'permission.request',
        id,
        toolName: request.toolName,
        summary: request.summary,
        input: context.input,
      });
    });
    pendingPermissions.delete(id);
    if (pending.decision === 'always' || pending.decision === 'always-user') {
      const state = session.permissionContext;
      const permissions = state.permissions.filter(
        rule => !(rule.toolName === context.publicName && rule.behavior === 'allow'),
      );
      const source: 'project' | 'user' = pending.decision === 'always-user' ? 'user' : 'project';
      permissions.push({ toolName: context.publicName, behavior: 'allow', source });
      await session.setPermissionContext({
        mode: state.mode ?? permissionMode,
        permissions,
        approver,
      });
      return { behavior: 'allow', reason: `Approved (always — ${source} scope) in GUI.` };
    }
    if (pending.decision !== 'allow') {
      return { behavior: 'deny', reason: 'Denied in GUI permission dialog.' };
    }
    if (pending.answers && context.publicName === 'AskUserQuestion') {
      const base =
        context.input && typeof context.input === 'object' && !Array.isArray(context.input)
          ? { ...(context.input as Record<string, unknown>) }
          : {};
      return {
        behavior: 'allow',
        reason: 'Answered AskUserQuestion in GUI.',
        updatedInput: { ...base, answers: pending.answers },
      };
    }
    return { behavior: 'allow', reason: 'Approved in GUI.' };
  };

  // Read-only Bash auto-allow + mutating-tool prompt (mirrors the TUI's
  // canUseTool). Only active in the 'default' permission mode; returns undefined
  // (no decision) otherwise so workspace/full modes keep their behavior.
  const MUTATING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit', 'PowerShell']);
  const canUseTool: HadamardCanUseTool = (context) => {
    if (currentPermissionMode() !== 'default') return undefined;
    if (context.publicName === 'Bash') {
      const command = (context.input as { command?: unknown } | null)?.command;
      if (typeof command === 'string' && isReadOnlyBashCommand(command)) {
        return undefined; // auto-allow harmless read-only commands
      }
      return { behavior: 'ask', reason: 'Bash command may modify the workspace.' };
    }
    if (MUTATING_TOOLS.has(context.publicName)) {
      return { behavior: 'ask', reason: `${context.publicName} mutates the workspace.` };
    }
    return undefined;
  };

  // User-configurable PreToolUse hooks from settings.json hooks.PreToolUse[].
  // Lazily reads live settings so edits apply without a restart; a no-op when no
  // hooks match (the common case), so the run path is unchanged.
  const preToolUseHookClassifier = createPreToolUseHookClassifier(
    () => readPreToolUseHooks(getLoadedJsonConfig()?.raw),
  );

  // Wire the plan-mode tools' onPlanModeChange to flip the session into plan
  // permission mode so mutating tools are blocked while the agent researches.
  applyPlanPermission = async () => {
    await session.setPermissionContext({ mode: 'plan', permissions: [], approver });
  };

  /**
   * §3.5 fallback switch: ON (default) allows silent fallbacks to the session
   * default model; OFF — or ON without a configured default model — disables
   * them so broken references surface as explicit errors instead.
   */
  async function defaultModelFallbackEnabled(): Promise<boolean> {
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    }).catch(() => undefined);
    const prefs = store ? readGuiPreferences(store.raw) : DEFAULT_GUI_PREFERENCES;
    if (prefs.useDefaultModelAsFallback === false) return false;
    const env = store ? readEnvFromSettings(store.raw) : {};
    return Boolean((env.HADAMARD_MODEL ?? '').trim());
  }

  /**
   * Fresh unified agent-definition summaries for the panel/drawer: built-ins
   * merged with .md definitions read from disk (built-in → user → project,
   * later wins), so newly saved agents appear without an SDK reload. The
   * default keeps the Agent-tool surface rule (subagent === false hidden,
   * S1a); the unified panel list passes includeNonDelegatable to also show
   * main-chat-only agents (S3).
   */
  async function agentDefinitionSummariesForGui(options?: { includeNonDelegatable?: boolean }) {
    const loaded = await loadHadamardAgentDefinitions({
      homeDir: resolveGuiHomeDir(),
      workDir,
    });
    const merged = new Map<string, HadamardAgentDefinition>();
    for (const definition of [...getDefaultHadamardAgents(), ...loaded]) {
      merged.set(definition.name, definition);
    }
    return [...merged.values()]
      .filter(definition => options?.includeNonDelegatable || definition.subagent !== false)
      .map(definition => summarizeHadamardAgentDefinition(definition));
  }

  async function state(opts?: { light?: boolean }) {
    const light = opts?.light === true;
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    }).catch(() => undefined);
    const env = store ? readEnvFromSettings(store.raw) : {};
    const configuredDirs = Array.isArray(store?.raw.pluginDirs)
      ? store.raw.pluginDirs.filter((value): value is string => typeof value === 'string')
      : [];
    const homeDir = store?.homeDir ?? resolveGuiHomeDir();
    const cacheKey = `${workDir}|${session?.id ?? 'none'}`;
    const protectedSessionIds = new Set<string>([
      ...(session ? [session.id] : []),
      ...externalCliProtectedSessionIds,
    ]);
    const now = Date.now();
    let heavy = heavyStateCache && heavyStateCache.key === cacheKey && now - heavyStateCache.at < 4000
      ? heavyStateCache
      : null;
    if (!heavy) {
      if (light) {
        // Project open: only rebuild the projects list. Plugins / empty-session
        // cleanup can wait for the next full /api/state refresh.
        const projects = await listKnownProjects(homeDir, workDir);
        heavy = { key: cacheKey, at: now, plugins: [], projects };
        heavyStateCache = heavy;
        void Promise.all([
          discoverHadamardPlugins({ workDir, homeDir, configuredDirs }),
          !session
            ? Promise.resolve(undefined)
            : collectSessionStoreRoots(
                homeDir,
                sdk?.config.sessionDirectory
                  ?? getHadamardProjectSessionDirectory(workDir, homeDir),
              )
              .then((roots) => cleanupStoredEmptySessions(roots, protectedSessionIds)),
        ]).then(([plugins]) => {
          if (heavyStateCache?.key === cacheKey) {
            heavyStateCache = { ...heavyStateCache, plugins, at: Date.now() };
          }
        }).catch(() => undefined);
      } else {
        const sessionStoreRoots = await collectSessionStoreRoots(
          homeDir,
          sdk?.config.sessionDirectory ?? getHadamardProjectSessionDirectory(workDir, homeDir),
        );
        const [plugins, projects] = await Promise.all([
          discoverHadamardPlugins({ workDir, homeDir, configuredDirs }),
          listKnownProjects(homeDir, workDir),
          !session
            ? Promise.resolve()
            : cleanupStoredEmptySessions(sessionStoreRoots, protectedSessionIds),
        ]);
        heavy = { key: cacheKey, at: now, plugins, projects };
        heavyStateCache = heavy;
      }
    }
    const registeredProjectPaths = heavy.projects.flatMap(project => project.workPaths);
    const [allSessions, unregisteredSessions, workflows, teams, routers, skills, agents, agentDefinitions, runtimeDiscovery, scheduledTasks] = await Promise.all([
      listGuiSessions(),
      listUnregisteredGuiSessions(homeDir, registeredProjectPaths),
      Promise.resolve(listWorkflows(workDir)),
      Promise.resolve(listTeamDefinitions(workDir)),
      Promise.resolve(listRouterProfiles(workDir)),
      light || needsCredentials ? Promise.resolve([]) : (sdk! as NonNullable<typeof sdk>).skills.listMetadata(),
      light || needsCredentials ? Promise.resolve([]) : agentDefinitionSummariesForGui(),
      light || needsCredentials ? Promise.resolve([]) : agentDefinitionSummariesForGui({ includeNonDelegatable: true }),
      light ? Promise.resolve([]) : Promise.resolve(discoverAgentRuntimes({ homeDir })),
      listScheduledAutomationTasks(workDir),
    ]);
    const bridgeConfigs = readBridgeConfigs(homeDir).configs;
    const agentProfiles = listAgentProfiles(homeDir);
    const selectableAgents = listSelectableAgents(homeDir);
    const activeAgent = activeAgentSelectionName
      ? findSelectableAgent(activeAgentSelectionName, homeDir) ?? null
      : null;
    // Hide 0-message conversations entirely — they're auto-cleaned on the
    // backend (cleanupStoredEmptySessions), and showing empty chats in the
    // list is noise. The active session is still resumable via the chat view.
    const sessions = allSessions.filter(item =>
      !isEmptyUserSessionSummary(item) && isVisibleChatSession(item)
    );
    const archivedSessions = light
      ? []
      : await listArchivedSessionsForWorkDir(workDir, homeDir);
    const railStore = await readContextRailStore(workDir, homeDir);
    const activeProject = heavy.projects.find(project => project.active);
    return {
      workDir,
      platform: process.platform,
      projectPath: activeProject?.path ?? projectPrimaryPath,
      projectWorkPaths: activeProject?.workPaths ?? [workDir],
      activeWorkPath: workDir,
      session: sessionView(session),
      permissionMode: currentPermissionMode(),
      effort: currentEffort() ?? 'auto',
      agentMode: currentAgentMode(),
      activeTeamName,
      teamPreferences: teamPrefs,
      activeRouterName: activeRouter?.name ?? null,
      routedModelLabel,
      commands: HADAMARD_GUI_INTERACTIVE_COMMANDS,
      commandUsages: Object.fromEntries(Object.keys(HADAMARD_GUI_INTERACTIVE_COMMANDS).map(name => [name, commandUsage(name)])),
      tools: toolMetadata,
      projects: heavy.projects,
      projectPlan: await readProjectPlan(projectPrimaryPath, homeDir),
      issueSummary: activeProject?.issueCounts ?? { total: 0, open: 0, review: 0, closed: 0 },
      sessions,
      unregisteredSessions,
      archivedSessions,
      workflows,
      scheduledTasks,
      teams,
      routers,
      agentProfiles,
      selectableAgents,
      activeAgent,
      skills,
      agents,
      agentDefinitions,
      plugins: heavy.plugins,
      settings: {
        configPath: store?.configPath ?? null,
        provider: env.HADAMARD_PROVIDER ?? sdk?.config.provider ?? 'anthropic',
        baseURL: env.HADAMARD_BASE_URL ?? '',
        defaultModel: env.HADAMARD_MODEL ?? '',
        defaultEffort: env.HADAMARD_EFFORT ?? '',
        defaultModelContext1M: env.HADAMARD_DEFAULT_MODEL_CONTEXT_1M === '1',
        defaultModelMultimodal: env.HADAMARD_DEFAULT_MODEL_MULTIMODAL === '1',
        minModel: env.HADAMARD_DEFAULT_MIN_MODEL ?? '',
        mediumModel: env.HADAMARD_DEFAULT_MEDIUM_MODEL ?? '',
        maxModel: env.HADAMARD_DEFAULT_MAX_MODEL ?? '',
        apiKeyConfigured: Boolean(env.HADAMARD_API_KEY || env.HADAMARD_AUTH_TOKEN),
        apiKey: env.HADAMARD_API_KEY ?? env.HADAMARD_AUTH_TOKEN ?? '',
        apiKeyMasked: maskApiKey(env.HADAMARD_API_KEY ?? env.HADAMARD_AUTH_TOKEN ?? ''),
        preferences: store ? readGuiPreferences(store.raw) : DEFAULT_GUI_PREFERENCES,
        browser: readHadamardBrowserSettings(store?.raw ?? {}),
        bridge: store?.raw?.bridge ?? {},
        sandbox: sdk
          ? {
              policy: sdk.config.sandbox,
              capability: sdk.config.sandboxCapabilities,
            }
          : null,
        policy: sdk?.config.effectivePolicy ?? null,
        dataRoot: {
          root: homeDir,
          pointerPath: getHadamardHomePointerPath(pointerHomeDir()),
        },
      },
      bridgeState: {
        mode: bridgeMode,
        activeConfig: activeBridgeConfig
          ? {
              name: activeBridgeConfig.name,
              runtime: activeBridgeConfig.runtime,
              execution: activeBridgeConfig.execution ?? 'api',
              authSource: activeBridgeConfig.authSource ?? 'apiKey',
              provider: activeBridgeConfig.provider,
              credentialProvider: activeBridgeConfig.credentialProvider ?? '',
              trustProjectResources: activeBridgeConfig.trustProjectResources === true,
              apiKeyMasked: activeBridgeConfig.apiKey ? maskApiKey(activeBridgeConfig.apiKey) : '',
              baseURL: activeBridgeConfig.baseURL ?? '',
              model: activeBridgeConfig.model ?? '',
              nativeSessionId:
                activeBridgeConfig.execution === 'cli'
      && isManagedExternalCliRuntime(activeBridgeConfig.runtime)
                  ? externalNativeSessionId(activeBridgeConfig as SupportedExternalCliConfig) ?? ''
                  : '',
            }
          : null,
        activeModelLabel: bridgeModelLabel,
        configs: bridgeConfigs.map(c => ({
          name: c.name,
          runtime: c.runtime,
          execution: c.execution ?? 'api',
          authSource: c.authSource ?? 'apiKey',
          provider: c.provider,
          credentialProvider: c.credentialProvider ?? '',
          trustProjectResources: c.trustProjectResources === true,
          hasApiKey: Boolean(c.apiKey),
          apiKey: c.apiKey ?? '',
          apiKeyMasked: c.apiKey ? maskApiKey(c.apiKey) : '',
          baseURL: c.baseURL ?? '',
          model: c.model ?? '',
          models: Array.isArray(c.models)
            ? c.models.map(m => ({
                name: m.name,
                context1M: m.context1M === true,
                contextWindowTokens: m.contextWindowTokens,
                maxContextWindowTokens: m.maxContextWindowTokens,
                effectiveContextWindowPercent: m.effectiveContextWindowPercent,
                autoCompactTokenLimit: m.autoCompactTokenLimit,
                modality: m.modality === 'multimodal' ? 'multimodal' : 'text',
              }))
            : [],
        })),
        externalRuns: externalCliRuntimeManager.list().map(run => ({
          runId: run.runId,
          configName: externalCliRunConfigNames.get(run.runId) ?? 'External CLI',
          status: run.status,
          background: run.background,
          cwd: run.cwd,
          nativeSessionId: run.nativeSessionId ?? '',
          createdAt: run.createdAt,
          startedAt: run.startedAt ?? '',
          finishedAt: run.finishedAt ?? '',
          lastText: run.result?.text ? run.result.text.slice(0, 240) : '',
          error: run.error?.message ?? '',
        })),
        runtimeDiscovery: runtimeDiscovery.map(runtime => {
          const local = runtime.runtime !== 'hadamard'
            ? detectRuntimeLocalConfig(runtime.runtime, pointerHomeDir(), externalCliConfigPaths)
            : null;
          return {
            id: runtime.id,
            label: runtime.label,
            runtime: runtime.runtime,
            provider: runtime.provider,
            status: runtime.status,
            installed: runtime.installed,
            configured: runtime.configured,
            command: runtime.command ?? '',
            commandPath: runtime.commandPath ?? '',
            version: runtime.version ?? '',
            versionError: runtime.versionError ?? '',
            configNames: runtime.configNames,
            reuseHint: runtime.reuseHint,
            description: runtime.description,
            localConfig: local
              ? {
                  model: local.model ?? '',
                  baseURL: local.baseURL ?? '',
                  hasApiKey: Boolean(local.apiKey),
                  source: local.source ?? '',
                }
              : null,
          };
        }),
      },
      mcpServers: readMcpServerConfig(homeDir).servers,
      goal: getGoal(),
      goalNext: describeGoalNext(getGoal()),
      goalLoop: goalLoopSnapshot(session.id),
      needsCredentials,
      needsDefaultModelOnboarding: shouldShowDefaultModelOnboarding(
        store?.raw ?? {},
        bridgeConfigs.length,
      ),
      projectSettings,
      planMode: currentPermissionMode() === 'plan',
      plan: readPlanFile(workDir),
      todos,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd: totalCostUsd,
        perConfig: Array.from(configUsage.entries()).map(([cfgName, rec]) => ({
          name: cfgName,
          ...rec,
          costUsd: configCost(cfgName, rec),
        })),
      },
      ...liveRunState(),
      terminalCapable,
      railItems: sortContextRailItems(railStore.items),
      railNotifications: railReminderScheduler.drainNotifications(),
      git: await gitBranchSummary(),
    };
  }

  async function saveSettings(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    });
    const raw = structuredClone(store.raw);
    const env = readEnvFromSettings(raw);
    raw.env = env;

    if (body.provider === 'anthropic' || body.provider === 'openai') {
      env.HADAMARD_PROVIDER = body.provider;
    }
    if (body.clearApiKey === true) {
      delete env.HADAMARD_API_KEY;
      delete env.HADAMARD_AUTH_TOKEN;
      delete raw.HADAMARD_API_KEY;
      delete raw.HADAMARD_AUTH_TOKEN;
    } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      env.HADAMARD_API_KEY = body.apiKey.trim();
      delete env.HADAMARD_AUTH_TOKEN;
    }
    const envFields = [
      ['baseURL', 'HADAMARD_BASE_URL'],
      ['defaultModel', 'HADAMARD_MODEL'],
      ['minModel', 'HADAMARD_DEFAULT_MIN_MODEL'],
      ['mediumModel', 'HADAMARD_DEFAULT_MEDIUM_MODEL'],
      ['maxModel', 'HADAMARD_DEFAULT_MAX_MODEL'],
    ] as const;
    for (const [field, key] of envFields) {
      if (typeof body[field] !== 'string') continue;
      const value = body[field].trim();
      if (value) env[key] = value;
      else delete env[key];
    }
    if (typeof body.effort === 'string') {
      const defaultEffort = body.effort.trim().toLowerCase();
      if (isEffort(defaultEffort)) env.HADAMARD_EFFORT = defaultEffort;
      else if (defaultEffort === 'auto') delete env.HADAMARD_EFFORT;
    }
    if (typeof body.defaultModelContext1M === 'boolean') {
      if (body.defaultModelContext1M) env.HADAMARD_DEFAULT_MODEL_CONTEXT_1M = '1';
      else delete env.HADAMARD_DEFAULT_MODEL_CONTEXT_1M;
    }
    if (typeof body.defaultModelMultimodal === 'boolean') {
      if (body.defaultModelMultimodal) env.HADAMARD_DEFAULT_MODEL_MULTIMODAL = '1';
      else delete env.HADAMARD_DEFAULT_MODEL_MULTIMODAL;
    }

    // Bridge settings: write per-provider paths + default provider.
    if (isPlainRecord(body.bridge)) {
      raw.bridge = { ...(isPlainRecord(raw.bridge) ? raw.bridge : {}), ...body.bridge };
    }

    if (isPlainRecord(body.browser)) {
      const browserBody = body.browser;
      const channelRaw = browserBody.channel;
      writeHadamardBrowserSettings(raw, {
        enabled: browserBody.enabled === true,
        headless: browserBody.headless !== false,
        channel:
          channelRaw === 'chrome' || channelRaw === 'msedge' || channelRaw === 'chromium'
            ? channelRaw
            : undefined,
        cdpUrl: typeof browserBody.cdpUrl === 'string' ? browserBody.cdpUrl : undefined,
        userDataDir: typeof browserBody.userDataDir === 'string' ? browserBody.userDataDir : undefined,
        allowedDomains: typeof browserBody.allowedDomains === 'string'
          ? browserBody.allowedDomains.split(',').map((item) => item.trim()).filter(Boolean)
          : Array.isArray(browserBody.allowedDomains)
            ? browserBody.allowedDomains.filter((item): item is string => typeof item === 'string')
            : undefined,
        defaultTimeoutMs:
          typeof browserBody.defaultTimeoutMs === 'number'
            ? browserBody.defaultTimeoutMs
            : typeof browserBody.defaultTimeoutMs === 'string' && browserBody.defaultTimeoutMs.trim()
              ? Number(browserBody.defaultTimeoutMs)
              : undefined,
        allowEvaluate: browserBody.allowEvaluate === true,
      });
    }

    const preferences = isPlainRecord(body.preferences)
      ? readGuiPreferences({ gui: body.preferences })
      : readGuiPreferences(raw);
    raw.gui = preferences;
    await persistHadamardSettingsStore(store.configPath, raw);
    await loadJsonConfigFile(store.configPath);

    const permissionPreset = typeof body.permissionPreset === 'string' && body.permissionPreset
      ? body.permissionPreset.toLowerCase().replace(/[ _]/g, '-')
      : '';
    const effort = typeof body.effort === 'string'
      ? body.effort.toLowerCase()
      : '';

    let applyError: string | undefined;
    try {
      await reloadSdk();
    } catch (error) {
      applyError = (error as Error).message;
    }
    if (permissionPreset) {
      await setPermissionPreset(permissionPreset);
    }
    if (effort === 'auto' || isEffort(effort)) {
      await session.mergeMetadata({ __hadamardEffort: effort });
    }
    invalidateHeavyState();
    return {
      ...await state(),
      settingsApplyError: applyError,
    };
  }

  function dataRootStatus() {
    const root = resolveGuiHomeDir();
    const summary = summarizeHadamardHome(root);
    return {
      root,
      pointerPath: getHadamardHomePointerPath(pointerHomeDir()),
      summary: {
        bytes: summary.bytes,
        entries: summary.entries,
      },
      contents: listHadamardHomeTopLevelEntries(root),
      retainedAfterMigration: true,
    };
  }

  async function changeDataRoot(body: Record<string, unknown>) {
    const targetRaw = typeof body.targetRoot === 'string' ? body.targetRoot.trim() : '';
    if (!targetRaw) throw new Error('Target data root is required');
    if (body.confirmed !== true) throw new Error('Confirmation is required before migrating the data root');

    const sourceRoot = resolveGuiHomeDir();
    const targetRoot = path.resolve(targetRaw);
    const sourceResolved = path.resolve(sourceRoot);
    const sameRoot = process.platform === 'win32'
      ? sourceResolved.toLowerCase() === targetRoot.toLowerCase()
      : sourceResolved === targetRoot;
    if (sameRoot) {
      return { ok: true, changed: false, dataRoot: dataRootStatus(), state: await state() };
    }

    const migration = await migrateHadamardHomeData({
      sourceRoot,
      targetRoot,
      osHomeDir: pointerHomeDir(),
    });
    guiHomeOverride = migration.targetRoot;
    if (!options.configPath) {
      clearLoadedJsonConfig();
      await loadJsonConfigFile(path.join(migration.targetRoot, 'settings.json')).catch(() => undefined);
    }

    let applyError: string | undefined;
    try {
      await reloadSdk();
    } catch (error) {
      applyError = (error as Error).message;
    }
    invalidateHeavyState();
    await syncRailReminders().catch(() => undefined);
    return {
      ok: true,
      changed: true,
      migration,
      dataRoot: dataRootStatus(),
      state: {
        ...await state(),
        settingsApplyError: applyError,
      },
    };
  }

  async function setPermissionPreset(key: string): Promise<GuiRunEvent[]> {
    const presets: Record<string, { mode: HadamardPermissionMode; rules: HadamardPermissionRule[]; label: string }> = {
      'read-only': {
        mode: 'default',
        rules: READONLY_DENY.map(toolName => ({ toolName, behavior: 'deny', source: 'permissions-preset' })),
        label: 'Read-only',
      },
      workspace: { mode: 'acceptEdits', rules: [], label: 'Workspace access' },
      full: { mode: 'bypassPermissions', rules: [], label: 'Full access' },
    };
    const preset = presets[key];
    if (!preset) return [{ type: 'error', message: `unknown permission preset: ${key}` }];
    await session.setPermissionContext({ mode: preset.mode, permissions: preset.rules, approver });
    return [{ type: 'notice', message: `permissions: ${preset.label} (${preset.mode})` }];
  }

  async function runWorkflow(name: string, input?: string): Promise<GuiRunEvent[]> {
    return withRuntimeRun(`workflow:${name}`, () => runWorkflowLeased(name, input));
  }

  async function runWorkflowLeased(name: string, input?: string): Promise<GuiRunEvent[]> {
    const workflow = loadWorkflow(name, workDir);
    if (!workflow) return [{ type: 'error', message: `workflow not found: ${name}` }];
    const events: GuiRunEvent[] = [{ type: 'notice', message: `running workflow: ${name}` }];
    const { WorkflowScriptRuntime } = await import('../workflow/workflowScriptRuntime.js');
    const runtime = new WorkflowScriptRuntime({
      sdk: sdk as any,
      trust: 'trusted',
      args: input,
      onEvent: (event: any) => {
        if (event.type === 'workflow.phase.start') events.push({ type: 'notice', message: `phase: ${event.title}` });
        if (event.type === 'workflow.agent.start') events.push({ type: 'notice', message: `agent: ${event.label ?? event.agentId}` });
        if (event.type === 'workflow.log') events.push({ type: 'notice', message: String(event.message) });
      },
    });
    const output = await runtime.execute(workflow.script);
    if (typeof output.result === 'string' && output.result.trim()) {
      events.push({ type: 'command.result', title: 'workflow result', text: output.result });
    }
    if (output.state.errors.length > 0) {
      events.push({ type: 'error', message: `${output.state.errors.length} errors during workflow execution` });
    }
    return events;
  }

  // ── Assistant (Global / Project Manager) ─────────────────────────
  // Project scope: per-workspace governance agent (createManagerTools).
  // Global scope: cross-project + settings tools (createAssistantGlobalTools),
  // with an independent session under <data-root>/assistant/.
  let managerGuiSession: AgentSession | null = null;
  let assistantGlobalSdk: HadamardAgentClient | null = null;
  let assistantGlobalSession: AgentSession | null = null;
  const teamProposals = new TeamProposalStore();
  const assistantProposals = new AssistantProposalStore();

  function managerHomeDir(): string {
    return resolveGuiHomeDir();
  }

  function assistantSessionDirectory(homeDir = managerHomeDir()): string {
    return path.join(homeDir, 'assistant');
  }

  async function createSessionCenterCatalog(): Promise<SessionCatalog> {
    const homeDir = managerHomeDir();
    const registry = await readWorkspaceRegistry(homeDir);
    const projectPaths = uniquePaths([workDir, ...registry.map(item => item.path)]);
    const runningSessionIds = new Set(
      [...runs.values()]
        .filter(run => run.desc.status === 'running')
        .map(run => run.desc.sessionId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    const waitingSessionIds = new Set<string>();
    await Promise.all(projectPaths.map(async projectPath => {
      const root = getHadamardProjectSessionDirectory(projectPath, homeDir);
      const tasks = await new BackgroundTaskStore(root).list().catch(() => []);
      for (const task of tasks) {
        if (task.status !== 'queued') continue;
        if (task.sessionId) waitingSessionIds.add(task.sessionId);
        if (task.parentSessionId) waitingSessionIds.add(task.parentSessionId);
      }
    }));
    return new SessionCatalog({
      homeDir,
      projectPaths,
      globalAssistantRoot: assistantSessionDirectory(homeDir),
      activity: { runningSessionIds, waitingSessionIds },
    });
  }

  async function selectAssistantCatalogItem(
    item: import('../storage/sessionCatalog.js').SessionCatalogItem,
  ): Promise<void> {
    const homeDir = managerHomeDir();
    if (item.type === 'assistant-global') {
      const config = await readAssistantConfig(homeDir);
      await writeAssistantConfig({ ...config, activeSessionId: item.locator.sessionId }, homeDir);
      assistantGlobalSession = null;
      return;
    }
    if (item.type === 'assistant-project' && item.projectPath) {
      const config = await readManagerConfig(item.projectPath, homeDir);
      await writeManagerConfig(item.projectPath, homeDir, {
        ...config,
        activeSessionId: item.locator.sessionId,
      });
      if (normalizeFsPath(item.projectPath) === normalizeFsPath(projectPrimaryPath)) managerGuiSession = null;
    }
  }

  async function selectAssistantFallback(
    item: import('../storage/sessionCatalog.js').SessionCatalogItem,
    catalog: SessionCatalog,
  ): Promise<void> {
    if (item.type !== 'assistant-global' && item.type !== 'assistant-project') return;
    const sameType = await catalog.query({
      types: [item.type],
      archived: false,
      ...(item.projectPath ? { projectPaths: [item.projectPath] } : {}),
      pageSize: 1,
    });
    const next = sameType.items[0] ?? await catalog.action({
      action: 'create',
      type: item.type,
      ...(item.projectPath ? { projectPath: item.projectPath } : {}),
      model: session.model,
    });
    await selectAssistantCatalogItem(next);
  }

  async function closeAssistantGlobalSdk(): Promise<void> {
    const previous = assistantGlobalSdk;
    assistantGlobalSdk = null;
    assistantGlobalSession = null;
    if (previous) await previous.close().catch(() => undefined);
  }

  async function resetManagerAndAssistantSessions(): Promise<void> {
    managerGuiSession = null;
    await closeAssistantGlobalSdk();
  }

  async function getManagerSession(): Promise<AgentSession> {
    if (managerGuiSession) return managerGuiSession;
    const homeDir = managerHomeDir();
    const config = await readManagerConfig(projectPrimaryPath, homeDir);
    const stored = await sdk!.sessions.list();
    const managers = stored
      .filter(item => item.kind === 'manager')
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const existing = managers.find(item => item.id === config.activeSessionId) ?? managers[0];
    if (existing) {
      managerGuiSession = await sdk!.resumeSession(existing.id, { permissionMode: 'bypassPermissions' });
      if (config.activeSessionId !== existing.id) {
        await writeManagerConfig(projectPrimaryPath, homeDir, { ...config, activeSessionId: existing.id });
      }
      return managerGuiSession;
    }
    managerGuiSession = await sdk!.createSession({
      title: 'Manager',
      kind: 'manager',
      metadata: { __hadamardKind: 'manager', __hadamardAssistantScope: 'project' },
      permissionMode: 'bypassPermissions',
    });
    await writeManagerConfig(projectPrimaryPath, homeDir, { ...config, activeSessionId: managerGuiSession.id });
    return managerGuiSession;
  }

  async function getAssistantGlobalSdk(): Promise<HadamardAgentClient> {
    if (assistantGlobalSdk) return assistantGlobalSdk;
    if (needsCredentials || !sdk) {
      throw new Error('No API key configured — open Settings → Models to add one.');
    }
    const homeDir = managerHomeDir();
    const sessionDirectory = assistantSessionDirectory(homeDir);
    await mkdir(sessionDirectory, { recursive: true });
    assistantGlobalSdk = await createAgentSdk({
      ...(currentHomeInput() ? { homeDir: currentHomeInput() } : {}),
      workDir: sessionDirectory,
      sessionDirectory,
      tools: [],
      permissionMode: 'bypassPermissions',
      ...(options.model ? { model: options.model } : {}),
    });
    return assistantGlobalSdk;
  }

  async function getAssistantGlobalSession(): Promise<AgentSession> {
    if (assistantGlobalSession) return assistantGlobalSession;
    const client = await getAssistantGlobalSdk();
    const homeDir = managerHomeDir();
    const config = await readAssistantConfig(homeDir);
    const stored = await client.sessions.list();
    const managers = stored
      .filter(item => item.kind === 'manager')
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const existing = managers.find(item => item.id === config.activeSessionId) ?? managers[0];
    if (existing) {
      assistantGlobalSession = await client.resumeSession(existing.id, { permissionMode: 'bypassPermissions' });
      if (config.activeSessionId !== existing.id) {
        await writeAssistantConfig({ ...config, activeSessionId: existing.id }, homeDir);
      }
      return assistantGlobalSession;
    }
    assistantGlobalSession = await client.createSession({
      title: 'Assistant (Global)',
      kind: 'manager',
      metadata: { __hadamardKind: 'manager', __hadamardAssistantScope: 'global' },
      permissionMode: 'bypassPermissions',
    });
    await writeAssistantConfig({ ...config, activeSessionId: assistantGlobalSession.id }, homeDir);
    return assistantGlobalSession;
  }

  async function persistAssistantTeamPreferences(prefs: typeof teamPrefs): Promise<void> {
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    }).catch(() => undefined);
    const raw = isPlainRecord(store?.raw) ? structuredClone(store.raw) : {};
    writeTeamPreferences(raw, prefs);
    if (store) {
      await persistHadamardSettingsStore(store.configPath, raw);
      await loadJsonConfigFile(store.configPath);
    }
    teamPrefs = prefs;
    invalidateHeavyState();
  }

  function buildAssistantGlobalHost(
    homeDir: string,
    editorContext?: AssistantEditorContext,
  ): Parameters<typeof createAssistantGlobalTools>[0] {
    return {
      homeDir,
      currentWorkDir: workDir,
      getAppState: () => ({
        region: 'gui',
        workDir,
        needsCredentials,
        activeAgent: activeBridgeConfig?.name ?? null,
        bridgeMode,
        model: session?.model ?? null,
      }),
      getEditorContext: () => editorContext ?? null,
      openProject: async (projectPath: string) => {
        await switchProject(projectPath);
        invalidateHeavyState();
        return { workDir };
      },
      applySettings: async (patch: Record<string, unknown>) => {
        await withRuntimeMutation(async () => {
          await saveSettings(patch);
        });
        return { ok: true, detail: 'Settings applied' };
      },
      activateAgent: async (name: string) => {
        await withRuntimeMutation(async () => {
          const resolved = await resolveSelectableAgentRun(name, homeDir);
          const cfg = {
            ...resolved.bridgeConfig,
            model: resolved.selectable.model,
          };
          await activateBridgeConfig(cfg);
          await persistSessionRuntimeMetadata();
          const effort = resolved.profile.effort || resolved.selectable.effort;
          if (effort === 'auto' || isEffort(effort)) {
            await session.mergeMetadata({ __hadamardEffort: effort });
          }
        });
        invalidateHeavyState();
        return { ok: true, detail: `Activated ${name}` };
      },
      // P3: ActivateAgent kind=router|team — same effects as /api/router/activate
      // and /team attach.
      activateTarget: async (kind: 'config' | 'router' | 'team', name: string) => {
        await withRuntimeMutation(async () => {
          if (kind === 'config') {
            const config = findBridgeConfig(name, homeDir);
            if (!config) throw new Error(`Provider configuration not found: ${name}`);
            await activateBridgeConfig(config);
          } else if (kind === 'router') {
            const loaded = loadRouterProfile(name, workDir, homeDir);
            if (!loaded) throw new Error(`Configured router not found: ${name}`);
            disableBridge();
            activeRouter = loaded.profile;
            routedModelLabel = null;
          } else {
            const definition = attachTeamByName(name);
            if (!definition) throw new Error(`Team not found: ${name}`);
          }
          await persistSessionRuntimeMetadata();
        });
        invalidateHeavyState();
        return {
          ok: true,
          detail: kind === 'config'
            ? `Activated provider configuration ${name}`
            : kind === 'router'
              ? `Activated router ${name}`
              : `Attached team ${name}`,
        };
      },
      // P3: reference snapshot extras (session/preference edges) and the
      // rename/delete transaction context — same semantics as the endpoints.
      getSessionRefState: () => ({
        activeAgent: activeAgentSelectionName,
        activeConfig: activeBridgeConfig?.name ?? null,
        activeRouterName: activeRouter?.name ?? null,
        activeTeamName,
      }),
      readTeamPreferences: () => teamPrefs,
      writeTeamPreferences: persistAssistantTeamPreferences,
      referenceOperationContext: async () => {
        return {
          projectDir: workDir,
          homeDir,
          managerProjectPath: projectPrimaryPath,
          teamPreferences: {
            read: () => teamPrefs,
            write: persistAssistantTeamPreferences,
          },
          issues: {
            read: async () => {
              const storage = await issueStorageFor(workDir, resolveGuiHomeDir());
              return listProjectIssues(workDir, resolveGuiHomeDir(), storage);
            },
            writeAgentConfig: async (id: string, agentConfig: string | null) => {
              const storage = await issueStorageFor(workDir, resolveGuiHomeDir());
              await updateProjectIssue(workDir, resolveGuiHomeDir(), id, { agentConfig }, storage);
            },
          },
          assistantConfig: {
            read: () => readAssistantConfig(resolveGuiHomeDir()),
            write: async (patch: { bridgeConfig?: string }) => {
              const current = await readAssistantConfig(resolveGuiHomeDir());
              await writeAssistantConfig({ ...current, ...patch }, resolveGuiHomeDir());
            },
          },
        };
      },
      readSettingsRaw: async () => {
        const store = await resolveHadamardSettingsStore({
          configPath: options.configPath,
          homeDir: currentHomeInput(),
        });
        return structuredClone(store.raw);
      },
      writeSettingsRaw: async (raw: Record<string, unknown>) => {
        const store = await resolveHadamardSettingsStore({
          configPath: options.configPath,
          homeDir: currentHomeInput(),
        });
        await persistHadamardSettingsStore(store.configPath, raw);
        await loadJsonConfigFile(store.configPath);
        invalidateHeavyState();
      },
    };
  }

  /** Host-collected read-only context for Manager runs (the Manager has no shell). */
  async function collectManagerHostContext(): Promise<{
    gitSummary: string;
    conversationSummaries: string;
    sessionSummaries: Array<{
      id: string;
      title: string;
      preview: string;
      status: string;
      updatedAt: string;
      messageCount: number;
    }>;
  }> {
    let gitSummary = '';
    try {
      const [branch, dirty, log] = await Promise.all([
        gitText(['rev-parse', '--abbrev-ref', 'HEAD']),
        gitText(['status', '--porcelain']),
        gitText(['log', '--oneline', '-10']),
      ]);
      gitSummary = `branch: ${branch}\ndirty files: ${dirty ? dirty.split('\n').length : 0}\nrecent commits:\n${log}`;
    } catch { /* not a git repo */ }
    let conversationSummaries = '';
    let sessionSummaries: Array<{
      id: string;
      title: string;
      preview: string;
      status: string;
      updatedAt: string;
      messageCount: number;
    }> = [];
    try {
      const stored = await sdk!.sessions.list();
      sessionSummaries = stored
        .filter(item => isVisibleChatSession(item) && !isEmptyUserSessionSummary(item))
        .map(s => ({
          id: s.id,
          title: s.title,
          preview: s.preview,
          status: s.status,
          updatedAt: s.updatedAt,
          messageCount: s.messageCount,
        }));
      conversationSummaries = sessionSummaries
        .slice(0, 20)
        .map(s => `- [${s.updatedAt.slice(0, 10)}] ${s.title} (${s.messageCount} msgs): ${s.preview}`)
        .join('\n');
    } catch { /* session listing unavailable */ }
    return { gitSummary, conversationSummaries, sessionSummaries };
  }

  /**
   * Run one Assistant turn. Project scope: Design update or governance chat.
   * Global scope: cross-project / settings chat (update mode is rejected).
   */
  async function runManagerTurn(opts: {
    mode: 'update' | 'chat';
    scope?: 'global' | 'project';
    instruction?: string;
    text?: string;
    send: (event: GuiRunEvent) => void;
    clientRequestId?: string;
    replayEvents?: Array<GuiRunEvent & { sequence: number }>;
    editorContext?: AssistantEditorContext;
  }): Promise<string> {
    const scope = opts.scope === 'global' ? 'global' : 'project';
    const label = scope === 'global'
      ? 'assistant:global'
      : (opts.mode === 'update' ? 'manager:update' : 'manager:chat');
    return withRuntimeRun(label, () => runManagerTurnLeased({ ...opts, scope }));
  }

  async function runManagerTurnLeased(opts: {
    mode: 'update' | 'chat';
    scope: 'global' | 'project';
    instruction?: string;
    text?: string;
    send: (event: GuiRunEvent) => void;
    clientRequestId?: string;
    replayEvents?: Array<GuiRunEvent & { sequence: number }>;
    editorContext?: AssistantEditorContext;
  }): Promise<string> {
    if (needsCredentials || !sdk) throw new Error('No API key configured — open Settings → Models to add one.');
    for (const run of runs.values()) {
      if (run.desc.kind === 'manager' && run.desc.status === 'running') {
        throw new Error('An Assistant run is already in progress.');
      }
    }
    const homeDir = managerHomeDir();
    const scope = opts.scope;

    if (scope === 'global' && opts.mode === 'update') {
      throw new Error('Update Design is only available in Project scope.');
    }

    let prompt: string;
    let managerTools: Awaited<ReturnType<typeof createManagerTools>>;
    let systemPrompt: string;
    let managerModel: string | null;
    let managerModelApi: Awaited<ReturnType<typeof buildRouteModelApi>>['modelApi'] | undefined;
    let managerSession: AgentSession;

    if (scope === 'global') {
      const cfg = await readAssistantConfig(homeDir);
      managerSession = await getAssistantGlobalSession();
      managerTools = [
        ...await createAssistantGlobalTools({
          ...buildAssistantGlobalHost(homeDir, opts.editorContext),
          assistantSessionId: managerSession.id,
          proposals: assistantProposals,
          teamProposals,
          onProposal: proposal => opts.send({ type: 'assistant.proposal', proposal }),
          onTeamProposal: proposal => opts.send({ type: 'team.proposal', proposal }),
        }),
        ...createAssistantTeamTools({
          scope: 'global',
          assistantSessionId: managerSession.id,
          currentWorkDir: workDir,
          homeDir,
          proposals: teamProposals,
          onProposal: proposal => opts.send({ type: 'team.proposal', proposal }),
        }),
      ];
      systemPrompt = `${buildAssistantGlobalSystemPrompt(workDir)}\n${buildAssistantTeamSystemPrompt('global')}`;
      prompt = opts.text?.trim() ?? '';
      if (!prompt) throw new Error('Empty assistant message.');
      managerModel = cfg.model ?? session.model ?? null;
      managerModelApi = undefined;
      if (cfg.bridgeConfig) {
        const bridgeCfg = findBridgeConfig(cfg.bridgeConfig, homeDir);
        if (!bridgeCfg) throw new Error(`Assistant provider config "${cfg.bridgeConfig}" not found.`);
        const hadamardUsesDefaults = bridgeCfg.runtime === 'hadamard'
          && !(typeof bridgeCfg.apiKey === 'string' && bridgeCfg.apiKey.trim())
          && !(typeof bridgeCfg.baseURL === 'string' && bridgeCfg.baseURL.trim());
        if (hadamardUsesDefaults) {
          managerModel = cfg.model || bridgeCfg.model || session.model || null;
        } else {
          const routed = await buildRouteModelApi({
            model: cfg.model || bridgeCfg.model || session.model || 'default',
            provider: bridgeCfg.provider,
            baseURL: bridgeCfg.baseURL,
            apiKey: bridgeCfg.apiKey,
            maxTokens: 32000,
          });
          managerModel = routed.model;
          managerModelApi = routed.modelApi;
        }
      }
    } else {
      const cfg = await readManagerConfig(projectPrimaryPath, homeDir);
      const managerIssueStorage = await issueStorageFor(projectPrimaryPath, homeDir);
      managerSession = await getManagerSession();
      managerTools = [
        ...await createManagerTools({
          projectPath: projectPrimaryPath,
          workDir,
          homeDir,
          config: cfg,
          issueStorageMode: managerIssueStorage,
        }),
        ...createAssistantTeamTools({
          scope: 'project',
          assistantSessionId: managerSession.id,
          currentWorkDir: workDir,
          homeDir,
          proposals: teamProposals,
          onProposal: proposal => opts.send({ type: 'team.proposal', proposal }),
        }),
      ];
      systemPrompt = `${buildManagerSystemPrompt(workDir, cfg)}\n${buildAssistantTeamSystemPrompt('project')}`;
      if (opts.mode === 'update') {
        const { gitSummary, conversationSummaries, sessionSummaries } = await collectManagerHostContext();
        const plan = await readProjectPlanFile(projectPrimaryPath, homeDir);
        const design = await readDesignFile(projectPrimaryPath, homeDir);
        const issues = await listProjectIssues(projectPrimaryPath, homeDir, managerIssueStorage);
        const githubDigest = await resolveGitHubDigestForUpdate(workDir, opts.instruction);
        prompt = buildUpdateDesignPrompt({
          instruction: opts.instruction,
          gitSummary,
          conversationSummaries,
          githubDigest,
          currentPlanJson: JSON.stringify(plan, null, 2),
          currentDesign: design ?? undefined,
          currentIssuesJson: JSON.stringify(issues.map(issue => ({
            key: `ISS-${issue.number}`,
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
            agentConfig: issue.agentConfig,
            activeSessionId: issue.activeSessionId,
            linkedSessions: issue.sessionIds
              .map(id => sessionSummaries.find(summary => summary.id === id))
              .filter(Boolean),
            updatedAt: issue.updatedAt,
          })), null, 2),
        });
      } else {
        prompt = opts.text?.trim() ?? '';
        if (!prompt) throw new Error('Empty manager message.');
      }
      managerModel = cfg.model ?? session.model ?? null;
      managerModelApi = undefined;
      if (cfg.bridgeConfig) {
        const bridgeCfg = findBridgeConfig(cfg.bridgeConfig, homeDir);
        if (!bridgeCfg) throw new Error(`Manager provider config "${cfg.bridgeConfig}" not found.`);
        const hadamardUsesDefaults = bridgeCfg.runtime === 'hadamard'
          && !(typeof bridgeCfg.apiKey === 'string' && bridgeCfg.apiKey.trim())
          && !(typeof bridgeCfg.baseURL === 'string' && bridgeCfg.baseURL.trim());
        if (hadamardUsesDefaults) {
          managerModel = cfg.model || bridgeCfg.model || session.model || null;
        } else {
          const routed = await buildRouteModelApi({
            model: cfg.model || bridgeCfg.model || session.model || 'default',
            provider: bridgeCfg.provider,
            baseURL: bridgeCfg.baseURL,
            apiKey: bridgeCfg.apiKey,
            maxTokens: 32000,
          });
          managerModel = routed.model;
          managerModelApi = routed.modelApi;
        }
      }
    }

    const runId = 'r-mgr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const abort = new AbortController();
    const desc: GuiRunDescriptor = {
      runId, clientRequestId: opts.clientRequestId,
      kind: 'manager',
      label: scope === 'global'
        ? 'assistant:global'
        : (opts.mode === 'update' ? 'manager:update' : 'manager:chat'),
      sessionId: managerSession.id, model: managerModel, startedAt: Date.now(),
      status: 'running', toolCalls: 0, tokenUsage: { input: 0, output: 0 },
    };
    const record: GuiRunRecord = { desc, abort, sink: opts.send, events: opts.replayEvents };
    assertRunCanStart();
    runs.set(runId, record);
    try {
      opts.send({ type: 'run.started', runId, model: desc.model });
      try {
        const compactResult = await managerSession.compact({});
        if (compactResult.compacted) {
          opts.send({
            type: 'status',
            message: `assistant · compacted ${compactResult.messagesRemoved ?? '?'} older messages`,
            runId,
          });
        }
      } catch { /* auto-compact is best-effort */ }
      const runOptions = {
        systemPrompt,
        tools: managerTools,
        signal: abort.signal,
        ...(managerModel ? { model: managerModel } : {}),
        ...(managerModelApi ? { modelApi: managerModelApi } : {}),
        __hadamardUseDefaultTools: false,
        __hadamardAllowedTools: managerTools.map(tool => tool.name),
      } as Parameters<typeof managerSession.stream>[1];
      const stream = managerSession.stream(prompt, runOptions);
      for await (const event of stream) {
        forwardAgentEvent(event, opts.send, runId);
        if (event.type === 'tool.call') {
          desc.toolCalls += 1;
          desc.currentTool = event.call.publicName;
        } else if (event.type === 'tool.result') {
          desc.currentTool = undefined;
        }
      }
      const result = await stream.result;
      desc.status = 'done';
      recordUsage(desc.model ?? session.model, result.usage as { input_tokens?: number; output_tokens?: number } | undefined);
      return result.text ?? '';
    } catch (error) {
      desc.status = abort.signal.aborted ? 'aborted' : 'error';
      throw error;
    } finally {
      retainRunReplay(record);
      runs.delete(runId);
      invalidateHeavyState();
    }
  }

  async function resyncAutomationScheduler(): Promise<void> {
    for (const id of scheduledAutomationIds) {
      await automationScheduler.remove(id).catch(() => undefined);
    }
    scheduledAutomationIds.clear();
    for (const task of await listScheduledAutomationTasks(workDir)) {
      // Webhook tasks fire on demand via /api/automation/webhook/:id — skip the cron scheduler.
      if ((task.trigger ?? 'schedule') === 'webhook' || !task.cron) continue;
      await automationScheduler.schedule({
        id: task.id,
        schedule: { cron: task.cron },
        description: task.name,
        enabled: task.enabled,
        task: async () => {
          const latest = await getScheduledAutomationTask(workDir, task.id);
          if (!latest || !latest.enabled) return;
          await executeScheduledAutomationTask(latest);
        },
      });
      scheduledAutomationIds.add(task.id);
    }
    if (!automationScheduler.isRunning) automationScheduler.start();
  }

  async function saveScheduledAutomationTask(input: ScheduledAutomationTaskInput): Promise<ScheduledAutomationTask> {
    if (input.kind === 'workflow') {
      const existing = input.id ? await getScheduledAutomationTask(workDir, input.id) : undefined;
      const target = {
        workflowName: input.workflowName ?? existing?.workflowName,
        workflowSource: input.workflowSource ?? existing?.workflowSource,
      };
      if (target.workflowSource === 'agent') {
        resolveScheduledAutomationWorkflow(target, workDir, resolveGuiHomeDir());
      }
    }
    const task = await upsertScheduledAutomationTask(workDir, input);
    await resyncAutomationScheduler();
    return task;
  }

  async function executeScheduledAutomationTask(task: ScheduledAutomationTask): Promise<GuiRunEvent[]> {
    return withRuntimeRun(`automation:${task.name}`, () => executeScheduledAutomationTaskLeased(task));
  }

  async function executeScheduledAutomationTaskLeased(task: ScheduledAutomationTask): Promise<GuiRunEvent[]> {
    const events: GuiRunEvent[] = [{ type: 'notice', message: `automation: ${task.name}` }];
    try {
      if (task.kind === 'workflow') {
        const workflowEvents = await runScheduledAutomationWorkflow(task);
        events.push(...workflowEvents);
        const failure = workflowEvents.find(event => event.type === 'error');
        if (failure) throw new Error(String(failure.message ?? 'workflow failed'));
      } else if (task.kind === 'manager') {
        // Scheduled Manager Design update. `input` is an optional
        // instruction; the run streams into the collected events.
        const text = await runManagerTurn({
          mode: 'update',
          instruction: task.input?.trim() || undefined,
          send: (event) => { events.push(event); },
        });
        events.push({ type: 'command.result', title: 'Manager · Design updated', text });
      } else {
        if (!task.prompt) throw new Error('Scheduled prompt task is missing prompt');
        events.push(...await runAutomationPrompt(task));
      }
      await recordScheduledAutomationRun(workDir, task.id, 'success');
    } catch (error) {
      const message = (error as Error).message;
      events.push({ type: 'error', message });
      await recordScheduledAutomationRun(workDir, task.id, message.includes('timed out') ? 'timeout' : 'failure', message);
    } finally {
      await resyncAutomationScheduler();
    }
    return events;
  }

  async function runScheduledAutomationWorkflow(task: ScheduledAutomationTask): Promise<GuiRunEvent[]> {
    const target = resolveScheduledAutomationWorkflow(task, workDir, resolveGuiHomeDir());
    if (target.source === 'script') return runWorkflow(task.workflowName!, task.input);

    const definition = instantiateTeamDefinition(target.definition, session.model);
    const abort = new AbortController();
    const result = await askTeamDefinition(
      definition,
      task.input ?? '',
      abort.signal,
      {
        workDir,
        homeDir: resolveGuiHomeDir(),
        model: activeBridgeModelApi?.model ?? session.model,
        modelApi: activeBridgeModelApi?.modelApi,
      },
    );
    return [
      { type: 'notice', message: `running Agent workflow: ${definition.name}` },
      { type: 'command.result', title: `Workflow result · ${definition.name}`, text: result.answer },
      ...(result.incompleteReason
        ? [{ type: 'error', message: `workflow incomplete: ${result.incompleteReason}` }]
        : []),
    ];
  }

  async function runAutomationPrompt(task: ScheduledAutomationTask): Promise<GuiRunEvent[]> {
    if (needsCredentials || !sdk) {
      throw new Error('No API key configured - open Settings > Models to add one.');
    }
    const input = task.prompt?.trim() ?? '';
    if (!input) throw new Error('Scheduled prompt is empty');

    const events: GuiRunEvent[] = [];
    const runId = 'r-auto-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const runAbort = new AbortController();
    const desc: GuiRunDescriptor = {
      runId,
      kind: 'background',
      label: `automation:${task.name}`,
      sessionId: session.id,
      model: session.model || null,
      startedAt: Date.now(),
      status: 'running',
      toolCalls: 0,
      tokenUsage: { input: 0, output: 0 },
    };
    const send = (event: GuiRunEvent) => { events.push(event); };
    const backgroundApprover: HadamardToolApprover = async () => ({ behavior: 'deny', reason: 'Scheduled background tasks cannot request interactive approval.' });
    assertRunCanStart();
    runs.set(runId, { desc, abort: runAbort, sink: send });
    let streamedText = '';
    try {
      let routed: { model: string; modelApi: import('../types.js').CreateAgentSdkOptions['modelApi']; effort?: HadamardRunEffort } | undefined;
      const configActive = !!activeBridgeConfig;
      if (activeRouter && !bridgeMode && !configActive) {
        const decision = await resolveRoutedRun(activeRouter, input, runAbort.signal, {
          projectDir: workDir,
          homeDir: resolveGuiHomeDir(),
        });
        routed = { model: decision.model, modelApi: decision.modelApi, effort: decision.effort };
      }
      const effectiveAgentOptions = currentEffectiveAgentRunOptions();
      const hadamardModel = (!bridgeMode && activeBridgeConfig?.runtime === 'hadamard')
        ? (activeBridgeConfig.model || undefined)
        : undefined;
      const stream = bridgeMode && activeBridgeModelApi
        ? session.stream(expandImageRefs(input, workDir), {
            ...effectiveAgentOptions,
            signal: withAgentRunTimeout(runAbort.signal),
            approver: backgroundApprover,
            classifier: preToolUseHookClassifier,
            canUseTool,
            model: activeBridgeModelApi.model,
            modelApi: activeBridgeModelApi.modelApi,
            ...(() => { const runTools = currentRunTools(); return runTools ? { tools: runTools } : {}; })(),
          })
        : session.stream(expandImageRefs(input, workDir), {
            ...effectiveAgentOptions,
            signal: withAgentRunTimeout(runAbort.signal),
            approver: backgroundApprover,
            classifier: preToolUseHookClassifier,
            canUseTool,
            // Per-route effort (router) wins over session/agent effort for the routed turn.
            ...(routed?.effort ? { effort: routed.effort } : {}),
            ...(routed ? { model: routed.model, modelApi: routed.modelApi } : {}),
            ...(hadamardModel ? { model: hadamardModel } : {}),
            ...(() => { const runTools = currentRunTools(); return runTools ? { tools: runTools } : {}; })(),
          });

      for await (const event of stream) {
        if (event.type === 'tool.call') {
          desc.toolCalls += 1;
          desc.currentTool = event.call.publicName;
        } else if (event.type === 'response.text.delta' && event.delta) {
          streamedText += event.delta;
          desc.lastText = streamedText;
        }
      }
      const result = await stream.result;
      const text = streamedText || result.text || '';
      if (text.trim()) {
        events.push({ type: 'command.result', title: `Automation result - ${task.name}`, text });
      }
      const effectiveModel = hadamardModel ?? routed?.model ?? activeBridgeModelApi?.model ?? session.model;
      recordUsage(effectiveModel, (result as any).usage);
      if ((result as any).usage) {
        desc.tokenUsage = {
          input: (result as any).usage.input_tokens ?? 0,
          output: (result as any).usage.output_tokens ?? 0,
        };
      }
      try {
        recordTurn({
          sessionId: session.id,
          ts: Math.floor(Date.now() / 1000),
          text: `automation:${task.name} ${input}`.slice(0, 200),
          model: effectiveModel,
        }, resolveGuiHomeDir());
      } catch { /* never fail automation over history */ }
      desc.status = 'done';
      return events;
    } catch (error) {
      desc.status = runAbort.signal.aborted ? 'aborted' : 'error';
      throw error;
    } finally {
      runs.delete(runId);
      invalidateHeavyState();
    }
  }

  // Live todo list captured from TodoWrite tool calls; surfaced in state() so the
  // frontend can render a persistent panel (mirrors the TUI's buildTodoPanel).
  let todos: { subject: string; status: string; activeForm?: string }[] = [];

  // ── Bridge: in-process named configs ─────────────────────────────────
  // activateBridgeConfig pre-builds a ModelApi via buildRouteModelApi and stores
  // it; streamRun injects {model, modelApi} per-run on the SAME session, so
  // context survives switching bridge↔hadamard. No child process anywhere.
  async function activateBridgeConfig(config: PersistedBridgeConfig): Promise<boolean> {
    if (config.execution === 'cli') {
      if (!isManagedExternalCliRuntime(config.runtime)) {
        throw new Error(
          'External CLI mode requires an installed CLI runtime.',
        );
      }
      activeBridgeConfig = config;
      activeBridgeModelApi = null;
      bridgeMode = true;
      bridgeModelLabel = config.model || null;
      return true;
    }
    // Hadamard without credentials: model-only override on the SDK default provider.
    // Hadamard WITH apiKey/baseURL (or any non-hadamard runtime): build a ModelApi
    // so the named config's provider credentials are used for every turn.
    const hadamardUsesDefaults = config.runtime === 'hadamard'
      && !(typeof config.apiKey === 'string' && config.apiKey.trim())
      && !(typeof config.baseURL === 'string' && config.baseURL.trim());
    if (hadamardUsesDefaults) {
      activeBridgeConfig = config;
      activeBridgeModelApi = null;
      bridgeMode = false;
      bridgeModelLabel = config.model || null;
      return true;
    }
    const routed = await buildRouteModelApi({
      model: config.model || session.model,
      provider: config.provider,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      maxTokens: 32000,
    });
    activeBridgeModelApi = routed;
    bridgeModelLabel = routed.model;
    activeBridgeConfig = config;
    bridgeMode = true;
    return true;
  }
  function disableBridge(): void {
    bridgeMode = false;
    activeBridgeConfig = null;
    activeAgentSelectionName = null;
    activeBridgeModelApi = null;
    bridgeModelLabel = null;
    // session context stays intact — switching back to the default provider.
  }

  // ── Goal: project-scoped durable objective ─────────────────────────────
  const RUNTIME_METADATA_KEY = '__hadamardRuntime';
  const CONFIG_NAME_METADATA_KEY = '__hadamardConfigName';
  const RUNTIME_MODEL_METADATA_KEY = '__hadamardRuntimeModel';
  const AGENT_SELECTION_METADATA_KEY = '__hadamardAgentSelection';
  const ROUTER_NAME_METADATA_KEY = '__hadamardRouterName';
  const EXTERNAL_SESSION_METADATA_KEY = '__hadamardExternalSessionId';
  const EXTERNAL_SESSIONS_METADATA_KEY = '__hadamardExternalSessions';
  interface ExternalSessionBinding {
    runtime: ManagedExternalCliRuntime;
    configName: string;
    cwd: string;
    nativeSessionId: string;
    updatedAt: string;
  }
  function sameWorkspace(left: string, right: string): boolean {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  function externalSessionBindingKey(
    config: SupportedExternalCliConfig,
    targetWorkDir = workDir,
  ): string {
    return createHash('sha256')
      .update(config.runtime + '\u0000' + config.name + '\u0000' + path.resolve(targetWorkDir))
      .digest('hex')
      .slice(0, 24);
  }
  function externalSessionBindings(
    targetSession: AgentSession = session,
  ): Record<string, ExternalSessionBinding> {
    const raw = targetSession.metadata[EXTERNAL_SESSIONS_METADATA_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const bindings: Record<string, ExternalSessionBinding> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (
        !isManagedExternalCliRuntime(record.runtime as BridgeRuntime)
        || typeof record.configName !== 'string'
        || typeof record.cwd !== 'string'
        || typeof record.nativeSessionId !== 'string'
        || !record.nativeSessionId
      ) continue;
      bindings[key] = {
      runtime: record.runtime as ManagedExternalCliRuntime,
        configName: record.configName,
        cwd: record.cwd,
        nativeSessionId: record.nativeSessionId,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
      };
    }
    return bindings;
  }
  function externalNativeSessionId(
    config: SupportedExternalCliConfig,
    targetSession: AgentSession = session,
    targetWorkDir = workDir,
  ): string | undefined {
    const binding = externalSessionBindings(targetSession)[
      externalSessionBindingKey(config, targetWorkDir)
    ];
    if (
      !binding
      || binding.runtime !== config.runtime
      || binding.configName !== config.name
      || !sameWorkspace(binding.cwd, targetWorkDir)
    ) return undefined;
    return binding.nativeSessionId;
  }
  async function rememberExternalNativeSession(
    config: SupportedExternalCliConfig,
    nativeSessionId: string,
    targetSession: AgentSession = session,
    targetWorkDir = workDir,
  ): Promise<void> {
    if (!nativeSessionId) return;
    const bindings = externalSessionBindings(targetSession);
    bindings[externalSessionBindingKey(config, targetWorkDir)] = {
      runtime: config.runtime,
      configName: config.name,
      cwd: path.resolve(targetWorkDir),
      nativeSessionId,
      updatedAt: new Date().toISOString(),
    };
    await targetSession.mergeMetadata({
      [EXTERNAL_SESSIONS_METADATA_KEY]: bindings,
      [EXTERNAL_SESSION_METADATA_KEY]: undefined,
    });
  }
  async function migrateLegacyExternalSessionBinding(): Promise<void> {
    const legacySessionId = session.metadata[EXTERNAL_SESSION_METADATA_KEY];
    const configName = session.metadata[CONFIG_NAME_METADATA_KEY];
    const runtime = session.metadata[RUNTIME_METADATA_KEY];
    if (
      typeof legacySessionId !== 'string'
      || !legacySessionId
      || typeof configName !== 'string'
      || !isManagedExternalCliRuntime(runtime as BridgeRuntime)
    ) return;
    const config = findBridgeConfig(configName, resolveGuiHomeDir());
    if (!config || config.execution !== 'cli' || config.runtime !== runtime) return;
    await rememberExternalNativeSession(config as SupportedExternalCliConfig, legacySessionId);
  }
  async function persistSessionRuntimeMetadata(
    targetSession: AgentSession = session,
    config: PersistedBridgeConfig | null = activeBridgeConfig,
    modelLabel: string | null = bridgeModelLabel,
  ): Promise<void> {
    try {
      await targetSession.mergeMetadata({
        [RUNTIME_METADATA_KEY]: config?.runtime ?? 'hadamard',
        [CONFIG_NAME_METADATA_KEY]: config?.name ?? null,
        [RUNTIME_MODEL_METADATA_KEY]: config?.model ?? modelLabel ?? null,
        [AGENT_SELECTION_METADATA_KEY]: activeAgentSelectionName,
        [ROUTER_NAME_METADATA_KEY]: activeRouter?.name ?? null,
      });
    } catch {
      // never fail a turn over metadata write
    }
  }
  async function restoreSessionRuntimeSelection(): Promise<void> {
    const configName = session.metadata[CONFIG_NAME_METADATA_KEY];
    const routerName = session.metadata[ROUTER_NAME_METADATA_KEY];
    const storedRouter = typeof routerName === 'string' && routerName.trim()
      ? loadRouterProfile(routerName.trim(), workDir, resolveGuiHomeDir())
      : null;
    if (typeof configName !== 'string' || !configName.trim()) {
      disableBridge();
      activeRouter = storedRouter?.profile ?? null;
      routedModelLabel = null;
      return;
    }
    const stored = findBridgeConfig(configName, resolveGuiHomeDir());
    if (!stored) {
      disableBridge();
      activeRouter = storedRouter?.profile ?? null;
      routedModelLabel = null;
      return;
    }
    activeRouter = null;
    routedModelLabel = null;
    const model = session.metadata[RUNTIME_MODEL_METADATA_KEY];
    const config = typeof model === 'string' && model.trim()
      ? { ...stored, model: model.trim() }
      : stored;
    const storedAgentName = session.metadata[AGENT_SELECTION_METADATA_KEY];
    const storedAgent = typeof storedAgentName === 'string'
      ? findSelectableAgent(storedAgentName, resolveGuiHomeDir())
      : undefined;
    activeAgentSelectionName = storedAgent
      && storedAgent.bridgeConfig === config.name
      && storedAgent.model === config.model
      ? storedAgent.name
      : null;
    try {
      await activateBridgeConfig(config);
    } catch {
      disableBridge();
    }
  }
  await migrateLegacyExternalSessionBinding();
  await restoreSessionRuntimeSelection();

  function externalCliConfigId(config: PersistedBridgeConfig): string {
    const signature = JSON.stringify([
      config.runtime,
      config.authSource ?? 'native',
      config.authSource === 'apiKey' ? config.apiKey ?? '' : '',
      config.authSource === 'apiKey' ? config.baseURL ?? '' : '',
      config.credentialProvider ?? '',
      config.trustProjectResources === true,
    ]);
    const cached = externalCliConfigIdentities.get(config.name);
    if (cached?.signature === signature) return cached.id;
    const identity = {
      signature,
      id: config.name + ':' + randomBytes(12).toString('hex'),
    };
    externalCliConfigIdentities.set(config.name, identity);
    return identity.id;
  }

  function safeExternalCliRun(run: ExternalCliRunSnapshot): Omit<
    ExternalCliRunSnapshot,
    'hadamardSessionId' | 'configId' | 'events' | 'logs'
  > & { configName: string } {
    const {
      hadamardSessionId: _hadamardSessionId,
      configId: _configId,
      events: _events,
      logs: _logs,
      ...safe
    } = run;
    return {
      ...safe,
      configName: externalCliRunConfigNames.get(run.runId) ?? 'External CLI',
    };
  }

  function safeExternalCliRunSummary(run: ExternalCliRunSnapshot) {
    return {
      runId: run.runId,
      configName: externalCliRunConfigNames.get(run.runId) ?? 'External CLI',
      status: run.status,
      background: run.background,
      cwd: run.cwd,
      nativeSessionId: run.nativeSessionId ?? '',
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? '',
      finishedAt: run.finishedAt ?? '',
      lastText: run.result?.text ? run.result.text.slice(0, 240) : '',
      error: run.error?.message ?? '',
    };
  }

  function externalCliPermissionMode(): 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan' {
    const mode = currentPermissionMode();
    return mode === 'auto' ? 'default' : mode;
  }

  type SupportedExternalCliConfig = PersistedBridgeConfig & {
    runtime: ManagedExternalCliRuntime;
  };

  function isExternalCliHistoryConfigCompatible(
    summary: ExternalCliSessionSummary,
    config: PersistedBridgeConfig,
  ): config is SupportedExternalCliConfig {
    return config.execution === 'cli'
      && isManagedExternalCliRuntime(config.runtime)
      && externalCliSessionMatchesConfig(summary, {
        runtime: config.runtime,
        authSource: config.authSource,
        profileName: config.name,
      }, {
        homeDir: pointerHomeDir(),
        hadamardHomeDir: resolveGuiHomeDir(),
      });
  }

  async function startManagedExternalCliRun(
    config: SupportedExternalCliConfig,
    prompt: string,
    background: boolean,
    nativeSessionId?: string,
  ): Promise<NonNullable<ReturnType<ExternalCliRuntimeManager['get']>>> {
    const originSession = session;
    const originWorkDir = workDir;
    const storedNativeSessionId = externalNativeSessionId(config, originSession, originWorkDir);
    const externalEffort = currentEffort();
    const permissionMode = externalCliPermissionMode();
    const configId = externalCliConfigId(config);
    if (background) externalCliProtectedSessionIds.add(originSession.id);
    let run: ExternalCliRunSnapshot;
    try {
      assertRunCanStart();
      // Materialize an empty chat before launching a background run. Empty
      // sessions intentionally remain in-memory drafts, so deferring the
      // first user message until completion would let cleanup or a session
      // switch discard the draft before the result is persisted.
      await originSession.appendMessages([
        { role: 'user', content: prompt },
      ]);
      run = await externalCliRuntimeManager.start({
      hadamardSessionId: originSession.id,
      configId,
      cwd: originWorkDir,
      prompt,
      background,
      nativeSessionId: nativeSessionId
        || (typeof storedNativeSessionId === 'string' && storedNativeSessionId
          ? storedNativeSessionId
          : undefined),
      clientOptions: {
        directCliProvider: config.runtime,
        authSource: config.authSource === 'apiKey' ? 'apiKey' : 'native',
        credentialProvider: config.credentialProvider,
        profileName: config.name,
        ...(config.authSource === 'apiKey'
          ? {
              apiKey: config.apiKey,
              baseURL: config.baseURL,
            }
          : {}),
        trustProjectResources: config.trustProjectResources,
      },
      sessionOptions: {
        title: 'hadamard-gui-' + config.runtime + '-' + config.name,
      },
      runOptions: {
        model: config.model,
        effort: externalEffort === 'auto' ? undefined : externalEffort,
        permissionMode,
        includePartialMessages: true,
      },
      });
    } catch (error) {
      if (background) externalCliProtectedSessionIds.delete(originSession.id);
      throw error;
    }
    externalCliRunConfigNames.set(run.runId, config.name);
    const persistCompletedRun = async (
      completed: ExternalCliRunSnapshot | undefined,
    ): Promise<void> => {
      if (completed?.status !== 'completed' || !completed.result) return;
      const nativeSessionId = completed.nativeSessionId || completed.result.nativeSessionId;
      if (nativeSessionId) {
        await rememberExternalNativeSession(
          config,
          nativeSessionId,
          originSession,
          originWorkDir,
        );
      }
      await originSession.appendMessages([
        { role: 'assistant', content: completed.result.text },
      ]);
    };
    if (run.background) {
      void externalCliRuntimeManager.wait(run.runId)
        .then(persistCompletedRun)
        .catch(error => {
          console.error(
            'Failed to persist External CLI background result:',
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => externalCliProtectedSessionIds.delete(originSession.id));
    } else await persistCompletedRun(run);
    return run;
  }

  function createExternalCliAgentStream(
    input: string,
    config: SupportedExternalCliConfig,
    guiRunId: string,
    signal: AbortSignal,
    originSession = session,
    originWorkDir = workDir,
  ): AsyncIterable<AgentEvent> & { result: Promise<AgentRunResult> } {
    const storedNativeSessionId = externalNativeSessionId(config, originSession, originWorkDir);
    const externalEffort = currentEffort();
    const permissionMode = externalCliPermissionMode();
    const configId = externalCliConfigId(config);
    const adapterState = createBridgeEventAdapterState();
    let resolveResult!: (result: AgentRunResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<AgentRunResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    void result.catch(() => undefined);

    const iterable = (async function* (): AsyncGenerator<AgentEvent> {
      let managerRunId: string | undefined;
      let terminalRun: ReturnType<ExternalCliRuntimeManager['get']>;
      const abort = () => {
        if (managerRunId) externalCliRuntimeManager.abort(managerRunId);
      };
      signal.addEventListener('abort', abort, { once: true });

      try {
        for await (const update of externalCliRuntimeManager.stream({
          hadamardSessionId: originSession.id,
          configId,
          cwd: originWorkDir,
          prompt: input,
          nativeSessionId: typeof storedNativeSessionId === 'string' && storedNativeSessionId
            ? storedNativeSessionId
            : undefined,
          clientOptions: {
            directCliProvider: config.runtime,
            authSource: config.authSource === 'apiKey' ? 'apiKey' : 'native',
            credentialProvider: config.credentialProvider,
            profileName: config.name,
            ...(config.authSource === 'apiKey'
              ? {
                  apiKey: config.apiKey,
                  baseURL: config.baseURL,
                }
              : {}),
            trustProjectResources: config.trustProjectResources,
          },
          sessionOptions: {
            title: 'hadamard-gui-' + config.runtime + '-' + config.name,
          },
          runOptions: {
            model: config.model,
            effort: externalEffort === 'auto' ? undefined : externalEffort,
            permissionMode,
            includePartialMessages: true,
          },
        })) {
          if (update.kind === 'snapshot' || update.kind === 'status') {
            managerRunId = update.run.runId;
            externalCliRunConfigNames.set(managerRunId, config.name);
            if (signal.aborted) externalCliRuntimeManager.abort(managerRunId);
            if (
              update.run.status === 'completed'
              || update.run.status === 'failed'
              || update.run.status === 'aborted'
            ) {
              terminalRun = update.run;
            }
            continue;
          }
          if (update.kind !== 'event') continue;
          for (const event of bridgeEventToAgentEvents(
            update.event,
            update.event.session_id ?? '',
            guiRunId,
            config.model ?? config.runtime,
            adapterState,
          )) {
            yield event;
          }
        }

        if (!terminalRun || terminalRun.status !== 'completed' || !terminalRun.result) {
          const message = signal.aborted || terminalRun?.status === 'aborted'
            ? 'External CLI run was interrupted.'
            : terminalRun?.error?.message ?? 'External CLI run failed.';
          throw new Error(message);
        }

        const nativeSessionId = terminalRun.nativeSessionId
          ?? terminalRun.result.nativeSessionId;
        await rememberExternalNativeSession(
          config,
          nativeSessionId,
          originSession,
          originWorkDir,
        ).catch(() => undefined);
        await originSession.appendMessages([
          { role: 'user', content: input },
          { role: 'assistant', content: terminalRun.result.text },
        ]).catch(() => undefined);
        await persistSessionRuntimeMetadata(originSession, config, config.model ?? null);
        const completed: AgentRunResult = {
          runId: guiRunId,
          sessionId: nativeSessionId,
          model: config.model ?? config.runtime,
          text: terminalRun.result.text,
          message: {
            id: 'external-' + guiRunId,
            role: 'assistant',
            type: 'message',
            model: config.model ?? config.runtime,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: terminalRun.result.text }],
          },
          messages: [],
          stopReason: 'end_turn',
          requests: [],
          toolCalls: [],
          startedAt: terminalRun.startedAt ?? terminalRun.createdAt,
          completedAt: terminalRun.finishedAt ?? new Date().toISOString(),
        };
        resolveResult(completed);
      } catch (error) {
        rejectResult(error);
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    })();

    return {
      [Symbol.asyncIterator]: () => iterable,
      result,
    };
  }

  function getGoal(): Goal | null {
    return sdk?.goals.peek(session.id) ?? null;
  }

  // A running Goal keeps taking turns on its own until it finishes, needs the
  // operator, or exhausts its budget. Pause aborts the loop; the banner polls
  // the snapshot for progress while it runs.
  const goalLoops = new Map<string, { controller: AbortController; startedAt: string }>();
  const goalLoopOutcomes = new Map<string, { turns: number; reason: string; endedAt: string }>();

  function startSessionGoalLoop(sessionId: string): boolean {
    if (!sdk || goalLoops.has(sessionId)) return false;
    const controller = new AbortController();
    goalLoops.set(sessionId, { controller, startedAt: new Date().toISOString() });
    goalLoopOutcomes.delete(sessionId);
    void (async () => {
      try {
        const run = await sdk.goals.runContinuation(sessionId, {
          force: true,
          mode: 'foreground',
          signal: controller.signal,
        });
        goalLoopOutcomes.set(sessionId, {
          turns: run.turns,
          reason: run.reason,
          endedAt: new Date().toISOString(),
        });
      } catch (error) {
        goalLoopOutcomes.set(sessionId, {
          turns: 0,
          reason: (error as Error).message,
          endedAt: new Date().toISOString(),
        });
      } finally {
        goalLoops.delete(sessionId);
        invalidateHeavyState();
      }
    })();
    return true;
  }

  function stopSessionGoalLoop(sessionId: string): boolean {
    const loop = goalLoops.get(sessionId);
    if (!loop) return false;
    loop.controller.abort();
    return true;
  }

  function goalLoopSnapshot(sessionId: string): GuiGoalLoopStatus {
    const loop = goalLoops.get(sessionId);
    if (loop) return { running: true, startedAt: loop.startedAt };
    const outcome = goalLoopOutcomes.get(sessionId);
    return outcome ? { running: false, ...outcome } : { running: false };
  }

  /** What the next Goal run would do, projected for the composer Goal banner. */
  function describeGoalNext(goal: Goal | null): GuiGoalNext | null {
    if (!goal) return null;
    const decision = decideGoalExecution(goal);
    if (decision.kind === 'run') {
      const item = decision.workItemId
        ? goal.workItems.find(entry => entry.id === decision.workItemId)
        : undefined;
      return {
        kind: 'run',
        ...(decision.workItemId ? { workItemId: decision.workItemId } : {}),
        text: item?.text
          ?? (decision.mode === 'finalize' ? 'Finalize the Goal.' : 'Plan the first step.'),
      };
    }
    if (decision.kind === 'replan') {
      return { kind: 'replan', text: `Replan the frontier (${decision.trigger}).` };
    }
    return { kind: 'stop', reason: decision.reason, text: decision.message };
  }
  // ── Batch: read a file and return its prompts for sequential execution ─
  async function runBatch(fileArg: string): Promise<GuiRunEvent[]> {
    const filePath = path.resolve(workDir, fileArg);
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      return [{ type: 'error', message: `batch: cannot read ${filePath}` }];
    }
    const prompts = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
    if (prompts.length === 0) return [{ type: 'error', message: 'batch: file has no prompts' }];
    return [
      { type: 'notice', message: `batch: ${prompts.length} prompts from ${path.basename(filePath)}` },
      { type: 'batch.queue', prompts },
    ];
  }

  async function runSlashCommand(raw: string): Promise<GuiRunEvent[]> {
    const spaceIndex = raw.indexOf(' ');
    const name = (spaceIndex === -1 ? raw.slice(1) : raw.slice(1, spaceIndex)).toLowerCase();
    const args = spaceIndex === -1 ? '' : raw.slice(spaceIndex + 1).trim();

    switch (name) {
      case 'help':
        return [{
          type: 'command.result',
          title: 'Commands',
          items: Object.entries(HADAMARD_GUI_INTERACTIVE_COMMANDS).map(([command, description]) => ({
            label: `/${command}`,
            description,
            detail: commandUsage(command),
          })),
        }];
      case 'clear':
        return runtimeMutationCommand(async () => {
          const previousSession = session;
          const effort = currentEffort();
          const agentMode = currentAgentMode();
          const nextSession = await createGuiSession({
            title: path.basename(workDir),
            model: previousSession.model,
            permissionMode: currentPermissionMode(),
            permissions: previousSession.permissionContext.permissions,
            metadata: {
              ...(effort ? { __hadamardEffort: effort } : {}),
              ...(currentContextWindow()
                ? { [HADAMARD_CONTEXT_WINDOW_METADATA_KEY]: currentContextWindow() }
                : {}),
              ...sessionAgentModePatch(agentMode),
            },
          });
          await replaceGuiSession(nextSession);
          await persistSessionRuntimeMetadata();
          totalInputTokens = 0;
          totalOutputTokens = 0;
          totalCostUsd = 0;
          configUsage.clear();
          invalidateHeavyState();
          runSessionStartHooks(() => readSessionStartHooks(getLoadedJsonConfig()?.raw), workDir);
          return [{ type: 'clear' }, { type: 'state' }];
        });
      case 'exit':
      case 'quit':
        return [{ type: 'notice', message: 'Close the browser tab or stop the hadamard-gui process to quit.' }];
      case 'model': {
        if (!args) return [{
          type: 'command.result',
          title: 'Model',
          text: `current: ${session.model}\ncontext: ${currentContextWindow() ? formatContextWindowTokens(currentContextWindow()!) : 'model default'}`,
        }];
        if (args === 'config') return [{ type: 'settings.open' }];
        if (args === 'context' || args.startsWith('context ')) {
          const requested = args.slice('context'.length).trim();
          const model = bridgeModelLabel ?? activeBridgeConfig?.model ?? session.model;
          const entry = resolveModelContextEntry(
            model,
            readBridgeConfigs(resolveGuiHomeDir()).configs,
            activeBridgeConfig,
          ) ?? (sdk ? {
            name: model,
            contextWindowTokens: sdk.config.compact.contextWindowTokens,
            maxContextWindowTokens: sdk.config.compact.maxContextWindowTokens,
          } : undefined);
          const limit = modelContextWindowLimit(entry);
          const available = modelContextWindowOptions(entry);
          if (!requested) return [{
            type: 'command.result',
            title: `Context window · ${model}`,
            text: `current: ${currentContextWindow() ? formatContextWindowTokens(currentContextWindow()!) : 'model default'}\nsupported selections: ${available.map(formatContextWindowTokens).join(', ')}\n${limit ? `model limit: ${formatContextWindowTokens(limit)}` : 'model limit: not declared'}`,
          }];
          const tokens = parseContextWindowTokens(requested);
          if (!tokens || (limit && tokens > limit)) {
            return [{ type: 'error', message: limit
              ? `invalid context window: ${requested}; model limit is ${formatContextWindowTokens(limit)}`
              : `invalid context window: ${requested}` }];
          }
          return runtimeMutationCommand(async () => {
            await session.mergeMetadata({ [HADAMARD_CONTEXT_WINDOW_METADATA_KEY]: tokens });
            return [{ type: 'notice', message: `context window set to: ${formatContextWindowTokens(tokens)}` }];
          });
        }
        if (args === 'custom' || args.startsWith('custom ')) {
          const customModel = args.slice('custom'.length).trim();
          if (!customModel) return [{ type: 'error', message: 'usage: /model custom <model-id>' }];
          return runtimeMutationCommand(async () => {
            disableBridge();
            await session.setModel(customModel);
            return [{ type: 'notice', message: `custom model set to: ${session.model}` }];
          });
        }
        if (args === 'router' || args.startsWith('router ')) {
          const routerArg = args.slice('router'.length).trim();
          if (routerArg === 'off' || routerArg === 'none') {
            return runtimeMutationCommand(async () => {
              activeRouter = null;
              routedModelLabel = null;
              await persistSessionRuntimeMetadata();
              return [{ type: 'notice', message: 'router off; using the fixed model' }];
            });
          }
          if (!routerArg) {
            return [{
              type: 'command.result',
              title: 'Router profiles',
              items: listRouterProfiles(workDir).map(profile => ({
                label: profile.name,
                description: `${profile.profile.routes.length} routes`,
                detail: profile.source,
              })),
            }];
          }
          const loaded = loadRouterProfile(routerArg, workDir);
          if (!loaded) return [{ type: 'error', message: `router profile not found: ${routerArg}` }];
          return runtimeMutationCommand(async () => {
            disableBridge();
            activeRouter = loaded.profile;
            routedModelLabel = null;
            await persistSessionRuntimeMetadata();
            return [{ type: 'notice', message: `router active: ${loaded.profile.name}` }];
          });
        }
        return runtimeMutationCommand(async () => {
          await session.setModel(args === 'default'
            ? sdk?.config.model ?? activeBridgeConfig?.model ?? 'external-cli'
            : args);
          return [{ type: 'notice', message: `model set to: ${session.model}` }];
        });
      }
      case 'effort': {
        if (!args) return [{ type: 'command.result', title: 'Effort', text: `current: ${currentEffort() ?? 'auto'}` }];
        const value = args.toLowerCase();
        if (value !== 'auto' && !isEffort(value)) return [{ type: 'error', message: 'usage: /effort [auto|low|medium|high|max]' }];
        return runtimeMutationCommand(async () => {
          await session.mergeMetadata({ __hadamardEffort: value });
          return [{ type: 'notice', message: `effort set to: ${value}` }];
        });
      }
      case 'mode': return [{ type: 'command.result', title: 'Agent mode', text: `current: ${currentAgentMode()}. Use the Agent mode selector in the composer to change it.` }];
      case 'document': return [{ type: 'command.result', title: 'Document', text: 'Open the Project Document workspace to choose DESIGN, PLAN, MEMORY, or RULES.' }];
      case 'permissions':
        return args
          ? runtimeMutationCommand(() => setPermissionPreset(args.toLowerCase().replace(/[ _]/g, '-')))
          : [{ type: 'command.result', title: 'Permissions', text: `current: ${currentPermissionMode()}` }];
      case 'sessions': {
        if (args) {
          const value = (flag: string) => args.match(new RegExp(`(?:^|\\s)--${flag}\\s+("[^"]+"|\\S+)`))?.[1]?.replace(/^"|"$/g, '');
          const rawType = value('type') || 'user';
          const page = await (await createSessionCenterCatalog()).query({
            types: rawType === 'all'
              ? ['user', 'assistant-global', 'assistant-project', 'agent']
              : [rawType as import('../storage/sessionCatalog.js').SessionCatalogType],
            archived: value('archived') === 'all' ? 'all' : value('archived') === 'archived',
            ...(value('project') ? { projectPaths: [value('project')!] } : {}),
            ...(value('status')
              ? { runtimeStatuses: [value('status') as import('../storage/sessionCatalog.js').SessionCatalogRuntimeStatus] }
              : {}),
            keyword: value('query'),
            pageSize: 200,
          });
          return [{
            type: 'command.result',
            title: 'Session Center',
            items: page.items.map(item => ({
              label: item.locator.sessionId,
              description: `${item.projectName} · ${item.type} · ${item.title}${item.archived ? ' · archived' : ''}`,
            })),
          }];
        }
        const sessions = await listGuiSessions();
        return [{
          type: 'command.result',
          title: 'Sessions',
          items: sessions
            .filter(item => isVisibleChatSession(item) && !isEmptyUserSessionSummary(item))
            .map(item => ({
            label: item.id === session.id ? `${item.id} (current)` : item.id,
            description: `${item.title} · ${item.model} · ${item.status}`,
            })),
        }];
      }
      case 'resume': {
        return [{ type: 'error', message: '/resume is TUI-only. Use the GUI Sessions list to switch conversations.' }];
      }
      case 'tools':
        return [{
          type: 'command.result',
          title: 'Tools',
          items: toolMetadata.map(tool => ({
            label: tool.name,
            description: `${tool.category} · ${tool.provider}${tool.readOnly ? ' · read-only' : ''}`,
            detail: tool.description,
          })),
        }];
      case 'memory':
        if (!sdk) return [{ type: 'error', message: 'Memory compaction requires a configured Hadamard provider credential.' }];
        try {
          const { HadamardMemoryCommandService } = await import('../memory/memoryCommandService.js');
          const result = await new HadamardMemoryCommandService({
            memory: sdk.memory,
            proposals: sdk.memoryProposals,
            compactConfig: sdk.config.compact,
            getState: () => session.compactState(),
          }).execute(args || 'status');
          return [{
            type: 'command.result',
            title: result.title,
            text: [result.message, result.text].filter(Boolean).join('\n\n'),
            items: result.items,
          }, { type: 'state' }];
        } catch (error) {
          return [{ type: 'error', message: error instanceof Error ? error.message : String(error) }];
        }
      case 'rules': {
        if (!sdk) return [{ type: 'error', message: 'Rules require a configured Hadamard provider.' }];
        try {
          const { RuleCommandService } = await import('../context/ruleCommandService.js');
          const result = await new RuleCommandService(
            sdk.config.homeDir,
            workDir,
          ).execute(args || 'list');
          return [{
            type: 'command.result',
            title: 'Rules',
            text: result.message,
            items: result.items,
          }, { type: 'state' }];
        } catch (error) {
          return [{ type: 'error', message: error instanceof Error ? error.message : String(error) }];
        }
      }
      case 'compact': {
        if (!sdk) return [{ type: 'error', message: 'Compaction requires a configured Hadamard provider credential.' }];
        const result = await session.compact({ summaryInstructions: args || undefined });
        if (!result.compacted) {
          return [{ type: 'error', message: result.error ?? `compact skipped: ${result.reason}` }];
        }
        const mode = sdk.config.compact?.compactPromptMode ?? 'hybrid';
        return [{ type: 'notice', message: `compacted: ${result.messagesRemoved ?? '?'} messages summarized (mode: ${mode})` }];
      }
      case 'dream': {
        if (!sdk) return [{ type: 'error', message: 'Dream requires a configured Hadamard provider credential.' }];
        if (!args || args === 'status') {
          return [{ type: 'command.result', title: 'Dream', text: JSON.stringify(await session.dreamState(), null, 2) }];
        }
        if (args !== 'run') return [{ type: 'error', message: 'usage: /dream [run|status]' }];
        const result = await session.dream({ force: true });
        return [{ type: 'notice', message: result.reason ?? (result.skipped ? 'dream skipped' : result.success ? 'dream completed' : 'dream failed') }];
      }
      case 'skills':
        return [{
          type: 'command.result',
          title: 'Skills',
          items: sdk!.skills.listMetadata().map(skill => ({
            label: skill.displayName ? `${skill.displayName} (${skill.name})` : skill.name,
            description: `${skill.source} · ${skill.context}${skill.version ? ` · v${skill.version}` : ''}`,
            detail: `${skill.description} ${skill.whenToUse ?? ''}`,
          })),
        }];
      case 'agents': {
        if (!sdk) {
          return [{ type: 'error', message: 'Agents require a configured Hadamard provider.' }];
        }
        const [subcommand = 'list', target = ''] = args.trim().split(/\s+/, 2);
        if (subcommand === 'list' && !target) {
          return [{
            type: 'command.result',
            title: 'Subagents',
            items: (await agentDefinitionSummariesForGui()).map(agent => ({
              label: agent.name,
              description: agent.model ?? 'inherits model',
              detail: agent.description,
            })),
          }];
        }
        const snapshots = await sdk.executions.listSnapshots();
        const views = snapshots.map(snapshot => createAgentExecutionRootView(snapshot));
        const flatten = (view: ReturnType<typeof createAgentExecutionRootView>) => {
          const nodes: typeof view.detached = [];
          const visit = (node: NonNullable<typeof view.root>): void => {
            nodes.push(node);
            node.children.forEach(visit);
          };
          if (view.root) visit(view.root);
          view.detached.forEach(visit);
          return nodes;
        };
        if (subcommand === 'runs') {
          if (target) return runSlashCommand(`/agents show ${target}`);
          const project = createAgentExecutionProjectView(snapshots);
          const runs = [...project.active, ...project.waiting, ...project.completed];
          return [{
            type: 'command.result',
            title: 'Agent executions',
            items: runs.map(run => ({
              label: run.rootExecutionId,
              description: `${run.lifecycle} · ${run.displayName} · ${run.nodeCount} agents`,
              detail: run.currentActivity?.summary ?? `${run.timing.elapsedMs}ms`,
            })),
            text: runs.length ? undefined : 'No Agent executions are recorded for this project.',
          }];
        }
        if (subcommand === 'show') {
          if (!target) return [{ type: 'error', message: 'usage: /agents show <root-execution-id>' }];
          const view = views.find(item => item.rootExecutionId === target);
          if (!view) {
            return [{ type: 'error', message: `No Agent execution tree found for '${target}'. Use /agents runs to browse.` }];
          }
          return [{
            type: 'command.result',
            title: `Agent execution · ${view.rootExecutionId}`,
            items: flatten(view).map(node => ({
              label: `${'  '.repeat(node.depth)}${node.displayName}`,
              description: `${node.lifecycle} · ${node.runtime}${node.model ? ` · ${node.model}` : ''}`,
              detail: `session: ${node.sessionId}${node.currentActivity?.summary ? ` · ${node.currentActivity.summary}` : ''}`,
            })),
            text: `${view.status} · ${view.nodeCount} agents · ${view.edgeCount} links · ${view.timing.elapsedMs}ms`,
          }];
        }
        if (subcommand === 'open') {
          if (!target) return [{ type: 'error', message: 'usage: /agents open <session-or-execution-id>' }];
          const node = views.flatMap(flatten).find(item => item.id === target || item.sessionId === target);
          if (!node) {
            return [{ type: 'error', message: `No Agent execution or conversation matches '${target}'. Use /agents runs to browse.` }];
          }
          return runtimeMutationCommand(async () => {
            await replaceGuiSession(await resumeGuiSession(node.sessionId, {
              model: options.model,
              permissionMode: options.permissionMode,
            }));
            await restoreSessionRuntimeSelection();
            return [{ type: 'notice', message: `opened Agent conversation: ${session.id}` }, { type: 'state' }];
          });
        }
        return [{ type: 'error', message: 'usage: /agents [list|runs|show <root-execution-id>|open <session-or-execution-id>]' }];
      }
      case 'mcp': {
        const mcpTools = toolMetadata.filter(tool => tool.provider === 'mcp');
        return [{
          type: 'command.result',
          title: 'MCP',
          items: mcpTools.map(tool => ({
            label: tool.name,
            description: tool.server ?? 'mcp',
            detail: tool.description,
          })),
          text: mcpTools.length === 0 ? 'no MCP servers are active' : undefined,
        }];
      }
      case 'plugins': {
        const snapshot = await state();
        return [{
          type: 'command.result',
          title: 'Plugins',
          items: (snapshot.plugins as any[]).map(plugin => ({
            label: plugin.name,
            description: [plugin.version, plugin.capabilities?.join(', ')].filter(Boolean).join(' · '),
            detail: plugin.path,
          })),
        }];
      }
      case 'devices': {
        const supported = ['status', 'start', 'stop', 'pair', 'scopes', 'revoke', 'send', 'outbox', 'discover', 'audit'];
        const command = args.split(/\s/u, 1)[0]?.toLowerCase() || 'status';
        if (!supported.includes(command)) {
          return [{ type: 'error', message: `unknown Device Link command: ${command}` }];
        }
        try {
          const result = await deviceLinkController.command(args || 'status');
          return [{
            type: 'command.result',
            title: 'Devices',
            text: [result.message, ...(result.lines ?? [])].join('\n'),
          }];
        } catch (error) {
          return [{ type: 'error', message: error instanceof Error ? error.message : String(error) }];
        }
      }
      case 'plugin': {
        try {
          const manager = new PluginPackageManager(
            path.join(resolveGuiHomeDir(), 'plugin-packages'),
            process.env.HADAMARD_PLUGIN_REGISTRY,
            sdk?.config.effectivePolicy,
          );
          const result = await manager.execute(args || 'list');
          if (result.runtimeChanged && sdk && !needsCredentials) await reloadSdk();
          return [{
            type: 'command.result',
            title: 'Plugin packages',
            text: result.message,
            items: result.items,
          }, { type: 'state' }];
        } catch (error) {
          return [{ type: 'error', message: error instanceof Error ? error.message : String(error) }];
        }
      }
      case 'automation': {
        if (args === 'new') {
          return [{ type: 'notice', message: 'Open Automation and select New task.' }];
        }
        if (args && args !== 'list') {
          return [{ type: 'error', message: 'usage: /automation [list|new]' }];
        }
        const tasks = await listScheduledAutomationTasks(workDir);
        return [{
          type: 'command.result',
          title: 'Automation tasks',
          items: tasks.map(task => ({
            label: task.name,
            description: `${task.kind} · ${task.trigger ?? 'schedule'} · ${task.enabled ? 'enabled' : 'paused'}`,
            detail: task.workflowName ?? task.prompt ?? task.input,
          })),
          text: tasks.length === 0 ? 'no automation tasks configured' : undefined,
        }];
      }
      case 'workflows': {
        if (args.startsWith('run ')) {
          const rest = args.slice(4).trim();
          const split = rest.indexOf(' ');
          return runWorkflow(split === -1 ? rest : rest.slice(0, split), split === -1 ? undefined : rest.slice(split + 1).trim());
        }
        if (args.startsWith('delete ')) {
          const name = args.slice(7).trim();
          if (!name) return [{ type: 'error', message: 'usage: /workflows delete <name>' }];
          const referencing = (await listScheduledAutomationTasks(workDir)).filter(task =>
            task.kind === 'workflow' && task.workflowSource !== 'agent' && task.workflowName === name);
          if (referencing.length) {
            return [{
              type: 'error',
              message: `workflow "${name}" is used by automation task(s): ${referencing.map(task => task.name || task.id).join(', ')}. Delete or re-point those tasks first.`,
            }];
          }
          const removed = await deleteWorkflow(name, workDir);
          return [{ type: 'notice', message: removed ? `deleted workflow: ${name}` : `workflow not found: ${name}` }];
        }
        if (args.startsWith('save ')) {
          const rest = args.slice(5).trim();
          const split = rest.indexOf(' ');
          if (split === -1) {
            return [{ type: 'error', message: 'usage: /workflows save <name> <script-path> [--overwrite]' }];
          }
          const name = rest.slice(0, split).trim();
          const pathParts = rest.slice(split + 1).trim().split(/\s+/);
          const overwrite = pathParts.includes('--overwrite');
          const scriptPath = pathParts.filter(part => part !== '--overwrite').join(' ');
          if (!name || !scriptPath) {
            return [{ type: 'error', message: 'usage: /workflows save <name> <script-path> [--overwrite]' }];
          }
          try {
            const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(workDir, scriptPath);
            const script = await readFile(resolved, 'utf8');
            const filePath = await saveWorkflow(name, script, { projectDir: workDir, overwrite });
            return [{ type: 'notice', message: `saved workflow: ${name} → ${filePath}` }];
          } catch (error) {
            return [{ type: 'error', message: error instanceof Error ? error.message : String(error) }];
          }
        }
        if (args && args !== 'list') {
          return [{ type: 'error', message: 'usage: /workflows [list|run <name> [task]|save <name> <script-path>|delete <name>]' }];
        }
        return [{
          type: 'command.result',
          title: 'Workflows',
          items: listWorkflows(workDir).map(workflow => ({
            label: workflow.name,
            description: workflow.description,
            detail: workflow.source,
          })),
        }];
      }
      case 'worktree': {
        const service = new WorktreeService(workDir);
        if (args === 'list' || !args) {
          await service.init();
          const trees = await service.listWorktrees();
          return [{
            type: 'command.result',
            title: 'Worktrees',
            items: trees.map(tree => ({
              label: tree.path,
              description: tree.isDirty ? 'dirty' : 'clean',
            })),
            text: trees.length === 0 ? 'no worktrees' : undefined,
          }];
        }
        if (args === 'exit') {
          service.exitWorktree();
          return [{ type: 'notice', message: `exited worktree, cwd: ${service.currentWorkDir}` }];
        }
        if (args.startsWith('enter ')) {
          const nameToEnter = args.slice(6).trim();
          await service.init();
          await service.createAndEnterWorktree({ name: nameToEnter });
          return [{ type: 'notice', message: `entered worktree: ${nameToEnter} (${service.currentWorkDir})` }];
        }
        return [{ type: 'error', message: 'usage: /worktree [enter <name>|exit|list]' }];
      }
      case 'team': {
        if (!args || args === 'list') {
          const teams = listTeamDefinitions(workDir);
          return [{
            type: 'command.result',
            title: 'Teams',
            items: teams.map(team => ({
              label: `${team.name === activeTeamName ? '* ' : ''}${team.name}`,
              description: `${team.definition.mode} · ${team.definition.members?.length ?? 0} members`,
              detail: team.source,
            })),
          }];
        }
        if (args === 'status') {
          const lines = [
            `attached: ${activeTeamName ?? 'none'}`,
            `autoInvoke: ${teamPrefs.autoInvoke ? 'on — the main agent can call the team as a tool' : 'off — manual /team ask only'}`,
            `defaultAttached: ${teamPrefs.defaultAttached ?? 'none'}${teamPrefs.defaultAttached && !activeTeamName ? ' (not found)' : ''}`,
            `confirmBeforeRun: ${teamPrefs.confirmBeforeRun ? 'on' : 'off'}`,
            `last run: ${lastTeamRunSummary ?? 'none'}`,
          ];
          return [{ type: 'command.result', title: 'Team status', text: lines.join('\n') }];
        }
        if (args === 'off') {
          return runtimeMutationCommand(async () => {
            activeTeamTool = null;
            activeTeamName = null;
            return [{ type: 'notice', message: 'team: none' }, { type: 'state' }];
          });
        }
        if (args.startsWith('attach ')) {
          const teamName = args.slice(7).trim();
          return runtimeMutationCommand(async () => {
            const definition = attachTeamByName(teamName);
            if (!definition) return [{ type: 'error', message: `team not found: ${teamName}` }];
            return [{
              type: 'notice',
              message: `agent attached: ${definition.name} · autoInvoke ${teamPrefs.autoInvoke ? 'on' : 'off — use /team ask'}`,
            }, { type: 'state' }];
          });
        }
        if (args.startsWith('clone ')) {
          const parts = args.slice(6).trim().split(/\s+/);
          if (parts.length !== 2) return [{ type: 'error', message: 'usage: /team clone <source> <new-name>' }];
          try {
            const clone = await cloneTeamDefinition(parts[0]!, parts[1]!, { projectDir: workDir });
            return [
              { type: 'notice', message: `team cloned: ${parts[0]} → ${clone.name} (${clone.filePath})` },
              { type: 'state' },
            ];
          } catch (error: any) {
            return [{ type: 'error', message: `clone failed: ${error.message}` }];
          }
        }
        if (args.startsWith('delete ')) {
          const teamName = args.slice(7).trim();
          if (!teamName) return [{ type: 'error', message: 'usage: /team delete <name>' }];
          if (getBuiltInTeamDefinition(teamName)) {
            return [{ type: 'error', message: `cannot delete built-in team: ${teamName}` }];
          }
          return runtimeMutationCommand(async () => {
            const removed = await deleteTeamDefinition(teamName, workDir);
            if (!removed) return [{ type: 'error', message: `team not found: ${teamName}` }];
            if (activeTeamName === teamName) {
              activeTeamTool = null;
              activeTeamName = null;
            }
            return [{ type: 'notice', message: `deleted team: ${teamName}` }, { type: 'state' }];
          });
        }
        if (args.startsWith('ask ')) {
          const rest = args.slice(4).trim();
          const parsed = parseTeamAskArguments(rest);
          if (!parsed) return [{ type: 'error', message: 'usage: /team ask <name> <prompt>' }];
          const { name: teamName, prompt } = parsed;
          const definition = resolveTeamDefinition(teamName, workDir, session.model);
          if (!definition) return [{ type: 'error', message: `team not found: ${teamName}` }];
          session.metadata.__hadamardLastTeamName = definition.name;
          const result = await askTeamDefinition(definition, prompt, undefined, {
            workDir,
            homeDir: resolveGuiHomeDir(),
            model: activeBridgeModelApi?.model ?? session.model,
            modelApi: activeBridgeModelApi?.modelApi,
          });
          lastTeamRunSummary = `${teamName} · ${result.mode} · ${Math.round(result.durationMs / 1000)}s`;
          return [{ type: 'command.result', title: `Team response · ${result.mode}`, text: result.answer }];
        }
        return [{ type: 'error', message: 'usage: /team [list|attach <name>|off|ask <name> <prompt>|clone <source> <new>|delete <name>|status]' }];
      }
      case 'issues': {
        const homeDir = resolveGuiHomeDir();
        const storage = await issueStorageFor(workDir, homeDir);
        const listIssues = async () => listProjectIssues(workDir, homeDir, storage);
        if (!args || args === 'list') {
          const issues = await listIssues();
          return [{
            type: 'command.result',
            title: `Issues (${storage})`,
            items: issues.map(issue => ({
              label: `#${issue.number} ${issue.title}`,
              description: `${issue.status} 路 ${issue.priority}`,
              detail: issue.description || issue.labels.join(', '),
            })),
            text: issues.length === 0 ? 'No issues yet. Use /issues create <title>.' : undefined,
          }];
        }
        if (args.startsWith('create ')) {
          const title = args.slice(7).trim();
          if (!title) return [{ type: 'error', message: 'usage: /issues create <title>' }];
          const issue = await createProjectIssue(workDir, homeDir, { title }, storage);
          return [{ type: 'notice', message: `issue created: #${issue.number} ${issue.title}` }, { type: 'state' }];
        }
        if (args.startsWith('show ')) {
          const rawId = args.slice(5).trim().replace(/^#/, '');
          const issues = await listIssues();
          const issue = issues.find(candidate =>
            candidate.id === rawId ||
            String(candidate.number) === rawId ||
            `ISS-${candidate.number}` === rawId.toUpperCase(),
          );
          if (!issue) return [{ type: 'error', message: `issue not found: ${rawId}` }];
          return [{
            type: 'command.result',
            title: `ISS-${issue.number} ${issue.title}`,
            text: [
              `${issue.status} · ${issue.priority}`,
              issue.description || '(no description)',
              issue.acceptanceCriteria.length
                ? `Acceptance criteria:\n${issue.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`
                : '',
              issue.brief ? `Manager brief:\n${issue.brief}` : '',
            ].filter(Boolean).join('\n\n'),
          }];
        }
        const transitions: Record<string, string> = {
          review: 'in_review',
          done: 'done',
          block: 'blocked',
        };
        const [verb, rawId] = args.split(/\s+/, 2);
        const nextStatus = transitions[verb ?? ''];
        if (nextStatus && isIssueStatus(nextStatus) && rawId) {
          const issue = await transitionProjectIssue(workDir, homeDir, rawId.replace(/^#/, ''), nextStatus, 'user', storage);
          if (!issue) return [{ type: 'error', message: `issue not found: ${rawId}` }];
          return [{ type: 'notice', message: `issue #${issue.number}: ${issue.status}` }, { type: 'state' }];
        }
        return [{ type: 'error', message: 'usage: /issues [list|show <id>|create <title>|start <id> [agent-profile]|review <id>|done <id>|block <id>]' }];
      }
      case 'assistant': {
        const catalog = await createSessionCenterCatalog();
        if (args === 'sessions') {
          const page = await catalog.query({
            types: ['assistant-global'],
            archived: false,
            pageSize: 200,
          });
          const active = (await readAssistantConfig(managerHomeDir())).activeSessionId;
          return [{
            type: 'command.result',
            title: 'Global Assistant Sessions',
            items: page.items.map(item => ({
              label: item.locator.sessionId === active
                ? `${item.locator.sessionId} (current)`
                : item.locator.sessionId,
              description: item.title,
            })),
          }];
        }
        if (args === 'new') {
          const item = await catalog.action({
            action: 'create',
            type: 'assistant-global',
            model: session.model,
          });
          await selectAssistantCatalogItem(item);
          return [{ type: 'notice', message: `Global Assistant Session created: ${item.locator.sessionId}` }];
        }
        if (args.startsWith('resume ')) {
          const id = args.slice('resume '.length).trim();
          const page = await catalog.query({
            types: ['assistant-global'],
            archived: false,
            pageSize: 200,
          });
          const item = page.items.find(candidate => candidate.locator.sessionId === id);
          if (!item) return [{ type: 'error', message: `Global Assistant Session not found: ${id}` }];
          await selectAssistantCatalogItem(item);
          return [{ type: 'notice', message: `Global Assistant Session selected: ${item.title}` }];
        }
        if (args === 'chat' || args === 'team') {
          return [{ type: 'error', message: `usage: /assistant ${args} <message>` }];
        }
        return [{ type: 'error', message: 'usage: /assistant [chat <message>|sessions|new|resume <id>|team <request>]' }];
      }
      case 'session': {
        const [action, ...rest] = args.split(/\s+/);
        if (!action) {
          return [{ type: 'error', message: 'usage: /session tree | fork <message-id> [label] | clone [label] | label <name> | rename <title> | pin [on|off] | archive | restore <id> | delete <id>' }];
        }
        if (!sdk) {
          return [{ type: 'error', message: 'Session branching requires a configured Hadamard provider.' }];
        }
        if (action === 'tree') {
          const roots = await sdk.sessionGraph.roots();
          const items: Array<{ label: string; description: string }> = [];
          const visit = (node: (typeof roots)[number], depth: number) => {
            items.push({
              label: `${'  '.repeat(depth)}${node.session.id === session.id ? '●' : '○'} ${node.session.branchName || node.session.title}`,
              description: node.session.id,
            });
            node.children.forEach(child => visit(child, depth + 1));
          };
          roots.forEach(root => visit(root, 0));
          return [{ type: 'command.result', title: 'Session Tree', items }];
        }
        if (action === 'fork') {
          const messageId = rest.shift();
          if (!messageId) {
            const refs = await sdk.sessionGraph.ensureMessageIds(session.id);
            return [{
              type: 'command.result',
              title: 'Choose a message id for /session fork',
              items: refs.map(ref => ({ label: ref.id, description: ref.message.role })),
            }];
          }
          const forked = await sdk.sessionForks.forkAtMessage(session.id, messageId, {
            branchName: rest.join(' ').trim() || undefined,
          });
          await replaceGuiSession(
            await resumeGuiSession(forked.id, { permissionMode: options.permissionMode }),
          );
          return [{ type: 'notice', message: `Session branch created: ${forked.id}` }, { type: 'state' }];
        }
        if (action === 'clone') {
          const cloned = await sdk.sessionForks.clone(session.id, {
            branchName: rest.join(' ').trim() || undefined,
          });
          await replaceGuiSession(
            await resumeGuiSession(cloned.id, { permissionMode: options.permissionMode }),
          );
          return [{ type: 'notice', message: `Session cloned: ${cloned.id}` }, { type: 'state' }];
        }
        if (action === 'label') {
          const label = rest.join(' ').trim();
          if (!label) return [{ type: 'error', message: 'usage: /session label <name>' }];
          await sdk.sessionForks.label(session.id, label);
          session = await resumeGuiSession(session.id, { permissionMode: options.permissionMode });
          return [{ type: 'notice', message: `Session branch labeled: ${label}` }, { type: 'state' }];
        }
        const catalog = await createSessionCenterCatalog();
        const page = await catalog.query({
          types: ['user', 'assistant-global', 'assistant-project'],
          archived: 'all',
          pageSize: 200,
        });
        const targetId = action === 'restore' || action === 'delete' ? rest[0] : session.id;
        const item = page.items.find(candidate => candidate.locator.sessionId === targetId);
        if (!item) return [{ type: 'error', message: `Session not found: ${targetId || ''}` }];
        if (action === 'rename') {
          const title = rest.join(' ').trim();
          if (!title) return [{ type: 'error', message: 'usage: /session rename <title>' }];
          await catalog.action({ action: 'rename', locator: item.locator, title });
          if (item.locator.sessionId === session.id) {
            session = await resumeGuiSession(session.id, { permissionMode: options.permissionMode });
          }
        } else if (action === 'pin') {
          await catalog.action({
            action: 'pin',
            locator: item.locator,
            pinned: rest[0] === 'off' ? false : rest[0] === 'on' ? true : undefined,
          });
        } else if (action === 'archive') {
          await catalog.action({ action: 'archive', locator: item.locator });
          if (item.locator.sessionId === session.id) {
            session = await createGuiSession({ model: options.model, permissionMode });
          }
        } else if (action === 'restore') {
          await catalog.action({ action: 'restore', locator: item.locator });
        } else if (action === 'delete') {
          await catalog.action({ action: 'delete', locator: item.locator });
        } else {
          return [{ type: 'error', message: `Unknown /session action: ${action}` }];
        }
        return [{ type: 'notice', message: `Session ${action} complete.` }, { type: 'state' }];
      }
      case 'manager': {
        // `/manager update` and `/manager chat <msg>` are intercepted by the
        // streaming path in /api/send (they register a RunRegistry
        // kind='manager' run); the synchronous sub-commands are handled here.
        const homeDir = resolveGuiHomeDir();
        if (args === 'sessions') {
          const page = await (await createSessionCenterCatalog()).query({
            types: ['assistant-project'],
            projectPaths: [projectPrimaryPath],
            archived: false,
            pageSize: 200,
          });
          return [{
            type: 'command.result',
            title: 'Project Manager Sessions',
            items: page.items.map(item => ({
              label: item.locator.sessionId,
              description: `${item.title}${item.locator.sessionId === (page.items.find(x => x.locator.sessionId === managerGuiSession?.id)?.locator.sessionId) ? ' · current' : ''}`,
            })),
          }];
        }
        if (args === 'new') {
          const catalog = await createSessionCenterCatalog();
          const item = await catalog.action({
            action: 'create',
            type: 'assistant-project',
            projectPath: projectPrimaryPath,
            model: session.model,
          });
          await selectAssistantCatalogItem(item);
          return [{ type: 'notice', message: `Manager Session created: ${item.locator.sessionId}` }];
        }
        if (args.startsWith('resume ')) {
          const id = args.slice('resume '.length).trim();
          const catalog = await createSessionCenterCatalog();
          const page = await catalog.query({
            types: ['assistant-project'],
            projectPaths: [projectPrimaryPath],
            archived: false,
            pageSize: 200,
          });
          const item = page.items.find(candidate => candidate.locator.sessionId === id);
          if (!item) return [{ type: 'error', message: `Manager Session not found: ${id}` }];
          await selectAssistantCatalogItem(item);
          return [{ type: 'notice', message: `Manager Session selected: ${item.title}` }];
        }
        if (!args || args === 'status') {
          const cfg = await readManagerConfig(projectPrimaryPath, homeDir);
          const plan = await readProjectPlanFile(projectPrimaryPath, homeDir);
          const design = await readDesignFile(projectPrimaryPath, homeDir);
          const lines = [
            `model: ${cfg.model ?? `${session.model} (session default)`}`,
            `readScope: ${cfg.readScope}`,
            `plan.json: ${plan.milestones.length} milestones · ${plan.today.length} today · ${plan.upcoming.length} upcoming`,
            `DESIGN.md: ${design ? `${design.length} chars · ${managerDesignPath(projectPrimaryPath, homeDir)}` : '(none yet — /manager update)'}`,
          ];
          return [{ type: 'command.result', title: 'Manager', text: lines.join('\n') }];
        }
        if (args === 'config') {
          const cfg = await readManagerConfig(projectPrimaryPath, homeDir);
          return [{
            type: 'command.result',
            title: 'Manager config',
            text: JSON.stringify(cfg, null, 2) + '\nEdit: ~/.hadamard/projects/<hash>/manager.json',
          }];
        }
        if (args === 'schedule') {
          const tasks = (await listScheduledAutomationTasks(workDir)).filter(task => task.kind === 'manager');
          return [{
            type: 'command.result',
            title: 'Manager schedules',
            items: tasks.map(task => ({
              label: task.name,
              description: `${task.cron} · ${task.enabled ? 'enabled' : 'paused'}`,
            })),
            text: tasks.length === 0 ? 'none — add kind:"manager" tasks in the Automation area' : undefined,
          }];
        }
        if (args === 'chat') {
          return [{ type: 'error', message: 'usage: /manager chat <message>' }];
        }
        return [{ type: 'error', message: 'usage: /manager [status|chat <message>|update [instruction]|config|schedule]' }];
      }
      case 'init': {
        const prompt = 'Explore this repository (read package.json, README, and AGENTS.md if present; list the top-level structure), then write or improve a root AGENTS.md documenting: what the project is, key commands (build/test/run), the high-level architecture, and important conventions. Keep it concise and accurate.';
        return [{ type: 'agent.prompt', text: prompt }];
      }
      case 'context': {
        const contextArgs = args.trim();
        if (contextArgs === 'setting' || contextArgs === 'settings') {
          return [{
            type: 'command.result',
            title: 'Context settings',
            text: `Current: ${projectSettings.context.instructionMode}\nUse /context settings agents|claude|both, or Project settings > Context instructions.`,
          }];
        }
        if (contextArgs.startsWith('setting ') || contextArgs.startsWith('settings ')) {
          const instructionMode = contextArgs.replace(/^settings?\s+/u, '');
          if (instructionMode !== 'agents' && instructionMode !== 'claude' && instructionMode !== 'both') {
            return [{ type: 'error', message: 'usage: /context settings [agents|claude|both]' }];
          }
          projectSettings = await writeProjectSettings(workDir, resolveGuiHomeDir(), {
            context: { instructionMode },
          });
          systemPrompt = buildGuiSystemPrompt(workDir, projectSettings, resolveGuiHomeDir(), projectRegisteredWorkPaths);
          return [{ type: 'notice', message: `context instructions: ${instructionMode}; global rules remain ~/.hadamard/AGENTS.md` }, { type: 'state' }];
        }
        if (contextArgs) {
          return [{ type: 'error', message: 'usage: /context [settings [agents|claude|both]]' }];
        }
        const project = loadProjectContext(workDir, {
          projectInstructionMode: projectSettings.context.instructionMode,
          hadamardHomeDir: resolveGuiHomeDir(),
          projectWorkPaths: projectRegisteredWorkPaths,
        });
        const mcp = toolMetadata.filter(t => t.provider === 'mcp').length;
        const { resolveHadamardCompactBudget, getPersistedHadamardCompactState } = await import('../runtime/hadamardCompact.js');
        const compactBudget = resolveHadamardCompactBudget({
          ...sdk!.config.compact,
          ...(currentContextWindow() ? { contextWindowTokens: currentContextWindow() } : {}),
        });
        const instructionState = parseProjectInstructionState(session.metadata);
        const compactCount = getPersistedHadamardCompactState(session.metadata).compactCount;
        const projectHash = instructionState?.contentHash.slice(0, 12);
        const contentHash = hashProjectInstructionContent(project.text, project.sources);
        const pendingProjectInstructions = !instructionState
          || compactCount > instructionState.injectedAtCompactCount
          || instructionState.contentHash !== contentHash;
        const localTools = sdk
          ? [...new Map(
              toolMetadata
                .map(metadata => sdk!.getTool(metadata.name))
                .filter((tool): tool is AgentToolDefinition => Boolean(tool))
                .map(tool => [tool.name, tool]),
            ).values()]
          : tools;
        const estimatedLocalTools = await applyResolvedToolDescriptions(
          [
            ...localTools,
            ...(activeTeamTool ? [activeTeamTool] : []),
          ],
          { workDir, permissionMode: currentPermissionMode() },
        );
        const requestBreakdown = estimateRequestTokenBreakdown({
          systemPrompt,
          tools: [
            ...estimatedLocalTools.map(tool => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputJsonSchema ?? {},
            })),
            ...toolMetadata
              .filter(metadata => metadata.provider === 'mcp' && !sdk?.getTool(metadata.name))
              .map(metadata => ({
                name: metadata.name,
                description: metadata.description,
                input_schema: {},
              })),
          ],
          messageTokens: estimateHadamardConversationTokens(session.messages)
            + (pendingProjectInstructions ? Math.ceil(project.text.length / 4) : 0),
        });
        const lines = [
          `Model: ${session.model}`,
          `Effort: ${currentEffort() ?? 'auto'}`,
          `Permission: ${currentPermissionMode()}`,
          `Messages: ${session.messages.length}`,
          `Raw context window: ${compactBudget.rawContextWindowTokens}`,
          `Effective context window: ${compactBudget.effectiveContextWindowTokens}`,
          `Automatic compact limit: ${compactBudget.autoCompactTokenLimit} (${compactBudget.source})`,
          `Next request estimate: ${requestBreakdown.totalTokens.toLocaleString()} tokens`,
          `Request breakdown: system ${requestBreakdown.systemTokens.toLocaleString()} + tools ${requestBreakdown.toolTokens.toLocaleString()} + messages ${requestBreakdown.messageTokens.toLocaleString()}`,
          `System prompt: ${systemPrompt.length} chars`,
          `Project instructions: ${project.text.length} chars`
            + (projectHash ? ` · hash ${projectHash}` : '')
            + ` · compact ${compactCount}`,
          `Tools: ${toolMetadata.length} (${mcp} MCP)`,
          `Bridge: ${bridgeMode ? (activeBridgeConfig?.name ?? 'on') : 'off'}`,
          `Instruction files: ${project.sources.length ? project.sources.join(', ') : '(none)'}`,
        ];
        return [{ type: 'command.result', title: 'Context', text: lines.join('\n') }];
      }
      case 'cost':
      case 'usage': {
        const lines = [
          `Input tokens: ${totalInputTokens.toLocaleString()}`,
          `Output tokens: ${totalOutputTokens.toLocaleString()}`,
          `Cost: ${totalCostUsd === null ? 'unknown' : '$' + totalCostUsd.toFixed(4)}`,
          `Model: ${session.model}`,
        ];
        if (configUsage.size > 0) {
          lines.push('', 'By config:');
          for (const [cfgName, rec] of configUsage) {
            const star = activeBridgeConfig?.name === cfgName ? ' *' : '';
            const cost = configCost(cfgName, rec);
            lines.push(`  ${cfgName}${star} — ${rec.turns} turns, ${(rec.inputTokens + rec.outputTokens).toLocaleString()} tokens${cost ? ', ' + cost : ''}`);
          }
        }
        return [{ type: 'command.result', title: 'Usage', text: lines.join('\n') }];
      }
      case 'doctor': {
        const env = readEnvFromSettings(getLoadedJsonConfig()?.raw ?? {});
        const project = loadProjectContext(workDir, {
          projectInstructionMode: projectSettings.context.instructionMode,
          hadamardHomeDir: resolveGuiHomeDir(),
          projectWorkPaths: projectRegisteredWorkPaths,
        });
        const isGit = await gitText(['rev-parse', '--is-inside-work-tree']) === 'true';
        const key = env.HADAMARD_API_KEY ? maskApiKey(env.HADAMARD_API_KEY) : env.HADAMARD_AUTH_TOKEN ? '(auth token)' : '(none)';
        const lines = [
          `Model: ${session.model}`,
          `Provider: ${env.HADAMARD_PROVIDER ?? sdk!.config.provider}`,
          `API key: ${key}`,
          `Base URL: ${env.HADAMARD_BASE_URL ?? sdk!.config.baseURL ?? '(default)'}`,
          `Workdir: ${workDir}`,
          `Git repo: ${isGit ? 'Yes' : 'No'}`,
          `Session: ${session.id} (${session.messages.length} messages)`,
          `Permission: ${currentPermissionMode()}`,
          `Tools: ${toolMetadata.length}`,
          `Instruction files: ${project.sources.length ? project.sources.join(', ') : '(none)'}`,
          `Bridge: ${bridgeMode ? `${activeBridgeConfig?.name ?? 'on'} → ${bridgeModelLabel ?? '?'}` : 'off'}`,
        ];
        return [{ type: 'command.result', title: 'Doctor', text: lines.join('\n') }];
      }
      case 'batch':
        if (!args) return [{ type: 'error', message: 'usage: /batch <file>' }];
        return runBatch(args);
      case 'goal': {
        if (!sdk) return [{ type: 'error', message: 'Goal requires a configured Hadamard provider.' }];
        const commandResult = await sdk.goals.command(session, args);
        return [
          commandResult.ok
            ? { type: 'command.result', title: 'Goal', text: commandResult.message }
            : { type: 'error', message: commandResult.message },
          ...(commandResult.changed ? [{ type: 'state' as const }] : []),
        ];
      }
      case 'diff': {
        if (!sdk) return [{ type: 'error', message: 'Session diff requires a configured Hadamard provider.' }];
        const sub = args || 'show';
        try {
          const diff = await sdk.getSessionDiff(session.id);
          if (sub === 'show') {
            return [{
              type: 'command.result',
              title: 'Session Diff',
              items: diff.files.map(file => ({
                label: `${file.status} ${file.path}`,
                description: `+${file.additions} -${file.deletions}`,
              })),
            }];
          }
          if (sub === 'apply --confirm') {
            const result = await sdk.applySessionDiff(session.id);
            return [{
              type: result.applied ? 'notice' : 'error',
              message: result.message,
            }];
          }
          return [{ type: 'error', message: 'usage: /diff show | apply --confirm' }];
        } catch (error) {
          return [{ type: 'error', message: error instanceof Error ? error.message : String(error) }];
        }
      }
      case 'review': {
        const diff = await gitText(['--no-pager', 'diff']);
        if (!diff) return [{ type: 'error', message: 'no git diff to review (stage/commit changes first)' }];
        const capped = diff.length > 80000 ? diff.slice(0, 80000) + '\n…[diff truncated]' : diff;
        const prompt = `Review the following git diff for correctness, security, and style issues. For each finding cite file:line and explain the problem and the fix. Be concise.\n\n\`\`\`diff\n${capped}\n\`\`\``;
        return [{ type: 'agent.prompt', text: prompt }];
      }
      case 'stats': {
        const mcp = toolMetadata.filter(t => t.provider === 'mcp').length;
        const lines = [
          `Messages: ${session.messages.length}`,
          `Input tokens: ${totalInputTokens.toLocaleString()}`,
          `Output tokens: ${totalOutputTokens.toLocaleString()}`,
          `Tools: ${toolMetadata.length} (${mcp} MCP)`,
          `Model: ${session.model}${bridgeMode ? ' (bridge:' + (activeBridgeConfig?.name ?? '?') + ')' : ''}`,
          `Plan mode: ${currentPermissionMode() === 'plan' ? 'on' : 'off'}`,
        ];
        return [{ type: 'command.result', title: 'Stats', text: lines.join('\n') }];
      }
      case 'export': {
        const lines: string[] = [];
        for (const message of session.messages) {
          const role = message.role === 'assistant' ? 'Assistant' : 'User';
          const text = typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content.map((b) => {
                  const t = (b as { text?: unknown } | null)?.text;
                  return typeof t === 'string' ? t : '';
                }).join('\n')
              : '';
          if (text.trim()) { lines.push(`## ${role}`, '', text, '', '---', ''); }
        }
        const md = lines.join('\n');
        const file = args ? path.resolve(workDir, args) : path.resolve(workDir, `session-${Date.now()}.md`);
        try { await writeFile(file, md, 'utf8'); return [{ type: 'notice', message: `exported to ${file}` }]; }
        catch (e) { return [{ type: 'error', message: `export failed: ${(e as Error).message}` }]; }
      }
      case 'rewind': {
        const n = parseInt(args || '1', 10);
        if (!Number.isFinite(n) || n < 1) return [{ type: 'error', message: 'usage: /rewind <N>' }];
        return runtimeMutationCommand(async () => {
          const kept = session.messages.slice(0, Math.max(0, session.messages.length - n));
          const newSession = await createGuiSession({ title: session.title, model: options.model, permissionMode });
          if (kept.length > 0) await newSession.appendMessages(kept).catch(() => undefined);
          session = newSession;
          await persistSessionRuntimeMetadata();
          return [{ type: 'notice', message: `rewound ${n} message(s)` }, { type: 'state' }];
        });
      }
      case 'hooks': {
        const raw = getLoadedJsonConfig()?.raw;
        const typed = parseTypedHooks(raw?.typedHooks);
        const pre = readPreToolUseHooks(raw);
        const post = readPostToolUseHooks(raw);
        const start = readSessionStartHooks(raw);
        const lines: string[] = [];
        const fmt = (h: { matcher?: string; command?: string; enabled?: boolean }) =>
          `  ${h.enabled === false ? '[disabled] ' : ''}${h.matcher ? h.matcher + ': ' : ''}${h.command}`;
        lines.push(`Lifecycle (${typed.hooks.length}):`);
        typed.hooks.forEach(h => lines.push(
          `  ${h.enabled === false ? '[disabled] ' : ''}${h.id}: ${h.event} -> ${h.handler.type}`,
        ));
        typed.issues.forEach(issue => lines.push(`  [invalid] ${issue}`));
        lines.push(`PreToolUse (${pre.length}):`); pre.forEach(h => lines.push(fmt(h)));
        lines.push(`PostToolUse (${post.length}):`); post.forEach(h => lines.push(fmt(h)));
        lines.push(`SessionStart (${start.length}):`); start.forEach(h => lines.push(fmt(h)));
        if (typed.hooks.length + pre.length + post.length + start.length === 0) {
          lines.push('', 'No hooks configured. Open Settings > Hooks to add a lifecycle hook.');
        }
        return [{ type: 'command.result', title: 'Hooks', text: lines.join('\n') }];
      }
      case 'plan': {
        if (args === 'off' || args === 'approve') {
          return runtimeMutationCommand(async () => {
            if (args === 'approve' && !readPlanFile(workDir)) {
              return [{ type: 'error', message: 'there is no saved plan to approve' }];
            }
            const mode = permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'default';
            await session.setPermissionContext({ mode, permissions: [], approver });
            return [
              {
                type: 'notice',
                message: args === 'approve'
                  ? 'plan approved — implementation permissions restored'
                  : 'plan mode off without approval',
              },
              { type: 'state' },
            ];
          });
        }
        if (args === 'view') {
          const plan = readPlanFile(workDir);
          return plan
            ? [{ type: 'command.result', title: 'Plan · awaiting approval', text: plan }]
            : [{ type: 'notice', message: 'no saved plan yet' }];
        }
        if (args === 'revise' || args.startsWith('revise ')) {
          const feedback = args.slice('revise'.length).trim();
          if (currentPermissionMode() !== 'plan') {
            await session.setPermissionContext({ mode: 'plan', permissions: [], approver });
          }
          return feedback
            ? [{
                type: 'agent.prompt',
                text: `Revise the saved plan using this feedback. Stay in Plan mode and call ExitPlanMode again when ready:\n\n${feedback}`,
              }, { type: 'state' }]
            : [{ type: 'notice', message: 'plan remains read-only; use /plan revise <feedback>' }, { type: 'state' }];
        }
        if (args === 'open') {
          openPathInSystem(planFilePath(workDir));
          return [{ type: 'notice', message: 'opened plan file' }];
        }
        return runtimeMutationCommand(async () => {
          if (currentPermissionMode() !== 'plan') {
            await session.setPermissionContext({ mode: 'plan', permissions: [], approver });
          }
          const plan = readPlanFile(workDir);
          return plan
            ? [{ type: 'command.result', title: 'Plan', text: plan }, { type: 'state' }]
            : [{ type: 'notice', message: 'plan mode on — research, then ExitPlanMode. No plan yet.' }, { type: 'state' }];
        });
      }
      case 'checkpoint': {
        const [action = 'list', checkpointId, modeValue, ...flags] = args.split(/\s+/u).filter(Boolean);
        if (action === 'list') {
          const checkpoints = await sdk!.checkpoints.list(session.id);
          return [{
            type: 'command.result',
            title: 'Checkpoints',
            text: checkpoints.length > 0
              ? checkpoints.map(item =>
                  `${item.id} · ${item.status} · ${item.entries.length} file(s) · ${item.createdAt}`
                ).join('\n')
              : 'No checkpoints for this Session.',
          }];
        }
        if (!checkpointId) {
          return [{ type: 'error', message: 'usage: /checkpoint show <id> | restore <id> [files|conversation|both] --confirm' }];
        }
        if (action === 'show') {
          const preview = await sdk!.checkpoints.preview(session.id, checkpointId);
          return [{
            type: 'command.result',
            title: `Checkpoint ${checkpointId}`,
            text: [
              ...preview.files.map(file =>
                `${file.action.padEnd(13)} ${file.path}${file.binary ? ' · binary' : ''}`
              ),
              ...(preview.conflicts.length > 0
                ? ['', 'Conflicts:', ...preview.conflicts.map(conflict => `- ${conflict.path}: ${conflict.message}`)]
                : ['', 'No restore conflicts detected.']),
            ].join('\n'),
          }];
        }
        if (action === 'restore') {
          const mode = ['files', 'conversation', 'both'].includes(modeValue ?? '')
            ? modeValue as import('../checkpoint/types.js').CheckpointRestoreMode
            : 'both';
          const confirmed = flags.includes('--confirm') || modeValue === '--confirm';
          if (!confirmed) {
            return [{
              type: 'error',
              message: `Preview first with /checkpoint show ${checkpointId}, then run /checkpoint restore ${checkpointId} ${mode} --confirm`,
            }];
          }
          return runtimeMutationCommand(async () => {
            const preview = await sdk!.checkpoints.preview(session.id, checkpointId);
            const result = await sdk!.checkpoints.restore({
              sessionId: session.id,
              checkpointId,
              mode,
            });
            if (result.conflicts.length > 0) {
              return [{
                type: 'error',
                message: result.conflicts.map(conflict => `${conflict.path}: ${conflict.message}`).join('\n'),
              }];
            }
            if (result.conversationRestored && preview.checkpoint.conversationCheckpointId) {
              await session.restoreCheckpoint(preview.checkpoint.conversationCheckpointId);
            }
            return [{
              type: 'notice',
              message: `checkpoint restored · ${result.restoredFiles.length} file(s)${result.conversationRestored ? ' · conversation' : ''}`,
            }, { type: 'state' }];
          });
        }
        return [{ type: 'error', message: 'usage: /checkpoint list|show|restore' }];
      }
      case 'bridge': {
        if (args === 'off') {
          return runtimeMutationCommand(async () => {
            disableBridge();
            await persistSessionRuntimeMetadata();
            return [{ type: 'notice', message: 'bridge off — using default provider' }, { type: 'state' }];
          });
        }
        if (args === 'help') {
          return [{ type: 'command.result', title: 'Bridge help', text: [
            '/bridge — open runtime configuration (Settings → Models)',
            '/bridge setup — open runtime setup (Settings → Models)',
            '/bridge switch <name> — activate a named API or External CLI config',
            '/bridge status — show the active execution/runtime/auth/session',
            '/bridge history — browse native External CLI conversations',
            '/bridge resume <native-id> — resume a native External CLI conversation',
            '/bridge background <prompt> — start work in the active External CLI',
            '/bridge runs — list foreground/background External CLI work',
            '/bridge stop <run-id> — interrupt External CLI work',
            '/bridge model [id] — set the active config model',
            '/bridge config — manage named configs',
            '/bridge off — return to the default provider',
            '/bridge run <prompt> — run one prompt through the active config',
            'Configs live in ~/.hadamard/bridge-configs.json',
          ].join('\n') }];
        }
        if (args === 'setup') return [{ type: 'settings.open', tab: 'models' }];
        if (args === 'config' || args === '') return [{ type: 'settings.open', tab: 'models' }];
        if (args === 'status') {
          if (!activeBridgeConfig) {
            return [{ type: 'command.result', title: 'Runtime status', text: 'Hadamard SDK default is active.' }];
          }
          const nativeSessionId = activeBridgeConfig.execution === 'cli'
      && isManagedExternalCliRuntime(activeBridgeConfig.runtime)
            ? externalNativeSessionId(activeBridgeConfig as SupportedExternalCliConfig)
            : undefined;
          return [{ type: 'command.result', title: 'Runtime status', text: [
            `config: ${activeBridgeConfig.name}`,
            `execution: ${activeBridgeConfig.execution === 'cli' ? 'External CLI' : 'Direct API'}`,
            `runtime: ${activeBridgeConfig.runtime}`,
            `model: ${activeBridgeConfig.model || '(runtime default)'}`,
            activeBridgeConfig.execution === 'cli'
              ? `authentication: ${activeBridgeConfig.authSource === 'apiKey' ? 'child-only API key override' : 'native CLI login/config'}`
              : '',
            activeBridgeConfig.execution === 'cli' && typeof nativeSessionId === 'string' && nativeSessionId
              ? `native session: ${nativeSessionId}`
              : '',
            `working directory: ${workDir}`,
          ].filter(Boolean).join('\n') }];
        }
        if (args === 'history') {
          const history = (await listExternalCliSessions({
            homeDir: pointerHomeDir(),
            hadamardHomeDir: resolveGuiHomeDir(),
            crushCwd: workDir,
          })).slice(0, 80);
          return [{
            type: 'command.result',
            title: 'External CLI history',
            items: history.map(item => ({
              label: item.title || item.nativeSessionId,
              description: `${item.runtime} · ${item.messageCount} messages · ${item.updatedAt}`,
              detail: item.cwd || item.nativeSessionId,
            })),
          text: history.length ? undefined : 'No native External CLI sessions were found.',
          }];
        }
        if (args === 'resume' || args.startsWith('resume ')) {
          const nativeSessionId = args.startsWith('resume ')
            ? args.slice('resume '.length).trim()
            : '';
          if (!nativeSessionId) {
            return [{ type: 'error', message: 'usage: /bridge resume <native-id>' }];
          }
          if (
            !activeBridgeConfig
            || activeBridgeConfig.execution !== 'cli'
            || !isManagedExternalCliRuntime(activeBridgeConfig.runtime)
          ) {
            return [{ type: 'error', message: 'activate an External CLI config first' }];
          }
          const config = activeBridgeConfig as SupportedExternalCliConfig;
          const summary = (await listExternalCliSessions({
            homeDir: pointerHomeDir(),
            hadamardHomeDir: resolveGuiHomeDir(),
            crushCwd: workDir,
            runtimes: [config.runtime],
          })).find(item => item.nativeSessionId === nativeSessionId
            && isExternalCliHistoryConfigCompatible(item, config));
          if (!summary) {
            return [{
              type: 'error',
              message: `native ${config.runtime} session not found: ${nativeSessionId}`,
            }];
          }
          if (summary.cwd && !sameWorkspace(summary.cwd, workDir)) {
            return [{
              type: 'error',
              message: `open the session workspace before resuming it: ${summary.cwd}`,
            }];
          }
          return runtimeMutationCommand(async () => {
            await activateBridgeConfig(config);
            await rememberExternalNativeSession(config, summary.nativeSessionId);
            await persistSessionRuntimeMetadata();
            return [
              {
                type: 'notice',
                message: `native ${config.runtime} session selected: ${summary.nativeSessionId}. The next message resumes that native conversation.`,
              },
              { type: 'state' },
            ];
          });
        }
        if (args === 'runs') {
          const externalRuns = externalCliRuntimeManager.list();
          return [{
            type: 'command.result',
            title: 'External CLI runs',
            items: externalRuns.map(run => ({
              label: `${run.runId} · ${run.status}`,
              description: `${run.background ? 'background' : 'foreground'} · ${externalCliRunConfigNames.get(run.runId) ?? 'External CLI'}`,
              detail: run.result?.text || run.error?.message || run.nativeSessionId || run.cwd,
            })),
            text: externalRuns.length ? undefined : 'No External CLI runs in this app session.',
          }];
        }
        if (args.startsWith('stop ')) {
          const runId = args.slice('stop '.length).trim();
          return externalCliRuntimeManager.abort(runId)
            ? [{ type: 'notice', message: `external CLI run stopped: ${runId}` }, { type: 'state' }]
            : [{ type: 'error', message: `active external CLI run not found: ${runId}` }];
        }
        if (args.startsWith('background ')) {
          const prompt = args.slice('background '.length).trim();
          if (!prompt) return [{ type: 'error', message: 'usage: /bridge background <prompt>' }];
          if (
            !activeBridgeConfig
            || activeBridgeConfig.execution !== 'cli'
      || !isManagedExternalCliRuntime(activeBridgeConfig.runtime)
          ) {
      return [{ type: 'error', message: 'activate an External CLI config first' }];
          }
          const run = await startManagedExternalCliRun(
            activeBridgeConfig as SupportedExternalCliConfig,
            prompt,
            true,
          );
          return [
            { type: 'notice', message: `external CLI background run started: ${run.runId}` },
            { type: 'command.result', title: 'Background External CLI', text: `Run ${run.runId} is ${run.status}. Use /bridge runs or /bridge stop ${run.runId}.` },
            { type: 'state' },
          ];
        }
        if (args.startsWith('switch ')) {
          const cfgName = args.slice(7).trim();
          const cfg = findBridgeConfig(cfgName, resolveGuiHomeDir());
          if (!cfg) return [{ type: 'error', message: `bridge config not found: ${cfgName}` }];
          return runtimeMutationCommand(async () => {
            await activateBridgeConfig(cfg);
            await persistSessionRuntimeMetadata();
            return [{ type: 'notice', message: `bridge active: ${cfg.name} → ${bridgeModelLabel} (provider ${cfg.provider})` }, { type: 'state' }];
          });
        }
        if (args.startsWith('model')) {
          const modelArg = args.slice(5).trim();
          if (!activeBridgeConfig) return [{ type: 'error', message: 'no active bridge config — /bridge switch <name> first' }];
          if (!modelArg) return [{ type: 'command.result', title: 'Bridge model', text: `current: ${bridgeModelLabel ?? activeBridgeConfig.model ?? '(default)'}` }];
          return runtimeMutationCommand(async () => {
            activeBridgeConfig = { ...activeBridgeConfig!, model: modelArg };
            await activateBridgeConfig(activeBridgeConfig);
            await persistSessionRuntimeMetadata();
            return [{ type: 'notice', message: `bridge model set: ${modelArg}` }, { type: 'state' }];
          });
        }
        if (args.startsWith('run ')) {
          if (!activeBridgeConfig) return [{ type: 'error', message: 'no active bridge config — /bridge switch <name> first' }];
          return [{ type: 'agent.prompt', text: args.slice(4).trim() }];
        }
        return [{ type: 'settings.open', tab: 'models' }];
      }
      default:
        return [{ type: 'error', message: `unknown command: /${name}` }];
    }
  }

  async function durableIssueCoordinatorFor(targetPath: string, homeDir: string): Promise<DurableIssueCoordinator> {
    const key = `${path.resolve(homeDir)}\u0000${path.resolve(targetPath)}`;
    const existing = durableIssueResources.get(key);
    if (existing) return existing.coordinator;
    const pending = durableIssueResourcePending.get(key);
    if (pending) return (await pending).coordinator;

    const opening = (async () => {
      const storage = await SqliteStorageV2.open({
        filename: path.join(
          getHadamardProjectSessionDirectory(targetPath, homeDir),
          'issue-dispatch-v2.sqlite',
        ),
      });
      try {
        const coordinator = new DurableIssueCoordinator({
          store: new SqliteDurableChildStore({
            store: storage.checkpoints,
            tenantId: 'local-gui',
            prefix: 'gui-issue:',
          }),
          executor: executeDurableIssueWorker,
          ownerId: `gui:${process.pid}:${randomBytes(4).toString('hex')}`,
        }).registerAgent(GUI_DURABLE_ISSUE_AGENT);
        const resource = { coordinator, storage };
        durableIssueResources.set(key, resource);
        return resource;
      } catch (error) {
        await storage.close().catch(() => undefined);
        throw error;
      }
    })();
    durableIssueResourcePending.set(key, opening);
    try {
      return (await opening).coordinator;
    } finally {
      durableIssueResourcePending.delete(key);
    }
  }

  async function executeDurableIssueWorker(
    request: DurableIssueExecutionRequest,
  ): Promise<{ output: JsonValue; usage: Usage; metadata: Record<string, JsonValue> }> {
    if (!sdk) throw new Error('Issue runtime is unavailable because the SDK is not initialized.');
    const context = parseDurableIssueContext(request.context);
    const runId = request.options.runId ?? `issue:${context.issueId}`;
    const send = durableIssueSinks.get(runId) ?? (() => undefined);
    const issue = (await listProjectIssues(context.targetPath, context.homeDir, context.storage))
      .find(candidate => candidate.id === context.issueId);
    if (!issue) throw new Error(`Issue not found while resuming durable child: ${context.issueId}`);

    // Must match issue dispatch / composer: saved profiles AND ephemeral config presets.
    const resolvedProfile = context.requestedProfile
      ? await resolveSelectableAgentRun(context.requestedProfile, context.homeDir)
      : null;
    let modelApi = resolvedProfile?.modelApi;
    let model = resolvedProfile?.model ?? context.workerModel ?? undefined;
    if (!modelApi && context.bridgeConfigName) {
      const bridge = findBridgeConfig(context.bridgeConfigName, context.homeDir);
      if (bridge) {
        const usesDefaults = bridge.runtime === 'hadamard'
          && !(typeof bridge.apiKey === 'string' && bridge.apiKey.trim())
          && !(typeof bridge.baseURL === 'string' && bridge.baseURL.trim());
        if (!usesDefaults) {
          const routed = await buildRouteModelApi({
            model: model ?? bridge.model ?? 'default',
            provider: bridge.provider,
            baseURL: bridge.baseURL,
            apiKey: bridge.apiKey,
            maxTokens: 32000,
          });
          model = routed.model;
          modelApi = routed.modelApi;
        }
      }
    }

    const fallbackEffort = context.effort === 'auto' || isEffort(context.effort)
      ? context.effort
      : undefined;
    const effectiveProfileOptions = resolvedProfile
      ? resolveEffectiveAgentRunOptions(resolvedProfile.profile, {
          systemPrompt: context.systemPrompt,
          fallbackPermissionMode: context.permissionMode,
          fallbackEffort,
        })
      : undefined;
    const profileOverrides = agentProfileRunOverrides(resolvedProfile?.profile);
    const effort = effectiveProfileOptions?.effort ?? fallbackEffort;

    const workerSession = await sdk.resumeSession(context.sessionId, {
      model,
      permissionMode: context.permissionMode,
    });
    let reported = false;
    const issueReportTool = createIssueReportToolForRun({
      targetPath: context.targetPath,
      homeDir: context.homeDir,
      storage: context.storage,
      issueId: context.issueId,
      onReported: () => {
        reported = true;
        durableIssueReported.add(runId);
      },
    });
    const stream = workerSession.stream(context.prompt, {
      systemPrompt: effectiveProfileOptions?.systemPrompt ?? context.systemPrompt,
      signal: typeof effectiveProfileOptions?.timeoutMs === 'number'
        ? request.options.signal
          ? AbortSignal.any([request.options.signal, AbortSignal.timeout(effectiveProfileOptions.timeoutMs)])
          : AbortSignal.timeout(effectiveProfileOptions.timeoutMs)
        : request.options.signal,
      permissionMode: effectiveProfileOptions?.permissionMode ?? context.permissionMode,
      ...(effort ? { effort } : {}),
      approver,
      classifier: preToolUseHookClassifier,
      canUseTool,
      ...(model ? { model } : {}),
      ...(modelApi ? { modelApi } : {}),
      ...(typeof profileOverrides.maxTokens === 'number' ? { maxTokens: profileOverrides.maxTokens } : {}),
      ...(typeof profileOverrides.temperature === 'number' ? { temperature: profileOverrides.temperature } : {}),
      ...(typeof profileOverrides.topP === 'number' ? { topP: profileOverrides.topP } : {}),
      ...(effectiveProfileOptions?.allowedTools
        ? { allowedTools: [...effectiveProfileOptions.allowedTools, issueReportTool.name] }
        : {}),
      ...(effectiveProfileOptions
        ? { workspaceAccess: effectiveProfileOptions.workspaceAccess }
        : {}),
      ...(typeof effectiveProfileOptions?.maxToolIterations === 'number'
        ? { maxToolIterations: effectiveProfileOptions.maxToolIterations }
        : {}),
      tools: [issueReportTool],
    });
    for await (const event of stream) {
      forwardAgentEvent(event, send, runId);
      const desc = runs.get(runId)?.desc;
      if (!desc) continue;
      if (event.type === 'tool.call') {
        desc.toolCalls += 1;
        desc.currentTool = event.call.publicName;
      } else if (event.type === 'tool.result') {
        desc.currentTool = undefined;
      } else if (event.type === 'response.text.delta' && event.delta) {
        desc.lastText = (desc.lastText || '') + event.delta;
      }
    }
    const result = await stream.result;
    if (!reported) {
      await addIssueComment(context.targetPath, context.homeDir, context.issueId, {
        actor: 'system',
        kind: 'system',
        body: 'Worker session ended without IssueReport; manager reconcile should review this issue.',
      }, context.storage);
    }
    return {
      output: result.text ?? '',
      usage: canonicalGuiUsage(result.usage),
      metadata: {
        issueId: context.issueId,
        issueNumber: context.issueNumber,
        sessionId: context.sessionId,
      },
    };
  }

  async function streamIssueDispatch(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    let releaseRuntimeRun: () => void;
    try {
      releaseRuntimeRun = beginRuntimeRun(`issue:${String(body.id ?? body.number ?? body.idOrNumber ?? 'dispatch')}`);
    } catch (error) {
      json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
      return;
    }
    try {
      await streamIssueDispatchLeased(body, res);
    } finally {
      releaseRuntimeRun();
    }
  }

  async function streamIssueDispatchLeased(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const send = (event: GuiRunEvent) => res.write(`${JSON.stringify(event)}\n`);
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    let issue: ProjectIssue | undefined;
    let targetPath = workDir;
    let homeDir = resolveGuiHomeDir();
    let storage: IssueStorageMode = 'home';
    let transitionedToProgress = false;
    let reported = false;
    let workerRunId: string | null = null;
    try {
      if (needsCredentials || !sdk) throw new Error('No API key configured - open Settings > Models to add one.');
      const idOrNumber = body.id ?? body.number ?? body.idOrNumber;
      if (typeof idOrNumber !== 'string' && typeof idOrNumber !== 'number') throw new Error('Missing issue id');
      homeDir = resolveGuiHomeDir();
      targetPath = issueTargetPath(body.path);
      storage = await issueStorageFor(targetPath, homeDir);
      issue = (await listProjectIssues(targetPath, homeDir, storage)).find(candidate =>
        typeof idOrNumber === 'number'
          ? candidate.number === idOrNumber
          : candidate.id === idOrNumber || String(candidate.number) === idOrNumber || `ISS-${candidate.number}` === idOrNumber.toUpperCase(),
      );
      if (!issue) throw new Error(`Issue not found: ${String(idOrNumber)}`);
      if (issue.status !== 'todo' && issue.status !== 'backlog') {
        throw new Error(`Issue must be todo or backlog before dispatch; current status is ${issue.status}.`);
      }

      const requestedProfile = typeof body.agentConfig === 'string' && body.agentConfig.trim()
        ? body.agentConfig.trim()
        : issue.agentConfig;
      const resolvedProfile = requestedProfile
        ? await resolveSelectableAgentRun(requestedProfile, homeDir)
        : null;

      send({ type: 'status', message: `manager - decomposing ISS-${issue.number}` });
      const plan = await readProjectPlanFile(targetPath, homeDir);
      const design = await readDesignFile(targetPath, homeDir);
      const briefPrompt = buildDecomposeIssuePrompt(issue, {
        currentPlanJson: JSON.stringify(plan, null, 2),
        currentDesign: design ?? undefined,
      });
      const brief = await runManagerTurn({ mode: 'chat', text: briefPrompt, send });
      const title = `ISS-${issue.number} ${issue.title}`.slice(0, 120);
      const workerModel = resolvedProfile?.model
        ?? (bridgeMode && activeBridgeModelApi ? activeBridgeModelApi.model : undefined)
        ?? (!bridgeMode && activeBridgeConfig?.runtime === 'hadamard' ? activeBridgeConfig.model : undefined)
        ?? session.model;
      const workerPermissionMode = resolvedProfile?.profile.permissionMode ?? currentPermissionMode();
      const workerSession = await sdk.createSession({
        title,
        ...(workerModel ? { model: workerModel } : {}),
        permissionMode: workerPermissionMode,
        metadata: {
          __hadamardIssueId: issue.id,
          __hadamardIssueNumber: issue.number,
          __hadamardIssueKey: `ISS-${issue.number}`,
          __hadamardAgentProfile: requestedProfile ?? null,
          [RUNTIME_METADATA_KEY]: resolvedProfile
            ? resolvedProfile.bridgeConfig.runtime
            : activeBridgeConfig?.runtime ?? 'hadamard',
          [CONFIG_NAME_METADATA_KEY]: resolvedProfile
            ? resolvedProfile.bridgeConfig.name
            : activeBridgeConfig?.name ?? null,
        },
      });
      session = workerSession;

      const sessionIds = [...new Set([...(issue.sessionIds ?? []), workerSession.id])];
      issue = await updateProjectIssue(targetPath, homeDir, issue.id, {
        brief,
        agentConfig: requestedProfile ?? issue.agentConfig ?? null,
        sessionIds,
        activeSessionId: workerSession.id,
      }, storage) ?? issue;
      if (issue.status === 'backlog') {
        issue = await transitionProjectIssue(targetPath, homeDir, issue.id, 'todo', 'system', storage) ?? issue;
      }
      issue = await transitionProjectIssue(targetPath, homeDir, issue.id, 'in_progress', 'system', storage) ?? issue;
      transitionedToProgress = true;
      send({ type: 'status', message: `dispatched ISS-${issue.number} to session ${workerSession.id}` });
      send({
        type: 'issue.dispatched',
        sessionId: workerSession.id,
        issueId: issue.id,
        issueNumber: issue.number,
        issueKey: `ISS-${issue.number}`,
        state: await state({ light: true }),
      });

      const runId = 'r-iss-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      workerRunId = runId;
      const abort = new AbortController();
      const desc: GuiRunDescriptor = {
        runId,
        kind: 'chat',
        label: `issue:${issue.id}`,
        sessionId: workerSession.id,
        model: workerModel ?? null,
        startedAt: Date.now(),
        status: 'running',
        toolCalls: 0,
        tokenUsage: { input: 0, output: 0 },
      };
      assertRunCanStart();
      runs.set(runId, { desc, abort, sink: send });
      const issueSystemPrompt = [
        systemPrompt,
        '',
        `You are working on ISS-${issue.number}: ${issue.title}.`,
        'When the work and self-checks are complete, call IssueReport with status="in_review".',
        'If you are blocked, call IssueReport with status="blocked" and explain the blocker.',
      ].filter(Boolean).join('\n');
      const workerPrompt = [
        brief,
        '',
        'Operational requirement: update the issue by calling IssueReport before ending the run.',
      ].join('\n');
      send({ type: 'user', text: workerPrompt });
      durableIssueSinks.set(runId, send);
      const profileOverrides = agentProfileRunOverrides(resolvedProfile?.profile);
      const dispatchEffort = profileOverrides.effort ?? currentEffort() ?? 'auto';
      const coordinator = await durableIssueCoordinatorFor(targetPath, homeDir);
      const result = await coordinator.run({
        childId: runId,
        parentRunId: `issue-dispatch:${issue.id}:${workerSession.id}`,
        agent: GUI_DURABLE_ISSUE_AGENT,
        input: workerPrompt,
        context: {
          targetPath,
          homeDir,
          storage,
          issueId: issue.id,
          issueNumber: issue.number,
          sessionId: workerSession.id,
          requestedProfile: requestedProfile ?? null,
          bridgeConfigName: resolvedProfile?.bridgeConfig.name ?? activeBridgeConfig?.name ?? null,
          workerModel: workerModel ?? null,
          permissionMode: workerPermissionMode,
          effort: dispatchEffort,
          systemPrompt: issueSystemPrompt,
          prompt: workerPrompt,
        } as unknown as JsonValue,
        signal: abort.signal,
        tenantId: 'local-gui',
        sessionId: workerSession.id,
        workspaceId: targetPath,
        workspaceRoot: targetPath,
        metadata: {
          issueId: issue.id,
          issueNumber: issue.number,
          issueKey: `ISS-${issue.number}`,
        },
      });
      reported = durableIssueReported.has(runId);
      const workerOutput = typeof result.output === 'string' ? result.output : '';
      if (workerOutput) send({ type: 'delta', text: workerOutput });
      if (!reported) {
        await addIssueComment(targetPath, homeDir, issue.id, {
          actor: 'system',
          kind: 'system',
          body: 'Worker session ended without IssueReport; Project Manager reconciliation started.',
        }, storage);
        send({ type: 'status', message: `manager - reconciling ISS-${issue.number}` });
        try {
          await runManagerTurn({
            mode: 'chat',
            text: [
              `Reconcile ISS-${issue.number} because its worker session ended without calling IssueReport.`,
              `Worker session: ${workerSession.id}`,
              `Worker final response:\n${workerOutput || '(no final text)'}`,
              'Use IssueGet to inspect the issue and its acceptance criteria.',
              'Then use IssueUpdate to move it to in_review only if the evidence shows the work and self-checks completed,',
              'to blocked if a concrete blocker remains, or back to todo if additional implementation is required.',
              'Add an IssueComment explaining the evidence and decision.',
            ].join('\n\n'),
            send,
          });
        } catch (reconcileError) {
          await addIssueComment(targetPath, homeDir, issue.id, {
            actor: 'system',
            kind: 'system',
            body: `Automatic manager reconciliation failed: ${(reconcileError as Error).message}`,
          }, storage).catch(() => undefined);
        }
        const reconciled = (await listProjectIssues(targetPath, homeDir, storage))
          .find(candidate => candidate.id === issue!.id);
        if (reconciled?.status === 'in_progress') {
          await addIssueComment(targetPath, homeDir, issue.id, {
            actor: 'system',
            kind: 'system',
            body: 'Manager reconciliation ended without settling the issue; reset to todo for safe redispatch.',
          }, storage);
          await transitionProjectIssue(targetPath, homeDir, issue.id, 'todo', 'system', storage);
        }
      }
      desc.status = 'done';
      send({ type: 'state', state: await state() });
      send({ type: 'done', usage: result.usage });
    } catch (error) {
      const message = (error as Error).message;
      if (workerRunId) reported = durableIssueReported.has(workerRunId);
      if (workerRunId) {
        const record = runs.get(workerRunId);
        if (record) record.desc.status = 'error';
      }
      send({ type: 'error', message });
      if (issue && transitionedToProgress && !reported) {
        try {
          await addIssueComment(targetPath, homeDir, issue.id, {
            actor: 'system',
            kind: 'system',
            body: `Issue dispatch failed or ended before reporting: ${message}`,
          }, storage);
          const latest = (await listProjectIssues(targetPath, homeDir, storage)).find(candidate => candidate.id === issue!.id);
          if (latest?.status === 'in_progress') {
            await transitionProjectIssue(targetPath, homeDir, issue.id, 'todo', 'system', storage);
          }
        } catch { /* preserve original error */ }
      }
      send({ type: 'state', state: await state() });
      send({ type: 'done' });
    } finally {
      if (workerRunId) {
        runs.delete(workerRunId);
        durableIssueSinks.delete(workerRunId);
        durableIssueReported.delete(workerRunId);
      }
      invalidateHeavyState();
      res.end();
    }
  }

  async function streamRun(input: string, res: ServerResponse, clientRequestId?: string, expectedSessionId?: string): Promise<void> {
    // A conversation may be changed while this run continues. Capture every
    // session/runtime value used by the run so later UI navigation cannot move
    // the in-flight stream onto the newly selected conversation.
    const runSession = session;
    const runWorkDir = workDir;
    const runBridgeMode = bridgeMode;
    const runBridgeConfig = activeBridgeConfig;
    const runBridgeModelApi = activeBridgeModelApi;
    const runRouter = activeRouter;
    const runAgentOptions = currentEffectiveAgentRunOptions();
    const runTools = currentRunTools();
    if (rejectMismatchedGuiSession(res, expectedSessionId, runSession.id)) return;
    let nextEventSequence = 0;
    const replayEvents: Array<GuiRunEvent & { sequence: number }> = [];
    const send = (event: GuiRunEvent) => {
      const payload = { ...event, sequence: ++nextEventSequence };
      replayEvents.push(payload);
      if (replayEvents.length > 2_000) replayEvents.shift();
      if (res.destroyed || res.writableEnded) return;
      try { res.write(`${JSON.stringify(payload)}\n`); } catch { /* renderer may reconnect */ }
    };
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    send({ type: 'user', text: input });

    const externalCliSelected = runBridgeConfig?.execution === 'cli';
    if (needsCredentials && !externalCliSelected) {
      send({ type: 'error', message: 'No API key configured — open Settings → Models to add one.' });
      send({ type: 'state', state: await state() });
      send({ type: 'done' });
      res.end();
      return;
    }

    if (input.startsWith('/team ask ')) {
      // Live team run (plan phase 4). Unlike array-returning slash commands,
      // this streams member activity as it happens via onEvent → forwardTeamEvent,
      // and registers a 'team' run so the Monitor pane shows it live.
      const rest = input.slice('/team ask '.length).trim();
      const parsed = parseTeamAskArguments(rest);
      if (!parsed) {
        send({ type: 'error', message: 'usage: /team ask <name> <prompt>' });
        send({ type: 'done' });
        res.end();
        return;
      }
      const { name: teamName, prompt } = parsed;
      const definition = resolveTeamDefinition(teamName, runWorkDir, runSession.model);
      if (!definition) {
        send({ type: 'error', message: `team not found: ${teamName}` });
        send({ type: 'done' });
        res.end();
        return;
      }
      runSession.metadata.__hadamardLastTeamName = definition.name;
      const teamRunId = 'r-team-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const teamAbort = new AbortController();
      const teamDesc: GuiRunDescriptor = {
        runId: teamRunId, clientRequestId, kind: 'team', label: `team:${definition.name}`,
        sessionId: runSession.id, model: runSession.model || null, startedAt: Date.now(),
        status: 'running', toolCalls: 0, tokenUsage: { input: 0, output: 0 },
        team: { mode: definition.mode, round: 0, members: [] },
      };
      const teamRun: GuiRunRecord = { desc: teamDesc, abort: teamAbort, sink: send, events: replayEvents };
      assertRunCanStart();
      runs.set(teamRunId, teamRun);
      try {
        send({ type: 'run.started', runId: teamRunId, model: runSession.model || null });
        const onEvent = (e: TeamEvent) => { forwardTeamEvent(e, teamRunId, send, teamDesc); };
        const result: ModelTeamResult = await askTeamDefinition(
          definition,
          prompt,
          teamAbort.signal,
          {
            workDir: runWorkDir,
            homeDir: resolveGuiHomeDir(),
            onEvent,
            model: runBridgeModelApi?.model ?? runSession.model,
            modelApi: runBridgeModelApi?.modelApi,
          },
        );
        teamDesc.status = 'done';
        lastTeamRunSummary = `${definition.name} · ${result.mode} · ${Math.round(result.durationMs / 1000)}s`;
        send({ type: 'command.result', title: `Team response · ${result.mode}`, text: result.answer, runId: teamRunId });
        if (result.incompleteReason) send({ type: 'notice', message: `team incomplete: ${result.incompleteReason}` });
        send({ type: 'state', state: await state() });
        send({ type: 'done' });
      } catch (error) {
        const err = error as Error;
        teamDesc.status = teamAbort.signal.aborted ? 'aborted' : 'error';
        send({ type: 'error', message: teamAbort.signal.aborted ? 'interrupted' : err.message });
      } finally {
        retainRunReplay(teamRun);
        runs.delete(teamRunId);
        invalidateHeavyState();
        res.end();
      }
      return;
    }

    if (input === '/manager update' || input.startsWith('/manager update ')
      || input.startsWith('/manager chat ') || input.startsWith('/manager team ')
      || input.startsWith('/assistant chat ') || input.startsWith('/assistant team ')) {
      // Streamed Manager run (plan M1): registers a RunRegistry kind='manager'
      // run so the Monitor shows it live. Single-instance per project.
      const isUpdate = input === '/manager update' || input.startsWith('/manager update ');
      const isGlobal = input.startsWith('/assistant ');
      try {
        let result: string;
        if (isUpdate) {
          const instruction = input.slice('/manager update'.length).trim() || undefined;
          result = await runManagerTurn({ mode: 'update', instruction, send, clientRequestId, replayEvents });
        } else {
          const teamPrefix = isGlobal ? '/assistant team' : '/manager team';
          const chatPrefix = isGlobal ? '/assistant chat' : '/manager chat';
          const isTeam = input.startsWith(teamPrefix + ' ');
          const request = input.slice((isTeam ? teamPrefix : chatPrefix).length).trim();
          const text = isTeam
            ? `Propose a Team Graph for this request. Inspect existing Teams first when relevant. ${request}`
            : request;
          result = await runManagerTurn({
            mode: 'chat',
            scope: isGlobal ? 'global' : 'project',
            text,
            send,
            clientRequestId,
            replayEvents,
          });
        }
        send({
          type: 'command.result',
          title: isUpdate ? 'Manager · Design updated' : 'Manager',
          text: result,
          runId: undefined,
        });
        send({ type: 'state', state: await state() });
        send({ type: 'done' });
      } catch (error) {
        send({ type: 'error', message: (error as Error).message });
      } finally {
        res.end();
      }
      return;
    }

    if (input.startsWith('/')) {
      try {
        for (const event of await runSlashCommand(input)) send(event);
        send({ type: 'state', state: await state() });
        send({ type: 'done' });
      } catch (error) {
        send({ type: 'error', message: (error as Error).message });
      } finally {
        res.end();
      }
      return;
    }

    const runId = 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const runAbort = new AbortController();
    const desc: GuiRunDescriptor = {
      runId,
      clientRequestId,
      kind: 'chat',
      label: input.slice(0, 80) || 'chat',
      sessionId: runSession.id,
      model: runSession.model || null,
      startedAt: Date.now(),
      status: 'running',
      toolCalls: 0,
      tokenUsage: { input: 0, output: 0 },
    };
    const run: GuiRunRecord = { desc, abort: runAbort, sink: send, events: replayEvents };
    assertRunCanStart();
    runs.set(runId, run);
    foregroundRunId = runId;
    let streamedTextSeen = false;
    let errorEventSeen = false;
    await persistSessionRuntimeMetadata(runSession, runBridgeConfig, runBridgeModelApi?.model ?? null);
    try {
      // Router dispatch is skipped when a named config is active — the config's
      // model and/or provider replaces per-turn routing.
      const configActive = !!runBridgeConfig;
      let routed: { model: string; modelApi: import('../types.js').CreateAgentSdkOptions['modelApi']; effort?: HadamardRunEffort } | undefined;
      if (runRouter && !runBridgeMode && !configActive) {
        const routerName = runRouter.name;
        try {
          const decision = await resolveRoutedRun(runRouter, input, runAbort.signal, {
            projectDir: runWorkDir,
            homeDir: resolveGuiHomeDir(),
          });
          routed = { model: decision.model, modelApi: decision.modelApi, effort: decision.effort };
          routedModelLabel = `${decision.label} (${decision.model})`;
          send({ type: 'notice', message: `router -> ${routedModelLabel}` });
        } catch (error) {
          // §3.5: with the default-model fallback off, a broken router reference
          // is an explicit error (client shows the repair modal), not a silent
          // degrade to the session model.
          if (error instanceof BrokenReferenceError && !(await defaultModelFallbackEnabled())) {
            send({
              type: 'broken.reference',
              kind: error.kind,
              targetName: error.targetName,
              from: { kind: 'router', name: routerName },
              message: `Router "${routerName}" reference is broken: ${error.message}`,
            });
            throw error;
          }
          send({ type: 'notice', message: `router classification failed: ${(error as Error).message}` });
        }
      }
      // Three modes:
      //  1. bridge config active → inject pre-built ModelApi (separate credentials)
      //  2. hadamard config active → inject model only (use SDK default provider)
      //  3. none active → in-process turn, optionally routed or teamed
      const effectiveAgentOptions = runAgentOptions;
      const hadamardModel = (!runBridgeMode && runBridgeConfig?.runtime === 'hadamard')
        ? (runBridgeConfig.model || undefined)
        : undefined;
      let stream: AsyncIterable<AgentEvent> & { result: Promise<AgentRunResult> };
      const externalCliConfig = runBridgeConfig?.execution === 'cli'
      && isManagedExternalCliRuntime(runBridgeConfig.runtime)
        ? runBridgeConfig as PersistedBridgeConfig & { runtime: 'claude' | 'codex' }
        : undefined;
      if (externalCliConfig) {
        send({
          type: 'notice',
          message: 'external CLI -> '
            + externalCliConfig.runtime
            + ' ('
            + (externalCliConfig.authSource === 'apiKey' ? 'API key override' : 'native login')
            + ')',
        });
        stream = createExternalCliAgentStream(
          input,
          externalCliConfig,
          runId,
          runAbort.signal,
          runSession,
          runWorkDir,
        );
      } else if (runBridgeMode && runBridgeModelApi) {
        const bridgeName = runBridgeConfig?.name ?? 'bridge';
        send({ type: 'notice', message: `bridge -> ${bridgeName} (${runBridgeModelApi.model})` });
        stream = runSession.stream(expandImageRefs(input, runWorkDir), {
          ...effectiveAgentOptions,
          signal: withAgentRunTimeout(runAbort.signal),
          approver,
          classifier: preToolUseHookClassifier,
          canUseTool,
          model: runBridgeModelApi.model,
          modelApi: runBridgeModelApi.modelApi,
          ...(runTools ? { tools: runTools } : {}),
        });
      } else {
        stream = runSession.stream(expandImageRefs(input, runWorkDir), {
          ...effectiveAgentOptions,
          signal: withAgentRunTimeout(runAbort.signal),
          approver,
          classifier: preToolUseHookClassifier,
          canUseTool,
          // Per-route effort (router) wins over session/agent effort for the routed turn.
          ...(routed?.effort ? { effort: routed.effort } : {}),
          ...(routed ? { model: routed.model, modelApi: routed.modelApi } : {}),
          ...(hadamardModel ? { model: hadamardModel } : {}),
          ...(runTools ? { tools: runTools } : {}),
        });
      }

      // If a hadamard config is active, send a brief notice (model-only, no credentials change).
      if (hadamardModel && !runBridgeMode) {
        send({ type: 'notice', message: `hadamard model -> ${hadamardModel} (config: ${runBridgeConfig!.name})` });
      }
      // Track tool call inputs so PostToolUse hooks (fire-and-forget) get both the
      // input and the output for the matching result.
      const toolCallInputs = new Map<string, { name: string; input: unknown }>();
      for await (const event of stream) {
        forwardAgentEvent(event, send, runId);
        if (event.type === 'error') errorEventSeen = true;
        if (event.type === 'tool.call') {
          desc.toolCalls += 1;
          desc.currentTool = event.call.publicName;
          toolCallInputs.set(event.call.id, { name: event.call.publicName, input: event.call.input });
          // Capture the live todo list from TodoWrite calls for the panel.
          if (event.call.publicName === 'TodoWrite') {
            const tasks = (event.call.input as { tasks?: unknown[] } | null)?.tasks;
            if (Array.isArray(tasks)) {
              todos = tasks.map((t) => {
                const task = t as { subject?: string; status?: string; activeForm?: string };
                return {
                  subject: typeof task.subject === 'string' ? task.subject : '',
                  status: typeof task.status === 'string' ? task.status : 'pending',
                  ...(typeof task.activeForm === 'string' && task.activeForm ? { activeForm: task.activeForm } : {}),
                };
              }).filter(t => t.subject);
            }
          }
        } else if (event.type === 'tool.result') {
          const prev = toolCallInputs.get(event.result.id);
          runPostToolUseHooks(
            () => readPostToolUseHooks(getLoadedJsonConfig()?.raw),
            event.result.publicName,
            prev?.input,
            event.result.outputText,
            workDir,
          );
          toolCallInputs.delete(event.result.id);
        }
        if (event.type === 'response.text.delta' && event.delta) { streamedTextSeen = true; desc.lastText = (desc.lastText || '') + event.delta; }
      }
      const result = await stream.result;
      if (!streamedTextSeen && result.text) send({ type: 'delta', text: result.text });
      if (result.incompleteReason) send({ type: 'notice', message: `run incomplete: ${result.incompleteReason}` });
      const effectiveModel = externalCliConfig?.model
        ?? (externalCliConfig ? externalCliConfig.runtime : undefined)
        ?? hadamardModel
        ?? routed?.model
        ?? runBridgeModelApi?.model
        ?? runSession.model;
      recordUsage(effectiveModel, (result as any).usage);
      desc.status = 'done';
      const runUsage = (result as any).usage;
      if (runUsage) desc.tokenUsage = { input: runUsage.input_tokens ?? 0, output: runUsage.output_tokens ?? 0 };
      // Lightweight global history — one JSONL line per user turn (mirrors Codex / Claude Code).
      try {
        recordTurn({
          sessionId: runSession.id,
          ts: Math.floor(Date.now() / 1000),
          text: input.slice(0, 200),
          model: effectiveModel,
        }, resolveGuiHomeDir());
      } catch { /* never fail a turn over a history write */ }
      if (sdk) toolMetadata = await sdk.listToolMetadata();
      invalidateHeavyState();
      send({ type: 'state', state: await state() });
      send({ type: 'done', usage: (result as any).usage });
    } catch (error) {
      const err = error as Error;
      desc.status = runAbort.signal.aborted ? 'aborted' : 'error';
      if (!errorEventSeen) {
        send({ type: 'error', message: runAbort.signal.aborted ? 'interrupted' : err.message });
      }
    } finally {
      retainRunReplay(run);
      runs.delete(runId);
      if (foregroundRunId === runId) foregroundRunId = null;
      invalidateHeavyState();
      res.end();
    }
  }

  // Read-only git view. Keep child processes off the Node event loop so a slow
  // repository cannot freeze streaming, status polling, or Electron input.
  async function gitText(args: string[], cwd = workDir): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return String(stdout).trim();
    } catch {
      return '';
    }
  }
  let gitBranchCache: { cwd: string; expiresAt: number; value: { isRepo: boolean; branch: string | null } } | null = null;
  let gitBranchPending: { cwd: string; promise: Promise<{ isRepo: boolean; branch: string | null }> } | null = null;
  async function gitBranchSummary(): Promise<{ isRepo: boolean; branch: string | null }> {
    const cwd = workDir;
    if (gitBranchCache?.cwd === cwd && gitBranchCache.expiresAt > Date.now()) return gitBranchCache.value;
    if (gitBranchPending?.cwd === cwd) return gitBranchPending.promise;
    const promise = (async () => {
      const isRepo = await gitText(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
      const branch = isRepo ? await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) : '';
      const value = { isRepo, branch: branch || null };
      gitBranchCache = { cwd, expiresAt: Date.now() + 2_000, value };
      return value;
    })();
    gitBranchPending = { cwd, promise };
    try { return await promise; }
    finally { if (gitBranchPending?.promise === promise) gitBranchPending = null; }
  }
  async function gitInfo(): Promise<Record<string, unknown>> {
    const cwd = workDir;
    if (await gitText(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return { isRepo: false };
    const [statusRaw, branchesRaw, logRaw, upstream, branch, userName, userEmail] = await Promise.all([
      gitText(['status', '--porcelain=v1'], cwd),
      gitText(['branch', '--format=%(HEAD)\t%(refname:short)'], cwd),
      gitText(['log', '--decorate=short', '--pretty=format:%h%x1f%s%x1f%an%x1f%ae%x1f%ar%x1f%aI%x1f%p%x1f%D%x1e', '-n', '30'], cwd),
      gitText(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd),
      gitText(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      gitText(['config', 'user.name'], cwd),
      gitText(['config', 'user.email'], cwd),
    ]);
    const status = statusRaw
      ? statusRaw.split('\n').filter(Boolean).map((line) => ({ x: (line[0] ?? ' ').trim(), y: (line[1] ?? ' ').trim(), file: line.slice(3) }))
      : [];
    const branches = branchesRaw
      ? branchesRaw.split('\n').filter(Boolean).map((line) => {
          const [head, ...rest] = line.split('\t');
          return { name: rest.join('\t') || line.trim(), current: head === '*' };
        })
      : [];
    const commits = parseGitCommitLog(logRaw);
    let ahead = 0;
    let behind = 0;
    const counts = upstream ? await gitText(['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd) : '';
    if (counts) {
      const [b, a] = counts.split(/\s+/);
      behind = Number(b) || 0;
      ahead = Number(a) || 0;
    }
    return {
      isRepo: true,
      cwd,
      branch,
      upstream,
      ahead,
      behind,
      status,
      branches,
      commits,
      userName: userName || null,
      userEmail: userEmail || null,
    };
  }

  async function deleteSession(id: string): Promise<Record<string, unknown>> {
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath, homeDir: currentHomeInput() }).catch(() => undefined);
    const homeDir = store?.homeDir ?? resolveGuiHomeDir();
    const roots = await collectSessionStoreRoots(homeDir, sdk!.config.sessionDirectory);
    // Also include the SDK session dir's parent (it may hold sessions/ directly).
    roots.push(path.dirname(sdk!.config.sessionDirectory));
    let deleted = false;
    for (const projectRoot of roots) {
      // Check the active sessions directory.
      for (const item of await listStoredSessionFiles(projectRoot)) {
        if (item.id !== id && item.storageId !== id) continue;
        await rm(item.filePath, { force: true });
        await rm(path.join(projectRoot, 'sessions', '.checkpoints', item.storageId), { recursive: true, force: true });
        deleted = true;
      }
      // Also check the archive directory.
      const archiveDir = path.join(projectRoot, 'archive');
      try {
        for (const file of await readdir(archiveDir)) {
          const storageId = jsonStorageId(file);
          if (!storageId) continue;
          let sessionId: string | undefined;
          try {
            const raw = JSON.parse(await readFile(path.join(archiveDir, file), 'utf8')) as unknown;
            if (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string') {
              sessionId = (raw as { id: string }).id;
            }
          } catch { /* skip */ }
          if (sessionId !== id && storageId !== id) continue;
          await rm(path.join(archiveDir, file), { force: true });
          await rm(path.join(archiveDir, '.checkpoints', storageId), { recursive: true, force: true });
          deleted = true;
        }
      } catch { /* archive dir may not exist */ }
    }
    // If the active chat was deleted, open a fresh one so the UI stays consistent.
    if (session.id === id) {
      session = await createGuiSession({ model: options.model, permissionMode });
      await restoreSessionRuntimeSelection();
    }
    invalidateHeavyState();
    return { deleted, state: await state() };
  }

  // ── Archive / unarchive sessions ─────────────────────────────────────
  // Move a session from sessions/ → archive/ (peer dir that the SDK never
  // touches), so it's hidden from both TUI and GUI session lists.
  async function archiveSession(id: string): Promise<boolean> {
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath, homeDir: currentHomeInput() }).catch(() => undefined);
    const homeDir = store?.homeDir ?? resolveGuiHomeDir();
    const sessionDirectory = sdk?.config.sessionDirectory
      ?? getHadamardProjectSessionDirectory(workDir, homeDir);
    const roots = await collectSessionStoreRoots(homeDir, sessionDirectory);
    roots.push(path.dirname(sessionDirectory)); // SDK session dir's parent
    for (const projectRoot of roots) {
      for (const item of await listStoredSessionFiles(projectRoot)) {
        if (item.id !== id && item.storageId !== id) continue;
        const archiveDir = path.join(projectRoot, 'archive');
        await mkdir(archiveDir, { recursive: true });
        await rename(item.filePath, path.join(archiveDir, item.storageId + '.json'));
        const ckptSrc = path.join(projectRoot, 'sessions', '.checkpoints', item.storageId);
        const ckptDst = path.join(archiveDir, '.checkpoints', item.storageId);
        try { await mkdir(path.dirname(ckptDst), { recursive: true }); await rename(ckptSrc, ckptDst); } catch { /* no checkpoints */ }
        // If the active chat was archived, open a fresh one.
        if (session.id === id) {
          session = await createGuiSession({ model: options.model, permissionMode });
          await restoreSessionRuntimeSelection();
        }
        invalidateHeavyState();
        return true;
      }
    }
    return false;
  }

  async function unarchiveSession(id: string): Promise<boolean> {
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath, homeDir: currentHomeInput() }).catch(() => undefined);
    const homeDir = store?.homeDir ?? resolveGuiHomeDir();
    const sessionDirectory = sdk?.config.sessionDirectory
      ?? getHadamardProjectSessionDirectory(workDir, homeDir);
    const roots = await collectSessionStoreRoots(homeDir, sessionDirectory);
    roots.push(path.dirname(sessionDirectory));
    for (const projectRoot of roots) {
      const archiveDir = path.join(projectRoot, 'archive');
      try {
        const files = await readdir(archiveDir);
        for (const file of files) {
          const storageId = jsonStorageId(file);
          if (!storageId) continue;
          // Read the archived file to get the session id.
          let sessionId: string | undefined;
          try {
            const raw = JSON.parse(await readFile(path.join(archiveDir, file), 'utf8')) as unknown;
            if (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string') {
              sessionId = (raw as { id: string }).id;
            }
          } catch { /* skip unreadable */ }
          if (sessionId !== id && storageId !== id) continue;
          const sessionsDir = path.join(projectRoot, 'sessions');
          await mkdir(sessionsDir, { recursive: true });
          await rename(path.join(archiveDir, file), path.join(sessionsDir, file));
          const ckptSrc = path.join(archiveDir, '.checkpoints', storageId);
          const ckptDst = path.join(sessionsDir, '.checkpoints', storageId);
          try { await mkdir(path.dirname(ckptDst), { recursive: true }); await rename(ckptSrc, ckptDst); } catch { /* no checkpoints */ }
          invalidateHeavyState();
          return true;
        }
      } catch { /* archive dir doesn't exist */ }
    }
    return false;
  }

  async function listArchivedSessions(): Promise<Array<{ id: string; storageId: string; title?: string; model?: string; messageCount: number; workDir?: string }>> {
    const results: Array<{ id: string; storageId: string; title?: string; model?: string; messageCount: number; workDir?: string }> = [];
    const addDir = async (archiveDir: string) => {
      try {
        for (const file of await readdir(archiveDir)) {
          const storageId = jsonStorageId(file);
          if (!storageId) continue;
          try {
            const raw = JSON.parse(await readFile(path.join(archiveDir, file), 'utf8')) as unknown;
            if (typeof raw !== 'object' || raw === null) continue;
            const obj = raw as { id?: unknown; title?: unknown; model?: unknown; messages?: unknown; metadata?: unknown };
            const messages = Array.isArray(obj.messages) ? obj.messages : [];
            results.push({
              id: typeof obj.id === 'string' ? obj.id : storageId,
              storageId,
              title: typeof obj.title === 'string' ? obj.title : undefined,
              model: typeof obj.model === 'string' ? obj.model : undefined,
              messageCount: messages.length,
              workDir: typeof obj.metadata === 'object' && obj.metadata !== null && typeof (obj.metadata as { __hadamardWorkDir?: unknown }).__hadamardWorkDir === 'string'
                ? (obj.metadata as { __hadamardWorkDir: string }).__hadamardWorkDir : undefined,
            });
          } catch { /* skip unreadable */ }
        }
      } catch { /* archive dir doesn't exist */ }
    };
    // Check archive/ subdirs of all known project roots + the session dir's parent.
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath, homeDir: currentHomeInput() }).catch(() => undefined);
    const homeDir = store?.homeDir ?? resolveGuiHomeDir();
    const roots = await collectSessionStoreRoots(homeDir, sdk!.config.sessionDirectory);
    for (const projectRoot of roots) {
      await addDir(path.join(projectRoot, 'archive'));
    }
    // Also check the parent of the session directory (SDK may store sessions directly there).
    await addDir(path.resolve(sdk!.config.sessionDirectory, '..', 'archive'));
    await addDir(path.join(path.dirname(sdk!.config.sessionDirectory), 'archive'));
    // Fallback: scan any archive/ dir directly under the SDK data root.
    try {
      const dataRoot = homeDir;
      for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        await addDir(path.join(dataRoot, entry.name, 'archive'));
      }
    } catch { /* data dir may not exist */ }
    return results;
  }

  async function forgetProject(targetPath: string): Promise<Record<string, unknown>> {
    const resolved = path.resolve(targetPath);
    if (normalizeFsPath(resolved) === normalizeFsPath(workDir)) {
      return { ok: false, error: 'Cannot forget the active workspace — switch to another first.', state: await state() };
    }
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath, homeDir: currentHomeInput() }).catch(() => undefined);
    const homeDir = store?.homeDir ?? resolveGuiHomeDir();
    // Only touch the forgotten workspace's own session store (+ current SDK dir
    // in case older sessions were written there with this workDir metadata).
    const roots = uniquePaths([
      getHadamardProjectSessionDirectory(resolved, homeDir),
      sdk!.config.sessionDirectory,
      path.dirname(sdk!.config.sessionDirectory),
    ]);
    let deleted = 0;
    for (const projectRoot of roots) {
      for (const item of await listStoredSessionFiles(projectRoot)) {
        if (!item.workDir || normalizeFsPath(item.workDir) !== normalizeFsPath(resolved)) continue;
        await rm(item.filePath, { force: true });
        await rm(path.join(projectRoot, 'sessions', '.checkpoints', item.storageId), { recursive: true, force: true });
        deleted += 1;
      }
    }
    await forgetWorkspaceFromRegistry(resolved, homeDir).catch(() => undefined);
    invalidateHeavyState();
    return { ok: true, deleted, state: await state() };
  }

  async function pinProject(targetPath: string, pinned: boolean): Promise<Record<string, unknown>> {
    const resolved = path.resolve(targetPath);
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath, homeDir: currentHomeInput() }).catch(() => undefined);
    const homeDir = store?.homeDir ?? resolveGuiHomeDir();
    await setWorkspacePinned(resolved, homeDir, pinned);
    invalidateHeavyState();
    return { ok: true, pinned, state: await state() };
  }

  async function updateProjectWorkPath(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = typeof body.action === 'string' ? body.action : '';
    const primary = typeof body.projectPath === 'string' && body.projectPath.trim()
      ? path.resolve(body.projectPath.trim())
      : projectPrimaryPath;
    const rawWorkPath = typeof body.workPath === 'string' ? body.workPath.trim() : '';
    if (!rawWorkPath) throw new Error('Missing work path.');
    const target = await resolveWorkspaceDirectory(rawWorkPath);
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    }).catch(() => undefined);
    const homeDir = store?.homeDir ?? resolveGuiHomeDir();

    if (action === 'add') {
      await addProjectWorkPath(primary, target, homeDir);
      if (body.activate === true) await switchProject(target);
    } else if (action === 'activate') {
      const before = findWorkspaceProject(await readWorkspaceRegistry(homeDir), primary);
      const previousActive = before ? workspaceActiveWorkPath(before) : primary;
      await setProjectActiveWorkPath(primary, target, homeDir);
      try {
        await switchProject(target);
      } catch (error) {
        await setProjectActiveWorkPath(primary, previousActive, homeDir).catch(() => undefined);
        throw error;
      }
    } else if (action === 'remove') {
      if (normalizeFsPath(target) === normalizeFsPath(workDir)) {
        throw new Error('Cannot remove the active work path. Switch to another path first.');
      }
      await removeProjectWorkPath(primary, target, homeDir);
    } else {
      throw new Error('Unknown work-path action.');
    }
    invalidateHeavyState();
    await refreshProjectPrimaryPath();
    return { ok: true, state: await state({ light: true }) };
  }

  const issueTargetPath = (rawPath: unknown): string =>
    typeof rawPath === 'string' && rawPath.trim()
      ? path.resolve(rawPath.trim())
      : workDir;

  const agentExecutionTargetPath = async (rawPath: string | null): Promise<string | undefined> => {
    const input = rawPath?.trim();
    if (!input) return undefined;
    try {
      const resolved = path.resolve(input);
      return (await stat(resolved)).isDirectory() ? resolved : undefined;
    } catch {
      return undefined;
    }
  };

  const issueStorageFor = async (targetPath: string, homeDir: string): Promise<IssueStorageMode> => {
    const meta = await readProjectMeta(targetPath, homeDir);
    return isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home';
  };

  const issuePayload = async (targetPath: string, homeDir: string): Promise<Record<string, unknown>> => {
    const storage = await issueStorageFor(targetPath, homeDir);
    const issues = await listProjectIssues(targetPath, homeDir, storage);
    return {
      ok: true,
      path: targetPath,
      storage,
      storageModes: ['home', 'workspace'],
      statuses: ISSUE_STATUSES,
      priorities: ISSUE_PRIORITIES,
      issues,
      counts: Object.fromEntries(ISSUE_STATUSES.map((status) => [
        status,
        issues.filter((issue) => issue.status === status).length,
      ])),
    };
  };

  const issueCommentKindFrom = (value: unknown): IssueCommentKind =>
    value === 'progress' ? 'progress' : 'comment';

  function createIssueReportToolForRun(args: {
    targetPath: string;
    homeDir: string;
    storage: IssueStorageMode;
    issueId: string | number;
    onReported?: () => void;
  }): AgentToolDefinition {
    return tool(
      {
        name: 'IssueReport',
        description:
          'Report the outcome for the issue assigned to this session. Call status=in_review when work and self-checks are complete; call status=blocked when you cannot proceed.',
        inputSchema: z.strictObject({
          status: z.enum(['in_review', 'blocked']),
          summary: z.string().describe('Concise outcome summary and verification performed'),
          followUps: z.array(z.string()).optional().describe('Optional follow-up items or blocker details'),
        }),
        isReadOnly: () => false,
        serialize: (output: { status: string }) => `Issue reported: ${output.status}`,
      },
      async (input) => {
        const body = [
          input.summary,
          Array.isArray(input.followUps) && input.followUps.length
            ? '\nFollow-ups:\n' + input.followUps.map((item) => `- ${item}`).join('\n')
            : '',
        ].join('').trim();
        await addIssueComment(args.targetPath, args.homeDir, args.issueId, {
          body,
          actor: 'agent',
          kind: 'progress',
        }, args.storage);
        const issue = await transitionProjectIssue(args.targetPath, args.homeDir, args.issueId, input.status, 'agent', args.storage);
        if (!issue) throw new Error(`Issue not found: ${String(args.issueId)}`);
        args.onReported?.();
        return { ok: true, status: issue.status, issue };
      },
    );
  }

  // The server binds only to loopback. The Host check defeats DNS rebinding,
  // the Origin check rejects cross-site browser requests, and the per-process
  // token prevents blind API calls. It is not an OS-level boundary against
  // another process running as the same local user.
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', host.toLowerCase()]);
  const hostHeaderAllowed = (req: IncomingMessage): boolean => {
    const header = req.headers.host;
    if (!header) return false;
    return loopbackHosts.has(header.replace(/:\d+$/, '').toLowerCase());
  };
  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients and same-origin GETs omit Origin
    try {
      return loopbackHosts.has(new URL(origin).hostname.toLowerCase());
    } catch {
      return false;
    }
  };

  // Probe node-pty once (loads the N-API prebuilt). terminalCapable gates the
  // terminal tab; if the prebuilt is missing the GUI silently hides the pane.
  terminalCapable = await ptyAvailable();
  const httpRouter = new GuiHttpRouter();
  registerGuiShellHttpController(httpRouter, authToken);
  registerGuiDesignHttpController(httpRouter, {
    createService: () => new DesignDocumentService(projectPrimaryPath, resolveGuiHomeDir()),
    openFolder: openPathInSystem,
  });
  registerGuiChatHttpController(httpRouter, {
    runtimeMutationInProgress: () => runtimeMutationInProgress,
    send: streamRun,
    sendIssue: (id, agentConfig, res) => streamIssueDispatch({
      id,
      ...(agentConfig ? { agentConfig } : {}),
    }, res),
    submitPendingInput: (input, mode) => {
      const active = [...runs.values()].some(record =>
        record.desc.status === 'running' && record.desc.sessionId === session.id,
      );
      if (!active) return { active: false, pendingInputCount: session.pendingInputCount };
      if (mode === 'steer') session.steer(input);
      else session.followUp(input);
      return { active: true, pendingInputCount: session.pendingInputCount };
    },
    createSession: () => enqueueServerSessionResume(async () => {
      assertSessionNavigationAllowed();
      await replaceGuiSession(await createGuiSession({ model: options.model, permissionMode }));
      await restoreSessionRuntimeSelection();
      return state();
    }),
    resumeSession: req => enqueueServerSessionResume(async () => {
      assertSessionNavigationAllowed();
      const body = await readJson(req);
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) return { status: 400, error: 'Missing session id' };
      const listed = await listGuiSessions();
      const target = listed.find(item => item.id === id);
      if (target && isEmptyUserSessionSummary(target)) {
        await (sdk ? sdk.sessions.delete(id) : credentiallessSessionStore.delete(id)).catch(() => undefined);
        return { status: 404, error: 'Empty sessions cannot be resumed.' };
      }
      if (target?.kind === 'manager') {
        return { status: 400, error: 'Manager sessions live in the Project Manager panel only.' };
      }
      try {
        await replaceGuiSession(await resumeGuiSession(id, {
          model: options.model,
          permissionMode: options.permissionMode,
        }));
      } catch {
        const restored = await unarchiveSession(id);
        if (!restored) return { status: 404, error: 'Session not found' };
        await replaceGuiSession(await resumeGuiSession(id, {
          model: options.model,
          permissionMode: options.permissionMode,
        }));
      }
      await restoreSessionRuntimeSelection();
      return { status: 200, state: await state() };
    }),
    resolvePermission: (id, decision, answers) => {
      const pending = pendingPermissions.get(id);
      if (!pending) return false;
      pending.resolve({ decision, answers });
      return true;
    },
    replayRun: (runId, after) => {
      const target = runId ? (runs.get(runId) ?? runReplayTombstones.get(runId)) : undefined;
      if (!target) return undefined;
      return {
        active: target.desc.status === 'running',
        run: target.desc,
        earliestSequence: target.events?.[0]?.sequence ?? null,
        events: (target.events ?? []).filter(event => event.sequence > after),
      };
    },
    abortRun: runId => {
      const id = runId ?? foregroundRunId;
      const target = id ? runs.get(id) : undefined;
      target?.abort.abort();
      return Boolean(target);
    },
    mutationError: error => ({
      status: runtimeMutationErrorStatus(error),
      body: runtimeMutationErrorBody(error),
    }),
  });
  registerGuiSettingsHttpController(httpRouter, {
    dataRootStatus,
    changeDataRoot: body => withRuntimeMutation(() => changeDataRoot(body)),
    openDataRoot: () => {
      const root = resolveGuiHomeDir();
      openPathInSystem(root);
      return { path: root };
    },
    openConfig: async () => {
      const store = await resolveHadamardSettingsStore({
        configPath: options.configPath,
        homeDir: currentHomeInput(),
      }).catch(() => undefined);
      if (!store?.configPath) return undefined;
      openPathInSystem(store.configPath);
      return { path: store.configPath };
    },
    saveSettings: body => withRuntimeMutation(() => saveSettings(body)),
    readHooks: async () => {
      const store = await resolveHadamardSettingsStore({
        configPath: options.configPath,
        homeDir: currentHomeInput(),
      }).catch(() => undefined);
      const raw = store?.raw ?? getLoadedJsonConfig()?.raw;
      const typed = parseTypedHooks(raw?.typedHooks);
      return {
        configPath: store?.configPath ?? null,
        hooks: readUserHooksConfig(raw),
        typedHooks: typed.hooks,
        typedHookIssues: typed.issues,
      };
    },
    saveHooks: body => withRuntimeMutation(async () => {
      const store = await resolveHadamardSettingsStore({
        configPath: options.configPath,
        homeDir: currentHomeInput(),
      });
      const raw = structuredClone(store.raw);
      const hooks = 'hooks' in body
        ? normalizeUserHooksConfig(body.hooks)
        : readUserHooksConfig(raw);
      if ('hooks' in body) raw.hooks = toSettingsHooksBlock(hooks);
      const typed = 'typedHooks' in body
        ? parseTypedHooks(body.typedHooks)
        : parseTypedHooks(raw.typedHooks);
      if (typed.issues.length > 0) throw new Error(typed.issues.join(' '));
      if ('typedHooks' in body) raw.typedHooks = typed.hooks;
      await persistHadamardSettingsStore(store.configPath, raw);
      await loadJsonConfigFile(store.configPath);
      if ('typedHooks' in body && sdk && !needsCredentials) await reloadSdk();
      return {
        ok: true,
        configPath: store.configPath,
        hooks,
        typedHooks: typed.hooks,
        typedHookIssues: [],
      };
    }),
    mutationError: error => ({
      status: runtimeMutationErrorStatus(error),
      body: runtimeMutationErrorBody(error),
    }),
  });
  function parseDeleteStrategy(raw: unknown): DeleteFallbackStrategy {
    if (!isPlainRecord(raw)) return { type: 'leave' };
    if (raw.type === 'repoint' && typeof raw.target === 'string' && raw.target.trim()) {
      return { type: 'repoint', target: raw.target.trim() };
    }
    if (raw.type === 'degrade-model') return { type: 'degrade-model' };
    if (raw.type === 'remove-nodes') return { type: 'remove-nodes' };
    return { type: 'leave' };
  }

  async function referenceOperationContext() {
    const homeDir = resolveGuiHomeDir();
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
      homeDir: currentHomeInput(),
    }).catch(() => undefined);
    return {
      projectDir: workDir,
      homeDir,
      managerProjectPath: projectPrimaryPath,
      teamPreferences: {
        read: () => teamPrefs,
        write: async (prefs: typeof teamPrefs) => {
          const raw = isPlainRecord(store?.raw) ? structuredClone(store.raw) : {};
          writeTeamPreferences(raw, prefs);
          if (store) {
            await persistHadamardSettingsStore(store.configPath, raw);
            await loadJsonConfigFile(store.configPath);
          }
          teamPrefs = prefs;
        },
      },
      issues: {
        read: async () => {
          const storage = await issueStorageFor(workDir, homeDir);
          return listProjectIssues(workDir, homeDir, storage);
        },
        writeAgentConfig: async (id: string, agentConfig: string | null) => {
          const storage = await issueStorageFor(workDir, homeDir);
          await updateProjectIssue(workDir, homeDir, id, { agentConfig }, storage);
        },
      },
      assistantConfig: {
        read: () => readAssistantConfig(homeDir),
        write: async (patch: { bridgeConfig?: string }) => {
          const current = await readAssistantConfig(homeDir);
          await writeAssistantConfig({ ...current, ...patch }, homeDir);
        },
      },
    };
  }

  async function buildGuiReferenceIndex(): Promise<GuiReferenceSnapshot> {
    const homeDir = resolveGuiHomeDir();
    const issueStorage = await issueStorageFor(workDir, homeDir);
    const [teams, routers, automationTasks, managerConfig, issues, assistantConfig] = await Promise.all([
      Promise.resolve(listTeamDefinitions(workDir, homeDir)),
      Promise.resolve(listRouterProfiles(workDir, homeDir)),
      listScheduledAutomationTasks(workDir),
      readManagerConfig(projectPrimaryPath, homeDir).catch(() => undefined),
      listProjectIssues(workDir, homeDir, issueStorage),
      readAssistantConfig(homeDir),
    ]);
    const workflows = listWorkflows(workDir, homeDir);
    const bridgeConfigs = readBridgeConfigs(homeDir).configs;
    const profileByName = new Map(listAgentProfiles(homeDir).map(profile => [profile.name, profile]));
    for (const profile of readAllAgentReferenceProfiles(homeDir, workDir)) {
      profileByName.set(profile.name, profile);
    }
    const index = buildReferenceIndex({
      bridgeConfigs,
      agentProfiles: [...profileByName.values()],
      routers: routers.map((entry) => entry.profile),
      teams: teams.map((entry) => entry.definition),
      automationTasks,
      teamPreferences: teamPrefs,
      managerConfigs: managerConfig
        ? [{ name: projectPrimaryPath, bridgeConfig: managerConfig.bridgeConfig }]
        : [],
      issues,
      assistantConfig,
      session: {
        activeAgent: activeAgentSelectionName,
        activeConfig: activeBridgeConfig?.name ?? null,
        activeRouterName: activeRouter?.name ?? null,
        activeTeamName,
      },
    });
    return {
      index,
      known: {
        configs: bridgeConfigs.map(config => config.name),
        agents: [
          ...listSelectableAgents(homeDir).map(agent => agent.name),
          ...listAgentDefinitionNames(homeDir, workDir),
        ],
        teams: teams.map(team => team.name),
        routers: routers.map(router => router.name),
        workflows: workflows.map(workflow => workflow.name),
      },
    };
  }

  registerGuiTeamHttpController(httpRouter, {
    definition: name => {
      const loaded = loadTeamDefinition(name, workDir);
      const raw = loaded?.definition ?? resolveTeamDefinition(name, workDir, session?.model ?? '');
      const squadType = (raw as TeamDefinition | null)?.squadType || 'graph';
      const definition = raw
        ? (squadType === 'graph' ? ensureConfiguredTeamGraph(migrateTeamDefinitionToGraph(raw)) : raw)
        : null;
      return { status: 200, body: { definition, source: loaded?.source ?? null } };
    },
    restoreDefault: name => {
      if (!name) return { status: 400, body: { error: 'name is required' } };
      const builtIn = getBuiltInTeamDefinition(name);
      if (builtIn) {
        return {
          status: 200,
          body: {
            definition: instantiateTeamDefinition(builtIn, session?.model ?? ''),
            source: 'built-in',
          },
        };
      }
      const loaded = loadTeamDefinition(name, workDir);
      if (!loaded) return { status: 404, body: { error: `team not found: ${name}` } };
      if (loaded.source === 'built-in') {
        return {
          status: 200,
          body: {
            definition: instantiateTeamDefinition(loaded.definition, session?.model ?? ''),
            source: 'built-in',
          },
        };
      }
      try {
        const raw = JSON.parse(readFileSync(loaded.filePath, 'utf-8')) as TeamDefinition;
        const squadType = raw.squadType || 'graph';
        const shaped = squadType === 'graph'
          ? ensureConfiguredTeamGraph(canonicalizeTeamDefinition(raw))
          : raw;
        return {
          status: 200,
          body: {
            definition: instantiateTeamDefinition(shaped, session?.model ?? ''),
            source: loaded.source,
          },
        };
      } catch (error) {
        return { status: 400, body: { error: (error as Error).message } };
      }
    },
    save: async body => {
      try {
        let definition = body.definition as TeamDefinition;
        if (!definition || typeof definition.name !== 'string' || !definition.name) {
          return { status: 400, body: { error: 'definition.name is required' } };
        }
        const squadType = (definition.squadType || 'graph') as 'graph' | 'workflow' | 'agent' | 'subagent';
        if (squadType === 'graph') {
          const migrated = ensureConfiguredTeamGraph(migrateTeamDefinitionToGraph(definition));
          const problems = validateTeamGraph(migrated);
          if (problems.length) return { status: 400, body: { error: problems.join('; '), problems } };
          definition = migrated;
        } else if (squadType === 'workflow') {
          const problems = validateWorkflowSquad(definition);
          if (problems.length) return { status: 400, body: { error: problems.join('; '), problems } };
          definition = { ...definition, squadType, mode: 'graph', version: 3, orchestration: 'graph' };
        } else if (isSingleAgentSquadType(squadType)) {
          definition = { ...definition, squadType: 'agent', mode: 'graph', version: 3, orchestration: 'graph' };
        } else {
          return { status: 400, body: { error: `unsupported squadType: ${squadType}` } };
        }
        const existing = loadTeamDefinition(definition.name, workDir, resolveGuiHomeDir());
        const target = body.target === 'project' || body.target === 'personal'
          ? body.target
          : existing?.source === 'project' ? 'project' : 'personal';
        const filePath = await saveTeamDefinition(definition, {
          projectDir: target === 'project' ? workDir : undefined,
          homeDir: resolveGuiHomeDir(),
          overwrite: true,
        });
        return { status: 200, body: { ok: true, filePath, target } };
      } catch (error) {
        return { status: 400, body: { error: (error as Error).message } };
      }
    },
    scaffold: body => {
      try {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return { status: 400, body: { error: 'name is required' } };
        const description = typeof body.description === 'string' ? body.description.trim() : undefined;
        const template = (body.template === 'parallel' || body.template === 'review-loop' ? body.template : 'blank') as GraphTeamTemplate;
        const definition = buildGraphTeamFromTemplate(name, template, description || undefined, {
          parallel: isPlainRecord(body.parallel) ? body.parallel as never : undefined,
          loop: isPlainRecord(body.loop) ? body.loop as never : undefined,
        });
        return { status: 200, body: { definition } };
      } catch (error) {
        return { status: 400, body: { error: (error as Error).message } };
      }
    },
    applyBlock: body => {
      try {
        const definition = body.definition as TeamDefinition;
        if (!definition || typeof definition.name !== 'string') {
          return { status: 400, body: { error: 'definition is required' } };
        }
        const block = body.block === 'loop' ? 'loop' : 'parallel';
        const blockOptions = isPlainRecord(body.options) ? body.options : {};
        if (block === 'parallel') {
          const members = Array.isArray(blockOptions.members) ? blockOptions.members : [];
          const parallelOptions = {
            members: members as never,
            join: blockOptions.join === 'any' ? 'any' as const : 'all' as const,
            synthesizer: blockOptions.synthesizer !== false,
            synthesizerId: typeof blockOptions.synthesizerId === 'string' ? blockOptions.synthesizerId : undefined,
            returnMode: blockOptions.returnMode === 'payload' ? 'payload' as const : 'void' as const,
          };
          if (blockOptions.mode === 'nested' || blockOptions.saveAsNested === true) {
            const nestedName = typeof blockOptions.nestedName === 'string' && blockOptions.nestedName.trim()
              ? blockOptions.nestedName.trim()
              : `${definition.name}-parallel`;
            const result = insertParallelAsNestedTeam(definition, { ...parallelOptions, nestedName });
            return { status: 200, body: { definition: result.definition, nested: result.nested } };
          }
          return { status: 200, body: { definition: insertParallelBlock(definition, parallelOptions) } };
        }
        if (blockOptions.mode === 'nested' || blockOptions.saveAsNested === true) {
          const nestedName = typeof blockOptions.nestedName === 'string' && blockOptions.nestedName.trim()
            ? blockOptions.nestedName.trim()
            : `${definition.name}-review-loop`;
          const result = insertLoopAsNestedTeam(definition, {
            executorId: typeof blockOptions.executorId === 'string' ? blockOptions.executorId : undefined,
            reviewerId: typeof blockOptions.reviewerId === 'string' ? blockOptions.reviewerId : undefined,
            maxRounds: typeof blockOptions.maxRounds === 'number' ? blockOptions.maxRounds : undefined,
            returnMode: blockOptions.returnMode === 'payload' ? 'payload' : 'void',
            nestedName,
          });
          return { status: 200, body: { definition: result.definition, nested: result.nested } };
        }
        return {
          status: 200,
          body: {
            definition: insertLoopBlock(definition, {
              executorId: typeof blockOptions.executorId === 'string' ? blockOptions.executorId : undefined,
              reviewerId: typeof blockOptions.reviewerId === 'string' ? blockOptions.reviewerId : undefined,
              maxRounds: typeof blockOptions.maxRounds === 'number' ? blockOptions.maxRounds : undefined,
              returnMode: blockOptions.returnMode === 'payload' ? 'payload' : 'void',
            }),
          },
        };
      } catch (error) {
        return { status: 400, body: { error: (error as Error).message } };
      }
    },
    proposal: async (proposalId, action, method, body) => {
      try {
        const proposal = teamProposals.get(proposalId);
        if (!proposal) return { status: 404, body: { error: `Unknown Team proposal: ${proposalId}` } };
        if (method === 'GET' && !action) return { status: 200, body: { proposal } };
        if (method === 'POST' && action === 'reject') {
          return { status: 200, body: { ok: true, proposal: teamProposals.reject(proposalId) } };
        }
        if (method === 'POST' && action === 'apply') {
          const applied = await withRuntimeMutation(() => teamProposals.apply(
            proposalId,
            managerHomeDir(),
            { editorBaseDigest: typeof body.editorBaseDigest === 'string' ? body.editorBaseDigest : undefined },
          ));
          return {
            status: 200,
            body: {
              ok: true,
              proposal: applied.proposal,
              filePath: applied.filePath,
              definition: applied.proposal.draft,
              openCanvas: {
                projectPath: applied.proposal.projectPath,
                teamName: applied.proposal.teamName,
              },
            },
          };
        }
        return { status: 405, body: { error: 'Method not allowed' } };
      } catch (error) {
        return { status: runtimeMutationErrorStatus(error), body: runtimeMutationErrorBody(error) };
      }
    },
    validate: body => {
      try {
        const definition = body.definition as TeamDefinition;
        if (!definition) return { status: 400, body: { error: 'definition is required' } };
        if (definition.squadType === 'workflow') {
          const problems = validateWorkflowSquad(definition);
          return { status: 200, body: { ok: problems.length === 0, problems, definition } };
        }
        if (isSingleAgentSquadType(definition.squadType)) {
          const problems = definition.members?.length ? [] : ['Agent squad requires at least one member'];
          return { status: 200, body: { ok: problems.length === 0, problems, definition } };
        }
        const migrated = ensureConfiguredTeamGraph(migrateTeamDefinitionToGraph(definition));
        const problems = validateTeamGraph(migrated);
        return { status: 200, body: { ok: problems.length === 0, problems, definition: migrated } };
      } catch (error) {
        return { status: 400, body: { error: (error as Error).message } };
      }
    },
    upgrade: body => {
      try {
        const name = typeof body.name === 'string' ? body.name : '';
        const definition = resolveTeamDefinition(name, workDir, session?.model ?? '');
        if (!definition) return { status: 404, body: { error: `team not found: ${name}` } };
        return { status: 200, body: { definition: migrateTeamDefinitionToGraph(definition) } };
      } catch (error) {
        return { status: 400, body: { error: (error as Error).message } };
      }
    },
    delete: async body => {
      try {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return { status: 400, body: { error: 'Missing team name' } };
        if (getBuiltInTeamDefinition(name)) {
          return { status: 400, body: { error: `cannot delete built-in team: ${name}` } };
        }
        const strategy = parseDeleteStrategy(body.strategy);
        const next = await withRuntimeMutation(async () => {
          if (strategy.type !== 'leave') {
            await applyDeleteFallback('team', name, strategy, await referenceOperationContext());
          }
          const removed = await deleteTeamDefinition(name, workDir, resolveGuiHomeDir());
          if (!removed) throw new Error(`team not found: ${name}`);
          if (activeTeamName === name) {
            activeTeamTool = null;
            activeTeamName = null;
            await persistSessionRuntimeMetadata();
          }
          return state();
        });
        invalidateHeavyState();
        return { status: 200, body: next };
      } catch (error) {
        return { status: runtimeMutationErrorStatus(error), body: runtimeMutationErrorBody(error) };
      }
    },
    preferences: async body => {
      try {
        const next = await withRuntimeMutation(async () => {
          const store = await resolveHadamardSettingsStore({
            configPath: options.configPath,
            homeDir: currentHomeInput(),
          });
          const raw = isPlainRecord(store.raw) ? structuredClone(store.raw) : {};
          const preferences = {
            autoInvoke: typeof body.autoInvoke === 'boolean' ? body.autoInvoke : teamPrefs.autoInvoke,
            defaultAttached: typeof body.defaultAttached === 'string'
              ? (body.defaultAttached.trim() || null)
              : teamPrefs.defaultAttached,
            confirmBeforeRun: typeof body.confirmBeforeRun === 'boolean'
              ? body.confirmBeforeRun
              : teamPrefs.confirmBeforeRun,
          };
          writeTeamPreferences(raw, preferences);
          await persistHadamardSettingsStore(store.configPath, raw);
          await loadJsonConfigFile(store.configPath);
          teamPrefs = preferences;
          return preferences;
        });
        return { status: 200, body: { ok: true, teamPreferences: next } };
      } catch (error) {
        return { status: runtimeMutationErrorStatus(error), body: runtimeMutationErrorBody(error) };
      }
    },
  });
  registerGuiAgentHttpController(httpRouter, {
    listProfiles: () => ({
      status: 200,
      body: { profiles: listAgentProfiles(resolveGuiHomeDir()) },
    }),
    saveProfile: async body => {
      try {
        const profile: AgentProfile = {
          name: typeof body.name === 'string' ? body.name.trim() : '',
          bridgeConfig: typeof body.bridgeConfig === 'string' ? body.bridgeConfig.trim() : '',
          model: typeof body.model === 'string' ? body.model.trim() : '',
        };
        if (body.agentMode === 'react' || body.agentMode === 'codeact' || body.agentMode === 'hybrid') {
          profile.agentMode = body.agentMode;
        } else if (body.agentMode !== undefined) {
          throw new Error("Agent profiles support only 'react', 'codeact', or 'hybrid'; Single is node-only.");
        }
        if (typeof body.description === 'string' && body.description.trim()) {
          profile.description = body.description.trim();
        }
        if (typeof body.systemPromptAppend === 'string' && body.systemPromptAppend.trim()) {
          profile.systemPromptAppend = body.systemPromptAppend.trim();
        }
        if (body.promptMode === 'extend' || body.promptMode === 'replace') {
          profile.promptMode = body.promptMode;
        }
        if (typeof body.subagent === 'boolean') profile.subagent = body.subagent;
        if (typeof body.permissionMode === 'string' && body.permissionMode.trim()) {
          profile.permissionMode = body.permissionMode.trim() as AgentProfile['permissionMode'];
        }
        if (typeof body.effort === 'string' && body.effort.trim()) {
          profile.effort = body.effort.trim() as AgentProfile['effort'];
        }
        if (body.maxTokens !== undefined && body.maxTokens !== null && body.maxTokens !== '') {
          const maxTokens = typeof body.maxTokens === 'number' ? body.maxTokens : Number(body.maxTokens);
          if (Number.isFinite(maxTokens) && maxTokens > 0) profile.maxTokens = Math.floor(maxTokens);
        }
        if (body.temperature !== undefined && body.temperature !== null && body.temperature !== '') {
          const temperature = typeof body.temperature === 'number' ? body.temperature : Number(body.temperature);
          if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
            profile.temperature = temperature;
          }
        }
        if (body.topP !== undefined && body.topP !== null && body.topP !== '') {
          const topP = typeof body.topP === 'number' ? body.topP : Number(body.topP);
          if (Number.isFinite(topP) && topP >= 0 && topP <= 1) profile.topP = topP;
        }
        if (Array.isArray(body.allowedTools)) {
          const tools = body.allowedTools.filter(
            (tool: unknown): tool is string => typeof tool === 'string' && tool.trim().length > 0,
          );
          if (tools.length) profile.allowedTools = tools;
        }
        if (body.workspaceAccess === 'workspace' || body.workspaceAccess === 'full') {
          profile.workspaceAccess = body.workspaceAccess;
        }
        if (body.maxIterations !== undefined && body.maxIterations !== null && body.maxIterations !== '') {
          const maxIterations = typeof body.maxIterations === 'number'
            ? body.maxIterations
            : Number(body.maxIterations);
          if (Number.isFinite(maxIterations) && maxIterations > 0) {
            profile.maxIterations = Math.floor(maxIterations);
          }
        }
        if (body.timeoutMs !== undefined && body.timeoutMs !== null && body.timeoutMs !== '') {
          const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : Number(body.timeoutMs);
          if (Number.isFinite(timeoutMs) && timeoutMs > 0) profile.timeoutMs = Math.floor(timeoutMs);
        }
        const existingDefinition = readAgentDefinitionMarkdown(profile.name, resolveGuiHomeDir(), workDir);
        const scope = body.scope === 'project'
          ? 'project'
          : existingDefinition?.source === 'project' ? 'project' : 'personal';
        const extras: AgentDefinitionExtraFields = {};
        extras.agentMode = profile.agentMode;
        if (body.promptMode === 'extend' || body.promptMode === 'replace') extras.promptMode = body.promptMode;
        if (typeof body.subagent === 'boolean') extras.subagent = body.subagent;
        extras.permissionMode = profile.permissionMode;
        extras.effort = profile.effort;
        extras.maxTokens = profile.maxTokens;
        extras.temperature = profile.temperature;
        extras.topP = profile.topP;
        extras.tools = profile.allowedTools;
        extras.workspaceAccess = profile.workspaceAccess;
        extras.maxIterations = profile.maxIterations;
        extras.timeoutMs = profile.timeoutMs;
        if (profile.bridgeConfig) {
          const bridgeCfg = findBridgeConfig(profile.bridgeConfig, resolveGuiHomeDir());
          const runtime = bridgeCfg?.runtime?.trim();
          if (runtime && runtime !== 'hadamard' && (bridgeCfg?.execution ?? 'api') === 'cli') {
            extras.runtime = runtime;
          }
        }
        const inheritModel = !profile.bridgeConfig || !profile.model;
        const unifiedWrite = inheritModel || scope === 'project' || Object.keys(extras).length > 0;
        const result = await withRuntimeMutation(async () => {
          if (!unifiedWrite) {
            const saved = upsertAgentProfile(profile, resolveGuiHomeDir());
            return { ok: true, profile: saved.profile, warnings: saved.warnings, state: await state() };
          }
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile.name)) {
            throw new Error('Invalid profile name (use letters, digits, . _ -)');
          }
          const directory = scope === 'project'
            ? path.join(workDir, '.hadamard', 'agents')
            : undefined;
          let warnings: string[] = [];
          if (inheritModel) {
            writeAgentDefinitionMarkdown({
              name: profile.name,
              description: profile.description,
              body: profile.systemPromptAppend,
              extras,
              directory,
              homeDir: resolveGuiHomeDir(),
            });
          } else {
            const validation = validateAgentProfile(profile, resolveGuiHomeDir());
            warnings = validation.warnings;
            writeAgentProfileMarkdown(validation.profile, resolveGuiHomeDir(), { directory, extras });
          }
          let conversion: string[] = [];
          if (typeof body.convertFromSquad === 'string' && body.convertFromSquad.trim()) {
            const report = await convertAgentSquadToAgentDefinition(
              body.convertFromSquad.trim(),
              profile.name,
              await referenceOperationContext(),
            );
            conversion = report.rewritten;
          }
          return {
            ok: true,
            profile: inheritModel ? null : profile,
            warnings,
            conversion,
            state: await state(),
          };
        });
        return { status: 200, body: result };
      } catch (error) {
        return { status: runtimeMutationErrorStatus(error), body: runtimeMutationErrorBody(error) };
      }
    },
    deleteProfile: async body => {
      try {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return { status: 400, body: { error: 'Missing profile name' } };
        const strategy = parseDeleteStrategy(body.strategy);
        const next = await withRuntimeMutation(async () => {
          if (strategy.type !== 'leave') {
            await applyDeleteFallback('agent', name, strategy, await referenceOperationContext());
          }
          deleteAgentProfile(name, resolveGuiHomeDir());
          if (body.scope === 'project') {
            deleteAgentProfileMarkdown(name, resolveGuiHomeDir(), path.join(workDir, '.hadamard', 'agents'));
          }
          if (activeAgentSelectionName === name) {
            activeAgentSelectionName = null;
            disableBridge();
            await persistSessionRuntimeMetadata();
          }
          return state();
        });
        return { status: 200, body: next };
      } catch (error) {
        return { status: runtimeMutationErrorStatus(error), body: runtimeMutationErrorBody(error) };
      }
    },
    definition: name => {
      if (!name) return { status: 400, body: { error: 'Missing name' } };
      const definition = readAgentDefinitionMarkdown(name, resolveGuiHomeDir(), workDir);
      if (!definition) return { status: 404, body: { error: `Agent definition not found: ${name}` } };
      return { status: 200, body: { definition } };
    },
    templates: () => ({ status: 200, body: { templates: getHadamardAgentTemplates() } }),
    instantiateTemplate: async body => {
      try {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const template = name ? getHadamardAgentTemplate(name) : undefined;
        if (!template) return { status: 404, body: { error: `Unknown agent template: ${name}` } };
        const scope = body.scope === 'project' ? 'project' : 'personal';
        const directory = scope === 'project'
          ? path.join(workDir, '.hadamard', 'agents')
          : undefined;
        const result = await withRuntimeMutation(async () => {
          if (readAgentDefinitionMarkdown(template.name, resolveGuiHomeDir(), workDir)) {
            throw new Error(`An agent named "${template.name}" already exists.`);
          }
          const filePath = writeAgentDefinitionMarkdown({
            name: template.name,
            description: template.description,
            body: template.body,
            extras: {
              permissionMode: template.frontmatter.permissionMode as AgentDefinitionExtraFields['permissionMode'],
              tools: Array.isArray(template.frontmatter.tools)
                ? template.frontmatter.tools.map(String)
                : undefined,
            },
            directory,
            homeDir: resolveGuiHomeDir(),
          });
          return { filePath };
        });
        invalidateHeavyState();
        return { status: 200, body: { ok: true, ...result, state: await state() } };
      } catch (error) {
        return { status: runtimeMutationErrorStatus(error), body: runtimeMutationErrorBody(error) };
      }
    },
    activate: async body => {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const configName = typeof body.bridgeConfig === 'string' ? body.bridgeConfig.trim() : '';
      const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
      if (!name && !configName) {
        return { status: 400, body: { error: 'Missing agent name or config name' } };
      }
      try {
        await withRuntimeMutation(async () => {
          let config: PersistedBridgeConfig;
          let defaultEffort: string | undefined;
          let nextAgentSelectionName: string | null = null;
          if (name) {
            const resolved = await resolveSelectableAgentRun(name, resolveGuiHomeDir());
            config = { ...resolved.bridgeConfig, model: resolved.selectable.model };
            nextAgentSelectionName = resolved.selectable.name;
            defaultEffort = resolved.profile.effort || resolved.selectable.effort;
          } else {
            const stored = findBridgeConfig(configName, resolveGuiHomeDir());
            if (!stored) throw new Error(`Bridge config not found: ${configName}`);
            config = { ...stored, ...(requestedModel ? { model: requestedModel } : {}) };
          }
          await activateBridgeConfig(config);
          activeAgentSelectionName = nextAgentSelectionName;
          activeRouter = null;
          routedModelLabel = null;
          await persistSessionRuntimeMetadata();
          const entry = resolveModelContextEntry(
            config.model || session.model,
            readBridgeConfigs(resolveGuiHomeDir()).configs,
            config,
          );
          const requestedContextWindow = parseContextWindowTokens(body.contextWindowTokens);
          const limit = modelContextWindowLimit(entry);
          if (requestedContextWindow) {
            if (limit && requestedContextWindow > limit) {
              throw new Error(
                `Context window exceeds the model limit of ${formatContextWindowTokens(limit)}.`,
              );
            }
            await session.mergeMetadata({
              [HADAMARD_CONTEXT_WINDOW_METADATA_KEY]: requestedContextWindow,
            });
          } else if (limit && currentContextWindow() && currentContextWindow()! > limit) {
            await session.mergeMetadata({
              [HADAMARD_CONTEXT_WINDOW_METADATA_KEY]: entry?.contextWindowTokens ?? limit,
            });
          }
          const requestedEffort = typeof body.effort === 'string' ? body.effort.trim() : '';
          const effort = requestedEffort || defaultEffort;
          if (effort === 'auto' || isEffort(effort)) {
            await session.mergeMetadata({ __hadamardEffort: effort });
          }
        });
      } catch (error) {
        return { status: runtimeMutationErrorStatus(error), body: runtimeMutationErrorBody(error) };
      }
      invalidateHeavyState();
      return { status: 200, body: await state() };
    },
  });
  registerGuiReferenceHttpController(httpRouter, createGuiReferenceHttpService({
    snapshot: buildGuiReferenceIndex,
    rename: async (kind, oldName, newName) => {
      const report = await withRuntimeMutation(async () => {
        const result = await renameDefinitionAndReferences(
          kind,
          oldName,
          newName,
          await referenceOperationContext(),
        );
        if (kind === 'config' && activeBridgeConfig?.name === oldName) {
          const renamed = findBridgeConfig(newName, resolveGuiHomeDir());
          if (renamed) await activateBridgeConfig(renamed);
        }
        if (kind === 'agent' && activeAgentSelectionName === oldName) {
          activeAgentSelectionName = newName;
        }
        if (kind === 'router' && activeRouter?.name === oldName) {
          activeRouter = loadRouterProfile(newName, workDir, resolveGuiHomeDir())?.profile ?? null;
          routedModelLabel = null;
        }
        if (kind === 'team' && activeTeamName === oldName) {
          try { attachTeamByName(newName); } catch { /* keep stale attach state */ }
        }
        await persistSessionRuntimeMetadata();
        return result;
      });
      invalidateHeavyState();
      return { rewritten: report.rewritten, state: await state() };
    },
    repointModel: async (config, fromModel, toModel) => {
      const report = await withRuntimeMutation(async () =>
        repointConfigModel(config, fromModel, toModel, await referenceOperationContext()));
      invalidateHeavyState();
      return { rewritten: report.rewritten, state: await state() };
    },
    mutationError: error => ({
      status: runtimeMutationErrorStatus(error),
      body: runtimeMutationErrorBody(error),
    }),
  }));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${urlHost}:${port}`);
      if (!hostHeaderAllowed(req) || !originAllowed(req)) {
        return text(res, 403, 'Forbidden: invalid host or origin');
      }
      // Webhook triggers come from external services (no hadamard token); they
      // carry their own per-task secret verified inside the route handler.
      const isWebhook = req.method === 'POST' && url.pathname.startsWith('/api/automation/webhook/');
      if (!isWebhook && url.pathname.startsWith('/api/') && req.headers['x-hadamard-token'] !== authToken) {
        return json(res, 403, { error: 'Forbidden: missing or invalid token' });
      }
      if (await httpRouter.handle(req, res, url)) return;
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, await state());
      }
      if (req.method === 'GET' && url.pathname === '/api/app-update') {
        return json(res, 200, appUpdater.snapshot());
      }
      if (req.method === 'POST' && url.pathname === '/api/app-update/check') {
        try {
          return json(res, 200, await appUpdater.check());
        } catch (error) {
          return json(res, 400, {
            ...appUpdater.snapshot(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/app-update/upgrade') {
        try {
          const update = await withRuntimeMutation(() => appUpdater.download());
          json(res, 200, update);
          setTimeout(() => {
            void appUpdater.install().catch(error => {
              console.error(`[hadamard-gui] update install failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          }, 500);
          return;
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), {
            ...runtimeMutationErrorBody(error),
            update: appUpdater.snapshot(),
          });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        return json(res, 200, liveRunState());
      }
      if (req.method === 'GET' && url.pathname === '/api/rail-live') {
        const railStore = await readContextRailStore(workDir, resolveGuiHomeDir());
        return json(res, 200, {
          railItems: sortContextRailItems(railStore.items),
          railNotifications: railReminderScheduler.drainNotifications(),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/customize/plugins') {
        return json(res, 200, await managedPluginCatalogSnapshot());
      }
      if (req.method === 'POST' && url.pathname === '/api/customize/plugins/test') {
        try {
          const body = await readJson(req);
          return json(res, 200, await withRuntimeMutation(() => testManagedPlugin(body)));
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/customize/plugins') {
        try {
          const body = await readJson(req);
          return json(res, 200, await withRuntimeMutation(() => updateManagedPlugin(body)));
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/customize/skills') {
        return json(res, 200, await externalSkillCatalogSnapshot());
      }
      if (req.method === 'POST' && url.pathname === '/api/customize/skills') {
        try {
          const body = await readJson(req);
          return json(res, 200, await withRuntimeMutation(() => updateExternalSkillPreferences(body)));
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/session/active') {
        // Keep this reconciliation endpoint deliberately lightweight. The
        // resume request may already have switched the server session even if
        // its full state response was interrupted or failed to assemble.
        await serverSessionResumeQueue;
        return json(res, 200, { session: sessionView(session) });
      }
      if (req.method === 'GET' && url.pathname === '/api/agent-executions') {
        const targetPath = await agentExecutionTargetPath(url.searchParams.get('path'));
        if (!targetPath) {
          return json(res, 400, { error: 'path must identify an existing project directory' });
        }
        const projectDirectory = await ensureProjectDataMigrated(targetPath);
        const executionStore = new AgentExecutionStore(projectDirectory);
        const sessionStore = new SessionStore(projectDirectory);
        const bridgeConfigs = readBridgeConfigs(resolveGuiHomeDir()).configs;
        const externalSnapshots = createExternalCliAgentExecutionSnapshots(
          externalCliRuntimeManager.list().map(run => {
            const configName = externalCliRunConfigNames.get(run.runId) ?? 'External CLI';
            const config = bridgeConfigs.find(item => item.name === configName);
            return {
              run,
              configName,
              runtime: config?.runtime ?? 'external-cli',
              model: config?.model ?? null,
            };
          }),
          targetPath,
        );
        const [storedSnapshots, storedSessions] = await Promise.all([
          executionStore.listSnapshots(),
          sessionStore.list(),
        ]);
        const executionView = createAgentExecutionProjectView([
          ...storedSnapshots,
          ...externalSnapshots,
        ]);
        const executionNodesBySession = new Map<string, {
          lifecycle: string;
          currentActivity: { kind?: string; summary?: string; toolName?: string } | null;
          displayName: string;
          updatedAt: string;
        }>();
        const executionLifecyclePriority = (lifecycle: string): number =>
          lifecycle === 'running' ? 2 : lifecycle === 'waiting' ? 1 : 0;
        const visitExecutionNode = (
          node: (typeof executionView.active)[number]['root'],
          rootUpdatedAt: string,
        ): void => {
          if (!node) return;
          const candidate = {
            lifecycle: node.lifecycle,
            currentActivity: node.currentActivity,
            displayName: node.displayName,
            updatedAt: node.timing.updatedAt || rootUpdatedAt,
          };
          const existing = executionNodesBySession.get(node.sessionId);
          const candidatePriority = executionLifecyclePriority(candidate.lifecycle);
          const existingPriority = existing ? executionLifecyclePriority(existing.lifecycle) : -1;
          if (
            !existing
              || candidatePriority > existingPriority
              || (candidatePriority === existingPriority && candidate.updatedAt > existing.updatedAt)
          ) {
            executionNodesBySession.set(node.sessionId, candidate);
          }
          for (const child of node.children) visitExecutionNode(child, rootUpdatedAt);
        };
        for (const root of [
          ...executionView.active,
          ...executionView.waiting,
          ...executionView.completed,
        ]) {
          visitExecutionNode(root.root, root.updatedAt);
          for (const node of root.detached) visitExecutionNode(node, root.updatedAt);
        }
        const activeRunsBySession = new Map(
          [...runs.values()]
            .filter(run => run.desc.status === 'running')
            .map(run => [run.desc.sessionId, run.desc] as const),
        );
        const targetIsOpen = normalizeFsPath(targetPath) === normalizeFsPath(workDir);
        const conversations = storedSessions
          .map(item => {
            const execution = executionNodesBySession.get(item.id);
            const activeRun = targetIsOpen ? activeRunsBySession.get(item.id) : undefined;
            const isWaiting = Boolean(
              execution?.lifecycle !== 'completed'
                && (
                  execution?.currentActivity?.kind === 'waiting'
                    || (!activeRun && execution?.lifecycle === 'waiting')
                ),
            );
            const isRunning = !isWaiting && Boolean(activeRun || execution?.lifecycle === 'running');
            const isLive = isRunning || isWaiting;
            return {
              ...item,
              isRunning,
              isWaiting,
              isLive,
              isCurrent: targetIsOpen && item.id === session.id,
              lifecycle: isWaiting ? 'waiting' : isRunning ? 'running' : (execution?.lifecycle ?? 'idle'),
              currentActivity: activeRun?.currentTool
                ? { kind: 'tool', summary: activeRun.currentTool, toolName: activeRun.currentTool }
                : execution?.currentActivity ?? null,
              displayName: item.kind === 'manager'
                ? 'Project Manager'
                : item.agentName || execution?.displayName || item.title,
            };
          })
          .sort((left, right) => {
            if (left.isLive !== right.isLive) return left.isLive ? -1 : 1;
            if (left.isRunning !== right.isRunning) return left.isRunning ? -1 : 1;
            const leftAt = left.lastActiveAt || left.lastRunAt || left.updatedAt;
            const rightAt = right.lastActiveAt || right.lastRunAt || right.updatedAt;
            return rightAt.localeCompare(leftAt);
          });
        return json(
          res,
          200,
          {
            ...executionView,
            conversations,
            runningConversationCount: conversations.filter(item => item.isRunning).length,
            waitingConversationCount: conversations.filter(item => item.isWaiting).length,
          },
        );
      }
      if (req.method === 'GET' && url.pathname === '/api/agent-execution') {
        const targetPath = await agentExecutionTargetPath(url.searchParams.get('path'));
        const rootExecutionId = url.searchParams.get('rootExecutionId')?.trim() ?? '';
        if (!targetPath) {
          return json(res, 400, { error: 'path must identify an existing project directory' });
        }
        try {
          assertSafeStorageSegment('rootExecutionId', rootExecutionId);
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
        const executionStore = new AgentExecutionStore(
          await ensureProjectDataMigrated(targetPath),
        );
        const snapshot = await executionStore.getSnapshot(rootExecutionId);
        if (!snapshot) {
          return json(res, 404, { error: `Agent execution not found: ${rootExecutionId}` });
        }
        return json(res, 200, createAgentExecutionRootView(snapshot));
      }
  // P3: generic Assistant confirmation cards (delete-with-references,
  // workflow upsert) staged by the global Assistant tools. Apply executes the
  // P1 transaction semantics (applyDeleteFallback + definition delete).
  const assistantProposalMatch = url.pathname.match(/^\/api\/assistant\/proposals\/([^/]+)(?:\/(apply|reject))?$/);
  if (assistantProposalMatch) {
    const proposalId = decodeURIComponent(assistantProposalMatch[1]!);
    const action = assistantProposalMatch[2];
    try {
      const proposal = assistantProposals.get(proposalId);
      if (!proposal) return json(res, 404, { error: `Unknown Assistant proposal: ${proposalId}` });
      if (req.method === 'GET' && !action) {
        return json(res, 200, { proposal });
      }
      if (req.method === 'POST' && action === 'reject') {
        return json(res, 200, { ok: true, proposal: assistantProposals.reject(proposalId) });
      }
      if (req.method === 'POST' && action === 'apply') {
        const body = await readJson(req);
        const strategy = parseDeleteStrategy(body.strategy);
        const applied = await withRuntimeMutation(async () => {
          const result = await assistantProposals.apply(proposalId, {
            homeDir: resolveGuiHomeDir(),
            projectDir: workDir,
            referenceContext: await referenceOperationContext(),
          }, { strategy });
          const del = result.proposal.delete;
          if (del) {
            // Active-state reconciliation mirrors the direct delete endpoints.
            if (del.kind === 'config' && activeBridgeConfig?.name === del.name) {
              disableBridge();
            }
            if (del.kind === 'agent' && activeAgentSelectionName === del.name) {
              activeAgentSelectionName = null;
              disableBridge();
            }
            if (del.kind === 'router' && activeRouter?.name === del.name) {
              activeRouter = null;
              routedModelLabel = null;
            }
            if (del.kind === 'team' && activeTeamName === del.name) {
              activeTeamTool = null;
              activeTeamName = null;
            }
            await persistSessionRuntimeMetadata();
          }
          return result;
        });
        invalidateHeavyState();
        return json(res, 200, {
          ok: true,
          proposal: applied.proposal,
          rewritten: applied.rewritten,
          filePath: applied.filePath,
          state: await state(),
        });
      }
      return json(res, 405, { error: 'Method not allowed' });
    } catch (error) {
      return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/manager/state') {
    const homeDir = managerHomeDir();
    const scope = isAssistantScope(url.searchParams.get('scope'))
      ? url.searchParams.get('scope') as 'global' | 'project'
      : 'project';
    const running = [...runs.values()].some(run => run.desc.kind === 'manager' && run.desc.status === 'running');
    let transcript: Array<{ kind: string; text: string }> = [];
    let activeAssistantSessionId: string | undefined;
    try {
      if (!needsCredentials && sdk) {
        const selected = scope === 'global' ? await getAssistantGlobalSession() : await getManagerSession();
        activeAssistantSessionId = selected.id;
        transcript = managerPanelTranscript(selected);
      }
    } catch { /* panel hydration is best-effort */ }
    const catalog = await createSessionCenterCatalog();
    const assistantSessions = await catalog.query({
      types: [scope === 'global' ? 'assistant-global' : 'assistant-project'],
      archived: false,
      ...(scope === 'project' ? { projectPaths: [projectPrimaryPath] } : {}),
      pageSize: 200,
    });
    const proposals = activeAssistantSessionId
      ? teamProposals.listForSession(activeAssistantSessionId)
      : [];
    const assistantProposalCards = activeAssistantSessionId
      ? assistantProposals.listForSession(activeAssistantSessionId)
      : [];
    if (scope === 'global') {
      const cfg = await readAssistantConfig(homeDir);
      return json(res, 200, {
        scope: 'global',
        canUseProjectScope: true,
        currentProjectPath: workDir,
        config: cfg,
        plan: { milestones: 0, today: 0, upcoming: 0 },
        designChars: 0,
        designPreview: null,
        updatePreview: null,
        designPath: null,
        designUpdatedAt: null,
        running,
        transcript,
        assistantSessions: assistantSessions.items,
        activeSessionId: activeAssistantSessionId ?? cfg.activeSessionId ?? null,
        proposals,
        assistantProposals: assistantProposalCards,
        schedules: [],
      });
    }
    const cfg = await readManagerConfig(projectPrimaryPath, homeDir);
    const plan = await readProjectPlanFile(projectPrimaryPath, homeDir);
    const design = await readDesignFile(projectPrimaryPath, homeDir);
    const designPath = managerDesignPath(projectPrimaryPath, homeDir);
    let designUpdatedAt: string | null = null;
    try { designUpdatedAt = (await stat(designPath)).mtime.toISOString(); } catch { /* none yet */ }
    return json(res, 200, {
      scope: 'project',
      canUseProjectScope: true,
      currentProjectPath: projectPrimaryPath,
      activeWorkPath: workDir,
      config: cfg,
      plan: { milestones: plan.milestones.length, today: plan.today.length, upcoming: plan.upcoming.length },
      designChars: design?.length ?? 0,
      designPreview: design ? design.slice(0, 2000) : null,
      updatePreview: formatManagerUpdatePreview(plan, design),
      designPath,
      designUpdatedAt,
      running,
      transcript,
      assistantSessions: assistantSessions.items,
      activeSessionId: activeAssistantSessionId ?? cfg.activeSessionId ?? null,
      proposals,
      assistantProposals: assistantProposalCards,
      schedules: (await listScheduledAutomationTasks(workDir))
        .filter(task => task.kind === 'manager')
        .map(task => ({ name: task.name, cron: task.cron, enabled: task.enabled })),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/manager/config') {
    // Assistant settings: Project → manager.json; Global → <data-root>/assistant.json
    try {
      const body = await readJson(req);
      const scope = isAssistantScope(body.scope) ? body.scope : 'project';
      const next = await withRuntimeMutation(async () => {
        const homeDir = managerHomeDir();
        if (scope === 'global') {
          const current = await readAssistantConfig(homeDir);
          const config = {
            ...current,
            model: typeof body.model === 'string' ? (body.model.trim() || undefined) : current.model,
            bridgeConfig: typeof body.bridgeConfig === 'string'
              ? (body.bridgeConfig.trim() || undefined)
              : current.bridgeConfig,
          };
          await writeAssistantConfig(config, homeDir);
          return config;
        }
        const current = await readManagerConfig(projectPrimaryPath, homeDir);
        const config: ManagerConfig = {
          ...current,
          model: typeof body.model === 'string' ? (body.model.trim() || undefined) : current.model,
          bridgeConfig: typeof body.bridgeConfig === 'string'
            ? (body.bridgeConfig.trim() || undefined)
            : current.bridgeConfig,
          readScope: isManagerReadScope(body.readScope) ? body.readScope : current.readScope,
          allowedReadPaths: Array.isArray(body.allowedReadPaths)
            ? body.allowedReadPaths.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
            : current.allowedReadPaths,
        };
        await writeManagerConfig(projectPrimaryPath, homeDir, config);
        return config;
      });
      return json(res, 200, { ok: true, scope, config: next });
    } catch (error) {
      return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
    }
  }
  if (req.method === 'POST' && (url.pathname === '/api/manager/chat' || url.pathname === '/api/manager/update')) {
    if (runtimeMutationInProgress) {
      return json(res, 409, { error: 'Runtime configuration is being updated. Try again in a moment.' });
    }
    const body = await readJson(req);
    const scope = isAssistantScope(body.scope) ? body.scope : 'project';
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: GuiRunEvent) => { res.write(JSON.stringify(event) + '\n'); };
    try {
      const isUpdate = url.pathname === '/api/manager/update';
      const text = await runManagerTurn(isUpdate
        ? {
          mode: 'update',
          scope,
          instruction: typeof body.instruction === 'string' ? body.instruction : undefined,
          send,
        }
        : {
          mode: 'chat',
          scope,
          text: typeof body.text === 'string' ? body.text : '',
          editorContext: isPlainRecord(body.editorContext)
            ? body.editorContext as unknown as AssistantEditorContext
            : undefined,
          send,
        });
      send({ type: 'manager.result', text, updated: isUpdate, scope });
      send({ type: 'done' });
    } catch (error) {
      send({ type: 'error', message: (error as Error).message });
    } finally {
      res.end();
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/rail-items') {
    const hd = resolveGuiHomeDir();
    const store = await readContextRailStore(workDir, hd);
    return json(res, 200, { items: sortContextRailItems(store.items) });
  }
  if (req.method === 'POST' && url.pathname === '/api/rail-items') {
    try {
      const body = await readJson(req);
      const next = normalizeContextRailStore({ items: body.items });
      const hd = resolveGuiHomeDir();
      const saved = await writeContextRailStore(workDir, hd, next);
      await syncRailReminders(workDir, hd);
      return json(res, 200, { ok: true, items: sortContextRailItems(saved.items) });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/project-note') {
    try {
      const body = await readJson(req);
      const targetPath = typeof body.path === 'string' ? body.path.trim() : workDir;
      const content = typeof body.content === 'string' ? body.content : '';
      const hd = resolveGuiHomeDir();
      const savedPath = await writeWorkspaceNote(path.resolve(targetPath), hd, content);
      invalidateHeavyState();
      return json(res, 200, { ok: true, path: savedPath, content });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/project-status') {
    const hd = resolveGuiHomeDir();
    const targetPath = typeof url.searchParams.get('path') === 'string' && url.searchParams.get('path')!.trim()
      ? path.resolve(url.searchParams.get('path')!.trim())
      : workDir;
    const meta = await readProjectMeta(targetPath, hd);
    return json(res, 200, {
      ok: true,
      path: targetPath,
      status: meta.status,
      label: PROJECT_STATUS_LABELS[meta.status],
      updatedAt: meta.updatedAt ?? null,
      statuses: PROJECT_STATUSES.map((value) => ({ value, label: PROJECT_STATUS_LABELS[value] })),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/project-status') {
    try {
      const body = await readJson(req);
      const targetPath = typeof body.path === 'string' && body.path.trim()
        ? path.resolve(body.path.trim())
        : workDir;
      if (!isProjectStatus(body.status)) {
        return json(res, 400, { error: 'Invalid status' });
      }
      const hd = resolveGuiHomeDir();
      const meta = await writeProjectMeta(targetPath, hd, { status: body.status });
      invalidateHeavyState();
      return json(res, 200, {
        ok: true,
        path: targetPath,
        status: meta.status,
        label: PROJECT_STATUS_LABELS[meta.status],
        updatedAt: meta.updatedAt ?? null,
      });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/project-settings') {
    const hd = resolveGuiHomeDir();
    const settings = await readProjectSettings(workDir, hd);
    const configs = readBridgeConfigs(hd).configs;
    const profiles = listAgentProfiles(hd);
    const dreamProfiles: Array<{
      kind: 'config' | 'agent';
      name: string;
      model?: string;
      label: string;
      value: string;
      available: boolean;
    }> = [];
    for (const config of configs) {
      const modelNames: string[] = [];
      const addModel = (value: unknown) => {
        const model = typeof value === 'string' ? value.trim() : '';
        if (model && !modelNames.includes(model)) modelNames.push(model);
      };
      addModel(config.model);
      for (const entry of config.models ?? []) addModel(entry?.name);
      const available = config.execution !== 'cli' && modelNames.length > 0;
      if (modelNames.length === 0) {
        dreamProfiles.push({
          kind: 'config',
          name: config.name,
          label: `Config · ${config.name}`,
          value: encodeDreamProfileValue({ kind: 'config', name: config.name }),
          available: false,
        });
        continue;
      }
      for (const model of modelNames) {
        dreamProfiles.push({
          kind: 'config',
          name: config.name,
          model,
          label: `Config · ${config.name} · ${model}`,
          value: encodeDreamProfileValue({ kind: 'config', name: config.name, model }),
          available,
        });
      }
    }
    for (const profile of profiles) {
      const config = configs.find(candidate => candidate.name === profile.bridgeConfig);
      dreamProfiles.push({
        kind: 'agent',
        name: profile.name,
        model: profile.model,
        label: `Agent · ${profile.name} · ${profile.model}`,
        value: encodeDreamProfileValue({ kind: 'agent', name: profile.name }),
        available: Boolean(config) && config?.execution !== 'cli',
      });
    }
    const memoryContent = sdk
      ? await sdk.memory.listMemoryContent().catch(() => [])
      : [];
    const dreamState = sdk
      ? await sdk.dream.state({ currentSessionId: session.id }).catch(() => undefined)
      : undefined;
    const compactBudget = sdk
      ? (await import('../runtime/hadamardCompact.js')).resolveHadamardCompactBudget({
          ...sdk.config.compact,
          ...(currentContextWindow() ? { contextWindowTokens: currentContextWindow() } : {}),
        })
      : undefined;
    const dailyDreamTime = settings.memory.durableMemory.dailyDreamTimeLocal || '03:00';
    const autoDream = settings.memory.durableMemory.autoDream === true;
    const dreamStatusText = dreamState
      ? [
          'Last dream: ' + (dreamState.lastConsolidatedAt || 'never'),
          'Next: ' + (autoDream
            ? ('daily at ' + dailyDreamTime + ' (GUI must be open)')
            : 'auto-dream off'),
          'Blocked: ' + (dreamState.blockedReason
            ? ({
              disabled: 'disabled',
              time_gate: 'waiting for schedule',
              session_gate: 'active session',
              locked: 'locked',
              scan_throttled: 'scan throttled',
              missing_execution_profile: 'no profile selected',
            } as Record<string, string>)[dreamState.blockedReason] ?? dreamState.blockedReason
            : (autoDream ? 'ready' : 'disabled')),
        ].join(' · ')
      : 'Dream status is unavailable until the Hadamard SDK is configured.';
    return json(res, 200, {
      ok: true,
      path: workDir,
      settings,
      dreamProfiles,
      memoryContent,
      dreamState,
      dreamStatusText,
      compactBudget,
      compactWarning: sdk?.config.compact.contextWindowWarning,
    });
  }
  if (req.method === 'PUT' && url.pathname === '/api/project-settings') {
    try {
      const body = await readJson(req);
      const hd = resolveGuiHomeDir();
      const memory = body.memory && typeof body.memory === 'object'
        ? body.memory as ProjectMemorySettingsPatch
        : undefined;
      const saved = await writeProjectSettings(workDir, hd, {
        workMode: body.workMode === 'coding' || body.workMode === 'daily' ? body.workMode : undefined,
        customPrompt: typeof body.customPrompt === 'string' ? body.customPrompt : undefined,
        projectRules: typeof body.projectRules === 'string' ? body.projectRules : undefined,
        agentMode: body.agentMode === 'react' || body.agentMode === 'codeact' || body.agentMode === 'hybrid'
          ? body.agentMode
          : undefined,
        codeAct: body.codeAct && typeof body.codeAct === 'object'
          ? body.codeAct as ProjectSettings['codeAct']
          : undefined,
        context: body.context && typeof body.context === 'object'
          ? { instructionMode: (body.context as Record<string, unknown>).instructionMode as ProjectSettings['context']['instructionMode'] }
          : undefined,
        memory,
      });
      projectSettings = saved;
      systemPrompt = buildGuiSystemPrompt(workDir, projectSettings, resolveGuiHomeDir(), projectRegisteredWorkPaths);
      invalidateHeavyState();
      return json(res, 200, { ok: true, path: workDir, settings: saved });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (await deviceLinkController.handle(req, res, url)) return;
  if (req.method === 'PUT' && url.pathname === '/api/session-agent-mode') {
    if (!session) return json(res, 503, { error: 'Hadamard SDK is not configured.' });
    try {
      const body = await readJson(req);
      if (!isAgentMode(body.agentMode)) {
        return json(res, 400, { error: 'agentMode must be react, codeact, or hybrid.' });
      }
      await session.mergeMetadata(sessionAgentModePatch(body.agentMode));
      invalidateHeavyState();
      return json(res, 200, { ok: true, agentMode: body.agentMode });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/project-goal') {
    if (!sdk) return json(res, 503, { error: 'Hadamard SDK is not configured.' });
    try {
      const body = await readJson(req);
      const command = typeof body.command === 'string' ? body.command : 'status';
      const result = await sdk.goals.command(session, command);
      invalidateHeavyState();
      return json(res, result.ok ? 200 : 400, { ok: result.ok, result });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/session-goal') {
    if (!sdk) return json(res, 503, { error: 'Hadamard SDK is not configured.' });
    try {
      const body = await readJson(req);
      const action = typeof body.action === 'string' ? body.action : 'status';
      const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
      if (action === 'run') {
        if (!getGoal()) return json(res, 400, { error: 'There is no goal to run.' });
        const started = startSessionGoalLoop(session.id);
        invalidateHeavyState();
        return json(res, 200, {
          ok: true,
          message: started ? 'goal loop started' : 'goal loop is already running',
          state: await state(),
        });
      }
      let command: string;
      if (action === 'set') {
        if (!objective) return json(res, 400, { error: 'A goal needs an objective.' });
        // A bare objective creates the session goal, or updates it in place mid-run.
        command = objective;
      } else if (action === 'answer') {
        const gateId = typeof body.gateId === 'string' ? body.gateId.trim() : '';
        const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
        if (!gateId || !answer) return json(res, 400, { error: 'An answer needs a gate and a reply.' });
        command = `answer ${gateId} ${answer}`;
      } else if (['pause', 'resume', 'clear', 'status'].includes(action)) {
        command = action;
      } else {
        return json(res, 400, { error: `Unsupported Goal action: ${action}` });
      }
      if (action === 'pause' || action === 'clear') stopSessionGoalLoop(session.id);
      const result = await sdk.goals.command(session, command);
      const messages = [result.message];
      // Answering a gate or resuming hands the loop straight back to the agent.
      if (result.ok && (action === 'answer' || action === 'resume')) {
        const goal = getGoal();
        const next = describeGoalNext(goal);
        if (goal?.status === 'active' && next && next.kind !== 'stop' && startSessionGoalLoop(session.id)) {
          messages.push('goal loop resumed');
        }
      }
      invalidateHeavyState();
      return json(res, result.ok ? 200 : 400, {
        ok: result.ok,
        message: messages.filter(Boolean).join(' · '),
        state: await state(),
      });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/project-memory-content') {
    if (!sdk) return json(res, 503, { error: 'Hadamard SDK is not configured.' });
    try {
      const id = url.searchParams.get('id');
      const query = url.searchParams.get('query');
      if (query) {
        return json(res, 200, { ok: true, results: await sdk.memory.searchMemoryContent(query) });
      }
      if (!id) return json(res, 400, { error: 'Missing memory id.' });
      return json(res, 200, { ok: true, ...(await sdk.memory.readMemoryContent(id)) });
    } catch (error) {
      return json(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/project-dream/run') {
    if (!sdk) return json(res, 503, { error: 'Hadamard SDK is not configured.' });
    try {
      return json(res, 200, { ok: true, result: await session.dream({ force: true }) });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/prompt-templates') {
    const hd = resolveGuiHomeDir();
    const templates = await listPromptTemplates(hd);
    return json(res, 200, { ok: true, templates });
  }
  if (req.method === 'POST' && url.pathname === '/api/prompt-templates') {
    try {
      const body = await readJson(req);
      const hd = resolveGuiHomeDir();
      const template = await createPromptTemplate(hd, {
        name: typeof body.name === 'string' ? body.name : '',
        body: typeof body.body === 'string' ? body.body : '',
      });
      return json(res, 200, { ok: true, template });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/prompt-templates/')) {
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/prompt-templates/'.length));
      const hd = resolveGuiHomeDir();
      const removed = await deletePromptTemplate(hd, id);
      if (!removed) return json(res, 404, { error: 'Template not found' });
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/plan') {
    const hd = resolveGuiHomeDir();
    return json(res, 200, await readProjectPlan(projectPrimaryPath, hd));
  }
  if (req.method === 'POST' && url.pathname === '/api/plan') {
    try {
      const body = await readJson(req);
      const next: ProjectPlan = {
        milestones: Array.isArray(body.milestones) ? body.milestones : [],
        today: Array.isArray(body.today) ? body.today : [],
        upcoming: Array.isArray(body.upcoming) ? body.upcoming : [],
      };
      const hd = resolveGuiHomeDir();
      await writeProjectPlan(projectPrimaryPath, hd, next);
      return json(res, 200, { ok: true, plan: next });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/project-agents-doc') {
    try {
      const agentsPath = path.join(workDir, 'AGENTS.md');
      const content = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
      return json(res, 200, { content, path: agentsPath, name: 'AGENTS.md' });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/project-agents-doc') {
    try {
      const body = await readJson(req);
      const content = typeof body.content === 'string' ? body.content : '';
      const agentsPath = path.join(workDir, 'AGENTS.md');
      await writeFile(agentsPath, content, 'utf8');
      return json(res, 200, { ok: true, content, path: agentsPath, name: 'AGENTS.md' });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/project-rules') {
    try {
      const homeDir = resolveGuiHomeDir();
      const registered = findWorkspaceProject(await readWorkspaceRegistry(homeDir), projectPrimaryPath);
      const workPaths = registered ? workspaceWorkPaths(registered) : [projectPrimaryPath];
      const catalog = new ProjectRuleCatalogService(workPaths);
      const entries = await catalog.list(false);
      const effective = catalog.effectiveFor(workDir, entries);
      const settings = await readProjectSettings(workDir, homeDir);
      return json(res, 200, {
        entries,
        effectiveIds: effective.map(entry => entry.id),
        targetPath: workDir,
        policy: { customPrompt: settings.customPrompt, projectRules: settings.projectRules },
      });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/project-rule') {
    try {
      const homeDir = resolveGuiHomeDir();
      const registered = findWorkspaceProject(await readWorkspaceRegistry(homeDir), projectPrimaryPath);
      const catalog = new ProjectRuleCatalogService(registered ? workspaceWorkPaths(registered) : [projectPrimaryPath]);
      return json(res, 200, await catalog.read(url.searchParams.get('id') || ''));
    } catch (error) {
      return json(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (req.method === 'PUT' && url.pathname === '/api/project-rule') {
    try {
      const body = await readJson(req);
      if (typeof body.id !== 'string' || typeof body.content !== 'string' || typeof body.expectedRevision !== 'string') {
        return json(res, 400, { error: 'id, content, and expectedRevision are required' });
      }
      const homeDir = resolveGuiHomeDir();
      const registered = findWorkspaceProject(await readWorkspaceRegistry(homeDir), projectPrimaryPath);
      const catalog = new ProjectRuleCatalogService(registered ? workspaceWorkPaths(registered) : [projectPrimaryPath]);
      return json(res, 200, await catalog.write(body.id, body.content, body.expectedRevision));
    } catch (error) {
      return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (req.method === 'PUT' && url.pathname === '/api/project-rule-policy') {
    try {
      const body = await readJson(req);
      const homeDir = resolveGuiHomeDir();
      const saved = await writeProjectSettings(workDir, homeDir, {
        customPrompt: typeof body.customPrompt === 'string' ? body.customPrompt : undefined,
        projectRules: typeof body.projectRules === 'string' ? body.projectRules : undefined,
      });
      projectSettings = saved;
      systemPrompt = buildGuiSystemPrompt(workDir, projectSettings, homeDir, projectRegisteredWorkPaths);
      invalidateHeavyState();
      return json(res, 200, { ok: true, policy: { customPrompt: saved.customPrompt, projectRules: saved.projectRules } });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/project-memory-doc') {
    if (!sdk) return json(res, 503, { error: 'Hadamard SDK is not configured.' });
    try {
      const paths = await sdk.memory.paths({ projectPath: workDir });
      const memoryPath = paths.autoMemoryEntrypoint;
      const content = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8') : '';
      return json(res, 200, { content, path: memoryPath });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/project-memory-doc') {
    if (!sdk) return json(res, 503, { error: 'Hadamard SDK is not configured.' });
    try {
      const body = await readJson(req);
      const content = typeof body.content === 'string' ? body.content : '';
      const paths = await sdk.memory.paths({ projectPath: workDir });
      const memoryPath = paths.autoMemoryEntrypoint;
      await mkdir(path.dirname(memoryPath), { recursive: true });
      await writeFile(memoryPath, content, 'utf8');
      return json(res, 200, { ok: true, path: memoryPath });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/project-plans') {
    try {
      const currentPath = planFilePath(workDir);
      const files = listPlanFiles(workDir);
      const normalizedCurrent = path.normalize(currentPath);
      const plans = files.map(planPath => ({
        name: path.basename(planPath),
        path: planPath,
        current: path.normalize(planPath) === normalizedCurrent,
      }));
      return json(res, 200, { plans, currentPath });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/project-plan') {
    try {
      const name = url.searchParams.get('name');
      const requestedPath = url.searchParams.get('path');
      let targetPath = planFilePath(workDir);
      if (typeof requestedPath === 'string' && requestedPath.trim()) {
        targetPath = path.resolve(requestedPath.trim());
      } else if (typeof name === 'string' && name.trim()) {
        targetPath = path.join(planDirFor(workDir), name.trim());
      }
      const allowedRoots = [
        path.resolve(planDirFor(workDir)),
        path.resolve(getHadamardProjectSessionDirectory(workDir, resolveGuiHomeDir())),
      ];
      const legacyKey = workDir.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40) || 'default';
      allowedRoots.push(path.resolve(path.join(resolveGuiHomeDir(), 'projects', legacyKey)));
      const allowed = allowedRoots.some(root => {
        const relative = path.relative(root, targetPath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      });
      if (!allowed) return json(res, 400, { error: 'Plan path is outside the project plan directory.' });
      const content = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
      return json(res, 200, { content, path: targetPath, name: path.basename(targetPath) });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/project-plan') {
    try {
      const body = await readJson(req);
      const content = typeof body.content === 'string' ? body.content : '';
      const planDir = planDirFor(workDir);
      await mkdir(planDir, { recursive: true });
      let targetPath = planFilePath(workDir);
      if (typeof body.path === 'string' && body.path.trim()) {
        targetPath = path.resolve(body.path.trim());
      } else if (typeof body.name === 'string' && body.name.trim()) {
        targetPath = path.join(planDir, body.name.trim());
      }
      const allowedRoots = [path.resolve(planDir)];
      const allowed = allowedRoots.some(root => {
        const relative = path.relative(root, targetPath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      });
      if (!allowed) return json(res, 400, { error: 'Plan path is outside the project plan directory.' });
      await writeFile(targetPath, content, 'utf8');
      return json(res, 200, { ok: true, path: targetPath, name: path.basename(targetPath) });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/issues') {
    try {
      const hd = resolveGuiHomeDir();
      const targetPath = issueTargetPath(url.searchParams.get('path'));
      return json(res, 200, await issuePayload(targetPath, hd));
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/issues') {
    try {
      const body = await readJson(req);
      const hd = resolveGuiHomeDir();
      const targetPath = issueTargetPath(body.path);
      const storage = await issueStorageFor(targetPath, hd);
      const idOrNumber = body.id ?? body.number ?? body.idOrNumber;
      if (typeof idOrNumber === 'string' || typeof idOrNumber === 'number') {
        const patch = {
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          ...(isIssuePriority(body.priority) ? { priority: body.priority } : {}),
          ...(Array.isArray(body.labels) ? { labels: body.labels } : {}),
          ...(Array.isArray(body.acceptanceCriteria) ? { acceptanceCriteria: body.acceptanceCriteria } : {}),
          ...(typeof body.parentIssueId === 'string' || body.parentIssueId === null ? { parentIssueId: body.parentIssueId } : {}),
          ...(typeof body.agentConfig === 'string' || body.agentConfig === null ? { agentConfig: body.agentConfig } : {}),
          ...(typeof body.brief === 'string' || body.brief === null ? { brief: body.brief } : {}),
        };
        const issue = await updateProjectIssue(targetPath, hd, idOrNumber, patch, storage);
        if (!issue) return json(res, 404, { error: 'Issue not found' });
        return json(res, 200, { ...(await issuePayload(targetPath, hd)), issue });
      }
      const issue = await createProjectIssue(targetPath, hd, {
        title: typeof body.title === 'string' ? body.title : '',
        description: typeof body.description === 'string' ? body.description : '',
        status: isIssueStatus(body.status) ? body.status : undefined,
        priority: isIssuePriority(body.priority) ? body.priority : undefined,
        labels: Array.isArray(body.labels) ? body.labels : undefined,
        acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : undefined,
        parentIssueId: typeof body.parentIssueId === 'string' ? body.parentIssueId : undefined,
        createdBy: body.createdBy === 'manager' ? 'manager' : 'user',
        agentConfig: typeof body.agentConfig === 'string' ? body.agentConfig : undefined,
        brief: typeof body.brief === 'string' ? body.brief : undefined,
      }, storage);
      return json(res, 200, { ...(await issuePayload(targetPath, hd)), issue });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/issues/status') {
    try {
      const body = await readJson(req);
      if (!isIssueStatus(body.status)) return json(res, 400, { error: 'Invalid issue status' });
      if (body.status === 'in_progress') {
        return json(res, 400, { error: 'Use /api/issues/start so in_progress is owned by deterministic dispatch' });
      }
      const idOrNumber = body.id ?? body.number ?? body.idOrNumber;
      if (typeof idOrNumber !== 'string' && typeof idOrNumber !== 'number') {
        return json(res, 400, { error: 'Missing issue id' });
      }
      const hd = resolveGuiHomeDir();
      const targetPath = issueTargetPath(body.path);
      const storage = await issueStorageFor(targetPath, hd);
      const issue = await transitionProjectIssue(targetPath, hd, idOrNumber, body.status, 'user', storage);
      if (!issue) return json(res, 404, { error: 'Issue not found' });
      return json(res, 200, { ...(await issuePayload(targetPath, hd)), issue });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/issues/comment') {
    try {
      const body = await readJson(req);
      const idOrNumber = body.id ?? body.number ?? body.idOrNumber;
      if (typeof idOrNumber !== 'string' && typeof idOrNumber !== 'number') {
        return json(res, 400, { error: 'Missing issue id' });
      }
      const hd = resolveGuiHomeDir();
      const targetPath = issueTargetPath(body.path);
      const storage = await issueStorageFor(targetPath, hd);
      const issue = await addIssueComment(targetPath, hd, idOrNumber, {
        body: typeof body.body === 'string' ? body.body : '',
        actor: 'user',
        kind: issueCommentKindFrom(body.kind),
      }, storage);
      if (!issue) return json(res, 404, { error: 'Issue not found' });
      return json(res, 200, { ...(await issuePayload(targetPath, hd)), issue });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/issues/start') {
    return streamIssueDispatch(await readJson(req) as Record<string, unknown>, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/issues/delete') {
    try {
      const body = await readJson(req);
      const idOrNumber = body.id ?? body.number ?? body.idOrNumber;
      if (typeof idOrNumber !== 'string' && typeof idOrNumber !== 'number') {
        return json(res, 400, { error: 'Missing issue id' });
      }
      const hd = resolveGuiHomeDir();
      const targetPath = issueTargetPath(body.path);
      const storage = await issueStorageFor(targetPath, hd);
      const deleted = await deleteProjectIssue(targetPath, hd, idOrNumber, storage);
      if (!deleted) return json(res, 404, { error: 'Issue not found' });
      return json(res, 200, await issuePayload(targetPath, hd));
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/issues/storage') {
    try {
      const hd = resolveGuiHomeDir();
      const targetPath = issueTargetPath(url.searchParams.get('path'));
      const mode = await issueStorageFor(targetPath, hd);
      return json(res, 200, {
        path: targetPath,
        mode,
        storePath: resolveIssueStorePath(targetPath, hd, mode),
      });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/issues/storage') {
    try {
      const body = await readJson(req);
      if (!isIssueStorageMode(body.mode)) return json(res, 400, { error: 'Invalid issue storage mode' });
      const hd = resolveGuiHomeDir();
      const targetPath = issueTargetPath(body.path);
      const from = await issueStorageFor(targetPath, hd);
      await migrateIssueStore({ workDir: targetPath, homeDir: hd, from, to: body.mode });
      await writeProjectMeta(targetPath, hd, { issueStorage: body.mode });
      return json(res, 200, await issuePayload(targetPath, hd));
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
      if (req.method === 'GET' && url.pathname === '/api/session/messages') return json(res, 200, { messages: renderableHistory(session) });
      if (req.method === 'POST' && url.pathname === '/api/screenshot') {
        try {
          const body = await readJson(req).catch(() => ({}));
          const mode = body && typeof body === 'object' && (body as { mode?: string }).mode === 'full'
            ? 'full'
            : 'region';
          const outputPath = path.join(
            workDir,
            '.hadamard',
            'screenshots',
            `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
          );
          await withHiddenGuiWindows(async () => {
            if (mode === 'full') await captureDesktopScreenshot(outputPath);
            else await captureDesktopRegionScreenshot(outputPath);
          });
          return json(res, 200, {
            ok: true,
            mode,
            path: outputPath,
            relativePath: path.relative(workDir, outputPath).split(path.sep).join('/'),
          });
        } catch (error) {
          if (error instanceof ScreenshotCancelledError) {
            return json(res, 400, { error: error.message, cancelled: true });
          }
          return json(res, 500, { error: (error as Error).message });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/bridge/detect') {
        return json(res, 200, { providers: await detectBridgeProviders() });
      }
      if (req.method === 'GET' && url.pathname === '/api/external-cli/sessions') {
        const requestedRuntime = url.searchParams.get('runtime');
        const query = (url.searchParams.get('query') ?? '').trim().toLowerCase();
        const requestedLimit = Number(url.searchParams.get('limit') ?? 50);
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(200, Math.trunc(requestedLimit)))
          : 50;
        const requestedOffset = Number(url.searchParams.get('offset') ?? 0);
        const offset = Number.isFinite(requestedOffset)
          ? Math.max(0, Math.trunc(requestedOffset))
          : 0;
        const runtimes: ExternalCliRuntime[] | undefined =
          requestedRuntime && isManagedExternalCliRuntime(requestedRuntime as BridgeRuntime)
          ? [requestedRuntime as ExternalCliRuntime]
          : undefined;
        const scanned = await listExternalCliSessions({
          homeDir: pointerHomeDir(),
          hadamardHomeDir: resolveGuiHomeDir(),
          crushCwd: workDir,
          runtimes,
          ...(query ? {} : { offset, limit: limit + 1 }),
        });
        const filtered = scanned.filter(summary => !query
          || summary.title.toLowerCase().includes(query)
          || (summary.cwd ?? '').toLowerCase().includes(query)
          || summary.nativeSessionId.toLowerCase().includes(query));
        const page = query ? filtered.slice(offset, offset + limit + 1) : filtered;
        const hasMore = page.length > limit;
        const historySecrets = externalCliHistorySecrets(resolveGuiHomeDir());
        const summaries = page.slice(0, limit)
          .map(summary => {
            const { path: sessionPath, ...safeSummary } = summary;
            return redactExternalCliHistoryDto({
              ...safeSummary,
              sourceLabel: externalCliHistorySourceLabel(summary),
              id: registerExternalCliSessionPath(sessionPath),
            }, historySecrets);
          });
        return json(res, 200, {
          sessions: summaries,
          total: query ? filtered.length : null,
          offset,
          nextOffset: hasMore ? offset + summaries.length : null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/external-cli/auth') {
        const runtimes = await Promise.all([
          probeExternalCliAuth('claude'),
          probeExternalCliAuth('codewhale'),
          probeExternalCliAuth('pi'),
          probeExternalCliAuth('codex'),
          probeExternalCliAuth('reasonix'),
          probeExternalCliAuth('crush'),
        ]);
        return json(res, 200, { runtimes });
      }
      if (req.method === 'GET' && url.pathname === '/api/external-cli/runs') {
        return json(res, 200, {
          runs: externalCliRuntimeManager.list().map(safeExternalCliRunSummary),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/external-cli/run') {
        const runId = url.searchParams.get('runId') ?? '';
        const afterSequence = Number(url.searchParams.get('after') ?? 0);
        const replay = externalCliRuntimeManager.replay(
          runId,
          Number.isFinite(afterSequence) ? Math.max(0, Math.trunc(afterSequence)) : 0,
        );
        return replay
          ? json(res, 200, { ...replay, run: safeExternalCliRun(replay.run) })
          : json(res, 404, { error: 'External CLI run not found.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/external-cli/run') {
        if (runtimeMutationInProgress) {
          return json(res, 409, { error: 'Runtime configuration is being updated. Try again in a moment.' });
        }
        const body = await readJson(req);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const configName = typeof body.configName === 'string'
          ? body.configName.trim()
          : activeBridgeConfig?.name ?? '';
        const config = configName
          ? findBridgeConfig(configName, resolveGuiHomeDir())
          : undefined;
        if (!prompt) return json(res, 400, { error: 'Missing external CLI prompt.' });
        if (body.nativeSessionId !== undefined) {
          return json(res, 400, {
            error: 'Resume native conversations through the validated external session history endpoint.',
          });
        }
        if (
          !config
          || config.execution !== 'cli'
          || !isManagedExternalCliRuntime(config.runtime)
        ) {
          return json(res, 400, { error: 'Select an External CLI config.' });
        }
        const run = await startManagedExternalCliRun(
          config as SupportedExternalCliConfig,
          prompt,
          body.background !== false,
        );
        return json(res, run.background ? 202 : 200, { run: safeExternalCliRun(run) });
      }
      if (req.method === 'POST' && url.pathname === '/api/external-cli/run/abort') {
        const body = await readJson(req);
        const runId = typeof body.runId === 'string' ? body.runId : '';
        return externalCliRuntimeManager.abort(runId)
          ? json(res, 200, { ok: true })
          : json(res, 404, { error: 'Active external CLI run not found.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/external-cli/session') {
        const id = url.searchParams.get('id') ?? '';
        if (!id) return json(res, 400, { error: 'Missing external session id.' });
        const sessionPath = resolveExternalCliSessionPath(id);
        if (!sessionPath) {
          return json(res, 400, { error: 'Invalid external session id.' });
        }
        let externalSession;
        try {
          externalSession = await readExternalCliSession(sessionPath, {
            homeDir: pointerHomeDir(),
            hadamardHomeDir: resolveGuiHomeDir(),
            crushCwd: workDir,
          });
        } catch (error) {
          if ((error as { code?: string }).code === 'EXTERNAL_CLI_SESSION_PATH_UNSAFE') {
            return json(res, 400, { error: 'External session id is outside the allowed runtime history roots.' });
          }
          throw error;
        }
        if (!externalSession) return json(res, 404, { error: 'External session not found.' });
        const { path: _path, ...safeSummary } = externalSession.summary;
        const compatibleConfigNames = readBridgeConfigs(resolveGuiHomeDir()).configs
          .filter(config => isExternalCliHistoryConfigCompatible(externalSession.summary, config))
          .map(config => config.name);
        return json(res, 200, {
          compatibleConfigNames,
          session: redactExternalCliHistoryDto({
            summary: {
              ...safeSummary,
              sourceLabel: externalCliHistorySourceLabel(externalSession.summary),
              id,
            },
            messages: externalSession.messages,
            truncated: externalSession.truncated === true,
          }, externalCliHistorySecrets(resolveGuiHomeDir())),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/external-cli/session/resume') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        const configName = typeof body.configName === 'string' ? body.configName.trim() : '';
        if (!id || !configName) {
          return json(res, 400, { error: 'External session id and config name are required.' });
        }
        const sessionPath = resolveExternalCliSessionPath(id);
        if (!sessionPath) {
          return json(res, 400, { error: 'Invalid external session id.' });
        }
        let externalSession;
        try {
          externalSession = await readExternalCliSession(sessionPath, {
            homeDir: pointerHomeDir(),
            hadamardHomeDir: resolveGuiHomeDir(),
            crushCwd: workDir,
          });
        } catch (error) {
          if ((error as { code?: string }).code === 'EXTERNAL_CLI_SESSION_PATH_UNSAFE') {
            return json(res, 400, { error: 'External session id is outside the allowed runtime history roots.' });
          }
          throw error;
        }
        if (!externalSession) return json(res, 404, { error: 'External session not found.' });
        const config = findBridgeConfig(configName, resolveGuiHomeDir());
        if (
          !config
          || !isExternalCliHistoryConfigCompatible(externalSession.summary, config)
        ) {
          return json(res, 400, {
            error: 'Choose an External CLI config for the same runtime and authentication profile as this session.',
          });
        }
        if (
          externalSession.summary.cwd
          && !sameWorkspace(externalSession.summary.cwd, workDir)
        ) {
          return json(res, 409, {
            error: 'Open the session workspace before resuming it: ' + externalSession.summary.cwd,
          });
        }
        try {
          await withRuntimeMutation(async () => {
            await activateBridgeConfig(config);
            await rememberExternalNativeSession(
              config as SupportedExternalCliConfig,
              externalSession.summary.nativeSessionId,
            );
            await persistSessionRuntimeMetadata();
          });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
        return json(res, 200, await state());
      }
      if (req.method === 'GET' && url.pathname === '/api/bridge/detect-local') {
        const runtime = url.searchParams.get('runtime') || '';
        const hd = pointerHomeDir();
        const local = detectRuntimeLocalConfig(runtime, hd, externalCliConfigPaths);
        return json(res, 200, local
          ? {
              runtime: local.runtime,
              provider: local.provider,
              model: local.model,
              baseURL: local.baseURL,
              hasApiKey: Boolean(local.apiKey),
              apiKey: local.apiKey,
              source: local.source,
            }
          : {});
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/update-local') {
        try {
          const body = await readJson(req);
          const runtime = typeof body.runtime === 'string' ? body.runtime.trim() : '';
          if (!runtime) return json(res, 400, { error: 'Missing runtime' });
          const hd = pointerHomeDir();
          const result = await withRuntimeMutation(async () => updateRuntimeLocalConfig(runtime, {
              model: typeof body.model === 'string' ? body.model : undefined,
              baseURL: typeof body.baseURL === 'string' ? body.baseURL : undefined,
              apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
            }, hd, externalCliConfigPaths));
          if (!result.ok) return json(res, 400, { error: result.error });
          return json(res, 200, result);
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/config') {
        let releaseRuntimeMutation: () => void;
        try {
          releaseRuntimeMutation = beginRuntimeMutation();
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
        try {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const provider = body.provider === 'openai' ? 'openai' : 'anthropic';
        const runtime: BridgeRuntime = (typeof body.runtime === 'string' && (VALID_RUNTIMES as string[]).includes(body.runtime))
          ? (body.runtime as BridgeRuntime) : 'claude';
        const execution = body.execution === 'cli' ? 'cli' : 'api';
        const authSource = body.authSource === 'native' ? 'native' : 'apiKey';
        if (!name) return json(res, 400, { error: 'Missing config name' });
        if (execution === 'cli' && !isManagedExternalCliRuntime(runtime)) {
          return json(res, 400, { error: 'External CLI mode requires a CLI runtime.' });
        }
        // Merge with the existing config of the same name when editing. The form
        // intentionally leaves the API-key field blank on edit (it's a secret),
        // so a blank key must PRESERVE the saved one — not replace it with empty.
        // clearApiKey:true explicitly drops the key.
        // Hadamard configs may omit credentials (SDK defaults) or carry apiKey/baseURL
        // for a named provider override — same persistence path either way.
        const existing = findBridgeConfig(name, resolveGuiHomeDir());
        const config: PersistedBridgeConfig = { name, provider, runtime, execution, authSource };
        if (typeof body.credentialProvider === 'string' && body.credentialProvider.trim()) {
          config.credentialProvider = body.credentialProvider.trim();
        }
        if (body.trustProjectResources === true) config.trustProjectResources = true;
        if (body.clearApiKey === true) {
          // explicitly remove the saved key
        } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
          config.apiKey = body.apiKey.trim();
        } else if (existing?.apiKey) {
          config.apiKey = existing.apiKey; // preserve on edit
        }
        if (execution === 'cli' && authSource === 'apiKey' && !config.apiKey) {
          return json(res, 400, { error: 'API-key override requires an API key.' });
        }
        // baseURL/model: the form loads existing values, so an empty field means
        // the user cleared it intentionally (send as-is; empty → omitted).
        if (typeof body.baseURL === 'string' && body.baseURL.trim()) config.baseURL = body.baseURL.trim();
        if (typeof body.model === 'string' && body.model.trim()) config.model = body.model.trim();
        // Models array (provider-specific model registry).
        if (Array.isArray(body.models)) {
          config.models = (body.models as Array<Record<string, unknown>>)
            .filter(m => typeof m.name === 'string' && m.name.trim())
            .map(m => ({
              name: (m.name as string).trim(),
              context1M: m.context1M === true || false,
              ...(typeof m.contextWindowTokens === 'number' && m.contextWindowTokens > 0
                ? { contextWindowTokens: Math.floor(m.contextWindowTokens) }
                : {}),
              ...(typeof m.maxContextWindowTokens === 'number' && m.maxContextWindowTokens > 0
                ? { maxContextWindowTokens: Math.floor(m.maxContextWindowTokens) }
                : {}),
              ...(typeof m.effectiveContextWindowPercent === 'number' && m.effectiveContextWindowPercent > 0 && m.effectiveContextWindowPercent <= 100
                ? { effectiveContextWindowPercent: m.effectiveContextWindowPercent }
                : {}),
              ...(typeof m.autoCompactTokenLimit === 'number' && m.autoCompactTokenLimit > 0
                ? { autoCompactTokenLimit: Math.floor(m.autoCompactTokenLimit) }
                : {}),
              modality: (m.modality === 'multimodal' ? 'multimodal' : 'text') as ModelModality,
            }));
        }
        addBridgeConfig(config, resolveGuiHomeDir());
        // Rebuild the active execution path as well as its display state. This
        // matters for Direct API configs because their ModelApi captures the
        // prior model/base URL/key, and for CLI configs because the manager
        // cache key must reflect an auth override change.
        if (activeBridgeConfig?.name === config.name) {
          await activateBridgeConfig(config);
          await persistSessionRuntimeMetadata();
        }
        invalidateHeavyState();
        return json(res, 200, await state());
        } finally {
          releaseRuntimeMutation();
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/config/delete') {
        try {
          return await withRuntimeMutation(async () => {
            const body = await readJson(req);
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (!name) return json(res, 400, { error: 'Missing config name' });
            const strategy = parseDeleteStrategy(body.strategy);
            if (strategy.type !== 'leave') {
              await applyDeleteFallback('config', name, strategy, await referenceOperationContext());
            }
            removeBridgeConfig(name, resolveGuiHomeDir());
            if (activeBridgeConfig?.name === name) {
              disableBridge();
              await persistSessionRuntimeMetadata();
            }
            invalidateHeavyState();
            return json(res, 200, await state());
          });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/router/activate') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return json(res, 400, { error: 'Missing router name' });
        const loaded = loadRouterProfile(name, workDir, resolveGuiHomeDir());
        if (!loaded) {
          return json(res, 404, { error: `Configured router not found: ${name}` });
        }
        try {
          await withRuntimeMutation(async () => {
            disableBridge();
            activeRouter = loaded.profile;
            routedModelLabel = null;
            await persistSessionRuntimeMetadata();
          });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/activate') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const cfg = findBridgeConfig(name, resolveGuiHomeDir());
        if (!cfg) return json(res, 404, { error: `bridge config not found: ${name}` });
        try {
          await withRuntimeMutation(async () => {
            await activateBridgeConfig(cfg);
            activeAgentSelectionName = null;
            activeRouter = null;
            routedModelLabel = null;
            await persistSessionRuntimeMetadata();
          });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/off') {
        try {
          await withRuntimeMutation(async () => {
            disableBridge();
            await persistSessionRuntimeMetadata();
          });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/router/profile') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return json(res, 400, { error: 'Missing router profile name' });
        if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) {
          return json(res, 400, { error: 'Invalid name (use letters, digits, spaces, . _ -)' });
        }
        const parseRef = (raw: unknown): RouterModelRef | null => {
          if (!raw || typeof raw !== 'object') return null;
          const obj = raw as Record<string, unknown>;
          const model = typeof obj.model === 'string' ? obj.model.trim() : '';
          if (!model) return null;
          const ref: RouterModelRef = { model };
          if (obj.provider === 'openai' || obj.provider === 'anthropic') ref.provider = obj.provider;
          if (typeof obj.baseURL === 'string' && obj.baseURL.trim()) ref.baseURL = obj.baseURL.trim();
          if (typeof obj.apiKey === 'string' && obj.apiKey.trim()) ref.apiKey = obj.apiKey.trim();
          if (typeof obj.maxTokens === 'number' && Number.isFinite(obj.maxTokens) && obj.maxTokens > 0) {
            ref.maxTokens = Math.floor(obj.maxTokens);
          }
          return ref;
        };
        // Unified reference model: accept typed route/fallback targets so
        // clients can persist agent refs instead of lossy model flattening.
        const parseTargetRef = (raw: unknown): AgentTargetRef | null => {
          if (!raw || typeof raw !== 'object') return null;
          const obj = raw as Record<string, unknown>;
          if (obj.kind === 'agent' && typeof obj.name === 'string' && obj.name.trim()) {
            return { kind: 'agent', name: obj.name.trim() };
          }
          if (obj.kind === 'team' && typeof obj.name === 'string' && obj.name.trim()) {
            return { kind: 'team', name: obj.name.trim() };
          }
          if (obj.kind === 'model' && typeof obj.model === 'string' && obj.model.trim()) {
            return {
              kind: 'model',
              config: typeof obj.config === 'string' ? obj.config.trim() : '',
              model: obj.model.trim(),
            };
          }
          return null;
        };
        const routerModel = parseRef(body.routerModel);
        if (!routerModel) return json(res, 400, { error: 'Leader model (routerModel.model) is required' });
        const routesRaw = Array.isArray(body.routes) ? body.routes : [];
        const routes: RouterRoute[] = [];
        for (const item of routesRaw) {
          if (!item || typeof item !== 'object') continue;
          const obj = item as Record<string, unknown>;
          const base = parseRef(obj);
          const when = typeof obj.when === 'string' ? obj.when.trim() : '';
          if (!base || !when) continue;
          const route: RouterRoute = { ...base, when };
          if (typeof obj.role === 'string' && obj.role.trim()) route.role = obj.role.trim();
          if (typeof obj.name === 'string' && obj.name.trim()) route.name = obj.name.trim();
          if (typeof obj.description === 'string' && obj.description.trim()) route.description = obj.description.trim();
          if (typeof obj.effort === 'string' && obj.effort.trim()) {
            route.effort = obj.effort.trim() as RouterRoute['effort'];
          }
          const routeTarget = parseTargetRef(obj.target);
          if (routeTarget) route.target = routeTarget;
          routes.push(route);
        }
        if (routes.length === 0) return json(res, 400, { error: 'At least one route with model + when is required' });
        const profile: RouterProfile = {
          name,
          routerModel,
          routes,
        };
        const routerModelTarget = parseTargetRef(body.routerModelTarget);
        if (routerModelTarget?.kind === 'model') profile.routerModelTarget = routerModelTarget;
        if (typeof body.description === 'string' && body.description.trim()) {
          profile.description = body.description.trim();
        }
        if (typeof body.classificationPrompt === 'string' && body.classificationPrompt.trim()) {
          profile.classificationPrompt = body.classificationPrompt.trim();
        }
        const fallback = parseRef(body.fallback);
        if (fallback) profile.fallback = fallback;
        const fallbackTarget = parseTargetRef(body.fallbackTarget);
        if (fallbackTarget) profile.fallbackTarget = fallbackTarget;
        const target = body.target === 'personal' ? 'personal' : 'project';
        let releaseRuntimeMutation: () => void;
        try {
          releaseRuntimeMutation = beginRuntimeMutation();
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
        try {
          const store = await resolveHadamardSettingsStore({
            configPath: options.configPath,
            homeDir: currentHomeInput(),
          }).catch(() => undefined);
          const hadamardHome = store?.homeDir ?? resolveGuiHomeDir();
          try {
            await saveRouterProfile(profile, {
              projectDir: target === 'project' ? workDir : undefined,
              homeDir: hadamardHome,
              overwrite: true,
            });
          } catch (error) {
            return json(res, 400, { error: (error as Error).message });
          }
          if (activeRouter?.name === name) {
            const reloaded = loadRouterProfile(name, workDir, hadamardHome);
            activeRouter = reloaded?.profile ?? profile;
          }
          invalidateHeavyState();
          return json(res, 200, await state());
        } finally {
          releaseRuntimeMutation();
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/router/profile/delete') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return json(res, 400, { error: 'Missing router profile name' });
        let releaseRuntimeMutation: () => void;
        try {
          releaseRuntimeMutation = beginRuntimeMutation();
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
        try {
          const store = await resolveHadamardSettingsStore({
            configPath: options.configPath,
            homeDir: currentHomeInput(),
          }).catch(() => undefined);
          const hadamardHome = store?.homeDir ?? resolveGuiHomeDir();
          const loaded = loadRouterProfile(name, workDir, hadamardHome);
          if (!loaded) return json(res, 404, { error: `router profile not found: ${name}` });
          const deleted = await deleteRouterProfile(name, workDir, hadamardHome);
          if (!deleted) return json(res, 404, { error: `router profile not found: ${name}` });
          if (activeRouter?.name === name) {
            activeRouter = null;
            routedModelLabel = null;
            await persistSessionRuntimeMetadata();
          }
          invalidateHeavyState();
          return json(res, 200, await state());
        } finally {
          releaseRuntimeMutation();
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/mcp/list') {
        return json(res, 200, readMcpServerConfig(resolveGuiHomeDir()));
      }
      if (req.method === 'POST' && url.pathname === '/api/mcp/add') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return json(res, 400, { error: 'Missing server name' });
        const server: PersistedMcpServer = { name };
        if (typeof body.command === 'string' && body.command) server.command = body.command;
        if (typeof body.url === 'string' && body.url) server.url = body.url;
        if (Array.isArray(body.args)) server.args = body.args.filter((a: unknown) => typeof a === 'string') as string[];
        try {
          await withRuntimeMutation(async () => {
            addMcpServer(server, resolveGuiHomeDir());
            await reloadSdk();
          });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/mcp/remove') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return json(res, 400, { error: 'Missing server name' });
        try {
          await withRuntimeMutation(async () => {
            removeMcpServer(name, resolveGuiHomeDir());
            await reloadSdk();
          });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/open-location') {
        openPathInSystem(workDir);
        return json(res, 200, { ok: true, path: workDir });
      }
      if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
        const folder = await pickFolder();
        return json(res, 200, { ok: true, folder });
      }
      if (req.method === 'GET' && url.pathname === '/api/browse') {
        try {
          const rawPath = url.searchParams.get('path');
          return json(res, 200, await browseDirectory(rawPath ?? undefined));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/workspace-files') {
        try {
          const rawPath = url.searchParams.get('path');
          return json(res, 200, await listWorkspaceFiles(rawPath ?? undefined, workDir));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/workspace-file') {
        try {
          const rawPath = url.searchParams.get('path');
          if (!rawPath) return json(res, 400, { error: 'Missing file path' });
          return json(res, 200, await readWorkspaceFile(rawPath, workDir));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      if ((req.method === 'PUT' || req.method === 'POST') && url.pathname === '/api/workspace-file') {
        try {
          const body = await readJson(req);
          const rawPath = typeof body.path === 'string' ? body.path : '';
          const text = body.text;
          if (!rawPath) return json(res, 400, { error: 'Missing file path' });
          if (typeof text !== 'string') return json(res, 400, { error: 'File content must be text' });
          return json(res, 200, await writeWorkspaceFile(rawPath, text, workDir));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/project/open') {
        const body = await readJson(req);
        const nextWorkDir = typeof body.path === 'string' ? body.path.trim() : '';
        if (!nextWorkDir) return json(res, 400, { error: 'Missing project path' });
        try {
          return json(res, 200, await withRuntimeMutation(() => switchProject(nextWorkDir, {
            remember: body.remember !== false,
          })));
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/project/work-path') {
        try {
          const body = await readJson(req);
          return json(res, 200, await withRuntimeMutation(() => updateProjectWorkPath(body)));
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/session-center') {
        try {
          const split = (name: string): string[] =>
            url.searchParams.getAll(name)
              .flatMap(value => value.split(','))
              .map(value => value.trim())
              .filter(Boolean);
          const rawTypes = split('type').filter(value =>
            value === 'user'
            || value === 'assistant-global'
            || value === 'assistant-project'
            || value === 'agent');
          const rawStatuses = split('status').filter(value =>
            value === 'running' || value === 'waiting' || value === 'idle');
          const rawArchived = url.searchParams.get('archived');
          const catalog = await createSessionCenterCatalog();
          return json(res, 200, await catalog.query({
            ...(split('projectPath').length ? { projectPaths: split('projectPath') } : {}),
            ...(rawTypes.length
              ? { types: rawTypes as import('../storage/sessionCatalog.js').SessionCatalogType[] }
              : {}),
            ...(rawStatuses.length
              ? { runtimeStatuses: rawStatuses as import('../storage/sessionCatalog.js').SessionCatalogRuntimeStatus[] }
              : {}),
            archived: rawArchived === 'all' ? 'all' : rawArchived === 'true',
            keyword: url.searchParams.get('q') ?? undefined,
            page: Number(url.searchParams.get('page')) || 1,
            pageSize: Number(url.searchParams.get('pageSize')) || 50,
          }));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/session-center/reference') {
        try {
          const body = await readJson(req);
          if (!isPlainRecord(body.locator)) {
            return json(res, 400, { error: 'Session reference requires a locator.' });
          }
          const catalog = await createSessionCenterCatalog();
          return json(res, 200, await catalog.reference(
            body.locator as unknown as import('../storage/sessionCatalog.js').SessionCatalogLocator,
          ));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/session-center/action') {
        try {
          const body = await readJson(req);
          const action = typeof body.action === 'string' ? body.action : '';
          if (!['create', 'open', 'rename', 'pin', 'archive', 'restore', 'delete'].includes(action)) {
            return json(res, 400, { error: 'Unknown Session Center action.' });
          }
          const runAction = () => enqueueServerSessionResume(async () => {
            if (action === 'open' || action === 'create') assertSessionNavigationAllowed();
            const catalog = await createSessionCenterCatalog();
            const item = await catalog.action({
              action: action as import('../storage/sessionCatalog.js').SessionCatalogAction,
              locator: isPlainRecord(body.locator)
                ? body.locator as unknown as import('../storage/sessionCatalog.js').SessionCatalogLocator
                : undefined,
              projectPath: typeof body.projectPath === 'string' ? body.projectPath : undefined,
              type: body.type === 'user'
                || body.type === 'assistant-global'
                || body.type === 'assistant-project'
                ? body.type
                : undefined,
              title: typeof body.title === 'string' ? body.title : undefined,
              pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
              model: session.model,
            });
            const shouldOpen = (action === 'open' || action === 'create') && !item.archived;
            if (shouldOpen && item.projectPath && normalizeFsPath(item.projectPath) !== normalizeFsPath(workDir)) {
              await switchProject(item.projectPath);
            }
            if (shouldOpen) {
              if (item.type === 'user') {
                await replaceGuiSession(await resumeGuiSession(item.locator.sessionId, {
                  model: options.model,
                  permissionMode: options.permissionMode,
                }));
                await restoreSessionRuntimeSelection();
              } else if (item.type === 'assistant-global' || item.type === 'assistant-project') {
                await selectAssistantCatalogItem(item);
              }
            }
            if (
              (action === 'archive' || action === 'delete')
              && (item.type === 'assistant-global' || item.type === 'assistant-project')
            ) {
              const homeDir = managerHomeDir();
              const activeId = item.type === 'assistant-global'
                ? (await readAssistantConfig(homeDir)).activeSessionId
                : item.projectPath
                  ? (await readManagerConfig(item.projectPath, homeDir)).activeSessionId
                  : undefined;
              if (activeId === item.locator.sessionId) {
                await selectAssistantFallback(item, catalog);
              }
            }
            if (
              action === 'archive'
              && item.type === 'user'
              && session.id === item.locator.sessionId
            ) {
              session = await createGuiSession({ model: options.model, permissionMode });
              await restoreSessionRuntimeSelection();
            }
            invalidateHeavyState();
            return { ok: true, item, state: shouldOpen ? await state() : undefined };
          });
          const result = action === 'open' || action === 'create'
            ? await runAction()
            : await withRuntimeMutation(runAction);
          return json(res, 200, result);
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/git') {
        return json(res, 200, await gitInfo());
      }
      if (req.method === 'GET' && url.pathname === '/api/git/diff') {
        try {
          const filePath = url.searchParams.get('path') || '';
          if (!filePath) return json(res, 400, { error: 'Missing path' });
          const staged = url.searchParams.get('staged') === '1' || url.searchParams.get('staged') === 'true';
          return json(res, 200, await readGitDiffAsync(workDir, filePath, staged));
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/review/commits') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 100);
        const logRaw = await gitText(['log', '--decorate=short', '--pretty=format:%h%x1f%s%x1f%an%x1f%ae%x1f%ar%x1f%aI%x1f%p%x1f%D%x1e', '-n', String(limit)]);
        return json(res, 200, { commits: parseGitCommitLog(logRaw) });
      }
      if (req.method === 'POST' && url.pathname === '/api/review/diff') {
        try {
          const body = await readJson(req);
          const base = typeof body.base === 'string' ? body.base.trim() : '';
          const head = typeof body.head === 'string' ? body.head.trim() : '';
          const args = ['--no-pager', 'diff', '--no-color'];
          if (base) args.push(base + (head ? '..' + head : '..HEAD'));
          const patch = await gitText(args);
          return json(res, 200, { patch, truncated: patch.length > 200_000 });
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/review/summarize') {
        if (!sdk) return json(res, 400, { error: 'No provider configured' });
        try {
          const body = await readJson(req);
          const patch = typeof body.patch === 'string' ? body.patch : '';
          if (!patch.trim()) return json(res, 400, { error: 'Empty diff' });
          const summary = await generateReviewSummary({
            diff: patch,
            model: sdk.config.model,
            oneShotMessage: (r) => sdk!.oneShotMessage(r),
          });
          return json(res, 200, summary);
        } catch (error) {
          return json(res, 500, { error: (error as Error).message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/session/delete') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return json(res, 400, { error: 'Missing session id' });
        try {
          return json(res, 200, await withRuntimeMutation(() => deleteSession(id)));
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/session/archive') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return json(res, 400, { error: 'Missing session id' });
        try {
          return await withRuntimeMutation(async () => {
            const ok = await archiveSession(id);
            if (!ok) return json(res, 404, { error: 'Session not found' });
            return json(res, 200, await state());
          });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/session/unarchive') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return json(res, 400, { error: 'Missing session id' });
        try {
          return await withRuntimeMutation(async () => {
            const ok = await unarchiveSession(id);
            if (!ok) return json(res, 404, { error: 'Archived session not found' });
            return json(res, 200, await state());
          });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions/archived') {
        return json(res, 200, { sessions: await listArchivedSessions() });
      }
      if (req.method === 'POST' && url.pathname === '/api/project/forget') {
        const body = await readJson(req);
        const target = typeof body.path === 'string' ? body.path.trim() : '';
        if (!target) return json(res, 400, { error: 'Missing project path' });
        return json(res, 200, await forgetProject(target));
      }
      if (req.method === 'POST' && url.pathname === '/api/project/pin') {
        const body = await readJson(req);
        const target = typeof body.path === 'string' ? body.path.trim() : '';
        if (!target) return json(res, 400, { error: 'Missing project path' });
        const pinned = body.pinned !== false;
        return json(res, 200, await pinProject(target, pinned));
      }
      if (req.method === 'GET' && url.pathname === '/api/scheduled-tasks') {
        return json(res, 200, { tasks: await listScheduledAutomationTasks(workDir) });
      }
      if (req.method === 'POST' && url.pathname === '/api/scheduled-tasks') {
        const body = await readJson(req);
        const kind = body.kind === 'prompt' ? 'prompt' : body.kind === 'manager' ? 'manager' : 'workflow';
        const trigger = body.trigger === 'webhook' ? 'webhook' : 'schedule';
        let task: ScheduledAutomationTask;
        try {
          task = await saveScheduledAutomationTask({
            id: typeof body.id === 'string' ? body.id : undefined,
            name: typeof body.name === 'string' ? body.name : undefined,
            kind,
            trigger,
            cron: typeof body.cron === 'string' ? body.cron : undefined,
            enabled: body.enabled !== false,
            description: typeof body.description === 'string' ? body.description : undefined,
            workflowName: typeof body.workflowName === 'string' ? body.workflowName : undefined,
            workflowSource: body.workflowSource === 'agent' || body.workflowSource === 'script'
              ? body.workflowSource
              : undefined,
            input: typeof body.input === 'string' ? body.input : undefined,
            prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
            webhookId: typeof body.webhookId === 'string' ? body.webhookId : undefined,
            webhookSecret: typeof body.webhookSecret === 'string' ? body.webhookSecret : undefined,
            webhookFilter: typeof body.webhookFilter === 'string' ? body.webhookFilter : undefined,
            scope: typeof body.scope === 'string' ? body.scope : undefined,
          });
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
        invalidateHeavyState();
        return json(res, 200, { task, state: await state() });
      }
      if (req.method === 'POST' && url.pathname === '/api/scheduled-tasks/toggle') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) return json(res, 400, { error: 'Missing task id' });
        const task = await setScheduledAutomationEnabled(workDir, id, body.enabled === true);
        if (!task) return json(res, 404, { error: `scheduled task not found: ${id}` });
        await resyncAutomationScheduler();
        return json(res, 200, { task, state: await state() });
      }
      if (req.method === 'POST' && url.pathname === '/api/scheduled-tasks/delete') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) return json(res, 400, { error: 'Missing task id' });
        const deleted = await deleteScheduledAutomationTask(workDir, id);
        await resyncAutomationScheduler();
        return json(res, deleted ? 200 : 404, deleted ? { ok: true, state: await state() } : { error: `scheduled task not found: ${id}` });
      }
      if (req.method === 'POST' && url.pathname === '/api/scheduled-tasks/run') {
        if (runtimeMutationInProgress) {
          return json(res, 409, { error: 'Runtime configuration is being updated. Try again in a moment.' });
        }
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) return json(res, 400, { error: 'Missing task id' });
        const task = await getScheduledAutomationTask(workDir, id);
        if (!task) return json(res, 404, { error: `scheduled task not found: ${id}` });
        try {
          const events = await executeScheduledAutomationTask(task);
          return json(res, 200, { events, state: await state() });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      // Webhook trigger: POST /api/automation/webhook/<webhookId>
      // External services hit this URL to fire a webhook-triggered automation task.
      if (req.method === 'POST' && url.pathname.startsWith('/api/automation/webhook/')) {
        const webhookId = decodeURIComponent(url.pathname.slice('/api/automation/webhook/'.length)).trim();
        if (!webhookId) return json(res, 400, { error: 'Missing webhook id' });
        const tasks = await listScheduledAutomationTasks(workDir);
        const task = tasks.find(t => t.trigger === 'webhook' && t.webhookId === webhookId && t.enabled);
        if (!task) return json(res, 404, { error: `no enabled webhook task for id: ${webhookId}` });
        if (task.webhookSecret) {
          const provided = req.headers['x-webhook-secret'];
          if (provided !== task.webhookSecret) return json(res, 401, { error: 'Invalid webhook secret' });
        }
        if (task.webhookFilter) {
          const raw = await readRawBody(req);
          if (!raw.toLowerCase().includes(task.webhookFilter.toLowerCase())) {
            return json(res, 202, { ok: true, skipped: 'filter', reason: `body missing "${task.webhookFilter}"` });
          }
        }
        try {
          const events = await executeScheduledAutomationTask(task);
          return json(res, 200, { ok: true, task: { id: task.id, name: task.name }, events });
        } catch (error) {
          return json(res, runtimeMutationErrorStatus(error), runtimeMutationErrorBody(error));
        }
      }
      // --- Terminal engine (plan phase 3). Token-gated like every /api/ route. ---
      if (req.method === 'POST' && url.pathname === '/api/terminal/create') {
        if (!terminalCapable) return json(res, 404, { error: 'Terminal unavailable (node-pty not loadable)' });
        const body = await readJson(req);
        const settingsStore = await resolveHadamardSettingsStore({
          configPath: options.configPath,
          homeDir: currentHomeInput(),
        }).catch(() => undefined);
        const preferences = settingsStore
          ? readGuiPreferences(settingsStore.raw)
          : DEFAULT_GUI_PREFERENCES;
        const explicitCmd = typeof body.cmd === 'string' && body.cmd ? body.cmd : undefined;
        const explicitArgs = Array.isArray(body.args)
          ? body.args.filter((a): a is string => typeof a === 'string')
          : undefined;
        const id = terminalManager.create({
          cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : workDir,
          cmd: explicitCmd,
          args: explicitCmd ? explicitArgs : undefined,
          windowsShell: preferences.windowsTerminalShell,
          cols: typeof body.cols === 'number' ? body.cols : undefined,
          rows: typeof body.rows === 'number' ? body.rows : undefined,
          env: body.env && typeof body.env === 'object' && !Array.isArray(body.env)
            ? Object.fromEntries(Object.entries(body.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
            : undefined,
        });
        if (!id) return json(res, 500, { error: 'Failed to spawn terminal' });
        return json(res, 200, { id, ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/terminal/output') {
        const id = typeof url.searchParams.get('id') === 'string' ? url.searchParams.get('id')! : '';
        if (!terminalManager.info(id)) return json(res, 404, { error: 'Terminal not found' });
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        const send = (event: GuiRunEvent) => res.write(`${JSON.stringify(event)}\n`);
        const unsubscribe = terminalManager.subscribe(
          id,
          (data) => send({ type: 'output', data }),
          (code) => { send({ type: 'exit', code }); res.end(); },
        );
        req.on('close', () => { unsubscribe(); try { res.end(); } catch { /* already closed */ } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/terminal/input') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        const data = typeof body.data === 'string' ? body.data : '';
        return json(res, 200, { ok: terminalManager.write(id, data) });
      }
      if (req.method === 'POST' && url.pathname === '/api/terminal/resize') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        const ok = terminalManager.resize(id, Number(body.cols), Number(body.rows));
        return json(res, 200, { ok });
      }
      if (req.method === 'POST' && url.pathname === '/api/terminal/kill') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        return json(res, 200, { ok: terminalManager.kill(id) });
      }
      // Command history persistence (plan phase 5). One JSONL line per command,
      // under the project's session dir (~/.hadamard/projects/<hash>/terminals/).
      if (req.method === 'POST' && url.pathname === '/api/terminal/history') {
        const body = await readJson(req);
        const command = typeof body.command === 'string' ? body.command.trim() : '';
        if (!command || !sdk) return json(res, 200, { ok: false });
        try {
          const dir = path.join(sdk.config.sessionDirectory, 'terminals');
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, 'history.jsonl'), JSON.stringify({ ts: Math.floor(Date.now() / 1000), command }) + '\n', { flag: 'a' });
          return json(res, 200, { ok: true });
        } catch {
          return json(res, 200, { ok: false }); // never block a command over a history write
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/terminal/history') {
        if (!sdk) return json(res, 200, { lines: [] });
        try {
          const raw = await readFile(path.join(sdk.config.sessionDirectory, 'terminals', 'history.jsonl'), 'utf8').catch(() => '');
          const lines = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
            try { return JSON.parse(l); } catch { return null; }
          }).filter(Boolean) as Array<{ ts: number; command: string }>;
          return json(res, 200, { lines });
        } catch {
          return json(res, 200, { lines: [] });
        }
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  });

  const actualPort = await listenWithFallback(server, host, port);
  const url = `http://${urlHost}:${actualPort}/`;
  await resyncAutomationScheduler();
  process.stdout.write(`hadamard-gui listening on ${url}\n`);

  const close = async () => {
    let runtimeCloseError: unknown;
    for (const rec of runs.values()) rec.abort.abort();
    runs.clear();
    foregroundRunId = null;
    await automationScheduler.dispose();
    terminalManager.closeAll();
    await externalCliRuntimeManager.close().catch(() => undefined);
    if (sdk) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await sdk.close();
          runtimeCloseError = undefined;
          break;
        } catch (error) {
          runtimeCloseError = error;
          process.stderr.write(
            `[hadamard-gui] warning: SDK runtime cleanup attempt ${attempt}/2 failed: ` +
            `${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }
    await deviceLinkController.close();
    await deleteEmptyGuiSession(session);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
    await Promise.allSettled([...durableIssueResources.values()].flatMap(resource => [
      resource.coordinator.services.close(),
      resource.storage.close(),
    ]));
    durableIssueResources.clear();
    durableIssueResourcePending.clear();
    if (runtimeCloseError) throw runtimeCloseError;
  };
  return { url, token: authToken, close };
}

// First-run onboarding: guides the user through creating ~/.hadamard/settings.json
// when no credential is found (mirrors the TUI's onboardCredentials). Uses plain
// readline so it works in any terminal launching `hadamard-gui`.
async function onboardCredentials(opts: { configPath?: string; homeDir?: string }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));
  process.stdout.write('\n  Welcome to Hadamard! Let\'s set up your first connection.\n\n');
  const provider = ((await ask('  Provider (anthropic/openai) [anthropic]: ')).trim().toLowerCase() || 'anthropic') as 'anthropic' | 'openai';
  const apiKey = (await ask('  API key: ')).trim();
  const baseURL = (await ask('  Base URL [https://api.deepseek.com]: ')).trim() || 'https://api.deepseek.com';
  const model = (await ask('  Model [deepseek-chat]: ')).trim() || 'deepseek-chat';
  rl.close();
  if (!apiKey) {
    process.stdout.write('  No API key entered. Set HADAMARD_API_KEY and rerun, or open Settings → Models in the GUI.\n');
    return;
  }
  const store = await resolveHadamardSettingsStore({ configPath: opts.configPath, homeDir: opts.homeDir });
  const raw = isPlainRecord(store.raw) ? structuredClone(store.raw) : {};
  const env = isPlainRecord(raw.env) ? { ...raw.env } : {};
  env.HADAMARD_API_KEY = apiKey;
  env.HADAMARD_BASE_URL = baseURL;
  env.HADAMARD_MODEL = model;
  if (provider === 'openai') env.HADAMARD_PROVIDER = 'openai';
  raw.env = env;
  await persistHadamardSettingsStore(store.configPath, raw);
  await loadJsonConfigFile(store.configPath);
  process.stdout.write(`  Config saved to ${store.configPath}. Starting GUI…\n\n`);
}

export async function runHadamardGui(options: HadamardGuiOptions = {}): Promise<void> {
  let handle: HadamardGuiServer;
  try {
    handle = await startHadamardGuiServer(options);
  } catch (error) {
    if (/(No Hadamard credential|credential was found)/i.test((error as Error).message)) {
      await onboardCredentials(options);
      handle = await startHadamardGuiServer(options);
    } else {
      throw error;
    }
  }
  let shuttingDown = false;
  const closeFromSignal = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await close();
      process.exit(0);
    } catch (error) {
      process.stderr.write(
        `[hadamard-gui] ERROR: cleanup after ${signal} failed: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Check E2B/Playwright resources manually before assuming billing has stopped.\n',
      );
      process.exit(1);
    }
  };
  process.once('SIGINT', () => { void closeFromSignal('SIGINT'); });
  process.once('SIGTERM', () => { void closeFromSignal('SIGTERM'); });
  async function close(): Promise<void> {
    await handle.close();
  }
}

const guiSurfacePipelines = new WeakMap<
  (event: GuiRunEvent) => void,
  LegacySurfaceEventPipeline
>();

function forwardAgentEvent(event: AgentEvent, send: (event: GuiRunEvent) => void, runId?: string): void {
  let pipeline = guiSurfacePipelines.get(send);
  if (!pipeline) {
    pipeline = new LegacySurfaceEventPipeline();
    guiSurfacePipelines.set(send, pipeline);
  }
  for (const surfaceEvent of pipeline.projectFor(event, 'gui')) {
    forwardSurfaceEvent(surfaceEvent, send, runId);
  }
}

function forwardSurfaceEvent(
  event: SurfaceSemanticEvent,
  send: (event: GuiRunEvent) => void,
  runId?: string,
): void {
  const data = event.data;
  switch (event.type) {
    case 'run.started':
      send({
        type: 'run.started',
        runId,
        model: typeof data.model === 'string'
          ? data.model
          : isPlainRecord(data.model) && typeof data.model.model === 'string'
            ? data.model.model
            : undefined,
      });
      return;
    case 'request.started':
      send({
        type: 'status',
        message: `request ${Number.isSafeInteger(data.iteration) ? data.iteration : 0}${data.requestTokenEstimate ? ` · ~${data.requestTokenEstimate} tokens` : ''}`,
      });
      return;
    case 'text.delta':
      if (typeof data.delta === 'string' && data.delta) send({ type: 'delta', text: data.delta });
      return;
    case 'reasoning.delta':
      if (typeof data.delta === 'string' && data.delta) {
        send({ type: 'thinking.delta', text: data.delta, snapshot: data.snapshot });
      }
      return;
    case 'tool.input.delta':
      send({
        type: 'tool.input.delta',
        id: data.callId,
        name: data.name,
        delta: data.delta,
        snapshot: data.snapshot,
      });
      return;
    case 'tool.started':
      send({
        type: 'tool.call',
        id: data.callId,
        runId: event.runId,
        iteration: data.iteration,
        name: data.publicName ?? data.name,
        provider: data.provider,
        input: data.input,
        startedAt: data.startedAt,
      });
      return;
    case 'tool.permission':
      if (isPlainRecord(data.decision)) {
        send({
          type: 'tool.permission',
          toolName: data.decision.publicName,
          behavior: data.decision.behavior,
          reason: data.decision.reason,
        });
      }
      return;
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.rejected':
      send({
        type: 'tool.result',
        id: data.callId,
        runId: event.runId,
        iteration: data.iteration,
        name: data.publicName ?? data.name,
        ok: data.isError !== true,
        text: data.outputText,
        durationMs: data.durationMs,
        completedAt: data.completedAt,
      });
      return;
    case 'tool.progress':
      send({
        type: 'tool.progress',
        id: data.callId,
        runId: event.runId,
        iteration: data.iteration,
        data: data.progress,
      });
      return;
    case 'compaction.completed': {
      const result = isPlainRecord(data.result) ? data.result : undefined;
      if (data.scope === 'session') {
        send({ type: 'notice', message: `session compacted: ${result?.messagesRemoved ?? '?'} messages summarized` });
      } else {
        send({ type: 'notice', message: `conversation compacted: ${data.messagesSummarized ?? '?'} messages summarized` });
      }
      return;
    }
    case 'model.fallback':
      send({ type: 'notice', message: `model fallback: ${data.fromModel} -> ${data.toModel}` });
      return;
    case 'interruption.requested':
      if (
        data.scope === 'request'
        && (event.sourceType === 'request.interrupted' || event.sourceType === 'model.interrupted')
      ) {
        send({
          type: 'reconnecting',
          message: 'Model connection interrupted · retrying automatically',
          retry: data.retry,
          maxRetries: data.maxRetries,
        });
      } else {
        send({ type: 'notice', message: 'request interrupted' });
      }
      return;
    case 'error':
      send({ type: 'error', message: typeof data.message === 'string' ? data.message : 'run failed' });
      return;
    default:
      return;
  }
}

/**
 * Maps TeamEvents to `team.*` GuiRunEvents (plan phase 4). A sibling of
 * forwardAgentEvent — it does not touch the 12 chat-run cases. Each event
 * carries runId so the client (and the Monitor pane) can address the team run.
 * Also mirrors member/round state onto the run descriptor for the Monitor cards.
 */
function forwardTeamEvent(event: TeamEvent, runId: string, send: (event: GuiRunEvent) => void, desc?: GuiRunDescriptor): void {
  switch (event.type) {
    case 'team.started':
      send({ type: 'team.started', runId, mode: event.mode, members: event.members });
      if (desc) desc.team = {
        mode: event.mode, round: 0,
        members: event.members.map(m => ({ id: m.id, model: m.model, status: 'pending', role: m.role })),
      };
      return;
    case 'team.member.started':
      send({ type: 'team.member.started', runId, id: event.id, model: event.model, role: event.role, round: event.round });
      upsertTeamMember(desc, event.id, { model: event.model, status: 'running', role: event.role });
      if (desc?.team) desc.team.round = event.round;
      return;
    case 'team.member.tool':
      send({ type: 'team.member.tool', runId, id: event.id, model: event.model, round: event.round, tool: event.tool });
      upsertTeamMember(desc, event.id, { status: 'running', currentTool: event.tool });
      if (desc) desc.currentTool = `${event.id}: ${event.tool}`;
      return;
    case 'team.member.completed':
      send({ type: 'team.member.completed', runId, id: event.id, model: event.model, role: event.role, round: event.round, ok: event.ok, toolCalls: event.toolCalls, durationMs: event.durationMs, error: event.error });
      upsertTeamMember(desc, event.id, { status: event.ok ? 'done' : 'error', error: event.error, toolCalls: event.toolCalls, durationMs: event.durationMs });
      if (desc) desc.toolCalls += event.toolCalls;
      return;
    case 'team.round.completed':
      send({ type: 'team.round.completed', runId, round: event.round, reports: event.reports });
      if (desc?.team) desc.team.round = event.round;
      return;
    case 'team.synthesis':
      send({ type: 'team.synthesis', runId, round: event.round, decision: event.decision });
      return;
    case 'team.edge.triggered':
      send({ type: 'team.edge.triggered', runId, from: event.from, to: event.to, trigger: event.trigger, channel: event.channel });
      if (desc?.team) {
        if (!desc.team.edges) desc.team.edges = [];
        desc.team.edges.push({ from: event.from, to: event.to, trigger: event.trigger, channel: event.channel });
      }
      return;
    case 'team.returned':
      send({ type: 'team.returned', runId, nodeId: event.nodeId, returnMode: event.returnMode, returnValue: event.returnValue });
      return;
    case 'team.completed':
      send({ type: 'team.completed', runId, mode: event.mode, rounds: event.rounds, incompleteReason: event.incompleteReason });
      if (desc?.team) desc.team.incompleteReason = event.incompleteReason;
      return;
    default:
      return;
  }
}

function upsertTeamMember(desc: GuiRunDescriptor | undefined, id: string, patch: { model?: string; status?: string; role?: string; currentTool?: string; error?: string; toolCalls?: number; durationMs?: number }): void {
  if (!desc?.team) return;
  let m = desc.team.members.find(x => x.id === id);
  if (!m) {
    m = { id, model: patch.model ?? '', status: patch.status ?? 'pending' };
    desc.team.members.push(m);
  }
  if (patch.model !== undefined) m.model = patch.model;
  if (patch.status !== undefined) m.status = patch.status;
  if (patch.role !== undefined) m.role = patch.role;
  if (patch.currentTool !== undefined) m.currentTool = patch.currentTool;
  if (patch.error !== undefined) m.error = patch.error;
  if (patch.toolCalls !== undefined) m.toolCalls = patch.toolCalls;
  if (patch.durationMs !== undefined) m.durationMs = patch.durationMs;
}

export {
  createHadamardGuiClientScript,
  createHadamardGuiHtml,
  createHadamardGuiStyles,
} from './hadamardGuiAssets.js';

export function parseHadamardGuiArgs(argv: string[]): HadamardGuiOptions & { help?: boolean; version?: boolean } {
  const result: HadamardGuiOptions & { help?: boolean; version?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--version' || arg === '-v') result.version = true;
    else if (arg === '--host' && argv[index + 1]) result.host = argv[++index];
    else if (arg === '--port' && argv[index + 1]) result.port = Number(argv[++index]);
    else if (arg === '--config' && argv[index + 1]) result.configPath = argv[++index];
    else if (arg === '--permission-mode' && argv[index + 1]) {
      const mode = argv[++index]!;
      if (!PERMISSION_MODES.has(mode as HadamardPermissionMode)) throw new Error(`Unknown permission mode: ${mode}`);
      result.permissionMode = mode as HadamardPermissionMode;
    } else if (arg === '--model' && argv[index + 1]) result.model = argv[++index];
    else if (arg === '--resume' && argv[index + 1]) result.resumeSessionId = argv[++index];
    else if (arg === '--continue') result.continueMostRecent = true;
    else if (!arg.startsWith('-') && !result.workDir) result.workDir = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseHadamardGuiArgs(process.argv.slice(2));
  if (args.version) {
    process.stdout.write(`${readPackageVersion(import.meta.url)}\n`);
    process.exit(0);
  }
  if (args.help) {
    process.stdout.write([
      'hadamard-gui - Clean SDK local GUI',
      '',
      'Usage: hadamard-gui [work-dir] [options]',
      '',
      'Options:',
      '  --host <host>              Loopback host to bind (default: 127.0.0.1)',
      '  --port <port>              Port to bind (default: 4174)',
      '  --config <path>            Load a specific Hadamard settings JSON file',
      '  --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions (default)',
      '  --model <model>            Override the configured model',
      '  --resume <session-id>      Resume a stored Clean SDK session',
      '  --continue                 Resume the most recent stored session',
      '  -v, --version              Show package version',
      '  -h, --help                 Show this help',
      '',
    ].join('\n'));
    process.exit(0);
  }
  runHadamardGui(args).catch((error) => {
    process.stderr.write(`Fatal: ${(error as Error).stack ?? (error as Error).message}\n`);
    process.exit(1);
  });
}
