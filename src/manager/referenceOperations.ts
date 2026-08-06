/**
 * Reference operations (Agents panel redesign, P1): transactional rename and
 * delete-with-fallback over the unified reference model.
 *
 * `renameDefinitionAndReferences` renames a config / agent / router / team and
 * atomically rewrites every referencing field known to the reference index
 * (profile.bridgeConfig, manager.json, router route/fallback targets incl.
 * legacy role-matched routes, team teamRef/targetRef nodes, automation tasks,
 * teamPreferences.defaultAttached). Referencers are written first, the
 * definition itself last; any failure restores the original file bytes.
 *
 * `applyDeleteFallback` rewrites referencers ahead of a force-delete:
 * config → re-point to another config; agent → re-point to another agent or
 * degrade to a raw model ref keeping the model name; team → remove referencing
 * graph nodes or leave them broken (the P0 ⚠ badge then marks them).
 *
 * Router/team JSON files are rewritten at the raw-file level so `$ENV_VAR`
 * apiKey references survive verbatim (the loaded views resolve them).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentTargetRef, RouterProfile, TeamDefinition, WorkflowNode } from '../types.js';
import {
  getBridgeConfigsPath,
  readBridgeConfigs,
  writeBridgeConfigs,
} from '../parity/bridgeConfigs.js';
import {
  getAgentProfilesPath,
  readAgentProfiles,
  writeAgentProfiles,
} from '../config/agentProfiles.js';
import { resolveHadamardHome } from '../config/hadamardHome.js';
import { BUILT_IN_TEAM_DEFINITIONS } from '../team/teamDefinitions.js';
import { readManagerConfig, writeManagerConfig, managerConfigPath } from './projectManager.js';
import {
  listScheduledAutomationTasks,
  scheduledAutomationFilePath,
  upsertScheduledAutomationTask,
} from '../scheduling/taskPersistence.js';
import type { TeamPreferences } from '../team/teamPreferences.js';

export type ReferenceDefinitionKind = 'config' | 'agent' | 'router' | 'team';

/** Force-delete fallback strategy chosen in the impact dialog. */
export type DeleteFallbackStrategy =
  /** Leave references pointing at the deleted name (they show as broken). */
  | { type: 'leave' }
  /** config → another config; agent → another agent. */
  | { type: 'repoint'; target: string }
  /** agent → degrade references to a raw model ref keeping the model name. */
  | { type: 'degrade-model' }
  /** team → remove referencing graph nodes (and their edges) from other teams. */
  | { type: 'remove-nodes' };

export interface ReferenceOperationContext {
  /** Project directory (workDir) for project-scoped routers/teams/automations. */
  projectDir?: string;
  homeDir?: string;
  /** Project path whose manager.json participates; defaults to projectDir. */
  managerProjectPath?: string;
  /** Accessor for teamPreferences.defaultAttached rewrites (settings.json). */
  teamPreferences?: {
    read(): TeamPreferences;
    write(prefs: TeamPreferences): void | Promise<void>;
  };
}

export interface ReferenceOperationReport {
  /** Human-readable descriptions of every rewritten reference. */
  rewritten: string[];
}

const VALID_DEFINITION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Raw-file reference rewrites (pure, exported for tests) ──────────

/** Rewrite one typed target ref; returns the (possibly new) ref and whether it changed. */
function rewriteTargetRef(
  ref: AgentTargetRef | undefined,
  kind: ReferenceDefinitionKind,
  oldName: string,
  newName: string,
): { ref: AgentTargetRef | undefined; changed: boolean } {
  if (!ref) return { ref, changed: false };
  if (kind === 'agent' && ref.kind === 'agent' && ref.name === oldName) {
    return { ref: { ...ref, name: newName }, changed: true };
  }
  if (kind === 'team' && ref.kind === 'team' && ref.name === oldName) {
    return { ref: { ...ref, name: newName }, changed: true };
  }
  if (kind === 'config' && ref.kind === 'model' && ref.config === oldName) {
    return { ref: { ...ref, config: newName }, changed: true };
  }
  return { ref, changed: false };
}

/**
 * Rewrite references inside a raw router profile JSON. `agentNames` are the
 * pre-rename saved profile names, used to recognize legacy role/name-matched
 * routes (their implicit agent reference follows the rename).
 * Returns true when anything changed.
 */
