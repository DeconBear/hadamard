/**
 * Model Router — the Leader/Dispatch layer for `/model` (not a team).
 *
 * A profile names a leader model (`routerModel`) and a roster of specialist
 * routes (each a model target + a `when` trigger and optional `role`/
 * `description`). On each user input, `classifyRoute()` asks the leader which
 * specialist should execute this turn, and `resolveRoutedRun()` returns the
 * `{ model, modelApi }` to run it on — which may be on a different provider. The
 * turn then runs exactly like a normal Hadamard agent turn, and that executor
 * may itself convene a team. Routing re-evaluates on the next user input.
 *
 * Profiles load from `.hadamard/routers/<name>.json` (project) and
 * `~/.hadamard/routers/<name>.json` (personal). `apiKey` values starting with
 * `$` are resolved from environment variables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { resolveHadamardHome } from '../config/hadamardHome.js';

import type {
  AgentTargetRef,
  ModelApi,
  RouterDecision,
  RouterModelRef,
  RouterProfile,
  RouterRoute,
} from '../types.js';
import { resolveRuntimeConfig } from '../config/resolveRuntimeConfig.js';
import { createHadamardModelApi } from '../runtime/hadamardModelApi.js';
import { createOpenaiModelApi } from '../provider/openai-model-api.js';
import { listAgentProfiles } from '../config/agentProfiles.js';
import { resolveTargetRef } from '../manager/resolveTargetRef.js';

function resolveApiKey(apiKey?: string): string | undefined {
  if (!apiKey) return undefined;
  return apiKey.startsWith('$') ? process.env[apiKey.slice(1)] : apiKey;
}

export interface RoutedModel {
  model: string;
  modelApi: ModelApi;
  maxTokens: number;
}

/** Build a model client for a route/target (resolves provider, baseURL, key). */
export async function buildRouteModelApi(ref: RouterModelRef): Promise<RoutedModel> {
  const resolved = await resolveRuntimeConfig({
    model: ref.model,
    provider: ref.provider,
    baseURL: ref.baseURL,
    authToken: resolveApiKey(ref.apiKey),
    maxTokens: ref.maxTokens ?? 32000,
    workDir: process.cwd(),
  });
  const api = resolved.provider === 'openai'
    ? createOpenaiModelApi(resolved)
    : createHadamardModelApi(resolved);
  return { model: resolved.model, modelApi: api, maxTokens: ref.maxTokens ?? 32000 };
}

/**
 * Pure route selection: map the classifier's raw output to a route. Accepts a
 * leading route number (1-based; "0" = none) or a route name/model substring.
 * Returns null when nothing matches so the caller can fall back.
 */
export function parseRouteSelection(raw: string, routes: RouterRoute[]): RouterRoute | null {
  const trimmed = raw.trim();
  const num = trimmed.match(/\d+/);
  if (num) {
    const n = parseInt(num[0], 10);
    if (n === 0) return null;
    if (n >= 1 && n <= routes.length) return routes[n - 1]!;
  }
  const lower = trimmed.toLowerCase();
  for (const route of routes) {
    const keys = [route.role, route.name, route.model].filter((k): k is string => Boolean(k)).map((k) => k.toLowerCase());
    if (keys.some((k) => k.length > 0 && lower.includes(k))) return route;
  }
  return null;
}

function buildClassificationPrompt(profile: RouterProfile, userInput: string): string {
  const routeList = profile.routes
    .map((r, i) => {
      const label = r.role ?? r.name ?? r.model;
      const detail = [r.when, r.description].filter(Boolean).join(' — ');
      return `${i + 1}. ${label} — ${detail}`;
    })
    .join('\n');
  const tail = `Return ONLY the specialist number (1-${profile.routes.length}); return 0 if none clearly fit.`;
  if (profile.classificationPrompt) {
    return `${profile.classificationPrompt}\n\nSpecialists:\n${routeList}\n\nUser request:\n${userInput}\n\n${tail}`;
  }
  return [
    'You are the team leader. Dispatch the user request to the single best specialist to execute this turn.',
    '',
    'Specialists:',
    routeList,
    '',
    'User request:',
    userInput,
    '',
    tail,
  ].join('\n');
}

/**
 * Classify a user input against a profile and return the chosen target.
 * `deps.classify` can be injected for tests (returns the raw classifier text).
 */
