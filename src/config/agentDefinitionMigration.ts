/**
 * Unified agent store, S1a (plan/AGENT_SUBAGENT_UNIFICATION_08Aug2026 §1/§3):
 * the json→md auto-migration, the .md serializer shared with the interim
 * profile write-through, and the AgentProfile compatibility derivation from
 * the unified `.md` store.
 *
 * Interim semantics (until S3 moves the write path fully to .md):
 * - Reads merge legacy `agent-configs.json` profiles with profiles derived
 *   from `<home>/.hadamard/agents/*.md`; the .md definition wins on name
 *   conflict ("file wins").
 * - Migration runs on first read (idempotent): every json profile without a
 *   same-named .md gets one (`promptMode: extend`, `subagent: true`, body =
 *   systemPromptAppend); afterwards the json is renamed to
 *   `agent-configs.json.migrated.bak` (never deleted; when a .bak already
 *   exists the migration is skipped and the json keeps its legacy behavior).
 * - Writes go to the json while it exists; once migrated (json absent) they
 *   write through to .md files. Upsert preserves frontmatter keys the profile
 *   model does not carry (allowedAgents, skills, memory, background,
 *   isolation, initialPrompt, …); bulk writes delete only .md files that
 *   parse as profile-backed definitions (bridgeConfig set) whose name is
 *   absent from the store, so pure-subagent .md files are never touched.
 * - Note: P1 transaction rollback (withFileRollback) does not snapshot .md
 *   files yet — full transactional .md handling lands with S3.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  parseAgentDefinitionMarkdown,
  parseMarkdownFrontmatter,
} from '../runtime/hadamardAgentDefinitions.js';
import type {
  HadamardAgentDefinition,
  HadamardPermissionMode,
  HadamardRunEffort,
} from '../types.js';
import { resolveHadamardHome } from './hadamardHome.js';
import type { AgentProfile } from './agentProfiles.js';

const MIGRATED_BACKUP_SUFFIX = '.migrated.bak';

/** Frontmatter keys owned by the AgentProfile model, in canonical write order. */
const PROFILE_FRONTMATTER_ORDER = [
  'name',
  'description',
  'bridgeConfig',
  'model',
  'effort',
  'permissionMode',
  'promptMode',
  'temperature',
  'topP',
  'maxTokens',
  'maxIterations',
  'timeoutMs',
  'workspaceAccess',
  'tools',
  'subagent',
] as const;

export function agentDefinitionsDir(homeDir?: string): string {
  return path.join(resolveHadamardHome(homeDir), 'agents');
}

function agentProfilesJsonPath(homeDir?: string): string {
  return path.join(resolveHadamardHome(homeDir), 'agent-configs.json');
}

function listMarkdownFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map(entry => path.join(dir, entry.name));
}

/** Definition name for a .md file: frontmatter name, else the filename stem. */
function definitionNameForFile(filePath: string): string | undefined {
  try {
    const parsed = parseMarkdownFrontmatter(readFileSync(filePath, 'utf8'));
    return (
      parsed.frontmatter.name?.trim()
      || path.basename(filePath, path.extname(filePath)).trim()
      || undefined
    );
  } catch {
    return undefined;
  }
}

function tryParseDefinition(filePath: string): HadamardAgentDefinition | undefined {
  try {
    return parseAgentDefinitionMarkdown({
      filePath,
      fallbackName: path.basename(filePath, path.extname(filePath)),
      source: 'user',
      content: readFileSync(filePath, 'utf8'),
    });
  } catch {
    return undefined;
  }
}

function findDefinitionFileByName(dir: string, name: string): string | undefined {
  return listMarkdownFiles(dir).find(filePath => definitionNameForFile(filePath) === name);
}

function formatFrontmatterValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.length ? value.map(item => String(item)).join(', ') : undefined;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  const str = String(value).trim();
  return str || undefined;
}

/**
 * Serialize one agent definition to the unified .md format. Profile-owned
 * keys are emitted in canonical order first; any extra keys (subagent-only
 * fields preserved from an existing file) follow.
 */
