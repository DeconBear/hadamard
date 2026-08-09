/**
 * Global Assistant tools — cross-project overview + Hadamard app configuration.
 *
 * Hard constraints (enforced here, not only by prompt):
 *   - No Write/Edit/Bash against user source trees.
 *   - Secrets are never returned in tool results.
 *   - Project-scoped tools require an explicit projectPath that exists in the
 *     workspace registry (or is the current workDir).
 */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { resolveHadamardHome } from '../config/hadamardHome.js';
import {
  deleteAgentProfile,
  validateAgentProfile,
  listAgentProfiles,
  listSelectableAgents,
  upsertAgentProfile,
  type AgentProfile,
} from '../config/agentProfiles.js';
import { getHadamardProjectSessionDirectory } from '../config/projectSessionDirectory.js';
import {
  listProjectIssues,
  type IssueStorageMode,
  isIssueStorageMode,
} from '../issues/issueStore.js';
import { addMcpServer, readMcpServerConfig, removeMcpServer } from '../mcp/mcpServerConfig.js';
import {
  addBridgeConfig,
  findBridgeConfig,
  readBridgeConfigs,
  removeBridgeConfig,
  type PersistedBridgeConfig,
} from '../parity/bridgeConfigs.js';
import {
  deleteRouterProfile,
  listRouterProfiles,
  saveRouterProfile,
} from '../router/modelRouter.js';
import {
  MANAGED_PLUGIN_IDS,
  patchManagedPluginSettings,
  readManagedPluginCatalog,
  type ManagedPluginId,
} from '../plugins/managedPluginCatalog.js';
import { isRecord } from '../runtime/helpers.js';
import { tool } from '../runtime/tools.js';
import {
  listScheduledAutomationTasks,
  setScheduledAutomationEnabled,
  upsertScheduledAutomationTask,
} from '../scheduling/taskPersistence.js';
import type {
  AgentToolDefinition,
  AgentTargetRef,
  RouterModelRef,
  RouterProfile,
  ScheduledAutomationTask,
  ScheduledAutomationTaskInput,
} from '../types.js';
import { isProjectStatus, readProjectMeta, writeProjectMeta } from '../gui/projectMeta.js';
import { readWorkspaceNote, writeWorkspaceNote } from '../gui/workspaceNote.js';
import { readWorkspaceRegistry } from '../gui/workspaceRegistry.js';
import {
  readManagerConfig,
  readProgressFile,
  readProjectPlanFile,
} from './projectManager.js';
import {
  buildReferenceIndex,
  findBrokenRefs,
  findUsages,
  type ReferenceEdge,
  type ReferenceIndexSessionState,
  type ReferenceKnownSets,
} from './referenceIndex.js';
import {
  renameDefinitionAndReferences,
  type ReferenceDefinitionKind,
  type ReferenceOperationContext,
} from './referenceOperations.js';
import {
  AssistantProposalStore,
  type AssistantProposal,
} from './assistantProposals.js';
import { TeamProposalStore, type TeamGraphProposal } from '../team/teamProposalService.js';
import {
  deleteTeamDefinition,
  getBuiltInTeamDefinition,
  listTeamDefinitions,
  loadTeamDefinition,
} from '../team/teamDefinitions.js';
import {
  readAllAgentReferenceProfiles,
  listAgentDefinitionNames,
  writeAgentDefinitionMarkdown,
  writeAgentProfileMarkdown,
  deleteAgentProfileMarkdown,
  projectAgentDefinitionsDir,
  type AgentDefinitionExtraFields,
} from '../config/agentDefinitionMigration.js';
import type { TeamPreferences } from '../team/teamPreferences.js';
import type { TeamDefinition } from '../types.js';
import { deleteWorkflow, listWorkflows } from '../workflow/workflowPersistence.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadHadamardAgentDefinitions } from '../runtime/hadamardAgentDefinitions.js';
import {
  getProductCapability,
  productCapabilities,
  searchProductCapabilities,
} from '../help/productCapabilities.js';

export type AssistantScope = 'global' | 'project';

export function isAssistantScope(value: unknown): value is AssistantScope {
  return value === 'global' || value === 'project';
}

export interface AssistantGlobalConfig {
  model?: string;
  bridgeConfig?: string;
  /** Selected Global Assistant conversation. Optional for pre-upgrade configs. */
  activeSessionId?: string;
}

export const DEFAULT_ASSISTANT_CONFIG: AssistantGlobalConfig = {};

export function assistantConfigPath(homeDir?: string): string {
  return path.join(resolveHadamardHome(homeDir), 'assistant.json');
}

export async function readAssistantConfig(homeDir?: string): Promise<AssistantGlobalConfig> {
  try {
    const raw = JSON.parse(await readFile(assistantConfigPath(homeDir), 'utf8'));
    if (!isRecord(raw)) return { ...DEFAULT_ASSISTANT_CONFIG };
    return {
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
      bridgeConfig: typeof raw.bridgeConfig === 'string' && raw.bridgeConfig.trim()
        ? raw.bridgeConfig.trim()
        : undefined,
      activeSessionId: typeof raw.activeSessionId === 'string' && raw.activeSessionId.trim()
        ? raw.activeSessionId.trim()
        : undefined,
    };
  } catch {
    return { ...DEFAULT_ASSISTANT_CONFIG };
  }
}

export async function writeAssistantConfig(
  config: AssistantGlobalConfig,
  homeDir?: string,
): Promise<void> {
  const filePath = assistantConfigPath(homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    ...(config.model ? { model: config.model } : {}),
    ...(config.bridgeConfig ? { bridgeConfig: config.bridgeConfig } : {}),
    ...(config.activeSessionId ? { activeSessionId: config.activeSessionId } : {}),
  }, null, 2), 'utf8');
}

export interface AssistantProjectBrief {
  name: string;
  path: string;
  note: string;
  status: string;
  sessionCount: number;
  issueCounts: { total: number; open: number; review: number; closed: number };
  active: boolean;
  pinned: boolean;
  lastUsedAt: string;
}

export interface AssistantEditorContext {
  activeRegion: string;
  entityKind?: 'agent' | 'router' | 'graph' | 'workflow';
  entityName?: string;
  dirty: boolean;
  baseDigest?: string;
  draft?: TeamDefinition | Record<string, unknown>;
}