export async function classifyRoute(
  profile: RouterProfile,
  userInput: string,
  signal?: AbortSignal,
  deps?: { classify?: (prompt: string, signal?: AbortSignal) => Promise<string> },
): Promise<RouterDecision> {
  const prompt = buildClassificationPrompt(profile, userInput);

  let raw = '';
  try {
    if (deps?.classify) {
      raw = await deps.classify(prompt, signal);
    } else {
      const classifier = await buildRouteModelApi(profile.routerModel);
      const response = await classifier.modelApi.createMessage({
        model: classifier.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 16,
        signal,
      });
      raw = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text?: string }).text ?? '')
        .join('')
        .trim();
    }
  } catch {
    raw = ''; // classifier failed → fall back below
  }

  const matched = parseRouteSelection(raw, profile.routes);
  const target: RouterModelRef = matched ?? profile.fallback ?? profile.routes[0]!;
  const label = matched
    ? (matched.role ?? matched.name ?? matched.model)
    : profile.fallback
      ? `fallback:${profile.fallback.model}`
      : (profile.routes[0]?.role ?? profile.routes[0]?.name ?? profile.routes[0]?.model ?? 'default');
  return { target, label, classification: raw, matched: matched !== null };
}

/**
 * Classify and build the model client for the turn. Spread the result into run
 * options: `session.stream(text, { model, modelApi, ... })`.
 */
export async function resolveRoutedRun(
  profile: RouterProfile,
  userInput: string,
  signal?: AbortSignal,
  options: { homeDir?: string; projectDir?: string } = {},
): Promise<{ model: string; modelApi: ModelApi; label: string; decision: RouterDecision }> {
  const decision = await classifyRoute(profile, userInput, signal);
  // Unified reference model: prefer the typed target when the chosen route
  // (or the fallback) carries one; legacy by-value fields fill any gaps.
  const targetRef: AgentTargetRef | undefined = decision.matched || !profile.fallback
    ? (decision.target as RouterRoute).target
    : profile.fallbackTarget;
  if (targetRef) {
    if (targetRef.kind === 'team') {
      throw new Error(`Router target "${targetRef.name}" is a team; team targets are not supported as router execution targets.`);
    }
    const resolved = resolveTargetRef(targetRef, { homeDir: options.homeDir, projectDir: options.projectDir });
    const legacy = decision.target;
    const routed = await buildRouteModelApi({
      model: resolved.model ?? legacy.model,
      provider: resolved.provider ?? legacy.provider,
      baseURL: resolved.baseURL ?? legacy.baseURL,
      apiKey: resolved.apiKey ?? legacy.apiKey,
      maxTokens: legacy.maxTokens,
    });
    return { model: routed.model, modelApi: routed.modelApi, label: decision.label, decision };
  }
  const routed = await buildRouteModelApi(decision.target);
  return { model: routed.model, modelApi: routed.modelApi, label: decision.label, decision };
}

// ── Persistence (.hadamard/routers + ~/.hadamard/routers) ──────────────

export interface LoadedRouterProfile {
  name: string;
  profile: RouterProfile;
  source: 'project' | 'personal';
  filePath: string;
}

function resolveRouterDirs(projectDir?: string, homeDir?: string): string[] {
  const home = resolveHadamardHome(homeDir);
  const dirs: string[] = [];
  if (projectDir) dirs.push(path.join(projectDir, '.hadamard', 'routers'));
  dirs.push(path.join(home, 'routers'));
  return dirs;
}

function resolveRefEnv<T extends RouterModelRef>(ref: T): T {
  return { ...ref, apiKey: resolveApiKey(ref.apiKey) };
}

function resolveProfileEnv(profile: RouterProfile): RouterProfile {
  return {
    ...profile,
    routerModel: resolveRefEnv(profile.routerModel),
    routes: profile.routes.map(resolveRefEnv),
    fallback: profile.fallback ? resolveRefEnv(profile.fallback) : undefined,
  };
}

/**
 * Lazily migrate a persisted route to the unified `AgentTargetRef` form
 * (in-memory only; the next save writes the new format). Rules:
 *  - an explicit `target` always wins (already new format);
 *  - role/name matching a saved agent profile name -> `{ kind: 'agent', name }`;
 *  - otherwise a model target: `config: ''` marks a raw legacy model ref
 *    whose originating bridge config is unknown; runtime resolution then
 *    falls back to the legacy provider/baseURL/apiKey fields on the route.
 */