export function serializeAgentDefinitionMarkdown(
  fields: Record<string, string | number | boolean | string[] | undefined>,
  body: string,
): string {
  const lines = ['---'];
  const seen = new Set<string>();
  for (const key of PROFILE_FRONTMATTER_ORDER) {
    seen.add(key);
    const formatted = formatFrontmatterValue(fields[key]);
    if (formatted !== undefined) lines.push(`${key}: ${formatted}`);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (seen.has(key)) continue;
    const formatted = formatFrontmatterValue(value);
    if (formatted !== undefined) lines.push(`${key}: ${formatted}`);
  }
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

/** Migrated/GUI-created profiles default to promptMode extend + subagent true (§6-1/§6-4). */
function profileToMarkdownFields(
  profile: AgentProfile,
): Record<string, string | number | boolean | string[] | undefined> {
  return {
    name: profile.name,
    description: profile.description,
    bridgeConfig: profile.bridgeConfig,
    model: profile.model,
    effort: profile.effort,
    permissionMode: profile.permissionMode,
    promptMode: 'extend',
    temperature: profile.temperature,
    topP: profile.topP,
    maxTokens: profile.maxTokens,
    maxIterations: profile.maxIterations,
    timeoutMs: profile.timeoutMs,
    workspaceAccess: profile.workspaceAccess,
    tools: profile.allowedTools,
    subagent: true,
  };
}

/**
 * Derive the legacy AgentProfile view from a unified definition. Only
 * definitions carrying both bridgeConfig and model qualify — pure .md
 * subagents never appear in the profile view.
 */
export function agentDefinitionToProfile(definition: HadamardAgentDefinition): AgentProfile | null {
  const bridgeConfig = definition.bridgeConfig?.trim();
  const model = definition.model?.trim();
  if (!bridgeConfig || !model) return null;
  return {
    name: definition.name,
    bridgeConfig,
    model,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.systemPrompt?.trim() ? { systemPromptAppend: definition.systemPrompt.trim() } : {}),
    ...(definition.permissionMode ? { permissionMode: definition.permissionMode } : {}),
    ...(definition.effort ? { effort: definition.effort } : {}),
    ...(typeof definition.maxTokens === 'number' ? { maxTokens: definition.maxTokens } : {}),
    ...(typeof definition.temperature === 'number' ? { temperature: definition.temperature } : {}),
    ...(typeof definition.topP === 'number' ? { topP: definition.topP } : {}),
    ...(definition.allowedTools?.length ? { allowedTools: [...definition.allowedTools] } : {}),
    ...(definition.workspaceAccess ? { workspaceAccess: definition.workspaceAccess } : {}),
    ...(typeof definition.maxToolIterations === 'number'
      ? { maxIterations: definition.maxToolIterations }
      : {}),
    ...(typeof definition.timeoutMs === 'number' ? { timeoutMs: definition.timeoutMs } : {}),
  };
}

/** True once the json store has been migrated (json gone, .bak present). */
export function agentProfileStoreMigrated(homeDir?: string): boolean {
  const jsonPath = agentProfilesJsonPath(homeDir);
  return !existsSync(jsonPath) && existsSync(`${jsonPath}${MIGRATED_BACKUP_SUFFIX}`);
}

/** True when a same-named .md definition already lives in the unified store. */
export function profileStoredAsMarkdown(name: string, homeDir?: string): boolean {
  return findDefinitionFileByName(agentDefinitionsDir(homeDir), name) !== undefined;
}

const VALID_DEFINITION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Subagent/delegation fields the AgentProfile model does not carry (S2
 * editor), plus the pure-definition fields used when writing an
 * inherit-session-model agent (no bridgeConfig → no profile entry).
 * Written verbatim into frontmatter; absent keys clear the
 * profile-owned default (subagent/promptMode) or leave the file untouched.
 */