export function rewriteRouterFileRefs(
  raw: RouterProfile,
  kind: ReferenceDefinitionKind,
  oldName: string,
  newName: string,
  agentNames: ReadonlySet<string>,
): boolean {
  let changed = false;
  raw.routes = (raw.routes ?? []).map((route) => {
    const next = { ...route };
    const rewritten = rewriteTargetRef(next.target, kind, oldName, newName);
    if (rewritten.changed) {
      next.target = rewritten.ref;
      changed = true;
    }
    if (!route.target && kind === 'agent' && agentNames.has(oldName)) {
      // Legacy route without a typed target: a role/name equal to the renamed
      // agent is an implicit reference (lazy migration would infer it).
      if (next.role === oldName) {
        next.role = newName;
        changed = true;
      } else if (next.name === oldName) {
        next.name = newName;
        changed = true;
      }
    }
    return next;
  });
  const fallback = rewriteTargetRef(raw.fallbackTarget, kind, oldName, newName);
  if (fallback.changed) {
    raw.fallbackTarget = fallback.ref;
    changed = true;
  }
  return changed;
}

function rewriteWorkflowTreeRefs(
  node: WorkflowNode | undefined,
  kind: ReferenceDefinitionKind,
  oldName: string,
  newName: string,
): boolean {
  if (!node) return false;
  let changed = false;
  const rewritten = rewriteTargetRef(node.targetRef, kind, oldName, newName);
  if (rewritten.changed) {
    node.targetRef = rewritten.ref;
    changed = true;
  }
  for (const child of node.children ?? []) {
    if (rewriteWorkflowTreeRefs(child, kind, oldName, newName)) changed = true;
  }
  return changed;
}

/** Rewrite references inside a raw team definition JSON. Returns true when changed. */
export function rewriteTeamFileRefs(
  raw: TeamDefinition,
  kind: ReferenceDefinitionKind,
  oldName: string,
  newName: string,
): boolean {
  let changed = false;
  raw.nodes = (raw.nodes ?? []).map((node) => {
    const next = { ...node };
    const rewritten = rewriteTargetRef(next.targetRef, kind, oldName, newName);
    if (rewritten.changed) {
      next.targetRef = rewritten.ref;
      changed = true;
    }
    if (kind === 'team' && next.type === 'team' && next.teamRef === oldName) {
      next.teamRef = newName;
      changed = true;
    }
    return next;
  });
  if (rewriteWorkflowTreeRefs(raw.workflowTree, kind, oldName, newName)) changed = true;
  return changed;
}

/** Degrade agent references in a raw router profile to raw model refs. Returns changed flag. */
export function degradeAgentRefsInRouter(raw: RouterProfile, agentName: string, model: string): boolean {
  let changed = false;
  const degrade = (ref: AgentTargetRef | undefined): AgentTargetRef | undefined => {
    if (ref?.kind === 'agent' && ref.name === agentName) {
      changed = true;
      return { kind: 'model', config: '', model };
    }
    return ref;
  };
  raw.routes = (raw.routes ?? []).map((route) => ({ ...route, target: degrade(route.target) }));
  raw.fallbackTarget = degrade(raw.fallbackTarget);
  return changed;
}

/** Strip agent targetRefs from a raw team definition (legacy model fields remain). */
export function removeAgentRefsInTeam(raw: TeamDefinition, agentName: string): boolean {
  let changed = false;
  const strip = (ref: AgentTargetRef | undefined): AgentTargetRef | undefined => {
    if (ref?.kind === 'agent' && ref.name === agentName) {
      changed = true;
      return undefined;
    }
    return ref;
  };
  raw.nodes = (raw.nodes ?? []).map((node) => ({ ...node, targetRef: strip(node.targetRef) }));
  const visit = (node: WorkflowNode | undefined): void => {
    if (!node) return;
    node.targetRef = strip(node.targetRef);
    for (const child of node.children ?? []) visit(child);
  };
  visit(raw.workflowTree);
  return changed;
}

/**
 * Remove graph nodes that invoke the given team (legacy `teamRef` or typed
 * `targetRef`) plus their incident edges. Workflow-tree nodes keep the node
 * and lose only the targetRef (tree surgery would change semantics).
 */
