import {
  DESIGN_MARKDOWN_FILE_NAME,
  DesignWorkspaceService,
} from './designWorkspaceService.js';

export const DESIGN_FILE_NAME = DESIGN_MARKDOWN_FILE_NAME;

export interface DesignDocumentSnapshot {
  content: string;
  revision: string;
  state: 'empty' | 'design';
  designPath: string;
  designContent?: string;
}

export class DesignDocumentStore {
  readonly workspace: DesignWorkspaceService;

  constructor(readonly projectPath: string) {
    this.workspace = new DesignWorkspaceService(projectPath);
  }

  directory(): string {
    return this.workspace.rootPath();
  }

  designPath(): string {
    return this.workspace.entryPath('markdown');
  }

  async inspect(): Promise<DesignDocumentSnapshot> {
    const document = await this.workspace.readEntry('markdown');
    const { content, revision, path: designPath } = document;
    return {
      content,
      revision,
      state: document.exists ? 'design' : 'empty',
      designPath,
      ...(document.exists ? { designContent: content } : {}),
    };
  }

  async write(content: string, options: { expectedRevision?: string } = {}): Promise<string> {
    const saved = await this.workspace.writeMarkdown(content, options.expectedRevision);
    return saved.path;
  }
}
