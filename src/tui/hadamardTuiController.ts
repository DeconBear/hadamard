/**
 * Hadamard TUI — a full-screen-feel terminal UI for the Clean SDK, modeled on
 * Claude Code's REPL: permanent transcript in native scrollback, a redrawable
 * bottom region with a Claude-style prompt bar, slash-command menu, streaming
 * output, permission dialogs, and mid-run steering. Dependency-free ANSI
 * rendering (no React/Ink).
 */
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';

import {
  createHadamardCoreTools,
  createAgentSdk,
  createHadamardBridgeSdk,
  detectBridgeProviders,
  loadDefaultHadamardSettings,
  loadJsonConfigFile,
  loadTeamDefinition,
  instantiateTeamDefinition,
  askTeamDefinition,
  createTeamTool,
  readTeamPreferences,
  createManagerTools,
  createAssistantTeamTools,
  buildAssistantTeamSystemPrompt,
  TeamProposalStore,
  SessionCatalog,
  discoverProjectSessions,
  getHadamardProjectSessionDirectory,
  createAssistantGlobalTools,
  buildAssistantGlobalSystemPrompt,
  readAssistantConfig,
  writeAssistantConfig,
  buildManagerSystemPrompt,
  buildUpdateDesignPrompt,
  formatManagerUpdatePreview,
  resolveGitHubDigestForUpdate,
  readManagerConfig,
  writeManagerConfig,
  readProjectPlanFile,
  readDesignFile,
  managerDesignPath,
  createProjectIssue,
  executeProjectIssue,
  isIssueStorageMode,
  listProjectIssues,
  listScheduledAutomationTasks,
  resolveHadamardHome,
  externalSkillPreferencesToRuntimeOptions,
  readHadamardExternalSkillPreferences,
  patchManagedPluginSettings,
  readManagedPluginCatalog,
  listRouterProfiles,
  loadRouterProfile,
  resolveRoutedRun,
  transitionProjectIssue,
} from '../index.js';
import { AppServer } from '../app-server/appServer.js';
import { DeviceLinkCommandService } from '../device-link/commandService.js';
import { DeviceLinkService } from '../device-link/deviceLinkService.js';
import { adaptBridgeRun } from '../parity/bridgeEventAdapter.js';
import { ExternalCliRuntimeManager } from '../parity/externalCliRuntimeManager.js';
import {
  externalCliSessionMatchesConfig,
  listExternalCliSessions,
  readExternalCliSession,
  type ExternalCliSessionSummary,
} from '../parity/externalCliSessions.js';
import { parseCrushSessionReferenceDetails } from '../parity/crushSessionHistory.js';
import { readProjectMeta } from '../gui/projectMeta.js';
import { findWorkspaceProject, readWorkspaceRegistry, workspaceWorkPaths } from '../gui/workspaceRegistry.js';
import { DesignWorkspaceService } from '../design/designWorkspaceService.js';
import { ProjectRuleCatalogService } from '../rules/projectRuleCatalog.js';
import {
  persistHadamardSettingsStore,
  resolveHadamardSettingsStore,
} from '../config/hadamardSettingsStore.js';
import { consumeFullAccessWarning } from '../config/fullAccessWarning.js';
import {
  readProjectSettings,
  writeProjectSettings,
  type ProjectInstructionMode,
} from '../config/projectSettings.js';
import { createPreToolUseHookClassifier, readPreToolUseHooks, readPostToolUseHooks, runPostToolUseHooks, readSessionStartHooks, runSessionStartHooks } from '../hooks/userHooks.js';
import { parseTypedHooks } from '../hooks/hookConfig.js';
import type {
  HadamardEffort,
  HadamardRunEffort,
  HadamardCanUseTool,
  HadamardPermissionMode,
  HadamardToolApprover,
  AgentEvent,
  AgentRunResult,
  AgentToolDefinition,
  TeamDefinition,
  RouterProfile,
} from '../types.js';
import { isRecord } from '../runtime/helpers.js';
import { getLoadedJsonConfig } from '../config/loadJsonConfigFile.js';
import {
  agentModeFromChecks,
  agentModeToChecks,
  readSessionAgentMode,
  sessionAgentModePatch,
} from '../runtime/agentModeService.js';
import { readSessionToolPresentation, sessionToolPresentationPatch } from '../codeact/presentationTypes.js';
import {
  buildModelConfigurationCatalog,
  findModelConfiguration,
  isModelCredentialConfigured,
  resolveHadamardConfigurationModel,
} from '../config/modelConfigurationCatalog.js';
import {
  formatContextWindowTokens,
  HADAMARD_CONTEXT_WINDOW_METADATA_KEY,
  isSelectableContextWindowTokens,
  modelContextWindowLimit,
  modelContextWindowOptions,
  parseContextWindowTokens,
  readSessionContextWindow,
  resolveModelContextEntry,
} from '../config/modelContextWindow.js';
import {
  findBridgeConfig,
  maskApiKey,
  readBridgeConfigs,
  addBridgeConfig,
  removeBridgeConfig,
  isManagedExternalCliRuntime,
  type PersistedBridgeConfig,
  type InProcessProvider,
  type ManagedExternalCliRuntime,
} from '../parity/bridgeConfigs.js';
import { buildRouteModelApi, type RoutedModel } from '../router/modelRouter.js';
import { addMcpServer, readMcpServerConfig, removeMcpServer } from '../mcp/mcpServerConfig.js';
import type { ContentBlockParam } from '../provider/types.js';
import { isReadOnlyBashCommand } from '../runtime/bashClassification.js';
import { estimateCost } from '../team/pricing.js';
import { planFilePath, readPlanFile } from '../tools/planMode/PlanModeTools.js';
import { loadProjectContext } from '../memory/projectContext.js';
import {
  hashProjectInstructionContent,
  parseProjectInstructionState,
} from '../memory/projectInstructionContext.js';
import { getPersistedHadamardCompactState } from '../runtime/hadamardCompact.js';
import { applyResolvedToolDescriptions } from '../runtime/agentClientRunHelpers.js';
import {
  LegacySurfaceEventPipeline,
  type SurfaceSemanticEvent,
} from '../surfaces/index.js';
import {
  HADAMARD_INTERACTIVE_COMMANDS,
  SUBCOMMAND_DESCRIPTIONS,
  canRunInteractiveCommand,
  interactiveCommandRunPolicy,
  interactiveCommandUsage,
  selectInteractiveCommand,
} from '../ui/commandSurface.js';
import {
  createAgentExecutionProjectView,
  createAgentExecutionRootView,
  formatAgentExecutionTreeLines,
  type AgentExecutionNodeView,
  type AgentExecutionRootView,
} from '../ui/agentExecutionView.js';
import { A, truncateToWidth, wrapToWidth } from './ansi.js';
import { InputEditor } from './editor.js';
import { discoverHadamardPlugins } from './pluginCatalog.js';
import { TuiScreen } from './screen.js';
import { ReasoningDisplayState } from './reasoningDisplay.js';
import { ToolActivityDisplayState } from './toolActivityDisplay.js';
import {
  recallLatestFollowUp,
  restoreAbandonedFollowUp,
  submitActiveInput,
  type ActiveInputMode,
} from './pendingInput.js';
import type { TuiSelectionItem } from './selection.js';
import {
  StreamFlusher,
  formatCompactNotice,
  formatDivider,
  formatEditCall,
  formatErrorLine,
  formatInfoLine,
  formatQueuedPrompt,
  formatToolCall,
  formatToolResult,
  formatUserPrompt,
} from './transcript.js';
import {
  activeAtToken,
  filterSlashCommands,
  isTuiChatSession,
  renderRichText,
} from './tuiTextPresenter.js';
import { buildTuiSystemPrompt } from './tuiSystemPrompt.js';
import { TuiInputController } from './tuiInputController.js';
import { runTuiMemoryCommand } from './tuiMemoryCommandHandler.js';
import { runTuiConfigurationCommand } from './tuiConfigurationCommandHandler.js';
import { runTuiBasicCommand } from './tuiBasicCommandHandler.js';
import { runTuiPlanCommand } from './tuiPlanCommandHandler.js';
import { runTuiSessionCommand } from './tuiSessionCommandHandler.js';
import { runTuiWorkflowCommand } from './tuiWorkflowCommandHandler.js';
import { runTuiWorktreeCommand } from './tuiWorktreeCommandHandler.js';
import { runTuiBridgeCommand } from './tuiBridgeCommandHandler.js';
import { runTuiTeamCommand } from './tuiTeamCommandHandler.js';
import { runTuiIssueCommand } from './tuiIssueCommandHandler.js';
import { runTuiAssistantCommand } from './tuiAssistantCommandHandler.js';
import { runTuiManagerCommand } from './tuiManagerCommandHandler.js';
import { runTuiWorkspaceCommand } from './tuiWorkspaceCommandHandler.js';
import { runTuiContextCommand } from './tuiContextCommandHandler.js';
import { runTuiCatalogCommand } from './tuiCatalogCommandHandler.js';
import { runTuiDeviceLinkCommand } from './tuiDeviceLinkCommandHandler.js';
import {
  buildTuiPermissionDialog,
  buildTuiPromptBar,
  buildTuiSelectionDialog,
  buildTuiTextInputDialog,
  tuiPromptCursorPosition,
  tuiSelectionDialogCursorPosition,
  tuiTextInputDialogCursorPosition,
} from './tuiFramePresenter.js';
import { onboardTuiCredentials } from './tuiOnboarding.js';
import { formatWelcomePage } from './tuiWelcomeBanner.js';
import {
  nextTuiContextTokenEstimate,
  estimateTuiContextTokenBreakdown,
} from './tuiContextUsage.js';
import type { RequestTokenEstimateBreakdown } from '../runtime/requestTokenEstimate.js';
import { formatSessionHistory } from './tuiSessionHistory.js';
import {
  isEmptyUserSessionSummary,
  isEmptyUserStoredSession,
} from '../storage/sessionVisibility.js';
import {
  buildTuiResumeCandidates,
  resolveTuiResumeReference,
  type TuiResumeCandidate,
} from './tuiSessionResume.js';
import {
  closeManagedPluginsForExit,
  tuiErrorMessage as errorMessage,
} from './tuiRuntimeLifecycle.js';
import type {
  HadamardTuiOptions,
  PermissionDialogState,
  SelectionDialogState,
  TextInputDialogState,
  TuiKey as Key,
} from './tuiTypes.js';
export {
  activeAtToken,
  filterSlashCommands,
  isTuiChatSession,
  renderRichText,
} from './tuiTextPresenter.js';
export type { HadamardTuiOptions } from './tuiTypes.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DYNAMIC_FRAME_MS = 33;
const MENU_MAX_ROWS = 12;
const SESSION_EFFORT_KEY = '__hadamardEffort';
const EFFORT_LEVELS: readonly HadamardEffort[] = ['low', 'medium', 'high', 'max'];

/** Core tools that mutate state and require approval in 'default' mode. */
const MUTATING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit']);
export const TUI_SLASH_COMMANDS = HADAMARD_INTERACTIVE_COMMANDS;

/** Mask an API key for display: show first 4 + last 4, hide the middle. */
function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Render free-form text for the scrollback: width-aware word wrapping with
 * markdown-lite heading highlighting. Used for workflow/team results and the
 * expert-panel member reports so long output reads cleanly instead of dumping
 * raw lines. Optionally caps very long output with a "… (N more lines)" note.
 */