export function removeTeamRefNodes(raw: TeamDefinition, teamName: string): boolean {
  const references = (node: { type?: string; teamRef?: string; targetRef?: AgentTargetRef }): boolean =>
    (node.type === 'team' && node.teamRef === teamName)
    || (node.targetRef?.kind === 'team' && node.targetRef.name === teamName);
  const removed = new Set(
    (raw.nodes ?? []).filter(references).map((node) => node.id ?? node.name ?? node.role ?? ''),
  );
  if (removed.size === 0 && !raw.workflowTree) return false;
  let changed = removed.size > 0;
  if (removed.size > 0) {
    raw.nodes = (raw.nodes ?? []).filter((node) => !references(node));
    raw.edges = (raw.edges ?? []).filter((edge) => !removed.has(edge.from) && !removed.has(edge.to));
  }
  const visit = (node: WorkflowNode | undefined): void => {
    if (!node) return;
    if (node.targetRef?.kind === 'team' && node.targetRef.name === teamName) {
      node.targetRef = undefined;
      changed = true;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(raw.workflowTree);
  return changed;
}

// ── File-level IO helpers ───────────────────────────────────────────

function routerDirs(projectDir?: string, homeDir?: string): string[] {
  const home = resolveHadamardHome(homeDir);
  const dirs: string[] = [];
  if (projectDir) dirs.push(path.join(projectDir, '.hadamard', 'routers'));
  dirs.push(path.join(home, 'routers'));
  return dirs;
}

function teamDirs(projectDir?: string, homeDir?: string): string[] {
  const home = resolveHadamardHome(homeDir);
  const dirs: string[] = [];
  if (projectDir) dirs.push(path.join(projectDir, '.hadamard', 'teams'));
  dirs.push(path.join(home, 'teams'));
  return dirs;
}

function listJsonFiles(dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) files.push(path.join(dir, entry.name));
      }
    } catch { /* skip inaccessible */ }
  }
  return files;
}

/** Snapshot file bytes, run `fn`, restore every file when it throws. */
async function withFileRollback(paths: Iterable<string>, fn: () => Promise<void>): Promise<void> {
  const snapshots = new Map<string, string | null>();
  for (const filePath of paths) {
    if (snapshots.has(filePath)) continue;
    try {
      snapshots.set(filePath, await readFile(filePath, 'utf-8'));
    } catch {
      snapshots.set(filePath, null);
    }
  }
  try {
    await fn();
  } catch (error) {
    for (const [filePath, content] of snapshots) {
      try {
        if (content === null) await rm(filePath, { force: true });
        else await writeFile(filePath, content, 'utf-8');
      } catch { /* best-effort rollback */ }
    }
    throw error;
  }
}

function rewriteJsonFile(filePath: string, mutate: (raw: unknown) => boolean): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return false;
  }
  if (!mutate(raw)) return false;
  writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  return true;
}

// ── Rename transaction ──────────────────────────────────────────────

/**
 * Rename a config / agent / router / team and rewrite every reference the
 * index knows about. Referencers are written first, the definition itself
 * last; any failure restores the original bytes of every touched file.
 */
