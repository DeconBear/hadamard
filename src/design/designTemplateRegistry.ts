export interface DesignTemplateSection {
  id: string;
  title: string;
  prompt: string;
  required?: boolean;
  repeatable?: boolean;
}

export interface DesignTemplate {
  id: string;
  version: number;
  name: string;
  description: string;
  engineeringProfileId: string;
  sections: readonly DesignTemplateSection[];
}

const CORE: readonly DesignTemplateSection[] = [
  { id: 'goal', title: 'Goal', prompt: 'What measurable outcome should this project produce?', required: true },
  { id: 'scope', title: 'Scope', prompt: 'What is included and explicitly excluded?', required: true },
  { id: 'architecture', title: 'Architecture', prompt: 'Describe components, responsibilities, and boundaries.' },
  { id: 'risks', title: 'Risks and validation', prompt: 'Record risks, mitigations, and objective verification.' },
  { id: 'decisions', title: 'Decision log', prompt: 'Record dated decisions and trade-offs.', repeatable: true },
];

function section(id: string, title: string, prompt: string): DesignTemplateSection {
  return { id, title, prompt };
}

function template(
  id: string,
  name: string,
  description: string,
  domainSections: readonly DesignTemplateSection[],
): DesignTemplate {
  return { id, version: 1, name, description, engineeringProfileId: id, sections: [...CORE, ...domainSections] };
}

export const DEFAULT_DESIGN_TEMPLATES: readonly DesignTemplate[] = Object.freeze([
  template('software.general', 'General software', 'Product and engineering plan for a general software project.', [
    section('users', 'Users', 'Who uses the system and what jobs do they need to complete?'),
    section('modules', 'Modules', 'List modules, ownership, dependencies, and stable interfaces.'),
    section('interfaces', 'Interfaces', 'Describe public APIs and compatibility expectations.'),
    section('data', 'Data', 'Describe data ownership, lifecycle, privacy, and migrations.'),
    section('deployment', 'Deployment', 'Describe environments, release, rollback, and operations.'),
    section('testing', 'Testing', 'Define test levels and release evidence.'),
  ]),
  template('software.frontend', 'Frontend software', 'User-facing web or desktop interface design.', [
    section('information-architecture', 'Information architecture', 'Describe navigation and content hierarchy.'),
    section('state-management', 'State management', 'Define server, client, URL, and persisted state ownership.'),
    section('components', 'Components', 'Define component boundaries, variants, and reusable primitives.'),
    section('accessibility', 'Accessibility', 'Define keyboard, screen reader, contrast, and motion requirements.'),
    section('performance', 'Performance', 'Set loading, interaction, rendering, and bundle budgets.'),
    section('browser-matrix', 'Browser matrix', 'List supported browsers, devices, and degradation policy.'),
  ]),
  template('software.backend', 'Backend software', 'Service, API, and data-intensive backend design.', [
    section('api', 'API', 'Define contracts, versioning, idempotency, and error semantics.'),
    section('data-model', 'Data model', 'Define entities, ownership, indexes, retention, and migrations.'),
    section('consistency', 'Consistency', 'State transaction, ordering, and consistency guarantees.'),
    section('capacity', 'Capacity', 'Estimate throughput, storage, latency, and scaling thresholds.'),
    section('security', 'Security', 'Define identity, authorization, secrets, and threat mitigations.'),
    section('observability', 'Observability', 'Define logs, metrics, traces, SLOs, and alerts.'),
    section('migration', 'Migration', 'Plan compatibility, backfill, cutover, rollback, and cleanup.'),
  ]),
  template('software.systems', 'Systems software', 'Runtime, operating-system, embedded, or performance-sensitive software.', [
    section('resource-model', 'Resource model', 'Define CPU, memory, storage, handles, and ownership.'),
    section('concurrency', 'Concurrency', 'Define threads, processes, synchronization, and ordering.'),
    section('failure-model', 'Failure model', 'List failures, detection, containment, recovery, and durability.'),
    section('performance-budget', 'Performance budget', 'Set latency, throughput, memory, and startup budgets.'),
    section('platform-compatibility', 'Platform compatibility', 'List target platforms, ABIs, and compatibility tests.'),
  ]),
  template('ai4s.experiment', 'AI for Science experiment', 'Reproducible computational science and AI4S experiment plan.', [
    section('scientific-question', 'Scientific question', 'State the scientific question and falsifiable objective.'),
    section('hypothesis', 'Hypothesis', 'State hypotheses and expected observations.'),
    section('data-provenance', 'Data sources and provenance', 'Record licenses, hashes, transformations, and lineage.'),
    section('environment', 'Environment', 'Pin software, hardware, seeds, and execution environment.'),
    section('experiments', 'Experiments', 'Define controls, ablations, runs, and recorded outputs.'),
    section('reproducibility', 'Reproducibility', 'Define artifacts and steps required to reproduce results.'),
  ]),
  template('ml.training', 'Neural network training', 'Dataset, training, evaluation, and drift plan.', [
    section('dataset', 'Dataset', 'Describe sources, consent, labels, preprocessing, and quality.'),
    section('splits', 'Dataset splits', 'Define leakage-safe train, validation, and test splits.'),
    section('model', 'Model', 'Describe architecture, initialization, and pretrained inputs.'),
    section('loss', 'Loss and optimization', 'Define loss terms, optimizer, scheduler, and regularization.'),
    section('hyperparameters', 'Hyperparameters', 'Record search space, chosen values, and rationale.'),
    section('compute', 'Compute', 'Estimate hardware, duration, energy, checkpoints, and recovery.'),
    section('evaluation', 'Evaluation', 'Define metrics, baselines, statistical tests, and acceptance.'),
    section('drift', 'Drift', 'Define monitoring, recalibration, and retraining triggers.'),
  ]),
  template('math.modeling', 'Mathematical modeling', 'Assumptions, equations, solution, sensitivity, and validation.', [
    section('assumptions', 'Assumptions', 'List assumptions, applicability, and expected failure modes.'),
    section('notation', 'Notation', 'Define symbols, units, dimensions, and conventions.'),
    section('equations', 'Equations', 'State governing equations and derivation references.'),
    section('boundary-conditions', 'Boundary and initial conditions', 'Define all boundary and initial conditions.'),
    section('solver', 'Solver', 'Describe analytical or numerical methods and convergence criteria.'),
    section('sensitivity', 'Sensitivity', 'Plan parameter sweeps, uncertainty, and identifiability checks.'),
    section('model-validation', 'Model validation', 'Compare predictions to independent data or known limits.'),
  ]),
  template('electronics.circuit', 'Electronic circuit', 'Requirements, schematic, simulation, layout, and BOM plan.', [
    section('specifications', 'Specifications', 'List electrical, environmental, safety, and cost targets.'),
    section('components', 'Components and derating', 'Select parts, tolerances, substitutes, and derating.'),
    section('schematic', 'Schematic', 'Describe topology, nets, interfaces, and design rationale.'),
    section('power', 'Power', 'Define rails, sequencing, protection, thermals, and power budget.'),
    section('signal-integrity', 'Signal integrity', 'Define impedance, timing, termination, and noise budgets.'),
    section('erc-drc', 'ERC and DRC', 'Define electrical and layout rule checks.'),
    section('simulation', 'Simulation', 'Plan operating point, transient, AC, noise, and corner simulations.'),
    section('bom', 'Bill of materials', 'Track manufacturer parts, lifecycle, sourcing, and cost.'),
  ]),
]);