export interface AgentDefinitionExtraFields {
  promptMode?: 'extend' | 'replace';
  subagent?: boolean;
  allowedAgents?: string[];
  skills?: string[];
  memory?: 'user' | 'project' | 'local';
  background?: boolean;
  isolation?: 'worktree';
  initialPrompt?: string;
  model?: string;
  permissionMode?: HadamardPermissionMode;
  effort?: HadamardRunEffort;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  maxIterations?: number;
  timeoutMs?: number;
  workspaceAccess?: 'workspace' | 'full';
  tools?: string[];
}

function formatExtras(
  extras: AgentDefinitionExtraFields | undefined,
): Record<string, string | number | boolean | string[] | undefined> {
  if (!extras) return {};
  return {
    promptMode: extras.promptMode,
    subagent: extras.subagent,
    allowedAgents: extras.allowedAgents?.length ? extras.allowedAgents : undefined,
    skills: extras.skills?.length ? extras.skills : undefined,
    memory: extras.memory,
    background: extras.background === true ? true : undefined,
    isolation: extras.isolation,
    initialPrompt: extras.initialPrompt?.trim() || undefined,
    model: extras.model?.trim() || undefined,
    permissionMode: extras.permissionMode,
    effort: extras.effort,
    temperature: extras.temperature,
    topP: extras.topP,
    maxTokens: extras.maxTokens,
    maxIterations: extras.maxIterations,
    timeoutMs: extras.timeoutMs,
    workspaceAccess: extras.workspaceAccess,
    tools: extras.tools?.length ? extras.tools : undefined,
  };
}

/**
 * Extras applied on top of a profile write: only the delegation keys.
 * Profile-owned keys (model, effort, permissionMode, sampling, workspace,
 * tools) come from the profile itself and must never be cleared by extras.
 */
function formatDelegationExtras(
  extras: AgentDefinitionExtraFields | undefined,
): Record<string, string | number | boolean | string[] | undefined> {
  const full = formatExtras(extras);
  return {
    promptMode: full.promptMode,
    subagent: full.subagent,
    allowedAgents: full.allowedAgents,
    skills: full.skills,
    memory: full.memory,
    background: full.background,
    isolation: full.isolation,
    initialPrompt: full.initialPrompt,
  };
}