export function migrateRouterRouteTarget(route: RouterRoute, agentNames: ReadonlySet<string>): RouterRoute {
  if (route.target) return route;
  const agentName = route.role && agentNames.has(route.role) ? route.role
    : route.name && agentNames.has(route.name) ? route.name
    : null;
  const target: AgentTargetRef = agentName
    ? { kind: 'agent', name: agentName }
    : { kind: 'model', config: '', model: route.model };
  return { ...route, target };
}

/**
 * Migrate `routes[].target` / `fallbackTarget` on a loaded profile. When
 * `agentNames` is omitted the saved agent profiles are read from the
 * default home; loaders pass explicit names so tests stay hermetic.
 */
export function migrateRouterProfileTargets(
  profile: RouterProfile,
  agentNames?: readonly string[],
): RouterProfile {
  const names = new Set(agentNames ?? listAgentProfiles().map((p) => p.name));
  return {
    ...profile,
    routes: profile.routes.map((route) => migrateRouterRouteTarget(route, names)),
    fallbackTarget: profile.fallbackTarget
      ?? (profile.fallback ? { kind: 'model', config: '', model: profile.fallback.model } : undefined),
  };
}

/** Agent profile names visible to router migration for a given home dir. */
function routerMigrationAgentNames(homeDir?: string): string[] {
  return listAgentProfiles(homeDir).map((p) => p.name);
}

export function loadRouterProfile(name: string, projectDir?: string, homeDir?: string): LoadedRouterProfile | null {
  const dirs = resolveRouterDirs(projectDir, homeDir);
  for (let i = 0; i < dirs.length; i++) {
    const filePath = path.join(dirs[i]!, `${name}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RouterProfile;
        const profile = migrateRouterProfileTargets(resolveProfileEnv(raw), routerMigrationAgentNames(homeDir));
        return { name, profile, source: i === 0 && projectDir ? 'project' : 'personal', filePath };
      } catch (err: any) {
        throw new Error(`Failed to load router profile "${name}" from ${filePath}: ${err.message}`);
      }
    }
  }
  return null;
}

export function listRouterProfiles(projectDir?: string, homeDir?: string): LoadedRouterProfile[] {
  const dirs = resolveRouterDirs(projectDir, homeDir);
  const seen = new Set<string>();
  const out: LoadedRouterProfile[] = [];
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const name = entry.name.slice(0, -5);
        if (seen.has(name)) continue;
        seen.add(name);
        const filePath = path.join(dir, entry.name);
        try {
          const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RouterProfile;
          const profile = migrateRouterProfileTargets(resolveProfileEnv(raw), routerMigrationAgentNames(homeDir));
          out.push({ name, profile, source: i === 0 && projectDir ? 'project' : 'personal', filePath });
        } catch { /* skip invalid */ }
      }
    } catch { /* skip inaccessible */ }
  }
  return out;
}

export async function saveRouterProfile(
  profile: RouterProfile,
  options: { projectDir?: string; homeDir?: string; overwrite?: boolean } = {},
): Promise<string> {
  const targetDir = resolveRouterDirs(options.projectDir, options.homeDir)[0]!;
  await mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, `${profile.name}.json`);
  if (fs.existsSync(filePath) && !options.overwrite) {
    throw new Error(`Router profile "${profile.name}" already exists at ${filePath}. Use overwrite: true to replace.`);
  }
  // Never persist literal secrets — keep only $ENV_VAR references.
  const stripKey = <T extends RouterModelRef>(ref: T): T => ({
    ...ref,
    apiKey: ref.apiKey?.startsWith?.('$') ? ref.apiKey : undefined,
  });
  // Always write the typed `target`/`fallbackTarget` refs; legacy by-value
  // fields are kept alongside them for back-compat.
  const migrated = migrateRouterProfileTargets(profile, routerMigrationAgentNames(options.homeDir));
  const sanitized: RouterProfile = {
    ...migrated,
    routerModel: stripKey(migrated.routerModel),
    routes: migrated.routes.map(stripKey),
    fallback: migrated.fallback ? stripKey(migrated.fallback) : undefined,
  };
  fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2), 'utf-8');
  return filePath;
}

export async function deleteRouterProfile(name: string, projectDir?: string, homeDir?: string): Promise<boolean> {
  for (const dir of resolveRouterDirs(projectDir, homeDir)) {
    const filePath = path.join(dir, `${name}.json`);
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true; }
  }
  return false;
}