export interface AssistantGlobalHost {
  homeDir: string;
  currentWorkDir: string;
  /** Lightweight app snapshot for GetAppState (no secrets). */
  getAppState?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Active GUI editor and unsaved draft captured at the start of this turn. */
  getEditorContext?: () => AssistantEditorContext | null | Promise<AssistantEditorContext | null>;
  /** Open/switch the GUI workspace. */
  openProject?: (projectPath: string) => Promise<{ workDir: string }>;
  /** Apply a safe settings subset (prefs / env tiers / permission). */
  applySettings?: (patch: Record<string, unknown>) => Promise<{ ok: boolean; detail?: string }>;
  /** Activate a selectable agent / profile by name. */
  activateAgent?: (name: string) => Promise<{ ok: boolean; detail?: string }>;
  /** Activate a provider config, router profile, or attached Graph/Workflow. */
  activateTarget?: (kind: 'config' | 'router' | 'team', name: string) => Promise<{ ok: boolean; detail?: string }>;
  /** Optional raw settings store for managed plugin patches. */
  readSettingsRaw?: () => Promise<Record<string, unknown>>;
  writeSettingsRaw?: (raw: Record<string, unknown>) => Promise<void>;
  /** Assistant session id; required to stage confirmation proposals. */
  assistantSessionId?: string;
  /** Shared staged-action store for destructive confirmations (P3). */
  proposals?: AssistantProposalStore;
  /** Notify the client about a staged confirmation card. */
  onProposal?: (proposal: AssistantProposal) => void;
  /** Shared Team graph proposal store used by UpsertTeam. */
  teamProposals?: TeamProposalStore;
  /** Notify the client about a staged Team proposal card. */
  onTeamProposal?: (proposal: TeamGraphProposal) => void;
  /** Reference index snapshot (same source as /api/references). Defaults to a local scan. */
  getReferenceSnapshot?: () => Promise<{ index: ReferenceEdge[]; known: ReferenceKnownSets }>;
  /** Active-session reference edges (activeAgent/activeConfig/activeRouter/activeTeam). */
  getSessionRefState?: () => ReferenceIndexSessionState | null;
  /** teamPreferences for the defaultAttached reference edge. */
  readTeamPreferences?: () => TeamPreferences | null;
  /** Persist Agents-page activation/confirmation preferences. */
  writeTeamPreferences?: (preferences: TeamPreferences) => Promise<void>;
  /** Context for rename/delete transactions; defaults to currentWorkDir/homeDir. */
  referenceOperationContext?: () => Promise<ReferenceOperationContext> | ReferenceOperationContext;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function redactBridgeConfig(config: PersistedBridgeConfig): Record<string, unknown> {
  return {
    name: config.name,
    runtime: config.runtime,
    execution: config.execution ?? 'api',
    authSource: config.authSource ?? (config.execution === 'cli' ? 'native' : 'apiKey'),
    credentialProvider: config.credentialProvider,
    trustProjectResources: config.trustProjectResources === true,
    provider: config.provider,
    baseURL: config.baseURL || undefined,
    model: config.model || undefined,
    models: (config.models ?? []).map(model => ({
      name: model.name,
      context1M: model.context1M === true,
      contextWindowTokens: model.contextWindowTokens,
      maxContextWindowTokens: model.maxContextWindowTokens,
      effectiveContextWindowPercent: model.effectiveContextWindowPercent,
      autoCompactTokenLimit: model.autoCompactTokenLimit,
      modality: model.modality ?? 'text',
    })),
    hasApiKey: Boolean(typeof config.apiKey === 'string' && config.apiKey.trim()),
  };
}

function redactRouterRef(ref: RouterModelRef): Record<string, unknown> {
  return {
    model: ref.model,
    provider: ref.provider,
    baseURL: ref.baseURL,
    maxTokens: ref.maxTokens,
    hasApiKey: Boolean(ref.apiKey),
  };
}

function redactRouterProfile(profile: RouterProfile): Record<string, unknown> {
  return {
    name: profile.name,
    description: profile.description,
    routerModel: redactRouterRef(profile.routerModel),
    routes: profile.routes.map(route => ({
      ...redactRouterRef(route),
      when: route.when,
      name: route.name,
      role: route.role,
      description: route.description,
      effort: route.effort,
      target: route.target,
    })),
    fallback: profile.fallback ? redactRouterRef(profile.fallback) : undefined,
    fallbackTarget: profile.fallbackTarget,
    classificationPrompt: profile.classificationPrompt,
  };
}

function redactEditorContext(context: AssistantEditorContext | null): AssistantEditorContext | null {
  if (!context) return null;
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(apiKey|password|secret|accessToken|refreshToken)$/i.test(key)) {
        out[`${key}Configured`] = Boolean(typeof item === 'string' ? item.trim() : item);
      } else {
        out[key] = redact(item);
      }
    }
    return out;
  };
  return {
    ...context,
    ...(context.draft ? { draft: redact(context.draft) as AssistantEditorContext['draft'] } : {}),
  };
}

export async function listAssistantProjectBriefs(
  homeDir: string,
  currentWorkDir: string,
): Promise<AssistantProjectBrief[]> {
  const current = path.resolve(currentWorkDir);
  const byPath = new Map<string, AssistantProjectBrief>();
  const add = (projectPath: string, pinned = false, lastUsedAt = '') => {
    const resolved = path.resolve(projectPath);
    const key = resolved.toLowerCase();
    const existing = byPath.get(key);
    byPath.set(key, {
      name: path.basename(resolved) || resolved,
      path: resolved,
      note: existing?.note ?? '',
      status: existing?.status ?? 'not_started',
      sessionCount: existing?.sessionCount ?? 0,
      issueCounts: existing?.issueCounts ?? { total: 0, open: 0, review: 0, closed: 0 },
      active: path.resolve(resolved).toLowerCase() === current.toLowerCase(),
      pinned: Boolean(existing?.pinned || pinned),
      lastUsedAt: existing?.lastUsedAt && existing.lastUsedAt > lastUsedAt
        ? existing.lastUsedAt
        : lastUsedAt,
    });
  };
  add(current);
  const registry = await readWorkspaceRegistry(homeDir);
  for (const entry of registry) {
    if (!(await pathExists(entry.path))) continue;
    add(entry.path, entry.pinned === true, entry.lastOpenedAt || '');
  }
  const rows = [...byPath.values()];
  await Promise.all(rows.map(async (project) => {
    const [note, meta] = await Promise.all([
      readWorkspaceNote(project.path, homeDir),
      readProjectMeta(project.path, homeDir),
    ]);
    project.note = note;
    project.status = meta.status;
    const storage: IssueStorageMode = isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home';
    const issues = await listProjectIssues(project.path, homeDir, storage).catch(() => []);
    project.issueCounts = {
      total: issues.length,
      open: issues.filter(issue => issue.status !== 'done' && issue.status !== 'cancelled').length,
      review: issues.filter(issue => issue.status === 'in_review').length,
      closed: issues.filter(issue => issue.status === 'done' || issue.status === 'cancelled').length,
    };
  }));
  return rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastUsedAt || '').localeCompare(a.lastUsedAt || '');
  });
}

async function assertKnownProject(
  host: AssistantGlobalHost,
  projectPath: string,
): Promise<string> {
  const resolved = path.resolve(projectPath);
  if (!(await pathExists(resolved))) {
    throw new Error(`Project path does not exist: ${resolved}`);
  }
  const briefs = await listAssistantProjectBriefs(host.homeDir, host.currentWorkDir);
  const known = briefs.some(item => path.resolve(item.path).toLowerCase() === resolved.toLowerCase());
  if (!known) {
    throw new Error(
      `Unknown project path: ${resolved}. Use ListProjects and pass a registered workspace path.`,
    );
  }
  return resolved;
}

