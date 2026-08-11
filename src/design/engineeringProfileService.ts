import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PolicyStore } from '../policy/policyStore.js';
import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import type { DesignDocumentStore } from './designDocumentStore.js';
import {
  getEngineeringProfile,
  type EngineeringProfile,
  type EngineeringValidatorDefinition,
} from './engineeringProfiles.js';

export type EngineeringProfileTarget = 'design' | 'agents' | 'policy' | 'validators';

export interface EngineeringProfileDiff {
  target: EngineeringProfileTarget;
  path: string;
  before: string;
  after: string;
  beforeChecksum: string;
  changed: boolean;
}

export interface EngineeringProfileProposal {
  proposalId: string;
  profile: EngineeringProfile;
  sourceConstraintIds: string[];
  diffs: Record<EngineeringProfileTarget, EngineeringProfileDiff>;
}

export interface EngineeringConstraintDrift {
  id: string;
  design: boolean;
  agents: boolean;
  policy: boolean;
  validators: boolean;
}

export interface EngineeringProfileDriftReport {
  profileId: string;
  constraints: EngineeringConstraintDrift[];
  expressedNotExecuted: string[];
  executedNotDesigned: string[];
}

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readOptional(filePath: string): Promise<string> {
  try { return await readFile(filePath, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' });
  try { await rename(temporary, filePath); } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function replaceGeneratedBlock(source: string, label: string, content: string): string {
  const start = `<!-- hadamard-${label}:start -->`;
  const end = `<!-- hadamard-${label}:end -->`;
  const block = `${start}\n${content.trim()}\n${end}`;
  const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u');
  return pattern.test(source) ? source.replace(pattern, block) : `${source.trimEnd()}${source.trim() ? '\n\n' : ''}${block}\n`;
}

function designContent(source: string, profile: EngineeringProfile): string {
  const statements = profile.constraints.map(item => `- **${item.id} — ${item.title}:** ${item.designStatement}`).join('\n');
  return replaceGeneratedBlock(source, 'engineering-design', `## Engineering constraints\n\n${statements}`);
}

function agentsContent(source: string, profile: EngineeringProfile): string {
  const instructions = profile.constraints.map(item => `- [${item.id}] ${item.agentInstruction}`).join('\n');
  return replaceGeneratedBlock(source, 'engineering-agents', `## Engineering Profile: ${profile.name}\n\n${instructions}`);
}

function validatorContent(profile: EngineeringProfile): string {
  const validators = new Map<string, EngineeringValidatorDefinition>();
  for (const constraint of profile.constraints) {
    for (const validator of constraint.validators) validators.set(validator.id, validator);
  }
  return `${JSON.stringify({ version: 1, profile: profile.id, validators: [...validators.values()] }, null, 2)}\n`;
}

function diff(target: EngineeringProfileTarget, filePath: string, before: string, after: string): EngineeringProfileDiff {
  return { target, path: filePath, before, after, beforeChecksum: checksum(before), changed: before !== after };
}

export class EngineeringProfileService {
  private readonly agentsPath: string;
  private readonly policyPath: string;
  private readonly validatorsPath: string;

  constructor(workspacePath: string, private readonly documents: DesignDocumentStore) {
    this.agentsPath = path.join(workspacePath, 'AGENTS.md');
    this.policyPath = path.join(workspacePath, '.hadamard', 'policy.json');
    this.validatorsPath = path.join(workspacePath, '.hadamard', 'validators.json');
  }

  async propose(profileId: string): Promise<EngineeringProfileProposal> {
    const profile = getEngineeringProfile(profileId);
    const document = await this.documents.inspect();
    const [agents, policy, validators] = await Promise.all([
      readOptional(this.agentsPath), readOptional(this.policyPath), readOptional(this.validatorsPath),
    ]);
    const policyStore = new PolicyStore(this.policyPath, 'project');
    const currentPolicy = await policyStore.load();
    const sourceConstraintIds = profile.constraints.map(item => item.id);
    const rules = profile.constraints.flatMap(item => item.policyRules);
    const desiredSettings = {
      ...currentPolicy.settings,
      engineeringProfile: { id: profile.id, sourceConstraintIds },
    };
    const desiredRules = [
      ...currentPolicy.rules.filter(rule => !rule.reason?.startsWith('[ENG-')),
      ...rules,
    ];
    const policyAlreadyMatches = JSON.stringify(currentPolicy.settings) === JSON.stringify(desiredSettings)
      && JSON.stringify(currentPolicy.rules) === JSON.stringify(desiredRules);
    const nextPolicy = policyAlreadyMatches && policy
      ? policy
      : `${JSON.stringify({
      version: 1,
      revision: currentPolicy.revision + 1,
      scope: 'project',
      settings: desiredSettings,
      rules: desiredRules,
      updatedAt: '(assigned on confirmation)',
    }, null, 2)}\n`;
    const diffs = {
      design: diff('design', this.documents.designPath(), document.content, designContent(document.content, profile)),
      agents: diff('agents', this.agentsPath, agents, agentsContent(agents, profile)),
      policy: diff('policy', this.policyPath, policy, nextPolicy),
      validators: diff('validators', this.validatorsPath, validators, validatorContent(profile)),
    };
    return {
      proposalId: checksum(JSON.stringify(Object.values(diffs).map(item => [item.target, item.beforeChecksum, checksum(item.after)]))),
      profile, sourceConstraintIds, diffs,
    };
  }

  async audit(profileId: string): Promise<EngineeringProfileDriftReport> {
    const profile = getEngineeringProfile(profileId);
    const document = await this.documents.inspect();
    const [agents, policyRaw, validatorsRaw] = await Promise.all([
      readOptional(this.agentsPath), readOptional(this.policyPath), readOptional(this.validatorsPath),
    ]);
    const policy = policyRaw ? JSON.parse(policyRaw) as Record<string, unknown> : {};
    const settings = policy.settings && typeof policy.settings === 'object' ? policy.settings as Record<string, unknown> : {};
    const engineering = settings.engineeringProfile && typeof settings.engineeringProfile === 'object'
      ? settings.engineeringProfile as Record<string, unknown> : {};
    const policyIds = new Set(Array.isArray(engineering.sourceConstraintIds)
      ? engineering.sourceConstraintIds.filter((id): id is string => typeof id === 'string') : []);
    const validators = validatorsRaw ? JSON.parse(validatorsRaw) as Record<string, unknown> : {};
    const validatorIds = new Set<string>();
    if (Array.isArray(validators.validators)) {
      for (const validator of validators.validators) {
        if (!validator || typeof validator !== 'object') continue;
        const ids = (validator as Record<string, unknown>).sourceConstraintIds;
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') validatorIds.add(id);
      }
    }
    const constraints = profile.constraints.map(item => ({
      id: item.id,
      design: document.content.includes(item.id),
      agents: agents.includes(`[${item.id}]`),
      policy: policyIds.has(item.id),
      validators: item.validators.length === 0 || validatorIds.has(item.id),
    }));
    return {
      profileId,
      constraints,
      expressedNotExecuted: constraints
        .filter(item => item.design && (!item.agents || !item.policy || !item.validators))
        .map(item => item.id),
      executedNotDesigned: constraints
        .filter(item => {
          const requiresValidator = profile.constraints.find(constraint => constraint.id === item.id)!.validators.length > 0;
          return !item.design && (item.agents || item.policy || (requiresValidator && item.validators));
        })
        .map(item => item.id),
    };
  }

  async apply(
    proposal: EngineeringProfileProposal,
    targets: readonly EngineeringProfileTarget[],
    confirmed: boolean,
  ): Promise<EngineeringProfileTarget[]> {
    if (!confirmed) throw new Error('Engineering Profile changes require explicit confirmation.');
    const fresh = await this.propose(proposal.profile.id);
    if (fresh.proposalId !== proposal.proposalId) throw new Error('Engineering Profile files changed; review a fresh proposal.');
    const selected = [...new Set(targets)];
    for (const target of selected) {
      const candidate = fresh.diffs[target];
      if (!candidate) throw new Error(`Unknown Engineering Profile target: ${target}`);
      if (target === 'policy') {
        const policyStore = new PolicyStore(this.policyPath, 'project');
        const current = await policyStore.load();
        const parsed = JSON.parse(candidate.after) as typeof current;
        await policyStore.save({
          version: 1, scope: 'project', settings: parsed.settings, rules: parsed.rules,
          lockedSettings: parsed.lockedSettings,
        }, current.revision);
      } else if (target === 'validators') {
        await mkdir(path.dirname(candidate.path), { recursive: true });
        await writeJsonAtomic(candidate.path, JSON.parse(candidate.after));
      } else {
        await writeTextAtomic(candidate.path, candidate.after);
      }
    }
    return selected;
  }
}
