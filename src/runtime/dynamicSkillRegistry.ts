import type {
  HadamardExternalSkillsOptions,
  HadamardSkillDefinition,
} from '../types.js';
import { loadHadamardExternalSkillDefinitions } from './externalSkillRuntime.js';
import {
  cloneHadamardSkillDefinition,
  getDefaultHadamardBundledSkills,
  loadHadamardSkillDefinitions,
} from './hadamardSkills.js';

export interface SkillCompositionParts {
  externalSkills?: boolean | HadamardExternalSkillsOptions;
  additionalSkillDirectories: string[];
  directSkills: HadamardSkillDefinition[];
  explicitSkills: HadamardSkillDefinition[];
  managedSkills: HadamardSkillDefinition[];
  disableDefaultSkills: boolean;
  loadDefaultSkillDirectories?: boolean;
}

export async function refreshDynamicSkillRegistry(input: {
  registry: Map<string, HadamardSkillDefinition>;
  composition: SkillCompositionParts;
  homeDir: string;
  workDir: string;
}): Promise<number> {
  const { composition } = input;
  const externalSkills = composition.externalSkills
    ? await loadHadamardExternalSkillDefinitions({
        hadamardHomeDir: input.homeDir,
        workDir: input.workDir,
        externalSkills: composition.externalSkills,
      }).then(result => result.definitions)
    : [];
  const refreshed = await loadHadamardSkillDefinitions({
    homeDir: input.homeDir,
    workDir: input.workDir,
    skillDirectories: composition.additionalSkillDirectories,
    disableDefaultSkills: composition.externalSkills ? true : composition.disableDefaultSkills,
    loadDefaultSkillDirectories: !composition.externalSkills
      && composition.loadDefaultSkillDirectories,
  });
  const hadamardCatalog = externalSkills.filter(definition =>
    definition.metadata?.__hadamardExternalSkillProvider === 'hadamard');
  const reusedRuntime = externalSkills.filter(definition =>
    definition.metadata?.__hadamardExternalSkillProvider !== 'hadamard');
  const ordered = [
    ...reusedRuntime,
    ...(composition.disableDefaultSkills ? [] : getDefaultHadamardBundledSkills()),
    ...refreshed,
    ...composition.directSkills,
    ...composition.managedSkills,
    ...hadamardCatalog,
    ...composition.explicitSkills,
  ];
  const next = new Map<string, HadamardSkillDefinition>();
  for (const definition of ordered) {
    next.set(definition.name, cloneHadamardSkillDefinition(definition));
  }
  let changes = 0;
  for (const [name, definition] of next) {
    const previous = input.registry.get(name);
    if (!previous || previous.description !== definition.description
      || previous.version !== definition.version) changes += 1;
  }
  for (const name of input.registry.keys()) {
    if (!next.has(name)) changes += 1;
  }
  input.registry.clear();
  for (const [name, definition] of next) input.registry.set(name, definition);
  return changes;
}