/** Reference snapshot used by the P3 reference/delete tools (same edges as /api/references). */
async function getReferenceSnapshot(
  host: AssistantGlobalHost,
): Promise<{ index: ReferenceEdge[]; known: ReferenceKnownSets }> {
  if (host.getReferenceSnapshot) return host.getReferenceSnapshot();
  const bridgeConfigs = readBridgeConfigs(host.homeDir).configs;
  // S3 unified store: profile edges come from the legacy store AND .md
  // definitions in both scopes (incl. bridgeConfig-only definitions).
  const profileByName = new Map(listAgentProfiles(host.homeDir).map(profile => [profile.name, profile]));
  for (const profile of readAllAgentReferenceProfiles(host.homeDir, host.currentWorkDir)) {
    profileByName.set(profile.name, profile);
  }
  const agentProfiles = [...profileByName.values()];
  const routers = listRouterProfiles(host.currentWorkDir, host.homeDir).map(entry => entry.profile);
  const teams = listTeamDefinitions(host.currentWorkDir, host.homeDir).map(entry => entry.definition);
  const automationTasks = await listScheduledAutomationTasks(host.currentWorkDir)
    .catch(() => [] as ScheduledAutomationTask[]);
  const manager = await readManagerConfig(host.currentWorkDir, resolveHadamardHome(host.homeDir))
    .catch(() => undefined);
  const projectMeta = await readProjectMeta(host.currentWorkDir, host.homeDir);
  const issueStorage: IssueStorageMode = isIssueStorageMode(projectMeta.issueStorage)
    ? projectMeta.issueStorage
    : 'home';
  const [issues, assistantConfig] = await Promise.all([
    listProjectIssues(host.currentWorkDir, host.homeDir, issueStorage).catch(() => []),
    readAssistantConfig(host.homeDir),
  ]);
  const workflows = listWorkflows(host.currentWorkDir, host.homeDir);
  const index = buildReferenceIndex({
    bridgeConfigs,
    agentProfiles,
    routers,
    teams,
    automationTasks,
    teamPreferences: host.readTeamPreferences?.() ?? null,
    managerConfigs: manager
      ? [{ name: host.currentWorkDir, bridgeConfig: manager.bridgeConfig }]
      : [],
    issues,
    assistantConfig,
    session: host.getSessionRefState?.() ?? null,
  });
  return {
    index,
    known: {
      configs: bridgeConfigs.map(config => config.name),
      // Selectable agents include ephemeral per-config presets so an active
      // session edge to one of them is not falsely reported as broken; the
      // .md definition names cover unified-store agents in both scopes (S3).
      agents: [
        ...listSelectableAgents(host.homeDir).map(agent => agent.name),
        ...listAgentDefinitionNames(host.homeDir, host.currentWorkDir),
      ],
      teams: teams.map(team => team.name),
      routers: routers.map(router => router.name),
      workflows: workflows.map(workflow => workflow.name),
    },
  };
}

async function resolveReferenceOperationContext(
  host: AssistantGlobalHost,
): Promise<ReferenceOperationContext> {
  if (host.referenceOperationContext) return host.referenceOperationContext();
  return {
    projectDir: host.currentWorkDir,
    homeDir: host.homeDir,
    managerProjectPath: host.currentWorkDir,
  };
}

/**
 * P3 delete discipline: zero-reference deletes proceed immediately; when
 * findUsages reports references the definition is NOT deleted — a proposal
 * card with the reference list and fallback strategies is staged instead, and
 * only Apply (GUI endpoint over AssistantProposalStore) executes the delete.
 */
async function deleteWithConfirmation(
  host: AssistantGlobalHost,
  kind: ReferenceDefinitionKind,
  name: string,
  deleteNow: () => Promise<unknown> | unknown,
): Promise<Record<string, unknown>> {
  const { index } = await getReferenceSnapshot(host);
  const usages = findUsages(index, kind, name);
  if (usages.length === 0) {
    await deleteNow();
    return { ok: true, deleted: true, references: [] };
  }
  if (!host.proposals || !host.assistantSessionId) {
    throw new Error(
      `Refusing to delete ${kind} "${name}": ${usages.length} reference(s) exist and no `
      + 'confirmation channel is available in this host. References: '
      + usages.map(edge => `${edge.from.kind} "${edge.from.name}" (${edge.field})`).join('; '),
    );
  }
  const proposal = host.proposals.stageDelete({
    assistantSessionId: host.assistantSessionId,
    kind,
    name,
    references: usages,
  });
  host.onProposal?.(proposal);
  return {
    ok: true,
    deleted: false,
    staged: true,
    proposalId: proposal.id,
    message: `Found ${usages.length} reference(s) — staged a confirmation card. `
      + `The ${kind} is deleted only after the user applies it.`,
    references: usages,
    strategies: proposal.delete?.strategies ?? [],
  };
}

export function buildAssistantGlobalSystemPrompt(currentWorkDir: string): string {
  return [
    'You are the Hadamard desktop Assistant in Global scope.',
    `The GUI is currently focused on workspace: ${currentWorkDir}.`,
    '',
    'Your job: help the user understand and operate Hadamard itself — projects, settings, provider configs, agent profiles, router profiles, plugins, automation, and MCP — without modifying project source code.',
    '',
    'Hard rules:',
    '- You have no Write/Edit/Bash tools for source trees. Do not invent workarounds.',
    '- Start with ListProjects when the user asks about workspaces or status across projects.',
    '- Use GetProjectOverview / GetProjectDocument / ListProjectIssues for deeper project inspection; always pass an explicit projectPath from ListProjects.',
    '- Before changing settings, plugins, bridge configs, agents, schedules, or MCP, briefly say what you will change, then call the matching tool.',
    '- Use ListReferences(kind, name) before any rename/delete to show impact, and ListBrokenReferences for proactive health checks.',
    '- Rename tools (RenameBridgeConfig / RenameAgentProfile / RenameRouterProfile / RenameTeam) run one transaction that atomically rewrites every referencing definition.',
    '- Delete-class tools (DeleteBridgeConfig / DeleteAgentProfile / DeleteRouterProfile / DeleteTeam) delete immediately only when nothing references the definition. When references exist they stage a confirmation card with the reference list and fallback strategies; the delete happens only when the user applies that card. Never claim a delete completed while a proposal is pending.',
    '- UpsertTeam and UpsertWorkflow stage proposal cards (Preview/Apply) — they never write to disk directly. DeleteWorkflow removes an unreferenced script workflow directly and refuses while automation tasks still reference it.',
    '- For any question about how to use Hadamard or what a feature does, call SearchProductCapabilities (or List/ReadProductCapability) and ground the answer in its UI location, prerequisites, steps, commands, and limitations. Do not answer product instructions from memory alone.',
    '- Before changing the currently open Agent, Router, Graph, or Workflow, call GetCurrentEditorContext. Preserve its baseDigest when staging a Graph/Workflow proposal so Apply can reject stale drafts.',
    '- ActivateAgent activates a saved profile by default; kind "config" activates a model configuration, kind "router" activates a Router, and kind "team" attaches a Graph or Workflow.',
    '- Never echo API keys or other secrets. Tool results already redact them.',
    '- Coding and file edits belong in the main chat, not here. Prefer OpenProject + telling the user to continue in the main conversation when implementation work is needed.',
    '- Be concise and concrete.',
  ].join('\n');
}