export async function renameDefinitionAndReferences(
  kind: ReferenceDefinitionKind,
  oldName: string,
  newName: string,
  ctx: ReferenceOperationContext = {},
): Promise<ReferenceOperationReport> {
  const from = oldName.trim();
  const to = newName.trim();
  if (!from || !to) throw new Error('Rename requires non-empty old and new names.');
  if (from === to) throw new Error('New name is the same as the current name.');
  if (kind !== 'config' && !VALID_DEFINITION_NAME.test(to)) {
    throw new Error('Invalid name (use letters, digits, . _ -)');
  }

  const homeDir = ctx.homeDir;
  const projectDir = ctx.projectDir;
  const rewritten: string[] = [];

  // ── Load phase (any read/validation error aborts before writes) ──
  const bridgeStore = readBridgeConfigs(homeDir);
  const profileStore = readAgentProfiles(homeDir);
  const agentNames = new Set(profileStore.profiles.map((profile) => profile.name));
  const managerPath = ctx.managerProjectPath ?? projectDir;
  const manager = managerPath ? await readManagerConfig(managerPath, resolveHadamardHome(homeDir)) : undefined;
  const tasks = projectDir ? await listScheduledAutomationTasks(projectDir) : [];

  if (kind === 'config' && !bridgeStore.configs.some((config) => config.name === from)) {
    throw new Error(`Bridge config not found: ${from}`);
  }
  if (kind === 'config' && bridgeStore.configs.some((config) => config.name === to)) {
    throw new Error(`A config named "${to}" already exists.`);
  }
  if (kind === 'agent') {
    if (!agentNames.has(from)) throw new Error(`Agent profile not found: ${from}`);
    if (agentNames.has(to)) throw new Error(`An agent profile named "${to}" already exists.`);
  }
  if (kind === 'team' && BUILT_IN_TEAM_DEFINITIONS[from]) {
    throw new Error(`"${from}" is a built-in preset and cannot be renamed. Clone it instead.`);
  }
  if (kind === 'team' && BUILT_IN_TEAM_DEFINITIONS[to]) {
    throw new Error(`"${to}" is a built-in preset name — pick another name.`);
  }

  const routerFiles = listJsonFiles(routerDirs(projectDir, homeDir));
  const teamFiles = listJsonFiles(teamDirs(projectDir, homeDir));
  const definitionFile = (kind === 'router' ? routerFiles : kind === 'team' ? teamFiles : [])
    .find((filePath) => path.basename(filePath, '.json') === from);
  if ((kind === 'router' || kind === 'team') && !definitionFile) {
    throw new Error(`${kind === 'router' ? 'Router profile' : 'Team'} not found: ${from}`);
  }
  const renamedDefinitionFile = definitionFile
    ? path.join(path.dirname(definitionFile), `${to}.json`)
    : undefined;
  if (renamedDefinitionFile && existsSync(renamedDefinitionFile)) {
    throw new Error(`A ${kind} named "${to}" already exists.`);
  }

  // ── Plan phase: preview (read-only) pass collects the affected files ──
  const changedRouterFiles = routerFiles.filter((filePath) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return false;
    }
    if (!isRecord(raw)) return false;
    const clone = JSON.parse(JSON.stringify(raw)) as RouterProfile;
    return rewriteRouterFileRefs(clone, kind, from, to, agentNames);
  });
  const changedTeamFiles = teamFiles.filter((filePath) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return false;
    }
    if (!isRecord(raw)) return false;
    const clone = JSON.parse(JSON.stringify(raw)) as TeamDefinition;
    return rewriteTeamFileRefs(clone, kind, from, to);
  });

  const plannedFiles = new Set<string>();
  const profilesChanged = kind === 'config'
    && profileStore.profiles.some((profile) => profile.bridgeConfig === from);
  const managerChanged = kind === 'config' && manager?.bridgeConfig === from;
  const tasksChanged = kind === 'team'
    && tasks.some((task) => task.kind === 'workflow' && task.workflowSource === 'agent' && task.workflowName === from);
  const prefs = ctx.teamPreferences?.read();
  const prefsChanged = kind === 'team' && prefs?.defaultAttached === from;

  if (kind === 'config') plannedFiles.add(getBridgeConfigsPath(homeDir));
  if (kind === 'agent' || profilesChanged) plannedFiles.add(getAgentProfilesPath(homeDir));
  if (managerChanged && managerPath) plannedFiles.add(managerConfigPath(managerPath, resolveHadamardHome(homeDir)));
  if (tasksChanged && projectDir) plannedFiles.add(scheduledAutomationFilePath(projectDir));
  for (const filePath of changedRouterFiles) plannedFiles.add(filePath);
  for (const filePath of changedTeamFiles) plannedFiles.add(filePath);
  if (definitionFile) plannedFiles.add(definitionFile);
  if (renamedDefinitionFile) plannedFiles.add(renamedDefinitionFile);

  // ── Write phase: referencers first, definition last ──
  await withFileRollback(plannedFiles, async () => {
    for (const filePath of changedRouterFiles) {
      rewriteJsonFile(filePath, (raw) => {
        if (!isRecord(raw)) return false;
        return rewriteRouterFileRefs(raw as unknown as RouterProfile, kind, from, to, agentNames);
      });
      rewritten.push(`router "${path.basename(filePath, '.json')}"`);
    }
    for (const filePath of changedTeamFiles) {
      if (definitionFile && filePath === definitionFile) continue; // renamed below
      rewriteJsonFile(filePath, (raw) => {
        if (!isRecord(raw)) return false;
        return rewriteTeamFileRefs(raw as unknown as TeamDefinition, kind, from, to);
      });
      rewritten.push(`team "${path.basename(filePath, '.json')}"`);
    }
    if (profilesChanged) {
      writeAgentProfiles({
        version: 1,
        profiles: profileStore.profiles.map((profile) =>
          profile.bridgeConfig === from ? { ...profile, bridgeConfig: to } : profile),
      }, homeDir);
      rewritten.push('agent-configs.json (bridgeConfig)');
    }
    if (managerChanged && managerPath && manager) {
      await writeManagerConfig(managerPath, resolveHadamardHome(homeDir), { ...manager, bridgeConfig: to });
      rewritten.push('manager.json (bridgeConfig)');
    }
    if (tasksChanged && projectDir) {
      for (const task of tasks) {
        if (task.kind === 'workflow' && task.workflowSource === 'agent' && task.workflowName === from) {
          await upsertScheduledAutomationTask(projectDir, { ...task, workflowName: to });
          rewritten.push(`automation "${task.name || task.id}" (workflowName)`);
        }
      }
    }
    if (prefsChanged && prefs && ctx.teamPreferences) {
      await ctx.teamPreferences.write({ ...prefs, defaultAttached: to });
      rewritten.push('teamPreferences.defaultAttached');
    }

    // Definition itself.
    if (kind === 'config') {
      writeBridgeConfigs({
        configs: bridgeStore.configs.map((config) =>
          config.name === from ? { ...config, name: to } : config),
      }, homeDir);
    } else if (kind === 'agent') {
      writeAgentProfiles({
        version: 1,
        profiles: profileStore.profiles.map((profile) =>
          profile.name === from ? { ...profile, name: to } : profile),
      }, homeDir);
    } else if (definitionFile && renamedDefinitionFile) {
      const raw = JSON.parse(readFileSync(definitionFile, 'utf-8')) as Record<string, unknown>;
      raw.name = to;
      await writeFile(renamedDefinitionFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
      await rm(definitionFile, { force: true });
    }
  });

  return { rewritten };
}