/** Read one definition's raw frontmatter + body by name (project dir wins). */
export function readAgentDefinitionMarkdown(
  name: string,
  homeDir?: string,
  projectDir?: string,
): { frontmatter: Record<string, string>; body: string; filePath: string; source: 'project' | 'user' } | null {
  const dirs: Array<{ dir: string; source: 'project' | 'user' }> = [];
  if (projectDir) dirs.push({ dir: path.join(projectDir, '.hadamard', 'agents'), source: 'project' });
  dirs.push({ dir: agentDefinitionsDir(homeDir), source: 'user' });
  for (const { dir, source } of dirs) {
    const filePath = findDefinitionFileByName(dir, name);
    if (!filePath) continue;
    try {
      const parsed = parseMarkdownFrontmatter(readFileSync(filePath, 'utf8'));
      return { frontmatter: parsed.frontmatter, body: parsed.body, filePath, source };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Write a pure .md agent (no bridgeConfig/model — "inherit session model").
 * Such definitions never appear in the profile compatibility view.
 */
export function writeAgentDefinitionMarkdown(options: {
  name: string;
  description?: string;
  body?: string;
  extras?: AgentDefinitionExtraFields;
  /** Defaults to the personal agents dir. */
  directory?: string;
  homeDir?: string;
}): string {
  const name = options.name.trim();
  if (!VALID_DEFINITION_NAME.test(name)) {
    throw new Error('Invalid agent name (use letters, digits, . _ -)');
  }
  const dir = options.directory ?? agentDefinitionsDir(options.homeDir);
  mkdirSync(dir, { recursive: true });
  const existing = findDefinitionFileByName(dir, name);
  let fields: Record<string, unknown> = {};
  if (existing) {
    const parsed = parseMarkdownFrontmatter(readFileSync(existing, 'utf8'));
    fields = { ...parsed.frontmatter };
  }
  const owned: Record<string, string | number | boolean | string[] | undefined> = {
    name,
    description: options.description?.trim() || undefined,
    ...formatExtras(options.extras),
  };
  for (const [key, value] of Object.entries(owned)) {
    if (formatFrontmatterValue(value) === undefined) delete fields[key];
    else fields[key] = value;
  }
  const body = options.body?.trim() || (existing ? parseMarkdownFrontmatter(readFileSync(existing, 'utf8')).body.trim() : '') || 'No additional instructions.';
  if (!fields.description) fields.description = firstBodyLine(body) ?? name;
  const filePath = existing ?? path.join(dir, `${name}.md`);
  writeFileSync(
    filePath,
    serializeAgentDefinitionMarkdown(
      fields as Record<string, string | number | boolean | string[] | undefined>,
      body,
    ),
    'utf8',
  );
  return filePath;
}

/** Profiles derived from the unified .md store (user scope). */
export function readProfilesFromAgentDefinitions(homeDir?: string): AgentProfile[] {
  const profiles: AgentProfile[] = [];
  for (const filePath of listMarkdownFiles(agentDefinitionsDir(homeDir))) {
    const definition = tryParseDefinition(filePath);
    if (!definition) continue;
    const profile = agentDefinitionToProfile(definition);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

/** Minimal raw-profile extraction for migration (json entries are pre-normalized). */
function normalizeMigrationProfile(raw: unknown): AgentProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const bridgeConfig = typeof record.bridgeConfig === 'string' ? record.bridgeConfig.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!name || !bridgeConfig || !model) return null;
  const numberOr = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const stringOr = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  return {
    name,
    bridgeConfig,
    model,
    description: stringOr(record.description),
    systemPromptAppend: stringOr(record.systemPromptAppend),
    permissionMode: record.permissionMode as AgentProfile['permissionMode'],
    effort: record.effort as AgentProfile['effort'],
    maxTokens: numberOr(record.maxTokens),
    temperature: numberOr(record.temperature),
    topP: numberOr(record.topP),
    allowedTools: Array.isArray(record.allowedTools)
      ? record.allowedTools.filter((tool): tool is string => typeof tool === 'string' && Boolean(tool.trim()))
      : undefined,
    workspaceAccess: record.workspaceAccess === 'full' ? 'full' : record.workspaceAccess === 'workspace' ? 'workspace' : undefined,
    maxIterations: numberOr(record.maxIterations),
    timeoutMs: numberOr(record.timeoutMs),
  };
}

function firstBodyLine(body: string): string | undefined {
  return body
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => Boolean(line) && !line.startsWith('#'))
    ?.slice(0, 240);
}

/**
 * json→md auto-migration (§3). Idempotent; skips entirely when a
 * `.migrated.bak` already exists. Same-named .md definitions win over json
 * profiles (never overwritten). After processing, the json is renamed to
 * `agent-configs.json.migrated.bak` — never deleted, so the change is
 * revertible by renaming it back.
 */
export function migrateAgentProfilesToMarkdown(
  homeDir?: string,
  agentsDir: string = agentDefinitionsDir(homeDir),
): { migrated: string[]; skipped: string[] } {
  const result = { migrated: [] as string[], skipped: [] as string[] };
  const jsonPath = agentProfilesJsonPath(homeDir);
  if (!existsSync(jsonPath)) return result;
  const backupPath = `${jsonPath}${MIGRATED_BACKUP_SUFFIX}`;
  if (existsSync(backupPath)) return result;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    // Unparseable json: leave it for the legacy reader rather than guessing.
    return result;
  }
  const list = Array.isArray((raw as { profiles?: unknown }).profiles)
    ? (raw as { profiles: unknown[] }).profiles
    : [];
  const existingNames = new Set<string>();
  for (const filePath of listMarkdownFiles(agentsDir)) {
    const name = definitionNameForFile(filePath);
    if (name) existingNames.add(name);
  }
  mkdirSync(agentsDir, { recursive: true });
  for (const entry of list) {
    const profile = normalizeMigrationProfile(entry);
    if (!profile) continue;
    if (existingNames.has(profile.name)) {
      result.skipped.push(profile.name);
      continue;
    }
    const body = profile.systemPromptAppend?.trim()
      || profile.description?.trim()
      || 'No additional instructions.';
    const description = profile.description?.trim() || firstBodyLine(body);
    writeFileSync(
      path.join(agentsDir, `${profile.name}.md`),
      serializeAgentDefinitionMarkdown({ ...profileToMarkdownFields(profile), description }, body),
      'utf8',
    );
    result.migrated.push(profile.name);
  }
  renameSync(jsonPath, backupPath);
  return result;
}

/**
 * Write-through upsert (migrated store): update the definition's .md file.
 * Profile-owned frontmatter keys are set or cleared wholesale (upsert
 * semantics); unknown keys (allowedAgents, skills, …) are preserved. The body
 * mirrors systemPromptAppend — the compat derivation maps body →
 * systemPromptAppend, so read-modify-write through the profile API always
 * carries the current body. `options.directory` redirects the write to a
 * project agents dir; `options.extras` (when provided) set-or-clear the
 * subagent/delegation keys the profile model does not carry.
 */
export function writeAgentProfileMarkdown(
  profile: AgentProfile,
  homeDir?: string,
  options: { directory?: string; extras?: AgentDefinitionExtraFields } = {},
): string {
  const dir = options.directory ?? agentDefinitionsDir(homeDir);
  mkdirSync(dir, { recursive: true });
  const existing = findDefinitionFileByName(dir, profile.name);
  let fields: Record<string, unknown> = {};
  const body = profile.systemPromptAppend?.trim() || '';
  if (existing) {
    const parsed = parseMarkdownFrontmatter(readFileSync(existing, 'utf8'));
    fields = { ...parsed.frontmatter };
  }
  for (const [key, value] of Object.entries(profileToMarkdownFields(profile))) {
    if (formatFrontmatterValue(value) === undefined) delete fields[key];
    else fields[key] = value;
  }
  if (options.extras) {
    for (const [key, value] of Object.entries(formatDelegationExtras(options.extras))) {
      if (formatFrontmatterValue(value) === undefined) delete fields[key];
      else fields[key] = value;
    }
  }
  const finalBody = body || 'No additional instructions.';
  if (!fields.description) {
    fields.description = firstBodyLine(finalBody) ?? profile.name;
  }
  const filePath = existing ?? path.join(dir, `${profile.name}.md`);
  writeFileSync(
    filePath,
    serializeAgentDefinitionMarkdown(
      fields as Record<string, string | number | boolean | string[] | undefined>,
      finalBody,
    ),
    'utf8',
  );
  return filePath;
}

/** Write-through delete (migrated store): remove the definition's .md file. */
export function deleteAgentProfileMarkdown(name: string, homeDir?: string, directory?: string): boolean {
  const dir = directory ?? agentDefinitionsDir(homeDir);
  const existing = findDefinitionFileByName(dir, name);
  if (!existing) return false;
  unlinkSync(existing);
  return true;
}

/**
 * Bulk write-through (migrated store): upsert every profile, then remove
 * profile-backed .md files whose name is absent from the store (a rename
 * leaves no stale file). Pure-subagent .md files (no bridgeConfig) are kept.
 */
export function writeAgentProfilesMarkdown(profiles: AgentProfile[], homeDir?: string): void {
  const dir = agentDefinitionsDir(homeDir);
  for (const profile of profiles) {
    writeAgentProfileMarkdown(profile, homeDir);
  }
  const keep = new Set(profiles.map(profile => profile.name));
  for (const filePath of listMarkdownFiles(dir)) {
    const name = definitionNameForFile(filePath);
    if (!name || keep.has(name)) continue;
    if (tryParseDefinition(filePath)?.bridgeConfig) unlinkSync(filePath);
  }
}
