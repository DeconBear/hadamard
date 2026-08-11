import type { PolicyRule } from '../policy/types.js';

export interface EngineeringValidatorDefinition {
  id: string;
  command: string;
  description: string;
  sourceConstraintIds: string[];
}

export interface EngineeringConstraint {
  id: string;
  title: string;
  designStatement: string;
  agentInstruction: string;
  policyRules: PolicyRule[];
  validators: EngineeringValidatorDefinition[];
}

export interface EngineeringProfile {
  id: string;
  name: string;
  constraints: readonly EngineeringConstraint[];
}

function constraint(
  id: string,
  title: string,
  designStatement: string,
  agentInstruction: string,
  validators: EngineeringValidatorDefinition[],
  policyRules: PolicyRule[] = [],
): EngineeringConstraint {
  return { id, title, designStatement, agentInstruction, policyRules, validators };
}

const SOFTWARE_BASE: readonly EngineeringConstraint[] = [
  constraint(
    'ENG-SW-TEST-001',
    'Evidence before completion',
    'Changes are complete only after focused tests and the documented release gates pass.',
    'Run focused tests for changed behavior, then the repository typecheck, test, and build gates before reporting completion.',
    [
      { id: 'typecheck', command: 'npm run typecheck', description: 'TypeScript static verification', sourceConstraintIds: ['ENG-SW-TEST-001'] },
      { id: 'test', command: 'npm test', description: 'Behavior test suite', sourceConstraintIds: ['ENG-SW-TEST-001'] },
      { id: 'build', command: 'npm run build', description: 'Production build', sourceConstraintIds: ['ENG-SW-TEST-001'] },
    ],
  ),
  constraint(
    'ENG-SW-BOUNDARY-001',
    'Preserve module boundaries',
    'Components must have one cohesive responsibility and depend on explicit contracts.',
    'Keep changes cohesive and dependency direction explicit; do not bypass service or policy boundaries.',
    [],
  ),
  constraint(
    'ENG-SEC-SECRET-001',
    'Protect credentials',
    'Credentials and private configuration never enter source control or exported Design artifacts.',
    'Never write secrets into tracked files, Design exports, logs, or test fixtures.',
    [],
    [{ id: 'engineering-secret-files', effect: 'deny', pathPattern: '**/*.{key,pem,p12}', reason: '[ENG-SEC-SECRET-001] private key material' }],
  ),
];

const AI4S: readonly EngineeringConstraint[] = [
  constraint(
    'ENG-AI4S-PROV-001',
    'Record scientific provenance',
    'Every dataset, transformation, environment, seed, and result has reproducible provenance.',
    'Record input hashes, licenses, transformations, environment lock, random seeds, and output hashes for every experiment.',
    [{ id: 'ai4s-provenance', command: 'hadamard validate provenance', description: 'Check experiment provenance records', sourceConstraintIds: ['ENG-AI4S-PROV-001'] }],
  ),
  constraint(
    'ENG-AI4S-DATA-001',
    'Constrain data egress',
    'Scientific data may leave the workspace only through an explicitly approved export.',
    'Do not upload or transmit project datasets without an explicit approval tied to the destination.',
    [],
    [{ id: 'ai4s-network', effect: 'ask', tool: 'WebFetch', reason: '[ENG-AI4S-DATA-001] review scientific data egress' }],
  ),
];

const ML: readonly EngineeringConstraint[] = [
  constraint(
    'ENG-ML-SPLIT-001',
    'Prevent evaluation leakage',
    'Dataset splits are immutable, hashed, and checked for subject or temporal leakage.',
    'Preserve split manifests and run leakage checks before training or evaluation.',
    [{ id: 'ml-data-splits', command: 'hadamard validate ml-splits', description: 'Check split hashes and leakage', sourceConstraintIds: ['ENG-ML-SPLIT-001'] }],
  ),
  constraint(
    'ENG-ML-REPRO-001',
    'Reproduce training runs',
    'Training runs pin code, data, environment, seeds, hyperparameters, and checkpoints.',
    'Write a complete run manifest before claiming a training result is reproducible.',
    [{ id: 'ml-run-manifest', command: 'hadamard validate ml-run', description: 'Check training run manifest', sourceConstraintIds: ['ENG-ML-REPRO-001'] }],
  ),
];

const MATH: readonly EngineeringConstraint[] = [
  constraint(
    'ENG-MATH-UNITS-001',
    'Check dimensions and limits',
    'Equations define units and pass dimensional and known-limit checks.',
    'Verify dimensions, boundary conditions, limiting cases, and numerical tolerances after equation changes.',
    [{ id: 'math-model', command: 'hadamard validate math-model', description: 'Check symbols, units, and validation cases', sourceConstraintIds: ['ENG-MATH-UNITS-001'] }],
  ),
];

const ELECTRONICS: readonly EngineeringConstraint[] = [
  constraint(
    'ENG-EE-SIM-001',
    'Simulate schematic changes',
    'Schematic or value changes are validated across specified operating and corner conditions.',
    'After changing a schematic, component, or value, run the project simulation suite and attach results.',
    [{ id: 'circuit-simulation', command: 'ngspice -b simulation.cir', description: 'Run circuit simulation', sourceConstraintIds: ['ENG-EE-SIM-001'] }],
  ),
  constraint(
    'ENG-EE-CHECK-001',
    'Pass ERC, DRC, and BOM checks',
    'Releases require clean electrical rules, layout rules, and auditable component sourcing.',
    'Run ERC, DRC, and BOM validation before marking an electronics change complete.',
    [{ id: 'electronics-release', command: 'hadamard validate electronics', description: 'Run ERC, DRC, and BOM checks', sourceConstraintIds: ['ENG-EE-CHECK-001'] }],
  ),
];

function profile(id: string, name: string, constraints: readonly EngineeringConstraint[]): EngineeringProfile {
  return { id, name, constraints };
}

export const ENGINEERING_PROFILES: readonly EngineeringProfile[] = Object.freeze([
  profile('software.general', 'General software engineering', SOFTWARE_BASE),
  profile('software.frontend', 'Frontend engineering', SOFTWARE_BASE),
  profile('software.backend', 'Backend engineering', SOFTWARE_BASE),
  profile('software.systems', 'Systems engineering', SOFTWARE_BASE),
  profile('ai4s.experiment', 'AI for Science experiment', AI4S),
  profile('ml.training', 'Machine learning training', [...AI4S, ...ML]),
  profile('math.modeling', 'Mathematical modeling', MATH),
  profile('electronics.circuit', 'Electronic circuit engineering', ELECTRONICS),
]);

export function getEngineeringProfile(id: string): EngineeringProfile {
  const profile = ENGINEERING_PROFILES.find(candidate => candidate.id === id);
  if (!profile) throw new Error(`Unknown Engineering Profile: ${id}`);
  return profile;
}