// ── Force-delete fallbacks ──────────────────────────────────────────

/**
 * Rewrite referencers ahead of a force-delete. The definition deletion itself
 * stays with the calling endpoint. `leave` is a no-op by design — the broken
 * references stay visible via the reference index and ⚠ badges.
 */
export async function applyDeleteFallback(
  kind: ReferenceDefinitionKind,
  name: string,
  strategy: DeleteFallbackStrategy,
  ctx: ReferenceOperationContext = {},
): Promise<ReferenceOperationReport> {
  const rewritten: string[] = [];
  if (strategy.type === 'leave') return { rewritten };

  const homeDir = ctx.homeDir;
  const projectDir = ctx.projectDir;
  const routerFiles = listJsonFiles(routerDirs(projectDir, homeDir));
  const teamFiles = listJsonFiles(teamDirs(projectDir, homeDir));
  const profileStore = readAgentProfiles(homeDir);
  const managerPath = ctx.managerProjectPath ?? projectDir;
  const manager = managerPath ? await readManagerConfig(managerPath, resolveHadamardHome(homeDir)) : undefined;

  if (strategy.type === 'repoint' && !strategy.target.trim()) {
    throw new Error('Re-point strategy requires a target name.');
  }

  // The agent's model is needed to degrade agent references to raw model refs.
  const degradedModel = kind === 'agent'
    ? profileStore.profiles.find((profile) => profile.name === name)?.model ?? ''
    : '';

  const mutateRouter = (raw: RouterProfile): boolean => {
    if (strategy.type === 'repoint') {
      return rewriteRouterFileRefs(raw, kind, name, strategy.target, new Set());
    }
    if (strategy.type === 'degrade-model' && kind === 'agent') {
      return degradeAgentRefsInRouter(raw, name, degradedModel);
    }
    return false;
  };
  const mutateTeam = (raw: TeamDefinition): boolean => {
    if (strategy.type === 'repoint') return rewriteTeamFileRefs(raw, kind, name, strategy.target);
    if (strategy.type === 'degrade-model' && kind === 'agent') return removeAgentRefsInTeam(raw, name);
    if (strategy.type === 'remove-nodes' && kind === 'team') return removeTeamRefNodes(raw, name);
    return false;
  };

  const plannedFiles = new Set<string>();
  if (kind === 'config' && strategy.type === 'repoint') {
    plannedFiles.add(getAgentProfilesPath(homeDir));
    if (manager?.bridgeConfig === name && managerPath) {
      plannedFiles.add(managerConfigPath(managerPath, resolveHadamardHome(homeDir)));
    }
  }
  for (const filePath of [...routerFiles, ...teamFiles]) plannedFiles.add(filePath);

  await withFileRollback(plannedFiles, async () => {
    for (const filePath of routerFiles) {
      if (rewriteJsonFile(filePath, (raw) => isRecord(raw) && mutateRouter(raw as unknown as RouterProfile))) {
        rewritten.push(`router "${path.basename(filePath, '.json')}"`);
      }
    }
    for (const filePath of teamFiles) {
      if (rewriteJsonFile(filePath, (raw) => isRecord(raw) && mutateTeam(raw as unknown as TeamDefinition))) {
        rewritten.push(`team "${path.basename(filePath, '.json')}"`);
      }
    }
    if (kind === 'config' && strategy.type === 'repoint') {
      if (profileStore.profiles.some((profile) => profile.bridgeConfig === name)) {
        writeAgentProfiles({
          version: 1,
          profiles: profileStore.profiles.map((profile) =>
            profile.bridgeConfig === name ? { ...profile, bridgeConfig: strategy.target } : profile),
        }, homeDir);
        rewritten.push('agent-configs.json (bridgeConfig)');
      }
      if (manager?.bridgeConfig === name && managerPath) {
        await writeManagerConfig(managerPath, resolveHadamardHome(homeDir), { ...manager, bridgeConfig: strategy.target });
        rewritten.push('manager.json (bridgeConfig)');
      }
    }
  });

  return { rewritten };
}

