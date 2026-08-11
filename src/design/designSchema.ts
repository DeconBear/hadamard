export const HADAMARD_DESIGN_VERSION = 1 as const;

export interface DesignFrontmatter {
  hadamardDesignVersion: typeof HADAMARD_DESIGN_VERSION;
  template: string;
  templateVersion: number;
  theme: string;
  updatedAt: string;
}
export interface ParsedDesignDocument {
  frontmatter: DesignFrontmatter;
  markdown: string;
  source: string;
}

export const DEFAULT_DESIGN_FRONTMATTER: Readonly<DesignFrontmatter> = {
  hadamardDesignVersion: HADAMARD_DESIGN_VERSION,
  template: 'software.general',
  templateVersion: 1,
  theme: 'clean-light',
  updatedAt: '1970-01-01T00:00:00.000Z',
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

export function parseDesignDocument(source: string): ParsedDesignDocument {
  const match = source.match(FRONTMATTER_PATTERN);
  if (!match) {
    return {
      frontmatter: { ...DEFAULT_DESIGN_FRONTMATTER },
      markdown: source,
      source,
    };
  }
  const values = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const version = Number(values.get('hadamardDesignVersion'));
  const templateVersion = Number(values.get('templateVersion'));
  return {
    frontmatter: {
      hadamardDesignVersion: version === HADAMARD_DESIGN_VERSION
        ? HADAMARD_DESIGN_VERSION
        : HADAMARD_DESIGN_VERSION,
      template: values.get('template') || DEFAULT_DESIGN_FRONTMATTER.template,
      templateVersion: Number.isSafeInteger(templateVersion) && templateVersion > 0
        ? templateVersion
        : DEFAULT_DESIGN_FRONTMATTER.templateVersion,
      theme: values.get('theme') || DEFAULT_DESIGN_FRONTMATTER.theme,
      updatedAt: values.get('updatedAt') || DEFAULT_DESIGN_FRONTMATTER.updatedAt,
    },
    markdown: source.slice(match[0].length),
    source,
  };
}

export function serializeDesignDocument(
  markdown: string,
  metadata: Partial<DesignFrontmatter> = {},
): string {
  const frontmatter: DesignFrontmatter = {
    ...DEFAULT_DESIGN_FRONTMATTER,
    ...metadata,
    hadamardDesignVersion: HADAMARD_DESIGN_VERSION,
  };
  return [
    '---',
    `hadamardDesignVersion: ${frontmatter.hadamardDesignVersion}`,
    `template: ${frontmatter.template}`,
    `templateVersion: ${frontmatter.templateVersion}`,
    `theme: ${frontmatter.theme}`,
    `updatedAt: ${frontmatter.updatedAt}`,
    '---',
    markdown.replace(/^\s*\n/u, ''),
  ].join('\n');
}