export async function createAssistantGlobalTools(
  host: AssistantGlobalHost,
): Promise<AgentToolDefinition[]> {
  const routerRefSchema = z.strictObject({
    model: z.string(),
    provider: z.enum(['anthropic', 'openai']).optional(),
    baseURL: z.string().optional(),
    apiKey: z.string().optional().describe('$ENV_VAR reference; literal secrets are not persisted'),
    maxTokens: z.number().int().positive().optional(),
  });
  const targetRefSchema: z.ZodType<AgentTargetRef> = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('model'), config: z.string(), model: z.string() }),
    z.strictObject({ kind: z.literal('agent'), name: z.string() }),
    z.strictObject({ kind: z.literal('team'), name: z.string() }),
  ]);
  const ListProjects = tool(
    {
      name: 'ListProjects',
      description: 'List remembered Hadamard workspaces with brief note, status, and issue counts.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({
      currentWorkDir: host.currentWorkDir,
      projects: await listAssistantProjectBriefs(host.homeDir, host.currentWorkDir),
    }),
  );

  const GetProjectOverview = tool(
    {
      name: 'GetProjectOverview',
      description: 'Get a compact overview for one registered project (note, status, plan/progress summaries, issues).',
      inputSchema: z.strictObject({
        projectPath: z.string().describe('Absolute workspace path from ListProjects'),
      }),
      isReadOnly: () => true,
    },
    async (input) => {
      const projectPath = await assertKnownProject(host, input.projectPath);
      const [note, meta, plan, progress] = await Promise.all([
        readWorkspaceNote(projectPath, host.homeDir),
        readProjectMeta(projectPath, host.homeDir),
        readProjectPlanFile(projectPath, host.homeDir),
        readProgressFile(projectPath, host.homeDir),
      ]);
      const storage: IssueStorageMode = isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home';
      const issues = await listProjectIssues(projectPath, host.homeDir, storage).catch(() => []);
      return {
        path: projectPath,
        name: path.basename(projectPath),
        note,
        status: meta.status,
        plan: {
          milestones: plan.milestones.length,
          today: plan.today.length,
          upcoming: plan.upcoming.length,
          milestoneTitles: plan.milestones.slice(0, 8).map(item => item.title),
        },
        progressChars: progress?.length ?? 0,
        progressPreview: progress ? progress.slice(0, 1200) : null,
        issueCounts: {
          total: issues.length,
          open: issues.filter(issue => issue.status !== 'done' && issue.status !== 'cancelled').length,
          review: issues.filter(issue => issue.status === 'in_review').length,
          closed: issues.filter(issue => issue.status === 'done' || issue.status === 'cancelled').length,
        },
        sessionDirectory: getHadamardProjectSessionDirectory(projectPath, host.homeDir),
      };
    },
  );

  const GetProjectDocument = tool(
    {
      name: 'GetProjectDocument',
      description: 'Read full plan.json, PROGRESS.md, or project note for a registered project.',
      inputSchema: z.strictObject({
        projectPath: z.string(),
        kind: z.enum(['plan', 'progress', 'note']),
      }),
      isReadOnly: () => true,
    },
    async (input) => {
      const projectPath = await assertKnownProject(host, input.projectPath);
      if (input.kind === 'plan') {
        return { kind: 'plan', content: await readProjectPlanFile(projectPath, host.homeDir) };
      }
      if (input.kind === 'progress') {
        return { kind: 'progress', content: await readProgressFile(projectPath, host.homeDir) };
      }
      return { kind: 'note', content: await readWorkspaceNote(projectPath, host.homeDir) };
    },
  );

  const ListProjectIssues = tool(
    {
      name: 'ListProjectIssues',
      description: 'List issues for a registered project.',
      inputSchema: z.strictObject({
        projectPath: z.string(),
      }),
      isReadOnly: () => true,
    },
    async (input) => {
      const projectPath = await assertKnownProject(host, input.projectPath);
      const meta = await readProjectMeta(projectPath, host.homeDir);
      const storage: IssueStorageMode = isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home';
      const issues = await listProjectIssues(projectPath, host.homeDir, storage);
      return {
        projectPath,
        issues: issues.map(issue => ({
          id: issue.id,
          key: `ISS-${issue.number}`,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
          agentConfig: issue.agentConfig ?? null,
          updatedAt: issue.updatedAt,
        })),
      };
    },
  );

  const GetAppState = tool(
    {
      name: 'GetAppState',
      description: 'Get the current GUI focus (region, workDir, credentials flag). No secrets.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({
      currentWorkDir: host.currentWorkDir,
      homeDir: host.homeDir,
      ...(host.getAppState ? await host.getAppState() : {}),
    }),
  );

  const GetCurrentEditorContext = tool(
    {
      name: 'GetCurrentEditorContext',
      description: 'Read the active GUI page/entity and its unsaved Agent, Router, Graph, or Workflow draft with a stable base digest. Use before proposing editor changes.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({
      context: redactEditorContext(host.getEditorContext ? await host.getEditorContext() : null),
    }),
  );

  const ListProductCapabilities = tool(
    {
      name: 'ListProductCapabilities',
      description: 'List the machine-readable Hadamard capability catalog. Use this, SearchProductCapabilities, or ReadProductCapability before answering product how-to questions.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({
      capabilities: productCapabilities.map(capability => ({
        id: capability.id,
        title: capability.title,
        summary: capability.summary,
        uiLocations: capability.uiLocations,
        commands: capability.commands,
      })),
    }),
  );

  const SearchProductCapabilities = tool(
    {
      name: 'SearchProductCapabilities',
      description: 'Search grounded product instructions by feature, UI label, command, or user goal.',
      inputSchema: z.strictObject({
        query: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      isReadOnly: () => true,
    },
    async input => ({ capabilities: searchProductCapabilities(input.query, input.limit) }),
  );

  const ReadProductCapability = tool(
    {
      name: 'ReadProductCapability',
      description: 'Read complete current instructions for one capability id returned by List/SearchProductCapabilities.',
      inputSchema: z.strictObject({ id: z.string() }),
      isReadOnly: () => true,
    },
    async input => {
      const capability = getProductCapability(input.id);
      if (!capability) throw new Error(`Unknown product capability: ${input.id}`);
      return { capability };
    },
  );

  const ListBridgeConfigs = tool(
    {
      name: 'ListBridgeConfigs',
      description: 'List saved provider/bridge configs (API keys redacted).',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({
      configs: readBridgeConfigs(host.homeDir).configs.map(redactBridgeConfig),
    }),
  );

  const ListAgentProfiles = tool(
    {
      name: 'ListAgentProfiles',
      description: 'List saved agent profiles and selectable auto presets.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => {
      const definitions = await loadHadamardAgentDefinitions({
        homeDir: host.homeDir,
        workDir: host.currentWorkDir,
      });
      return {
      profiles: listAgentProfiles(host.homeDir),
      definitions: definitions.map(definition => ({
        name: definition.name,
        description: definition.description,
        source: definition.source,
        sourcePath: definition.sourcePath,
        bridgeConfig: definition.bridgeConfig,
        model: definition.model,
        inheritSessionModel: !definition.bridgeConfig || !definition.model,
        promptMode: definition.promptMode,
        permissionMode: definition.permissionMode,
        effort: definition.effort,
        maxTokens: definition.maxTokens,
        temperature: definition.temperature,
        topP: definition.topP,
        allowedTools: definition.allowedTools,
        workspaceAccess: definition.workspaceAccess,
        maxIterations: definition.maxToolIterations ?? definition.maxTurns,
        timeoutMs: definition.timeoutMs,
        subagent: definition.subagent !== false,
      })),
      selectable: listSelectableAgents(host.homeDir).map(agent => ({
        name: agent.name,
        source: agent.source,
        bridgeConfig: agent.bridgeConfig,
        model: agent.model,
        effort: agent.effort,
        ephemeral: agent.ephemeral === true,
      })),
    };
    },
  );

  const ListRouterProfilesTool = tool(
    {
      name: 'ListRouterProfiles',
      description: 'List project and personal router profiles with API keys redacted.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({
      profiles: listRouterProfiles(host.currentWorkDir, host.homeDir).map(item => ({
        source: item.source,
        profile: redactRouterProfile(item.profile),
      })),
    }),
  );

  const ListPlugins = tool(
    {
      name: 'ListPlugins',
      description: 'List managed plugins and public (non-secret) config.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => {
      const raw = host.readSettingsRaw ? await host.readSettingsRaw() : {};
      const catalog = readManagedPluginCatalog(raw);
      return {
        plugins: catalog.plugins.map(plugin => ({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          category: plugin.category,
          enabled: plugin.enabled,
          state: plugin.state,
          secretConfigured: plugin.secretConfigured,
          config: plugin.config,
        })),
      };
    },
  );

  const ListScheduledTasks = tool(
    {
      name: 'ListScheduledTasks',
      description: 'List automation tasks for the current workspace.',
      inputSchema: z.strictObject({
        projectPath: z.string().optional().describe('Defaults to current workDir'),
      }),
      isReadOnly: () => true,
    },
    async (input) => {
      const projectPath = input.projectPath
        ? await assertKnownProject(host, input.projectPath)
        : path.resolve(host.currentWorkDir);
      const tasks = await listScheduledAutomationTasks(projectPath);
      return {
        projectPath,
        tasks: tasks.map(task => ({
          id: task.id,
          name: task.name,
          kind: task.kind,
          trigger: task.trigger ?? 'schedule',
          cron: task.cron,
          enabled: task.enabled,
          workflowName: task.workflowName,
          nextRunAt: task.nextRunAt,
          lastRunAt: task.lastRunAt,
          lastResult: task.lastResult,
        })),
      };
    },
  );

  const ListMcpServers = tool(
    {
      name: 'ListMcpServers',
      description: 'List configured MCP servers.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({
      servers: readMcpServerConfig(host.homeDir).servers,
    }),
  );

  const OpenProject = tool(
    {
      name: 'OpenProject',
      description: 'Switch the GUI to a registered workspace path.',
      inputSchema: z.strictObject({
        projectPath: z.string(),
      }),
    },
    async (input) => {
      if (!host.openProject) throw new Error('OpenProject is unavailable in this host.');
      const projectPath = await assertKnownProject(host, input.projectPath);
      const result = await host.openProject(projectPath);
      return { ok: true, workDir: result.workDir };
    },
  );

  const UpdateProjectNote = tool(
    {
      name: 'UpdateProjectNote',
      description: 'Update the short workspace note shown on the project card.',
      inputSchema: z.strictObject({
        projectPath: z.string(),
        content: z.string(),
      }),
    },
    async (input) => {
      const projectPath = await assertKnownProject(host, input.projectPath);
      const saved = await writeWorkspaceNote(projectPath, host.homeDir, input.content);
      return { ok: true, path: saved };
    },
  );

  const UpdateProjectStatus = tool(
    {
      name: 'UpdateProjectStatus',
      description: 'Update the manual project lifecycle status.',
      inputSchema: z.strictObject({
        projectPath: z.string(),
        status: z.enum(['in_progress', 'planning', 'on_hold', 'not_started', 'completed']),
      }),
    },
    async (input) => {
      const projectPath = await assertKnownProject(host, input.projectPath);
      if (!isProjectStatus(input.status)) throw new Error(`Invalid status: ${input.status}`);
      const meta = await writeProjectMeta(projectPath, host.homeDir, { status: input.status });
      return { ok: true, meta };
    },
  );

  const UpdateGuiPreferences = tool(
    {
      name: 'UpdateGuiPreferences',
      description: 'Update GUI preferences, including which config/profile types appear in the chat model picker.',
      inputSchema: z.strictObject({
        theme: z.enum(['system', 'light', 'dark']).optional(),
        density: z.enum(['comfortable', 'compact']).optional(),
        enterToSend: z.boolean().optional(),
        autoScroll: z.boolean().optional(),
        developerTools: z.boolean().optional(),
        showBranchInComposer: z.boolean().optional(),
        showProviderConfigsInComposer: z.boolean().optional(),
        showAgentProfilesInComposer: z.boolean().optional(),
        showRouterProfilesInComposer: z.boolean().optional(),
        useDefaultModelAsFallback: z.boolean().optional(),
        showBuiltInSubagents: z.boolean().optional(),
      }),
    },
    async (input) => {
      if (!host.applySettings) throw new Error('UpdateGuiPreferences is unavailable in this host.');
      return host.applySettings({ preferences: input });
    },
  );

  const UpdateRuntimeEnv = tool(
    {
      name: 'UpdateRuntimeEnv',
      description: 'Update runtime env defaults (provider, defaultModel, baseURL, model tiers, permission preset). Does not echo API keys.',
      inputSchema: z.strictObject({
        provider: z.enum(['anthropic', 'openai']).optional(),
        defaultModel: z.string().optional(),
        baseURL: z.string().optional(),
        apiKey: z.string().optional().describe('Write-only; never returned'),
        clearApiKey: z.boolean().optional(),
        permissionPreset: z.enum(['full', 'workspace', 'read-only']).optional(),
        minModel: z.string().optional(),
        mediumModel: z.string().optional(),
        maxModel: z.string().optional(),
        effort: z.enum(['auto', 'low', 'medium', 'high', 'max']).optional(),
        defaultModelContext1M: z.boolean().optional(),
        defaultModelMultimodal: z.boolean().optional(),
      }),
    },
    async (input) => {
      if (!host.applySettings) throw new Error('UpdateRuntimeEnv is unavailable in this host.');
      const result = await host.applySettings(input);
      return { ok: result.ok, detail: result.detail, apiKeySet: Boolean(input.apiKey?.trim()) };
    },
  );

  const UpsertBridgeConfigTool = tool(
    {
      name: 'UpsertBridgeConfig',
      description: 'Create or update a provider/bridge config. API key is write-only.',
      inputSchema: z.strictObject({
        name: z.string(),
        runtime: z.enum(['hadamard', 'claude', 'codewhale', 'pi', 'codex', 'reasonix', 'crush']),
        execution: z.enum(['api', 'cli']).optional(),
        authSource: z.enum(['native', 'apiKey']).optional(),
        credentialProvider: z.string().optional(),
        trustProjectResources: z.boolean().optional(),
        provider: z.enum(['anthropic', 'openai']).optional(),
        baseURL: z.string().optional(),
        apiKey: z.string().optional(),
        model: z.string().optional(),
        models: z.array(z.strictObject({
          name: z.string(),
          context1M: z.boolean().optional(),
          contextWindowTokens: z.number().int().positive().optional(),
          maxContextWindowTokens: z.number().int().positive().optional(),
          effectiveContextWindowPercent: z.number().positive().max(100).optional(),
          autoCompactTokenLimit: z.number().int().positive().optional(),
          modality: z.enum(['text', 'multimodal']).optional(),
        })).optional(),
      }),
    },
    async (input) => {
      const existing = findBridgeConfig(input.name, host.homeDir);
      const next: PersistedBridgeConfig = {
        name: input.name.trim(),
        runtime: input.runtime,
        execution: input.execution ?? existing?.execution ?? 'api',
        authSource: input.authSource ?? existing?.authSource,
        credentialProvider: input.credentialProvider?.trim() || existing?.credentialProvider,
        trustProjectResources: input.trustProjectResources ?? existing?.trustProjectResources,
        provider: input.provider ?? existing?.provider ?? 'anthropic',
        baseURL: input.baseURL?.trim() || existing?.baseURL,
        apiKey: input.apiKey?.trim() || existing?.apiKey,
        model: input.model?.trim() || existing?.model,
        models: input.models ?? existing?.models,
      };
      addBridgeConfig(next, host.homeDir);
      return { ok: true, config: redactBridgeConfig(next) };
    },
  );

  const UpsertAgentProfileTool = tool(
    {
      name: 'UpsertAgentProfile',
      description: 'Create or update an agent (unified .md store, S3). Omit bridgeConfig+model for an inherit-session-model agent; pass scope "project" to save into <workDir>/.hadamard/agents.',
      inputSchema: z.strictObject({
        name: z.string(),
        bridgeConfig: z.string().optional().describe('Omit (with model) for an inherit-session-model agent'),
        model: z.string().optional(),
        description: z.string().optional(),
        permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto']).optional(),
        effort: z.enum(['auto', 'low', 'medium', 'high', 'max']).optional(),
        maxTokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().min(0).max(1).optional(),
        allowedTools: z.array(z.string().min(1)).optional(),
        workspaceAccess: z.enum(['workspace', 'full']).optional(),
        maxIterations: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
        systemPromptAppend: z.string().optional(),
        scope: z.enum(['project', 'personal']).optional().describe('Defaults to personal (~/.hadamard/agents)'),
        promptMode: z.enum(['extend', 'replace']).optional(),
        subagent: z.boolean().optional().describe('Default true: the Agent/Task tool may delegate to this agent'),
      }),
    },
    async (input) => {
      const inheritModel = !input.bridgeConfig?.trim() || !input.model?.trim();
      const extras: AgentDefinitionExtraFields = {
        ...(input.promptMode ? { promptMode: input.promptMode } : {}),
        ...(typeof input.subagent === 'boolean' ? { subagent: input.subagent } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(typeof input.maxTokens === 'number' ? { maxTokens: input.maxTokens } : {}),
        ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
        ...(typeof input.topP === 'number' ? { topP: input.topP } : {}),
        ...(input.allowedTools?.length ? { tools: input.allowedTools } : {}),
        ...(input.workspaceAccess ? { workspaceAccess: input.workspaceAccess } : {}),
        ...(typeof input.maxIterations === 'number' ? { maxIterations: input.maxIterations } : {}),
        ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
      };
      const scope = input.scope === 'project' ? 'project' : 'personal';
      const unified = inheritModel || scope === 'project' || Object.keys(extras).length > 0;
      const profile: AgentProfile = {
        name: input.name.trim(),
        bridgeConfig: input.bridgeConfig?.trim() ?? '',
        model: input.model?.trim() ?? '',
        ...(input.description ? { description: input.description } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(typeof input.maxTokens === 'number' ? { maxTokens: input.maxTokens } : {}),
        ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
        ...(typeof input.topP === 'number' ? { topP: input.topP } : {}),
        ...(input.allowedTools?.length ? { allowedTools: input.allowedTools } : {}),
        ...(input.workspaceAccess ? { workspaceAccess: input.workspaceAccess } : {}),
        ...(typeof input.maxIterations === 'number' ? { maxIterations: input.maxIterations } : {}),
        ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.systemPromptAppend ? { systemPromptAppend: input.systemPromptAppend } : {}),
        ...(input.promptMode ? { promptMode: input.promptMode } : {}),
        ...(typeof input.subagent === 'boolean' ? { subagent: input.subagent } : {}),
      };
      if (!unified) {
        const saved = upsertAgentProfile(profile, host.homeDir);
        return { ok: true, profile: saved.profile, warnings: saved.warnings };
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile.name)) {
        throw new Error('Invalid agent name (use letters, digits, . _ -)');
      }
      const directory = scope === 'project' ? projectAgentDefinitionsDir(host.currentWorkDir) : undefined;
      if (inheritModel) {
        const filePath = writeAgentDefinitionMarkdown({
          name: profile.name,
          description: profile.description,
          body: profile.systemPromptAppend,
          extras,
          directory,
          homeDir: host.homeDir,
        });
        return { ok: true, filePath, inheritSessionModel: true };
      }
      const validation = validateAgentProfile(profile, host.homeDir);
      const filePath = writeAgentProfileMarkdown(validation.profile, host.homeDir, { directory, extras });
      return { ok: true, filePath, profile: validation.profile, warnings: validation.warnings };
    },
  );

  const UpsertRouterProfileTool = tool(
    {
      name: 'UpsertRouterProfile',
      description: 'Create or replace a project or personal leader/dispatch router profile.',
      inputSchema: z.strictObject({
        name: z.string(),
        scope: z.enum(['project', 'personal']).optional(),
        description: z.string().optional(),
        routerModel: routerRefSchema,
        routes: z.array(z.strictObject({
          model: z.string(),
          provider: z.enum(['anthropic', 'openai']).optional(),
          baseURL: z.string().optional(),
          apiKey: z.string().optional().describe('$ENV_VAR reference; literal secrets are not persisted'),
          maxTokens: z.number().int().positive().optional(),
          when: z.string(),
          name: z.string().optional(),
          role: z.string().optional(),
          description: z.string().optional(),
          effort: z.enum(['auto', 'low', 'medium', 'high', 'max']).optional(),
          target: targetRefSchema.optional(),
        })).min(1),
        fallback: routerRefSchema.optional(),
        fallbackTarget: targetRefSchema.optional(),
        classificationPrompt: z.string().optional(),
      }),
    },
    async (input) => {
      const profile: RouterProfile = {
        name: input.name.trim(),
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        routerModel: input.routerModel,
        routes: input.routes,
        ...(input.fallback ? { fallback: input.fallback } : {}),
        ...(input.fallbackTarget ? { fallbackTarget: input.fallbackTarget } : {}),
        ...(input.classificationPrompt?.trim()
          ? { classificationPrompt: input.classificationPrompt.trim() }
          : {}),
      };
      const filePath = await saveRouterProfile(profile, {
        projectDir: input.scope === 'personal' ? undefined : host.currentWorkDir,
        homeDir: host.homeDir,
        overwrite: true,
      });
      return { ok: true, filePath, profile: redactRouterProfile(profile) };
    },
  );

  const DeleteRouterProfileTool = tool(
    {
      name: 'DeleteRouterProfile',
      description: 'Delete a router profile by name. Deletes directly when unreferenced; stages a confirmation card when references exist.',
      inputSchema: z.strictObject({
        name: z.string(),
        scope: z.enum(['project', 'personal']).optional(),
      }),
    },
    async (input) => {
      const name = input.name.trim();
      return deleteWithConfirmation(host, 'router', name, async () => {
        const deleted = await deleteRouterProfile(
          name,
          input.scope === 'personal' ? undefined : host.currentWorkDir,
          host.homeDir,
        );
        return { deleted };
      });
    },
  );

  const DeleteAgentProfileTool = tool(
    {
      name: 'DeleteAgentProfile',
      description: 'Delete an agent by name (profile or pure .md definition, either scope — S3 unified store). Deletes directly when unreferenced; stages a confirmation card when references exist.',
      inputSchema: z.strictObject({ name: z.string() }),
    },
    async (input) => {
      const name = input.name.trim();
      return deleteWithConfirmation(host, 'agent', name, () => {
        deleteAgentProfile(name, host.homeDir);
        // Pure .md agents / project scope are not in the legacy store.
        deleteAgentProfileMarkdown(name, host.homeDir, projectAgentDefinitionsDir(host.currentWorkDir));
        return { deleted: true };
      });
    },
  );

  const DeleteBridgeConfigTool = tool(
    {
      name: 'DeleteBridgeConfig',
      description: 'Delete a provider/bridge config by name. Deletes directly when unreferenced; stages a confirmation card when references exist.',
      inputSchema: z.strictObject({ name: z.string() }),
    },
    async (input) => {
      const name = input.name.trim();
      if (!findBridgeConfig(name, host.homeDir)) {
        throw new Error(`Bridge config not found: ${name}`);
      }
      return deleteWithConfirmation(host, 'config', name, () => {
        removeBridgeConfig(name, host.homeDir);
        return { deleted: true };
      });
    },
  );

  const DeleteTeamTool = tool(
    {
      name: 'DeleteTeam',
      description: 'Delete a Team definition by name. Built-in Teams cannot be deleted. Deletes directly when unreferenced; stages a confirmation card when references exist.',
      inputSchema: z.strictObject({ name: z.string() }),
    },
    async (input) => {
      const name = input.name.trim();
      if (getBuiltInTeamDefinition(name)) {
        throw new Error(`"${name}" is a built-in Team and cannot be deleted. Clone it instead.`);
      }
      const loaded = loadTeamDefinition(name, host.currentWorkDir, host.homeDir);
      if (!loaded) throw new Error(`Team not found: ${name}`);
      return deleteWithConfirmation(host, 'team', name, async () => {
        const deleted = await deleteTeamDefinition(name, host.currentWorkDir, host.homeDir);
        if (!deleted) throw new Error(`Team not found: ${name}`);
        return { deleted: true };
      });
    },
  );

  const ActivateAgentTool = tool(
    {
      name: 'ActivateAgent',
      description: 'Activate a saved Agent/profile, provider config, Router, Graph, or Workflow in the current chat.',
      inputSchema: z.strictObject({
        name: z.string(),
        kind: z.enum(['profile', 'config', 'router', 'team']).optional()
          .describe('Defaults to "profile" (saved agent / selectable preset)'),
      }),
    },
    async (input) => {
      const kind = input.kind ?? 'profile';
      if (kind === 'profile') {
        if (!host.activateAgent) throw new Error('ActivateAgent is unavailable in this host.');
        return host.activateAgent(input.name.trim());
      }
      if (!host.activateTarget) {
        throw new Error('ActivateAgent router/team activation is unavailable in this host.');
      }
      return host.activateTarget(kind, input.name.trim());
    },
  );

  const UpdateTeamPreferencesTool = tool(
    {
      name: 'UpdateTeamPreferences',
      description: 'Update Agents-page team behavior: automatic invocation, default attached Graph/Workflow, and confirmation before runs.',
      inputSchema: z.strictObject({
        autoInvoke: z.boolean().optional(),
        defaultAttached: z.string().nullable().optional(),
        confirmBeforeRun: z.boolean().optional(),
      }),
    },
    async input => {
      if (!host.writeTeamPreferences) throw new Error('UpdateTeamPreferences is unavailable in this host.');
      const current = host.readTeamPreferences?.() ?? {
        autoInvoke: false,
        defaultAttached: null,
        confirmBeforeRun: true,
      };
      const next: TeamPreferences = {
        autoInvoke: input.autoInvoke ?? current.autoInvoke,
        defaultAttached: input.defaultAttached === undefined ? current.defaultAttached : input.defaultAttached,
        confirmBeforeRun: input.confirmBeforeRun ?? current.confirmBeforeRun,
      };
      if (next.defaultAttached && !loadTeamDefinition(next.defaultAttached, host.currentWorkDir, host.homeDir)) {
        throw new Error(`Graph/Workflow not found: ${next.defaultAttached}`);
      }
      await host.writeTeamPreferences(next);
      return { ok: true, preferences: next };
    },
  );

  const UpdateManagedPlugin = tool(
    {
      name: 'UpdateManagedPlugin',
      description: 'Enable/disable or patch a managed plugin. Secrets are write-only.',
      inputSchema: z.strictObject({
        pluginId: z.string(),
        enabled: z.boolean().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        clearSecret: z.boolean().optional(),
      }),
    },
    async (input) => {
      if (!host.readSettingsRaw || !host.writeSettingsRaw) {
        throw new Error('UpdateManagedPlugin is unavailable in this host.');
      }
      if (!(MANAGED_PLUGIN_IDS as readonly string[]).includes(input.pluginId)) {
        throw new Error(`Unknown managed plugin: ${input.pluginId}`);
      }
      const pluginId = input.pluginId as ManagedPluginId;
      const raw = await host.readSettingsRaw();
      patchManagedPluginSettings(raw, pluginId, {
        enabled: input.enabled,
        config: input.config,
        clearSecret: input.clearSecret,
      });
      await host.writeSettingsRaw(raw);
      const catalog = readManagedPluginCatalog(raw);
      const entry = catalog.plugins.find(plugin => plugin.id === pluginId);
      return {
        ok: true,
        pluginId,
        enabled: entry?.enabled === true,
        config: entry?.config ?? {},
      };
    },
  );

  const UpsertScheduledTask = tool(
    {
      name: 'UpsertScheduledTask',
      description: 'Create or update an automation task for a project workspace.',
      inputSchema: z.strictObject({
        projectPath: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        kind: z.enum(['workflow', 'prompt', 'manager']),
        cron: z.string().optional(),
        enabled: z.boolean().optional(),
        workflowName: z.string().optional(),
        workflowSource: z.enum(['agent', 'script']).optional(),
        input: z.string().optional(),
        prompt: z.string().optional(),
        trigger: z.enum(['schedule', 'webhook']).optional(),
      }),
    },
    async (input) => {
      const projectPath = input.projectPath
        ? await assertKnownProject(host, input.projectPath)
        : path.resolve(host.currentWorkDir);
      const body: ScheduledAutomationTaskInput = {
        id: input.id,
        name: input.name,
        kind: input.kind,
        cron: input.cron,
        enabled: input.enabled,
        workflowName: input.workflowName,
        workflowSource: input.workflowSource,
        input: input.input,
        prompt: input.prompt,
        trigger: input.trigger,
      };
      const task = await upsertScheduledAutomationTask(projectPath, body);
      return { ok: true, projectPath, task: { id: task.id, name: task.name, kind: task.kind, cron: task.cron, enabled: task.enabled } };
    },
  );

  const ToggleScheduledTask = tool(
    {
      name: 'ToggleScheduledTask',
      description: 'Enable or pause an automation task.',
      inputSchema: z.strictObject({
        projectPath: z.string().optional(),
        id: z.string(),
        enabled: z.boolean(),
      }),
    },
    async (input) => {
      const projectPath = input.projectPath
        ? await assertKnownProject(host, input.projectPath)
        : path.resolve(host.currentWorkDir);
      const task = await setScheduledAutomationEnabled(projectPath, input.id, input.enabled);
      if (!task) throw new Error(`Scheduled task not found: ${input.id}`);
      return { ok: true, projectPath, task: { id: task.id, name: task.name, enabled: task.enabled } };
    },
  );

  const AddMcpServerTool = tool(
    {
      name: 'AddMcpServer',
      description: 'Add an MCP server to ~/.hadamard/mcp.json.',
      inputSchema: z.strictObject({
        name: z.string(),
        type: z.enum(['stdio', 'http']),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        url: z.string().optional(),
      }),
    },
    async (input) => {
      if (input.type === 'stdio') {
        if (!input.command?.trim()) throw new Error('stdio MCP servers require command');
        addMcpServer({
          name: input.name.trim(),
          command: input.command.trim(),
          args: input.args,
        }, host.homeDir);
      } else {
        if (!input.url?.trim()) throw new Error('http MCP servers require url');
        addMcpServer({
          name: input.name.trim(),
          url: input.url.trim(),
        }, host.homeDir);
      }
      return { ok: true, servers: readMcpServerConfig(host.homeDir).servers };
    },
  );

  const RemoveMcpServerTool = tool(
    {
      name: 'RemoveMcpServer',
      description: 'Remove an MCP server by name.',
      inputSchema: z.strictObject({ name: z.string() }),
    },
    async (input) => {
      removeMcpServer(input.name.trim(), host.homeDir);
      return { ok: true, servers: readMcpServerConfig(host.homeDir).servers };
    },
  );

  const ListReferencesTool = tool(
    {
      name: 'ListReferences',
      description: 'List every reference to a definition (kind: config|agent|team|router) — impact analysis before rename/delete.',
      inputSchema: z.strictObject({
        kind: z.enum(['config', 'agent', 'team', 'router']),
        name: z.string(),
      }),
      isReadOnly: () => true,
    },
    async (input) => {
      const { index } = await getReferenceSnapshot(host);
      const references = findUsages(index, input.kind, input.name.trim());
      return { kind: input.kind, name: input.name.trim(), count: references.length, references };
    },
  );

  const ListBrokenReferencesTool = tool(
    {
      name: 'ListBrokenReferences',
      description: 'List references whose target no longer exists (proactive health check).',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => {
      const { index, known } = await getReferenceSnapshot(host);
      const broken = findBrokenRefs(index, known);
      return { count: broken.length, broken };
    },
  );

  const makeRenameTool = (
    kind: ReferenceDefinitionKind,
    toolName: string,
    label: string,
  ): AgentToolDefinition => tool(
    {
      name: toolName,
      description: `Rename a ${label} and atomically rewrite every referencing definition (single transaction with rollback).`,
      inputSchema: z.strictObject({
        oldName: z.string(),
        newName: z.string(),
      }),
    },
    async (input) => {
      const report = await renameDefinitionAndReferences(
        kind,
        input.oldName,
        input.newName,
        await resolveReferenceOperationContext(host),
      );
      return {
        ok: true,
        kind,
        oldName: input.oldName.trim(),
        newName: input.newName.trim(),
        rewritten: report.rewritten,
      };
    },
  );

  const RenameBridgeConfigTool = makeRenameTool('config', 'RenameBridgeConfig', 'provider/bridge config');
  const RenameAgentProfileTool = makeRenameTool('agent', 'RenameAgentProfile', 'agent profile');
  const RenameRouterProfileTool = makeRenameTool('router', 'RenameRouterProfile', 'router profile');
  const RenameTeamTool = makeRenameTool('team', 'RenameTeam', 'Team definition');

  const UpsertTeamTool = tool(
    {
      name: 'UpsertTeam',
      description: 'Stage a Team definition create/update as a proposal card (Preview/Apply). Never writes to disk directly; built-in Teams cannot be overwritten.',
      inputSchema: z.strictObject({
        projectPath: z.string().optional().describe('Defaults to the current workspace'),
        definition: z.record(z.string(), z.unknown())
          .describe('Complete TeamDefinition JSON, preferably graph v3 with stable node ids'),
        baseDigest: z.string().optional().describe('Digest from GetCurrentEditorContext; required automatically when changing the active unsaved Graph/Workflow draft'),
        explanation: z.string().optional(),
      }),
    },
    async (input) => {
      if (!host.teamProposals || !host.assistantSessionId) {
        throw new Error('UpsertTeam is unavailable in this host (no Team proposal store).');
      }
      const projectPath = input.projectPath?.trim()
        ? await assertKnownProject(host, input.projectPath)
        : path.resolve(host.currentWorkDir);
      const editor = host.getEditorContext ? await host.getEditorContext() : null;
      const definition = input.definition as unknown as TeamDefinition;
      const editorMatches = editor
        && (editor.entityKind === 'graph' || editor.entityKind === 'workflow')
        && editor.entityName === definition.name
        && editor.draft
        && editor.baseDigest;
      if (editorMatches && input.baseDigest && input.baseDigest !== editor.baseDigest) {
        throw new Error('The supplied editor base digest is stale. Read GetCurrentEditorContext and propose the change again.');
      }
      const proposal = host.teamProposals.stage({
        assistantSessionId: host.assistantSessionId,
        projectPath,
        definition,
        explanation: input.explanation ?? '',
        homeDir: host.homeDir,
        ...(editorMatches ? {
          baseDefinition: editor.draft as TeamDefinition,
          editorBaseDigest: editor.baseDigest,
        } : {}),
      });
      host.onTeamProposal?.(proposal);
      return {
        kind: 'team.proposal',
        proposalId: proposal.id,
        projectPath: proposal.projectPath,
        teamName: proposal.teamName,
        explanation: proposal.explanation,
        problems: proposal.problems,
        diff: proposal.diff,
        status: proposal.status,
      };
    },
  );

  const UpsertWorkflowTool = tool(
    {
      name: 'UpsertWorkflow',
      description: 'Stage a script workflow create/update as a confirmation card. Apply writes <name>.js into the project or personal workflows directory.',
      inputSchema: z.strictObject({
        name: z.string(),
        script: z.string().describe('Complete workflow script (export const meta = {...} required)'),
        scope: z.enum(['project', 'personal']).optional().describe('Defaults to project'),
        description: z.string().optional(),
        explanation: z.string().optional(),
      }),
    },
    async (input) => {
      if (!host.proposals || !host.assistantSessionId) {
        throw new Error('UpsertWorkflow is unavailable in this host (no proposal store).');
      }
      const proposal = host.proposals.stageWorkflowUpsert({
        assistantSessionId: host.assistantSessionId,
        name: input.name,
        script: input.script,
        scope: input.scope ?? 'project',
        projectPath: path.resolve(host.currentWorkDir),
        description: input.description,
        explanation: input.explanation,
      });
      host.onProposal?.(proposal);
      return {
        ok: true,
        staged: true,
        proposalId: proposal.id,
        name: proposal.workflow?.name,
        problems: proposal.workflow?.problems ?? [],
        message: 'Staged a confirmation card. The workflow file is written only after the user applies it.',
      };
    },
  );

  const DeleteWorkflowTool = tool(
    {
      name: 'DeleteWorkflow',
      description: 'Delete a script workflow by name. Refuses while automation tasks still reference it.',
      inputSchema: z.strictObject({ name: z.string() }),
    },
    async (input) => {
      const name = input.name.trim();
      if (!listWorkflows(host.currentWorkDir, host.homeDir).some(workflow => workflow.name === name)) {
        throw new Error(`Workflow not found: ${name}`);
      }
      const tasks = await listScheduledAutomationTasks(host.currentWorkDir)
        .catch(() => [] as ScheduledAutomationTask[]);
      const referencing = tasks.filter(task =>
        task.kind === 'workflow' && task.workflowSource !== 'agent' && task.workflowName === name);
      if (referencing.length) {
        throw new Error(
          `Refusing to delete workflow "${name}": referenced by automation task(s): `
          + `${referencing.map(task => task.name || task.id).join(', ')}. Delete or re-point those tasks first.`,
        );
      }
      const deleted = await deleteWorkflow(name, host.currentWorkDir, host.homeDir);
      return { ok: true, deleted };
    },
  );

  return [
    ListProjects,
    GetProjectOverview,
    GetProjectDocument,
    ListProjectIssues,
    GetAppState,
    GetCurrentEditorContext,
    ListProductCapabilities,
    SearchProductCapabilities,
    ReadProductCapability,
    ListBridgeConfigs,
    ListAgentProfiles,
    ListRouterProfilesTool,
    ListPlugins,
    ListScheduledTasks,
    ListMcpServers,
    OpenProject,
    UpdateProjectNote,
    UpdateProjectStatus,
    UpdateGuiPreferences,
    UpdateRuntimeEnv,
    UpsertBridgeConfigTool,
    UpsertAgentProfileTool,
    DeleteAgentProfileTool,
    UpsertRouterProfileTool,
    DeleteRouterProfileTool,
    ActivateAgentTool,
    UpdateTeamPreferencesTool,
    UpdateManagedPlugin,
    UpsertScheduledTask,
    ToggleScheduledTask,
    AddMcpServerTool,
    RemoveMcpServerTool,
    ListReferencesTool,
    ListBrokenReferencesTool,
    RenameBridgeConfigTool,
    RenameAgentProfileTool,
    RenameRouterProfileTool,
    RenameTeamTool,
    DeleteBridgeConfigTool,
    DeleteTeamTool,
    UpsertTeamTool,
    UpsertWorkflowTool,
    DeleteWorkflowTool,
  ];
}
