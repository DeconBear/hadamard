import { DesignDocumentStore, type DesignMigrationAction } from './designDocumentStore.js';
import { DesignImportExportService } from './designImportExportService.js';
import { DesignRenderService } from './designRenderService.js';
import { createDefaultDesignTemplateRegistry } from './designTemplateRegistry.js';
import { parseDesignDocument } from './designSchema.js';

export class DesignDocumentService {
  readonly store: DesignDocumentStore;
  readonly templates = createDefaultDesignTemplateRegistry();
  readonly renderer = new DesignRenderService();
  readonly transfers = new DesignImportExportService(this.renderer);

  constructor(projectPath: string, homeDir: string, workspacePath = projectPath) {
    this.store = new DesignDocumentStore(projectPath, homeDir, workspacePath);
  }

  async read() {
    const snapshot = await this.store.inspect();
    return { ...snapshot, parsed: parseDesignDocument(snapshot.content) };
  }

  patch(content: string, expectedRevision?: string, mirror = false) {
    return this.store.write(content, { expectedRevision, mirror });
  }

  render(content: string) {
    return this.renderer.render(content);
  }

  migrate(action: DesignMigrationAction) {
    return this.store.migrate(action);
  }
}