export class DesignTemplateRegistry {
  private readonly templates = new Map<string, DesignTemplate>();

  constructor(templates: readonly DesignTemplate[] = DEFAULT_DESIGN_TEMPLATES) {
    for (const candidate of templates) this.register(candidate);
  }

  register(candidate: DesignTemplate): void {
    if (!candidate.id.trim() || !Number.isSafeInteger(candidate.version) || candidate.version < 1) {
      throw new Error('Design template id and positive integer version are required.');
    }
    const ids = new Set<string>();
    for (const item of candidate.sections) {
      if (!item.id.trim() || ids.has(item.id)) throw new Error(`Duplicate or empty section id in ${candidate.id}.`);
      ids.add(item.id);
    }
    this.templates.set(candidate.id, Object.freeze({ ...candidate, sections: [...candidate.sections] }));
  }

  get(id: string): DesignTemplate | undefined {
    return this.templates.get(id);
  }

  list(): DesignTemplate[] {
    return [...this.templates.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  createMarkdown(id: string): string {
    const selected = this.get(id);
    if (!selected) throw new Error(`Unknown Design template: ${id}`);
    return selected.sections
      .map(item => `<!-- hadamard-section:${item.id} -->\n## ${item.title}\n\n<!-- ${item.prompt} -->\n`)
      .join('\n');
  }
}

export function createDefaultDesignTemplateRegistry(): DesignTemplateRegistry {
  return new DesignTemplateRegistry();
}