// Apply inline markdown formatting to a single unwrapped line segment:
// `code` → dim, **bold** → bold, *italic* → italic. Applied after wrapping
// so ANSI codes never split mid-segment.
// First-run onboarding: guides the user through creating the Hadamard settings file
// when no credential is found. Uses plain readline (no TTY required beyond stdin).
export async function runHadamardTui(options: HadamardTuiOptions = {}): Promise<void> {
  let workDir = path.resolve(options.workDir ?? process.cwd());
  const permissionMode: HadamardPermissionMode = options.permissionMode ?? 'bypassPermissions';

  try {
    if (options.configPath) {
      await loadJsonConfigFile(options.configPath);
    } else {
      await loadDefaultHadamardSettings();
    }
  } catch {
    // Missing local config is fine; env vars may carry credentials.
  }

  const hadamardHomeDir = resolveHadamardHome();
  const [workspaceRegistry, loadedProjectSettings] = await Promise.all([
    readWorkspaceRegistry(hadamardHomeDir),
    readProjectSettings(workDir, hadamardHomeDir),
  ]);
  let projectSettings = loadedProjectSettings;
  let registeredProject = findWorkspaceProject(workspaceRegistry, workDir);
  let projectPrimaryPath = registeredProject?.path ?? workDir;
  let projectWorkPaths = registeredProject ? workspaceWorkPaths(registeredProject) : [workDir];
  let activeSessionDirectory = getHadamardProjectSessionDirectory(
    projectPrimaryPath,
    hadamardHomeDir,
  );
  let systemPrompt = buildTuiSystemPrompt(workDir, projectSettings, hadamardHomeDir, projectWorkPaths);

  let applyPlanPermission: (() => Promise<void>) | null = null;
  let managedPluginSettings: Record<string, unknown> = {};
  let tools: AgentToolDefinition[] = [];
  const rebuildInteractiveTools = async (): Promise<void> => {
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
    });
    managedPluginSettings = store.raw;
    tools = [
      ...createHadamardCoreTools({
        cwd: workDir,
        onPlanModeChange: async (mode) => {
          if (mode === 'plan') await applyPlanPermission?.();
        },
      }),
    ];
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    tools = [...byName.values()];
  };
  const createCleanSdk = async () => {
    const [, externalSkillPreferences] = await Promise.all([
      rebuildInteractiveTools(),
      readHadamardExternalSkillPreferences({
        hadamardHomeDir,
        workDir,
      }),
    ]);
    return createAgentSdk({
      workDir,
      sessionDirectory: activeSessionDirectory,
      tools,
      managedPlugins: managedPluginSettings,
      permissionMode,
      externalSkills: externalSkillPreferencesToRuntimeOptions(externalSkillPreferences),
      // Load user-managed stdio MCP servers from ~/.hadamard/mcp.json (gap #10).
      mcpServers: readMcpServerConfig().servers.map(s => (
        s.command
          ? { kind: 'stdio' as const, name: s.name, command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}), ...(s.cwd ? { cwd: s.cwd } : {}) }
          : { kind: 'streamable_http' as const, name: s.name, url: s.url!, ...(s.headers ? { headers: s.headers } : {}) }
      )),
      ...(options.model ? { model: options.model } : {}),
    });
  };
  let sdk: Awaited<ReturnType<typeof createAgentSdk>>;
  let toolMetadata: Awaited<ReturnType<typeof sdk.listToolMetadata>> = [];
  let toolMetadataReady: Promise<void> = Promise.resolve();
  while (true) {
    try {
      sdk = await createCleanSdk();
      toolMetadataReady = sdk.listToolMetadata().then(
        list => { toolMetadata = list; },
        () => undefined,
      );
      break;
    } catch (error) {
      if (error instanceof Error && error.message.includes('No Hadamard credential')) {
        // First-run onboarding: guide the user through creating ~/.hadamard/settings.json.
        await onboardTuiCredentials(options.configPath);
        // onboardTuiCredentials persists, reloads, and validates the exact
        // settings path before returning. Retry with the fresh config.
        continue;
      }
      throw error;
    }
  }

  const startupSessions = await sdk.sessions.list();
  const requestedResume = options.resumeSessionId
    ? startupSessions.find(item => item.id === options.resumeSessionId)
    : undefined;
  if (requestedResume && isEmptyUserSessionSummary(requestedResume)) {
    await sdk.sessions.delete(requestedResume.id).catch(() => undefined);
    await sdk.close().catch(() => undefined);
    throw new Error(`Session '${requestedResume.id}' is empty and cannot be resumed.`);
  }
  let session = options.resumeSessionId
    ? await sdk.resumeSession(options.resumeSessionId, {
        model: options.model,
        permissionMode: options.permissionMode,
      })
    : options.continueMostRecent
      ? await sdk.sessions.continueMostRecent({
          model: options.model,
          permissionMode: options.permissionMode,
        })
      : await sdk.createSession({
          title: path.basename(workDir),
          model: options.model,
          permissionMode,
        });
  let deviceLinkService: DeviceLinkService | null = null;
  async function getDeviceLinkService(): Promise<DeviceLinkService> {
    deviceLinkService ??= await DeviceLinkService.open({
      rootDirectory: path.join(sdk.config.homeDir, 'device-link'),
      appServer: new AppServer(sdk),
      sdk,
      workspaceRoot: sdk.config.workDir,
    });
    return deviceLinkService;
  }
  // Run SessionStart hooks (fire-and-forget, from settings.json hooks.SessionStart[]).
  runSessionStartHooks(() => readSessionStartHooks(getLoadedJsonConfig()?.raw), sdk.config.workDir);

  const screen = new TuiScreen(process.stdout);
  const editor = new InputEditor();
  const flusher = new StreamFlusher(() => screen.width);

  let running = false;
  let queuedConfirmActive = false;
  let commandBusy = false;
  let shuttingDown = false;
  /** Follow-up pulled out of the queue into the editor; restored if abandoned. */
  let recalledFollowUp: string | null = null;
  // Active team tool the main agent may call (toggled via /team). null = no team.
  // The tool is only injected into runs when preferences.team.autoInvoke is on;
  // otherwise attach is a selection and /team ask stays the manual path.
  const teamPrefs = readTeamPreferences(getLoadedJsonConfig()?.raw);
  let activeTeamTool: AgentToolDefinition | null = null;
  let activeTeamName: string | null = null;
  let lastTeamRunSummary: string | null = null;
  const attachTeamByName = (name: string): TeamDefinition | null => {
    const loaded = loadTeamDefinition(name, sdk.config.workDir);
    if (!loaded) return null;
    const definition = instantiateTeamDefinition(loaded.definition, session.model);
    activeTeamTool = createTeamTool(definition);
    activeTeamName = definition.name;
    return definition;
  };
  if (teamPrefs.defaultAttached) {
    // Unresolvable default names are ignored; /team status surfaces the hint.
    try { attachTeamByName(teamPrefs.defaultAttached); } catch { /* ignore */ }
  }
  // /model router: when set, each user turn is classified and routed to a model.
  let activeRouter: RouterProfile | null = null;
  let routedModelLabel: string | null = null;
  // A named config can use either the in-process API bridge or a real external
  // CLI. External clients/sessions are isolated by Hadamard session, config, and
  // cwd so switching chats cannot leak native runtime context.
  let bridgeMode = false;
  let activeBridgeConfig: PersistedBridgeConfig | null = null;
  // Pre-built {model, modelApi} for the active config. Built once at activation;
  // stale after disable (cleared). Per-run injection reuses the /model router's
  // proven mechanism (session.stream({model, modelApi})).
  let activeBridgeModelApi: RoutedModel | null = null;
  type ExternalBridgeClient = Awaited<ReturnType<typeof createHadamardBridgeSdk>>;
  type ExternalBridgeSession = Awaited<ReturnType<ExternalBridgeClient['createSession']>>;
  interface ExternalBridgeRuntime {
    client: ExternalBridgeClient;
    session: ExternalBridgeSession;
    fingerprint: string;
  }
  type SupportedExternalCliConfig = PersistedBridgeConfig & {
    execution: 'cli';
    runtime: ManagedExternalCliRuntime;
  };
  type TuiAgentSession = typeof session;

  async function deleteEmptyTuiSession(target: TuiAgentSession): Promise<void> {
    if (isEmptyUserStoredSession(target.snapshot())) {
      await target.delete().catch(() => undefined);
    }
  }
  interface ExternalSessionBinding {
    runtime: ManagedExternalCliRuntime;
    configName: string;
    cwd: string;
    nativeSessionId: string;
    updatedAt: string;
  }
  const RUNTIME_METADATA_KEY = '__hadamardRuntime';
  const CONFIG_NAME_METADATA_KEY = '__hadamardConfigName';
  const RUNTIME_MODEL_METADATA_KEY = '__hadamardRuntimeModel';
  const EXTERNAL_SESSIONS_METADATA_KEY = '__hadamardExternalSessions';
  // Display label for the active runtime model.
  let bridgeModelLabel: string | null = null;
  const externalBridgeRuntimes = new Map<string, ExternalBridgeRuntime>();
  const externalCliRuntimeManager = new ExternalCliRuntimeManager();
  const externalCliRunLabels = new Map<string, {
    configName: string;
    runtime: ManagedExternalCliRuntime;
  }>();
  function sameWorkspace(left: string, right: string): boolean {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  function externalSessionBindingKey(
    config: SupportedExternalCliConfig,
    targetWorkDir = sdk.config.workDir,
  ): string {
    return createHash('sha256')
      .update(config.runtime + '\u0000' + config.name + '\u0000' + path.resolve(targetWorkDir))
      .digest('hex')
      .slice(0, 24);
  }
  function externalBridgeRuntimeKey(
    config: SupportedExternalCliConfig,
    targetSession: TuiAgentSession = session,
    targetWorkDir = sdk.config.workDir,
  ): string {
    return targetSession.id + '\u0000' + externalSessionBindingKey(config, targetWorkDir);
  }
  function externalSessionBindings(
    targetSession: TuiAgentSession = session,
  ): Record<string, ExternalSessionBinding> {
    const raw = targetSession.metadata[EXTERNAL_SESSIONS_METADATA_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const bindings: Record<string, ExternalSessionBinding> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (
        !isManagedExternalCliRuntime(record.runtime as import('../parity/bridgeConfigs.js').BridgeRuntime)
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
    targetSession: TuiAgentSession = session,
    targetWorkDir = sdk.config.workDir,
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
    targetSession: TuiAgentSession = session,
    targetWorkDir = sdk.config.workDir,
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
    await targetSession.mergeMetadata({ [EXTERNAL_SESSIONS_METADATA_KEY]: bindings });
  }
  async function persistSessionRuntimeMetadata(
    targetSession: TuiAgentSession = session,
    config: PersistedBridgeConfig | null = activeBridgeConfig,
    modelLabel: string | null = bridgeModelLabel,
  ): Promise<void> {
    await targetSession.mergeMetadata({
      [RUNTIME_METADATA_KEY]: config?.runtime ?? 'hadamard',
      [CONFIG_NAME_METADATA_KEY]: config?.name ?? null,
      [RUNTIME_MODEL_METADATA_KEY]: config?.model ?? modelLabel ?? null,
    });
  }
  async function configureContextWindow(value?: string): Promise<void> {
    const model = bridgeModelLabel ?? activeBridgeConfig?.model ?? session.model;
    const entry = resolveModelContextEntry(model, readBridgeConfigs().configs, activeBridgeConfig) ?? {
      name: model,
      contextWindowTokens: sdk.config.compact.contextWindowTokens,
      maxContextWindowTokens: sdk.config.compact.maxContextWindowTokens,
    };
    const limit = modelContextWindowLimit(entry);
    const available = modelContextWindowOptions(entry);
    let selected = value ? parseContextWindowTokens(value) : undefined;
    if (value && !isSelectableContextWindowTokens(selected)) {
      appendStatic([...formatErrorLine(`Invalid context window: ${value}. Choose a value up to 2M.`), '']);
      return;
    }
    if (!value) {
      const choice = await selectItem({
        title: 'Context window',
        subtitle: limit
          ? `${model} · declared ${formatContextWindowTokens(limit)} — selecting above it fails at the provider`
          : `${model} · model limit not declared`,
        searchable: false,
        items: available.map(tokens => ({
          id: String(tokens),
          label: formatContextWindowTokens(tokens),
          description: tokens === entry?.contextWindowTokens
            ? 'model default'
            : limit && tokens > limit
              ? `over declared ${formatContextWindowTokens(limit)} — may fail`
              : 'session limit',
        })),
      });
      if (!choice) return;
      selected = Number(choice);
    }
    await session.mergeMetadata({ [HADAMARD_CONTEXT_WINDOW_METADATA_KEY]: selected });
    const overLimit = limit !== undefined && selected !== undefined && selected > limit;
    appendStatic([
      ...formatInfoLine(`context window: ${formatContextWindowTokens(selected!)}`),
      ...(overLimit
        ? formatInfoLine(`Warning: ${formatContextWindowTokens(selected!)} exceeds the model's declared ${formatContextWindowTokens(limit!)}. If requests fail with a context-length error, lower this with /model context.`)
        : []),
      '',
    ]);
  }
  function clearBridgeSelection(): void {
    bridgeMode = false;
    activeBridgeConfig = null;
    activeBridgeModelApi = null;
    bridgeModelLabel = null;
  }
  async function restoreSessionRuntimeSelection(): Promise<void> {
    const configName = session.metadata[CONFIG_NAME_METADATA_KEY];
    if (typeof configName !== 'string' || !configName.trim()) {
      clearBridgeSelection();
      return;
    }
    const stored = findBridgeConfig(configName);
    if (!stored) {
      clearBridgeSelection();
      return;
    }
    const model = session.metadata[RUNTIME_MODEL_METADATA_KEY];
    const config = typeof model === 'string' && model.trim()
      ? { ...stored, model: model.trim() }
      : stored;
    if (!await activateBridgeConfig(config)) clearBridgeSelection();
  }
  function activeExternalBridgeRuntime(): ExternalBridgeRuntime | null {
    if (
      !bridgeMode
      || activeBridgeConfig?.execution !== 'cli'
      || !isManagedExternalCliRuntime(activeBridgeConfig.runtime)
    ) return null;
    return externalBridgeRuntimes.get(
      externalBridgeRuntimeKey(activeBridgeConfig as SupportedExternalCliConfig),
    ) ?? null;
  }
  function externalBridgeFingerprint(config: PersistedBridgeConfig): string {
    return JSON.stringify([
      config.runtime,
      config.authSource ?? 'native',
      config.authSource === 'apiKey' ? config.apiKey ?? '' : '',
      config.authSource === 'apiKey' ? config.baseURL ?? '' : '',
      config.authSource === 'apiKey' ? config.credentialProvider ?? '' : '',
      config.trustProjectResources === true,
    ]);
  }
  function externalCliConfigId(config: SupportedExternalCliConfig): string {
    const digest = createHash('sha256')
      .update(externalBridgeFingerprint(config))
      .digest('hex')
      .slice(0, 12);
    return `${config.name}:${digest}`;
  }
  function findConflictingExternalCliRun(
    config: SupportedExternalCliConfig,
    targetSession: TuiAgentSession = session,
    targetWorkDir = sdk.config.workDir,
  ) {
    const configId = externalCliConfigId(config);
    return externalCliRuntimeManager.list().find(run => {
      if (
        run.hadamardSessionId !== targetSession.id
        || !sameWorkspace(run.cwd, targetWorkDir)
        || (run.status !== 'queued' && run.status !== 'running')
      ) return false;
      const label = externalCliRunLabels.get(run.runId);
      return run.configId === configId
        || (label?.configName === config.name && label.runtime === config.runtime);
    });
  }
  function externalCliDisplayText(
    value: string,
    config?: PersistedBridgeConfig,
  ): string {
    let safe = value;
    if (config?.apiKey) safe = safe.split(config.apiKey).join('[REDACTED]');
    return safe
      .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
      .replace(/((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
      .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
  }
  function externalCliPreview(
    value: string,
    config?: PersistedBridgeConfig,
    maxLength = 180,
  ): string {
    const normalized = externalCliDisplayText(value, config).replace(/\s+/gu, ' ').trim();
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 3)}...`
      : normalized;
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
  let abortCtrl: AbortController | null = null;
  // Persistent Manager session (kind: 'manager') — reused across /manager
  // update/chat turns so the Manager keeps its own conversation context.
  let managerTuiSession: Awaited<ReturnType<typeof sdk.createSession>> | null = null;
  const assistantTeamProposals = new TeamProposalStore();
  async function interactiveSessionCatalog(): Promise<SessionCatalog> {
    const registered = await readWorkspaceRegistry(sdk.config.homeDir);
    return new SessionCatalog({
      homeDir: sdk.config.homeDir,
      projectPaths: [projectPrimaryPath, ...registered.map(item => item.path)],
    });
  }
  function managerProposalDiffForTui(
    proposal: import('../team/teamProposalService.js').TeamGraphProposal,
  ): string[] {
    return [
      ['+ nodes', proposal.diff.addedNodes],
      ['- nodes', proposal.diff.removedNodes],
      ['~ nodes', proposal.diff.changedNodes],
      ['+ edges', proposal.diff.addedEdges],
      ['- edges', proposal.diff.removedEdges],
      ['~ edges', proposal.diff.changedEdges],
    ].filter(([, values]) => (values as string[]).length)
      .map(([label, values]) => `${A.dim}${label}: ${(values as string[]).join(', ')}${A.reset}`);
  }
  let globalAssistantSdk: Awaited<ReturnType<typeof createAgentSdk>> | null = null;
  let globalAssistantSession: Awaited<ReturnType<typeof sdk.createSession>> | null = null;
  async function resolveGlobalAssistantSession() {
    const homeDir = sdk.config.homeDir;
    const config = await readAssistantConfig(homeDir);
    if (!globalAssistantSdk) {
      const sessionDirectory = path.join(homeDir, 'assistant');
      globalAssistantSdk = await createAgentSdk({
        workDir: sessionDirectory,
        sessionDirectory,
        tools: [],
        permissionMode: 'bypassPermissions',
        ...(config.model ? { model: config.model } : {}),
      });
    }
    if (globalAssistantSession && globalAssistantSession.id === config.activeSessionId) {
      return globalAssistantSession;
    }
    const stored = (await globalAssistantSdk.sessions.list())
      .filter(item => item.kind === 'manager')
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const existing = stored.find(item => item.id === config.activeSessionId) ?? stored[0];
    globalAssistantSession = existing
      ? await globalAssistantSdk.resumeSession(existing.id, { permissionMode: 'bypassPermissions' })
      : await globalAssistantSdk.createSession({
        title: 'Assistant (Global)',
        kind: 'manager',
        metadata: { __hadamardKind: 'manager', __hadamardAssistantScope: 'global' },
        permissionMode: 'bypassPermissions',
      });
    if (config.activeSessionId !== globalAssistantSession.id) {
      await writeAssistantConfig({ ...config, activeSessionId: globalAssistantSession.id }, homeDir);
    }
    return globalAssistantSession;
  }
  async function resolveManagerTuiSession() {
    if (managerTuiSession) return managerTuiSession;
    const cfg = await readManagerConfig(sdk.config.workDir, sdk.config.homeDir);
    const managers = (await sdk.sessions.list()).filter(item => item.kind === 'manager');
    managers.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const existing = managers.find(item => item.id === cfg.activeSessionId) ?? managers[0];
    if (existing) {
      managerTuiSession = await sdk.resumeSession(existing.id, { permissionMode: 'bypassPermissions' });
      if (cfg.activeSessionId !== existing.id) {
        await writeManagerConfig(sdk.config.workDir, sdk.config.homeDir, {
          ...cfg,
          activeSessionId: existing.id,
        });
      }
      return managerTuiSession;
    }
    managerTuiSession = await sdk.createSession({
      title: 'Manager',
      metadata: { __hadamardKind: 'manager' },
      permissionMode: 'bypassPermissions',
    });
    await writeManagerConfig(sdk.config.workDir, sdk.config.homeDir, {
      ...cfg,
      activeSessionId: managerTuiSession.id,
    });
    return managerTuiSession;
  }
  let dialog: PermissionDialogState | null = null;
  let selectionDialog: SelectionDialogState | null = null;
  let textInputDialog: TextInputDialogState | null = null;
  let menuSelected = 0;
  // @-mention file completion: highlighted candidate + lazily-cached file list.
  let atSelected = 0;
  let workspaceFiles: string[] | null = null;
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let dynamicRenderTimer: ReturnType<typeof setTimeout> | null = null;
  let runStartedAt = 0;
  let requestStartedAt = 0;
  let providerActivitySeen = false;
  let runToolCount = 0;
  let lastTokenEstimate: number | undefined;
  let lastTokenBreakdown: RequestTokenEstimateBreakdown | undefined;
  // Running token + USD totals for /cost and /usage. Per-config breakdown
  // shows spend by each bridge config so the user can compare backends.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd: number | null = 0;
  const configUsage = new Map<string, { inputTokens: number; outputTokens: number; turns: number }>();
  function recordUsage(model: string, usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  } | undefined): void {
    const inT = usage?.input_tokens ?? 0;
    const outT = usage?.output_tokens ?? 0;
    totalInputTokens += inT;
    totalOutputTokens += outT;
    const cost = estimateCost(model, inT, outT);
    totalCostUsd = cost === null ? null : (totalCostUsd === null ? cost : totalCostUsd + cost);
    // Per-config tracking: attribute this turn to the active bridge config.
    if (bridgeMode && activeBridgeConfig) {
      const rec = configUsage.get(activeBridgeConfig.name) ?? { inputTokens: 0, outputTokens: 0, turns: 0 };
      rec.inputTokens += inT;
      rec.outputTokens += outT;
      rec.turns += 1;
      configUsage.set(activeBridgeConfig.name, rec);
    }
  }
  function configCost(name: string, rec: { inputTokens: number; outputTokens: number }): string | null {
    const cfg = findBridgeConfig(name);
    if (!cfg?.model) return null;
    const cost = estimateCost(cfg.model, rec.inputTokens, rec.outputTokens);
    return cost !== null ? `$${cost.toFixed(4)}` : null;
  }
  let statusNote = '';
  let streamedTextSeen = false;
  const reasoningDisplay = new ReasoningDisplayState();
  const toolActivityDisplay = new ToolActivityDisplayState();
  // Track tool names by callId for PostToolUse hook context.
  const toolCallNames = new Map<string, string>();
  // Live todo list (captured from TodoWrite tool calls). Rendered as a
  // persistent panel in the dynamic region so the user can see what the agent
  // is working on / what remains — Claude Code's main progress affordance.
  let currentTodos: { content: string; status: string; activeForm?: string }[] = [];
  const currentPermissionMode = (): HadamardPermissionMode =>
    session.permissionContext.mode ?? permissionMode;
  const currentExternalCliPermissionMode = (): 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan' => {
    const mode = currentPermissionMode();
    return mode === 'auto' || mode === 'approveForMe' ? 'default' : mode;
  };
  const currentEffort = (): HadamardRunEffort | undefined => {
    const stored = session.metadata[SESSION_EFFORT_KEY];
    if (stored === 'auto') return 'auto';
    return isHadamardEffort(stored) ? stored : sdk.config.effort;
  };
  const currentAgentMode = () => readSessionAgentMode(session.metadata, projectSettings.agentMode);

  function isHadamardEffort(value: unknown): value is HadamardEffort {
    return typeof value === 'string' && EFFORT_LEVELS.includes(value as HadamardEffort);
  }

  function selectItem(options: {
    title: string;
    subtitle?: string;
    items: TuiSelectionItem[];
    searchable?: boolean;
  }): Promise<string | undefined> {
    if (options.items.length === 0) {
      return Promise.resolve(undefined);
    }
    return new Promise(resolve => {
      selectionDialog = {
        title: options.title,
        subtitle: options.subtitle,
        items: options.items,
        selected: 0,
        query: '',
        searchable: options.searchable !== false,
        resolve: value => resolve(typeof value === 'string' ? value : undefined),
      };
      renderDynamic();
    });
  }

  function selectItems(options: {
    title: string;
    subtitle?: string;
    items: TuiSelectionItem[];
    checkedIds: string[];
  }): Promise<string[] | undefined> {
    return new Promise(resolve => {
      selectionDialog = {
        title: options.title,
        subtitle: options.subtitle,
        items: options.items,
        selected: 0,
        query: '',
        searchable: false,
        multiple: true,
        checkedIds: new Set(options.checkedIds),
        resolve: value => resolve(Array.isArray(value) ? value : undefined),
      };
      renderDynamic();
    });
  }

  function promptText(options: {
    title: string;
    label: string;
    description?: string;
    initial?: string;
    secret?: boolean;
  }): Promise<string | undefined> {
    return new Promise(resolve => {
      const inputEditor = new InputEditor();
      if (options.initial) inputEditor.setText(options.initial);
      textInputDialog = {
        title: options.title,
        label: options.label,
        description: options.description,
        editor: inputEditor,
        secret: options.secret === true,
        resolve,
      };
      renderDynamic();
    });
  }

  async function reloadCleanSdk(): Promise<void> {
    const previousSdk = sdk;
    const nextSdk = await createCleanSdk();
    try {
      const nextSession = await nextSdk.resumeSession(session.id);
      const nextToolMetadata = await nextSdk.listToolMetadata();
      sdk = nextSdk;
      session = nextSession;
      toolMetadata = nextToolMetadata;
      await restoreSessionRuntimeSelection();
    } catch (error) {
      await nextSdk.close().catch(() => undefined);
      throw error;
    }
    if (deviceLinkService) {
      await deviceLinkService.close().catch(() => undefined);
      deviceLinkService = null;
    }
    await previousSdk.close().catch(() => undefined);
  }

  const approver: HadamardToolApprover = async (context) => {
    const outcome = await new Promise<'allow' | 'always' | 'always-user' | 'deny'>((resolve) => {
      dialog = {
        toolName: context.publicName,
        summary: summarizeForDialog(context.input),
        selected: 0,
        safetyCritical: context.safetyCritical === true,
        resolve,
      };
      renderDynamic();
    });
    dialog = null;
    renderDynamic();
    if (outcome === 'always' || outcome === 'always-user') {
      const state = session.permissionContext;
      const permissions = state.permissions.filter(
        rule => !(rule.toolName === context.publicName && rule.behavior === 'allow'),
      );
      const source: 'project' | 'user' = outcome === 'always-user' ? 'user' : 'project';
      permissions.push({
        toolName: context.publicName,
        behavior: 'allow',
        source,
      });
      await session.setPermissionContext({
        mode: state.mode ?? permissionMode,
        permissions,
        approver,
      });
      return { behavior: 'allow', reason: `Approved (always — ${source} scope) in TUI.` };
    }
    return outcome === 'allow'
      ? { behavior: 'allow', reason: 'Approved in TUI.' }
      : { behavior: 'deny', reason: 'Denied in TUI permission dialog.' };
  };

  applyPlanPermission = async () => {
    await session.setPermissionContext({ mode: 'plan', permissions: [], approver });
  };

  // Mirrors the GUI hook: evaluates the LIVE permission mode so mode switches
  // via /permissions behave identically on both surfaces.
  const canUseTool: HadamardCanUseTool | undefined =
    (context) => {
          if (currentPermissionMode() !== 'default') return undefined;
          if (context.publicName === 'Bash') {
            // Auto-allow read-only commands (ls, git status, cat, …) so the
            // default mode isn't a prompt on every harmless call (gap #12 vs
            // claude-code). Everything else still prompts. isReadOnlyBashCommand
            // is conservative — anything ambiguous falls through to 'ask'.
            const command = (context.input as { command?: unknown } | null)?.command;
            if (typeof command === 'string' && isReadOnlyBashCommand(command)) {
              return undefined;
            }
            return { behavior: 'ask', reason: 'Bash command may modify the workspace.' };
          }
          if (MUTATING_TOOLS.has(context.publicName)) {
            return { behavior: 'ask', reason: `${context.publicName} mutates the workspace.` };
          }
          return undefined;
        };

  // User-configurable PreToolUse hooks from settings.json hooks.PreToolUse[].
  // Lazily reads the live settings so edits are picked up without a restart.
  // The classifier returns undefined (no-op) when no hooks match — so the run
  // path is unchanged for users who haven't configured any.
  const preToolUseHookClassifier = createPreToolUseHookClassifier(
    () => readPreToolUseHooks(getLoadedJsonConfig()?.raw),
  );

  function summarizeForDialog(input: unknown): string {
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

  // ── Dynamic region rendering ───────────────────────────────────────

  // ── @-mention file completion ──────────────────────────────────────
  // Prefer git's view (tracked + untracked, honoring .gitignore) so the list
  // matches what the agent actually sees; fall back to a bounded fs walk for
  // non-git workspaces. Cached for the session and invalidated after each run.
  function loadWorkspaceFiles(): string[] {
    if (workspaceFiles) return workspaceFiles;
    try {
      const out = execSync('git ls-files --cached --others --exclude-standard', {
        cwd: workDir,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      workspaceFiles = out.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8000);
    } catch {
      workspaceFiles = walkWorkspaceFiles(workDir, 8000);
    }
    return workspaceFiles;
  }

  function walkWorkspaceFiles(root: string, limit: number): string[] {
    const skip = new Set(['node_modules', '.git', 'dist', '.codegraph', '.next', 'coverage']);
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0 && out.length < limit) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!skip.has(entry.name) && !entry.name.startsWith('.')) stack.push(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
          if (out.length >= limit) break;
        }
      }
    }
    return out;
  }

  function atCompletions(token: string): string[] {
    const files = loadWorkspaceFiles();
    const query = token.toLowerCase();
    if (!query) return files.slice(0, 200);
    // Subsequence fuzzy match with path-aware scoring: prefer basename hits,
    // then prefix hits, then path depth (shorter = nearer the root = more
    // likely the file the user wants). Falls back to substring for short
    // tokens so exact-include still ranks well.
    const scored: { file: string; score: number }[] = [];
    for (const file of files) {
      const lower = file.toLowerCase();
      const slash = lower.lastIndexOf('/') + 1;
      const base = lower.slice(slash);
      let score = -1;
      if (base.startsWith(query)) score = 1000 - base.length;
      else if (lower.includes(query)) score = 800 - slash;
      else {
        // Subsequence fuzzy match: walk the path consuming the query in order.
        let qi = 0;
        for (let i = 0; i < lower.length && qi < query.length; i++) {
          if (lower[i] === query[qi]) qi++;
        }
        if (qi === query.length) score = 400 - slash - (lower.length - query.length) * 0.1;
      }
      if (score >= 0) scored.push({ file, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 200).map((s) => s.file);
  }

  function buildAtMenu(): string[] {
    const active = activeAtToken(editor.text, editor.cursor);
    if (!active) return [];
    const matches = atCompletions(active.token);
    if (matches.length === 0) {
      return [`${A.dim}  @${active.token} — no matching files${A.reset}`];
    }
    if (atSelected >= matches.length) atSelected = matches.length - 1;
    if (atSelected < 0) atSelected = 0;
    const windowStart = Math.max(
      0,
      Math.min(atSelected - MENU_MAX_ROWS + 1, matches.length - MENU_MAX_ROWS),
    );
    const visible = matches.slice(windowStart, windowStart + MENU_MAX_ROWS);
    const lines = visible.map((file, i) => {
      const index = windowStart + i;
      const display = truncateToWidth(file, Math.max(screen.width - 6, 12));
      return index === atSelected ? `${A.inverse} @${display} ${A.reset}` : `  ${A.cyan}@${display}${A.reset}`;
    });
    const hiddenAbove = windowStart;
    const hiddenBelow = matches.length - (windowStart + visible.length);
    if (hiddenAbove > 0 || hiddenBelow > 0) {
      const parts: string[] = [];
      if (hiddenAbove > 0) parts.push(`↑${hiddenAbove}`);
      if (hiddenBelow > 0) parts.push(`↓${hiddenBelow}`);
      lines.push(`${A.dim}  ${parts.join('  ')} more · ${atSelected + 1}/${matches.length} (↑/↓ · Tab/Enter to insert)${A.reset}`);
    }
    return lines;
  }

  /** Replace the active @-token with the highlighted file path. */
  function applyAtCompletion(): boolean {
    const active = activeAtToken(editor.text, editor.cursor);
    if (!active) return false;
    const matches = atCompletions(active.token);
    if (matches.length === 0) return false;
    const file = matches[Math.min(atSelected, matches.length - 1)]!;
    const before = editor.text.slice(0, active.start);
    const after = editor.text.slice(editor.cursor);
    const mention = `@${file} `;
    editor.setTextWithCursor(`${before}${mention}${after}`, before.length + mention.length);
    atSelected = 0;
    return true;
  }

  function buildMenu(): string[] {
    const matches = filterSlashCommands(editor.text);
    if (matches.length === 0) return [];
    if (menuSelected >= matches.length) menuSelected = matches.length - 1;
    if (menuSelected < 0) menuSelected = 0;
    const commandWidth = Math.min(28, Math.max(14, Math.floor(screen.width * 0.28)));
    const descriptionWidth = Math.max(screen.width - commandWidth - 4, 12);
    // Scroll a window of MENU_MAX_ROWS so the highlighted item stays visible and
    // commands past the cap (e.g. /workflows, /worktree, /team) are reachable
    // with the arrow keys instead of being clipped off the bottom.
    const windowStart = Math.max(
      0,
      Math.min(menuSelected - MENU_MAX_ROWS + 1, matches.length - MENU_MAX_ROWS),
    );
    const visible = matches.slice(windowStart, windowStart + MENU_MAX_ROWS);
    const lines = visible.map((name, i) => {
      const index = windowStart + i;
      const selected = index === menuSelected;
      const command = `/${name}`.padEnd(commandWidth);
      const label = selected ? `${A.inverse}${command}${A.reset}` : command;
      const unavailable = running && interactiveCommandRunPolicy(name) === 'idle-only';
      const summary = TUI_SLASH_COMMANDS[name] ?? SUBCOMMAND_DESCRIPTIONS[name] ?? '';
      const description = truncateToWidth(
        unavailable ? `${summary} · after current run` : summary,
        descriptionWidth,
      );
      return `${label} ${A.dim}${description}${A.reset}`;
    });
    const hiddenAbove = windowStart;
    const hiddenBelow = matches.length - (windowStart + visible.length);
    if (hiddenAbove > 0 || hiddenBelow > 0) {
      const parts: string[] = [];
      if (hiddenAbove > 0) parts.push(`↑${hiddenAbove}`);
      if (hiddenBelow > 0) parts.push(`↓${hiddenBelow}`);
      lines.push(`${A.dim}  ${parts.join('  ')} more · ${menuSelected + 1}/${matches.length} (↑/↓ to scroll)${A.reset}`);
    }
    const selected = matches[Math.min(menuSelected, matches.length - 1)];
    if (selected) {
      const commandName = selected.split(/\s/u, 1)[0] ?? selected;
      const availability = interactiveCommandRunPolicy(selected) === 'during-run'
        ? 'available while working'
        : 'idle session';
      lines.push(`${A.dim}  ${interactiveCommandUsage(commandName)} · ${availability}${A.reset}`);
    }
    return lines;
  }

  /** Friendly permission label matching the /permissions presets. */
  function permissionLabel(): string {
    const m = currentPermissionMode();
    if (m === 'bypassPermissions') return 'full-access';
    if (m === 'approveForMe') return 'approve-for-me';
    if (m === 'acceptEdits') return 'workspace';
    if (m === 'default' && session.permissionContext.permissions.some((p) => p.behavior === 'deny')) return 'read-only';
    return m;
  }

  /** Always-visible mode + live context-usage line (usage shown as % of the window). */
  function buildModeLine(): string {
    const used = lastTokenEstimate ?? 0;
    const window = readSessionContextWindow(session.metadata)
      ?? sdk.config.compact.contextWindowTokens
      ?? 200_000;
    const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
    const usedK = used >= 1000 ? `${(used / 1000).toFixed(used >= 100_000 ? 0 : 1)}k` : `${used}`;
    const ctxColor = pct >= 90 ? A.red : pct >= 70 ? A.yellow : A.dim;
    const modelLabel = activeRouter
      ? `router:${activeRouter.name}${routedModelLabel ? ` → ${routedModelLabel}` : ''}`
      : !bridgeMode && activeBridgeConfig?.runtime === 'hadamard' && bridgeModelLabel
        ? `${activeBridgeConfig.name}:${bridgeModelLabel}`
        : session.model;
    const bridgeTag = bridgeMode && activeBridgeConfig
      ? ` · bridge:${activeBridgeConfig.name}${bridgeModelLabel ? ` · ${bridgeModelLabel}` : ''}`
      : '';
    const teamLabel = activeTeamName
      ? `team:${activeTeamName}${teamPrefs.autoInvoke ? '' : ' (manual)'}`
      : 'team:none';
    const left = `${modelLabel} · ${permissionLabel()} · mode:${currentAgentMode()} · effort:${currentEffort() ?? 'auto'} · ${teamLabel}${bridgeTag}${goalContextLine()} · `;
    return `${A.dim}  ${left}${A.reset}${ctxColor}ctx ${pct}% (${usedK})${A.reset}`;
  }

  function buildStatusLine(): string[] {
    const modeLine = buildModeLine();
    if (!running) return [modeLine];
    const elapsed = Math.max(Math.round((Date.now() - runStartedAt) / 1000), 0);
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    const note = statusNote ? ` · ${statusNote}` : '';
    const queued = session.pendingInputCount > 0 ? ` · ${session.pendingInputCount} queued` : '';
    return [
      `${A.cyan}${frame}${A.reset} ${A.bold}Working…${A.reset}${A.dim} (${elapsed}s · ${runToolCount} tool${runToolCount === 1 ? '' : 's'}${note}${queued} · esc to interrupt)${A.reset}`,
      modeLine,
    ];
  }

  function buildHintLine(): string[] {
    if (running) {
      return [`${A.dim}  enter queue follow-up · shift+enter steer now · ↑ recall queued · esc interrupt${A.reset}`];
    }
    return [`${A.dim}  ? shortcuts · / commands · @ files · \\↵ newline · ↑↓ history · ctrl+c clear/exit${A.reset}`];
  }

  function buildPendingInputPanel(): string[] {
    const pending = session.pendingInputs;
    const visible = pending.followUps.slice(-3);
    const hidden = pending.followUps.length - visible.length;
    const lines = visible.map((text, index) => (
      `${A.dim}  queued ${hidden + index + 1}: ${truncateToWidth(text.replace(/\s+/g, ' '), Math.max(screen.width - 15, 12))}${A.reset}`
    ));
    if (pending.steering.length > 0) {
      lines.push(`${A.dim}  ${pending.steering.length} immediate steering message${pending.steering.length === 1 ? '' : 's'} pending${A.reset}`);
    }
    return lines;
  }

  function buildTodoPanel(): string[] {
    if (currentTodos.length === 0) return [];
    const max = 8;
    const visible = currentTodos.slice(0, max);
    const done = currentTodos.filter(t => t.status === 'completed').length;
    const lines: string[] = [
      `${A.dim}  tasks (${done}/${currentTodos.length})${A.reset}`,
    ];
    for (const t of visible) {
      let mark: string;
      let body: string;
      if (t.status === 'completed') {
        mark = `${A.green}✓${A.reset}`;
        body = `${A.dim}${truncateToWidth(t.content, screen.width - 6)}${A.reset}`;
      } else if (t.status === 'in_progress') {
        mark = `${A.cyan}▶${A.reset}`;
        // Show the present-continuous form while a task is actively executing.
        const text = t.activeForm ?? t.content;
        body = `${A.bold}${truncateToWidth(text, screen.width - 6)}${A.reset}`;
      } else {
        mark = `${A.dim}○${A.reset}`;
        body = `${truncateToWidth(t.content, screen.width - 6)}`;
      }
      lines.push(`  ${mark} ${body}`);
    }
    const more = currentTodos.length - max;
    if (more > 0) lines.push(`${A.dim}  … ${more} more${A.reset}`);
    return lines;
  }

  function renderDynamic(): void {
    const lines: string[] = [];
    let promptCursor: { line: number; column: number } | undefined;
    lines.push(...buildStatusLine());
    if (queuedConfirmActive && !running) {
      lines.push(...formatInfoLine('Stopped · queued message ready: press Enter to send, ESC to discard.'));
    }
    if (running && session.pendingInputCount > 0) {
      lines.push(...buildPendingInputPanel());
    }
    if (reasoningDisplay.hasActive) {
      lines.push(...reasoningDisplay.liveLines(screen.width));
    }
    const tail = flusher.tail();
    if (running && tail) {
      lines.push(tail);
    }
    // Live todo panel — shown whenever the agent has a plan, unless a modal
    // (permission/selection/text-input) is open (those take the region).
    if (currentTodos.length > 0 && !dialog && !selectionDialog && !textInputDialog) {
      lines.push(...buildTodoPanel());
    }
    if (dialog) {
      lines.push(...buildTuiPermissionDialog(dialog, screen.width));
    } else if (selectionDialog) {
      const dialogStartLine = lines.length;
      const rendered = buildTuiSelectionDialog(selectionDialog, screen.width, process.stdout.rows ?? 24);
      selectionDialog.selected = rendered.selected;
      lines.push(...rendered.lines);
      promptCursor = tuiSelectionDialogCursorPosition(selectionDialog, dialogStartLine);
    } else if (textInputDialog) {
      const dialogStartLine = lines.length;
      lines.push(...buildTuiTextInputDialog(textInputDialog, screen.width));
      promptCursor = tuiTextInputDialogCursorPosition(textInputDialog, dialogStartLine);
    } else {
      const promptStartLine = lines.length;
      lines.push(...buildTuiPromptBar(editor, screen.width));
      promptCursor = tuiPromptCursorPosition(editor, screen.width, promptStartLine);
      const atMenu = buildAtMenu();
      if (atMenu.length > 0) {
        lines.push(...atMenu);
      } else {
        const menu = buildMenu();
        lines.push(...(menu.length > 0 ? menu : buildHintLine()));
      }
    }
    screen.setDynamic(lines, promptCursor);
  }

  function scheduleDynamicRender(): void {
    if (dynamicRenderTimer) return;
    dynamicRenderTimer = setTimeout(() => {
      dynamicRenderTimer = null;
      renderDynamic();
    }, DYNAMIC_FRAME_MS);
  }

  function cancelScheduledDynamicRender(): void {
    if (!dynamicRenderTimer) return;
    clearTimeout(dynamicRenderTimer);
    dynamicRenderTimer = null;
  }

  function appendStatic(lines: readonly string[]): void {
    screen.appendStatic(lines);
  }

  function paintWelcome(): void {
    appendStatic(formatWelcomePage({
      workDir,
      model: session.model,
      toolCount: toolMetadata.length || tools.length,
      permissionMode: currentPermissionMode(),
      width: screen.width,
    }));
  }

  async function refreshContextEstimate(): Promise<void> {
    const sessionId = session.id;
    await toolMetadataReady;
    const project = loadProjectContext(workDir, {
      projectInstructionMode: projectSettings.context.instructionMode,
      hadamardHomeDir,
      projectWorkPaths,
    });
    const instructionState = parseProjectInstructionState(session.metadata);
    const compactCount = getPersistedHadamardCompactState(session.metadata).compactCount;
    const contentHash = hashProjectInstructionContent(project.text, project.sources);
    const pendingInject = !instructionState
      || compactCount > instructionState.injectedAtCompactCount
      || instructionState.contentHash !== contentHash;
    const localTools = [...new Map(
      toolMetadata
        .map(metadata => sdk.getTool(metadata.name))
        .filter((tool): tool is AgentToolDefinition => Boolean(tool))
        .map(tool => [tool.name, tool]),
    ).values()];
    const estimatedLocalTools = await applyResolvedToolDescriptions(
      [
        ...localTools,
        ...(activeTeamTool ? [activeTeamTool] : []),
      ],
      { workDir, permissionMode: currentPermissionMode() },
    );
    const estimate = estimateTuiContextTokenBreakdown({
      systemPrompt,
      tools: [
        ...estimatedLocalTools,
        ...toolMetadata
          .filter(metadata => metadata.provider === 'mcp' && !sdk.getTool(metadata.name))
          .map(metadata => ({
            name: metadata.name,
            description: metadata.description,
            inputJsonSchema: {},
          })),
      ],
      messages: session.messages,
    });
    if (pendingInject) {
      estimate.messageTokens += Math.ceil(project.text.length / 4);
      estimate.uncalibratedTokens += Math.ceil(project.text.length / 4);
      estimate.totalTokens += Math.ceil(project.text.length / 4);
    }
    if (session.id === sessionId) {
      lastTokenBreakdown = estimate;
      lastTokenEstimate = estimate.totalTokens;
      renderDynamic();
    }
  }

  function projectInstructionRunOptions() {
    const contextWindowTokens = readSessionContextWindow(session.metadata);
    return {
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
      projectInstructions: {
        mode: projectSettings.context.instructionMode,
        workPaths: projectWorkPaths,
      },
    };
  }

  function paintSessionHistory(): void {
    appendStatic(formatSessionHistory(session.messages, screen.width));
    void refreshContextEstimate();
  }

  function paintResumedSession(): void {
    process.stdout.write('\x1b[2J\x1b[H');
    screen.setDynamic([]);
    paintWelcome();
    appendStatic([
      ...formatInfoLine(`resumed: ${session.id} · ${session.title} · ${session.model}`),
      ...formatInfoLine(`workspace: ${workDir}`),
      '',
    ]);
    paintSessionHistory();
    renderDynamic();
  }

  async function clearConversation(): Promise<void> {
    const previousSession = session;
    const effort = currentEffort();
    const agentMode = currentAgentMode();
    const nextSession = await sdk.createSession({
      title: path.basename(workDir),
      model: previousSession.model,
      permissionMode: currentPermissionMode(),
      permissions: previousSession.permissionContext.permissions,
      metadata: {
        ...(effort ? { [SESSION_EFFORT_KEY]: effort } : {}),
        ...(readSessionContextWindow(previousSession.metadata)
          ? { [HADAMARD_CONTEXT_WINDOW_METADATA_KEY]: readSessionContextWindow(previousSession.metadata) }
          : {}),
        ...sessionAgentModePatch(agentMode),
      },
    });
    session = nextSession;
    await persistSessionRuntimeMetadata();
    await deleteEmptyTuiSession(previousSession);
    totalInputTokens = 0;
    totalOutputTokens = 0;
    totalCostUsd = 0;
    configUsage.clear();
    currentTodos = [];
    lastTokenEstimate = undefined;
    lastTokenBreakdown = undefined;
    await refreshContextEstimate();
    process.stdout.write('\x1b[2J\x1b[H');
    screen.setDynamic([]);
    paintWelcome();
    renderDynamic();
    runSessionStartHooks(() => readSessionStartHooks(getLoadedJsonConfig()?.raw), workDir);
  }

  function collapseReasoning(): void {
    const lines = reasoningDisplay.complete();
    if (lines.length > 0) appendStatic(lines);
  }

  // Inline CLI spinner for long async operations (probe, reload).
  // Writes directly to stdout with \r — independent of the redrawable region.
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let inlineSpinnerTimer: ReturnType<typeof setInterval> | null = null;
  function showSpinner(message: string): void {
    let i = 0;
    inlineSpinnerTimer = setInterval(() => {
      process.stdout.write(`\r${A.dim}${SPINNER[i++ % SPINNER.length]} ${message}${A.reset}`);
    }, 80);
  }
  function stopSpinner(): void {
    if (inlineSpinnerTimer) { clearInterval(inlineSpinnerTimer); inlineSpinnerTimer = null; }
    process.stdout.write('\r\x1b[K');
  }

  /** Run an async operation with an inline spinner — no flicker for sub-100ms ops. */
  async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    showSpinner(message);
    try {
      const result = await fn();
      const elapsed = Date.now() - start;
      if (elapsed < 120) await new Promise(r => setTimeout(r, 120 - elapsed)); // min display
      return result;
    } finally {
      stopSpinner();
    }
  }

  // ── Agent run ──────────────────────────────────────────────────────

  // /model router: pick a saved router profile (or turn routing off). When
  // active, each user turn is classified and routed to a model in startRun().
  async function chooseRouter(arg: string): Promise<void> {
    const turnOff = () => {
      activeRouter = null;
      routedModelLabel = null;
      appendStatic([...formatInfoLine('router off — using the fixed model'), '']);
    };
    if (arg === 'off' || arg === 'none') { turnOff(); return; }

    if (arg) {
      const found = loadRouterProfile(arg, sdk.config.workDir);
      if (!found) {
        appendStatic([...formatErrorLine(`router profile not found: ${arg}`), '']);
        return;
      }
      activeRouter = found.profile;
      routedModelLabel = null;
      appendStatic([...formatInfoLine(`router active: ${found.profile.name} — each turn is classified by ${found.profile.routerModel.model} and routed`), '']);
      return;
    }

    const profiles = listRouterProfiles(sdk.config.workDir);
    if (profiles.length === 0) {
      appendStatic([
        ...formatInfoLine('no router profiles found. Create one at ~/.hadamard/routers/<name>.json (routerModel + routes:[{ when, model, provider?, baseURL?, apiKey? }] + fallback).'),
        '',
      ]);
      return;
    }
    const items = [
      { id: '__off__', label: activeRouter ? `Turn router off (active: ${activeRouter.name})` : 'Router off (current)', description: 'use the fixed model for every turn' },
      ...profiles.map((p) => ({ id: `profile:${p.name}`, label: p.name, description: `${p.profile.routes.length} routes · classifier ${p.profile.routerModel.model} · ${p.source}` })),
    ];
    const choice = await selectItem({ title: 'Model router', subtitle: 'classify each turn and route to a model (may be cross-provider)', items });
    if (!choice) return;
    if (choice === '__off__') { turnOff(); return; }
    const found = loadRouterProfile(choice.slice('profile:'.length), sdk.config.workDir);
    if (found) {
      activeRouter = found.profile;
      routedModelLabel = null;
      appendStatic([...formatInfoLine(`router active: ${found.profile.name} — turns routed by ${found.profile.routerModel.model}`), '']);
    }
  }

  // Expand @<image-path> tokens into Anthropic image content blocks so the
  // user can attach screenshots/designs inline (gap #4, partial — clipboard
  // capture is platform-specific, so this is the @path route only). Returns a
  // string when there are no image refs (the common case) so the run path is
  // unchanged; otherwise a ContentBlockParam[] with text + base64 image blocks.
  function expandImageRefs(text: string): string | ContentBlockParam[] {
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
        data = fs.readFileSync(resolved).toString('base64');
      } catch {
        continue; // not readable — leave the @token in the text below
      }
      const at = text.indexOf(ref, cursor);
      if (at > cursor) blocks.push({ type: 'text', text: text.slice(cursor, at) });
      const ext = path.extname(raw).slice(1).toLowerCase();
      const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      });
      cursor = at + ref.length;
      seen.add(resolved);
      imagesAdded++;
    }
    if (cursor < text.length) blocks.push({ type: 'text', text: text.slice(cursor) });
    // If no image actually loaded, fall back to the original string so the run
    // path is unchanged (the @tokens stay literal for the model to ignore).
    return imagesAdded > 0 ? blocks : text;
  }

  async function startRun(text: string): Promise<void> {
    if (
      bridgeMode
      && activeBridgeConfig?.execution === 'cli'
          && isManagedExternalCliRuntime(activeBridgeConfig.runtime)
    ) {
      const conflictingRun = findConflictingExternalCliRun(
        activeBridgeConfig as SupportedExternalCliConfig,
      );
      if (conflictingRun) {
        appendStatic([
          ...formatErrorLine(`background run ${conflictingRun.runId} is still ${conflictingRun.status}; this native CLI session cannot run concurrently.`),
          ...formatInfoLine(`Wait for it to finish, or use /bridge runs and /bridge stop ${conflictingRun.runId}.`),
          '',
        ]);
        return;
      }
    }
    running = true;
    runStartedAt = Date.now();
    requestStartedAt = 0;
    providerActivitySeen = false;
    runToolCount = 0;
    toolActivityDisplay.reset();
    toolCallNames.clear();
    statusNote = 'preparing locally';
    streamedTextSeen = false;
    abortCtrl = new AbortController();
    spinnerTimer = setInterval(() => {
      spinnerFrame += 1;
      if (requestStartedAt > 0 && !providerActivitySeen) {
        const waitingSeconds = Math.max(Math.round((Date.now() - requestStartedAt) / 1000), 0);
        statusNote = `waiting for model ${waitingSeconds}s`;
      }
      renderDynamic();
    }, 120);

    appendStatic(formatUserPrompt(text));
    renderDynamic();
    await toolMetadataReady;

    // /model router: classify this turn and route it to a model (possibly on a
    // different provider). Only applies to the in-process SDK — bridge mode
    // runs on the fixed provider+model, so routing is skipped there.
    let routed: { model: string; modelApi: import('../types.js').CreateAgentSdkOptions['modelApi']; effort?: HadamardRunEffort } | undefined;
    if (activeRouter && !bridgeMode) {
      try {
        const decision = await resolveRoutedRun(activeRouter, text, abortCtrl.signal);
        routed = { model: decision.model, modelApi: decision.modelApi, effort: decision.effort };
        routedModelLabel = `${decision.label} (${decision.model})`;
        appendStatic(formatInfoLine(`router → ${routedModelLabel}`));
      } catch (error: any) {
        appendStatic(formatInfoLine(`router classification failed (${error.message}); using ${session.model}`));
      }
    }

    try {
      // Branch the event source. Bridge mode spawns the configured runtime CLI
      // and adapts its events into the same AgentEvent stream the rest of this
      // loop consumes — so a bridge run reuses the spinner, tool cards, Esc
      // interrupt, first-class session steering, and history exactly like a
      // normal run.
      let eventStream: AsyncIterable<AgentEvent>;
      let resultPromise: Promise<AgentRunResult>;
      const externalBridge = activeExternalBridgeRuntime();
      if (externalBridge && activeBridgeConfig) {
        statusNote = 'cli:' + activeBridgeConfig.runtime;
        const nativeStream = externalBridge.session.stream(text, {
          model: bridgeModelLabel ?? activeBridgeConfig.model,
          signal: abortCtrl.signal,
          permissionMode: currentExternalCliPermissionMode(),
        });
        const adapted = adaptBridgeRun(
          nativeStream,
          nativeStream.result,
          'tui-cli-' + runStartedAt,
          activeBridgeConfig.runtime,
        );
        eventStream = adapted;
        resultPromise = adapted.result;
      } else if (bridgeMode && activeBridgeModelApi) {
        // Bridge mode: run in-process through the selected config's
        // provider/apiKey/baseURL/model (no child process). Inject the
        // pre-built {model, modelApi} into session.stream — the /model
        // router's proven mechanism for cross-provider routing. Same
        // session → context intact; switching bridge↔hadamard is seamless.
        statusNote = `bridge:${activeBridgeConfig?.name ?? 'bridge'}`;
        const stream = session.stream(expandImageRefs(text), {
          systemPrompt,
          ...projectInstructionRunOptions(),
          signal: abortCtrl.signal,
          permissionMode: currentPermissionMode(),
          effort: currentEffort(),
          approver,
          classifier: preToolUseHookClassifier,
          agentMode: currentAgentMode(),
          model: activeBridgeModelApi.model,
          modelApi: activeBridgeModelApi.modelApi,
          ...(activeTeamTool && teamPrefs.autoInvoke ? { tools: [...tools, activeTeamTool] } : {}),
          ...(canUseTool ? { canUseTool } : {}),
        });
        eventStream = stream;
        resultPromise = stream.result;
      } else {
        const selectedConfigModel = resolveHadamardConfigurationModel(
          activeBridgeConfig,
          bridgeMode,
          bridgeModelLabel,
        );
        const stream = session.stream(expandImageRefs(text), {
          systemPrompt,
          ...projectInstructionRunOptions(),
          signal: abortCtrl.signal,
          permissionMode: currentPermissionMode(),
          // A matched route's effort overrides the session effort for this turn.
          effort: routed?.effort ?? currentEffort(),
          approver,
          classifier: preToolUseHookClassifier,
          agentMode: currentAgentMode(),
          ...(routed
            ? { model: routed.model, modelApi: routed.modelApi }
            : selectedConfigModel ? { model: selectedConfigModel } : {}),
          ...(activeTeamTool && teamPrefs.autoInvoke ? { tools: [...tools, activeTeamTool] } : {}),
          ...(canUseTool ? { canUseTool } : {}),
        });
        eventStream = stream;
        resultPromise = stream.result;
      }
      const surfaceEvents = new LegacySurfaceEventPipeline();
      for await (const event of eventStream) {
        for (const surfaceEvent of surfaceEvents.projectFor(event, 'tui')) {
          handleSurfaceEvent(surfaceEvent);
        }
      }
      const result = await resultPromise;
      collapseReasoning();
      // Accumulate token + USD usage for /cost and /usage. The model is the
      // routed model (if a router is active) or the session model. Bridge runs
      recordUsage(routed?.model ?? activeBridgeModelApi?.model ?? bridgeModelLabel ?? session.model, result.usage);
      const rest = flusher.drain();
      if (rest.length > 0) appendStatic(rest);
      if (!flusher.hasContent && result.text && runHadNoStreamedText()) {
        appendStatic([result.text]);
      }
      if (
        externalBridge
        && activeBridgeConfig?.execution === 'cli'
        && isManagedExternalCliRuntime(activeBridgeConfig.runtime)
      ) {
        const externalConfig = activeBridgeConfig as SupportedExternalCliConfig;
        await rememberExternalNativeSession(externalConfig, externalBridge.session.id)
          .catch(() => undefined);
        await persistSessionRuntimeMetadata(session, externalConfig, bridgeModelLabel)
          .catch(() => undefined);
        if (result.text) {
          await session.appendMessages([
            { role: 'user', content: text },
            { role: 'assistant', content: result.text },
          ]).catch(() => undefined);
        }
      }
      if (result.incompleteReason) {
        appendStatic(formatInfoLine(`run incomplete: ${result.incompleteReason}`));
      }
      appendStatic(['']);
    } catch (error) {
      collapseReasoning();
      const rest = flusher.drain();
      if (rest.length > 0) appendStatic(rest);
      const err = error as Error;
      if (err.name === 'RunAbortedError' || err.name === 'AbortError' || abortCtrl?.signal.aborted) {
        appendStatic([`${A.yellow}⏹ interrupted${A.reset}`, '']);
      } else {
        appendStatic([...formatErrorLine(err.message), '']);
      }
    } finally {
      running = false;
      abortCtrl = null;
      workspaceFiles = null; // the agent may have created/removed files — refresh @-completion
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
      cancelScheduledDynamicRender();
      renderDynamic();
    }

  }

  function runHadNoStreamedText(): boolean {
    return !streamedTextSeen;
  }

  function handleSurfaceEvent(event: SurfaceSemanticEvent): void {
    const data = event.data;
    switch (event.type) {
      case 'run.started':
        streamedTextSeen = false;
        reasoningDisplay.reset();
        toolActivityDisplay.reset();
        toolCallNames.clear();
        return;
      case 'request.started':
        requestStartedAt = Date.now();
        providerActivitySeen = false;
        statusNote = 'waiting for model 0s';
        lastTokenEstimate = nextTuiContextTokenEstimate(lastTokenEstimate, event);
        if (
          typeof data.systemTokenEstimate === 'number'
          && typeof data.toolTokenEstimate === 'number'
          && typeof data.messageTokenEstimate === 'number'
        ) {
          const multiplier = typeof data.tokenEstimateMultiplier === 'number'
            ? data.tokenEstimateMultiplier
            : 1;
          const uncalibratedTokens = data.systemTokenEstimate
            + data.toolTokenEstimate
            + data.messageTokenEstimate;
          lastTokenBreakdown = {
            systemTokens: data.systemTokenEstimate,
            toolTokens: data.toolTokenEstimate,
            messageTokens: data.messageTokenEstimate,
            uncalibratedTokens,
            totalTokens: lastTokenEstimate ?? Math.ceil(uncalibratedTokens * multiplier),
            multiplier,
          };
        }
        renderDynamic();
        return;
      case 'text.delta': {
        const delta = typeof data.delta === 'string' ? data.delta : '';
        if (!delta) return;
        providerActivitySeen = true;
        collapseReasoning();
        streamedTextSeen = true;
        const flushed = flusher.push(delta);
        if (flushed.length > 0) appendStatic(flushed);
        scheduleDynamicRender();
        return;
      }
      case 'reasoning.delta': {
        const delta = typeof data.delta === 'string' ? data.delta : '';
        if (!delta) return;
        providerActivitySeen = true;
        reasoningDisplay.append(delta);
        scheduleDynamicRender();
        return;
      }
      case 'tool.input.delta': {
        providerActivitySeen = true;
        const name = typeof data.name === 'string' && data.name ? data.name : 'tool';
        const snapshot = typeof data.snapshot === 'string'
          ? data.snapshot.trim().replace(/\s+/g, ' ')
          : '';
        const preview = snapshot.length > 72 ? `${snapshot.slice(0, 69)}...` : snapshot;
        statusNote = preview ? `preparing ${name}: ${preview}` : `preparing ${name}`;
        scheduleDynamicRender();
        return;
      }
      case 'model.content': {
        providerActivitySeen = true;
        const content = isRecord(data.content) ? data.content : undefined;
        if (data.kind === 'content' && content?.type === 'thinking' && !reasoningDisplay.hasStreamedContent) {
          const thinking = typeof content.thinking === 'string' ? content.thinking : '';
          reasoningDisplay.setCompleteContent(thinking);
          scheduleDynamicRender();
        }
        return;
      }
      case 'tool.started': {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (!toolActivityDisplay.markStarted(callId)) return;
        providerActivitySeen = true;
        collapseReasoning();
        const publicName = typeof data.publicName === 'string'
          ? data.publicName
          : typeof data.name === 'string' ? data.name : 'tool';
        const input = data.input;
        const pending = flusher.drain();
        if (pending.length > 0) appendStatic(pending);
        runToolCount += 1;
        statusNote = publicName;
        if (callId) toolCallNames.set(callId, publicName);
        // Render Edit calls as a colored old→new diff instead of a one-liner.
        appendStatic(
          publicName === 'Edit'
            ? formatEditCall(input, screen.width)
            : formatToolCall(publicName, input, screen.width),
        );
        // Capture the live todo list from TodoWrite calls so the persistent
        // panel (renderDynamic) reflects the agent's current plan + progress.
        if (publicName === 'TodoWrite') {
          const todos = (isRecord(input) ? input.todos : undefined);
          if (Array.isArray(todos)) {
            currentTodos = todos
              .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
              .map(t => ({
                content: String(t.content ?? ''),
                status: String(t.status ?? 'pending'),
                activeForm: typeof t.activeForm === 'string' && t.activeForm ? t.activeForm : undefined,
              }));
            scheduleDynamicRender();
          }
        }
        renderDynamic();
        return;
      }
      case 'tool.progress': {
        const progress = isRecord(data.progress) ? data.progress : undefined;
        const message = typeof data.message === 'string'
          ? data.message
          : typeof progress?.message === 'string' ? progress.message : undefined;
        if (message) {
          statusNote = message;
          scheduleDynamicRender();
        }
        return;
      }
      case 'tool.completed':
      case 'tool.failed':
      case 'tool.rejected': {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (!toolActivityDisplay.markTerminal(callId)) return;
        const outputText = typeof data.outputText === 'string' ? data.outputText : '';
        statusNote = '';
        appendStatic(
          formatToolResult(
            {
              isError: data.isError === true,
              durationMs: typeof data.durationMs === 'number' ? data.durationMs : 0,
              outputText,
            },
            screen.width,
          ),
        );
        // Run matching PostToolUse hooks (fire-and-forget, never block).
        const toolName = callId ? toolCallNames.get(callId) : undefined;
        if (toolName) {
          runPostToolUseHooks(
            () => readPostToolUseHooks(getLoadedJsonConfig()?.raw),
            toolName,
            null as unknown,
            outputText,
            sdk.config.workDir,
          );
        }
        if (callId) toolCallNames.delete(callId);
        renderDynamic();
        return;
      }
      case 'compaction.completed':
        if (typeof data.tokenEstimateAfter === 'number') {
          lastTokenEstimate = nextTuiContextTokenEstimate(lastTokenEstimate, event);
          renderDynamic();
        }
        appendStatic(formatCompactNotice(
          typeof data.trigger === 'string' ? data.trigger : 'auto',
          typeof data.tokenEstimateBefore === 'number' ? data.tokenEstimateBefore : undefined,
          typeof data.tokenEstimateAfter === 'number' ? data.tokenEstimateAfter : undefined,
        ));
        return;
      case 'tool.permission':
        if (isRecord(data.decision) && data.decision.behavior === 'deny') {
          appendStatic(formatInfoLine(
            `permission denied: ${String(data.decision.publicName ?? 'tool')} — ${String(data.decision.reason ?? '')}`,
          ));
        }
        return;
      case 'error':
        appendStatic(formatErrorLine(typeof data.message === 'string' ? data.message : 'run failed'));
        return;
      default:
        return;
    }
  }

  // ── Slash commands ─────────────────────────────────────────────────

  async function resumeCandidates(
    options: { includeAgents?: boolean } = {},
  ): Promise<TuiResumeCandidate[]> {
    const [discovered, local] = await Promise.all([
      discoverProjectSessions(sdk.config.homeDir, { cacheTtlMs: 0 }),
      sdk.sessions.list(),
    ]);
    return buildTuiResumeCandidates(discovered, local, {
      localProjectPath: projectPrimaryPath,
      localSessionDirectory: sdk.config.sessionDirectory,
      currentSessionId: session.id,
      scopeProjectPath: workDir,
      includeAgents: options.includeAgents,
    });
  }

  async function activateResumeCandidate(target: TuiResumeCandidate): Promise<void> {
    const previousSession = session;
    const targetDirectory = path.resolve(target.sessionDirectory);
    const currentDirectory = path.resolve(sdk.config.sessionDirectory);
    const normalizeRuntimePath = (value: string) => {
      const resolved = path.resolve(value).normalize('NFC');
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (
      normalizeRuntimePath(targetDirectory) === normalizeRuntimePath(currentDirectory)
      && normalizeRuntimePath(target.projectPath) === normalizeRuntimePath(workDir)
    ) {
      session = await sdk.resumeSession(target.summary.id);
      await restoreSessionRuntimeSelection();
      await deleteEmptyTuiSession(previousSession);
      return;
    }

    const previous = {
      workDir,
      registeredProject,
      projectPrimaryPath,
      projectWorkPaths,
      activeSessionDirectory,
      projectSettings,
      systemPrompt,
    };
    const registry = await readWorkspaceRegistry(hadamardHomeDir);
    workDir = path.resolve(target.projectPath);
    registeredProject = findWorkspaceProject(registry, workDir);
    projectPrimaryPath = registeredProject?.path ?? workDir;
    projectWorkPaths = registeredProject ? workspaceWorkPaths(registeredProject) : [workDir];
    activeSessionDirectory = targetDirectory;
    projectSettings = await readProjectSettings(workDir, hadamardHomeDir);
    systemPrompt = buildTuiSystemPrompt(workDir, projectSettings, hadamardHomeDir, projectWorkPaths);

    const previousSdk = sdk;
    let nextSdk: Awaited<ReturnType<typeof createAgentSdk>> | undefined;
    try {
      nextSdk = await createCleanSdk();
      const nextSession = await nextSdk.resumeSession(target.summary.id);
      const nextToolMetadata = await nextSdk.listToolMetadata();
      sdk = nextSdk;
      session = nextSession;
      toolMetadata = nextToolMetadata;
      managerTuiSession = null;
      workspaceFiles = null;
      await restoreSessionRuntimeSelection();
    } catch (error) {
      await nextSdk?.close().catch(() => undefined);
      ({
        workDir,
        registeredProject,
        projectPrimaryPath,
        projectWorkPaths,
        activeSessionDirectory,
        projectSettings,
        systemPrompt,
      } = previous);
      await rebuildInteractiveTools();
      throw error;
    }
    if (deviceLinkService) {
      await deviceLinkService.close().catch(() => undefined);
      deviceLinkService = null;
    }
    await deleteEmptyTuiSession(previousSession);
    await previousSdk.close().catch(() => undefined);
  }

  async function resumeSession(
    reference: string,
    options: { allowAgent?: boolean } = {},
  ): Promise<boolean> {
    let candidate: TuiResumeCandidate;
    try {
      candidate = resolveTuiResumeReference(
        await resumeCandidates({ includeAgents: options.allowAgent }),
        reference,
      );
    } catch (error) {
      appendStatic([
        ...formatErrorLine(errorMessage(error)),
        '',
      ]);
      return false;
    }
    await activateResumeCandidate(candidate);
    paintResumedSession();
    return true;
  }

  async function chooseSessionToResume(): Promise<void> {
    const candidates = (await resumeCandidates()).filter(item => isTuiChatSession(item.summary));
    if (candidates.length === 0) {
      appendStatic([...formatInfoLine('no other Sessions to resume'), '']);
      return;
    }
    const byKey = new Map(candidates.map(item => [item.key, item]));
    const selected = await selectItem({
      title: 'Resume a Session',
      subtitle: `Sessions in ${workDir}`,
      items: candidates.map(item => ({
        id: item.key,
        label: item.summary.title,
        description: [
          path.basename(item.projectPath),
          item.summary.model,
          item.summary.status,
          new Date(item.summary.lastRunAt ?? item.summary.updatedAt).toLocaleString(),
        ].join(' · '),
        detail: `${item.projectPath}\n${item.summary.preview}`,
      })),
    });
    const target = selected ? byKey.get(selected) : undefined;
    if (target) {
      await activateResumeCandidate(target);
      paintResumedSession();
    }
  }

  async function configureContextSettings(requestedMode = ''): Promise<void> {
    const normalized = requestedMode.trim().toLowerCase();
    let instructionMode: ProjectInstructionMode | undefined;
    if (normalized === 'agents' || normalized === 'claude' || normalized === 'both') {
      instructionMode = normalized;
    } else if (normalized) {
      appendStatic([...formatErrorLine('usage: /context settings [agents|claude|both]'), '']);
      return;
    } else {
      const selected = await selectItem({
        title: 'Context settings',
        subtitle: `Current project mode: ${projectSettings.context.instructionMode}`,
        searchable: false,
        items: [
          { id: 'agents', label: 'AGENTS.md', description: 'Recommended Hadamard default' },
          { id: 'claude', label: 'CLAUDE.md', description: 'Project-level Claude compatibility' },
          { id: 'both', label: 'AGENTS.md + CLAUDE.md', description: 'Load both project instruction formats' },
        ],
      });
      if (selected === 'agents' || selected === 'claude' || selected === 'both') {
        instructionMode = selected;
      }
    }
    if (!instructionMode) return;
    projectSettings = await writeProjectSettings(workDir, hadamardHomeDir, {
      context: { instructionMode },
    });
    systemPrompt = buildTuiSystemPrompt(workDir, projectSettings, hadamardHomeDir, projectWorkPaths);
    appendStatic([
      ...formatInfoLine(`context instructions: ${instructionMode}`),
      ...formatInfoLine('Global rules remain ~/.hadamard/AGENTS.md.'),
      '',
    ]);
  }

  async function chooseModel(): Promise<void> {
    const catalog = buildModelConfigurationCatalog(
      {
        model: sdk.config.model,
        provider: sdk.config.provider,
        baseURL: sdk.config.baseURL,
      },
      readBridgeConfigs().configs,
    );
    const items: TuiSelectionItem[] = [
      ...catalog.map(config => ({
        id: config.id,
        label: config.source === 'default' ? 'default' : config.name,
        description: [
          config.execution === 'cli' ? `${config.runtime} CLI` : config.runtime,
          config.model || 'runtime default',
          config.models.length > 1 ? `${config.models.length} models` : '',
        ].filter(Boolean).join(' · '),
      })),
      {
        id: 'custom',
        label: 'Enter a model ID',
        description: 'Use the default provider for this session',
      },
      {
        id: 'configure',
        label: 'Manage configurations',
        description: 'Default plus named provider configurations',
      },
    ];
    const selected = await selectItem({
      title: 'Select model',
      subtitle: `Current: ${session.model}`,
      items,
      searchable: true,
    });
    if (!selected) return;
    if (selected === 'configure') {
      await configureModelSettings();
      return;
    }
    if (selected === 'custom') {
      const model = await promptText({
        title: 'Custom model',
        label: 'Model ID',
        initial: session.model,
      });
      if (!model?.trim()) return;
      await disableBridge();
      await session.setModel(model.trim());
    } else {
      const config = findModelConfiguration(catalog, selected);
      if (!config) return;
      if (config.source === 'default') {
        await disableBridge();
        await session.setModel(sdk.config.model);
      } else if (config.config) {
        let selectedConfig = { ...config.config, model: config.model };
        if (config.models.length > 1) {
          const model = await selectItem({
            title: config.name,
            subtitle: 'Select a model from this configuration',
            searchable: true,
            items: config.models.map(item => ({
              id: item.name,
              label: item.name,
              description: item.modality ?? 'text',
            })),
          });
          if (!model) return;
          selectedConfig = { ...selectedConfig, model };
        }
        await activateBridgeConfig(selectedConfig);
      }
    }
    await configureContextWindow();
    appendStatic([...formatInfoLine(`model configuration: ${activeBridgeConfig?.name ?? 'default'} · ${bridgeModelLabel ?? session.model}`), '']);
  }

  async function configureModelSettings(): Promise<void> {
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath });
    const raw = structuredClone(store.raw);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (/^[A-Z0-9_]+$/.test(key) && typeof value === 'string') env[key] = value;
    }
    if (isRecord(raw.env)) {
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value === 'string') env[key] = value;
      }
    }
    raw.env = env;
    let dirty = false;

    while (true) {
      const selected = await selectItem({
        title: 'Model and provider settings',
        subtitle: store.configPath,
        searchable: false,
        items: [
          {
            id: 'provider',
            label: 'Provider',
            description: env.HADAMARD_PROVIDER ?? sdk.config.provider,
          },
          {
            id: 'api-key',
            label: 'API key',
            description:
              isModelCredentialConfigured(env, sdk.config) ? 'configured' : 'not configured',
          },
          {
            id: 'base-url',
            label: 'Base URL',
            description: env.HADAMARD_BASE_URL || 'provider default',
          },
          {
            id: 'model',
            label: 'Default model',
            description: env.HADAMARD_MODEL || sdk.config.model || 'not configured',
          },
          {
            id: 'named',
            label: 'Named configurations',
            description: `${readBridgeConfigs().configs.length} configured`,
          },
          {
            id: 'save',
            label: 'Save and apply',
            description: dirty ? 'Unsaved changes' : 'No changes',
          },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      if (!selected || selected === 'cancel') return;
      if (selected === 'save') {
        if (!dirty) {
          appendStatic([...formatInfoLine('model settings unchanged'), '']);
          return;
        }
        await persistHadamardSettingsStore(store.configPath, raw);
        await loadJsonConfigFile(store.configPath);
        await withSpinner('reloading SDK', reloadCleanSdk);
        appendStatic([
          ...formatInfoLine(`model settings saved: ${store.configPath}`),
          '',
        ]);
        return;
      }
      if (selected === 'provider') {
        const provider = await selectItem({
          title: 'Select provider protocol',
          searchable: false,
          items: [
            { id: 'anthropic', label: 'Anthropic-compatible' },
            { id: 'openai', label: 'OpenAI-compatible' },
          ],
        });
        if (provider) {
          env.HADAMARD_PROVIDER = provider;
          dirty = true;
        }
        continue;
      }
      if (selected === 'api-key') {
        const apiKey = await promptText({
          title: 'Configure API key',
          label: 'API key',
          description: 'The value is masked and will not be written to the transcript.',
          secret: true,
        });
        if (apiKey?.trim()) {
          env.HADAMARD_API_KEY = apiKey.trim();
          delete env.HADAMARD_AUTH_TOKEN;
          dirty = true;
        }
        continue;
      }
      if (selected === 'base-url') {
        const baseUrl = await promptText({
          title: 'Configure base URL',
          label: 'Base URL',
          description: 'Leave empty to use the provider default.',
          initial: env.HADAMARD_BASE_URL ?? '',
        });
        if (baseUrl !== undefined) {
          if (baseUrl.trim()) env.HADAMARD_BASE_URL = baseUrl.trim();
          else delete env.HADAMARD_BASE_URL;
          dirty = true;
        }
        continue;
      }
      if (selected === 'model') {
        const model = await promptText({
          title: 'Configure default model',
          label: 'Model ID',
          initial: env.HADAMARD_MODEL ?? sdk.config.model,
        });
        if (model !== undefined) {
          if (model.trim()) env.HADAMARD_MODEL = model.trim();
          else delete env.HADAMARD_MODEL;
          dirty = true;
        }
        continue;
      }
      if (selected === 'named') {
        await manageBridgeConfigs();
      }
    }
  }

  async function configureBridgeSettings(): Promise<void> {
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath });
    const raw = structuredClone(store.raw);
    const bridge: Record<string, unknown> = (raw.bridge as Record<string, unknown>) ?? {};
    let dirty = false;

    const detections = await detectBridgeProviders();

    while (true) {
      const defaultLabel = (typeof bridge.defaultProvider === 'string' ? bridge.defaultProvider : 'claude');
      const providerItems = detections.map((d) => ({
        id: `provider:${d.id}`,
        label: `${d.id}${d.available ? '' : ' (not found)'}`,
        description: d.version ? `v${d.version}${d.path ? ` · ${d.path}` : ''}` : 'not detected',
      }));
      const selected = await selectItem({
        title: 'Bridge runtime settings',
        subtitle: store.configPath,
        searchable: false,
        items: [
          { id: 'default', label: 'Default provider', description: defaultLabel },
          ...providerItems,
          { id: 'save', label: 'Save and apply', description: dirty ? 'Unsaved changes' : 'No changes' },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      if (!selected || selected === 'cancel') return;
      if (selected === 'save') {
        if (!dirty) {
          appendStatic([...formatInfoLine('bridge settings unchanged'), '']);
          return;
        }
        raw.bridge = bridge;
        await persistHadamardSettingsStore(store.configPath, raw);
        await loadJsonConfigFile(store.configPath);
        appendStatic([...formatInfoLine(`bridge settings saved: ${store.configPath}`), '']);
        return;
      }
      if (selected === 'default') {
        const providerChoices = detections.map((d) => ({
          id: d.id,
          label: d.id,
          description: d.available ? (d.version ?? 'detected') : 'not found',
        }));
        const provider = await selectItem({
          title: 'Select default bridge provider',
          searchable: false,
          items: providerChoices,
        });
        if (provider) {
          bridge.defaultProvider = provider;
          dirty = true;
        }
        continue;
      }
      if (selected.startsWith('provider:')) {
        const pid = selected.slice('provider:'.length);
        const providers: Record<string, unknown> = (bridge.providers as Record<string, unknown>) ?? {};
        const entry: Record<string, unknown> = (providers[pid] as Record<string, unknown>) ?? {};
        const pathInput = await promptText({
          title: `Executable path for ${pid}`,
          label: 'Path',
          description: `Leave empty to auto-detect on PATH. Current: ${(entry.path as string) ?? 'auto'}`,
          initial: (entry.path as string) ?? '',
        });
        if (pathInput !== undefined) {
          if (pathInput.trim()) entry.path = pathInput.trim();
          else delete entry.path;
          providers[pid] = entry;
          bridge.providers = providers;
          dirty = true;
        }
        continue;
      }
    }
  }

  function requireActiveExternalCliConfig(action: string): SupportedExternalCliConfig | null {
    const config = activeBridgeConfig;
    if (!bridgeMode || !config) {
      appendStatic([
        ...formatErrorLine(`/bridge ${action} requires an active External CLI config.`),
        ...formatInfoLine('Use /bridge switch <name> to activate an External CLI config.'),
        '',
      ]);
      return null;
    }
    if (config.execution !== 'cli') {
      appendStatic([
        ...formatErrorLine(`/bridge ${action} is available only in External CLI mode.`),
        ...formatInfoLine(`The active config "${config.name}" uses Direct API mode.`),
        '',
      ]);
      return null;
    }
    if (!isManagedExternalCliRuntime(config.runtime)) {
      appendStatic([
        ...formatErrorLine(`External CLI control does not support runtime "${config.runtime}".`),
        ...formatInfoLine('Supported external runtimes: Claude Code, CodeWhale, Pi, Codex, Reasonix, and Crush.'),
        '',
      ]);
      return null;
    }
    return config as SupportedExternalCliConfig;
  }

  function printBridgeStatus(): void {
    if (!activeBridgeConfig) {
      appendStatic([
        `${A.bold}Bridge status${A.reset}`,
        `  ${A.dim}mode${A.reset}       off`,
        `  ${A.dim}background${A.reset} ${externalCliRuntimeManager.list().filter(run => run.hadamardSessionId === session.id && (run.status === 'queued' || run.status === 'running')).length} active`,
        '',
      ]);
      return;
    }

    const config = activeBridgeConfig;
    const activeRuns = externalCliRuntimeManager.list().filter(run =>
      run.hadamardSessionId === session.id
      && (run.status === 'queued' || run.status === 'running'),
    );
    const mode = config.execution === 'cli'
      ? 'External CLI'
      : (config.runtime === 'hadamard' ? 'Hadamard SDK' : 'Direct API');
    const lines = [
      `${A.bold}Bridge status${A.reset}`,
      `  ${A.dim}config${A.reset}     ${config.name}`,
      `  ${A.dim}mode${A.reset}       ${mode}`,
      `  ${A.dim}runtime${A.reset}    ${config.runtime}`,
      `  ${A.dim}model${A.reset}      ${bridgeModelLabel ?? config.model ?? 'runtime default'}`,
    ];
    if (config.execution === 'cli') {
      lines.push(
        `  ${A.dim}auth${A.reset}       ${config.authSource === 'apiKey' ? 'API key override' : 'native CLI login/config'}`,
        `  ${A.dim}cwd${A.reset}        ${sdk.config.workDir}`,
        `  ${A.dim}session${A.reset}    ${activeExternalBridgeRuntime()?.session.id ?? 'not started'}`,
        `  ${A.dim}background${A.reset} ${activeRuns.length} active`,
      );
    } else {
      lines.push(`  ${A.dim}external CLI controls are disabled for this config${A.reset}`);
    }
    lines.push('');
    appendStatic(lines);
  }

  async function printExternalCliHistory(nativeSessionId = ''): Promise<void> {
    const config = requireActiveExternalCliConfig('history');
    if (!config) return;
    try {
      const allSessions = (await listExternalCliSessions({
        runtimes: [config.runtime],
        crushCwd: sdk.config.workDir,
        hadamardHomeDir: sdk.config.homeDir,
      }))
        .filter(item => externalCliSessionMatchesConfig(item, {
          runtime: config.runtime,
          authSource: config.authSource,
          profileName: config.name,
        }, { hadamardHomeDir: sdk.config.homeDir }));
      if (nativeSessionId) {
        const summary = allSessions.find(item => item.nativeSessionId === nativeSessionId);
        if (!summary) {
          appendStatic([
            ...formatErrorLine(`native ${config.runtime} session not found: ${nativeSessionId}`),
            '',
          ]);
          return;
        }
        const nativeSession = await readExternalCliSession(summary.path, {
          detailMaxBytes: 512 * 1024,
          detailMaxMessages: 200,
          crushCwd: sdk.config.workDir,
          hadamardHomeDir: sdk.config.homeDir,
        });
        if (!nativeSession) {
          appendStatic([...formatErrorLine(`native session could not be read: ${nativeSessionId}`), '']);
          return;
        }
        const sourceLabel = externalCliHistorySourceLabel(summary);
        const detailLines: string[] = [
          `${A.bold}${externalCliPreview(nativeSession.summary.title, config) || nativeSessionId}${A.reset}`,
          `${A.dim}${config.runtime}${sourceLabel ? ` \u00b7 ${sourceLabel}` : ''} 路 ${nativeSessionId}${nativeSession.summary.cwd ? ` 路 ${externalCliDisplayText(nativeSession.summary.cwd, config)}` : ''}${A.reset}`,
          ...formatDivider(screen.width),
        ];
        if (nativeSession.truncated) {
          detailLines.push(`${A.dim}bounded transcript preview${A.reset}`, '');
        }
        for (const message of nativeSession.messages) {
          const model = message.model ? ` 路 ${externalCliDisplayText(message.model, config)}` : '';
          detailLines.push(`${A.bold}${message.role}${A.reset}${A.dim}${model}${A.reset}`);
          if (message.text) {
            const safeText = externalCliDisplayText(message.text, config);
            detailLines.push(...wrapToWidth(safeText, Math.max(20, screen.width - 4)).map(line => `  ${line}`));
          }
          if (message.tools?.length) {
            const safeTools = externalCliDisplayText(JSON.stringify(message.tools, null, 2) ?? '', config);
            detailLines.push(...wrapToWidth(safeTools, Math.max(20, screen.width - 4)).map(line => `  ${A.dim}${line}${A.reset}`));
          }
          detailLines.push('');
        }
        detailLines.push(...formatInfoLine(`Use /bridge resume ${nativeSessionId} to continue this native conversation.`), '');
        appendStatic(detailLines);
        return;
      }

      const sessions = allSessions.slice(0, 20);
      const runtimeLabel: Record<typeof config.runtime, string> = {
        claude: 'Claude Code',
        codewhale: 'CodeWhale',
        pi: 'Pi',
        codex: 'Codex',
        reasonix: 'Reasonix',
        crush: 'Crush',
      };
      const lines: string[] = [
        `${A.bold}${runtimeLabel[config.runtime]} native conversations${A.reset}`,
        ...formatDivider(screen.width),
      ];
      if (sessions.length === 0) {
        lines.push(`  ${A.dim}no native conversations found${A.reset}`);
      } else {
        for (const item of sessions) {
          const sourceLabel = externalCliHistorySourceLabel(item);
          lines.push(
            `  ${A.bold}${item.nativeSessionId}${A.reset} ${A.dim}· ${item.updatedAt} · ${item.messageCount} messages${sourceLabel ? ` \u00b7 ${sourceLabel}` : ''}${A.reset}`,
            `    ${externalCliPreview(item.title, config) || '(untitled)'}`,
          );
          if (item.cwd) lines.push(`    ${A.dim}${externalCliDisplayText(item.cwd, config)}${A.reset}`);
        }
      }
      lines.push(
        '',
        ...formatInfoLine('Use /bridge history <native-id> to inspect or /bridge resume <native-id> to continue.'),
        ...formatInfoLine('Credentials and history file paths stay hidden.'),
        '',
      );
      appendStatic(lines);
    } catch (error) {
      appendStatic([
        ...formatErrorLine(`could not read CLI history: ${externalCliDisplayText((error as Error).message, config)}`),
        '',
      ]);
    }
  }

  async function resumeExternalCliHistorySession(nativeSessionId: string): Promise<void> {
    const config = requireActiveExternalCliConfig('resume');
    if (!config) return;
    try {
      const summary = (await listExternalCliSessions({
        runtimes: [config.runtime],
        crushCwd: sdk.config.workDir,
        hadamardHomeDir: sdk.config.homeDir,
      }))
        .find(item => item.nativeSessionId === nativeSessionId && externalCliSessionMatchesConfig(
          item,
          {
            runtime: config.runtime,
            authSource: config.authSource,
            profileName: config.name,
          },
          { hadamardHomeDir: sdk.config.homeDir },
        ));
      if (!summary) {
        appendStatic([
          ...formatErrorLine(`native ${config.runtime} session not found: ${nativeSessionId}`),
          '',
        ]);
        return;
      }
      if (summary.cwd && !sameWorkspace(summary.cwd, sdk.config.workDir)) {
        appendStatic([
          ...formatErrorLine(`open the session workspace before resuming it: ${externalCliDisplayText(summary.cwd, config)}`),
          '',
        ]);
        return;
      }
      const runtimeKey = externalBridgeRuntimeKey(config);
      const existing = externalBridgeRuntimes.get(runtimeKey);
      if (existing) {
        await existing.client.close();
        externalBridgeRuntimes.delete(runtimeKey);
      }
      await rememberExternalNativeSession(config, summary.nativeSessionId);
      await persistSessionRuntimeMetadata(session, config, bridgeModelLabel);
      appendStatic([
        ...formatInfoLine(`native ${config.runtime} session selected: ${summary.nativeSessionId}`),
        ...formatInfoLine('The next message resumes that native conversation.'),
        '',
      ]);
    } catch (error) {
      appendStatic([
        ...formatErrorLine(`could not resume CLI history: ${externalCliDisplayText((error as Error).message, config)}`),
        '',
      ]);
    }
  }

  async function startExternalCliBackgroundRun(prompt: string): Promise<void> {
    const config = requireActiveExternalCliConfig('background');
    if (!config) return;
    const effort = currentEffort();
    const originSession = session;
    const originWorkDir = sdk.config.workDir;
    try {
      const run = await externalCliRuntimeManager.start({
        hadamardSessionId: originSession.id,
        configId: externalCliConfigId(config),
        cwd: originWorkDir,
        prompt,
        background: true,
        nativeSessionId: externalNativeSessionId(config, originSession, originWorkDir),
        clientOptions: {
          directCli: true,
          directCliProvider: config.runtime,
          workDir: sdk.config.workDir,
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
          title: `hadamard-tui-background-${config.runtime}-${config.name}`,
        },
        runOptions: {
          model: bridgeModelLabel ?? config.model,
          includePartialMessages: true,
          permissionMode: currentExternalCliPermissionMode(),
          ...(effort && effort !== 'auto' ? { effort } : {}),
        },
      });
      externalCliRunLabels.set(run.runId, {
        configName: config.name,
        runtime: config.runtime,
      });
      appendStatic([
        ...formatInfoLine(`background run queued · ${run.runId} · ${config.runtime} CLI`),
        ...formatInfoLine('Use /bridge runs to inspect it or /bridge stop <runId> to interrupt it.'),
        '',
      ]);
      void externalCliRuntimeManager.wait(run.runId).then(async completed => {
        if (!completed || shuttingDown) return;
        if (completed.status === 'completed' && completed.result) {
          const completedNativeSessionId = completed.nativeSessionId || completed.result.nativeSessionId;
          if (completedNativeSessionId) {
            await rememberExternalNativeSession(
              config,
              completedNativeSessionId,
              originSession,
              originWorkDir,
            );
          }
          await originSession.appendMessages([
            { role: 'user', content: prompt },
            { role: 'assistant', content: completed.result.text },
          ]);
        }
        const message = completed.status === 'completed'
          ? `background run completed · ${completed.runId}`
          : `background run ${completed.status} · ${completed.runId}${completed.error?.message ? ` · ${externalCliPreview(completed.error.message, config)}` : ''}`;
        appendStatic([...formatInfoLine(message), '']);
      }).catch(() => undefined);
    } catch (error) {
      appendStatic([
        ...formatErrorLine(`could not start background run: ${externalCliDisplayText((error as Error).message, config)}`),
        '',
      ]);
    }
  }

  function printExternalCliRuns(): void {
    const runs = externalCliRuntimeManager.list()
      .filter(run => run.hadamardSessionId === session.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 20);
    const lines: string[] = [
      `${A.bold}External CLI background runs${A.reset}`,
      ...formatDivider(screen.width),
    ];
    if (runs.length === 0) {
      lines.push(`  ${A.dim}no background runs in this TUI session${A.reset}`);
    } else {
      for (const run of runs) {
        const label = externalCliRunLabels.get(run.runId);
        const runtime = label?.runtime ?? 'external';
        const configName = label?.configName ?? 'unknown config';
        const runConfig = label ? findBridgeConfig(label.configName) : undefined;
        lines.push(
          `  ${A.bold}${run.runId}${A.reset} ${A.dim}· ${run.status} · ${runtime} · ${configName}${A.reset}`,
        );
        if (run.nativeSessionId) {
          lines.push(`    ${A.dim}native session: ${run.nativeSessionId}${A.reset}`);
        }
        const result = run.result?.text ? externalCliPreview(run.result.text, runConfig) : '';
        const error = run.error?.message ? externalCliPreview(run.error.message, runConfig) : '';
        if (result) lines.push(`    ${result}`);
        else if (error) lines.push(`    ${A.red}${error}${A.reset}`);
      }
    }
    lines.push('');
    appendStatic(lines);
  }

  function stopExternalCliRun(runId: string): void {
    const run = externalCliRuntimeManager.get(runId);
    if (!run || run.hadamardSessionId !== session.id) {
      appendStatic([...formatErrorLine(`unknown external CLI run: ${runId}`), '']);
      return;
    }
    if (!externalCliRuntimeManager.abort(runId)) {
      appendStatic([...formatInfoLine(`run ${runId} is already ${run.status}`), '']);
      return;
    }
    appendStatic([...formatInfoLine(`stopping background run · ${runId}`), '']);
  }

  async function runBridgePrompt(prompt: string): Promise<void> {
    // /bridge run forces a bridge turn. If no config is active, open the board
    // (or error if none saved) rather than auto-picking a detected runtime.
    if (!bridgeMode || !activeBridgeConfig) {
      const configs = readBridgeConfigs().configs;
      if (configs.length === 0) {
        appendStatic([...formatErrorLine('No bridge configs saved. Use /bridge config to add one.'), '']);
        return;
      }
      appendStatic([...formatInfoLine('No active bridge config — select one from the board.'), '']);
      return;
    }
    await startRun(prompt);
  }

  async function disableBridge(): Promise<void> {
    // Switch back to the SDK's default model/provider. The conversation
    // context stays intact (same session). Config stays saved for re-activation.
    clearBridgeSelection();
    await persistSessionRuntimeMetadata();
    appendStatic([
      ...formatInfoLine('bridge mode off — back to default provider (session intact)'),
      '',
    ]);
  }

  function printBridgeHelp(): void {
    appendStatic([
      ...formatInfoLine('/bridge sub-commands:'),
      `  ${A.dim}(bare)${A.reset}       — list saved configs; pick one to activate`,
      `  ${A.dim}config${A.reset}      — add / edit / remove named connection configs`,
      `  ${A.dim}run <prompt>${A.reset}  — run one turn through the active runtime`,
      `  ${A.dim}background <prompt>${A.reset} — start work in the active external CLI`,
      `  ${A.dim}runs${A.reset}        — list external CLI background runs`,
      `  ${A.dim}stop <runId>${A.reset} — interrupt a background run`,
      `  ${A.dim}status${A.reset}      — show execution, runtime, auth source, and session`,
      `  ${A.dim}history [native-id]${A.reset} — list or inspect native CLI conversations (paths hidden)`,
      `  ${A.dim}resume <native-id>${A.reset} — resume a native CLI conversation in this workspace`,
      `  ${A.dim}switch <name>${A.reset} — activate a saved config by name (or a raw provider id)`,
      `  ${A.dim}model [id]${A.reset} — set model for the current runtime`,
      `  ${A.dim}setup${A.reset}      — detect + configure paths (legacy)`,
      `  ${A.dim}off${A.reset}        — disable bridge mode`,
      `  ${A.dim}help${A.reset}       — show this list`,
        ...formatInfoLine('External CLI commands support every registered CLI runtime.'),
      ...formatInfoLine('Native auth lets each CLI read its own login/config; key overrides are'),
      ...formatInfoLine('injected into child processes and never printed in status or run output.'),
      ...formatInfoLine('Direct API configs keep using the existing in-process bridge path.'),
      '',
    ]);
  }

  async function openBridgeBoard(): Promise<void> {
    // The /bridge board lists SAVED connection configs (the user's presets).
    // Selecting one activates that runtime with the config's credentials
    // injected. No-config fallbacks (legacy provider switch, setup, detect)
    // live under the actions so nothing is lost.
    const configs = readBridgeConfigs().configs;
    const state = bridgeMode
      ? `${A.green}(active)${A.reset}`
      : `${A.dim}(idle)${A.reset}`;
    const activeCfg = activeBridgeConfig?.name ?? (bridgeMode ? 'active' : null);
    const lines: string[] = [
      `Bridge ${state}${activeCfg ? ` · ${A.bold}${activeCfg}${A.reset}` : ''}`,
      ...formatDivider(screen.width),
    ];
    if (configs.length === 0) {
      lines.push(`  ${A.dim}no saved configs — use "/bridge config" to add one${A.reset}`);
    } else {
      for (const c of configs) {
        const active = activeBridgeConfig?.name === c.name;
        const mark = active ? `${A.green}●${A.reset}` : `${A.dim}○${A.reset}`;
        const mode = c.execution === 'cli' ? 'External CLI' : (c.runtime === 'hadamard' ? 'Hadamard SDK' : 'Direct API');
        lines.push(`  ${mark} ${A.bold}${c.name}${A.reset} ${A.dim}· ${mode} · ${c.runtime}${A.reset}${c.model ? ` ${A.dim}· ${c.model}${A.reset}` : ''}`);
        lines.push(`      ${A.dim}${c.execution === 'cli' && c.authSource === 'native' ? 'auth: CLI login' : 'key: ' + maskApiKey(c.apiKey)}${c.baseURL ? ` · ${c.baseURL}` : ''}${A.reset}`);
      }
    }
    lines.push('');
    appendStatic(lines);

    const choice = await selectItem({
      title: 'Bridge',
      subtitle: activeCfg ? `active: ${activeCfg}` : 'no active config',
      searchable: false,
      items: [
        // One item per saved config → selecting activates it.
        ...configs.map(c => ({
          id: `c:${c.name}`,
          label: `${c.name}${activeBridgeConfig?.name === c.name ? ' *' : ''}`,
          description: `${c.execution === 'cli' ? 'External CLI' : 'Direct API'} · ${c.runtime}${c.execution === 'cli' ? ` · ${c.authSource === 'native' ? 'CLI login' : 'key override'}` : ''}${c.model ? ` · ${c.model}` : ''}`,
        })),
        { id: 'config', label: '⚙ Manage configs…', description: 'add / edit / remove saved configs' },
        { id: 'run', label: '▶ Run a prompt…', description: 'run one turn through the active runtime' },
        { id: 'model', label: '◈ Model', description: 'set model for the active runtime' },
        { id: 'setup', label: '✎ Edit paths…', description: 'per-provider executable + default (legacy)' },
        { id: 'detect', label: '↻ Re-detect runtimes', description: 're-scan PATH for installed CLIs' },
        ...(bridgeMode ? [{ id: 'off', label: '■ Disable bridge', description: 'back to in-process SDK' }] : []),
        { id: 'help', label: '? Help', description: 'show /bridge sub-commands' },
      ],
    });
    if (!choice) return;
    if (choice.startsWith('c:')) {
      const name = choice.slice(2);
      const cfg = configs.find(c => c.name === name);
      if (cfg) await activateBridgeConfig(cfg);
      return;
    }
    if (choice === 'config') { await manageBridgeConfigs(); return; }
    if (choice === 'run') {
      const task = await promptText({ title: 'Bridge run', label: 'Prompt' });
      if (task?.trim()) await runBridgePrompt(task.trim());
      return;
    }
    if (choice === 'model') { await selectBridgeModel(); return; }
    if (choice === 'setup') { await configureBridgeSettings(); return; }
    if (choice === 'detect') {
      const refreshed = await detectBridgeProviders();
      appendStatic(['', ...refreshed.map((d) => `${d.available ? '✔' : '✘'} ${d.id} ${d.version ?? ''}`), '']);
      return;
    }
    if (choice === 'off') { await disableBridge(); return; }
    if (choice === 'help') { printBridgeHelp(); return; }
  }

  // Activate a named bridge config — the in-process path. Pre-builds a ModelApi
  // via buildRouteModelApi so each turn can inject {model, modelApi} into
  // session.stream (same session, context naturally survives switching).
  async function activateBridgeConfig(config: PersistedBridgeConfig): Promise<boolean> {
    try {
      if (config.execution === 'cli') {
        if (!isManagedExternalCliRuntime(config.runtime)) {
          throw new Error(
            'External CLI mode requires an installed CLI runtime.',
          );
        }
        const externalConfig = config as SupportedExternalCliConfig;
        const fingerprint = externalBridgeFingerprint(externalConfig);
        const runtimeKey = externalBridgeRuntimeKey(externalConfig);
        let runtime = externalBridgeRuntimes.get(runtimeKey);
        if (runtime && runtime.fingerprint !== fingerprint) {
          await runtime.client.close();
          externalBridgeRuntimes.delete(runtimeKey);
          runtime = undefined;
        }
        const boundNativeSessionId = externalNativeSessionId(externalConfig);
        const resumed = Boolean(runtime || boundNativeSessionId);
        if (!runtime) {
          const client = await createHadamardBridgeSdk({
            directCli: true,
            directCliProvider: config.runtime,
            workDir: sdk.config.workDir,
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
          });
          const sessionOptions = { title: 'hadamard-tui-' + config.runtime + '-' + config.name };
          const nativeSession = boundNativeSessionId
            ? await client.resumeSession(boundNativeSessionId, sessionOptions)
            : await client.createSession(sessionOptions);
          runtime = { client, session: nativeSession, fingerprint };
          externalBridgeRuntimes.set(runtimeKey, runtime);
        }
        activeBridgeModelApi = null;
        bridgeModelLabel = config.model ?? null;
        activeBridgeConfig = config;
        bridgeMode = true;
        await persistSessionRuntimeMetadata(session, config, bridgeModelLabel);
        appendStatic([
          ...formatInfoLine(
            'runtime active — '
              + config.runtime
              + ' CLI · '
              + (config.authSource === 'apiKey' ? 'API key override' : 'native CLI login')
              + ' · model: '
              + (config.model ?? 'runtime default')
              + (resumed ? ' · resumed' : ''),
          ),
          ...formatInfoLine(
            'working directory: ' + sdk.config.workDir + ' · native session: ' + runtime.session.id,
          ),
          '',
        ]);
        return true;
      }

      const hadamardUsesDefaults = config.runtime === 'hadamard'
        && !config.apiKey?.trim()
        && !config.baseURL?.trim();
      if (hadamardUsesDefaults) {
        activeBridgeModelApi = null;
        bridgeModelLabel = config.model ?? null;
        activeBridgeConfig = config;
        bridgeMode = false;
        await persistSessionRuntimeMetadata(session, config, bridgeModelLabel);
        appendStatic([
          ...formatInfoLine('Hadamard SDK active · model: ' + (config.model ?? session.model)),
          '',
        ]);
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
      await persistSessionRuntimeMetadata(session, config, bridgeModelLabel);
      appendStatic([
        ...formatInfoLine(`bridge active — config: ${config.name} · provider: ${config.provider} · model: ${routed.model}`),
        ...formatInfoLine(`apiKey: ${maskApiKey(config.apiKey)}${config.baseURL ? ` · baseURL: ${config.baseURL}` : ''}`),
        ...formatInfoLine(`normal prompts now run through ${config.name}; /bridge off switches back to the default provider`),
        '',
      ]);
      return true;
    } catch (error) {
      appendStatic([...formatErrorLine(`bridge activation failed: ${(error as Error).message}`), '']);
      return false;
    }
  }

  // /bridge config — manage named connection configs (the management screen).
  async function manageBridgeConfigs(): Promise<void> {
    while (true) {
      const store = readBridgeConfigs();
      const lines: string[] = [
        `${A.bold}Bridge configs${A.reset} ${A.dim}(~/.hadamard/bridge-configs.json)${A.reset}`,
      ];
      if (store.configs.length === 0) {
        lines.push(`  ${A.dim}no configs yet — add one to connect a runtime by name${A.reset}`);
      } else {
        for (const c of store.configs) {
          const active = activeBridgeConfig?.name === c.name;
          const star = active ? ` ${A.green}*${A.reset}` : '';
          lines.push(`  ${A.bold}${c.name}${A.reset} ${A.dim}· ${c.provider}${A.reset}${star}`);
          lines.push(`    ${A.dim}key: ${maskApiKey(c.apiKey)}${c.baseURL ? ` · ${c.baseURL}` : ''}${c.model ? ` · ${c.model}` : ''}${A.reset}`);
        }
      }
      lines.push('');
      appendStatic(lines);

      const choice = await selectItem({
        title: 'Bridge configs',
        searchable: false,
        items: [
          { id: 'add', label: '+ Add config…', description: 'open the config editor with empty fields' },
          ...(store.configs.length > 0
            ? [
                { id: 'edit', label: '✎ Edit config…', description: 'modify any field of a saved config' },
                { id: 'remove', label: '− Remove config…', description: 'delete a saved config' },
              ]
            : []),
          { id: 'back', label: '↩ Back', description: 'return to the prompt' },
        ],
      });
      if (!choice || choice === 'back') return;
      if (choice === 'add') {
        const created = await editBridgeConfig();
        if (created) {
          addBridgeConfig(created);
          appendStatic([...formatInfoLine(`saved config "${created.name}" — select it via /bridge to activate`), '']);
        }
        continue;
      }
      if (choice === 'edit') {
        const name = await selectItem({
          title: 'Edit config',
          searchable: false,
          items: store.configs.map(c => ({ id: c.name, label: c.name, description: `${c.provider} · ${maskApiKey(c.apiKey)}` })),
        });
        if (!name) continue;
        const existing = store.configs.find(c => c.name === name)!;
        const updated = await editBridgeConfig(existing);
        if (updated) {
          const wasActive = activeBridgeConfig?.name === existing.name
            || activeBridgeConfig?.name === updated.name;
          const previousRuntimeKey = wasActive
            && activeBridgeConfig?.execution === 'cli'
        && isManagedExternalCliRuntime(activeBridgeConfig.runtime)
            ? externalBridgeRuntimeKey(activeBridgeConfig as SupportedExternalCliConfig)
            : undefined;
          addBridgeConfig(updated); // dedupe-by-name replaces
          if (wasActive) {
            if (await activateBridgeConfig(updated)) {
              const nextRuntimeKey = updated.execution === 'cli'
        && isManagedExternalCliRuntime(updated.runtime)
                ? externalBridgeRuntimeKey(updated as SupportedExternalCliConfig)
                : undefined;
              if (previousRuntimeKey && previousRuntimeKey !== nextRuntimeKey) {
                const previousRuntime = externalBridgeRuntimes.get(previousRuntimeKey);
                await previousRuntime?.client.close().catch(() => undefined);
                externalBridgeRuntimes.delete(previousRuntimeKey);
              }
              appendStatic([...formatInfoLine(`active config "${updated.name}" updated and reactivated`), '']);
            }
          } else {
            appendStatic([...formatInfoLine(`config "${updated.name}" saved`), '']);
          }
        }
        continue;
      }
      if (choice === 'remove') {
        const name = await selectItem({
          title: 'Remove config',
          searchable: false,
          items: store.configs.map(c => ({ id: c.name, label: c.name, description: `${c.provider} · ${maskApiKey(c.apiKey)}` })),
        });
        if (!name) continue;
        removeBridgeConfig(name);
        if (activeBridgeConfig?.name === name) {
          await disableBridge();
          appendStatic([...formatInfoLine(`removed active config "${name}" and disabled bridge mode`), '']);
        } else {
          appendStatic([...formatInfoLine(`removed config "${name}"`), '']);
        }
        continue;
      }
    }
  }

  // Single-page config editor: shows ALL fields at once (with current values),
  // and the user can edit any field in any order — e.g. set the key, then go
  // back and change the name — before Save / Cancel. A field is selected via the
  // menu, re-prompted, then the loop re-renders the whole form with the new
  // value. Returns the config on Save, undefined on Cancel.
  async function editBridgeConfig(existing?: PersistedBridgeConfig): Promise<PersistedBridgeConfig | undefined> {
    // Work on a local copy so Cancel discards all edits.
    const draft: PersistedBridgeConfig = existing
      ? {
          name: existing.name,
          provider: existing.provider,
          runtime: existing.runtime,
          execution: existing.execution ?? 'api',
          authSource: existing.authSource ?? 'apiKey',
          ...(existing.apiKey ? { apiKey: existing.apiKey } : {}),
          ...(existing.baseURL ? { baseURL: existing.baseURL } : {}),
          ...(existing.model ? { model: existing.model } : {}),
          ...(existing.credentialProvider ? { credentialProvider: existing.credentialProvider } : {}),
          ...(existing.trustProjectResources ? { trustProjectResources: true } : {}),
        }
      : {
          name: '',
          provider: 'anthropic',
          runtime: 'claude',
          execution: 'cli',
          authSource: 'native',
        };

    // Lazy-detect: runtimes are probed only when the user opens the runtime
    // picker, so the form renders instantly. Cached after first probe.
    let detections: Awaited<ReturnType<typeof detectBridgeProviders>> | null = null;

    while (true) {
      // Render the live form.
      const header = existing ? `Editing "${existing.name}"` : 'New bridge config';
      const lines: string[] = [
        `${A.bold}${header}${A.reset} — edit any field, then Save`,
        ...formatDivider(screen.width),
        `  ${A.bold}name${A.reset}     ${draft.name || `${A.dim}(unset)${A.reset}`}`,
        `  ${A.bold}execution${A.reset} ${draft.execution === 'cli' ? 'External CLI' : (draft.runtime === 'hadamard' ? 'Hadamard SDK' : 'Direct API')}`,
        `  ${A.bold}runtime${A.reset}   ${A.bold}${draft.runtime}${A.reset} ${A.dim}(${draft.provider})${A.reset}`,
        `  ${A.bold}auth${A.reset}      ${draft.execution === 'cli' ? (draft.authSource === 'native' ? 'reuse CLI login' : 'API key override') : 'API adapter credentials'}`,
        `  ${A.bold}apiKey${A.reset}   ${maskApiKey(draft.apiKey)}`,
        `  ${A.bold}baseURL${A.reset} ${draft.baseURL || `${A.dim}(inherit)${A.reset}`}`,
        `  ${A.bold}key provider${A.reset} ${draft.credentialProvider || `${A.dim}(infer from model/runtime)${A.reset}`}`,
        `  ${A.bold}project config${A.reset} ${draft.trustProjectResources ? 'trusted' : 'not trusted'}`,
        `  ${A.bold}model${A.reset}    ${draft.model || `${A.dim}(inherit)${A.reset}`}`,
        '',
      ];
      appendStatic(lines);

      const choice = await selectItem({
        title: existing ? `Edit ${existing.name}` : 'New config',
        subtitle: 'edit any field in any order · Save to commit',
        searchable: false,
        items: [
          { id: 'name', label: `name: ${draft.name || '(unset)'}`, description: 'a label you pick, e.g. deepseek-claude' },
          { id: 'execution', label: `execution: ${draft.execution === 'cli' ? 'External CLI' : 'Direct API'}`, description: 'launch an installed CLI or use Hadamard API adapters' },
          { id: 'provider', label: `runtime: ${draft.runtime}`, description: `${draft.provider} · pick from detected runtimes` },
          { id: 'auth', label: `auth: ${draft.authSource === 'native' ? 'reuse CLI login' : 'API key override'}`, description: draft.execution === 'cli' ? 'credential source for the child CLI' : 'used by External CLI mode' },
          { id: 'apiKey', label: `apiKey: ${maskApiKey(draft.apiKey)}`, description: 'injected as the credential each turn (hidden input)' },
          { id: 'baseURL', label: `baseURL: ${draft.baseURL || '(inherit)'}`, description: 'the backend endpoint (e.g. https://api.deepseek.com)' },
          { id: 'credentialProvider', label: `key provider: ${draft.credentialProvider || '(infer)'}`, description: 'provider env mapping for multi-backend CLIs, e.g. openai, anthropic, deepseek' },
          { id: 'trustProjectResources', label: `project config: ${draft.trustProjectResources ? 'trusted' : 'not trusted'}`, description: 'allow runtime-specific project config; required for explicit-key Crush when config exists' },
          { id: 'model', label: `model: ${draft.model || '(inherit)'}`, description: 'optional model id' },
          { id: 'save', label: '💾 Save config', description: draft.name ? `commit "${draft.name}"` : 'a name is required to save' },
          { id: 'cancel', label: '✕ Cancel', description: 'discard changes' },
        ],
      });
      if (!choice || choice === 'cancel') return undefined;
      if (choice === 'save') {
        const name = draft.name.trim();
        if (!name) {
          appendStatic([...formatErrorLine('cannot save — name is required (edit the name field first)'), '']);
          continue;
        }
        if (draft.execution === 'cli' && !isManagedExternalCliRuntime(draft.runtime)) {
          appendStatic([
            ...formatErrorLine('External CLI mode requires a registered CLI runtime.'),
            '',
          ]);
          continue;
        }
        if (draft.execution === 'cli' && draft.authSource === 'apiKey' && !draft.apiKey) {
          appendStatic([
            ...formatErrorLine('API-key override requires an API key.'),
            '',
          ]);
          continue;
        }
        const config: PersistedBridgeConfig = {
          name,
          provider: draft.provider,
          runtime: draft.runtime,
          execution: draft.execution,
          authSource: draft.authSource,
        };
        if (draft.apiKey) config.apiKey = draft.apiKey;
        if (draft.baseURL) config.baseURL = draft.baseURL;
        if (draft.model) config.model = draft.model;
        if (draft.credentialProvider) config.credentialProvider = draft.credentialProvider;
        if (draft.trustProjectResources) config.trustProjectResources = true;
        return config;
      }
      if (choice === 'name') {
        const v = (await promptText({ title: 'Config name', label: 'name', initial: draft.name, description: 'a label you pick, e.g. deepseek-claude' }))?.trim();
        if (v !== undefined) draft.name = v;
        continue;
      }
      if (choice === 'execution') {
        const v = await selectItem({
          title: 'Execution mode',
          subtitle: 'API mode stays in Hadamard; CLI mode launches the installed runtime',
          searchable: false,
          items: [
            { id: 'cli', label: 'External CLI', description: 'Managed CLI child process with native session resume' },
            { id: 'api', label: 'Direct API', description: 'Hadamard provider adapter; no external CLI process' },
          ],
        });
        if (v === 'cli') {
          if (!isManagedExternalCliRuntime(draft.runtime)) {
            appendStatic([
              ...formatErrorLine('External CLI mode requires a registered CLI runtime.'),
              '',
            ]);
          } else {
            draft.execution = 'cli';
            draft.authSource = draft.authSource ?? 'native';
          }
        } else if (v === 'api') {
          draft.execution = 'api';
          draft.authSource = 'apiKey';
        }
        continue;
      }
      if (choice === 'auth') {
        if (draft.execution !== 'cli') {
          appendStatic([
            ...formatInfoLine('Authentication source applies to External CLI mode.'),
            '',
          ]);
          continue;
        }
        const v = await selectItem({
          title: 'CLI authentication',
          subtitle: 'Native login never copies credentials into Hadamard',
          searchable: false,
          items: [
            { id: 'native', label: 'Reuse CLI login / config', description: 'inherit HOME and let the CLI read its own credentials' },
            { id: 'apiKey', label: 'API key override', description: 'inject this config key into the child process only' },
          ],
        });
        if (v === 'native' || v === 'apiKey') draft.authSource = v;
        continue;
      }
      if (choice === 'provider') {
        // Show detected runtimes as the primary options; each maps to an
        // in-process provider. Detection is lazy — probed only when the user
        // opens this picker, so the form renders instantly.
        if (!detections) {
          detections = await withSpinner('scanning for runtimes', detectBridgeProviders);
        }
        const RUNTIME_MAP: Record<string, { provider: InProcessProvider; label: string }> = {
          claude: { provider: 'anthropic', label: 'claude' },
          codewhale: { provider: 'anthropic', label: 'codewhale' },
          reasonix: { provider: 'openai', label: 'reasonix' },
          pi: { provider: 'openai', label: 'pi' },
          codex: { provider: 'openai', label: 'codex' },
          crush: { provider: 'openai', label: 'crush' },
        };
        const curProvider = draft.provider;
        const curRuntime = draft.runtime;
        const items = detections.map(d => ({
          id: d.id,
          label: `${d.id}${d.id === curRuntime ? ' ✓' : ''}`,
          description: `${RUNTIME_MAP[d.id]?.provider ?? '?'}${d.available ? (d.version ? ` · v${d.version}` : ' · detected') : ' · not found'}${d.id === 'reasonix' ? ' · DeepSeek' : d.id === 'crush' ? ' · multi-backend' : ''}`,
        }));
        const v = await selectItem({
          title: 'Runtime',
          subtitle: curRuntime ? `current: ${curRuntime} (${curProvider})` : `current provider: ${curProvider}`,
          searchable: false,
          items,
        });
        if (v) {
          const mapped = RUNTIME_MAP[v] ?? { provider: 'anthropic' as InProcessProvider };
          draft.provider = mapped.provider;
          draft.runtime = v as PersistedBridgeConfig['runtime'];
        }
        continue;
      }
      if (choice === 'apiKey') {
        const initial = draft.apiKey;
        const v = await promptText({
          title: 'API key',
          label: 'api key',
          secret: true,
          initial,
          description: 'hidden input · clear to inherit from settings',
        });
        if (v !== undefined) draft.apiKey = v.trim() || undefined;
        continue;
      }
      if (choice === 'baseURL') {
        const v = (await promptText({ title: 'Base URL', label: 'base url', initial: draft.baseURL, description: 'the backend endpoint; leave empty to inherit' }))?.trim();
        if (v !== undefined) draft.baseURL = v || undefined;
        continue;
      }
      if (choice === 'credentialProvider') {
        const v = (await promptText({
          title: 'Credential provider',
          label: 'provider id',
          initial: draft.credentialProvider,
          description: 'openai, anthropic, deepseek, gemini, openrouter, etc.; leave empty to infer',
        }))?.trim();
        if (v !== undefined) draft.credentialProvider = v || undefined;
        continue;
      }
      if (choice === 'trustProjectResources') {
        const v = await selectItem({
          title: 'Project runtime config',
          subtitle: 'Project-local runtime files may change provider/tool behavior',
          searchable: false,
          items: [
            { id: 'no', label: 'Do not trust', description: 'use runtime defaults and managed credentials where supported' },
            { id: 'yes', label: 'Trust project config', description: 'allow project-local CLI resources and configuration' },
          ],
        });
        if (v === 'yes' || v === 'no') draft.trustProjectResources = v === 'yes';
        continue;
      }
      if (choice === 'model') {
        const v = (await promptText({
          title: 'Model',
          label: 'model',
          initial: draft.model,
          description: 'a model id (optional, e.g. deepseek-chat, claude-sonnet-4-6)',
        }))?.trim();
        if (v !== undefined) draft.model = v || undefined;
        continue;
      }
    }
  }

  async function switchBridgeProvider(target: string): Promise<void> {
    if (!target) {
      appendStatic([...formatInfoLine('usage: /bridge switch <config-name>  (or open /bridge to pick)'), '']);
      return;
    }
    const cfg = findBridgeConfig(target);
    if (cfg) {
      await activateBridgeConfig(cfg);
      return;
    }
    appendStatic([...formatErrorLine(`unknown config: ${target} — use /bridge config to add one, or open /bridge to pick`), '']);
  }

  async function selectBridgeModel(modelId = ''): Promise<void> {
    const cfgName = activeBridgeConfig?.name ?? 'active';
    if (modelId) {
      // Direct set: /bridge model claude-sonnet-4-6
      bridgeModelLabel = modelId;
      if (activeBridgeConfig) activeBridgeConfig = { ...activeBridgeConfig, model: modelId };
      await persistSessionRuntimeMetadata();
      appendStatic([...formatInfoLine(`bridge model → ${modelId}`), '']);
      return;
    }

    // Picker: prompt for a model ID.
    const v = (await promptText({
      title: `Bridge model for ${cfgName}`,
      label: 'Model ID',
      initial: bridgeModelLabel ?? '',
      description: 'enter the model id to use with the bridge config',
    }));
    if (v !== undefined) {
      bridgeModelLabel = v.trim() || null;
      if (activeBridgeConfig) {
        activeBridgeConfig = {
          ...activeBridgeConfig,
          ...(bridgeModelLabel ? { model: bridgeModelLabel } : { model: undefined }),
        };
      }
      await persistSessionRuntimeMetadata();
      appendStatic([...formatInfoLine(`bridge model → ${bridgeModelLabel || 'session default'}`), '']);
    }
  }

  async function chooseEffort(): Promise<void> {
    const selected = await selectItem({
      title: 'Select reasoning effort',
      subtitle: `Current: ${currentEffort() ?? 'auto'}`,
      searchable: false,
      items: [
        { id: 'auto', label: 'auto', description: 'Use the runtime default' },
        { id: 'low', label: 'low', description: 'Fast, direct reasoning' },
        { id: 'medium', label: 'medium', description: 'Balanced reasoning' },
        { id: 'high', label: 'high', description: 'Deeper reasoning and verification' },
        { id: 'max', label: 'max', description: 'Maximum supported reasoning effort' },
      ],
    });
    if (selected) await setEffort(selected);
  }

  async function setEffort(value: string): Promise<void> {
    if (value !== 'auto' && !isHadamardEffort(value)) {
      appendStatic([...formatErrorLine(`unknown effort: ${value}`), '']);
      return;
    }
    await session.mergeMetadata({
      [SESSION_EFFORT_KEY]: value,
    });
    appendStatic([...formatInfoLine(`effort set to: ${currentEffort() ?? 'auto'}`), '']);
  }

  async function chooseToolPresentation(): Promise<void> {
    const current = readSessionToolPresentation(session.metadata) ?? projectSettings.toolPresentation ?? 'native';
    const selected = await selectItems({
      title: 'Tool presentation',
      subtitle: `Current: ${current} · Enter confirms`,
      checkedIds: [current],
      items: [
        { id: 'native', label: 'Native', description: 'every tool schema sent directly' },
        { id: 'ptc', label: 'PTC', description: 'one stateless run_code program + typed SDK (requires CodeAct enabled)' },
        { id: 'both', label: 'Both', description: 'native tools plus the run_code wire tool' },
      ],
    });
    if (!selected || selected.length === 0) return;
    const mode = selected[0];
    if (mode !== 'native' && mode !== 'ptc' && mode !== 'both') return;
    await session.mergeMetadata(sessionToolPresentationPatch(mode));
    appendStatic([...formatInfoLine(`tool presentation set to: ${mode}`), '']);
  }

  async function chooseAgentMode(): Promise<void> {
    const current = currentAgentMode();
    const checks = agentModeToChecks(current);
    const selected = await selectItems({
      title: 'Agent execution mode',
      subtitle: `Current: ${current} · Space toggles · Enter confirms`,
      checkedIds: [checks.react ? 'react' : '', checks.codeact ? 'codeact' : ''].filter(Boolean),
      items: [
        { id: 'react', label: 'ReAct', description: 'ordinary JSON tools and iterative observation' },
        { id: 'codeact', label: 'CodeAct', description: 'persistent Python CodeCell execution' },
      ],
    });
    if (!selected) return;
    try {
      const mode = agentModeFromChecks({
        react: selected.includes('react'),
        codeact: selected.includes('codeact'),
      });
      await session.mergeMetadata(sessionAgentModePatch(mode));
      appendStatic([...formatInfoLine(`agent mode set to: ${mode}`), '']);
    } catch (error) {
      appendStatic([...formatErrorLine((error as Error).message), '']);
    }
  }

  // ── /goal: project-scoped goal managed by the shared GoalService ─────
  // The service is the single authority over goal lifecycle (see plan/13
  // P0.2); the TUI only reads and steers it (create/clear/pause/resume).
  // Complete/blocked are runtime-only transitions, set via the Goal tools.
  function goalContextLine(): string {
    // Normalize through the shared Goal schema while keeping status rendering
    // synchronous over the already-cached Session metadata.
    const goal = sdk.goals.peek(session.id);
    if (!goal) return '';
    const marks: Record<string, string> = {
      active: `${A.green}▶${A.reset}`,
      paused: `${A.yellow}‖${A.reset}`,
      complete: `${A.dim}✓${A.reset}`,
      blocked: `${A.red}⊘${A.reset}`,
    };
    const mark = marks[goal.status ?? 'active'] ?? '';
    return ` · goal:${mark}${A.dim}${truncateToWidth(goal.objective, 30)}${A.reset}`;
  }

  async function showSkills(): Promise<void> {
    const skills = sdk.skills.listMetadata();
    if (skills.length === 0) {
      appendStatic([...formatInfoLine('no skills are registered'), '']);
      return;
    }
    const selected = await selectItem({
      title: 'Skills',
      items: skills.map(skill => ({
        id: skill.name,
        label: skill.displayName ? `${skill.displayName} (${skill.name})` : skill.name,
        description: `${skill.source} · ${skill.context}${skill.version ? ` · v${skill.version}` : ''}`,
        detail: `${skill.description} ${skill.whenToUse ?? ''}`,
      })),
    });
    const skill = skills.find(item => item.name === selected);
    if (skill) {
      const heading = skill.displayName ? `${skill.displayName} (/${skill.name})` : `/${skill.name}`;
      const ver = skill.version ? ` v${skill.version}` : '';
      appendStatic([
        `${A.cyan}${heading}${A.reset}${A.dim}${ver}${A.reset} ${skill.description}`,
        `${A.dim}${skill.whenToUse ?? `source: ${skill.source} · context: ${skill.context}`}${A.reset}`,
        '',
      ]);
    }
  }

  async function showAgents(): Promise<void> {
    const agents = sdk.agents.list();
    if (agents.length === 0) {
      appendStatic([...formatInfoLine('no subagents are registered'), '']);
      return;
    }
    const selected = await selectItem({
      title: 'Subagents',
      items: agents.map(agent => ({
        id: agent.name,
        label: agent.name,
        description: agent.model ?? 'inherits model',
        detail: agent.description,
      })),
    });
    const agent = agents.find(item => item.name === selected);
    if (agent) {
      appendStatic([
        `${A.cyan}${agent.name}${A.reset} ${agent.description}`,
        `${A.dim}model: ${agent.model ?? 'inherit'} · tools: ${agent.inheritDefaultTools ? 'inherit' : agent.toolNames.join(', ') || 'none'}${A.reset}`,
        '',
      ]);
    }
  }

  function flattenAgentExecutionNodes(view: AgentExecutionRootView): AgentExecutionNodeView[] {
    const nodes: AgentExecutionNodeView[] = [];
    const visit = (node: AgentExecutionNodeView): void => {
      nodes.push(node);
      node.children.forEach(visit);
    };
    if (view.root) visit(view.root);
    view.detached.forEach(visit);
    return nodes;
  }

  function formatAgentExecutionElapsed(elapsedMs: number): string {
    if (elapsedMs < 1_000) return `${elapsedMs}ms`;
    if (elapsedMs < 60_000) return `${Math.round(elapsedMs / 100) / 10}s`;
    return `${Math.floor(elapsedMs / 60_000)}m ${Math.round((elapsedMs % 60_000) / 1_000)}s`;
  }

  async function openAgentExecutionConversation(reference: string): Promise<void> {
    let snapshots;
    try {
      snapshots = await sdk.executions.listSnapshots();
    } catch (error) {
      appendStatic([...formatErrorLine(`could not load Agent executions: ${(error as Error).message}`), '']);
      return;
    }
    const views = snapshots.map(snapshot => createAgentExecutionRootView(snapshot));
    const node = views.flatMap(flattenAgentExecutionNodes).find(
      item => item.id === reference || item.sessionId === reference,
    );
    if (!node) {
      appendStatic([
        ...formatErrorLine(`No Agent execution or conversation matches '${reference}'. Use /agents runs to browse.`),
        '',
      ]);
      return;
    }
    await resumeSession(node.sessionId, { allowAgent: true });
  }

  async function showAgentExecution(rootExecutionId: string): Promise<void> {
    let snapshot;
    try {
      snapshot = await sdk.executions.getSnapshot(rootExecutionId);
    } catch (error) {
      appendStatic([...formatErrorLine(`could not load Agent execution: ${(error as Error).message}`), '']);
      return;
    }
    if (!snapshot) {
      appendStatic([
        ...formatErrorLine(`No Agent execution tree found for '${rootExecutionId}'. Use /agents runs to browse.`),
        '',
      ]);
      return;
    }
    const view = createAgentExecutionRootView(snapshot);
    const nodes = flattenAgentExecutionNodes(view);
    appendStatic([
      `${A.bold}Agent execution${A.reset} ${A.dim}${view.rootExecutionId}${A.reset}`,
      `${A.dim}${view.status} · ${view.nodeCount} agents · ${view.edgeCount} links · ${formatAgentExecutionElapsed(view.timing.elapsedMs)}${A.reset}`,
      ...formatAgentExecutionTreeLines(view, {
        prefix: '  ',
        includeActivity: true,
        includePlan: true,
        includeTiming: true,
        maxMetaWidth: Math.max(36, screen.width - 12),
      }),
      '',
    ]);
    if (nodes.length === 0) return;
    const selected = await selectItem({
      title: 'Agent execution conversations',
      subtitle: 'Choose an Agent or subagent to open its independent conversation',
      items: nodes.map(node => ({
        id: node.id,
        label: `${'  '.repeat(node.depth)}${node.displayName}`,
        description: `${node.status} · ${node.runtime}${node.model ? ` · ${node.model}` : ''}`,
        detail: [
          `session: ${node.sessionId}`,
          node.currentActivity?.summary,
          node.currentStep ? `current: ${node.currentStep.title}` : undefined,
          node.nextSteps.length ? `next: ${node.nextSteps.slice(0, 3).map(step => step.title).join(', ')}` : undefined,
        ].filter((value): value is string => Boolean(value)).join('\n'),
      })),
    });
    if (selected) await openAgentExecutionConversation(selected);
  }

  async function showAgentRuns(): Promise<void> {
    let snapshots;
    try {
      snapshots = await sdk.executions.listSnapshots();
    } catch (error) {
      appendStatic([...formatErrorLine(`could not load Agent executions: ${(error as Error).message}`), '']);
      return;
    }
    const project = createAgentExecutionProjectView(snapshots);
    if (project.totalExecutionCount === 0) {
      appendStatic([...formatInfoLine('no Agent executions are recorded for this project'), '']);
      return;
    }
    const summary = (label: string, executions: AgentExecutionRootView[]): string[] => [
      `${A.bold}${label}${A.reset} ${A.dim}(${executions.length})${A.reset}`,
      ...executions.map(execution =>
        `  ${execution.status === 'errored' ? A.red : execution.isActive ? A.green : A.dim}${execution.rootExecutionId}${A.reset} ${execution.displayName} · ${execution.nodeCount} agents · ${formatAgentExecutionElapsed(execution.timing.elapsedMs)}`,
      ),
    ];
    appendStatic([
      `${A.bold}Agent executions${A.reset} ${A.dim}${project.totalAgentCount} agent conversations${A.reset}`,
      ...summary('Active', project.active),
      ...summary('Completed', project.completed),
      '',
    ]);
    const selected = await selectItem({
      title: 'Agent execution runs',
      subtitle: `${project.activeExecutionCount} active · ${project.completedExecutionCount} completed`,
      items: [
        ...project.active.map(execution => ({
          id: execution.rootExecutionId,
          label: `Active · ${execution.displayName}`,
          description: `${execution.status} · ${execution.nodeCount} agents · ${execution.currentActivity?.summary ?? 'waiting'}`,
          detail: execution.rootExecutionId,
        })),
        ...project.completed.map(execution => ({
          id: execution.rootExecutionId,
          label: `Completed · ${execution.displayName}`,
          description: `${execution.status} · ${execution.nodeCount} agents · ${formatAgentExecutionElapsed(execution.timing.elapsedMs)}`,
          detail: execution.rootExecutionId,
        })),
      ],
    });
    if (selected) await showAgentExecution(selected);
  }

  async function showMcp(): Promise<void> {
    const byServer = new Map<string, typeof toolMetadata>();
    for (const tool of toolMetadata.filter(item => item.provider === 'mcp')) {
      const server = tool.server ?? 'mcp';
      const tools = byServer.get(server) ?? [];
      tools.push(tool);
      byServer.set(server, tools);
    }
    const persisted = readMcpServerConfig();
    const lines: string[] = [];
    if (byServer.size > 0) {
      lines.push(`${A.bold}Active MCP servers${A.reset} ${A.dim}(${byServer.size})${A.reset}`);
      for (const [server, tools] of byServer) {
        lines.push(`  ${A.green}●${A.reset} ${A.bold}${server}${A.reset} ${A.dim}— ${tools.length} tool${tools.length === 1 ? '' : 's'}${A.reset}`);
      }
    } else {
      lines.push(`${A.dim}no MCP servers are active${A.reset}`);
    }
    if (persisted.servers.length > 0) {
      lines.push(`${A.bold}Configured servers${A.reset} ${A.dim}(~/.hadamard/mcp.json)${A.reset}`);
      for (const s of persisted.servers) {
        lines.push(`  ${A.dim}·${A.reset} ${s.name} ${A.dim}→ ${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}${A.reset}`);
      }
    }
    lines.push('');
    appendStatic(lines);

    const choice = await selectItem({
      title: 'MCP servers',
      searchable: false,
      items: [
        { id: 'add', label: '+ Add stdio server…', description: 'persist a stdio MCP server to ~/.hadamard/mcp.json' },
        ...(persisted.servers.length > 0
          ? [{ id: 'remove', label: '− Remove server…', description: 'delete a configured server and reload' }]
          : []),
        { id: 'reload', label: '↻ Reload SDK', description: 'recreate the client to pick up config changes' },
        ...(byServer.size > 0
          ? [...byServer.entries()].map(([server, tools]) => ({
              id: `view:${server}`,
              label: server,
              description: `${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.map(t => t.name).slice(0, 6).join(', ')}${tools.length > 6 ? '…' : ''}`,
            }))
          : []),
      ],
    });
    if (!choice) return;
    if (choice === 'add') {
      const name = (await promptText({ title: 'MCP server name', label: 'name' }))?.trim();
      if (!name) return;
      const kind = await selectItem({
        title: 'Server type',
        items: [
          { id: 'stdio', label: 'stdio', description: 'local process (e.g. npx, python, a binary)' },
          { id: 'http', label: 'http', description: 'remote streamable HTTP MCP server (url)' },
        ],
      });
      if (!kind) return;
      if (kind === 'stdio') {
        const command = (await promptText({ title: `Command for ${name}`, label: 'command', description: 'e.g. npx or a binary path' }))?.trim();
        if (!command) return;
        const argsRaw = await promptText({ title: `Args for ${name}`, label: 'args', description: 'space-separated (optional)' });
        addMcpServer({ name, command, ...(argsRaw?.trim() ? { args: argsRaw.trim().split(/\s+/) } : {}) });
      } else {
        const url = (await promptText({ title: `URL for ${name}`, label: 'url', description: 'e.g. https://mcp.example.com' }))?.trim();
        if (!url) return;
        const headersRaw = await promptText({ title: `Headers for ${name}`, label: 'headers', description: 'key:value, comma-separated (optional)' });
        const headers: Record<string, string> | undefined = headersRaw?.trim() ? Object.fromEntries(headersRaw.split(',').map(p => p.split(':').map(s => s.trim())).filter(a => a.length === 2)) : undefined;
        addMcpServer({ name, url, ...(headers ? { headers } : {}) });
      }
      appendStatic([...formatInfoLine(`added MCP server "${name}" — reloading SDK`), '']);
      await withSpinner('reloading SDK', reloadCleanSdk);
      return;
    }
    if (choice === 'remove') {
      const name = await selectItem({
        title: 'Remove MCP server',
        searchable: false,
        items: persisted.servers.map(s => ({ id: s.name, label: s.name, description: `${s.command}` })),
      });
      if (!name) return;
      removeMcpServer(name);
      appendStatic([...formatInfoLine(`removed MCP server "${name}" — reloading SDK`), '']);
      await withSpinner('reloading SDK', reloadCleanSdk);
      return;
    }
    if (choice === 'reload') {
      await withSpinner('reloading SDK', reloadCleanSdk);
      appendStatic([...formatInfoLine('SDK reloaded — MCP config re-read'), '']);
      return;
    }
    if (choice.startsWith('view:')) {
      const server = choice.slice('view:'.length);
      appendStatic([
        `${A.cyan}${server}${A.reset}`,
        `${A.dim}${(byServer.get(server) ?? []).map(tool => tool.name).join(', ')}${A.reset}`,
        '',
      ]);
    }
  }

  async function showPlugins(): Promise<void> {
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath });
    const managed = readManagedPluginCatalog(store.raw).plugins;
    const configuredDirs = Array.isArray(store.raw.pluginDirs)
      ? store.raw.pluginDirs.filter((value): value is string => typeof value === 'string')
      : [];
    const plugins = await discoverHadamardPlugins({
      workDir,
      homeDir: store.homeDir,
      configuredDirs,
    });
    const { PluginPackageManager } = await import('../plugins/pluginManager.js');
    const packageManager = new PluginPackageManager(
      path.join(sdk.config.homeDir, 'plugin-packages'),
      process.env.HADAMARD_PLUGIN_REGISTRY,
      sdk.config.effectivePolicy,
    );
    const packages = await packageManager.snapshot();
    const selected = await selectItem({
      title: 'Plugins',
      subtitle: 'Built-in integrations, trusted packages, and local manifests',
      items: [
        ...managed.map(plugin => ({
          id: `managed:${plugin.id}`,
          label: plugin.name,
          description: `${plugin.state} · ${plugin.description}`,
          detail: plugin.statusDetail ?? plugin.category,
        })),
        ...plugins.map(plugin => ({
          id: `local:${plugin.path}`,
          label: plugin.name,
          description: [plugin.version, plugin.capabilities.join(', ')].filter(Boolean).join(' · '),
          detail: `${plugin.description ?? ''} ${plugin.path}`,
        })),
        ...packages.map(plugin => ({
          id: `package:${plugin.id}`,
          label: `${plugin.name} ${plugin.version}`,
          description: `${plugin.packageType} · ${!plugin.trusted ? 'review required' : plugin.enabled ? 'enabled' : 'disabled'}`,
          detail: `${plugin.commit ?? 'local/unverified'} · ${plugin.capabilities.join(', ')}`,
        })),
      ],
    });
    if (selected?.startsWith('managed:')) {
      const id = selected.slice('managed:'.length);
      const plugin = managed.find(item => item.id === id);
      if (!plugin) return;
      const action = await selectItem({
        title: plugin.name,
        subtitle: plugin.description,
        searchable: false,
        items: [
          {
            id: 'toggle',
            label: plugin.state === 'available' ? 'Install' : plugin.enabled ? 'Disable' : 'Enable',
            description: `Current state: ${plugin.state}`,
          },
          {
            id: 'details',
            label: 'Show configuration status',
            description: plugin.secretConfigured ? 'Credential configured' : 'No plugin credential stored',
          },
        ],
      });
      if (action === 'toggle') {
        const raw = structuredClone(store.raw);
        const enabling = plugin.state === 'available' || !plugin.enabled;
        patchManagedPluginSettings(raw, plugin.id, { enabled: enabling });
        await persistHadamardSettingsStore(store.configPath, raw);
        await loadJsonConfigFile(store.configPath);
        await withSpinner('reloading managed plugins', reloadCleanSdk);
        appendStatic([
          ...formatInfoLine(`${plugin.name} ${enabling ? 'enabled' : 'disabled'}`),
          '',
        ]);
      } else if (action === 'details') {
        appendStatic([
          `${A.cyan}${plugin.name}${A.reset}`,
          `${A.dim}${plugin.description}${A.reset}`,
          `${A.dim}state: ${plugin.state} · credential: ${plugin.secretConfigured ? 'configured' : 'not configured'}${A.reset}`,
          ...formatInfoLine('Use GUI Customize for provider URLs, API keys, browser profiles, and health checks.'),
          '',
        ]);
      }
      return;
    }
    if (selected?.startsWith('package:')) {
      const id = selected.slice('package:'.length);
      const plugin = packages.find(item => item.id === id);
      if (!plugin) return;
      appendStatic([
        `${A.cyan}${plugin.name}${A.reset} ${plugin.version}`,
        `${A.dim}source: ${plugin.source}${plugin.commit ? ` @ ${plugin.commit}` : ''}${A.reset}`,
        `${A.dim}startup: ${plugin.startupCommands.join(' | ') || 'none'}${A.reset}`,
        `${A.dim}environment: ${plugin.environmentVariables.join(', ') || 'none declared'}${A.reset}`,
        `${A.dim}network: ${plugin.network ? 'requested' : 'not requested'} · files: ${plugin.fileAccess.join(' + ') || 'none'}${A.reset}`,
        `${A.dim}capabilities: ${plugin.capabilities.join(', ') || 'none'}${A.reset}`,
        '',
      ]);
      const action = await selectItem({
        title: `${plugin.name} trust and activation`,
        subtitle: 'Trust is bound to exact version, integrity, and capabilities',
        searchable: false,
        items: [
          ...(!plugin.trusted ? [{ id: 'trust', label: 'Trust exact version', description: 'Approve the displayed startup and capability set' }] : []),
          ...(plugin.trusted ? [{ id: plugin.enabled ? 'disable' : 'enable', label: plugin.enabled ? 'Disable' : 'Enable', description: 'Reload the SDK after changing activation' }] : []),
          { id: 'remove', label: 'Remove package', description: 'Uninstall package and revoke trust' },
        ],
      });
      if (action) {
        const result = await packageManager.execute(`${action} ${plugin.id}`);
        if (result.runtimeChanged) await withSpinner('reloading plugin packages', reloadCleanSdk);
        appendStatic([...formatInfoLine(result.message), '']);
      }
      return;
    }
    const localPath = selected?.startsWith('local:') ? selected.slice('local:'.length) : '';
    const plugin = plugins.find(item => item.path === localPath);
    if (plugin) {
      appendStatic([
        `${A.cyan}${plugin.name}${A.reset}${plugin.version ? ` ${plugin.version}` : ''}`,
        `${A.dim}${plugin.path} · ${plugin.capabilities.join(', ') || 'manifest only'}${A.reset}`,
        '',
      ]);
    }
  }

  async function runSlashCommand(raw: string): Promise<void> {
    const spaceIndex = raw.indexOf(' ');
    const name = (spaceIndex === -1 ? raw.slice(1) : raw.slice(1, spaceIndex)).toLowerCase();
    const args = spaceIndex === -1 ? '' : raw.slice(spaceIndex + 1).trim();
    if (!canRunInteractiveCommand(raw.slice(1), running)) {
      appendStatic(formatInfoLine(`/${name} requires an idle session; it will be available after this run`));
      return;
    }
    appendStatic(formatUserPrompt(raw));
    commandBusy = true;
    renderDynamic();
    try {
      if (name === 'document') {
        const selected = await selectItem({
          title: 'Project documents',
          searchable: false,
          items: [
            { id: 'design', label: 'DESIGN', description: '.hadamard/design/design.md or design.html' },
            { id: 'plan', label: 'PLAN', description: 'Current plan document' },
            { id: 'memory', label: 'MEMORY', description: 'Durable project memory entrypoint' },
            { id: 'rules', label: 'RULES', description: 'Directory-scoped AGENTS.md catalog' },
          ],
        });
        if (!selected) return;
        let targetPath: string | undefined;
        if (selected === 'design') {
          const format = await selectItem({
            title: 'Design source',
            searchable: false,
            items: [
              { id: 'markdown', label: 'Markdown', description: '.hadamard/design/design.md' },
              { id: 'html', label: 'HTML', description: '.hadamard/design/design.html' },
            ],
          });
          if (!format) return;
          const registry = await readWorkspaceRegistry(hadamardHomeDir);
          const primary = findWorkspaceProject(registry, sdk.config.workDir)?.path ?? sdk.config.workDir;
          const design = new DesignWorkspaceService(primary);
          await design.ensureRoot();
          targetPath = design.entryPath(format === 'html' ? 'html' : 'markdown');
          if (!fs.existsSync(targetPath)) {
            if (format === 'html') await design.writeHtml('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Project Design</title></head><body><main><h1>Project Design</h1></main></body></html>\n');
            else await design.writeMarkdown('# Project Design\n');
          }
        } else if (selected === 'plan') {
          targetPath = planFilePath(sdk.config.workDir);
        } else if (selected === 'memory') {
          targetPath = (await sdk.memory.paths({ projectPath: sdk.config.workDir })).autoMemoryEntrypoint;
        } else {
          const registry = await readWorkspaceRegistry(hadamardHomeDir);
          const project = findWorkspaceProject(registry, sdk.config.workDir);
          const catalog = new ProjectRuleCatalogService(project ? workspaceWorkPaths(project) : [sdk.config.workDir]);
          const entries = await catalog.list();
          const rule = await selectItem({
            title: 'AGENTS.md rules',
            searchable: true,
            items: entries.map(entry => ({ id: entry.path, label: entry.relativePath, description: entry.workPath })),
          });
          targetPath = rule;
        }
        if (!targetPath) return;
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        const editorBin = process.env.EDITOR || process.env.VISUAL || 'notepad';
        const result = spawnSync(editorBin, [targetPath], { stdio: 'inherit', shell: false });
        appendStatic([...formatInfoLine(result.error ? `Could not open ${targetPath}: ${result.error.message}` : `Opened ${targetPath}`), '']);
        return;
      }
      const memoryCommandHandled = await runTuiMemoryCommand(name, args, {
        runMemoryCommand: async input => {
          const { HadamardMemoryCommandService } = await import('../memory/memoryCommandService.js');
          return new HadamardMemoryCommandService({
            memory: sdk.memory,
            proposals: sdk.memoryProposals,
            compactConfig: sdk.config.compact,
            getState: () => session.compactState(),
          }).execute(input);
        },
        compact: summaryInstructions => session.compact({ summaryInstructions }),
        compactPromptMode: () => sdk.config.compact?.compactPromptMode ?? 'hybrid',
        dreamState: () => session.dreamState(),
        dream: () => session.dream({ force: true }),
        selectDreamAction: () => selectItem({
          title: 'Dream memory consolidation',
          searchable: false,
          items: [
            { id: 'status', label: 'Show dream state' },
            { id: 'run', label: 'Run consolidation now' },
          ],
        }),
        appendStatic,
      });
      if (memoryCommandHandled) return;
      const configurationCommandHandled = await runTuiConfigurationCommand(name, args, {
        defaultModel: () => ({
          model: sdk.config.model,
          provider: sdk.config.provider,
          baseURL: sdk.config.baseURL,
        }),
        sessionModel: () => session.model,
        setSessionModel: model => session.setModel(model),
        disableBridge,
        activateBridgeConfig,
        activeBridgeConfigName: () => activeBridgeConfig?.name,
        bridgeModelLabel: () => bridgeModelLabel,
        chooseModel,
        configureContextWindow,
        configureModelSettings,
        chooseRouter,
        chooseEffort,
        setEffort,
        chooseAgentMode,
        chooseToolPresentation,
        currentPermissionMode,
        setPermissionContext: (mode, permissions) => session.setPermissionContext({
          mode,
          permissions,
          approver,
        }),
        selectItem,
        appendStatic,
      });
      if (configurationCommandHandled) return;
      const basicCommandHandled = await runTuiBasicCommand(name, args, {
        selectItem,
        clear: clearConversation,
        startRun,
        shutdown: () => { void shutdown(0); },
        toolNames: () => toolMetadata.map(tool => tool.name),
        snapshot: () => ({
          model: session.model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          costUsd: totalCostUsd,
          usageByConfiguration: [...configUsage].map(([name, record]) => ({
            name,
            ...record,
            cost: configCost(name, record),
            active: activeBridgeConfig?.name === name,
          })),
          messages: session.messages.length,
          toolCount: toolMetadata.length,
          mcpToolCount: toolMetadata.filter(tool => tool.provider === 'mcp').length,
          bridgeName: bridgeMode ? activeBridgeConfig?.name : undefined,
          planMode: session.permissionContext.mode === 'plan',
        }),
        runGoal: async args => (await sdk.goals.command(session, args)).message,
        appendStatic,
      });
      if (basicCommandHandled) return;
      const planCommandHandled = await runTuiPlanCommand(name, args, {
        defaultPermissionMode: () => permissionMode,
        currentPermissionMode,
        setPermissionMode: mode => session.setPermissionContext({
          mode,
          permissions: [],
          approver,
        }),
        readPlan: () => readPlanFile(sdk.config.workDir),
        planFile: () => planFilePath(sdk.config.workDir),
        openPlanFile: () => {
          try {
            const editorBin = process.env.EDITOR || process.env.VISUAL || 'notepad';
            spawnSync(editorBin, [planFilePath(sdk.config.workDir)], { stdio: 'ignore', shell: false });
            return true;
          } catch {
            return false;
          }
        },
        startRun,
        renderRichText: text => renderRichText(text, screen.width),
        appendStatic,
      });
      if (planCommandHandled) return;
      const sessionCommandHandled = await runTuiSessionCommand(name, args, {
        current: () => ({
          id: session.id,
          title: session.title,
          model: session.model,
          messageCount: session.messages.length,
        }),
        checkpoints: {
          list: () => sdk.checkpoints.list(session.id),
          preview: checkpointId => sdk.checkpoints.preview(session.id, checkpointId),
          restore: (checkpointId, mode) => sdk.checkpoints.restore({
            sessionId: session.id,
            checkpointId,
            mode,
          }),
          restoreConversation: checkpointId => session.restoreCheckpoint(checkpointId),
        },
        rewind: async messageCount => {
          const kept = session.messages.slice(0, session.messages.length - messageCount);
          const nextSession = await sdk.createSession({ title: session.title, model: session.model });
          if (kept.length > 0) await nextSession.appendMessages(kept);
          const previousSession = session;
          session = nextSession;
          await restoreSessionRuntimeSelection();
          await previousSession.delete().catch(() => undefined);
          return session.id;
        },
        listStoredSessions: async () => (await sdk.sessions.list())
          .filter(item => isTuiChatSession(item) && !isEmptyUserSessionSummary(item))
          .map(item => ({
            id: item.id,
            title: item.title,
            model: item.model,
            status: item.status,
            kind: item.kind,
          })),
        querySessions: async filters => {
          const page = await (await interactiveSessionCatalog()).query({
            types: filters.types as import('../storage/sessionCatalog.js').SessionCatalogType[],
            archived: filters.archived === 'all' ? 'all' : filters.archived === 'archived',
            ...(filters.project ? { projectPaths: [filters.project] } : {}),
            ...(filters.status
              ? { runtimeStatuses: [filters.status as import('../storage/sessionCatalog.js').SessionCatalogRuntimeStatus] }
              : {}),
            keyword: filters.query,
            pageSize: 200,
          });
          return page.items.map(item => ({
            sessionId: item.locator.sessionId,
            projectName: item.projectName,
            type: item.type,
            title: item.title,
            archived: item.archived,
            pinned: item.pinned,
          }));
        },
        resume: async sessionId => {
          if (sessionId) await resumeSession(sessionId);
          else await chooseSessionToResume();
        },
        tree: async () => {
          const mapNode = (node: Awaited<ReturnType<typeof sdk.sessionGraph.roots>>[number]): import('./tuiSessionCommandHandler.js').TuiSessionTreeNode => ({
            id: node.session.id,
            title: node.session.title,
            branchName: node.session.branchName,
            children: node.children.map(mapNode),
          });
          return (await sdk.sessionGraph.roots()).map(mapNode);
        },
        ensureMessageIds: async () => (await sdk.sessionGraph.ensureMessageIds(session.id))
          .map(ref => ({ id: ref.id, role: ref.message.role })),
        fork: async (messageId, label) => {
          const forked = await sdk.sessionForks.forkAtMessage(session.id, messageId, {
            branchName: label,
          });
          session = await sdk.resumeSession(forked.id);
          return forked.id;
        },
        clone: async label => {
          const cloned = await sdk.sessionForks.clone(session.id, { branchName: label });
          session = await sdk.resumeSession(cloned.id);
          return cloned.id;
        },
        label: async value => {
          await sdk.sessionForks.label(session.id, value);
          session = await sdk.resumeSession(session.id);
        },
        catalogAction: async (action, targetId, value) => {
          const catalog = await interactiveSessionCatalog();
          const all = await catalog.query({
            types: ['user', 'assistant-global', 'assistant-project'],
            archived: 'all',
            pageSize: 200,
          });
          const item = all.items.find(candidate => candidate.locator.sessionId === targetId);
          if (!item) return false;
          if (action === 'rename') {
            await catalog.action({ action, locator: item.locator, title: String(value) });
            if (targetId === session.id) session = await sdk.resumeSession(session.id);
          } else if (action === 'pin') {
            await catalog.action({
              action,
              locator: item.locator,
              pinned: typeof value === 'boolean' ? value : undefined,
            });
          } else {
            await catalog.action({ action, locator: item.locator });
            if (action === 'archive' && targetId === session.id) {
              session = await sdk.createSession({
                model: session.model,
                permissionMode: currentPermissionMode(),
              });
            }
          }
          return true;
        },
        appendStatic,
      });
      if (sessionCommandHandled) return;
      const workflowCommandHandled = await runTuiWorkflowCommand(name, args, {
        workDir: sdk.config.workDir,
        homeDir: sdk.config.homeDir,
        selectItem,
        promptText,
        runWorkflowScript: async (script, workflowArgs, onEvent) => {
          const { WorkflowScriptRuntime } = await import('../workflow/workflowScriptRuntime.js');
          const runtime = new WorkflowScriptRuntime({
            sdk,
            trust: 'trusted',
            args: workflowArgs,
            onEvent,
          });
          const output = await runtime.execute(script);
          return { result: output.result, errors: output.state.errors };
        },
        renderRichText: text => renderRichText(text, screen.width),
        appendStatic,
      });
      if (workflowCommandHandled) return;
      if (await runTuiWorktreeCommand(name, args, {
        workDir: sdk.config.workDir,
        appendStatic,
      })) return;
      if (await runTuiBridgeCommand(name, args, {
        runs: {
          run: runBridgePrompt,
          background: startExternalCliBackgroundRun,
          listRuns: printExternalCliRuns,
          stop: stopExternalCliRun,
          status: printBridgeStatus,
          history: printExternalCliHistory,
          resume: resumeExternalCliHistorySession,
        },
        configuration: {
          switchProvider: switchBridgeProvider,
          setup: configureBridgeSettings,
          manage: manageBridgeConfigs,
          disable: async () => { await disableBridge(); },
          selectModel: selectBridgeModel,
          help: printBridgeHelp,
          openBoard: openBridgeBoard,
        },
        appendStatic,
      })) return;
      if (await runTuiTeamCommand(name, args, {
        workDir: sdk.config.workDir,
        state: {
          activeName: () => activeTeamName,
          hasActiveTool: () => Boolean(activeTeamTool),
          preferences: () => teamPrefs,
          lastRunSummary: () => lastTeamRunSummary,
          currentModel: () => session.model,
          attach: attachTeamByName,
          clear: () => {
            activeTeamTool = null;
            activeTeamName = null;
          },
          setLastRunSummary: summary => { lastTeamRunSummary = summary; },
        },
        execution: {
          ask: (definition, prompt, onEvent) => askTeamDefinition(definition, prompt, undefined, {
            workDir: sdk.config.workDir,
            onEvent,
          }),
        },
        ui: {
          selectItem,
          renderRichText: text => renderRichText(text, screen.width),
          appendStatic,
        },
      })) return;
      if (await runTuiIssueCommand(name, args, {
        issues: {
          storage: async () => {
            const meta = await readProjectMeta(sdk.config.workDir, sdk.config.homeDir);
            return isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home';
          },
          list: storage => listProjectIssues(sdk.config.workDir, sdk.config.homeDir, storage),
          create: (title, storage) => createProjectIssue(
            sdk.config.workDir,
            sdk.config.homeDir,
            { title },
            storage,
          ),
          execute: async (issue, agentProfile, storage) => {
            const dispatched = await executeProjectIssue({
              sdk,
              managerSession: await resolveManagerTuiSession(),
              workDir: sdk.config.workDir,
              homeDir: sdk.config.homeDir,
              storageMode: storage,
              issue,
              agentProfile,
              defaultModel: session.model,
              permissionMode: currentPermissionMode(),
              systemPrompt,
            });
            session = dispatched.session;
            return {
              issue: dispatched.issue,
              sessionId: session.id,
              text: dispatched.result.text,
            };
          },
          transition: (id, status, storage) => transitionProjectIssue(
            sdk.config.workDir,
            sdk.config.homeDir,
            id,
            status,
            'user',
            storage,
          ),
        },
        appendStatic,
      })) return;
      if (await runTuiAssistantCommand(name, args, {
        assistant: {
          initialize: async () => { await resolveGlobalAssistantSession(); },
          listSessions: async () => {
            const config = await readAssistantConfig(sdk.config.homeDir);
            return (await globalAssistantSdk!.sessions.list())
              .filter(item => item.kind === 'manager')
              .map(item => ({
                id: item.id,
                title: item.title,
                messageCount: item.messageCount,
                active: item.id === config.activeSessionId,
              }));
          },
          createSession: async () => {
            const config = await readAssistantConfig(sdk.config.homeDir);
            globalAssistantSession = await globalAssistantSdk!.createSession({
              title: 'Assistant (Global)',
              kind: 'manager',
              metadata: { __hadamardKind: 'manager', __hadamardAssistantScope: 'global' },
              permissionMode: 'bypassPermissions',
            });
            await writeAssistantConfig({
              ...config,
              activeSessionId: globalAssistantSession.id,
            }, sdk.config.homeDir);
            return globalAssistantSession.id;
          },
          resumeSession: async id => {
            const found = (await globalAssistantSdk!.sessions.list())
              .find(item => item.id === id && item.kind === 'manager');
            if (!found) return undefined;
            const config = await readAssistantConfig(sdk.config.homeDir);
            globalAssistantSession = await globalAssistantSdk!.resumeSession(id, {
              permissionMode: 'bypassPermissions',
            });
            await writeAssistantConfig({ ...config, activeSessionId: id }, sdk.config.homeDir);
            return { title: found.title };
          },
          run: async (prompt, onTool) => {
            const globalSession = await resolveGlobalAssistantSession();
            const proposals: import('../team/teamProposalService.js').TeamGraphProposal[] = [];
            const assistantTools = [
              ...await createAssistantGlobalTools({
                homeDir: sdk.config.homeDir,
                currentWorkDir: sdk.config.workDir,
              }),
              ...createAssistantTeamTools({
                scope: 'global',
                assistantSessionId: globalSession.id,
                currentWorkDir: sdk.config.workDir,
                homeDir: sdk.config.homeDir,
                proposals: assistantTeamProposals,
                onProposal: proposal => { proposals.push(proposal); },
              }),
            ];
            const config = await readAssistantConfig(sdk.config.homeDir);
            const stream = globalSession.stream(prompt, {
              systemPrompt: `${buildAssistantGlobalSystemPrompt(sdk.config.workDir)}\n${buildAssistantTeamSystemPrompt('global')}`,
              tools: assistantTools,
              ...(config.model ? { model: config.model } : {}),
              __hadamardUseDefaultTools: false,
              __hadamardAllowedTools: assistantTools.map(item => item.name),
            } as Parameters<typeof globalSession.stream>[1]);
            const assistantToolDisplay = new ToolActivityDisplayState();
            for await (const event of stream) {
              if (event.type === 'tool.call' && assistantToolDisplay.markStarted(event.call.id)) {
                onTool(event.call.name);
              }
            }
            const result = await stream.result;
            return { text: result.text, proposals };
          },
          proposalDiff: managerProposalDiffForTui,
          applyProposal: async id => (await assistantTeamProposals.apply(id, sdk.config.homeDir)).filePath,
          rejectProposal: id => { assistantTeamProposals.reject(id); },
        },
        selectItem,
        renderRichText: text => renderRichText(text, screen.width),
        appendStatic,
      })) return;
      if (await runTuiManagerCommand(name, args, {
        manager: {
          listSessions: async () => {
            const config = await readManagerConfig(sdk.config.workDir, sdk.config.homeDir);
            return (await sdk.sessions.list())
              .filter(item => item.kind === 'manager')
              .map(item => ({
                id: item.id,
                title: item.title,
                messageCount: item.messageCount,
                active: item.id === config.activeSessionId,
              }));
          },
          createSession: async () => {
            const config = await readManagerConfig(sdk.config.workDir, sdk.config.homeDir);
            managerTuiSession = await sdk.createSession({
              title: 'Manager',
              kind: 'manager',
              metadata: { __hadamardKind: 'manager', __hadamardAssistantScope: 'project' },
              permissionMode: 'bypassPermissions',
            });
            await writeManagerConfig(sdk.config.workDir, sdk.config.homeDir, {
              ...config,
              activeSessionId: managerTuiSession.id,
            });
            return managerTuiSession.id;
          },
          resumeSession: async id => {
            const found = (await sdk.sessions.list())
              .find(item => item.id === id && item.kind === 'manager');
            if (!found) return undefined;
            const config = await readManagerConfig(sdk.config.workDir, sdk.config.homeDir);
            managerTuiSession = await sdk.resumeSession(id, { permissionMode: 'bypassPermissions' });
            await writeManagerConfig(sdk.config.workDir, sdk.config.homeDir, {
              ...config,
              activeSessionId: id,
            });
            return { title: found.title };
          },
          status: async () => {
            const config = await readManagerConfig(sdk.config.workDir, sdk.config.homeDir);
            const plan = await readProjectPlanFile(sdk.config.workDir, sdk.config.homeDir);
            const design = await readDesignFile(sdk.config.workDir, sdk.config.homeDir);
            return {
              model: config.model ?? `${session.model} (session default)`,
              readScope: config.readScope,
              milestones: plan.milestones.length,
              today: plan.today.length,
              upcoming: plan.upcoming.length,
              designChars: design ? design.length : null,
            };
          },
          config: () => readManagerConfig(sdk.config.workDir, sdk.config.homeDir),
          setConfig: async (key, value) => {
            const config = await readManagerConfig(sdk.config.workDir, sdk.config.homeDir);
            if (key === 'model') config.model = value || undefined;
            else if (key === 'bridgeConfig' || key === 'config') config.bridgeConfig = value || undefined;
            else if (key === 'readScope') {
              if (value !== 'workspace-only' && value !== 'workspace+docs' && value !== 'explicit-allowlist' && value !== 'full-access') {
                return { ok: false, message: 'readScope must be workspace-only | workspace+docs | explicit-allowlist | full-access' };
              }
              config.readScope = value;
            } else if (key === 'allow') {
              config.allowedReadPaths = value ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
            } else {
              return { ok: false, message: 'usage: /manager config set <model|bridgeConfig|readScope|allow> <value>' };
            }
            await writeManagerConfig(sdk.config.workDir, sdk.config.homeDir, config);
            return { ok: true, message: `Manager config updated: ${key}` };
          },
          schedules: async () => (await listScheduledAutomationTasks(sdk.config.workDir))
            .filter(task => task.kind === 'manager')
            .map(task => ({ name: task.name, cron: task.cron, enabled: task.enabled })),
          run: async (kind, instruction, onNotice, onTool) => {
            const config = await readManagerConfig(sdk.config.workDir, sdk.config.homeDir);
            const proposals: import('../team/teamProposalService.js').TeamGraphProposal[] = [];
            managerTuiSession = await resolveManagerTuiSession();
            const managerTools = [
              ...await createManagerTools({
                workDir: sdk.config.workDir,
                homeDir: sdk.config.homeDir,
                config,
              }),
              ...createAssistantTeamTools({
                scope: 'project',
                assistantSessionId: managerTuiSession.id,
                currentWorkDir: sdk.config.workDir,
                homeDir: sdk.config.homeDir,
                proposals: assistantTeamProposals,
                onProposal: proposal => { proposals.push(proposal); },
              }),
            ];
            let prompt = kind === 'team'
              ? `Propose a Team Graph for this request. Inspect existing Teams first when relevant. ${instruction}`
              : instruction;
            if (kind === 'update') {
              let gitSummary = '';
              try {
                const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: sdk.config.workDir, encoding: 'utf8' }).trim();
                const dirty = execSync('git status --porcelain', { cwd: sdk.config.workDir, encoding: 'utf8' }).trim();
                const log = execSync('git log --oneline -10', { cwd: sdk.config.workDir, encoding: 'utf8' }).trim();
                gitSummary = `branch: ${branch}\ndirty files: ${dirty ? dirty.split('\n').length : 0}\nrecent commits:\n${log}`;
              } catch { /* not a git repo */ }
              const stored = await sdk.sessions.list();
              const conversationSummaries = stored
                .filter((s) => s.kind !== 'manager')
                .slice(0, 20)
                .map((s) => `- [${s.updatedAt.slice(0, 10)}] ${s.title} (${s.messageCount} msgs): ${s.preview}`)
                .join('\n');
              const plan = await readProjectPlanFile(sdk.config.workDir, sdk.config.homeDir);
              const design = await readDesignFile(sdk.config.workDir, sdk.config.homeDir);
              onNotice(formatManagerUpdatePreview(plan, design).split('\n').slice(0, 2).join(' · '));
              const githubDigest = await resolveGitHubDigestForUpdate(
                sdk.config.workDir,
                instruction || undefined,
              );
              prompt = buildUpdateDesignPrompt({
                instruction: instruction || undefined,
                gitSummary,
                conversationSummaries,
                githubDigest,
                currentPlanJson: JSON.stringify(plan, null, 2),
                currentDesign: design ?? undefined,
              });
            }
            try {
              const compactResult = await managerTuiSession.compact({});
              if (compactResult.compacted) {
                onNotice(`manager compacted ${compactResult.messagesRemoved ?? '?'} older messages`);
              }
            } catch { /* auto-compact is best-effort */ }
            const stream = managerTuiSession.stream(prompt, {
              systemPrompt: `${buildManagerSystemPrompt(sdk.config.workDir, config)}\n${buildAssistantTeamSystemPrompt('project')}`,
              tools: managerTools,
              ...(config.model ? { model: config.model } : {}),
              __hadamardUseDefaultTools: false,
              __hadamardAllowedTools: managerTools.map(tool => tool.name),
            } as Parameters<typeof managerTuiSession.stream>[1]);
            const managerToolDisplay = new ToolActivityDisplayState();
            for await (const event of stream) {
              if (event.type === 'tool.call' && managerToolDisplay.markStarted(event.call.id)) {
                onTool(event.call.name);
              }
            }
            const result = await stream.result;
            return {
              text: result.text,
              proposals,
              ...(kind === 'update'
                ? { designPath: managerDesignPath(sdk.config.workDir, sdk.config.homeDir) }
                : {}),
            };
          },
          proposalDiff: proposal => [
            `${A.dim}${proposal.explanation || '(no explanation)'}${A.reset}`,
            ...managerProposalDiffForTui(proposal),
            ...proposal.problems.map(problem => `${A.red}invalid: ${problem}${A.reset}`),
          ],
          applyProposal: async id => {
            const applied = await assistantTeamProposals.apply(id, sdk.config.homeDir);
            return { teamName: applied.proposal.teamName, filePath: applied.filePath };
          },
          rejectProposal: id => { assistantTeamProposals.reject(id); },
        },
        selectItem,
        renderRichText: text => renderRichText(text, screen.width),
        appendStatic,
      })) return;
      if (await runTuiWorkspaceCommand(name, args, {
        readFile: file => fs.readFileSync(path.resolve(workDir, file), 'utf-8'),
        gitDiff: () => {
          try {
            return execSync('git diff', {
              cwd: workDir,
              encoding: 'utf8',
              maxBuffer: 1024 * 1024,
              timeout: 15_000,
            }).trim();
          } catch {
            return '';
          }
        },
        exportConversation: file => {
          const markdown = session.messages
            .map(message => `## ${message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role}\n\n${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`)
            .join('\n\n---\n\n');
          fs.writeFileSync(path.resolve(workDir, file), markdown, 'utf-8');
        },
        getSessionDiff: () => sdk.getSessionDiff(session.id),
        applySessionDiff: () => sdk.applySessionDiff(session.id),
        startRun,
        appendStatic,
      })) return;
      if (await runTuiContextCommand(name, args, {
        configureContext: configureContextSettings,
        contextSnapshot: async () => {
          await refreshContextEstimate();
          const { resolveHadamardCompactBudget, getPersistedHadamardCompactState } = await import('../runtime/hadamardCompact.js');
          const compactBudget = resolveHadamardCompactBudget({
            ...sdk.config.compact,
            ...(readSessionContextWindow(session.metadata)
              ? { contextWindowTokens: readSessionContextWindow(session.metadata) }
              : {}),
          });
          const project = loadProjectContext(workDir, {
            projectInstructionMode: projectSettings.context.instructionMode,
            hadamardHomeDir,
            projectWorkPaths,
          });
          const instructionState = parseProjectInstructionState(session.metadata);
          return {
            effectiveWindowTokens: compactBudget.effectiveContextWindowTokens,
            rawWindowTokens: compactBudget.rawContextWindowTokens,
            autoCompactTokenLimit: compactBudget.autoCompactTokenLimit,
            compactSource: compactBudget.source,
            usedTokens: lastTokenEstimate ?? 0,
            systemTokens: lastTokenBreakdown?.systemTokens,
            toolTokens: lastTokenBreakdown?.toolTokens,
            messageTokens: lastTokenBreakdown?.messageTokens,
            tokenEstimateMultiplier: lastTokenBreakdown?.multiplier,
            messages: session.messages.length,
            systemPromptChars: systemPrompt.length,
            projectInstructionChars: project.text.length,
            projectInstructionHash: instructionState?.contentHash.slice(0, 12),
            projectInstructionKey: instructionState?.contextKey.split('\n')[0],
            compactCount: getPersistedHadamardCompactState(session.metadata).compactCount,
            toolCount: toolMetadata.length,
            mcpToolCount: toolMetadata.filter(tool => tool.provider === 'mcp').length,
            instructionFiles: project.sources,
            model: session.model,
            effort: currentEffort() ?? 'auto',
            team: activeTeamName ?? 'none',
            router: activeRouter?.name ?? 'off',
            bridge: bridgeMode && activeBridgeConfig ? activeBridgeConfig.name : 'off',
          };
        },
        doctorSnapshot: async () => {
          const config = sdk.config;
          const apiKey = config.apiKey
            ?? process.env.HADAMARD_API_KEY
            ?? process.env.ANTHROPIC_API_KEY
            ?? process.env.OPENAI_API_KEY;
          let isGit = false;
          try {
            execSync('git rev-parse --is-inside-work-tree', {
              cwd: config.workDir,
              stdio: 'ignore',
            });
            isGit = true;
          } catch { /* not git */ }
          const project = loadProjectContext(config.workDir, {
            projectInstructionMode: projectSettings.context.instructionMode,
            hadamardHomeDir,
          });
          const detections = await withSpinner('detecting runtimes', detectBridgeProviders);
          return {
            model: config.model,
            provider: config.provider,
            apiKey: apiKey ? `set (${maskKey(apiKey)})` : null,
            ...(config.baseURL ? { baseURL: config.baseURL } : {}),
            workDir: config.workDir,
            isGit,
            sessionId: session.id,
            messageCount: session.messages.length,
            permissionMode: currentPermissionMode(),
            toolCount: toolMetadata.length,
            instructionFiles: project.sources,
            bridgeRuntimes: detections.filter(item => item.available).map(item => item.id),
            ...(bridgeMode && activeBridgeConfig
              ? {
                  activeBridge: {
                    name: activeBridgeConfig.name,
                    ...(bridgeModelLabel ? { model: bridgeModelLabel } : {}),
                  },
                }
              : {}),
          };
        },
        appendStatic,
      })) return;
      if (await runTuiDeviceLinkCommand(name, args, {
        execute: async commandArgs => new DeviceLinkCommandService(
          await getDeviceLinkService(),
        ).execute(commandArgs),
        appendStatic,
      })) return;
      if (await runTuiCatalogCommand(name, args, {
        showSkills,
        showAgents,
        showAgentRuns,
        showAgentExecution,
        openAgentExecution: openAgentExecutionConversation,
        showMcp,
        hooks: () => {
          const raw = getLoadedJsonConfig()?.raw;
          const typedHooks = parseTypedHooks(raw?.typedHooks);
          return {
            lifecycle: typedHooks.hooks.map(hook => ({
              id: hook.id,
              event: hook.event,
              handlerType: hook.handler.type,
            })),
            issues: typedHooks.issues,
            preToolUse: readPreToolUseHooks(raw).map(hook => ({
              matcher: hook.matcher,
              command: hook.command,
            })),
            postToolUse: readPostToolUseHooks(raw).map(hook => ({
              matcher: hook.matcher,
              command: hook.command,
            })),
            sessionStart: readSessionStartHooks(raw).map(hook => ({ command: hook.command })),
          };
        },
        showPlugins,
        pluginCommand: async commandArgs => {
          const { PluginPackageManager } = await import('../plugins/pluginManager.js');
          const manager = new PluginPackageManager(
            path.join(sdk.config.homeDir, 'plugin-packages'),
            process.env.HADAMARD_PLUGIN_REGISTRY,
            sdk.config.effectivePolicy,
          );
          const result = await manager.execute(commandArgs);
          if (result.runtimeChanged) await reloadCleanSdk();
          return result;
        },
        rulesCommand: async commandArgs => {
          const { RuleCommandService } = await import('../context/ruleCommandService.js');
          return new RuleCommandService(
            sdk.config.homeDir,
            sdk.config.workDir,
          ).execute(commandArgs);
        },
        appendStatic,
      })) return;
      appendStatic([...formatErrorLine(`unknown command: /${name} — type /help`), '']);
    } finally {
      commandBusy = false;
      renderDynamic();
    }
  }

  // ── Submit / key handling ──────────────────────────────────────────

  /** If the editor was emptied after ↑-recall, put the follow-up back in queue. */
  function restoreRecalledFollowUpIfAbandoned(): void {
    if (!recalledFollowUp || !editor.isEmpty()) return;
    restoreAbandonedFollowUp(session, recalledFollowUp);
    recalledFollowUp = null;
  }

  async function submit(mode: ActiveInputMode = 'follow-up'): Promise<void> {
    if (applyAtCompletion()) {
      renderDynamic();
      return;
    }
    const selectedCommand = selectInteractiveCommand(editor.text, menuSelected);
    if (selectedCommand) {
      const selectedName = selectedCommand.slice(1).split(/\s/u, 1)[0] ?? '';
      // Slash completions are not a resubmit of the recalled follow-up.
      restoreAbandonedFollowUp(session, recalledFollowUp);
      recalledFollowUp = null;
      editor.setText(selectedCommand);
      editor.submit();
      menuSelected = 0;
      if (running && !canRunInteractiveCommand(selectedCommand.slice(1), true)) {
        appendStatic(formatInfoLine(`/${selectedName} requires an idle session; it will be available after this run`));
        renderDynamic();
        return;
      }
      // A selected completion already contains its subcommand. Keeping the
      // partially typed second word would turn `/agents runs` into
      // `/agents runs runs` on Enter.
      await runSlashCommand(selectedCommand);
      return;
    }
    const value = editor.submit();
    if (value === null) {
      renderDynamic();
      return;
    }
    const text = value.trim();
    menuSelected = 0;
    if (!text) {
      // Stopped-task confirmation: with queued messages still pending and
      // the editor empty, Enter starts a continuation run that delivers
      // them (follow-ups ride the natural stop, steering/injects ride the
      // first step boundary).
      if (queuedConfirmActive && !running && session.pendingInputCount > 0) {
        queuedConfirmActive = false;
        const queuedInput = session.takeNextPendingInput();
        if (queuedInput) {
          void startRun(queuedInput);
          return;
        }
        renderDynamic();
        return;
      }
      restoreRecalledFollowUpIfAbandoned();
      renderDynamic();
      return;
    }
    if (running) {
      if (text.startsWith('/')) {
        // Slash commands are not a resubmit of the recalled follow-up.
        restoreAbandonedFollowUp(session, recalledFollowUp);
        recalledFollowUp = null;
        const command = text.slice(1).trim().split(/\s/u, 1)[0]?.toLowerCase() ?? '';
        if (!canRunInteractiveCommand(text.slice(1), true)) {
          appendStatic(formatInfoLine(`/${command} requires an idle session; it will be available after this run`));
          renderDynamic();
          return;
        }
        await runSlashCommand(text);
        renderDynamic();
        return;
      }
      // Resubmit consumes the recalled draft (re-queued below).
      recalledFollowUp = null;
      submitActiveInput(session, text, mode);
      appendStatic(mode === 'steer'
        ? formatInfoLine(`steering now: ${text.replace(/\s+/g, ' ')}`)
        : formatQueuedPrompt(text));
      renderDynamic();
      return;
    }
    if (commandBusy) {
      renderDynamic();
      return;
    }
    if (text.startsWith('/')) {
      restoreAbandonedFollowUp(session, recalledFollowUp);
      recalledFollowUp = null;
      await runSlashCommand(text);
      return;
    }
    recalledFollowUp = null;
    void startRun(text);
  }

  const inputController = new TuiInputController({
    editor,
    dialogs: {
      permission: () => dialog,
      selection: () => selectionDialog,
      setSelection: value => { selectionDialog = value; },
      textInput: () => textInputDialog,
      setTextInput: value => { textInputDialog = value; },
    },
    run: {
      isRunning: () => running,
      isShuttingDown: () => shuttingDown,
      abort: () => {
        if (!abortCtrl) return false;
        abortCtrl.abort();
        return true;
      },
      shutdown: () => { void shutdown(0); },
      submit: mode => { void submit(mode); },
      hasQueuedInputs: () => session.pendingInputCount > 0,
      discardQueuedInputs: () => { session.discardPendingInputs(); },
      setQueuedConfirm: value => {
        queuedConfirmActive = value;
        renderDynamic();
      },
      recallFollowUp: () => recallLatestFollowUp(session),
      setRecalledFollowUp: value => { recalledFollowUp = value; },
      restoreAbandonedRecall: restoreRecalledFollowUpIfAbandoned,
    },
    completions: {
      atCompletions,
      applyAtCompletion,
      menuSelected: () => menuSelected,
      setMenuSelected: value => { menuSelected = value; },
      atSelected: () => atSelected,
      setAtSelected: value => { atSelected = value; },
    },
    view: {
      render: renderDynamic,
      clearTerminal: () => process.stdout.write('\x1b[2J\x1b[H'),
    },
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    let exitCode = code;
    if (spinnerTimer) clearInterval(spinnerTimer);
    cancelScheduledDynamicRender();
    abortCtrl?.abort();
    screen.stop();
    process.stdout.write(`${A.dim}Goodbye.${A.reset}\n`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    try {
      await closeManagedPluginsForExit(() => sdk.close());
    } catch (error) {
      exitCode = 1;
      process.stderr.write(
        `[hadamard-tui] ERROR: ${errorMessage(error)} ` +
        'Check E2B/Playwright resources manually before assuming billing has stopped.\n',
      );
    }
    if (deviceLinkService) {
      await deviceLinkService.close().catch(error => {
        exitCode = 1;
        process.stderr.write(`[hadamard-tui] ERROR: Device Link cleanup failed: ${errorMessage(error)}\n`);
      });
      deviceLinkService = null;
    }
    await deleteEmptyTuiSession(session);
    const cleanupResults = await Promise.allSettled([
      ...(globalAssistantSdk ? [globalAssistantSdk.close()] : []),
      externalCliRuntimeManager.close(),
      ...[...externalBridgeRuntimes.values()].map(runtime => runtime.client.close()),
    ]);
    const cleanupFailures = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (cleanupFailures.length > 0) {
      exitCode = 1;
      process.stderr.write(
        `[hadamard-tui] ERROR: ${cleanupFailures.length} runtime cleanup operation(s) failed: ` +
        `${cleanupFailures.map(result => errorMessage(result.reason)).join('; ')}\n`,
      );
    }
    externalBridgeRuntimes.clear();
    externalCliRunLabels.clear();
    process.exit(exitCode);
  }

  process.stdout.write('\x1b[2J\x1b[H');
  screen.start();
  await refreshContextEstimate();
  paintWelcome();
  if (currentPermissionMode() === 'bypassPermissions') {
    const fullAccessWarning = await consumeFullAccessWarning();
    if (fullAccessWarning) {
      appendStatic([...formatErrorLine(`WARNING: ${fullAccessWarning}`), '']);
    }
  }
  paintSessionHistory();
  await restoreSessionRuntimeSelection();
  renderDynamic();

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (char: string | undefined, key: Key | undefined) => {
    try {
      inputController.handleKey(char, key ?? {});
    } catch (error) {
      appendStatic(formatErrorLine(`input error: ${(error as Error).message}`));
      renderDynamic();
    }
  });
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  process.stdout.on('resize', () => renderDynamic());

  // Keep the process alive until shutdown() exits it.
  await new Promise(() => {});
}
