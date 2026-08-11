export interface DesignTemplateSection {
  id: string;
  title: string;
  prompt: string;
  required?: boolean;
}
export interface DesignTemplate {
  id: string;
  version: number;
  name: string;
  sections: readonly DesignTemplateSection[];
}

const GENERAL_SOFTWARE_TEMPLATE: DesignTemplate = {
  id: 'software.general',
  version: 1,
  name: 'General software',
  sections: [
    { id: 'goal', title: 'Goal', prompt: 'What outcome should this project produce?', required: true },
    { id: 'scope', title: 'Scope', prompt: 'What is included and explicitly excluded?', required: true },
    { id: 'architecture', title: 'Architecture', prompt: 'Describe components and their boundaries.' },
    { id: 'risks', title: 'Risks and validation', prompt: 'Record risks, mitigations, and verification.' },
    { id: 'decisions', title: 'Decision log', prompt: 'Record dated decisions and trade-offs.' },
  ],
};

export class DesignTemplateRegistry {
  private readonly templates = new Map<string, DesignTemplate>();

  constructor(templates: readonly DesignTemplate[] = [GENERAL_SOFTWARE_TEMPLATE]) {
    for (const template of templates) this.register(template);
  }

  register(template: DesignTemplate): void {
    if (!template.id.trim() || !Number.isSafeInteger(template.version) || template.version < 1) {
      throw new Error('Design template id and positive integer version are required.');
    }
    this.templates.set(template.id, Object.freeze({ ...template, sections: [...template.sections] }));
  }

  get(id: string): DesignTemplate | undefined {
    return this.templates.get(id);
  }

  list(): DesignTemplate[] {
    return [...this.templates.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  createMarkdown(id: string): string {
    const template = this.get(id);
    if (!template) throw new Error(`Unknown Design template: ${id}`);
    return template.sections
      .map(section => `## ${section.title}\n\n<!-- ${section.prompt} -->\n`)
      .join('\n');
  }
}

export function createDefaultDesignTemplateRegistry(): DesignTemplateRegistry {
  return new DesignTemplateRegistry();
}