// ── Config model re-point ───────────────────────────────────────────

/**
 * Re-point every typed reference to `configName`'s `fromModel` onto
 * `toModel` (same config). Used when a model is removed from a config:
 * agent profiles (bridgeConfig+model), router route/fallback targets, and
 * team node targetRefs.
 */
export async function repointConfigModel(
  configName: string,
  fromModel: string,
  toModel: string,
  ctx: ReferenceOperationContext = {},
): Promise<ReferenceOperationReport> {
  const rewritten: string[] = [];
  const homeDir = ctx.homeDir;
  const projectDir = ctx.projectDir;
  const profileStore = readAgentProfiles(homeDir);

  const rewriteModelRef = (ref: AgentTargetRef | undefined): { ref: AgentTargetRef | undefined; changed: boolean } => {
    if (ref?.kind === 'model' && ref.config === configName && ref.model === fromModel) {
      return { ref: { ...ref, model: toModel }, changed: true };
    }
    return { ref, changed: false };
  };
  const mutateRouter = (raw: RouterProfile): boolean => {
    let changed = false;
    raw.routes = (raw.routes ?? []).map((route) => {
      const next = rewriteModelRef(route.target);
      if (next.changed) changed = true;
      return { ...route, target: next.ref };
    });
    const fallback = rewriteModelRef(raw.fallbackTarget);
    if (fallback.changed) {
      raw.fallbackTarget = fallback.ref;
      changed = true;
    }
    return changed;
  };
  const mutateTeam = (raw: TeamDefinition): boolean => {
    let changed = false;
    raw.nodes = (raw.nodes ?? []).map((node) => {
      const next = rewriteModelRef(node.targetRef);
      if (next.changed) changed = true;
      return { ...node, targetRef: next.ref };
    });
    const visit = (node: WorkflowNode | undefined): void => {
      if (!node) return;
      const next = rewriteModelRef(node.targetRef);
      if (next.changed) {
        node.targetRef = next.ref;
        changed = true;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(raw.workflowTree);
    return changed;
  };

  const files = [
    ...listJsonFiles(routerDirs(projectDir, homeDir)),
    ...listJsonFiles(teamDirs(projectDir, homeDir)),
  ];
  const planned = new Set<string>([getAgentProfilesPath(homeDir), ...files]);

  await withFileRollback(planned, async () => {
    if (profileStore.profiles.some((p) => p.bridgeConfig === configName && p.model === fromModel)) {
      writeAgentProfiles({
        version: 1,
        profiles: profileStore.profiles.map((profile) =>
          profile.bridgeConfig === configName && profile.model === fromModel
            ? { ...profile, model: toModel }
            : profile),
      }, homeDir);
      rewritten.push('agent-configs.json (model)');
    }
    for (const filePath of files) {
      const isRouter = filePath.includes(`${path.sep}routers${path.sep}`);
      if (rewriteJsonFile(filePath, (raw) => isRecord(raw)
        && (isRouter
          ? mutateRouter(raw as unknown as RouterProfile)
          : mutateTeam(raw as unknown as TeamDefinition)))) {
        rewritten.push(path.basename(filePath, '.json'));
      }
    }
  });

  return { rewritten };
}
